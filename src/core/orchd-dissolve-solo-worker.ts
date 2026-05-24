// ADR-231 §D6 + ADR-221 §Phase 2 — orchd auto-dissolve subscriber for
// solo-worker teams.
//
// Listens for `task.done` events; when the event's owning team matches
// the solo-worker prefix convention (`w-*` per ADR-221 §v2 line 72,
// classified via `isSoloWorkerTeamName` in `src/core/solo-worker.ts`)
// AND all of that member's tasks are now in `done` status, dispatches
// `atmux team dissolve-worker <worker-team-name>` to tear down the
// cage. Closes ADR-221 §Phase 2 auto-dissolve.
//
// Distinct from parent's `src/core/orchd-dissolve.ts` (Phase 4
// ADR-227): different scope (per-task vs per-epic), different topic
// (`task.done` vs `epic.pushed`), different consumerId. Honker's
// per-consumer offsets isolate the two — both can subscribe to
// `task.done` without coordination (parent's auto-merge subscriber
// also lives on `task.done` with a third consumerId; per ADR-202
// §VIII the offsets are independent).
//
// **Verb-choice note (ADR-231 §D6 + ADR-221 §v2 reconciliation)**:
// ADR-231 §D6 step 4 names the dissolve verb as `atmux team stop
// --team <name>` — but that verb form doesn't exist in the codebase
// (only `atmux stop --team-dir <path>` and the canonical
// `atmux team dissolve-worker <id>` per ADR-221 §v2 line 68). This
// handler uses `dissolve-worker` per ADR-221 §v2 — the canonical
// dissolve verb that handles cockpit cleanup + kanban row update via
// the shared `dissolveEpic` core. ADR-231 §D6 amendment (filed same-
// commit as this handler) updates the §D6 step-4 wording to match.
//
// Failure recovery: dissolve subprocess failure → `atmux flag add
// --severity p1 --needs unblock` per ADR-231 §D6 step 5. NO retry —
// follows the same anti-retry-storm doctrine as `src/core/orchd-
// dispatch/epic-merge.ts` (failed dissolve gets operator triage, not
// a silent retry loop that hides root causes).
//
// Idempotency: re-delivery after a successful dissolve is a no-op.
// `atmux team dissolve-worker` on an already-dissolved worker is
// clean per ADR-090 §dissolve-epic — the cockpit row is already gone,
// the worktree is gone, the kanban Epic row is already in `merged →
// dissolved` terminal state, so subsequent invocations refuse with a
// recognized "epic not found" error that the handler maps to a
// silent-no-op outcome.

import type { Database } from "bun:sqlite";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { withIdempotency } from "../abstractions/events.ts";
import { isHonkerEnabled } from "../abstractions/honker.ts";
import type { TaskDonePayload } from "../schema/events.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";
import { isSoloWorkerTeamName } from "./solo-worker.ts";

/**
 * Outcome of one dissolveSoloWorkerHandler invocation. Drives the
 * processed / escalated totals returned by
 * {@link orchdDissolveSoloWorkerConsume} for the cron `--drain`
 * summary line.
 */
export type DissolveSoloWorkerOutcome =
  | "dissolved"
  | "escalated"
  | "skipped-task-missing"
  | "skipped-not-solo-worker"
  | "skipped-pending-work"
  | "skipped-honker-off";

/** Minimal logger surface — mirrors `gitter-consumer.ts::Logger`. */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const noopLog: Logger["info"] = () => {};
const NOOP_LOGGER: Logger = { info: noopLog, warn: noopLog, error: noopLog };

// ---------- Handler factory ----------

/** Test-injection seam for {@link createDissolveSoloWorkerHandler}. */
export interface DissolveSoloWorkerHandlerDeps {
  /** Open Database (per-team `state.db`). The handler queries
   *  `tasks` to (a) confirm the just-done task row still exists and
   *  (b) enumerate the member's remaining open tasks. */
  db: Database;
  /** Solo-worker classifier override (test seam). Defaults to
   *  {@link isSoloWorkerTeamName} from `solo-worker.ts`. */
  isSoloWorker?: (teamName: string) => boolean;
  /** Spawn fn used for both `atmux team dissolve-worker` and the
   *  failure-path `atmux flag add`. Defaults to the buffered
   *  {@link defaultSpawn} from `src/abstractions/spawn.ts`. */
  spawn?: typeof defaultSpawn;
  /** Logger (info/warn/error). Falls back to a no-op shim. */
  logger?: Logger;
}

