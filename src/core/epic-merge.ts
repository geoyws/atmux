// ADR-091 §State machine: epic-team auto-merger caller.
//
// Sibling of `src/core/intra-team-merge.ts` (ADR-134, intra-team
// per-member-branch fan-in). Both callers compose the same shared
// state machine in `src/core/branch-merge-state.ts` plus the same
// persistence layer (`MergerStateRepo`); the only difference is the
// SCOPE of the `<base>-<branch>` pair:
//
//   - intra-team-merge.ts  — `<teamBase>-<member>`   → `<teamBase>`
//                            (one row per per-member branch)
//   - epic-merge.ts (this) — `<parentBase>-epic-<epicId>` → `<parentBase>`
//                            (one row per epic-team — shared-worktree
//                            carve-out per ADR-090 §Decision-anchor #3)
//
// The MergerStateRepo's primary key is the branch-name string; no
// schema migration is needed for epic-team rows — they coexist with
// intra-team rows in the same `merger_state` table, addressed by the
// epic-team's branch name.
//
// ADR-091 design doc (`docs/adr/091-kanban-driven-auto-merge.md`) is
// not yet drafted (t-4af76f05 still todo at file-time); this caller
// lands per the driver's planner-discretion instruction (ADR-091 impl
// can ship before the design doc when the shared state machine is
// already on disk + ADR-090 fixes the integration contract). The
// design here is pinned to:
//
//   - ADR-090 §EPIC-done definition (§Decision-anchor #5):
//     EPIC.status="done" iff (a) all child Tasks done, (b) worktree
//     clean, (c) HEAD ahead of parentBase, (d) `reviewer-trunk-
//     signoff` Task in done.
//   - ADR-090 §Decision-anchor #6: mergeMode "auto" runs the merge,
//     "pr" is schema-accept-runtime-noop in v1.
//   - ADR-090 §`gitter` extension: epic-team's gitter does NOT run
//     trunk merge — that's this caller's job, fired from cron.
//   - ADR-090 §`dissolve-epic`: on `merged` success, this caller
//     auto-dispatches `atmux team dissolve-epic --auto <epicId>`
//     (verb landing in T9 t-b430b185; until T9 lands, the dispatch
//     is a logged TODO and operator dissolves manually).
//
// Reviewer pre-flag #2 (epic-team gitter cron ownership): cron-line
// emission lives in `src/core/cron.ts::renderCronLines` — gated on
// `team.epicTeam !== undefined`, fires `atmux epic-merge tick` every
// 5min by default. The verb itself runs the gate + state-machine
// + merge + dissolve-dispatch; this module is the pure-of-cron core.

import type { GitSpawn } from "../abstractions/branch-merge.ts";
import { defaultGitSpawn, MergeConflictError, mergeMember } from "../abstractions/branch-merge.ts";
import {
  type BranchMergeState,
  isTerminalState,
  type PreMergeGateInput,
  shouldTransitionFromInProgress,
} from "./branch-merge-state.ts";
import type { MergerStateRepo } from "./repositories/merger-state-repo.ts";

// ---------- Context + result types ----------

/** Per-epic-team context for one tick of {@link performEpicMerge}.
 *  Mirrors `IntraTeamMergeContext` shape so callers familiar with
 *  ADR-134's wrapper find the same fields here, plus three epic-
 *  team-specific extras: `mergeMode` (ADR-090 §Decision-anchor #6),
 *  `epicId` (for dissolve-epic dispatch on success), and
 *  `hasReviewerTrunkSignoff` (ADR-090 §Decision-anchor #5 trunk-
 *  signoff Task gate — encoded here rather than inside the shared
 *  `PreMergeGateInput` so ADR-134's caller stays scope-clean). */
