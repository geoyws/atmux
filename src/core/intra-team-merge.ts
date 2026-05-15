// ADR-134 §state-machine: intra-team auto-merger caller.
//
// Composes the shared state machine
// (`src/core/branch-merge-state.ts`), the persistence layer
// (`src/core/repositories/merger-state-repo.ts`), and the merge
// primitive (`src/abstractions/branch-merge.ts::mergeMember`) into
// one side-effecting wrapper: `performMerge(ctx)` walks the per-
// branch state machine one tick at a time, returning the post-tick
// state + reason for caller observability.
//
// Per ADR-134 §state-machine — the machine is event-driven OR cron-
// backstop; both call this same function with the same context
// shape. BEGIN IMMEDIATE on every state.db transition (via the
// repo) serializes concurrent fires; the guarded
// `transition(fromState → toState)` short-circuits when a sibling
// writer already advanced the row.
//
// Path A confirmed (per Task t-b5f12ab1 body): ADR-091 sibling
// caller `src/core/epic-merge.ts` is `todo` with no owner at
// file-time, so this caller lands first; the ADR-091 caller will
// follow the same compose-shape against the same shared module.

import type { GitSpawn } from "../abstractions/branch-merge.ts";
import {
  defaultGitSpawn,
  MergeConflictError,
  mergeMember,
} from "../abstractions/branch-merge.ts";
import {
  type BranchMergeState,
  isTerminalState,
  type PreMergeGateInput,
  shouldTransitionFromInProgress,
} from "./branch-merge-state.ts";
import type { MergerStateRepo } from "./repositories/merger-state-repo.ts";

// ---------- Context + result types ----------

/** Per-branch context for one tick of `performMerge`. The caller
 *  (event-driven dispatcher OR cron backstop) resolves all of these
 *  from kanban + git probes; the wrapper is otherwise pure-of-IO
 *  except for the merge step itself. */
export interface IntraTeamMergeContext {
  /** Team name. Composes with `branchKey` for the merger_state
   *  row PK. */
  team: string;
  /** Per-member branch (e.g. `geoyws-whip-impl`). The Auto-merger's
   *  fan-in target for this tick. Composes with `team` for the
   *  merger_state row PK. */
  branchKey: string;
  /** Base branch (e.g. `geoyws`). The fan-in destination; mergeMember
   *  checks out this branch before running `git merge --no-ff
   *  <branchKey>`. */
  base: string;
  /** Absolute path to the worktree containing `base` (gitter's
   *  worktree or the team's checkout root). mergeMember runs `git
   *  -C <repoPath>` against this. */
  repoPath: string;
  /** Pre-resolved gate facts — kanban open-task count, worktree
   *  cleanliness, ahead-of-base status, base-moved-during-work
   *  flag. The caller pulls these from the kanban repo + per-
   *  branch git probes; this wrapper does NOT re-resolve them.
   *  Pure inputs keep the wrapper's branch logic deterministic. */
  gate: PreMergeGateInput;
  /** Repo for the merger_state ledger. Caller constructs once per
   *  Database handle; reused across `performMerge` ticks. */
  repo: MergerStateRepo;
  /** Clock — unix epoch seconds. Defaults to `Math.floor(Date.now()
   *  / 1000)`. Tests pin to a fixed value for reproducible
   *  `updated_at` columns. */
  now?: () => number;
  /** Git spawn override (test injection). Defaults to
   *  `defaultGitSpawn`. */
  git?: GitSpawn;
  /** When false, skip the `git fetch origin <base>` step before
   *  merge. Default `true`. Tests pass `false` for local-only
   *  git fixtures. */
  fetch?: boolean;
}

/** Result of one `performMerge` tick. The tuple covers every
 *  observable outcome the caller may want to dispatch on:
 *  state-only updates (gate held / advanced), terminal merges,
 *  conflicts (the merge attempt threw `MergeConflictError`), and
 *  no-op short-circuits (the row didn't exist OR another writer
 *  raced past us). */
export interface PerformMergeResult {
  /** Post-tick state. Equal to entry state on a no-op tick. */
  state: BranchMergeState;
  /** True iff the state CHANGED during this tick. False on
   *  intentional no-ops (gate held in `in_progress`) AND on
   *  concurrency-loss no-ops (repo guard rejected the
   *  transition because a sibling writer already advanced
   *  the row). */
  changed: boolean;
  /** Operator-facing reason — set on every successful transition
   *  (`shouldTransitionFromInProgress.reason` when applicable,
   *  hand-rolled strings on terminal/conflict/test-gate paths).
   *  Mirrored into `merger_state.note` for `atmux status` /
   *  Discord surfacing. */
  reason: string;
  /** Set when this tick's transition reached `merged` and `merge-
   *  member` reported a fresh fan-in SHA. `undefined` on
   *  idempotent re-fires (mergeMember returned `{ status:
   *  'no-op' }` because no commits were ahead). */
  mergedSha?: string;
}

