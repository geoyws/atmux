// ADR-062 §3: `atmux lane-tick` orchestrator verb.
//
// Cron-fired single-pass loop: for each `team.members[]` entry with
// `lane` set, capture the pane, classify via `classifyText`, and inject
// `atmux claim --next --as <member>` via `safeSendKeys` when the pane
// is READY. Non-READY → log + skip; Tasks claimable through this path
// land on the kanban via the workers' own `claim --next` calls (lane
// tick never reads or mutates the kanban itself).
//
// **Bounded** — at most one keystroke injection per member per tick. No
// claim+claim loops; the next eligible Task surfaces on the next tick.
// **Idempotent** — a tick with no eligible Tasks anywhere is a no-op
// (claim --next returns silently when its selector matches nothing).
//
// Failure isolation: a per-member capture / send error logs evidence
// and skips that member without breaking the loop. team.json absence
// or schema-invalid surfaces as ConfigError up the call chain (cron's
// log target captures it).
//
// Cron-fired `>>logs/lane-tick.log` is set up by the cron template
// (T4); this verb writes structured single-line records to stderr per
// member, suitable for grep-able log archeology.

import { dirname } from "node:path";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import { findCommitForTask, type GitSpawn } from "../core/auto-done.ts";
import {
  getAtmuxDir,
  resolveTeamSocket,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { listTasks, moveTask } from "../core/kanban.ts";
import { type CaptureFn, classifyText, type PaneClassification } from "../core/pane-state.ts";
import { pasteAndSubmit } from "../core/paste-submit.ts";
import {
  type SafeSendOpts,
  type SafeSendResult,
  type SendKeysFn,
  safeSendKeys,
} from "../core/safe-send.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import { parseLeadCtxPct } from "./whip.ts";

// ---------- Public types (test-injectable deps) ----------

/** Function-shape alias matching `safeSendKeys` so tests can inject a
 *  recorder without importing the real implementation. */
export type SafeSendFn = (
  target: string,
  text: string,
  opts: SafeSendOpts,
) => Promise<SafeSendResult>;

export interface LaneTickDeps {
  /** Pre-built tmux namespace. Defaults to `createTmux({socketPath:
   *  getDefaultSocket(team.name)})` — same wiring whip uses. */
  tmux?: TmuxNamespace;
  /** Pane capture function. Defaults to `tmux.pane.capturePane({target,
   *  start: -30})`. Test injection bypasses tmux entirely. */
  capture?: CaptureFn;
  /** safeSendKeys function. Defaults to the real implementation; tests
   *  inject a recorder so they can assert call count + arguments
   *  without needing a real tmux + classifier loop. */
  sendFn?: SafeSendFn;
  /** Inner tmux send-keys wrapper used by safeSendKeys. Tests rarely
   *  need to override this directly — `sendFn` is the cleaner cut. */
  sendKeysFn?: SendKeysFn;
  /** Logger; defaults to stderr. Single-line records keyed on member
   *  name + outcome. */
  log?: (msg: string) => void;
  /** ADR-080 §B2: git spawn override for the auto-done scan. Tests
   *  inject a fixture so the scan exercises without a real git repo. */
  git?: GitSpawn;
}

export interface LaneTickResult {
  /** Members iterated (laned only). */
  visited: number;
  /** Per-member outcome — keyed on member name. */
  outcomes: Record<string, LaneTickMemberOutcome>;
  /** ADR-080 §B2: count of in-progress `commit t-X` tasks the auto-done
   *  scan resolved (commit found in repo log → kanban moved to done).
   *  0 on idempotent re-runs and on teams without a gitter pattern. */
  autoDoneResolved: number;
}

export type LaneTickMemberOutcome =
  | "injected"
  /** ADR-080 §A2: lead pane at ctx-pct ≥ leadCtxRotateThreshold — instead
   *  of injecting `claim --next` (which would deepen ctx pressure), the
   *  rotation nudge `/team rotate-lead` is sent so the lead can hand off
   *  before mid-think drift sets in. Operator-visible outcome distinct
   *  from `injected` so the post-tick summary distinguishes the cause. */
  | "injected-rotate-nudge"
  | "skip-not-ready"
  | "skip-capture-error"
  | "skip-send-refused";

// ---------- Verb entrypoint ----------

/**
 * `atmux lane-tick [--team-dir <dir>]`. Returns 0 on completion (even
 * when every member skipped). Cron-friendly: never throws on per-member
 * capture/send errors; only top-level config failures (missing
 * team.json, malformed schema, missing session) surface as ConfigError.
 */
export async function laneTick(
  argv: ReadonlyArray<string>,
  deps: LaneTickDeps = {},
): Promise<number> {
  const parsed = parseLaneTickArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const log = deps.log ?? defaultLog;

  // ADR-080 §B2: --backfill-done is the operator's one-shot recovery
  // path. Skip the per-tick claim-injection loop entirely (the operator
  // is cleaning up legacy stale state, not driving live work) and run
  // ONLY the auto-done scan over all of git history (`backfill=true`).
  if (parsed.backfillDone === true) {
    const scanOpts: AutoDoneScanOpts = { backfill: true, log };
    if (deps.git !== undefined) scanOpts.git = deps.git;
    const resolved = await runAutoDoneScan(atmuxDir, team, scanOpts);
    log(`lane-tick: --backfill-done resolved=${resolved}`);
    return 0;
  }

  const result = await runLaneTick(atmuxDir, team, deps);
  // Surface a one-line summary on stderr for cron-log grep.
  log(
    `lane-tick: visited=${result.visited} ` +
      `injected=${count(result.outcomes, "injected")} ` +
      `injected-rotate-nudge=${count(result.outcomes, "injected-rotate-nudge")} ` +
      `auto-done-resolved=${result.autoDoneResolved} ` +
      `skip-not-ready=${count(result.outcomes, "skip-not-ready")} ` +
      `skip-capture-error=${count(result.outcomes, "skip-capture-error")} ` +
      `skip-send-refused=${count(result.outcomes, "skip-send-refused")}`,
  );
  return 0;
}

/** Pure-ish core: takes a resolved team + atmuxDir + injectable deps,
 *  runs one tick, returns the per-member outcome map. Exported for
 *  direct unit-testing without re-routing through argv parse. */
export async function runLaneTick(
  atmuxDir: string,
  team: Team,
  deps: LaneTickDeps = {},
): Promise<LaneTickResult> {
  const log = deps.log ?? defaultLog;
  const tmux = deps.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
  const sendFn = deps.sendFn ?? safeSendKeys;
  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  const sendKeysFn: SendKeysFn =
    deps.sendKeysFn ??
    (async (target: string, keys: string, opts) => {
      // ADR-138 T3b3 (t-06547e2d): when the keystroke is a TEXT BODY
      // (the claim-injection / rotate-nudge case below — bracketed-
      // paste-Enter-swallow bug zone), route through
      // `pasteAndSubmit` so the bundled load-buffer + paste-buffer
      // -d + 500ms settle + C-m cascade lands the message reliably.
      // Raw `tmux.pane.sendKeys` is preserved for control-key /
      // modal-dismiss cases (enter:false explicit, single-character
      // payload) — those don't pass through the bracketed-paste
      // envelope and are fine on the raw path.
      const sendTarget = {
        kind: "member" as const,
        member: parseMemberFromTarget(target),
        team: team.name,
        target,
      };
      const wantsEnter = opts?.enter ?? true;
      const isControlKeyOnly = !wantsEnter || /^[CM]-./.test(keys);
      if (isControlKeyOnly) {
        // Control-key / no-submit path — raw sendKeys is correct here.
        await tmux.pane.sendKeys({ target: sendTarget, keys, enter: wantsEnter });
        return;
      }
      // Text-body path — paste-submit cascade. P0 leak (t-06547e2d):
      // `tmux send-keys <text> Enter` on a Claude pane in the "just
      // finished + ← for agents" transition state silently drops the
      // Enter, leaving the command queued in the composer. pasteAndSubmit
      // uses `C-m` (literal CR) after the bracketed-paste envelope —
      // empirically reliable across the leak's full failure-mode set.
      await pasteAndSubmit(tmux, sendTarget, keys);
    });

  const session = await getSessionName({ dir: atmuxDir, team });

  const lanedMembers = team.members.filter((m) => m.lane !== undefined && m.lane.length > 0);

  // ADR-080 §A2: lookup the lead member name + the team's ctx-rotate
  // threshold once per tick; the lead-only refusal gate inside the loop
  // consumes both. Threshold default `70` mirrors `whip.leadCtxRotateThreshold`'s
  // schema default — when team.whip is omitted, the lead refusal still
  // fires at the same threshold whip uses for its rotate-recommendation.
  const leadName = team.members.find((m) => m.role === "team-lead")?.name;
  const leadCtxRotateThreshold = team.whip?.leadCtxRotateThreshold ?? 70;

  const outcomes: Record<string, LaneTickMemberOutcome> = {};

  for (const member of lanedMembers) {
    const windowTarget = resolveWindowTarget(session, member);

    let classification: PaneClassification;
    let paneText = "";
    try {
      paneText = await capture(windowTarget);
      classification = classifyText(paneText);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`lane-tick: ${member.name}: capture error (${msg}) — skip`);
      outcomes[member.name] = "skip-capture-error";
      continue;
    }

    if (classification.state !== "READY") {
      log(
        `lane-tick: ${member.name}: state=${classification.state} ` +
          `(evidence=${truncate(classification.evidence, 60)}) — skip`,
      );
      outcomes[member.name] = "skip-not-ready";
      continue;
    }

    const sendOpts: SafeSendOpts = {
      capture,
      sendKeys: sendKeysFn,
      log,
    };

    // ADR-080 §A2: when this member is the team lead AND the pane
    // ctx-pct is at-or-above `leadCtxRotateThreshold`, swap the
    // injected text from `claim --next` to a `/team rotate-lead`
    // nudge. Rationale: a high-ctx lead that picks up another claim
    // is the exact "67% ctx + queued claim defeats rotation" scenario
    // the operator flagged on 2026-05-09 07:25 MYT (sopx-driver bundle).
    // Re-using §A1's `parseLeadCtxPct` keeps the parser surface unified.
    let claimText = `atmux claim --next --as ${member.name}`;
    let isRotateNudge = false;
    if (leadName !== undefined && member.name === leadName) {
      const ctxPct = parseLeadCtxPct(paneText);
      if (ctxPct !== null && ctxPct >= leadCtxRotateThreshold) {
        log(
          `lane-tick: ${member.name}: lead ctx=${ctxPct}% ≥ ` +
            `${leadCtxRotateThreshold}% — sending /team rotate-lead nudge ` +
            `instead of claim --next`,
        );
        claimText = "/team rotate-lead";
        isRotateNudge = true;
      }
    }

    const result = await sendFn(windowTarget, claimText, sendOpts);
    if (result.outcome === "sent") {
      if (isRotateNudge) {
        log(`lane-tick: ${member.name}: injected /team rotate-lead (state=READY)`);
        outcomes[member.name] = "injected-rotate-nudge";
      } else {
        log(`lane-tick: ${member.name}: injected claim --next (state=READY)`);
        outcomes[member.name] = "injected";
      }
    } else {
      log(
        `lane-tick: ${member.name}: send refused (outcome=${result.outcome}, ` +
          `state=${result.finalClassification.state}) — skip`,
      );
      outcomes[member.name] = "skip-send-refused";
    }
  }

  // ADR-080 §B2: auto-done scan — back-fill `atmux done` for in-progress
  // `commit t-X` tasks whose commit landed in the gitter repo but whose
  // kanban entry was never closed. Runs after the claim-injection loop
  // (the loop is the hot path; the scan is best-effort per-tick polish).
  // Best-effort: any failure logs and continues — the per-member loop
  // already returned its outcomes; we don't want a kanban / git fault
  // to mask successful injections.
  let autoDoneResolved = 0;
  try {
    const scanOpts: AutoDoneScanOpts = { backfill: false, log };
    if (deps.git !== undefined) scanOpts.git = deps.git;
    autoDoneResolved = await runAutoDoneScan(atmuxDir, team, scanOpts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`lane-tick: auto-done scan error (${msg}) — skip`);
  }

  return { visited: lanedMembers.length, outcomes, autoDoneResolved };
}

