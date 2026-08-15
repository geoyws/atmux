// ADR-228 §D2: SpawnQueue repository.
//
// CRUD + transactional dequeue for the v14 `spawn_queue` table
// (`src/abstractions/sqlite-migrations.ts:651` — TODO_FAN_IN_RENUMBER).
// Pattern mirrors `complaints-repo.ts`:
// row interface (snake_case SQL columns), row↔domain bridges
// (camelCase TS), CRUD methods on the repo class. Writes assume a
// caller-validated `SpawnQueueRow`; reads `.parse()` every row through
// `SpawnQueueRow` per the task AC ("parseStrict on each read").
//
// `dequeueHead` wraps SELECT-then-UPDATE in `transactImmediate` (per
// ADR-134 §state-machine race-protection — same pattern used by
// `merger-state-repo.ts`). Concurrent callers serialize on the SQLite
// write lock: the second caller waits on `busy_timeout = 5000ms` for
// the first to commit, then sees the already-flipped row and proceeds
// to the next head (or `null` when the queued pool drains).

import type { Database } from "bun:sqlite";
import { transactImmediate } from "../../abstractions/sqlite.ts";
import {
  type SpawnQueueRow,
  SpawnQueueRow as SpawnQueueRowSchema,
  type SpawnQueueState,
} from "../../schema/spawn-queue.ts";

// ---------- Row shape (raw bun:sqlite output; snake_case SQL columns) ----------

interface SpawnQueueSqlRow {
  queue_id: string;
  epic_id: string;
  spawn_args: string;
  queued_at_sec: number;
  queued_by: string;
  priority: number;
  attempts: number;
  last_attempt_at_sec: number | null;
  last_failure_reason: string | null;
  state: string;
}

// ---------- Row ↔ domain bridges ----------

/**
 * SQL row → domain shape. Parses through `SpawnQueueRowSchema` (per AC
 * "parseStrict on each read") so schema drift surfaces immediately
 * rather than producing a silently-malformed domain object.
 */
export function spawnQueueFromRow(row: SpawnQueueSqlRow): SpawnQueueRow {
  return SpawnQueueRowSchema.parse({
    queueId: row.queue_id,
    epicId: row.epic_id,
    spawnArgs: row.spawn_args,
    queuedAtSec: row.queued_at_sec,
    queuedBy: row.queued_by,
    priority: row.priority,
    attempts: row.attempts,
    lastAttemptAtSec: row.last_attempt_at_sec,
    lastFailureReason: row.last_failure_reason,
    state: row.state,
  });
}

/** Domain shape → SQL row. Identity-mapping camelCase to snake_case. */
export function spawnQueueToRow(r: SpawnQueueRow): SpawnQueueSqlRow {
  return {
    queue_id: r.queueId,
    epic_id: r.epicId,
    spawn_args: r.spawnArgs,
    queued_at_sec: r.queuedAtSec,
    queued_by: r.queuedBy,
    priority: r.priority,
    attempts: r.attempts,
    last_attempt_at_sec: r.lastAttemptAtSec,
    last_failure_reason: r.lastFailureReason,
    state: r.state,
  };
}

// ---------- Repository ----------

export class SpawnQueueRepo {
  constructor(private readonly db: Database) {}