export interface EpicMergeContext {
  /** Epic-team's shared branch (`<parentBase>-epic-<epicId>`). Primary
   *  key into `merger_state` — one row per epic-team since members
   *  share the worktree per ADR-090 §Decision-anchor #3 carve-out. */
  epicBranch: string;
  /** Parent team's base branch (e.g. `geoyws`, `sopx-geoyws`). The
   *  fan-in destination — `mergeMember` checks this out before
   *  running `git merge --no-ff <epicBranch>`. */
  parentBase: string;
  /** Absolute path to the parent team's worktree (NOT the epic-team's
   *  worktree). The merge runs against the parent's branch; the
   *  epic-team's worktree is on the EPIC's branch and not involved
   *  in the merge step itself. */
  parentRepoPath: string;
  /** Pre-resolved gate facts. The caller (cron tick verb) pulls these
   *  from the epic-team's kanban repo + `git -C parentRepoPath` +
   *  `git -C epicRepoPath` probes. Pure inputs keep the wrapper's
   *  branch logic deterministic. */
  gate: PreMergeGateInput;
  /** ADR-090 §Decision-anchor #5: true iff a Task with
   *  `role: "reviewer-trunk-signoff"` exists in `status: "done"` in
   *  the epic-team's kanban. The caller pre-resolves via a single
   *  state.db query; an unset gate (no signoff Task on file) blocks
   *  the `in_progress → ready_to_merge` transition with a clear
   *  reason regardless of the other gate facts. */
  hasReviewerTrunkSignoff: boolean;
  /** ADR-090 §Decision-anchor #6: merge dispatch mode. `"auto"` runs
   *  `git merge --no-ff` (default, v1). `"pr"` is schema-accept-
   *  runtime-noop — the wrapper short-circuits at `ready_to_merge`
   *  with a logged "pr-mode runtime deferred" reason and does NOT
   *  advance to `merging`. */
  mergeMode: "auto" | "pr";
  /** Epic-team kanban id (`e-XXXXXXXX` from parent's state.db Epic
   *  row). Used to compose the `atmux team dissolve-epic --auto
   *  <epicId>` dispatch on `merged` success — the dissolve verb
   *  (t-b430b185, T9) takes the epic-team's name as positional, but
   *  the kanban row is identified by epicId in parent's state.db.
   *  Surface to operators in `merger_state.note` for traceability. */
  epicId: string;
  /** Repo for the merger_state ledger. Caller constructs once per
   *  Database handle; reused across `performEpicMerge` ticks. The
   *  same MergerStateRepo serves intra-team rows + epic-team rows
   *  — they coexist by branch-name string. */
  repo: MergerStateRepo;
  /** Caller identity for `merger_state.transitioned_by`. Defaults
   *  to `"epic-cron"` — the cron tick's typical attribution.
   *  Operator-driven verb invocation passes `"operator"`. */
  by?: string;
  /** Clock — unix epoch seconds. Defaults to `Math.floor(Date.now()
   *  / 1000)`. Tests pin to a fixed value for reproducible
   *  `transitioned_at` columns. */
  now?: () => number;
  /** Git spawn override (test injection). Defaults to `defaultGitSpawn`. */
  git?: GitSpawn;
  /** When false, skip the `git fetch origin <parentBase>` step
   *  before merge. Default `true`. Tests pass `false` for local-only
   *  git fixtures. */
  fetch?: boolean;
  /** ADR-090↔ADR-091 wire-up hook (t-9a8b0e4e). When provided, fires
   *  on `merging → merged` success to dispatch the dissolve-epic verb
   *  per ADR-090 §dissolve-epic step 3. Production default lives in
   *  `verbs/epic-merge.ts::defaultDispatchDissolve` — it imports +
   *  invokes `dissolveEpic` directly with `callerScope: "driver"`
   *  injected (the cron-fired auto-merger IS the legitimate dispatcher
   *  per ADR-091 state machine). Tests stub a no-op or capture-args
   *  variant; core unit tests that don't care about the dispatch path
   *  leave it `undefined`, in which case {@link tryDispatchDissolve}
   *  logs the TODO + returns `false` (pre-wire-up behavior). Keeps
   *  `src/core/*` free of `src/verbs/*` imports — layering stays
   *  clean. */
  dispatchDissolve?: (epicId: string, by: string) => Promise<boolean>;
}

