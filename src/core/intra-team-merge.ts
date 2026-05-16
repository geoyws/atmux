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
// shape. The repo's `transition()` runs every state.db write under
// BEGIN IMMEDIATE so concurrent fires serialize at the write step.
//
// Concurrency model (per ADR-134 §state-machine + trunk's
// `merger-state-repo.ts` docstring): the repo's `transition()` is a
// pure UPSERT — no fromState guard at the row level; serialization
// is what BEGIN IMMEDIATE buys us. The caller re-reads state via
// `getState()` immediately before each write to keep two ticks from
// jointly stomping a row (best-effort TOCTOU guard — the WRITE path
// is still serialized atomically, the READ path is racy). On a state
// mismatch between the re-read and the expected `fromState`, this
// wrapper returns `changed: false` with `reason` explaining the
// concurrency loss so the dispatcher can move on.
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
  /** Per-member branch (e.g. `geoyws-whip-impl`). Primary key into
   *  the `merger_state` table per ADR-134 §state-machine — one row
   *  per `<base>-<member>` branch tracked by the team's gitter. */
  memberBranch: string;
  /** Base branch (e.g. `geoyws`). The fan-in destination; mergeMember
   *  checks out this branch before running `git merge --no-ff
   *  <memberBranch>`. */
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
  /** Caller identity for `merger_state.transitioned_by`. Defaults
   *  to `"event"` — the event-driven dispatcher's typical attribution.
   *  Cron backstop passes `"cron"`; operator-driven verb passes
   *  `"operator"`. */
  by?: string;
  /** Clock — unix epoch seconds. Defaults to `Math.floor(Date.now()
   *  / 1000)`. Tests pin to a fixed value for reproducible
   *  `transitioned_at` columns. */
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
 *  no-op short-circuits (concurrency loss OR terminal short-circuit). */
export interface PerformMergeResult {
  /** Post-tick state. Equal to entry state on a no-op tick. */
  state: BranchMergeState;
  /** True iff the state CHANGED during this tick. False on
   *  intentional no-ops (gate held with note unchanged, terminal
   *  short-circuit, caller-driven holding-state observed) AND on
   *  concurrency-loss no-ops (the re-read state didn't match the
   *  expected fromState). */
  changed: boolean;
  /** Operator-facing reason — set on every successful transition
   *  (`shouldTransitionFromInProgress.reason` when applicable,
   *  hand-rolled strings on terminal/conflict/test-gate paths).
   *  Mirrored into `merger_state.note` for `atmux status` /
   *  Discord surfacing. */
  reason: string;
  /** Set when this tick's transition reached `tested` and `merge-
   *  member` reported a fresh fan-in SHA. `undefined` on
   *  idempotent re-fires (mergeMember returned `{ status:
   *  'no-op' }` because no commits were ahead). */
  mergedSha?: string;
}

/** Re-read state then write a transition. Returns the resolved
 *  current state + whether the write actually applied. On TOCTOU
 *  mismatch (the re-read state differs from `fromState`), skips the
 *  write and reports the observed state via `observedFrom`. The
 *  serialized write path (repo.transition wraps BEGIN IMMEDIATE)
 *  still guarantees no torn writes; this guard is the best-effort
 *  layer that keeps two ticks from BOTH advancing the same row past
 *  the same checkpoint when they read concurrently. */