/**
 * One state-machine tick for `(team, branchKey)`. Reads the row,
 * picks the appropriate transition by current state + gate input,
 * applies it via the repo's BEGIN IMMEDIATE wrapper, returns the
 * post-tick observable.
 *
 * Tick semantics (one tick = one observable advance):
 *
 *   - **No row OR `open`** → seed `in_progress` (idempotent via
 *     `upsertOpen` for missing rows; otherwise the explicit
 *     `open → in_progress` transition). The first task-done event
 *     for a branch produces the row; this tick advances it.
 *
 *   - **`in_progress`** → consult `shouldTransitionFromInProgress`:
 *     stays `in_progress` (gate held), advances to `ready_to_merge`
 *     (gate clear, base stable), or advances to `rebasing` (gate
 *     clear, base moved). The "stay" branch is NOT a no-op tick —
 *     we refresh `note` so operators inspecting the row see the
 *     latest gate-held reason.
 *
 *   - **`ready_to_merge`** → advance to `merging` and run
 *     `mergeMember(base, branchKey, repoPath)`. On
 *     `MergeConflictError` → terminal `conflict` with `note =
 *     "conflict at <sha>: <paths>"` per ADR-134 §Conflict surface
 *     §1. On `{ status: 'no-op' }` (no commits ahead) → terminal
 *     `merged` with `note = "no-op (already merged)"`. On `{
 *     status: 'merged', sha }` → advance to `tested` with `note =
 *     "merge sha <sha>"`. The `tested → merged | test_failed`
 *     decision is the post-merge test-gate which lives in the
 *     caller (ADR-134 T3+T4); this wrapper stops at `tested` so
 *     the caller can wire the test runner separately.
 *
 *   - **`rebasing` / `merging` / `tested` / `test_failed`** — these
 *     are mid-flight states that ONLY the caller's outer
 *     test/rebase wiring transitions out of. This wrapper returns
 *     `changed: false` with a "waiting on caller" reason so the
 *     dispatcher knows it's not idle. Forward progress here lands
 *     in T3+T4 sub-Tasks.
 *
 *   - **Terminal (`merged` / `conflict` / `reverted`)** — no-op
 *     return; caller / operator drives manual reset back to
 *     `in_progress` per ADR-134 §state-machine.
 *
 * Concurrency: every state-mutation routes through
 * `repo.transition()` which wraps `BEGIN IMMEDIATE`. Two ticks
 * racing the same row both reach the writer lock; the second
 * one's `fromState` guard catches the post-transition state and
 * returns `{ applied: false }`, which this function maps to
 * `changed: false` (no double-apply). */