/** Result of one `performEpicMerge` tick. Same shape as
 *  `PerformMergeResult` from intra-team-merge.ts so callers can
 *  share dispatch logic; adds `dissolveDispatched` for the
 *  `merged → auto-dissolve` audit trail. */
export interface PerformEpicMergeResult {
  /** Post-tick state. Equal to entry state on a no-op tick. */
  state: BranchMergeState;
  /** True iff the state CHANGED during this tick. False on intentional
   *  no-ops (gate held, terminal short-circuit, pr-mode hold) AND on
   *  concurrency-loss no-ops (TOCTOU mismatch on re-read). */
  changed: boolean;
  /** Operator-facing reason — mirrored into `merger_state.note` for
   *  `atmux status` / Discord surfacing. */
  reason: string;
  /** Set when this tick reached `merged` and `mergeMember` reported a
   *  fresh fan-in SHA. `undefined` on no-op merges (no commits ahead). */
  mergedSha?: string;
  /** True iff this tick auto-dispatched `atmux team dissolve-epic
   *  --auto <epicId>` per ADR-090. False when the dispatch failed,
   *  was skipped (T9 verb absent), or we never reached `merged`. */
  dissolveDispatched: boolean;
}

// ---------- Helper — guarded transition with TOCTOU re-read ----------

/** Re-read state then write a transition. Mirrors the intra-team-
 *  merge guardedTransition shape for cross-caller consistency. */
function guardedTransition(
  repo: MergerStateRepo,
  args: {
    epicBranch: string;
    fromState: BranchMergeState;
    toState: BranchMergeState;
    note: string | null;
    by: string;
    now: number;
    baseSha?: string | null;
    conflictSha?: string | null;
  },
): { applied: boolean; observedFrom: BranchMergeState } {
  const current = repo.getState(args.epicBranch);
  // Null-row is the implicit `open` initial state per ADR-134
  // §state-machine — same convention applies to epic-team rows.
  const observed: BranchMergeState = current?.state ?? "open";
  if (observed !== args.fromState) {
    return { applied: false, observedFrom: observed };
  }
  const tx: Parameters<MergerStateRepo["transition"]>[0] = {
    memberBranch: args.epicBranch,
    next: args.toState,
    note: args.note,
    by: args.by,
    transitionedAt: args.now,
  };
  if (args.baseSha !== undefined) tx.baseSha = args.baseSha;
  if (args.conflictSha !== undefined) tx.conflictSha = args.conflictSha;
  repo.transition(tx);
  return { applied: true, observedFrom: observed };
}

// ---------- Pure gate refinement: ADR-090 §EPIC-done definition ----------

/** Refines {@link shouldTransitionFromInProgress} with ADR-090's
 *  reviewer-trunk-signoff Task gate (§Decision-anchor #5). Pure —
 *  no I/O, deterministic given the inputs. Decision priority (first
 *  matching reason wins):
 *
 *    1. owner has open tasks         → stay `in_progress`
 *    2. worktree dirty               → stay `in_progress`
 *    3. branch not ahead of base     → stay `in_progress`
 *    4. **reviewer-trunk-signoff missing → stay `in_progress`** ← NEW
 *    5. base moved during work       → transition `rebasing`
 *    6. otherwise                    → transition `ready_to_merge`
 *
 *  The trunk-signoff gate sits BETWEEN the basic gate facts and the
 *  base-moved decision so a missing signoff doesn't get masked by a
 *  rebase recommendation — the operator sees "missing trunk-signoff"
 *  before "rebase pending", which matches the human-priority order
 *  (reviewer hasn't blessed yet, no point preparing for merge).
 */
