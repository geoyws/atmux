// ADR-148 §D4 / T3: lane-stall verb.
//
// Operator-on-demand post-ADR-233 (cron auto-install retired; orchd is
// the event-driven runtime). Pre-ADR-233 this fired from a cron block;
// the per-team `cron-install --template lane-stall-watch` arming is
// gone. Until an orchd consumer subscribes to a lane-stall topic, the
// verb runs only when an operator/lead invokes `atmux lane-stall-tick`
// directly. Per ADR-148 §D4 the verb is the fleet-wide safety net —
// when a Task
// stalls in a lane whose members are all non-shipping, fire an Enter-
// push (`atmux claim <task-id>`) to the most-recently-active member's
// pane. This is the Path A choice per §OQ-2 (Enter-push over filing a
// new Task) — sub-second response vs +1 cron cycle delay.
//
// Pane-state check is MANDATORY before send-keys per CLAUDE.md
// "always read pane state BEFORE tmux send-keys" — wrapped in
// `safeSendKeys` which already handles the classify + retry + refuse
// loop (READY → send; TYPING/COMPACTING → retry; MODAL/UNKNOWN → refuse).
//
// On send refusal, the verb appends a one-line entry to a flag file at
// `<atmuxDir>/state/lane-stall-flags.md` for operator review. (The
// `atmux flag` verb isn't on this branch yet — when it lands, swap to
// `flagAdd(...)` in a follow-up cleanup commit.)
//
// Dedup: every successful send writes a row to `~/.atmux/state/
// lane-stall-fires.json` (per task body). Re-fires for the same
// `(taskId, lane)` within `laneStallMinAgeSec / 2` are skipped at the
// decision layer.

import { join } from "node:path";
import { appendText, ensureDir } from "../abstractions/fs.ts";
import { formatMyt } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
  stateDir,
} from "../core/common.ts";
import { listTasks } from "../core/kanban.ts";
import {
  appendDedupFire,
  type CadenceVerdict,
  decideLaneStall,
  type LaneStallDecision,
  type LaneStallMemberInput,
  type LaneStallTaskInput,
  pruneDedupState,
  readDedupState,
} from "../core/lane-stall.ts";
import { type CaptureFn } from "../core/pane-state.ts";
import { type SafeSendOpts, type SendKeysFn, safeSendKeys } from "../core/safe-send.ts";
import { UsageError } from "../errors.ts";
import { DEFAULT_LANE_STALL_MIN_AGE_SEC, type Team, type TeamMember } from "../schema/team.ts";

const USAGE = "atmux lane-stall-tick [--team-dir <path>]";

// ---------- Args ----------

export interface ParsedLaneStallTickArgs {
  teamDir?: string;
}

export function parseLaneStallTickArgs(argv: ReadonlyArray<string>): ParsedLaneStallTickArgs {
  const out: ParsedLaneStallTickArgs = {};
  for (let i = 0; i < argv.length; ) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "lane-stall-tick: --team-dir requires a value",
          hint: USAGE,
        });
      }
      out.teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `lane-stall-tick: unknown arg: ${a ?? ""}`,
      hint: USAGE,
    });
  }
  return out;
}

// ---------- Test-injection seam ----------

/** Per-member cadence-verdict lookup. T5 (cadence-classifier.ts) ships
 *  the real implementation; until then, the default returns `"idle"`
 *  for every member — the safest fall-through since idle ∈ STALL_VERDICTS,
 *  meaning lane-stall fires whenever the age + lane-membership gates
 *  trip. Tests inject explicit verdicts per fixture. */
export type CadenceLookupFn = (member: TeamMember) => Promise<CadenceVerdict>;

/** Optional per-member last-activity probe (epoch seconds). Used by
 *  `decideLaneStall` to pick the target member when a lane has 2+
 *  non-shipping members. Default `() => Promise.resolve(undefined)` —
 *  the decision falls back to roster order in that case. */
export type LastActivityFn = (member: TeamMember) => Promise<number | undefined>;

export interface LaneStallTickDeps {
  tmux?: TmuxNamespace;
  capture?: CaptureFn;
  sendKeys?: SendKeysFn;
  /** Default returns `"idle"` for every member (worst-case fallback);
   *  tests + T5 pass the real classifier. */
  cadenceVerdict?: CadenceLookupFn;
  /** Optional last-activity probe (epoch seconds). */
  lastActivity?: LastActivityFn;
  /** Clock override. Default `() => Math.floor(Date.now() / 1000)`. */
  nowSec?: () => number;
  /** `$HOME` override for the dedup-state path. Default `process.env.HOME`. */
  home?: string;
  /** Logger. Default writes one line per outcome to stderr. */
  log?: (msg: string) => void;
}

