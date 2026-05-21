// ADR-145 + ADR-134 + ADR-212: gitter merge handler (T4 of EPIC
// e-4acc3562).
//
// The real merge dispatcher behind the T2 stubbed-default. On every
// `task.done` event, the handler:
//
//   1. Resolves the `<base>-<member>` branch from the event payload —
//      `event.member` joined to `deps.baseBranch` is the canonical
//      shape; falls back to `git branch --contains <commitSha>` when
//      member is missing/ambiguous (e.g. cross-team event leak).
//   2. Roster-checks the resolved suffix against `deps.roster`
//      (team.json `members[].name`) — returns 'skipped-not-mine'
//      when the branch isn't ours.
//   3. Short-circuits 'skipped-not-mine' when `aheadCount === 0`
//      (`git rev-list --count <base>..<member>`) — nothing to merge.
//   4. Invokes `productionQueueMergeAttempt({memberBranch, aheadCount})`
//      from the ADR-134 dispatcher.
//   5. Reads the resulting `merger_state` row + maps it to a
//      {@link HandlerOutcome}:
//        - `merged` → 'merged'
//        - `conflict` | `test_failed` → 'escalated' (T5 emits the
//          gitter.escalated event off this signal)
//        - any walkable non-terminal state → 'gate-held' (idempotent
//          re-fire on the next event/cron tick)
//
// **Hard invariant** (ADR-212 §D2 + ADR-134 §state-machine): the
// handler NEVER calls `git rebase`, `git squash`, `git reset`, or
// `git checkout` autonomously. The dispatcher's `performMerge` is
// non-destructive on conflict (BEGIN IMMEDIATE writes the conflict
// row, leaves the worktree index intact for lead-driven recovery).
// Any of those four verbs in the spawn stream is a tested-against
// regression.

import type { GitSpawn } from "../abstractions/branch-merge.ts";
import type { emit } from "../abstractions/events.ts";
import type { TaskDonePayload } from "../schema/events.ts";
import type { HandlerOutcome, Logger } from "./gitter-consumer.ts";
import {
  productionQueueMergeAttempt,
  type ProductionDispatcherDeps,
} from "./intra-team-merge-dispatcher.ts";
import type { KanbanRepo } from "./repositories/kanban-repo.ts";
import type { MergerStateRepo } from "./repositories/merger-state-repo.ts";

/** Test-injection seam — production callers thread real impls. */
export interface GitterMergeHandlerDeps {
  /** Absolute path to the team git working tree. */
  teamRoot: string;
  /** Trunk branch the team fans into (`<product>-<lead>`). */
  baseBranch: string;
  /** `git` spawn shim. Tests inject a deterministic responder + assert
   *  the verbs touched (no rebase/squash/reset/checkout per ADR-134). */
  git: GitSpawn;
  /** Repo handle for `merger_state` reads — written by the dispatcher. */
  mergerRepo: MergerStateRepo;
  /** Kanban repo threaded into the dispatcher for owner-task gating. */
  kanbanRepo: KanbanRepo;
  /** Logger surface (info/warn/error) — adapted to the dispatcher's
   *  tui.Logger shape internally. */
  logger: Logger;
  /** Worktree resolver — required by the dispatcher for the rebasing
   *  detour per ADR-134 T3+T4. */
  resolveMemberWorktreePath: (memberBranch: string) => Promise<string | null>;
  /** Emit fn (test seam) — reserved for T5's gitter.escalated
   *  emission; not invoked from this Task. */
  emit: typeof emit;
  /** Absolute path to .atmux dir for the post-merge done-flip hook. */
  atmuxDir: string;
  /** Active roster — `team.json::members[].name`. */
  roster: ReadonlyArray<string>;
  /** Test-injection seam for the dispatcher factory. Defaults to
   *  `productionQueueMergeAttempt`. */
  dispatcherFactory?: (deps: ProductionDispatcherDeps) => (input: {
    memberBranch: string;
    aheadCount: number;
  }) => Promise<{ queued: boolean; reason?: string }>;
}

const NON_TERMINAL_WALKABLE_STATES: ReadonlySet<string> = new Set([
  "in_progress",
  "ready_to_merge",
  "rebasing",
  "merging",
  "tested",
]);