export function shouldEpicTransitionFromInProgress(
  gate: PreMergeGateInput,
  hasReviewerTrunkSignoff: boolean,
): { next: BranchMergeState; reason: string } {
  // Run the shared gate first — it covers items 1-3 + 5.
  const sharedDecision = shouldTransitionFromInProgress(gate);
  // If shared gate already vetoed (1-3), surface its reason verbatim.
  if (sharedDecision.next === "in_progress") return sharedDecision;
  // Shared gate passed. Now check ADR-090 §Decision-anchor #5: the
  // reviewer-trunk-signoff Task is a HARD gate — without it, the EPIC
  // is not done regardless of the other facts.
  if (!hasReviewerTrunkSignoff) {
    return {
      next: "in_progress",
      reason:
        "missing reviewer-trunk-signoff — reviewer must file done Task with role='reviewer-trunk-signoff' (ADR-090 §Decision-anchor #5)",
    };
  }
  // Shared gate's recommendation (rebasing OR ready_to_merge) wins.
  return sharedDecision;
}

// ---------- Side-effecting wrapper ----------

/**
 * One state-machine tick for an epic-team. Reads the row (keyed by
 * `epicBranch`), picks the appropriate transition by current state +
 * gate input + reviewer-trunk-signoff facts, applies it via the
 * repo's BEGIN IMMEDIATE wrapper, and (on `merged` success)
 * auto-dispatches `atmux team dissolve-epic --auto <epicId>` per
 * ADR-090's lifecycle.
 *
 * Tick semantics (one tick = one observable advance):
 *
 *   - **No row OR `open`** → seed `in_progress` (the cron's first
 *     tick on a freshly-spawned epic-team produces this; null-row is
 *     treated as implicit `open` per the repo's ADR-134 convention,
 *     applied verbatim to ADR-091 epic-team rows).
 *
 *   - **`in_progress`** → consult {@link shouldEpicTransitionFromInProgress}:
 *     stays `in_progress` (gate held — including missing trunk-signoff),
 *     advances to `ready_to_merge` (all gates clear, base stable), or
 *     advances to `rebasing` (gates clear, base moved during work).
 *
 *   - **`ready_to_merge`** → branch on `ctx.mergeMode`:
 *
 *       - `"auto"` (default, v1): advance to `merging` and run
 *         `mergeMember(parentBase, epicBranch, parentRepoPath)`. On
 *         `MergeConflictError` → terminal `conflict` with note. On
 *         `{ status: 'no-op' }` → terminal `merged` (no commits
 *         ahead — epic-team had nothing to fan in; dissolve-dispatch
 *         still fires per ADR-090 §dissolve-epic). On `{ status:
 *         'merged', sha }` → terminal `merged` directly (no `tested`
 *         intermediate — ADR-090 EPIC-done already absorbed the
 *         test-coverage gate via the `reviewer-trunk-signoff` Task
 *         filed by the reviewer). Then auto-dispatch dissolve-epic.
 *
 *       - `"pr"` (deferred, v1): no-op short-circuit. Stays in
 *         `ready_to_merge` with reason "pr-mode runtime deferred —
 *         schema-accept-runtime-noop per ADR-090 §Decision-anchor
 *         #6". Future ADR ships the pr-mode runtime; the schema
 *         field is reserved at ADR-090 T1.
 *
 *   - **`rebasing` / `merging` / `tested` / `test_failed`** — caller-
 *     driven holding states. ADR-091 epic-team scope does NOT use
 *     `tested` / `test_failed` (test gate is absorbed by the
 *     reviewer-trunk-signoff filing per §Decision-anchor #5 above);
 *     `rebasing` and mid-flight `merging` are no-op observed states
 *     for the cron tick. Rebase resolution lives in the cron's
 *     outer wiring (a future Task — for now, operators resolve
 *     rebase conflicts manually and reset the row to `in_progress`
 *     per ADR-134's manual-recovery convention).
 *
 *   - **Terminal (`merged` / `conflict` / `reverted`)** — no-op
 *     return; `merged` rows have already auto-dispatched dissolve
 *     when they were FIRST written (the `dissolveDispatched: true`
 *     flag was set on that prior tick). Subsequent ticks observe
 *     terminal and short-circuit.
 *
 * Concurrency: every state-mutation routes through `repo.transition()`
 * which wraps `BEGIN IMMEDIATE`. The `guardedTransition` helper re-
 * reads state before each write and short-circuits on TOCTOU
 * mismatch — best-effort guard that complements the serialized
 * write path. ADR-090 §Decision-anchor #11 documents that pr-mode's
 * eventual `gh auth switch` serialization is a separate cockpit-
 * scoped advisory lock (not this row-level guard) — out of scope
 * for v1 since pr-mode is runtime-noop.
 */
