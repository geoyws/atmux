// ADR-226 + ADR-202 + ADR-203: orchd auto-merge subscriber (Phase 3).
//
// Listens for `task.done` events; on the last open Task of an Epic,
// invokes the merge dispatcher (default-stubbed, sibling EPIC
// `e-60e16169` injects `performEpicMerge` from `src/core/epic-merge.ts`),
// then emits `epic.merged` or `epic.merge-blocked`. Cron backstop
// (`atmux epic-merge tick`) stays installed for two weeks per
// ADR-202 §X cron-decommission protocol.
//
// Module surface MIRRORS `src/core/gitter-consumer.ts` exactly per
// ADR-226 §DA2 — same withIdempotency wrapper, same kill-switch, same
// stubbed-default-with-injected-resolver pattern. Operators learn one
// shape, not two.
//
// **LOAD-BEARING per ADR-226 §DA5 + §OQ4** (be-1, t-05f368d6 verify
// 2026-05-23): `tasks.epic` column is universally NULL today (0/1044
// parent + 0/26 epic-team rows) because `atmux task add` lost `--epic`
// flag in 0.8.9 (memory `feedback_atmux_task_add_lost_epic_story_
// deliverable_flags`). All EPIC-bound tasks encode the epic via the
// `[e-XXXXXXXX]` subject prefix. Both `resolveEpicId` AND the epic-
// completeness query MUST handle the subject-prefix shape directly
// or this consumer ships as dead code (skipped-no-epic on every
// event) OR worse, spurious-merges every task.done because the
// completeness query returns COUNT(*)=0 for an epicId nothing rows
// match. The 3rd-stage parser + the LIKE-prefix branches are
// droppable once `task add --epic` is restored — follow-up Task scope
// for parent-atmux planner.

import type { Database } from "bun:sqlite";
import { emit as defaultEmit, withIdempotency } from "../abstractions/events.ts";
import { isHonkerEnabled } from "../abstractions/honker.ts";
import type { TaskDonePayload } from "../schema/events.ts";
import type { KanbanTask } from "../schema/kanban.ts";

/**
 * Result the injected dispatcher returns from one merge attempt.
 * Translated to {@link AutoMergeOutcome} + the corresponding
 * `epic.merged` / `epic.merge-blocked` event emit by
 * {@link createAutoMergeHandler}.
 *
 * Default-stub returns `{state: "skipped-not-mine"}` per ADR-226 §D5
 * — the sibling EPIC `e-60e16169` injects a real dispatcher that
 * constructs `EpicMergeContext` + calls `performEpicMerge` from
 * `src/core/epic-merge.ts`.
 */
export type DispatchEpicMergeResult =
  | { state: "merged"; parentBase: string; mergeSha: string }
  | { state: "merge-conflict"; reason: string }
  | { state: "gate-held"; reason: string }
  | { state: "already-merged" }
  | { state: "skipped-not-mine"; reason?: string };

/**
 * Outcome of a single orchd-merge handler invocation. Drives the
 * `{processed, escalated}` totals + the post-event emit (`epic.merged`
 * on `merged`, `epic.merge-blocked` on `escalated`).
 */
export type AutoMergeOutcome =
  | "merged"
  | "escalated"
  | "skipped-no-epic"
  | "skipped-epic-not-complete"
  | "skipped-already-merged"
  | "skipped-honker-off"
  | "skipped-not-mine";

/** Minimal logger surface — mirrors `gitter-consumer.ts::Logger`. */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const noopLog: Logger["info"] = () => {};
const NOOP_LOGGER: Logger = { info: noopLog, warn: noopLog, error: noopLog };

// ---------- resolveEpicId — three-stage per ADR-226 §DA5 + §OQ4 ----------

/**
 * Anchored, hex-bounded regex matching the `[e-XXXXXXXX...]` subject
 * prefix shape. ADR-058 fixes epic id charset to lowercase hex; the
 * trailing word boundary `\b` rejects the bracket-immediately form so
 * `[e-12345abc/s-1]` still matches but `[e-12345abcSOMETHING]` does
 * not partial-match. Anchored at `^` so prose containing `[e-...]`
 * substrings inside the subject body never false-positives.
 */
