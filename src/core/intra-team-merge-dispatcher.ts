// ADR-134 T9 (t-6987392a): cron-driven real merge dispatcher.
//
// The production factory for {@link QueueMergeFn} — drives the per-
// branch state machine forward when the cron backstop sweep
// (`src/core/gitter-sweep.ts`, T4) finds an eligible branch.
// Replaces the {@link recordingQueueMergeAttempt} stub that shipped
// with T4.
//
// Synchronous within one cron tick: the dispatcher loops
// {@link performMerge} ticks against the same context until the
// branch reaches a stop-point (terminal state, caller-driven wait
// state, concurrency-loss no-op, or safety-cap). No async event bus;
// the cron cadence (`team.autoMerge.cronBackstopMin`, default 10 min)
// is the latency floor.
//
// Walk per ADR-134 §state-machine on a clean-gate happy path:
//
//   open  → in_progress  → ready_to_merge  → merging  → tested
//
// The `tested → merged | test_failed` test gate is deliberately NOT
// driven here — that decision lives in ADR-144 (epic-team test-gate,
// t-db08e5bb) + ADR-134 follow-up work. The dispatcher stops at
// `tested`; the operator (or future Task) advances. Base IS advanced
// by the time we reach `tested` (the `git merge --no-ff` ran inside
// `performMerge.ready_to_merge → merging`), so the operator-visible
// acceptance criterion ("merges complete + base branch advanced")
// is satisfied at `tested` regardless of the test-gate wiring.
//
// Conflict surface (`merging → conflict`): durable signal is the
// `merger_state.note` row that `performMerge` already writes inside
// the BEGIN IMMEDIATE transaction. The fire-and-forget operator
// notification (flag + Discord ping) is **T5** (t-e9363607) — when
// T5 lands, the dispatcher invokes the surface helper after the
// conflict transition. Until then, the conflict-row IS the operator
// surface (`atmux status` reads `merger_state` per ADR-134).
//
// T3 cross-ref (t-27b06cda): the event-driven path the dispatcher's
// signature is shaped to accept verbatim. When the pubsub primitive
// (EPIC t-4f57c9e4) lands, T3's event handler will call
// {@link productionQueueMergeAttempt} with the same input shape —
// the dispatcher itself is pubsub-agnostic. No duplicate state-
// machine logic.

import type { GitSpawn } from "../abstractions/branch-merge.ts";
import {
  type BranchMergeState,
  isTerminalState,
} from "./branch-merge-state.ts";
import {
  type IntraTeamMergeContext,
  performMerge,
} from "./intra-team-merge.ts";
import type { QueueMergeFn } from "./gitter-sweep.ts";
import type { KanbanRepo } from "./repositories/kanban-repo.ts";
import type { MergerStateRepo } from "./repositories/merger-state-repo.ts";
import type { Logger } from "./tui.ts";

// ---------- Types ----------

/** Construct-time deps for {@link productionQueueMergeAttempt}. All
 *  side-effecting fields are injectable so the unit tests can drive
 *  the dispatcher through every cell of the 5-cell matrix without
 *  touching git or SQLite. */