export async function performEpicMerge(ctx: EpicMergeContext): Promise<PerformEpicMergeResult> {
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const by = ctx.by ?? "epic-cron";
  const t = now();

  const row = ctx.repo.getState(ctx.epicBranch);
  const currentState: BranchMergeState = row?.state ?? "open";

  // Terminal? No-op return. ADR-090 §dissolve-epic + ADR-091 expect
  // operator (or the dissolve-epic verb itself) to drive recovery
  // from `conflict`; `merged` is the final happy-path state and the
  // dissolve-dispatch was fired on the tick that REACHED it (this
  // tick observes a stale row and just confirms).
  if (isTerminalState(currentState)) {
    return {
      state: currentState,
      changed: false,
      reason: `terminal state '${currentState}' — dissolve-epic ${currentState === "merged" ? "already auto-dispatched" : "operator-resolution required"}`,
      dissolveDispatched: false,
    };
  }

  // null OR open → in_progress. First-cron-tick seed for a freshly-
  // spawned epic-team.
  if (currentState === "open") {
    const r = guardedTransition(ctx.repo, {
      epicBranch: ctx.epicBranch,
      fromState: "open",
      toState: "in_progress",
      note: `epic-team ${ctx.epicId} spawned — fan-in pending`,
      by,
      now: t,
    });
    return {
      state: r.applied ? "in_progress" : r.observedFrom,
      changed: r.applied,
      reason: r.applied
        ? `epic-team ${ctx.epicId} spawned — fan-in pending`
        : `concurrency lost: row was '${r.observedFrom}', expected 'open'`,
      dissolveDispatched: false,
    };
  }

  // in_progress → epic-aware gate decision (refines shared gate with
  // reviewer-trunk-signoff per §Decision-anchor #5).
  if (currentState === "in_progress") {
    const decision = shouldEpicTransitionFromInProgress(ctx.gate, ctx.hasReviewerTrunkSignoff);
    const r = guardedTransition(ctx.repo, {
      epicBranch: ctx.epicBranch,
      fromState: "in_progress",
      toState: decision.next,
      note: decision.reason,
      by,
      now: t,
    });
    return {
      state: r.applied ? decision.next : r.observedFrom,
      changed: r.applied,
      reason: r.applied
        ? decision.reason
        : `concurrency lost: row was '${r.observedFrom}', expected 'in_progress'`,
      dissolveDispatched: false,
    };
  }

  // ready_to_merge → branch on mergeMode (ADR-090 §Decision-anchor #6).
  if (currentState === "ready_to_merge") {
    if (ctx.mergeMode === "pr") {
      // Schema-accept-runtime-noop per §Decision-anchor #6. Stay in
      // `ready_to_merge`; refresh the note so operators inspecting
      // the row see the deferred-runtime explanation rather than a
      // stale "all checks pass" message from the prior in_progress
      // tick. Not a transition (state unchanged) — emit a no-op
      // result with the explanation.
      return {
        state: "ready_to_merge",
        changed: false,
        reason:
          "pr-mode runtime deferred — schema-accept-runtime-noop per ADR-090 §Decision-anchor #6 (pr-runtime ships in a future ADR)",
        dissolveDispatched: false,
      };
    }
    // mergeMode === "auto" — proceed with the merge.
    return await runAutoMerge(ctx, t, by, now);
  }

  // rebasing / merging / tested / test_failed — observed mid-flight
  // states. ADR-091 epic-team scope does NOT use the `tested`
  // intermediate (the trunk-signoff Task is the test-coverage gate
  // per §Decision-anchor #5, applied at the in_progress→
  // ready_to_merge boundary instead of post-merge). `rebasing` and a
  // mid-flight `merging` (e.g. crash-mid-merge) are no-op observed
  // states; operator manual reset + the next cron tick re-evaluate.
  return {
    state: currentState,
    changed: false,
    reason: `state '${currentState}' is mid-flight or operator-resolution-required — waiting on outer wiring`,
    dissolveDispatched: false,
  };
}