/**
 * Build the dissolveSoloWorkerHandler bound to `deps`. Mirrors the
 * shape of `createAutoMergeHandler` (ADR-226) + `createAutoDissolveHandler`
 * (ADR-227) so operators learn one factory shape.
 *
 * Per `task.done` event (algorithm per ADR-231 §D6):
 *
 *   1. Load task by id via {@link KanbanRepo.getTask}; row-missing
 *      (race-deleted) → return `"skipped-task-missing"`.
 *   2. Classify the owning team via {@link isSoloWorker}; non-worker
 *      → return `"skipped-not-solo-worker"`.
 *   3. Enumerate the owning member's remaining tasks via
 *      {@link KanbanRepo.listTasks}; any non-`done` row → return
 *      `"skipped-pending-work"`.
 *   4. Spawn `atmux team dissolve-worker <event.team>` (per ADR-221
 *      §v2; not `atmux team stop` per §D6 step-4 amendment co-filed).
 *      Exit-0 → return `"dissolved"`. Non-zero → flag + return
 *      `"escalated"`.
 *
 * Failure → `atmux flag add --severity p1 --needs unblock` with the
 * worker-team name + stderr tail in the flag body. NO retry per
 * ADR-231 anti-retry-storm doctrine.
 *
 * Throws are caught by {@link withIdempotency} in
 * {@link orchdDissolveSoloWorkerConsume} — offset is NOT advanced;
 * next sweep re-attempts.
 */