// ---------- Verb entry ----------

export interface LaneStallTickResult {
  /** Decisions surfaced this tick (one per stalled-candidate Task).
   *  Includes skips so the cron log captures the full reasoning. */
  decisions: LaneStallDecision[];
  /** Number of `fire` decisions where the send-keys actually landed
   *  successfully (state was READY or retryable, send returned 'sent'). */
  fired: number;
  /** Number of `fire` decisions where the send was refused (pane not
   *  READY) — these go to the flag file for operator review. */
  flagged: number;
  /** Number of stale dedup entries pruned this tick. */
  prunedDedupEntries: number;
}

export async function laneStallTick(
  argv: ReadonlyArray<string>,
  deps: LaneStallTickDeps = {},
): Promise<number> {
  const parsed = parseLaneStallTickArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  await runLaneStallTick(team, atmuxDir, deps);
  return 0;
}

/** Pure-ish core — exported for direct unit testing without going
 *  through argv parse. */
export async function runLaneStallTick(
  team: Team,
  atmuxDir: string,
  deps: LaneStallTickDeps = {},
): Promise<LaneStallTickResult> {
  const log = deps.log ?? defaultLog;
  const nowSecFn = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const homeDir = deps.home ?? process.env.HOME ?? "";
  const cadenceVerdict = deps.cadenceVerdict ?? defaultCadenceVerdict;
  const lastActivity = deps.lastActivity ?? defaultLastActivity;

  // Gate on team config — verb is a no-op when cadence is opt-out OR
  // lane-stall is explicitly disabled.
  if (team.cadence?.enabled !== true) {
    log("lane-stall-tick: team.cadence.enabled !== true — no-op");
    return { decisions: [], fired: 0, flagged: 0, prunedDedupEntries: 0 };
  }
  if (team.cadence.laneStallEnabled === false) {
    log("lane-stall-tick: team.cadence.laneStallEnabled === false — no-op");
    return { decisions: [], fired: 0, flagged: 0, prunedDedupEntries: 0 };
  }

  const laneStallMinAgeSec = team.cadence.laneStallMinAgeSec ?? DEFAULT_LANE_STALL_MIN_AGE_SEC;
  const nowSec = nowSecFn();

  // Prune stale dedup entries BEFORE the decision so a long-running
  // operator-resolved Task can fire again on its next stall cycle.
  let prunedDedupEntries = 0;
  if (homeDir.length > 0) {
    prunedDedupEntries = await pruneDedupState(homeDir, nowSec, laneStallMinAgeSec);
  }

  // Filter Tasks to stalled-candidates: status=todo AND non-null lane.
  const allTasks = await listTasks(atmuxDir, { status: "todo" });
  const candidates: LaneStallTaskInput[] = allTasks
    .filter(
      (t): t is typeof t & { lane: string; createdAt: number } =>
        typeof t.lane === "string" && t.lane.length > 0 && typeof t.createdAt === "number",
    )
    .map((t) => ({ id: t.id, lane: t.lane, createdAt: t.createdAt }));

  if (candidates.length === 0) {
    log("lane-stall-tick: no todo Tasks with non-null lane — no-op");
    return { decisions: [], fired: 0, flagged: 0, prunedDedupEntries };
  }

  // Resolve per-member verdict + last-activity once per tick — the
  // decision needs all members keyed by lane.
  const memberInputs: LaneStallMemberInput[] = [];
  for (const m of team.members) {
    if (m.lane === undefined || m.lane.length === 0) continue;
    const verdict = await cadenceVerdict(m);
    const lastAct = await lastActivity(m);
    const input: LaneStallMemberInput = {
      name: m.name,
      lane: m.lane,
      verdict,
    };
    if (lastAct !== undefined) input.lastActivityAt = lastAct;
    memberInputs.push(input);
  }

  const dedupState = homeDir.length > 0 ? await readDedupState(homeDir) : { fires: [] };

  const decisions = decideLaneStall({
    tasks: candidates,
    members: memberInputs,
    dedup: dedupState.fires,
    nowSec,
    laneStallMinAgeSec,
  });

  // Resolve session + tmux for the fire-decision send-keys.
  const session = await getSessionName({ dir: atmuxDir, team });
  const tmux = deps.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  const sendKeys: SendKeysFn =
    deps.sendKeys ??
    (async (target: string, keys: string, opts) => {
      // Recover member name from windowTarget suffix for the SendTarget
      // audit metadata. Best-effort — the metadata is inert at the
      // tmux argv layer.
      const after = target.includes(":") ? (target.split(":")[1] ?? "") : target;
      const m = /[A-Za-z0-9_-].*$/.exec(after);
      const memberName = m?.[0] ?? after;
      await tmux.pane.sendKeys({
        target: { kind: "member", member: memberName, team: team.name, target },
        keys,
        enter: opts?.enter ?? true,
      });
    });

  let fired = 0;
  let flagged = 0;

  for (const d of decisions) {
    if (d.kind !== "fire") {
      log(`lane-stall-tick: ${d.taskId} (lane=${d.lane}) → ${d.kind}: ${d.reason ?? ""}`);
      continue;
    }
    const targetMember = team.members.find((m) => m.name === d.targetMember);
    if (targetMember === undefined) {
      log(
        `lane-stall-tick: ${d.taskId} fire decision names unknown member '${d.targetMember}' — flagging`,
      );
      await appendFlagEntry(atmuxDir, nowSec, d, "target member missing from roster");
      flagged += 1;
      continue;
    }
    const windowName = buildWindowName(
      targetMember.name,
      targetMember.emoji,
      targetMember.label,
      targetMember.role,
    );
    const windowTarget = `${session}:${windowName}`;
    const sendOpts: SafeSendOpts = {
      capture,
      sendKeys,
      log,
    };
    const sendText = `atmux claim ${d.taskId}`;
    const result = await safeSendKeys(windowTarget, sendText, sendOpts);
    if (result.outcome === "sent") {
      log(`lane-stall-tick: ${d.taskId} → fired to ${targetMember.name} (lane=${d.lane}, send=ok)`);
      if (homeDir.length > 0) {
        await appendDedupFire(homeDir, {
          taskId: d.taskId,
          lane: d.lane,
          firedAt: nowSec,
        });
      }
      fired += 1;
    } else {
      log(
        `lane-stall-tick: ${d.taskId} → ${targetMember.name} pane refused send ` +
          `(outcome=${result.outcome}, state=${result.finalClassification.state}) — flagging`,
      );
      await appendFlagEntry(
        atmuxDir,
        nowSec,
        d,
        `pane refused send (outcome=${result.outcome}, state=${result.finalClassification.state})`,
      );
      flagged += 1;
    }
  }

  log(
    `lane-stall-tick: tick complete — ${fired} fired, ${flagged} flagged, ` +
      `${decisions.filter((x) => x.kind !== "fire").length} skipped, ` +
      `${prunedDedupEntries} dedup pruned`,
  );
  return { decisions, fired, flagged, prunedDedupEntries };
}