// ---------- Internal — auto-mode merge runner ----------

/** Composes the `ready_to_merge → merging → merged | conflict`
 *  sequence for `mergeMode === "auto"`. Extracted so the top-level
 *  state-dispatch reads cleanly without inline async branches.
 *  ADR-091 epic-team scope skips the `tested` intermediate per
 *  §Decision-anchor #5 — the test-coverage gate was already
 *  satisfied by the `reviewer-trunk-signoff` Task before
 *  `ready_to_merge` was reached. */
async function runAutoMerge(
  ctx: EpicMergeContext,
  t: number,
  by: string,
  now: () => number,
): Promise<PerformEpicMergeResult> {
  // Optimistic transition to `merging` first (durable signal — write
  // the in-flight state BEFORE the side effect, so a crash mid-merge
  // leaves an operator-visible row matching ADR-134 §Conflict
  // surface §1 convention).
  const enter = guardedTransition(ctx.repo, {
    epicBranch: ctx.epicBranch,
    fromState: "ready_to_merge",
    toState: "merging",
    note: `running git merge --no-ff ${ctx.epicBranch} on parent ${ctx.parentBase}`,
    by,
    now: t,
  });
  if (!enter.applied) {
    return {
      state: enter.observedFrom,
      changed: false,
      reason: `concurrency lost entering merging: row was '${enter.observedFrom}'`,
      dissolveDispatched: false,
    };
  }

  const opts: { git?: GitSpawn; fetch?: boolean } = {};
  if (ctx.git !== undefined) opts.git = ctx.git;
  if (ctx.fetch !== undefined) opts.fetch = ctx.fetch;
  else opts.git = ctx.git ?? defaultGitSpawn;

  try {
    const mr = await mergeMember(ctx.parentBase, ctx.epicBranch, ctx.parentRepoPath, opts);
    const t2 = now();

    if (mr.status === "no-op") {
      // Epic-team had nothing to fan in (HEAD === parentBase already).
      // Per ADR-090 §dissolve-epic step 5, dissolve-epic still runs
      // — the epic-team is "done" from the kanban side and the
      // worktree should be torn down. Mark merged + dispatch dissolve.
      const reason = `no-op (no commits ahead of ${ctx.parentBase}) — dissolve still pending`;
      const r = guardedTransition(ctx.repo, {
        epicBranch: ctx.epicBranch,
        fromState: "merging",
        toState: "merged",
        note: reason,
        by,
        now: t2,
      });
      const dispatched = r.applied ? await tryDispatchDissolve(ctx, by) : false;
      return {
        state: r.applied ? "merged" : r.observedFrom,
        changed: r.applied,
        reason,
        dissolveDispatched: dispatched,
      };
    }

    // status === "merged" — direct to terminal `merged` (skip
    // `tested` per §Decision-anchor #5 above).
    const reason = `merge sha ${mr.sha} on ${ctx.parentBase} — dissolve dispatching`;
    const r = guardedTransition(ctx.repo, {
      epicBranch: ctx.epicBranch,
      fromState: "merging",
      toState: "merged",
      note: reason,
      by,
      now: t2,
      baseSha: mr.sha,
    });
    const dispatched = r.applied ? await tryDispatchDissolve(ctx, by) : false;
    const result: PerformEpicMergeResult = {
      state: r.applied ? "merged" : r.observedFrom,
      changed: r.applied,
      reason,
      dissolveDispatched: dispatched,
    };
    if (r.applied) result.mergedSha = mr.sha;
    return result;
  } catch (e) {
    if (e instanceof MergeConflictError) {
      const paths = e.conflictPaths.slice(0, 5).join(", ");
      const reason = `conflict on ${e.wtBranch}: ${paths}`;
      const t2 = now();
      // Force-write the conflict transition (terminal — guardedTransition
      // would short-circuit on a sibling-writer race; the terminal
      // write is more important than the TOCTOU guard here, matching
      // intra-team-merge.ts:343-358 precedent).
      ctx.repo.transition({
        memberBranch: ctx.epicBranch,
        next: "conflict",
        note: reason,
        by,
        transitionedAt: t2,
      });
      return {
        state: "conflict",
        changed: true,
        reason,
        dissolveDispatched: false,
      };
    }
    // Non-conflict throw (git missing, parentRepoPath gone, etc.) —
    // leave the row in `merging` for operator inspection.
    throw e;
  }
}