export function createDissolveSoloWorkerHandler(
  deps: DissolveSoloWorkerHandlerDeps,
): (event: TaskDonePayload) => Promise<DissolveSoloWorkerOutcome> {
  const isSolo = deps.isSoloWorker ?? isSoloWorkerTeamName;
  const spawnFn = deps.spawn ?? defaultSpawn;
  const logger = deps.logger ?? NOOP_LOGGER;

  return async (event) => {
    // Step 1 — load task row (defensive existence check per ADR-231 §D6 step 1).
    const repo = new KanbanRepo(deps.db);
    const task = repo.getTask(event.taskId);
    if (task === null) {
      logger.info(
        `orchd-dissolve-solo-worker: task.done taskId=${event.taskId} — row missing (race-deleted); skip`,
      );
      return "skipped-task-missing";
    }

    // Step 2 — classify owning team.
    if (!isSolo(event.team)) {
      // Most events fall through this gate (regular epic-teams and
      // long-lived teams aren't solo-workers). Log at debug-tier
      // verbosity, not warn.
      logger.info(
        `orchd-dissolve-solo-worker: team='${event.team}' not a solo-worker (prefix mismatch); skip`,
      );
      return "skipped-not-solo-worker";
    }

    // Step 3 — pending-work check. Use the event's `member` field as
    // the owner key; for solo-workers this is typically a single-
    // member roster so the result set is small. The query reads
    // ALL tasks owned by this member in the local state.db — solo-
    // worker cages have their own state.db scoped to the worker, so
    // this naturally restricts the query to that worker's tasks.
    const pending = repo.listTasks({ owner: event.member }).filter((t) => t.status !== "done");
    if (pending.length > 0) {
      logger.info(
        `orchd-dissolve-solo-worker: worker-team='${event.team}' member='${event.member}' has ${pending.length} pending task(s); skip dissolve`,
      );
      return "skipped-pending-work";
    }

    // Step 4 — invoke dissolve-worker subprocess. Per ADR-221 §v2
    // line 68 (NOT `atmux team stop` per ADR-231 §D6 amendment).
    let dissolveResult: SpawnResult;
    try {
      dissolveResult = await spawnFn({
        cmd: "atmux",
        argv: ["team", "dissolve-worker", event.team],
        expectExitCode: "any",
        timeoutMs: 60_000,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        `orchd-dissolve-solo-worker: dissolve spawn threw for worker-team='${event.team}': ${msg}`,
      );
      await raiseFailureFlag(spawnFn, event.team, `spawn threw: ${msg}`, logger);
      return "escalated";
    }

    if (dissolveResult.exitCode === 0) {
      logger.info(
        `orchd-dissolve-solo-worker: dissolved worker-team='${event.team}' (member='${event.member}')`,
      );
      return "dissolved";
    }

    // Non-zero exit — raise the flag with stderr tail in body.
    const stderrTail = tail500(dissolveResult.stderr || dissolveResult.stdout);
    logger.warn(
      `orchd-dissolve-solo-worker: dissolve failed for worker-team='${event.team}' exit=${dissolveResult.exitCode}; raising flag`,
    );
    await raiseFailureFlag(spawnFn, event.team, stderrTail, logger);
    return "escalated";
  };
}

// ---------- Failure flag helper ----------

/** Best-effort `atmux flag add --severity p1 --needs unblock`. Swallows
 *  spawn errors — flag-add must never bubble out of the handler (the
 *  outcome itself is already `"escalated"`, the consumer will record
 *  that, and a failed flag-add doesn't make the underlying dissolve
 *  any more recoverable). */
async function raiseFailureFlag(
  spawnFn: typeof defaultSpawn,
  workerTeam: string,
  stderrTail: string,
  logger: Logger,
): Promise<void> {
  const body =
    `orchd: dissolve failed for worker-team ${workerTeam}\n` +
    `stderr tail:\n${stderrTail}`;
  try {
    await spawnFn({
      cmd: "atmux",
      argv: ["flag", "add", body, "--severity", "p1", "--needs", "unblock"],
      expectExitCode: "any",
      timeoutMs: 10_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`orchd-dissolve-solo-worker: flag-add spawn failed (swallowed): ${msg}`);
  }
}

function tail500(s: string): string {
  if (s.length <= 500) return s;
  return s.slice(-500);
}

// ---------- Consumer surface (mirrors orchd-merge.ts / orchd-dissolve.ts) ----------

export interface OrchdDissolveSoloWorkerConsumeDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Consumer name for offset tracking. Defaults to `'atmux:orchd:dissolve-solo-worker'`. */
  consumerName?: string;
  /** Topics to subscribe to. Defaults to `['task.done']`. */
  topics?: ReadonlyArray<string>;
  /** Real handler; default no-op returns 'skipped-not-solo-worker'. */
  handler?: (event: TaskDonePayload) => Promise<DissolveSoloWorkerOutcome>;
  /** Clock injection — propagated to `withIdempotency` for offset writes. */
  nowSec?: () => number;
  /** Optional logger; falls back to a no-op when absent. */
  logger?: Logger;
  /** Env injection for `isHonkerEnabled`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const defaultHandler = async (_event: TaskDonePayload): Promise<DissolveSoloWorkerOutcome> => {
  return "skipped-not-solo-worker";
};

/**
 * Drain pending `task.done` events for the solo-worker dissolve
 * consumer, invoking `deps.handler` per event under at-least-once
 * idempotency. Returns totals for the cron `--drain` summary line.
 *
 * Honker kill-switch (`ATMUX_HONKER=off`) short-circuits — drain
 * returns zero totals so the cron-only path stays untouched until the
 * substrate flips on.
 *
 * Failure mode: a thrown handler is caught inside `withIdempotency`
 * and stops the drain at the failing event. The offset is NOT
 * advanced past it — the next sweep re-attempts. This function itself
 * NEVER throws on handler failure.
 */
export async function orchdDissolveSoloWorkerConsume(
  deps: OrchdDissolveSoloWorkerConsumeDeps,
): Promise<{ processed: number; escalated: number }> {
  const consumerName = deps.consumerName ?? "atmux:orchd:dissolve-solo-worker";
  const topics = deps.topics ?? (["task.done"] as const);
  const handler = deps.handler ?? defaultHandler;
  const logger = deps.logger ?? NOOP_LOGGER;

  if (!isHonkerEnabled(deps.env)) {
    logger.info("orchd-dissolve-solo-worker: ATMUX_HONKER=off — fallback to cron-only path");
    return { processed: 0, escalated: 0 };
  }

  let processed = 0;
  let escalated = 0;

  await withIdempotency(
    deps.db,
    consumerName,
    deps.nowSec ? { topics, nowSec: deps.nowSec } : { topics },
    async (event) => {
      const outcome = await handler(event as TaskDonePayload);
      processed += 1;
      if (outcome === "escalated") escalated += 1;
    },
  );

  return { processed, escalated };
}