/**
 * Build the gitter merge handler bound to `deps`. The returned
 * function plugs into `gitterConsume({...deps, handler})` per the
 * T2 consumer contract.
 */
export function createGitterMergeHandler(
  deps: GitterMergeHandlerDeps,
): (event: TaskDonePayload) => Promise<HandlerOutcome> {
  const dispatcherFactory = deps.dispatcherFactory ?? productionQueueMergeAttempt;

  // Adapt the consumer-tier Logger (info/warn/error) to the dispatcher's
  // tui.Logger (log/ok/warn/err). Dispatcher only calls `.log()` in
  // production paths; ok/warn/err route to info so any added severity
  // shows up via the consumer-tier logger consistently.
  const toInfo = (msg: string) => deps.logger.info(msg);
  const dispatcherLogger = { log: toInfo, ok: toInfo, warn: toInfo, err: toInfo };

  const queueMerge = dispatcherFactory({
    teamRoot: deps.teamRoot,
    baseBranch: deps.baseBranch,
    git: deps.git,
    mergerRepo: deps.mergerRepo,
    kanbanRepo: deps.kanbanRepo,
    logger: dispatcherLogger,
    resolveMemberWorktreePath: deps.resolveMemberWorktreePath,
    atmuxDir: deps.atmuxDir,
  });

  return async (event) => {
    const memberBranch = await resolveMemberBranch(event, deps);
    if (memberBranch === null) {
      deps.logger.info(
        `gitter-merge-handler: cannot resolve memberBranch (event.member=${event.member}, commitSha=${event.commitSha ?? "n/a"}) — skipping`,
      );
      return "skipped-not-mine";
    }

    const aheadCount = await computeAheadCount(deps, memberBranch);
    if (aheadCount === 0) {
      deps.logger.info(
        `gitter-merge-handler: '${memberBranch}' ahead=0 — nothing to merge, skipping`,
      );
      return "skipped-not-mine";
    }

    await queueMerge({ memberBranch, aheadCount });

    const row = deps.mergerRepo.getState(memberBranch);
    const state = row?.state ?? "open";
    if (state === "merged") return "merged";
    if (state === "conflict" || state === "test_failed") return "escalated";
    if (NON_TERMINAL_WALKABLE_STATES.has(state)) return "gate-held";

    // Defensive fallback — unknown / unexpected terminal state (e.g.
    // 'reverted'). Treat as gate-held so the consumer re-fires on the
    // next tick rather than silently dropping the event.
    deps.logger.warn(
      `gitter-merge-handler: '${memberBranch}' unexpected post-dispatch state='${state}' — treating as gate-held`,
    );
    return "gate-held";
  };
}

// ---------- helpers ----------

async function resolveMemberBranch(
  event: TaskDonePayload,
  deps: GitterMergeHandlerDeps,
): Promise<string | null> {
  if (event.member && deps.roster.includes(event.member)) {
    return `${deps.baseBranch}-${event.member}`;
  }
  if (!event.commitSha) return null;
  // Fallback — git branch --contains gives every branch reachable from
  // the SHA. Take the first <base>-<member> hit where <member> is in
  // the roster.
  const r = await deps.git([
    "-C",
    deps.teamRoot,
    "branch",
    "--contains",
    event.commitSha,
  ]);
  if (r.exitCode !== 0) return null;
  const prefix = `${deps.baseBranch}-`;
  for (const raw of (r.stdout ?? "").split("\n")) {
    const name = raw.replace(/^\*?\s+/, "").trim();
    if (name.startsWith(prefix)) {
      const suffix = name.slice(prefix.length);
      if (deps.roster.includes(suffix)) return name;
    }
  }
  return null;
}

async function computeAheadCount(
  deps: GitterMergeHandlerDeps,
  memberBranch: string,
): Promise<number> {
  const r = await deps.git([
    "-C",
    deps.teamRoot,
    "rev-list",
    "--count",
    `${deps.baseBranch}..${memberBranch}`,
  ]);
  if (r.exitCode !== 0) return 0;
  const n = Number.parseInt((r.stdout ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