function guardedTransition(
  repo: MergerStateRepo,
  args: {
    memberBranch: string;
    fromState: BranchMergeState;
    toState: BranchMergeState;
    note: string | null;
    by: string;
    now: number;
    baseSha?: string | null;
    conflictSha?: string | null;
  },
): { applied: boolean; observedFrom: BranchMergeState } {
  const current = repo.getState(args.memberBranch);
  // Null-row is the implicit `open` initial state per ADR-134.
  const observed: BranchMergeState = current?.state ?? "open";
  if (observed !== args.fromState) {
    return { applied: false, observedFrom: observed };
  }
  const tx: Parameters<MergerStateRepo["transition"]>[0] = {
    memberBranch: args.memberBranch,
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

/**
 * One state-machine tick for `memberBranch`. Reads the row,
 * picks the appropriate transition by current state + gate input,
 * applies it via the repo's BEGIN IMMEDIATE wrapper, returns the
 * post-tick observable.
 *
 * Tick semantics (one tick = one observable advance):
 *
 *   - **No row OR `open`** → seed `in_progress` (the first task-done
 *     event for a branch produces this tick; null-row is treated as
 *     implicit `open` per the repo's ADR-134 convention).
 *
 *   - **`in_progress`** → consult `shouldTransitionFromInProgress`:
 *     stays `in_progress` (gate held), advances to `ready_to_merge`
 *     (gate clear, base stable), or advances to `rebasing` (gate
 *     clear, base moved). The "stay" branch is NOT a no-op tick —
 *     we refresh `note` so operators inspecting the row see the
 *     latest gate-held reason.
 *
 *   - **`ready_to_merge`** → advance to `merging` and run
 *     `mergeMember(base, memberBranch, repoPath)`. On
 *     `MergeConflictError` → terminal `conflict` with `note =
 *     "conflict on <branch>: <paths>"` per ADR-134 §Conflict surface
 *     §1. On `{ status: 'no-op' }` (no commits ahead) → terminal
 *     `merged` with `note = "no-op (no commits ahead)"`. On `{
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
 * `repo.transition()` which wraps `BEGIN IMMEDIATE`. The
 * `guardedTransition` helper re-reads state before each write and
 * short-circuits on TOCTOU mismatch — best-effort guard that
 * complements the serialized write path.
 */
export async function performMerge(
  ctx: IntraTeamMergeContext,
): Promise<PerformMergeResult> {
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const by = ctx.by ?? "event";
  const t = now();

  // Read current row. Null-row is implicit `open` per ADR-134.
  const row = ctx.repo.getState(ctx.memberBranch);
  const currentState: BranchMergeState = row?.state ?? "open";

  // Terminal? No-op return. Operator-driven manual reset is the only
  // way out of these; this wrapper stays read-only on terminals.
  if (isTerminalState(currentState)) {
    return {
      state: currentState,
      changed: false,
      reason: `terminal state '${currentState}' — operator must reset to in_progress to retry`,
    };
  }

  // null OR open → in_progress.
  if (currentState === "open") {
    const r = guardedTransition(ctx.repo, {
      memberBranch: ctx.memberBranch,
      fromState: "open",
      toState: "in_progress",
      note: "owner started work — fan-in pending",
      by,
      now: t,
    });
    return {
      state: r.applied ? "in_progress" : r.observedFrom,
      changed: r.applied,
      reason: r.applied
        ? "owner started work — fan-in pending"
        : `concurrency lost: row was '${r.observedFrom}', expected 'open'`,
    };
  }

  // in_progress → gate-driven decision.
  if (currentState === "in_progress") {
    const decision = shouldTransitionFromInProgress(ctx.gate);
    const r = guardedTransition(ctx.repo, {
      memberBranch: ctx.memberBranch,
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
    };
  }

  // ready_to_merge → run the actual merge.
  if (currentState === "ready_to_merge") {
    // Optimistic transition to `merging` first (durable signal per
    // ADR-134 §Conflict surface §1 — write the in-flight state
    // BEFORE the side effect, so a crash mid-merge leaves an
    // operator-visible row). On concurrency loss, abort the tick.
    const enter = guardedTransition(ctx.repo, {
      memberBranch: ctx.memberBranch,
      fromState: "ready_to_merge",
      toState: "merging",
      note: "running git merge",
      by,
      now: t,
    });
    if (!enter.applied) {
      return {
        state: enter.observedFrom,
        changed: false,
        reason: `concurrency lost entering merging: row was '${enter.observedFrom}'`,
      };
    }

    const opts: { git?: GitSpawn; fetch?: boolean } = {};
    if (ctx.git !== undefined) opts.git = ctx.git;
    if (ctx.fetch !== undefined) opts.fetch = ctx.fetch;
    else opts.git = ctx.git ?? defaultGitSpawn;

    try {
      const mr = await mergeMember(
        ctx.base,
        ctx.memberBranch,
        ctx.repoPath,
        opts,
      );
      // Re-stamp `now` AFTER the merge so the `transitioned_at`
      // column reflects when the side effect completed (helps
      // operators attribute long-running merges).
      const t2 = now();
      if (mr.status === "no-op") {
        const reason = "no-op (no commits ahead of base)";
        const r = guardedTransition(ctx.repo, {
          memberBranch: ctx.memberBranch,
          fromState: "merging",
          toState: "merged",
          note: reason,
          by,
          now: t2,
        });
        return {
          state: r.applied ? "merged" : r.observedFrom,
          changed: r.applied,
          reason,
        };
      }
      // status === "merged" — advance to `tested`; the post-merge
      // test gate (ADR-134 T3+T4) drives the `tested → merged |
      // test_failed` decision. Caller stops here; this wrapper
      // does NOT auto-mark `merged`.
      const reason = `merge sha ${mr.sha}`;
      const r = guardedTransition(ctx.repo, {
        memberBranch: ctx.memberBranch,
        fromState: "merging",
        toState: "tested",
        note: reason,
        by,
        now: t2,
        baseSha: mr.sha,
      });
      const result: PerformMergeResult = {
        state: r.applied ? "tested" : r.observedFrom,
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
        // Force-write the conflict transition (terminal — the
        // dispatcher would otherwise see merging and treat it as a
        // caller-driven holding state). guardedTransition would
        // short-circuit on a sibling-writer race; the terminal
        // write is more important than the TOCTOU guard here.
        ctx.repo.transition({
          memberBranch: ctx.memberBranch,
          next: "conflict",
          note: reason,
          by,
          transitionedAt: t2,
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
    state: currentState,
    changed: false,
    reason: `state '${currentState}' is caller-driven — waiting on outer wiring (T3+T4)`,
  };
}