export interface ProductionDispatcherDeps {
  /** Absolute path to the team's git working tree. Same shape as
   *  {@link GitterSweepDeps.teamRoot}; threaded into `performMerge`
   *  via `IntraTeamMergeContext.repoPath`. */
  teamRoot: string;
  /** Base branch the dispatcher fans branches into. Same shape as
   *  {@link GitterSweepDeps.baseBranch}; threaded into
   *  `performMerge` via `IntraTeamMergeContext.base`. */
  baseBranch: string;
  /** Repo handle for `merger_state` reads + transitions. The
   *  underlying repo wraps every write in BEGIN IMMEDIATE per
   *  ADR-134 §state-machine race-protection. */
  mergerRepo: MergerStateRepo;
  /** Kanban repo for resolving the branch owner's open-task count
   *  (input to the pre-merge gate). Owner is derived from the
   *  `<base>-<member>` branch convention. */
  kanbanRepo: KanbanRepo;
  /** `git` spawn shim. Defaulted at the verb layer to
   *  `defaultGitSpawn`; tests inject deterministic responders. */
  git: GitSpawn;
  /** Logger sink. Each tick emits one structured line so the cron
   *  log shows the operator the per-branch walk. */
  logger: Logger;
  /** Clock injection — defaults to `Math.floor(Date.now() / 1000)`.
   *  Threaded into `performMerge` so `merger_state.transitioned_at`
   *  is test-stable. */
  now?: () => number;
  /** When `false`, skip the `git fetch origin <base>` step inside
   *  `performMerge.ready_to_merge → merging`. Defaults to `true` in
   *  production (the fetch is the up-to-date guarantee); tests pin
   *  `false` for local-only fixtures. */
  fetch?: boolean;
  /** Safety cap on the per-invocation walk. Defaults to 10 — enough
   *  to cover the longest happy-path walk (open → in_progress →
   *  ready_to_merge → merging → tested = 4 transitions, plus a
   *  rebasing detour = +2, total 6) with headroom. Tests pin this
   *  to validate the cap fires when the machine doesn't progress. */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 10;

/** States where the walk should pause and return — the caller's outer
 *  wiring (test-gate, operator reset, T5 conflict surface) drives
 *  the next transition. Distinct from {@link isTerminalState} because
 *  these states are mid-flight; the row is non-terminal but the
 *  dispatcher can't make forward progress without external input. */
const CALLER_DRIVEN_STATES: ReadonlySet<BranchMergeState> = new Set<BranchMergeState>([
  "tested",
  "test_failed",
]);

// ---------- Owner derivation ----------

/** Derive the member-name from the `<base>-<member>` branch convention
 *  (per ADR-082 + ADR-088 + ADR-134). The base IS the prefix; the
 *  remainder is the member.
 *
 *  Returns `null` when the branch doesn't match the convention
 *  (operator-renamed branch, base mismatch, missing separator). The
 *  caller treats null as "can't gate on owner-tasks" and conservatively
 *  refuses the queue — better than silently merging a branch we can't
 *  attribute. */
export function deriveMember(memberBranch: string, base: string): string | null {
  const prefix = `${base}-`;
  if (!memberBranch.startsWith(prefix)) return null;
  const member = memberBranch.slice(prefix.length);
  return member.length > 0 ? member : null;
}

// ---------- Pre-merge gate input resolver ----------

/** Resolve the four-fact pre-merge gate input from kanban + git
 *  probes. Pure-of-injected-IO — calls the `git` spawn + `kanbanRepo`
 *  passed in, no module-level globals.
 *
 *  - **ownerOpenTaskCount** — kanban rows where `owner=<member>` AND
 *    `status` in {`todo`, `in-progress`}. Zero = gate clears.
 *  - **worktreeIsClean** — `git status --porcelain` empty against
 *    `teamRoot`. The base worktree's cleanliness gates the
 *    destructive `git checkout <base>` inside `mergeMember`.
 *  - **isAheadOfBase** — `aheadCount > 0`. The sweep already
 *    computed this from `rev-list --count`; pass through verbatim.
 *  - **baseHasMoved** — `git merge-base --is-ancestor <merge-base>
 *    origin/<base>` where `<merge-base>` is the branch's divergence
 *    point. If the merge-base is NOT an ancestor of `origin/<base>`,
 *    base has advanced past the divergence — rebase needed. The
 *    `origin/<base>` ref reflects the latest fetch; in the test
 *    `fetch:false` path, `<base>` is used instead. */
export async function resolvePreMergeGate(
  memberBranch: string,
  aheadCount: number,
  deps: Pick<ProductionDispatcherDeps, "teamRoot" | "baseBranch" | "kanbanRepo" | "git" | "fetch">,
): Promise<{
  ownerOpenTaskCount: number;
  worktreeIsClean: boolean;
  isAheadOfBase: boolean;
  baseHasMoved: boolean;
}> {
  const member = deriveMember(memberBranch, deps.baseBranch);

  // Owner open-task count. Null member = no owner attribution; count
  // = +∞ to keep the gate held until the operator renames or
  // intervenes. (We pick a finite sentinel — Number.MAX_SAFE_INTEGER
  // is overkill; the gate only checks `> 0`, so any positive value
  // suffices.)
  let ownerOpenTaskCount = 0;
  if (member === null) {
    ownerOpenTaskCount = 1;
  } else {
    const todoTasks = deps.kanbanRepo.listTasks({ owner: member, status: "todo" });
    const inProgressTasks = deps.kanbanRepo.listTasks({ owner: member, status: "in-progress" });
    ownerOpenTaskCount = todoTasks.length + inProgressTasks.length;
  }

  // Worktree cleanliness against teamRoot. Empty porcelain = clean.
  const sr = await deps.git(["-C", deps.teamRoot, "status", "--porcelain"]);
  const worktreeIsClean = sr.exitCode === 0 && sr.stdout.trim().length === 0;

  // baseHasMoved: did `<base>` (or `origin/<base>` when fetched)
  // advance past the branch's merge-base? `git merge-base --is-
  // ancestor <merge-base> <baseRef>` returns exit-0 when ancestor;
  // exit-1 when not. We invert: not-ancestor → base advanced.
  const baseRef = deps.fetch !== false ? `origin/${deps.baseBranch}` : deps.baseBranch;
  const mb = await deps.git(["-C", deps.teamRoot, "merge-base", baseRef, memberBranch]);
  let baseHasMoved = false;
  if (mb.exitCode === 0) {
    const mergeBase = mb.stdout.trim();
    if (mergeBase.length > 0) {
      const anc = await deps.git([
        "-C",
        deps.teamRoot,
        "merge-base",
        "--is-ancestor",
        mergeBase,
        baseRef,
      ]);
      // `--is-ancestor`: exit-0 = is ancestor, exit-1 = not. Anything
      // else (128 etc.) means git itself failed; treat as "unknown,
      // assume not moved" — conservative, avoids spurious rebases.
      if (anc.exitCode === 0) {
        // mergeBase IS an ancestor of baseRef. If they're equal,
        // base has NOT moved (mergeBase points at baseRef tip);
        // otherwise base advanced past mergeBase = moved.
        const rp = await deps.git(["-C", deps.teamRoot, "rev-parse", baseRef]);
        if (rp.exitCode === 0) {
          baseHasMoved = rp.stdout.trim() !== mergeBase;
        }
      }
    }
  }

  return {
    ownerOpenTaskCount,
    worktreeIsClean,
    isAheadOfBase: aheadCount > 0,
    baseHasMoved,
  };
}

// ---------- The dispatcher ----------

/**
 * Build a {@link QueueMergeFn} closure that drives the per-branch
 * state machine to a stop-point on each invocation. Synchronous
 * within the cron tick — the sweep call returns only after the
 * dispatcher walks the branch as far as it can.
 *
 * Return semantics:
 *
 *   - `{ queued: true, reason: "<final-state>: <last-reason>" }`
 *     when at least one transition fired this invocation. The walk
 *     reached a stop-point (terminal, caller-driven, or cap); the
 *     reason names the final state.
 *
 *   - `{ queued: false, reason: "in-flight: <state>" }` when the
 *     branch was ALREADY in a caller-driven or in-flight state at
 *     entry. The dispatcher made no transitions; the queue refused
 *     because someone else owns the next move.
 *
 *   - `{ queued: false, reason: "terminal: <state>" }` when the
 *     branch was ALREADY terminal (`merged` / `conflict` / `reverted`)
 *     at entry. The dispatcher made no transitions; the queue
 *     refused because the row is done.
 *
 *   - `{ queued: false, reason: "gate-held: <gate-reason>" }` when
 *     `in_progress` re-evaluated to itself (gate held — owner has
 *     open tasks / dirty worktree / etc.) AND no further transitions
 *     were possible. The walk fired the in_progress self-loop and
 *     stopped; useful for cron-log evidence.
 */
export function productionQueueMergeAttempt(
  deps: ProductionDispatcherDeps,
): QueueMergeFn {
  return async ({ memberBranch, aheadCount }) => {
    const cap = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    // Entry-state check — refuse fast on in-flight / terminal rows.
    const entryRow = deps.mergerRepo.getState(memberBranch);
    const entryState: BranchMergeState = entryRow?.state ?? "open";
    if (isTerminalState(entryState)) {
      deps.logger.log(
        `[dispatcher] ${memberBranch}: refuse-terminal state='${entryState}'`,
      );
      return { queued: false, reason: `terminal: ${entryState}` };
    }
    if (CALLER_DRIVEN_STATES.has(entryState)) {
      deps.logger.log(
        `[dispatcher] ${memberBranch}: refuse-caller-driven state='${entryState}'`,
      );
      return { queued: false, reason: `in-flight: ${entryState}` };
    }
    // `rebasing` / `merging` are also in-flight (another tick is
    // moving the row), but the sweep already filtered those at the
    // eligibility step. Defense-in-depth: re-refuse here so a direct
    // dispatcher invocation from T3 (post-pubsub) gets the same
    // protection.
    if (entryState === "rebasing" || entryState === "merging") {
      deps.logger.log(
        `[dispatcher] ${memberBranch}: refuse-in-flight state='${entryState}'`,
      );
      return { queued: false, reason: `in-flight: ${entryState}` };
    }

    // Resolve the pre-merge gate input ONCE per invocation. The
    // facts (open-task count, worktree cleanliness, ahead-of-base,
    // base-moved) are stable for the duration of one walk; cron
    // re-fires on the next tick to re-evaluate.
    const gate = await resolvePreMergeGate(memberBranch, aheadCount, deps);

    // Walk performMerge until a stop-point. Each iteration is one
    // state-machine tick; the loop bound is `cap` iterations to
    // guard against pathological loops (e.g. concurrency-loss
    // self-firing).
    let iteration = 0;
    let lastReason = "no progress";
    let lastState: BranchMergeState = entryState;
    let madeProgress = false;
    while (iteration < cap) {
      iteration += 1;
      const ctx: IntraTeamMergeContext = {
        memberBranch,
        base: deps.baseBranch,
        repoPath: deps.teamRoot,
        gate,
        repo: deps.mergerRepo,
        by: "cron",
        now,
        git: deps.git,
      };
      if (deps.fetch !== undefined) ctx.fetch = deps.fetch;
      const r = await performMerge(ctx);
      deps.logger.log(
        `[dispatcher] ${memberBranch}: tick=${iteration} state='${r.state}' changed=${r.changed} reason='${r.reason}'`,
      );
      lastState = r.state;
      lastReason = r.reason;
      if (r.changed) madeProgress = true;
      // Stop conditions: any of
      //   - terminal state (merged / conflict / reverted)
      //   - caller-driven state (tested / test_failed) — defer to
      //     ADR-144 test-gate wiring
      //   - changed=false self-loop on in_progress (gate held) —
      //     walk made no forward progress on this tick
      if (isTerminalState(r.state)) break;
      if (CALLER_DRIVEN_STATES.has(r.state)) break;
      if (!r.changed) break;
    }

    // Conflict surface — durable signal already written via
    // `performMerge`'s BEGIN IMMEDIATE transition to `conflict`.
    // Fire-and-forget operator notification (atmux flag + Discord
    // [merge-conflict] ping) is T5 (t-e9363607); when T5 lands, the
    // surface helper is invoked here.
    // TODO(t-e9363607): wire T5 conflict-surface invocation when it
    // ships. Until then, `atmux status` reading `merger_state.note`
    // IS the operator surface.

    if (madeProgress) {
      return { queued: true, reason: `${lastState}: ${lastReason}` };
    }
    // No progress + final state is `in_progress` = gate held.
    if (lastState === "in_progress") {
      return { queued: false, reason: `gate-held: ${lastReason}` };
    }
    return { queued: false, reason: `no-progress: ${lastReason}` };
  };
}