export async function performMerge(
  ctx: IntraTeamMergeContext,
): Promise<PerformMergeResult> {
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const t = now();

  // Read current row. Missing → seed an `open` row (the dispatcher's
  // typical "first event for this branch" path) and re-load.
  let row = ctx.repo.load(ctx.team, ctx.branchKey);
  if (row === null) {
    ctx.repo.upsertOpen({ team: ctx.team, branchKey: ctx.branchKey, now: t });
    row = ctx.repo.load(ctx.team, ctx.branchKey);
    if (row === null) {
      // Defensive — the upsert above MUST have produced a row;
      // failure here means another writer concurrently deleted it
      // (impossible in practice; the repo has no delete method).
      return {
        state: "open",
        changed: false,
        reason: "row vanished after upsertOpen — concurrent writer deleted",
      };
    }
  }

  // Terminal? No-op return. Operator-driven manual reset is the only
  // way out of these; this wrapper stays read-only on terminals.
  if (isTerminalState(row.state)) {
    return {
      state: row.state,
      changed: false,
      reason: `terminal state '${row.state}' — operator must reset to in_progress to retry`,
    };
  }

  // open → in_progress.
  if (row.state === "open") {
    const r = ctx.repo.transition({
      team: ctx.team,
      branchKey: ctx.branchKey,
      fromState: "open",
      toState: "in_progress",
      note: "owner started work — fan-in pending",
      now: t,
    });
    return {
      state: r.applied ? "in_progress" : (r.observedFrom ?? "open"),
      changed: r.applied,
      reason: r.applied
        ? "owner started work — fan-in pending"
        : `concurrency lost: row was '${r.observedFrom}', expected 'open'`,
    };
  }

  // in_progress → gate-driven decision.
  if (row.state === "in_progress") {
    const decision = shouldTransitionFromInProgress(ctx.gate);
    if (decision.next === "in_progress") {
      // Gate held; refresh `note` with the current reason so the
      // operator can inspect why we're not progressing. Idempotent
      // self-transition.
      const r = ctx.repo.transition({
        team: ctx.team,
        branchKey: ctx.branchKey,
        fromState: "in_progress",
        toState: "in_progress",
        note: decision.reason,
        now: t,
      });
      return {
        state: "in_progress",
        changed: r.applied,
        reason: decision.reason,
      };
    }
    const r = ctx.repo.transition({
      team: ctx.team,
      branchKey: ctx.branchKey,
      fromState: "in_progress",
      toState: decision.next,
      note: decision.reason,
      now: t,
    });
    return {
      state: r.applied ? decision.next : (r.observedFrom ?? "in_progress"),
      changed: r.applied,
      reason: r.applied
        ? decision.reason
        : `concurrency lost: row was '${r.observedFrom}', expected 'in_progress'`,
    };
  }

  // ready_to_merge → run the actual merge.
  if (row.state === "ready_to_merge") {
    // Optimistic transition to `merging` first (durable signal per
    // ADR-134 §Conflict surface §1 — write the in-flight state
    // BEFORE the side effect, so a crash mid-merge leaves an
    // operator-visible row). On concurrency loss, abort the tick.
    const enter = ctx.repo.transition({
      team: ctx.team,
      branchKey: ctx.branchKey,
      fromState: "ready_to_merge",
      toState: "merging",
      note: "running git merge",
      now: t,
    });
    if (!enter.applied) {
      return {
        state: enter.observedFrom ?? "ready_to_merge",
        changed: false,
        reason: `concurrency lost entering merging: row was '${enter.observedFrom}'`,
      };
    }

    const opts: { git?: GitSpawn; fetch?: boolean } = {};
    if (ctx.git !== undefined) opts.git = ctx.git;
    if (ctx.fetch !== undefined) opts.fetch = ctx.fetch;
    else opts.git = ctx.git ?? defaultGitSpawn;

    try {
      const mr = await mergeMember(ctx.base, ctx.branchKey, ctx.repoPath, opts);
      // Re-stamp `now` AFTER the merge so the `updated_at` column
      // reflects when the side effect completed (helps operators
      // attribute long-running merges).
      const t2 = now();
      if (mr.status === "no-op") {
        const reason = "no-op (branch had no commits ahead of base)";
        const r = ctx.repo.transition({
          team: ctx.team,
          branchKey: ctx.branchKey,
          fromState: "merging",
          toState: "merged",
          note: reason,
          now: t2,
        });
        return {
          state: r.applied ? "merged" : (r.observedFrom ?? "merging"),
          changed: r.applied,
          reason,
        };
      }
      // status === "merged" — advance to `tested`; the post-merge
      // test gate (ADR-134 T3+T4) drives the `tested → merged |
      // test_failed` decision. Caller stops here; this wrapper
      // does NOT auto-mark `merged`.
      const reason = `merge sha ${mr.sha}`;
      const r = ctx.repo.transition({
        team: ctx.team,
        branchKey: ctx.branchKey,
        fromState: "merging",
        toState: "tested",
        note: reason,
        now: t2,
      });
      const result: PerformMergeResult = {
        state: r.applied ? "tested" : (r.observedFrom ?? "merging"),
        changed: r.applied,
        reason,
      };
      if (r.applied) result.mergedSha = mr.sha;
      return result;
    } catch (e) {
      if (e instanceof MergeConflictError) {
        const paths = e.conflictPaths.slice(0, 5).join(", ");
        const reason = `conflict on ${e.wtBranch}: ${paths}`;
        const t2 = now();
        ctx.repo.transition({
          team: ctx.team,
          branchKey: ctx.branchKey,
          fromState: "merging",
          toState: "conflict",
          note: reason,
          now: t2,
        });
        return { state: "conflict", changed: true, reason };
      }
      // Non-conflict throw (git missing, repoPath gone, etc.) —
      // leave the row in `merging` for operator inspection.
      // Surfacing as the original error preserves the stack.
      throw e;
    }
  }

  // rebasing / merging / tested / test_failed — caller-driven
  // states. Wrapper returns no-op so the dispatcher can defer to
  // T3+T4 wiring.
  return {
    state: row.state,
    changed: false,
    reason: `state '${row.state}' is caller-driven — waiting on outer wiring (T3+T4)`,
  };
}