// ---------- ADR-080 §B2: auto-done scan ----------

/** Options for `runAutoDoneScan`. Exported for direct unit-testing. */
export interface AutoDoneScanOpts {
  /** When true, scan ignores `task.createdAt` and looks at all of git
   *  history (`sinceMs = 0`). Used by `atmux lane-tick --backfill-done`
   *  for the operator's one-shot recovery of legacy stale tasks (the
   *  29-task sopx case). Default false (per-tick polling uses the
   *  task's own `createdAt` as the lower bound). */
  backfill?: boolean;
  /** Git spawn override for tests. */
  git?: GitSpawn;
  /** Logger; defaults to stderr via the caller's chain. */
  log?: (msg: string) => void;
}

/** Subject pattern for a gitter "commit task" — `commit t-XXXXXXXX` or
 *  `commit <something containing t-XXXXXXXX>`. The check is "subject
 *  starts with `commit `" — captures both the operator-observed sopx
 *  shape (`commit t-X`) and longer variants (`commit t-X — fix foo`).
 *  Per ADR-080 §B2: "in-progress `commit t-X` tasks owned by gitter
 *  (or any member with a `commit` task pattern in their subject)". */
const COMMIT_TASK_SUBJECT_RE = /^commit\b/i;

/**
 * Scan kanban for in-progress `commit ...` tasks and back-fill `atmux
 * done` when a matching commit is found in the gitter repo. Returns the
 * count of tasks resolved this scan (i.e. moved to done). Idempotent:
 * tasks already done are absent from the in-progress filter, so a
 * re-run with no new commits is a no-op.
 *
 * Repo path resolution:
 *   1. `team.gitter.repoPath` if set.
 *   2. `dirname(atmuxDir)` (atmux-dir's parent — the project root that
 *      contains `.atmux/`). Per OQ-B1 default.
 *
 * Best-effort per-task: a single git failure logs evidence and skips
 * THAT task without breaking the scan loop. The scan is always-safe to
 * re-run — kanban writes happen only on confirmed-match per task.
 */