// ---------- Helpers ----------

/** Default cadence verdict — `"idle"` (worst-case fall-through). T5's
 *  real classifier replaces this once it lands on the branch. */
async function defaultCadenceVerdict(_member: TeamMember): Promise<CadenceVerdict> {
  return "idle";
}

/** Default last-activity probe — returns `undefined` (decision falls
 *  back to roster order). Tests + future pane-activity wiring inject
 *  the real implementation. */
async function defaultLastActivity(_member: TeamMember): Promise<number | undefined> {
  return undefined;
}

/** Append one entry to the flag file at `<atmuxDir>/state/
 *  lane-stall-flags.md`. Operator-readable Markdown so a future
 *  `atmux flag` verb can ingest it without parser plumbing. */
async function appendFlagEntry(
  atmuxDir: string,
  nowSec: number,
  d: LaneStallDecision,
  reason: string,
): Promise<void> {
  const path = join(stateDir(atmuxDir), "lane-stall-flags.md");
  await ensureDir(stateDir(atmuxDir));
  const ts = formatMyt(nowSec * 1000);
  const entry =
    `## ${ts} — ${d.taskId} (lane=${d.lane})\n` +
    `- target: ${d.targetMember ?? "(unresolved)"}\n` +
    `- reason: ${reason}\n` +
    `- decision: ${d.reason ?? d.kind}\n\n`;
  await appendText(path, entry);
}

function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ADR-148 cross-ref note (per task body acceptance §5):
// ADR-127 lane-claim auto-pickup is the SIBLING surface — that handles
// the `member-idle` event (member finishes a turn → cron injects
// `claim --next`). lane-stall here is the SIBLING fallback for the
// inverse: `lane-stall` event (Task waits in lane while members idle).
// Both paths converge on the same `atmux claim` Enter-push; lane-claim
// is the per-member-state trigger, lane-stall is the per-Task-age
// trigger. ADR-148 §D4 documents the relation; ADR-127 picks up the
// cross-ref via its own append-only annotation if/when needed.