const SUBJECT_EPIC_PREFIX_RE = /^\[e-([0-9a-f]+)\b/;

/**
 * Resolve the epic id for a `task.done` event in three stages:
 *
 *   1. `event.epicId` — when the emitter populated it from the kanban
 *      `tasks.epic` column at emit-time (`src/core/kanban.ts:478-479`).
 *      This is the preferred path; it skips a DB query.
 *
 *   2. `tasks.epic` column for `event.taskId` — fallback when the
 *      emitter ran before the `epic` column was populated (e.g. an
 *      operator-edited row, or a race between insert + emit). Returns
 *      the stored value if present.
 *
 *   3. `[e-XXXXXXXX]` subject prefix on `tasks.subject` — final
 *      fallback, **LOAD-BEARING TODAY** because `tasks.epic` is
 *      universally NULL until `atmux task add --epic` is restored
 *      (per `feedback_atmux_task_add_lost_epic_story_deliverable_flags`
 *      memory). Returns `e-<hex>` reconstructed from the regex
 *      capture.
 *
 * Returns `null` when all three stages return null/empty. The handler
 * maps that to `skipped-no-epic`. Stage 3 is droppable once the
 * upstream regression is fixed; documented in the module header.
 */
export function resolveEpicId(event: TaskDonePayload, db: Database): string | null {
  if (typeof event.epicId === "string" && event.epicId.length > 0) {
    return event.epicId;
  }
  const row = db.prepare("SELECT epic, subject FROM tasks WHERE id = ?").get(event.taskId) as
    | { epic: string | null; subject: string | null }
    | null
    | undefined;
  if (row === undefined || row === null) return null;
  if (typeof row.epic === "string" && row.epic.length > 0) {
    return row.epic;
  }
  if (typeof row.subject === "string") {
    const m = SUBJECT_EPIC_PREFIX_RE.exec(row.subject);
    if (m !== null) return `e-${m[1]}`;
  }
  return null;
}

// ---------- isEpicComplete — subject-prefix-aware per ADR-226 §D1 step 3 ----------

/**
 * Returns `true` iff every Task bound to `epicId` is in `done` or
 * `wontfix` status. Implements ADR-226 §D1 step 3's §OQ4-aware variant:
 * the four-branch OR clause catches `epic = :eid` (future-proof) AND
 * the three canonical subject-prefix shapes today:
 *   - `[e-XXX]<EOF>`            → `LIKE '[' || :eid || ']%'`
 *   - `[e-XXX T1] ...`          → `LIKE '[' || :eid || ' %'`
 *   - `[e-XXX/s-YYY] ...`       → `LIKE '[' || :eid || '/%'`
 *
 * Without the LIKE branches the query returns 0 for every epicId today
 * (since `tasks.epic IS NULL` universally per §OQ4) → orchd would
 * spurious-merge every `task.done` instead of gating on epic completion.
 *
 * Exported so tests can exercise the query in isolation + so future
 * consumers (Phase 4/5) can re-use the helper rather than duplicating
 * the LIKE pattern.
 */
export function isEpicComplete(db: Database, epicId: string): boolean {
  // Positional binds — bun:sqlite's named-bind syntax requires the key
  // to include the `:` prefix verbatim, which is awkward for the four
  // repeated callsites here. Positional is also the convention used
  // throughout `src/core/kanban.ts` + repositories.
  const closeBracket = `[${epicId}]%`;
  const spaceSuffix = `[${epicId} %`;
  const slashSuffix = `[${epicId}/%`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS open_count FROM tasks
       WHERE (
         epic = ?
         OR subject LIKE ?
         OR subject LIKE ?
         OR subject LIKE ?
       )
       AND status NOT IN ('done', 'wontfix')`,
    )
    .get(epicId, closeBracket, spaceSuffix, slashSuffix) as { open_count: number } | undefined;
  return (row?.open_count ?? 0) === 0;
}

// ---------- Handler factory ----------

/** Default stub — sibling EPIC `e-60e16169` injects the real dispatcher. */
const DEFAULT_DISPATCH_STUB = async (_epicId: string): Promise<DispatchEpicMergeResult> => ({
  state: "skipped-not-mine",
});

/** Test-injection seam for {@link createAutoMergeHandler}. */
export interface AutoMergeHandlerDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Adapter-aware task snapshot. Production bootstrap supplies this so
   *  external mode never falls back to the legacy `tasks` table. */
  loadTasks?: () => ReadonlyArray<KanbanTask> | Promise<ReadonlyArray<KanbanTask>>;
  /** Real merge dispatcher. Default returns `skipped-not-mine`; sibling
   *  EPIC `e-60e16169` injects a closure that builds `EpicMergeContext`
   *  and calls `performEpicMerge` from `src/core/epic-merge.ts`. */
  dispatchEpicMerge?: (epicId: string) => Promise<DispatchEpicMergeResult>;
  /** Emit fn (test seam). Defaults to the production `emit` helper. */
  emit?: typeof defaultEmit;
  /** Logger (info/warn/error). Falls back to a no-op shim. */
  logger?: Logger;
  /** Clock — unix epoch seconds. Defaults to wall-clock. */
  nowSec?: () => number;
}

/**
 * Build the orchd-merge handler bound to `deps`. The returned function
 * plugs into `orchdMergeConsume({...consumerDeps, handler})` per the
 * consumer contract — same shape as `createGitterMergeHandler`.
 *
 * Per `task.done` event:
 *   1. {@link resolveEpicId} (3-stage) → `epicId` or null.
 *   2. null → `skipped-no-epic`.
 *   3. {@link isEpicComplete} → false → `skipped-epic-not-complete`.
 *   4. Invoke `dispatchEpicMerge(epicId)`.
 *   5. Map dispatch state → outcome + emit downstream event:
 *      - `merged` → emit `epic.merged` + return `"merged"`.
 *      - `merge-conflict` / `gate-held` → emit `epic.merge-blocked` +
 *        return `"escalated"`.
 *      - `already-merged` → return `"skipped-already-merged"` (no
 *        emit — merger_state.state='merged' is permanent-terminal per
 *        memory `project_merger_state_merged_terminal_design_gap`).
 *      - `skipped-not-mine` → return `"skipped-not-mine"` (dispatcher
 *        decided the epic isn't its concern — e.g. roster mismatch).
 *
 * Throws are caught by `withIdempotency` in {@link orchdMergeConsume}
 * — handler offset is NOT advanced; next sweep retries.
 */
export function createAutoMergeHandler(
  deps: AutoMergeHandlerDeps,
): (event: TaskDonePayload) => Promise<AutoMergeOutcome> {
  const dispatch = deps.dispatchEpicMerge ?? DEFAULT_DISPATCH_STUB;
  const emit = deps.emit ?? defaultEmit;
  const logger = deps.logger ?? NOOP_LOGGER;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  return async (event) => {
    const tasks = deps.loadTasks ? await deps.loadTasks() : null;
    const epicId =
      tasks === null ? resolveEpicId(event, deps.db) : resolveEpicIdFromTasks(event, tasks);
    if (epicId === null) {
      logger.info(
        `orchd-merge: task.done taskId=${event.taskId} — no epic resolved (3-stage miss)`,
      );
      return "skipped-no-epic";
    }
    if (
      !(tasks === null ? isEpicComplete(deps.db, epicId) : isEpicCompleteFromTasks(tasks, epicId))
    ) {
      logger.info(
        `orchd-merge: epic=${epicId} not complete (open tasks remain) — skipped-epic-not-complete`,
      );
      return "skipped-epic-not-complete";
    }

    const result = await dispatch(epicId);
    switch (result.state) {
      case "merged": {
        emit(deps.db, {
          topic: "epic.merged",
          epicId,
          parentBase: result.parentBase,
          mergeSha: result.mergeSha,
          mergedAtSec: nowSec(),
        });
        logger.info(
          `orchd-merge: epic=${epicId} merged sha=${result.mergeSha.slice(0, 7)} parentBase=${result.parentBase}`,
        );
        return "merged";
      }
      case "merge-conflict":
      case "gate-held": {
        emit(deps.db, {
          topic: "epic.merge-blocked",
          epicId,
          reason: result.reason,
          blockedAtSec: nowSec(),
        });
        logger.warn(
          `orchd-merge: epic=${epicId} blocked state=${result.state} reason=${result.reason}`,
        );
        return "escalated";
      }
      case "already-merged": {
        logger.info(
          `orchd-merge: epic=${epicId} already-merged (merger_state.state='merged' terminal) — no-op`,
        );
        return "skipped-already-merged";
      }
      case "skipped-not-mine": {
        logger.info(
          `orchd-merge: epic=${epicId} dispatcher returned skipped-not-mine${result.reason ? ` (${result.reason})` : ""}`,
        );
        return "skipped-not-mine";
      }
    }
  };
}

function resolveEpicIdFromTasks(
  event: TaskDonePayload,
  tasks: ReadonlyArray<KanbanTask>,
): string | null {
  if (typeof event.epicId === "string" && event.epicId.length > 0) return event.epicId;
  const task = tasks.find((item) => item.id === event.taskId);
  if (!task) return null;
  if (typeof task.epic === "string" && task.epic.length > 0) return task.epic;
  const subject = task.subject ?? "";
  const match = SUBJECT_EPIC_PREFIX_RE.exec(subject);
  return match ? `e-${match[1]}` : null;
}

function isEpicCompleteFromTasks(tasks: ReadonlyArray<KanbanTask>, epicId: string): boolean {
  const bracket = `[${epicId}]`;
  return !tasks.some((task) => {
    const subject = task.subject ?? "";
    const bound =
      task.epic === epicId ||
      subject === bracket ||
      subject.startsWith(`${bracket} `) ||
      subject.startsWith(`[${epicId}/`);
    return (
      bound && task.status !== "done" && task.status !== "wontfix" && task.status !== "cancelled"
    );
  });
}

// ---------- Consumer surface (mirrors gitter-consumer.ts exactly) ----------

/** Test-injection seam — production callers pass `{db}` and accept defaults. */
export interface OrchdMergeConsumeDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Consumer name for offset tracking. Defaults to `'atmux:orchd-merge'`. */
  consumerName?: string;
  /** Topics to subscribe to. Defaults to `['task.done']`. */
  topics?: ReadonlyArray<string>;
  /** Real merge handler; default no-op returns 'skipped-no-epic'. */
  handler?: (event: TaskDonePayload) => Promise<AutoMergeOutcome>;
  /** Clock injection — propagated to `withIdempotency` for offset writes. */
  nowSec?: () => number;
  /** Optional logger; falls back to a no-op when absent. */
  logger?: Logger;
  /** Env injection for `isHonkerEnabled`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Default stub handler — emits skipped-no-epic regardless. */
async function defaultHandler(_event: TaskDonePayload): Promise<AutoMergeOutcome> {
  return "skipped-no-epic";
}

/**
 * Drain pending `task.done` events for the orchd-merge consumer,
 * invoking `deps.handler` (or the stubbed default) per event under
 * at-least-once idempotency. Returns the totals so callers can surface
 * "N processed, M escalated" without re-walking the offset table.
 *
 * Honker kill-switch short-circuit: when `ATMUX_HONKER` is off (the
 * default), the consumer logs once and returns zero totals so the
 * cron-only path stays untouched until the substrate flips on.
 *
 * Failure mode: a thrown handler is caught inside `withIdempotency`
 * and stops the drain at the failing event. The offset is NOT
 * advanced past it — the next sweep re-attempts. This function itself
 * NEVER throws on handler failure.
 */
export async function orchdMergeConsume(
  deps: OrchdMergeConsumeDeps,
): Promise<{ processed: number; escalated: number }> {
  const consumerName = deps.consumerName ?? "atmux:orchd-merge";
  const topics = deps.topics ?? (["task.done"] as const);
  const handler = deps.handler ?? defaultHandler;
  const logger = deps.logger ?? NOOP_LOGGER;

  if (!isHonkerEnabled(deps.env)) {
    logger.info("orchd-merge: ATMUX_HONKER=off — fallback to cron-only path");
    return { processed: 0, escalated: 0 };
  }

  let processed = 0;
  let escalated = 0;

  await withIdempotency(
    deps.db,
    consumerName,
    deps.nowSec ? { topics, nowSec: deps.nowSec } : { topics },
    async (event) => {
      // task.done is the only topic we subscribe to by default; the
      // cast is safe under the discriminated-union narrow at emit time.
      const outcome = await handler(event as TaskDonePayload);
      processed += 1;
      if (outcome === "escalated") escalated += 1;
    },
  );

  return { processed, escalated };
}