export async function runAutoDoneScan(
  atmuxDir: string,
  team: Team,
  opts: AutoDoneScanOpts = {},
): Promise<number> {
  const log = opts.log ?? defaultLog;
  const backfill = opts.backfill ?? false;
  const repoPath = team.gitter?.repoPath ?? dirname(atmuxDir);

  const tasks = await listTasks(atmuxDir, { status: "in-progress" });
  const commitTasks = tasks.filter((t) =>
    typeof t.subject === "string" ? COMMIT_TASK_SUBJECT_RE.test(t.subject) : false,
  );
  if (commitTasks.length === 0) return 0;

  let resolved = 0;
  for (const t of commitTasks) {
    const sinceMs = backfill
      ? 0
      : typeof t.createdAt === "number" && t.createdAt > 0
        ? t.createdAt * 1000 // kanban createdAt is epoch seconds
        : 0;
    let sha: string | null = null;
    try {
      const findOpts = opts.git !== undefined ? { git: opts.git } : {};
      sha = await findCommitForTask(repoPath, t.id, sinceMs, findOpts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`lane-tick: auto-done ${t.id}: findCommit error (${msg}) — skip`);
      continue;
    }
    if (sha === null) continue;
    try {
      await moveTask(atmuxDir, t.id, "done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`lane-tick: auto-done ${t.id}: moveTask error (${msg}) — skip`);
      continue;
    }
    log(`lane-tick: auto-done ${t.id} via ${sha.slice(0, 8)}`);
    resolved += 1;
  }
  return resolved;
}

// ---------- Parser ----------

interface ParsedArgs {
  teamDir?: string;
  /** ADR-080 §B2: one-shot back-fill mode — auto-done scan ignores
   *  `task.createdAt` and looks at all of git history. Skips the
   *  per-member claim-injection loop (operator runs this once after
   *  §B2 lands to recover the 29-stale legacy state). */
  backfillDone?: boolean;
}

const USAGE = "atmux lane-tick [--team-dir <dir>] [--backfill-done]";

export function parseLaneTickArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let teamDir: string | undefined;
  let backfillDone = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "lane-tick: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--backfill-done") {
      backfillDone = true;
      i += 1;
      continue;
    }
    throw new UsageError({ what: `lane-tick: unknown flag: ${a}`, hint: USAGE });
  }
  const out: ParsedArgs = {};
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (backfillDone) out.backfillDone = true;
  return out;
}

