// ADR-091 + ADR-134 shared state machine for branch auto-merge.
//
// Pure transitions + types only — no I/O. Side-effecting wrappers
// (git ops, state.db writes, conflict surfacing) live in the caller
// modules:
//
//   - src/core/intra-team-merge.ts — ADR-134 intra-team scope
//     (per-member branch → team-base), this Task's main caller.
//   - src/core/epic-merge.ts       — ADR-091 sibling-team scope
//     (epic-team → parent team-base), forthcoming (t-04350614).
//
// Path A reuse decision per Task t-b5f12ab1 body: t-04350614 (ADR-091
// impl) is `todo` with no owner at file-time, so the recommended path
// is to ship the shared module first and let the ADR-091 caller
// follow the same pattern. The state set covers BOTH scopes verbatim
// — ADR-091's 7-state machine `open → in_progress → ready_to_merge
// → rebasing → merging → merged | conflict` plus ADR-134's 3 new
// states `tested`, `test_failed`, `reverted` for the post-merge
// test-gate (ADR-134 §state-machine + §revertOnFail).
//
// ADR-134 spec authored 2026-05-14 at commit `1b0a59a` on `geoyws`
// trunk (not yet on whip-impl branch — this module's design is
// pinned to that commit's spec text). When `geoyws` merges into
// `geoyws-whip-impl`, `docs/adr/134-in-team-auto-merger.md` will
// appear in tree; the citation comments in this file already
// reference the canonical filename.

/** Every state in the branch-merge lifecycle. The ten literals match
 *  ADR-134 §state-machine verbatim and supersede ADR-091's smaller
 *  set (which is a subset).
 *
 *  Terminal states (`merged`, `conflict`, `reverted`) only leave via
 *  operator-driven manual reset back to `in_progress` per ADR-134
 *  §state-machine "Terminal states ... transition back to in_progress
 *  is manual — operator resolves, gitter re-claims on next
 *  event/cron tick." */
export type BranchMergeState =
  | "open"
  | "in_progress"
  | "ready_to_merge"
  | "rebasing"
  | "merging"
  | "tested"
  | "merged"
  | "conflict"
  | "test_failed"
  | "reverted";

/** Frozen enum-shape array of every state literal. Use for runtime
 *  validation (e.g. schema enum bounds) instead of duplicating the
 *  literal list at each call site. */
export const BRANCH_MERGE_STATES: readonly BranchMergeState[] = [
  "open",
  "in_progress",
  "ready_to_merge",
  "rebasing",
  "merging",
  "tested",
  "merged",
  "conflict",
  "test_failed",
  "reverted",
] as const;

/** ADR-134 §state-machine "Terminal states: `merged`, `conflict`,
 *  `reverted`." `test_failed` is intermediate (auto-progresses to
 *  `reverted` when `revertOnFail: true`, else stays for operator
 *  inspection). */
export const TERMINAL_STATES: ReadonlySet<BranchMergeState> = new Set([
  "merged",
  "conflict",
  "reverted",
]);