  /**
   * Insert a freshly-built `SpawnQueueRow`. Caller is responsible for
   * having parsed through `SpawnQueueRowSchema` first (defaults
   * applied, regex / enum honoured) — the repo does NOT re-parse on
   * write, mirroring `ComplaintsRepo.insert`.
   */
  insertQueued(row: SpawnQueueRow): void {
    const sql = spawnQueueToRow(row);
    this.db
      .prepare(
        `INSERT INTO spawn_queue (
            queue_id, epic_id, spawn_args, queued_at_sec, queued_by,
            priority, attempts, last_attempt_at_sec, last_failure_reason, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sql.queue_id,
        sql.epic_id,
        sql.spawn_args,
        sql.queued_at_sec,
        sql.queued_by,
        sql.priority,
        sql.attempts,
        sql.last_attempt_at_sec,
        sql.last_failure_reason,
        sql.state,
      );
  }

  /**
   * Every row in a given state, sorted by `(priority, queued_at_sec)` —
   * the composite `idx_spawn_queue_priority_queued` index covers the
   * predicate + sort without an extra sort step.
   */
  listByState(state: SpawnQueueState): SpawnQueueRow[] {
    const rows = this.db
      .query("SELECT * FROM spawn_queue WHERE state = ? ORDER BY priority, queued_at_sec")
      .all(state) as SpawnQueueSqlRow[];
    return rows.map(spawnQueueFromRow);
  }

  /**
   * All `queued` rows sorted head-first. Convenience alias for the
   * drain tick + `atmux orchd queue list` operator command (lands in
   * t-3-306e935d).
   */
  listAllSorted(): SpawnQueueRow[] {
    return this.listByState("queued");
  }

  /**
   * Atomically pop the head of the `queued` pool: under BEGIN
   * IMMEDIATE — (1) `SELECT` the (priority, queued_at_sec)-min row
   * with `state='queued'`, (2) `UPDATE` it to `state='spawning'`, (3)
   * return the post-flip row. Concurrent callers serialize on the
   * SQLite write lock per ADR-134 §state-machine race-protection.
   * Returns `null` when the queued pool is empty.
   *
   * The returned row reflects the NEW state (`spawning`) so the caller
   * doesn't need to refetch to confirm the flip succeeded.
   */
  dequeueHead(): SpawnQueueRow | null {
    return transactImmediate(this.db, () => {
      const row = this.db
        .query(
          `SELECT * FROM spawn_queue
           WHERE state = 'queued'
           ORDER BY priority, queued_at_sec
           LIMIT 1`,
        )
        .get() as SpawnQueueSqlRow | null;
      if (row === null) return null;
      this.db
        .prepare("UPDATE spawn_queue SET state = 'spawning' WHERE queue_id = ?")
        .run(row.queue_id);
      const pre = spawnQueueFromRow(row);
      return { ...pre, state: "spawning" as SpawnQueueState };
    });
  }

  /**
   * Flip `state → 'abandoned'` and record `last_failure_reason`. Used
   * by the drain tick after the `attempts` counter hits `MAX_ATTEMPTS`.
   * Returns `true` on update, `false` when no row matched the id —
   * lets the caller distinguish "row was already deleted" from "we
   * abandoned it".
   */
  markAbandoned(queueId: string, reason: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE spawn_queue
         SET state = 'abandoned', last_failure_reason = ?
         WHERE queue_id = ?`,
      )
      .run(reason, queueId);
    return result.changes > 0;
  }

  /**
   * Increment `attempts`, set `last_attempt_at_sec` + `last_failure_reason`,
   * and flip `state` back to `'queued'` so the next drain tick can
   * retry. The drain tick caller is responsible for the
   * "attempts >= MAX_ATTEMPTS → markAbandoned instead" branch BEFORE
   * calling this. Returns `true` on update, `false` when no row matched.
   *
   * `nowSec` is an injected clock per the codebase test-clock
   * convention (matches `Complaint.openedAt`'s caller-supplied epoch).
   */
  incrementAttempts(queueId: string, reason: string, nowSec: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE spawn_queue
         SET attempts = attempts + 1,
             last_failure_reason = ?,
             last_attempt_at_sec = ?,
             state = 'queued'
         WHERE queue_id = ?`,
      )
      .run(reason, nowSec, queueId);
    return result.changes > 0;
  }

  /**
   * Hard-delete a row by `queue_id`. The success path of a drain
   * attempt deletes the row (the spawned epic-team is the audit
   * trail; the queue entry is consumed). Returns `true` on delete,
   * `false` when no row matched.
   */
  deleteByQueueId(queueId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM spawn_queue WHERE queue_id = ?")
      .run(queueId);
    return result.changes > 0;
  }
}