// ---------- Internals ----------

/** Build the tmux window target string for a member. Matches the
 *  whip.ts resolution: `${session}:${emoji}${name}` for regular
 *  members. Lead-window resolution lives in whip (uses the I-2 marker
 *  fallback for renamed lead windows); lane-tick only iterates
 *  members with `.lane` set, and lead/planner/reviewer/gitter don't
 *  carry a worker lane in practice — the simpler form suffices. */
function resolveWindowTarget(session: string, member: TeamMember): string {
  const windowName = `${member.emoji ?? ""}${member.name}`;
  return `${session}:${windowName}`;
}

/** Recover the member name from a windowTarget string (post-colon,
 *  emoji-stripped). Used only by the default sendKeysFn wrapper to
 *  fill the SendTarget audit metadata. Best-effort — the metadata is
 *  inert at the tmux argv layer. */
function parseMemberFromTarget(target: string): string {
  const after = target.includes(":") ? (target.split(":")[1] ?? "") : target;
  // Strip leading non-alnum (member emoji prefix is variable-length unicode);
  // the first ASCII alnum onward is the member name.
  const m = /[A-Za-z0-9_-].*$/.exec(after);
  return m?.[0] ?? after;
}

function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function count(
  outcomes: Record<string, LaneTickMemberOutcome>,
  outcome: LaneTickMemberOutcome,
): number {
  let n = 0;
  for (const o of Object.values(outcomes)) if (o === outcome) n += 1;
  return n;
}

// Re-export ConfigError so cli.ts dispatch sees the right type when
// requireTeam throws — no functional purpose beyond import hygiene.
export { ConfigError };