/** Membership test for {@link TERMINAL_STATES}. */
export function isTerminalState(state: BranchMergeState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Inputs to the pre-merge readiness gate — pure facts derived by
 *  the caller (kanban repo + git probe), not computed inside the
 *  state machine. Shape kept tight so the two callers
 *  (intra-team-merge.ts for ADR-134, epic-merge.ts for ADR-091)
 *  share the same plumbing. */
export interface PreMergeGateInput {
  /** Number of tasks the branch's owner is *actively shipping*. Zero
   *  is the gate-pass condition for the `ready_to_merge` transition
   *  per ADR-134 §triggers §event-driven primary step #2.
   *
   *  Per-scope semantics:
   *   - **intra-team** (`src/core/intra-team-merge-dispatcher.ts`,
   *     §Amendment 2026-05-22) — counts `owner=<member>` rows with
   *     `status='in-progress'` only. `todo` no longer counts; that
   *     pre-amendment semantic structurally wedged long-lived parent-
   *     team members (docs / lead / reviewer) who always carry forward
   *     future todos. Safety intent ("don't fan in mid-active-work")
   *     is preserved by `in-progress` + the worktree-clean gate.
   *   - **epic-team** (`src/verbs/epic-merge.ts`) — unchanged: counts
   *     ALL non-`done`/non-`wontfix` tasks in the epic-team's kanban.
   *     For ephemeral epic-teams, all-tasks-done IS the epic-
   *     complete signal that fan-in is appropriate. */
  ownerOpenTaskCount: number;
  /** True iff the worktree is clean (`git status --porcelain` empty).
   *  ADR-134 reviewer pre-flag #2 requires this gate before any
   *  `worktree set-ref` realign (and by extension, before any
   *  destructive merge that would overwrite uncommitted work). */
  worktreeIsClean: boolean;
  /** True iff the branch has at least one commit not yet on base
   *  (`git rev-list <base>..<branch>` non-empty). Avoids spinning
   *  the state machine on a branch that has nothing to fan in. */
  isAheadOfBase: boolean;
  /** True iff `<base>` advanced after the branch diverged
   *  (`git merge-base --is-ancestor <branch-merge-base> <base>` →
   *  base has commits the branch doesn't carry). Triggers the
   *  `rebasing` detour per ADR-134 §state-machine. */
  baseHasMoved: boolean;
}

/** Decision returned by {@link shouldTransitionFromInProgress}. The
 *  `reason` field is operator-facing — it lands in
 *  `state.db::merger_state.note` (per ADR-134 §Conflict surface §1
 *  "durable signal must precede the fire-and-forget surface"). */
export interface PreMergeGateDecision {
  next: BranchMergeState;
  reason: string;
}

/**
 * Pure pre-merge readiness gate. Pure — no I/O, no Date.now(), no
 * mutation. Both the event-driven dispatcher (ADR-134 §triggers
 * §event-driven primary) and the cron backstop (ADR-134 §triggers
 * §cron backstop secondary) call this with the same input shape;
 * the BEGIN IMMEDIATE wrap on state.db transitions (ADR-134
 * reviewer pre-flag #3) guarantees only one of them actually applies
 * the transition when both fire concurrently.
 *
 * Decision tree (priority order — first matching reason wins):
 *
 *   1. owner has open tasks         → stay `in_progress`
 *      (intra-team: in-progress tasks > 0 per ADR-134 §Amendment
 *       2026-05-22; epic-team: any non-done > 0)
 *   2. worktree dirty               → stay `in_progress`
 *   3. branch not ahead of base     → stay `in_progress`
 *   4. base moved during work       → transition `rebasing`
 *   5. otherwise                    → transition `ready_to_merge`
 *
 * The first three return reasons that name the blocker; operators
 * inspecting `merger_state.note` see *why* the gate hasn't passed.
 */
export function shouldTransitionFromInProgress(input: PreMergeGateInput): PreMergeGateDecision {
  if (input.ownerOpenTaskCount > 0) {
    const plural = input.ownerOpenTaskCount === 1 ? "task" : "tasks";
    return {
      next: "in_progress",
      reason: `${input.ownerOpenTaskCount} open ${plural} — owner still working`,
    };
  }
  if (!input.worktreeIsClean) {
    return {
      next: "in_progress",
      reason: "worktree dirty — member has uncommitted changes",
    };
  }
  if (!input.isAheadOfBase) {
    return {
      next: "in_progress",
      reason: "branch not ahead of base — nothing to merge",
    };
  }
  if (input.baseHasMoved) {
    return {
      next: "rebasing",
      reason: "base moved during work — rebase before merge",
    };
  }
  return {
    next: "ready_to_merge",
    reason: "all checks pass — ready to merge",
  };
}

/** Boolean convenience wrapper matching the signature called out in
 *  the Task body (`shouldTransitionToReady(memberBranch, kanban,
 *  gitState): boolean`). True iff {@link shouldTransitionFromInProgress}
 *  recommends a transition to `ready_to_merge` (i.e. the gate passed
 *  AND the base hasn't moved — `baseHasMoved: true` routes to
 *  `rebasing` first and returns false here). */
export function shouldTransitionToReady(input: PreMergeGateInput): boolean {
  return shouldTransitionFromInProgress(input).next === "ready_to_merge";
}

/** Adjacency map for valid forward transitions per ADR-134
 *  §state-machine. Backward transitions from terminal states
 *  (`conflict` / `reverted`) into `in_progress` are operator-driven
 *  manual resets — modelled separately in {@link isValidTransition}
 *  so the data shape here stays "what the machine itself moves
 *  between" without operator-recovery noise. */
const FORWARD_TRANSITIONS: ReadonlyMap<BranchMergeState, ReadonlySet<BranchMergeState>> = new Map<
  BranchMergeState,
  ReadonlySet<BranchMergeState>
>([
  // `open` only transitions on a task-done event.
  ["open", new Set<BranchMergeState>(["in_progress"])],
  // `in_progress` re-evaluates on every event/cron tick — self-loop
  // is intentional (the cron backstop fires repeatedly while the
  // owner has open tasks, and each fire is a no-op transition to
  // itself).
  ["in_progress", new Set<BranchMergeState>(["ready_to_merge", "in_progress"])],
  // From `ready_to_merge`:
  //   - `rebasing` — base moved during work (ADR-134 + ADR-091 §Decision-anchor #4).
  //   - `merging` — ADR-134 intra-team scope: test happens AFTER the merge.
  //   - `tested` — ADR-144 epic-team scope: test BEFORE merge so a failing
  //     test never lands on parent-trunk. Per ADR-144 §Decision the test-gate
  //     wraps the merge step at the epic-team layer.
  ["ready_to_merge", new Set<BranchMergeState>(["rebasing", "merging", "tested"])],
  // Rebase either succeeds (back to ready_to_merge) or hits a
  // conflict (terminal).
  ["rebasing", new Set<BranchMergeState>(["ready_to_merge", "conflict"])],
  // Merge either runs the test gate or hits a conflict.
  ["merging", new Set<BranchMergeState>(["tested", "conflict", "merged"])],
  // From `tested`:
  //   - `merged` — ADR-134 intra-team scope: post-merge tests passed.
  //   - `test_failed` — tests failed (either scope).
  //   - `merging` — ADR-144 epic-team scope: pre-merge tests passed; proceed
  //     to the actual `git merge --no-ff` step. Gated by {@link canEnterMerging}:
  //     the row's `test_outcome` MUST be `"pass"` or `"bypass"` (operator
  //     ADR-033 driver-scope override). A `"fail"` outcome refuses the
  //     transition at the caller layer.
  ["tested", new Set<BranchMergeState>(["merged", "test_failed", "merging"])],
  // test_failed routes per team.json::autoMerge.revertOnFail. The
  // state machine accepts BOTH terminal `reverted` (revertOnFail:
  // true) AND a manual reset to `in_progress` (revertOnFail: false
  // + operator manual recovery, ADR-144 §test_failed recovery for
  // the epic-team scope via `atmux epic-merge advance --to in-progress`).
  ["test_failed", new Set<BranchMergeState>(["reverted", "in_progress"])],
  // Terminal — no forward transitions from these without an operator
  // manual reset (see {@link isValidTransition}).
  ["merged", new Set<BranchMergeState>()],
  ["conflict", new Set<BranchMergeState>()],
  ["reverted", new Set<BranchMergeState>()],
]);

/** Returns true iff the state machine permits a transition from
 *  `from` to `to`. Operator-driven manual resets from
 *  `conflict` / `reverted` / `test_failed` back to `in_progress` are
 *  always allowed per ADR-134 §state-machine "transition back to
 *  in_progress is manual" and ADR-144 §test_failed recovery; everything
 *  else honors {@link FORWARD_TRANSITIONS}.
 *
 *  `merged → open` is permitted per ADR-134 §Amendment 2026-05-22 (II)
 *  (t-0542595c) — when a long-lived member ships additional commits
 *  past a previous fan-in, the dispatcher auto-re-enters the state
 *  machine by transitioning back to `open`. This is consistent with
 *  the original spec phrase "fresh `open` row after the branch is
 *  realigned to the new base" — pre-amendment, no caller actually
 *  performed that reset, so the row stayed at `merged` and refused
 *  every subsequent commit, requiring manual sqlite intervention. */
export function isValidTransition(from: BranchMergeState, to: BranchMergeState): boolean {
  if ((from === "conflict" || from === "reverted") && to === "in_progress") {
    return true;
  }
  if (from === "merged" && to === "open") {
    return true;
  }
  return FORWARD_TRANSITIONS.get(from)?.has(to) ?? false;
}

/** Test outcome literal per ADR-144 §test_failed recovery + §Operator
 *  bypass. Persisted on the merger_state row (column `test_outcome`,
 *  migration v8→v9) so the test-gate guard can verify the most recent
 *  tested outcome durably across cron ticks.
 *
 *  - `"pass"` — tests passed; `tested → merging` is allowed.
 *  - `"fail"` — tests failed; `tested → merging` is REFUSED. Caller
 *    advances to `test_failed` instead. Per ADR-144 §retryOnFlake, a
 *    single retry may flip this back to `"pass"` before the
 *    `test_failed` transition fires.
 *  - `"bypass"` — operator `--skip-test-gate` override per ADR-144
 *    §Operator bypass. Logged to `~/.atmux/state/test-gate-bypasses.log`
 *    + Discord `[test-gate-bypass]` (T5). Allowed for `tested → merging`
 *    so the operator can rescue a wedged epic when tests are genuinely
 *    broken but the merge is urgent.
 *  - `null` — no test outcome on record. The transition `tested →
 *    merging` is refused; caller must record an outcome first. The
 *    seed value when a row is freshly transitioned TO `tested` without
 *    a paired outcome (e.g. test execution still running). */
export type TestOutcome = "pass" | "fail" | "bypass";

/** Frozen array of every {@link TestOutcome} literal. Mirrors
 *  {@link BRANCH_MERGE_STATES} for Zod enum bounds. */
export const TEST_OUTCOMES: readonly TestOutcome[] = ["pass", "fail", "bypass"] as const;

/** Test-gate guard per ADR-144 §Decision "Refuse 'merging' transition
 *  unless prior 'tested' outcome is PASS." Returns `true` iff:
 *
 *    1. The intended `next` transition is NOT `merging` — gate doesn't
 *       apply (e.g. `merging → tested` for ADR-134 intra-team scope, or
 *       any transition that doesn't touch `merging`).
 *    2. The current `from` state is NOT `tested` — gate doesn't apply
 *       (e.g. ADR-134's `ready_to_merge → merging` direct path skips
 *       the test-gate; intra-team scope's test happens post-merge).
 *    3. The current `from` is `tested` AND the persisted
 *       `testOutcome` is `"pass"` or `"bypass"` — gate passes.
 *
 *  Returns `false` only for the ADR-144 epic-team scope failure mode:
 *  `from === "tested"` AND `next === "merging"` AND the outcome is
 *  `"fail"` OR `null` (unrecorded). Callers translate `false` into a
 *  `test_failed` transition (auto-mode) or a usage error (operator
 *  invocation without `--skip-test-gate`).
 *
 *  Pure — no I/O. The caller has already read the row via
 *  {@link MergerStateRepo.getState}; this function gates the next
 *  transition pre-write. The persisted outcome itself is written by
 *  the test-runner's prior transition `ready_to_merge → tested`
 *  (T3 cage-mode, T4 deployed-mode). */
export function canEnterMerging(
  from: BranchMergeState,
  next: BranchMergeState,
  testOutcome: TestOutcome | null,
): boolean {
  if (next !== "merging") return true;
  if (from !== "tested") return true;
  return testOutcome === "pass" || testOutcome === "bypass";
}
