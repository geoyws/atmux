// ADR-060 §D3: kanban repository. SQL is owned here; verbs + core/
// modules see a typed CRUD surface that mirrors the existing
// `core/kanban.ts` API. Zod stays at the row↔domain bridge so DB
// constraints + Zod parse are belt-and-suspenders.
//
// Field naming convention: SQL columns are snake_case; domain
// objects (TS types) are camelCase. `taskFromRow` / `taskToRow`
// own the conversion. Future schema work folds into row helpers.

import type { Database } from "bun:sqlite";
import {
  type KanbanTask,
  KanbanTask as KanbanTaskSchema,
} from "../../schema/kanban.ts";

// ---------- Row shapes (SQL columns; raw bun:sqlite output) ----------

interface TaskRow {
  id: string;
  subject: string | null;
  body: string | null;
  status: string | null;
  owner: string | null;
  deps: string | null;
  priority: number | null;
  lane: string | null;
  deliverable: string | null;
  stale_min: number | null;
  driver_only: number | null;
  created_at: number | null;
  claimed_at: number | null;
  completed_at: number | null;
  claimed_from: string | null;
  created_from: string | null;
  note: string | null;
  // ADR-263 §D3 (sqlite-migrations v16→v17): git task-source provenance.
  source_kind: string | null;
  source_id: string | null;
  extra: string | null;
}

// ---------- Row ↔ domain bridges ----------

/** Encode a string-or-object value for SQLite TEXT storage. Strings store
 *  verbatim (so `_maybeParseJsonValue` returns them as strings). Objects
 *  serialize as JSON. Null/undefined → null. Used for `claimedFrom` /
 *  `createdFrom` which bash atmux writes in either shape (per src/schema/
 *  kanban.ts comment for those fields). */
function _maybeStringifyValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Inverse of `_maybeStringifyValue`. A stored string that PARSES to a JSON
 *  object round-trips back to the object; anything else (plain tags like
 *  `"commit"`, `"dispatch"`, member names) returns as-is. */