// ---------- Internal — dissolve-epic dispatch (ADR-090 §dissolve-epic) ----------

/** Attempts to fire the dissolve-epic verb after a successful merge.
 *  ADR-090 §dissolve-epic step 3 names this as the cron-fired post-
 *  merge cleanup path. The actual dispatch lives behind
 *  {@link EpicMergeContext.dispatchDissolve} — a hook the verb layer
 *  wires to `dissolveEpic(...)` from `verbs/team/dissolve-epic.ts`
 *  with `callerScope: "driver"` injected (the cron-fired auto-merger
 *  IS the legitimate dispatcher per ADR-091's state machine).
 *
 *  The hook indirection keeps `src/core/*` free of `src/verbs/*`
 *  imports — clean layering. When the hook is absent (test fixtures
 *  that don't exercise the dissolve path, or a future ad-hoc caller
 *  that wants to log-only), this falls back to the pre-T9 TODO line
 *  so cron logs still surface the unfired dispatch.
 *
 *  Returns `true` iff the dispatch succeeded; `false` on any failure
 *  path (hook absent, hook throws, verb returns non-zero internally).
 *  Failure is NOT thrown — the merge ALREADY succeeded; the dissolve
 *  gap is operator-recoverable via a manual `atmux team dissolve-epic`
 *  invocation later, and the `merger_state.note` carries the merge SHA
 *  so the operator has the receipt regardless. */
async function tryDispatchDissolve(ctx: EpicMergeContext, by: string): Promise<boolean> {
  if (ctx.dispatchDissolve !== undefined) {
    try {
      return await ctx.dispatchDissolve(ctx.epicId, by);
    } catch (e) {
      // Surface the failure on stderr (cron log capture) without
      // throwing — the merge state row is already terminal `merged`
      // by the time we reach this hook, and re-throwing would leave
      // the caller no path to fix anything that isn't operator-
      // recoverable manually.
      process.stderr.write(
        `epic-merge[${by}]: dissolve-epic dispatch for ${ctx.epicId} failed — ${
          e instanceof Error ? e.message : String(e)
        } (operator can retry with \`atmux team dissolve-epic ${ctx.epicId}\`)\n`,
      );
      return false;
    }
  }
  // No hook wired — log the TODO so cron tails surface the gap.
  // Production callers (cron tick, operator-driven verb) always pass
  // `dispatchDissolve`; this branch only fires for ad-hoc core invocations
  // (e.g. unit tests that don't care about the dissolve path).
  process.stderr.write(
    `epic-merge[${by}]: no dispatchDissolve hook wired — skipping auto-dissolve for ${ctx.epicId} ` +
      `(operator can dissolve manually: \`atmux team dissolve-epic ${ctx.epicId}\`)\n`,
  );
  return false;
}
