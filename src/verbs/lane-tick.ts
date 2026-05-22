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
  buildWindowName,
  buildWindowNameLegacy,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
  resolveWindowWithRenameShim,
  type WindowShimOps,
} from "../core/common.ts";
import { resolveGoalForMember } from "../core/goal-resolver.ts";
import { listTasks, moveTask, showTask } from "../core/kanban.ts";
import { type CaptureFn, classifyText, type PaneClassification } from "../core/pane-state.ts";
import { pasteAndSubmit } from "../core/paste-submit.ts";
import { detectAndResubmit } from "../core/queued-text-resubmit.ts";
import {
  composerEmpty,
  type SafeSendOpts,
  type SafeSendResult,
  type SendKeysFn,
  safeSendKeys,
  safeSendKeysWithVerify,
} from "../core/safe-send.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import { parseLeadCtxPct } from "./poke.ts";
import { defaultBriefsDir, getBriefPath } from "./rotate.ts";

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
  /** ADR-157 T4: briefs-dir override (default `defaultBriefsDir()`
   *  from rotate.ts). The goal-narrow branch resolves
   *  `<briefsDir>/<role>.md` and parses `## Standing Goal`; tests
   *  inject a temp dir so the matrix runs without real briefs. */
  briefsDir?: string;
  /** ADR-157 T4: override the brief-text resolver. Defaults to
   *  `resolveGoalForMember(member, briefPath)`. Tests inject a fixture
   *  so the goal-skip path runs deterministically without staging a
   *  real brief file. Return value: resolved goal text OR `null` when
   *  no goal is active. */
  resolveGoal?: (member: TeamMember) => Promise<string | null>;
  /** EPIC e-a3077ca0 T5: dep-injectable window-shim ops. Production
   *  wires through `tmux.window.listWindows` + `tmux.window.renameWindow`
   *  so legacy hyphen / no-separator panes self-heal to canonical on the
   *  per-member capture iteration (the production failure path from
   *  t-fabd2528 verify-poll). Tests inject a stub to bypass tmux
   *  invocation entirely; on `null` (the default test path) the helper
   *  falls back to the canonical form without renaming — matches the
   *  pre-shim behavior for fixture-only tests. */
  shimOps?: WindowShimOps | null;
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
  /** EPIC e-f28c2596 T3: `detectAndResubmit` (the helper at the top of
   *  the per-member loop) found queued text in an idle composer and
   *  fired the member's own queued command via `safeSendKeysWithVerify`.
   *  On the helper's `fire` AND `log-failure` outcomes both — both
   *  attempted to re-fire, just one succeeded the verifier and the
   *  other escalated to send-keys-failures.log. Distinct from `injected`
   *  (no claim-injection happened — the member is now executing their
   *  OWN queued command, lane-tick deferred to avoid stacking). */
  | "injected-queued-resubmit"
  | "skip-not-ready"
  | "skip-capture-error"
  | "skip-send-refused"
  /** ADR-157 T4: claim-injection skipped because the member is
   *  goal-driven (Claude `/goal` skill running). The three safety nets
   *  preserved verbatim — auto-done scan + lead-ctx-rotate nudge +
   *  dead-pane / rate-limit-lockout detection — fire INDEPENDENTLY of
   *  this outcome. Lane-tick narrows to backstop for failure modes
   *  `/goal` cannot see; the per-turn Haiku evaluator drives the
   *  drain on the happy path. */
  | "skip-goal-active";

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
      `injected-queued-resubmit=${count(result.outcomes, "injected-queued-resubmit")} ` +
      `auto-done-resolved=${result.autoDoneResolved} ` +
      `skip-not-ready=${count(result.outcomes, "skip-not-ready")} ` +
      `skip-capture-error=${count(result.outcomes, "skip-capture-error")} ` +
      `skip-send-refused=${count(result.outcomes, "skip-send-refused")} ` +
      `skip-goal-active=${count(result.outcomes, "skip-goal-active")}`,
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
  // EPIC e-a3077ca0 T5: shim ops default to tmux.window in production;
  // tests that override `tmux`/`capture` without overriding `shimOps`
  // get `null`-typed dep → resolveMemberWindow short-circuits to
  // canonical without invoking tmux at all (matches the pre-shim
  // behavior for fixture-only tests). Explicit-null is the test
  // contract; production caller defaults to the live tmux wiring.
  const shimOps: WindowShimOps | null =
    deps.shimOps === undefined
      ? {
          listWindowNames: async (s) => (await tmux.window.listWindows(s)).map((w) => w.name),
          renameWindow: (s, from, to) => tmux.window.renameWindow(`${s}:${from}`, to),
        }
      : deps.shimOps;
  const sendKeysFn: SendKeysFn = deps.sendKeysFn ?? buildDefaultSendKeysFn(tmux, team.name);

  const session = await getSessionName({ dir: atmuxDir, team });

  // ADR-157 T4 goal-narrow plumbing — resolve the briefs-dir + the
  // goal-resolver once per tick. Default goal resolver reads each
  // member's role brief at `<briefsDir>/<role>.md` and falls through
  // resolveGoalForMember's chain (member.goal explicit > brief
  // `## Standing Goal` > null). Tests inject `deps.resolveGoal` to
  // bypass file IO + run the matrix deterministically.
  const briefsDir = deps.briefsDir ?? defaultBriefsDir();
  const resolveGoal: (member: TeamMember) => Promise<string | null> =
    deps.resolveGoal ??
    (async (member) => {
      const role = typeof member.role === "string" ? member.role : "member";
      const briefPath = await getBriefPath(role, briefsDir);
      return resolveGoalForMember(member, briefPath);
    });

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
    const windowTarget = await resolveMemberWindowTarget(session, member, shimOps);

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

    // EPIC e-f28c2596 T3 — detect stuck queued text in the composer
    // and re-fire it via ADR-138 verified-send BEFORE running the
    // normal lane-tick claim-injection logic. Helper is pure-of-IO;
    // the closure wraps safeSendKeysWithVerify (which already writes
    // the ADR-168 escalation log on its escalate path — the helper's
    // failureLogFn here is a verb-stderr shim for operator visibility,
    // mirroring T2 (poke.ts, commit 0d69bf3); the on-disk persistence
    // is owned by safe-send, NOT duplicated here).
    //
    // States:
    //   - `noop`        — composer empty; fall through to existing logic.
    //   - `skip`        — queued + mid-turn; fall through (the existing
    //                     READY classification below will mark skip-not-
    //                     ready since active-turn indicators are present).
    //   - `fire`        — queued + idle; helper re-fired the member's own
    //                     queued command + verifier confirmed transition.
    //                     We `continue` so lane-tick does NOT stack a
    //                     second claim-injection on top of the freshly-
    //                     started turn.
    //   - `log-failure` — queued + idle; resubmit attempted but the
    //                     verifier timed out across all retries. The
    //                     wrapped safeSendKeysWithVerify already escalated
    //                     to send-keys-failures.log per ADR-168; we
    //                     `continue` for the same anti-stacking reason
    //                     (the member's composer may still hold queued
    //                     text — pile-on would be incorrect).
    //
    // Best-effort: the entire resubmit call is try/wrapped so a tmux /
    // verifier fault does not crash the auto-done scan that runs after
    // this loop (the scan is the lane-tick-tick's secondary safety net
    // per ADR-080 §B2 and must remain reachable).
    try {
      const queuedAction = await detectAndResubmit(
        paneText,
        async (text) => {
          const r = await safeSendKeysWithVerify({
            target: windowTarget,
            keys: text,
            expectVerifier: composerEmpty(),
            capture,
            sendKeys: sendKeysFn,
            log,
          });
          return { success: r.success, attempts: r.attempts, finalCapture: r.finalCapture };
        },
        Date.now,
        async (entry) => {
          // safeSendKeysWithVerify already persisted the ADR-168 log
          // entry on its escalate path; this shim re-emits a structured
          // line to the verb tick log so operators tailing
          // logs/lane-tick.log see the failure in the per-member stream
          // (mirrors T2's poke.ts pattern for cross-verb consistency).
          log(
            `lane-tick: ${member.name}: queued-text resubmit log-failure ` +
              `(attempts=${entry.sendResult.attempts}, ` +
              `text="${truncate(entry.text, 60)}")`,
          );
        },
      );
      if (queuedAction.kind === "fire") {
        log(
          `lane-tick: ${member.name}: queued-text resubmit FIRED ` +
            `(attempts=${queuedAction.sendResult?.attempts ?? 0}, ` +
            `text="${truncate(queuedAction.text ?? "", 60)}") — ` +
            `skip claim-injection this tick`,
        );
        outcomes[member.name] = "injected-queued-resubmit";
        continue;
      }
      if (queuedAction.kind === "log-failure") {
        log(
          `lane-tick: ${member.name}: queued-text resubmit FAILED ` +
            `(attempts=${queuedAction.sendResult?.attempts ?? 0}) — ` +
            `see ~/.atmux/state/send-keys-failures.log`,
        );
        outcomes[member.name] = "injected-queued-resubmit";
        continue;
      }
      if (queuedAction.kind === "skip") {
        log(`lane-tick: ${member.name}: queued-text resubmit skipped — ${queuedAction.reason}`);
        // Fall through: the active-turn indicator that triggered the
        // helper's skip will also trigger the READY classification's
        // skip-not-ready outcome below, which is the correct audit signal.
      }
    } catch (e) {
      // Best-effort — disk / tmux faults must not abort the wider tick.
      // The auto-done scan + remaining per-member iterations need to
      // remain reachable. Log + fall through to the legacy path.
      log(`lane-tick: ${member.name}: queued-text resubmit threw: ${String(e)} — fall through`);
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
    let claimText = buildClaimText(member.name);
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

    // ADR-157 T4 — goal-active SKIP branch.
    //
    // Ordering (reviewer pre-flag #1 — MUST land after the dead-pane
    // check above AND after the lead-ctx-rotate override): READY-check
    // already passed; lead-ctx-rotate nudge takes priority over the
    // goal-skip (lead can't self-rotate via /goal — that safety net
    // per §D5 #2 MUST fire even for goal-active leads). Goal-skip only
    // applies to the plain `claim --next` injection path.
    //
    // Cursor carve-out (ADR-157 §D4): `runtime === "cursor"` keeps
    // the existing claim-injection path — Cursor CLI has no /goal
    // equivalent, so the cron-driven nudge is the only drain. Goal-
    // field is structurally allowed under cursor runtime (T2
    // WARN-not-refuse) but is a no-op at runtime.
    //
    // Three safety nets PRESERVED (per ADR-157 §D5):
    //   1. Auto-done sweep — fires AFTER this loop for ALL members
    //      regardless of goal-state (see `runAutoDoneScan` below).
    //   2. Lead-ctx-rotate nudge — fires ABOVE for ALL leads
    //      regardless of goal-state (the override happened before
    //      this skip-branch — `isRotateNudge: true` bypasses the
    //      goal-active early-exit).
    //   3. Dead-pane / rate-limit detection — fires ABOVE via the
    //      READY classification (skip-not-ready outcome). A wedged
    //      goal-active member returns to skip-not-ready, NOT to
    //      skip-goal-active, so the operator sees the pane health
    //      problem.
    if (!isRotateNudge && member.runtime !== "cursor") {
      let goalText: string | null = null;
      try {
        goalText = await resolveGoal(member);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Conservative: a goal-resolver failure (corrupt brief,
        // permission denied) MUST NOT silently skip claim-injection
        // — fall through to the existing injection path. Operator
        // sees the warn + drain stays healthy.
        log(
          `lane-tick: ${member.name}: goal-resolve error (${msg}) — ` +
            `falling through to claim --next`,
        );
      }
      if (goalText !== null) {
        // Operator-debuggable log per Task body §3 — cite the
        // resolved-via source so goal-phrasing bugs are easy to
        // trace. team.json wins when member.goal is set + non-empty;
        // brief otherwise.
        const explicit = typeof member.goal === "string" && member.goal.length > 0;
        const resolvedVia = explicit ? "team.json" : "brief";
        log(
          `[lane-tick] skip claim-inject for ${member.name}: ` +
            `goal-active (resolved-via=${resolvedVia})`,
        );
        outcomes[member.name] = "skip-goal-active";
        continue;
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

// ---------- Per-event lean dispatcher (relayd direct send-keys, IX-A) ----------

/** Options for {@link runLaneTickForOne}. Sourced from the relayd
 *  `task.unclaimed` event payload (per ADR-202 §Amendment 2026-05-22
 *  IX-A T3 unified contract): the Rust dispatcher hands the Bun side
 *  `--task-id` + `--lane` from the payload. `TaskUnclaimedPayload` has
 *  no `member` field (task is unclaimed), so the dispatcher derives
 *  member from `team.members[]` via `lane` lookup. `--member` is an
 *  OPTIONAL explicit override on the wire that maps to {@link member}
 *  here; standalone override (without taskId+lane) is rejected at the
 *  parser layer. */
export interface LaneTickForOneOpts {
  /** Target task id (from the relayd task.unclaimed event). Used to
   *  resolve the task on the kanban + as an audit-log identifier on
   *  the dispatch line; the worker still re-pulls via `claim --next`
   *  at its own scope (the same prompt runLaneTick uses). */
  taskId: string;
  /** Lane of the target task. Drives lane-to-member derivation when
   *  {@link member} is omitted: first `team.members[]` entry whose
   *  `.lane === opts.lane` wins. For 1-member-per-lane teams (modern
   *  epic-team default) the pick is deterministic. */
  lane: string;
  /** Optional override of lane-to-member derivation. When provided,
   *  bypasses lane-lookup and dispatches directly to this member;
   *  MUST exist in `team.members[]` (absent → outcome="skip-member-
   *  not-found"). When omitted (the Rust dispatcher's default), the
   *  derivation runs against `team.members[].lane`. */
  member?: string;
}

export type LaneTickForOneOutcome =
  | "injected"
  | "send-failed"
  /** Lane-derivation failed: no `team.members[]` entry with matching
   *  `.lane`. Distinct from skip-member-not-found (which fires when
   *  an explicit --member override doesn't resolve) so operators can
   *  disambiguate misconfigured roster vs misrouted CLI invocation. */
  | "skip-no-member-for-lane"
  | "skip-member-not-found"
  | "skip-task-not-found";

export interface LaneTickForOneResult {
  outcome: LaneTickForOneOutcome;
  /** Resolved member name (post-derivation when --member omitted),
   *  OR `null` when derivation failed (skip-no-member-for-lane). */
  member: string | null;
  taskId: string;
  /** From safeSendKeysWithVerify — number of send attempts (1 on first
   *  verify-pass, up to retries+1 otherwise). 0 when skipped pre-send. */
  attempts: number;
}

/** Injectable deps for {@link runLaneTickForOne} — strict subset of
 *  {@link LaneTickDeps} (no goal-resolver, no git-spawn for auto-done,
 *  no sendFn — the lean dispatcher uses `safeSendKeysWithVerify`
 *  directly). */
export interface LaneTickForOneDeps {
  tmux?: TmuxNamespace;
  capture?: CaptureFn;
  sendKeysFn?: SendKeysFn;
  log?: (msg: string) => void;
  shimOps?: WindowShimOps | null;
}

/**
 * Lean per-event dispatcher: dispatch ONE task to ONE member via
 * `safeSendKeysWithVerify`, skipping the cross-member enumeration loop
 * that {@link runLaneTick} does today.
 *
 * Called by the Rust atmux-relayd lane-router on each `task.unclaimed`
 * event (per ADR-202 §Amendment 2026-05-22 IX-A relayd direct send-keys).
 * The relayd has already routed the event to (task, member, lane); this
 * function trusts that routing and dispatches the same `atmux claim
 * --next --as <member>` prompt {@link runLaneTick} uses, verified-once
 * via `safeSendKeysWithVerify`.
 *
 * Safety nets NOT applied here (the cron-driven {@link runLaneTick}
 * tick remains the backstop): queued-text resubmit, lead-ctx-rotate
 * override, goal-active skip, auto-done scan. Per-event path is
 * intentionally minimal — the polled tick keeps firing per ADR-080 +
 * ADR-157, so the net of safety remains complete.
 */
export async function runLaneTickForOne(
  atmuxDir: string,
  team: Team,
  opts: LaneTickForOneOpts,
  deps: LaneTickForOneDeps = {},
): Promise<LaneTickForOneResult> {
  const log = deps.log ?? defaultLog;

  // Resolve member: explicit override > lane-derivation. For the
  // override path the wire-protocol is "the caller knew the exact
  // member"; for the derivation path the wire-protocol is "the Rust
  // dispatcher passed --lane only, please pick the first matching
  // member". 1-member-per-lane is the modern epic-team default;
  // multi-member-per-lane falls back to first-listed-wins (deliberate
  // simplification — the polled lane-tick remains the load-balanced
  // path).
  let member: TeamMember | undefined;
  if (opts.member !== undefined) {
    member = team.members.find((m) => m.name === opts.member);
    if (member === undefined) {
      log(
        `lane-tick-one: ${opts.member}: member not in team.members[] — skip ` +
          `(task=${opts.taskId}, lane=${opts.lane})`,
      );
      return {
        outcome: "skip-member-not-found",
        member: opts.member,
        taskId: opts.taskId,
        attempts: 0,
      };
    }
  } else {
    member = team.members.find((m) => m.lane === opts.lane);
    if (member === undefined) {
      log(
        `lane-tick-one: lane=${opts.lane} has no member in team.members[] — skip ` +
          `(task=${opts.taskId})`,
      );
      return {
        outcome: "skip-no-member-for-lane",
        member: null,
        taskId: opts.taskId,
        attempts: 0,
      };
    }
  }

  // Resolve task by id so a vanished task (claimed by sibling between
  // event emit + dispatch tick, or wiped by operator) surfaces as a
  // no-op rather than a spurious claim-injection. The worker's own
  // `claim --next` is still authoritative for what they pick up — this
  // is the upstream sanity gate.
  const task = await showTask(atmuxDir, opts.taskId);
  if (task === null) {
    log(
      `lane-tick-one: ${member.name}: task ${opts.taskId} not in kanban — skip ` +
        `(lane=${opts.lane})`,
    );
    return {
      outcome: "skip-task-not-found",
      member: member.name,
      taskId: opts.taskId,
      attempts: 0,
    };
  }

  const tmux = deps.tmux ?? createTmux({ socketPath: resolveTeamSocket(team) });
  const capture: CaptureFn =
    deps.capture ?? ((target: string) => tmux.pane.capturePane({ target, start: -30 }));
  const shimOps: WindowShimOps | null =
    deps.shimOps === undefined
      ? {
          listWindowNames: async (s) => (await tmux.window.listWindows(s)).map((w) => w.name),
          renameWindow: (s, from, to) => tmux.window.renameWindow(`${s}:${from}`, to),
        }
      : deps.shimOps;
  const sendKeysFn: SendKeysFn = deps.sendKeysFn ?? buildDefaultSendKeysFn(tmux, team.name);

  const session = await getSessionName({ dir: atmuxDir, team });
  const windowTarget = await resolveMemberWindowTarget(session, member, shimOps);

  const claimText = buildClaimText(member.name);

  const result = await safeSendKeysWithVerify({
    target: windowTarget,
    keys: claimText,
    expectVerifier: composerEmpty(),
    capture,
    sendKeys: sendKeysFn,
    log,
  });

  if (result.success) {
    log(
      `lane-tick-one: ${member.name}: injected claim --next ` +
        `(task=${opts.taskId}, lane=${opts.lane}, attempts=${result.attempts})`,
    );
    return {
      outcome: "injected",
      member: member.name,
      taskId: opts.taskId,
      attempts: result.attempts,
    };
  }
  log(
    `lane-tick-one: ${member.name}: send-failed — see send-keys-failures.log ` +
      `(task=${opts.taskId}, lane=${opts.lane}, attempts=${result.attempts})`,
  );
  return {
    outcome: "send-failed",
    member: member.name,
    taskId: opts.taskId,
    attempts: result.attempts,
  };
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

/** Compose the claim-injection prompt sent on the happy path. Shared
 *  between {@link runLaneTick} and {@link runLaneTickForOne} so a future
 *  prompt-shape change (e.g. carrying the task id explicitly) lands in
 *  ONE place. The lead-ctx-rotate override in runLaneTick still swaps
 *  to a literal `/team rotate-lead` string — that's a distinct nudge,
 *  not a variation of this template. */
function buildClaimText(memberName: string): string {
  return `atmux claim --next --as ${memberName}`;
}

/** Build the default `sendKeysFn` that both {@link runLaneTick} and
 *  {@link runLaneTickForOne} use when the caller doesn't inject one.
 *
 *  ADR-138 T3b3 (t-06547e2d): when the keystroke is a TEXT BODY
 *  (claim-injection / rotate-nudge zone — the bracketed-paste-Enter-
 *  swallow bug zone), route through `pasteAndSubmit` so the bundled
 *  load-buffer + paste-buffer -d + 500ms settle + C-m cascade lands
 *  the message reliably. Raw `tmux.pane.sendKeys` is preserved for
 *  control-key / modal-dismiss cases (enter:false explicit, single-
 *  character payload) — those don't pass through the bracketed-paste
 *  envelope and are fine on the raw path. */
function buildDefaultSendKeysFn(tmux: TmuxNamespace, teamName: string): SendKeysFn {
  return async (target: string, keys: string, opts) => {
    const sendTarget = {
      kind: "member" as const,
      member: parseMemberFromTarget(target),
      team: teamName,
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
  };
}

/** EPIC e-a3077ca0 T5: build the tmux window target string for a
 *  member, self-healing legacy hyphen / no-separator window names to
 *  the ADR-161 canonical form in-place. Previously this returned
 *  `${session}:${emoji}${name}` (pre-ADR-135 no-separator form) which
 *  was exactly the failure trail captured 2026-05-18 03:52 UTC in
 *  lane-tick.log: `capture error — can't find window: 🦦docs` while
 *  the actual pane was `🦦_docs`.
 *
 *  Behavior: derive canonical (ADR-161-aware) + the two legacy variants,
 *  call resolveWindowWithRenameShim, return `${session}:<canonical>`.
 *  On shim failure (no matching window in any form OR `shimOps === null`
 *  for fixture-only tests) fall back to canonical without renaming —
 *  the downstream capture call will then produce its usual
 *  `capture error` line + skip-capture-error outcome, matching
 *  pre-shim behavior for absent panes.
 *
 *  Lead-window resolution still lives in whip (uses the I-2 marker
 *  fallback for renamed lead windows); lane-tick only iterates
 *  members with `.lane` set, and lead/planner/reviewer/gitter don't
 *  carry a worker lane in practice — the shim suffices here. */
async function resolveMemberWindowTarget(
  session: string,
  member: TeamMember,
  shimOps: WindowShimOps | null,
): Promise<string> {
  const canonical = buildWindowName(member.name, member.emoji, member.label, member.role);
  if (shimOps === null) {
    return `${session}:${canonical}`;
  }
  const adr135Hyphen = buildWindowName(member.name, member.emoji, member.label);
  const pre135NoSep = buildWindowNameLegacy(member.name, member.emoji);
  let windowName: string;
  try {
    windowName = await resolveWindowWithRenameShim(
      session,
      canonical,
      [adr135Hyphen, pre135NoSep],
      shimOps,
    );
  } catch {
    // Either no matching window OR list-windows failed (tmux unavailable
    // in test harness). Fall back to canonical so the downstream
    // capture call produces its `capture error` log line + the per-
    // member loop logs skip-capture-error — matches pre-shim behavior.
    windowName = canonical;
  }
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