function _maybeParseJsonValue(s: string | null): unknown {
  if (s === null) return null;
  if (s.length === 0 || s.charCodeAt(0) !== 0x7b /* '{' */) return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const KNOWN_TASK_FIELDS = new Set([
  "id",
  "subject",
  "body",
  "status",
  "owner",
  "deps",
  "priority",
  "lane",
  "deliverable",
  "staleMin",
  "driverOnly",
  "createdAt",
  "claimedAt",
  "completedAt",
  "claimedFrom",
  "createdFrom",
  "note",
  // ADR-263 §D3: top-level columns, not extra-JSON (dedup index target).
  "sourceKind",
  "sourceId",
]);

export function taskFromRow(row: TaskRow): KanbanTask {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  const candidate: Record<string, unknown> = {
    id: row.id,
    subject: row.subject ?? undefined,
    body: row.body,
    status: row.status ?? undefined,
    owner: row.owner,
    deps: row.deps ? JSON.parse(row.deps) : undefined,
    priority: row.priority,
    lane: row.lane,
    deliverable: row.deliverable,
    staleMin: row.stale_min,
    driverOnly: row.driver_only === null ? undefined : row.driver_only === 1,
    createdAt: row.created_at ?? undefined,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    claimedFrom: _maybeParseJsonValue(row.claimed_from),
    createdFrom: _maybeParseJsonValue(row.created_from),
    note: row.note,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    ...extra,
  };
  return KanbanTaskSchema.parse(candidate);
}

export function taskToRow(task: KanbanTask): TaskRow {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(task)) {
    if (!KNOWN_TASK_FIELDS.has(k)) extra[k] = v;
  }
  return {
    id: task.id,
    subject: task.subject ?? null,
    body: task.body ?? null,
    status: task.status ?? null,
    owner: task.owner ?? null,
    deps: task.deps ? JSON.stringify(task.deps) : null,
    priority: task.priority ?? null,
    lane: task.lane ?? null,
    deliverable: task.deliverable ?? null,
    stale_min: task.staleMin ?? null,
    driver_only: task.driverOnly === undefined ? null : task.driverOnly ? 1 : 0,
    created_at: task.createdAt ?? null,
    claimed_at: task.claimedAt ?? null,
    completed_at: task.completedAt ?? null,
    claimed_from: _maybeStringifyValue(task.claimedFrom),
    created_from: _maybeStringifyValue(task.createdFrom),
    note: task.note ?? null,
    source_kind: task.sourceKind ?? null,
    source_id: task.sourceId ?? null,
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

// ---------- Bind-param helper ----------

/** bun:sqlite named-bind expects keys prefixed with `$` (matches the SQL
 *  placeholder syntax `$col`). Row interfaces use bare column names; this
 *  helper prefixes at the call site. Return type narrowed to the
 *  `SQLQueryBindings` value union bun:sqlite accepts. */
type BindValue = string | number | null;
function bind(row: TaskRow): Record<string, BindValue> {
  const out: Record<string, BindValue> = {};
  for (const [k, v] of Object.entries(row)) out[`$${k}`] = v as BindValue;
  return out;
}

// ---------- Repository ----------

export interface TaskFilter {
  owner?: string;
  status?: string;
  lane?: string;
}

export class KanbanRepo {
  constructor(private db: Database) {}

  // ----- task CRUD -----

  addTask(task: KanbanTask): void {
    const row = taskToRow(task);
    this.db
      .query(
        `INSERT INTO tasks (id, subject, body, status, owner, deps, priority,
				                    lane, deliverable, stale_min, driver_only,
				                    created_at, claimed_at, completed_at, claimed_from,
				                    created_from, note, source_kind, source_id, extra)
				 VALUES ($id, $subject, $body, $status, $owner, $deps, $priority,
				         $lane, $deliverable, $stale_min, $driver_only,
				         $created_at, $claimed_at, $completed_at, $claimed_from,
				         $created_from, $note, $source_kind, $source_id, $extra)`,
      )
      .run(bind(row));
  }

  upsertTask(task: KanbanTask): void {
    const row = taskToRow(task);
    this.db
      .query(
        `INSERT INTO tasks (id, subject, body, status, owner, deps, priority,
				                    lane, deliverable, stale_min, driver_only,
				                    created_at, claimed_at, completed_at, claimed_from,
				                    created_from, note, source_kind, source_id, extra)
				 VALUES ($id, $subject, $body, $status, $owner, $deps, $priority,
				         $lane, $deliverable, $stale_min, $driver_only,
				         $created_at, $claimed_at, $completed_at, $claimed_from,
				         $created_from, $note, $source_kind, $source_id, $extra)
				 ON CONFLICT(id) DO UPDATE SET
				   subject=excluded.subject, body=excluded.body, status=excluded.status,
				   owner=excluded.owner, deps=excluded.deps, priority=excluded.priority,
				   lane=excluded.lane,
				   deliverable=excluded.deliverable, stale_min=excluded.stale_min,
				   driver_only=excluded.driver_only, created_at=excluded.created_at,
				   claimed_at=excluded.claimed_at, completed_at=excluded.completed_at,
				   claimed_from=excluded.claimed_from, created_from=excluded.created_from,
				   note=excluded.note, source_kind=excluded.source_kind,
				   source_id=excluded.source_id, extra=excluded.extra`,
      )
      .run(bind(row));
  }

  getTask(id: string): KanbanTask | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE id = $id")
      .get({ $id: id }) as TaskRow | null;
    return row ? taskFromRow(row) : null;
  }

  /** ADR-263 §D3: dedup lookup for `atmux issues sync` — find the task
   *  ingested from a given external identity (`github:owner/repo#123`).
   *  Backed by the partial-unique `idx_tasks_source_id` index. Returns
   *  `null` when no task carries that `sourceId` yet (→ insert a fresh
   *  one). */
  getTaskBySourceId(sourceId: string): KanbanTask | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE source_id = $sourceId")
      .get({ $sourceId: sourceId }) as TaskRow | null;
    return row ? taskFromRow(row) : null;
  }

  /** ADR-263 §D3: list tasks ingested from a given source scope, e.g.
   *  `github:owner/repo#` (the canonical `sourceId` prefix). Used by the
   *  sync engine's close-reconciliation pass. */
  listTasksBySourcePrefix(prefix: string): KanbanTask[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE source_id LIKE $prefix ORDER BY created_at ASC, id ASC")
      .all({ $prefix: `${prefix}%` }) as TaskRow[];
    return rows.map(taskFromRow);
  }

  listTasks(filter: TaskFilter = {}): KanbanTask[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.owner !== undefined) {
      where.push("owner = $owner");
      params.$owner = filter.owner;
    }
    if (filter.status !== undefined) {
      where.push("status = $status");
      params.$status = filter.status;
    }
    if (filter.lane !== undefined) {
      where.push("lane = $lane");
      params.$lane = filter.lane;
    }
    const sql = `SELECT * FROM tasks${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, id ASC`;
    const rows = this.db.query(sql).all(params) as TaskRow[];
    return rows.map(taskFromRow);
  }

  deleteTask(id: string): boolean {
    const result = this.db.query("DELETE FROM tasks WHERE id = $id").run({ $id: id });
    return result.changes > 0;
  }
}
