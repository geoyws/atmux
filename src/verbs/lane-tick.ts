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

import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { type CaptureFn, classifyText, type PaneClassification } from "../core/pane-state.ts";
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
}

export interface LaneTickResult {
  /** Members iterated (laned only). */
  visited: number;
  /** Per-member outcome — keyed on member name. */
  outcomes: Record<string, LaneTickMemberOutcome>;
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

  const result = await runLaneTick(atmuxDir, team, deps);
  // Surface a one-line summary on stderr for cron-log grep.
  const log = deps.log ?? defaultLog;
  log(
    `lane-tick: visited=${result.visited} ` +
      `injected=${count(result.outcomes, "injected")} ` +
      `injected-rotate-nudge=${count(result.outcomes, "injected-rotate-nudge")} ` +
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
  const tmux = deps.tmux ?? createTmux({ socketPath: getDefaultSocket(team.name) });
  const sendFn = deps.sendFn ?? safeSendKeys;
  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  const sendKeysFn: SendKeysFn =
    deps.sendKeysFn ??
    (async (target: string, keys: string, opts) => {
      // safeSendKeys passes the same string we passed to it as `target`,
      // which we built as `${session}:${windowName}` below. Wrap in the
      // SendTarget discriminated union for the input-injection contract
      // (ADR-025). The member name is recovered from the windowTarget
      // suffix (see resolveWindowTarget); tests don't exercise this
      // path, so no further plumbing needed.
      await tmux.pane.sendKeys({
        target: { kind: "member", member: parseMemberFromTarget(target), team: team.name, target },
        keys,
        enter: opts?.enter ?? true,
      });
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

  return { visited: lanedMembers.length, outcomes };
}

// ---------- Parser ----------

interface ParsedArgs {
  teamDir?: string;
}

const USAGE = "atmux lane-tick [--team-dir <dir>]";

export function parseLaneTickArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let teamDir: string | undefined;
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
    throw new UsageError({ what: `lane-tick: unknown flag: ${a}`, hint: USAGE });
  }
  const out: ParsedArgs = {};
  if (teamDir !== undefined) out.teamDir = teamDir;
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
