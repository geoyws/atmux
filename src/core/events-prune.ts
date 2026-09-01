// ADR-202 §XI (queued via T2.2, t-c3a40f38) — events-prune cursor sweep.
//
// The `events` table (v10→v11 schema, ADR-202 §D1 substrate) is append-
// only. Without periodic pruning it grows unbounded — every emit() is
// one row, persisted forever by design (durability over eviction in
// Phase-1). Once consumers are reliably advancing their
// `subscriber_offsets`, we can safely evict rows that every consumer
// has already processed.
//
// Strict offset-gate invariant: an event is NEVER deleted while its
// rowid > MIN(subscriber_offsets.last_event_id_rowid). If even one
// consumer hasn't advanced past an event, the event stays. This is the
// "events never deleted while id > MIN(offset)" rule (AC §5 / §XI
// amendment) — the offset is consumer-truth, the prune respects it.
//
// `prune_state` (v12→v13 schema) records two values per team:
//   - `cursor`             — highest rowid we've pruned so far. Floor
//                            for the next sweep so we don't full-scan
//                            the table every tick.
//   - `last_pruned_at_sec` — unix seconds of the most recent sweep
//                            completion. Drives cadence checks and the
//                            medic visibility probe.
//
// Function is pure / caller-invoked. No cron wiring, no orchd hook —
// the follow-up wiring Task carries that. Single team_name per call;
// multi-team coordination is out of scope.

import type { Database } from "bun:sqlite";

/** Default time-to-live for an event before it becomes prune-eligible. */
const DEFAULT_TTL_SEC = 30 * 86400;
/** Default soft cap on the `events` table — FIFO eviction kicks in above this. */
const DEFAULT_MAX_ROWS = 100_000;

export interface PruneOpts {
  /** Events older than `now - ttlSec` are eligible for TTL eviction.
   *  Default 30 days. */
  ttlSec?: number;
  /** Soft cap on the `events` table row count. When exceeded, the
   *  oldest rows (FIFO by rowid) are evicted down to the cap. Eviction
   *  is still offset-gated — only rows within the offset-allowed window
   *  may be deleted. Default 100_000. */
  maxRows?: number;
  /** The team this prune call shepherds. Used to key the `prune_state`
   *  row. Required in practice — callers always know their team. */
  teamName?: string;
  /** Test-injection seam — override the now-second clock for TTL +
   *  `last_pruned_at_sec` writes. */
  nowSec?: () => number;
}

export interface PruneResult {
  /** Total events DELETEd from the `events` table this call. */
  deleted: number;
  /** Events that would have been candidates but were skipped because
   *  the offset gate didn't allow advance past `prune_state.cursor`. */
  skipped: number;
  /** Populated only when the offset gate refused the call. Empty in
   *  the happy path. */
  reason?: string;
}

/**
 * Sweep the `events` table for prunable rows. Idempotent + offset-gated.
 *
 * Algorithm (one SQLite transaction):
 *   1. `floor` = `prune_state.cursor` for this team (0 if no row).
 *   2. `ceiling` = events.rowid for the event whose event_id matches
 *      `MIN(subscriber_offsets.last_event_id)`. The slowest consumer
 *      defines how far we can prune. 0 if no consumers / lookup empty.
 *   3. If `ceiling <= floor`: no consumer has advanced past our cursor
 *      since the last sweep — return early with `reason` populated.
 *   4. Within `(floor, ceiling]`: DELETE rows older than `ttlSec`.
 *   5. If `COUNT(*) > maxRows` after TTL prune: FIFO-evict the excess
 *      from `(floor, ceiling]` to bring the table back to the cap.
 *   6. UPSERT `prune_state` with new `cursor=ceiling` + now-second
 *      timestamp.
 */
export function prune(db: Database, opts: PruneOpts = {}): PruneResult {
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const teamName = opts.teamName;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  if (!teamName) {
    throw new Error(
      "events-prune: opts.teamName is required (caller-side responsibility per ADR-202 §XI)",
    );
  }

  return db.transaction((): PruneResult => {
    // Step 1: read floor from prune_state.
    const cursorRow = db
      .prepare("SELECT cursor FROM prune_state WHERE team_name = ?")
      .get(teamName) as { cursor: number } | undefined;
    const floor = Math.max(cursorRow?.cursor ?? 0, 0);

    // Step 2: compute ceiling — rowid of the event matching the
    // slowest consumer's last_event_id. Empty subscriber_offsets or a
    // last_event_id pointing at a since-pruned event yields no row →
    // ceiling = 0 (skip path will fire).
    const ceilingRow = db
      .prepare(
        `SELECT events.rowid AS rid
         FROM events
         WHERE events.event_id = (SELECT MIN(last_event_id) FROM subscriber_offsets)`,
      )
      .get() as { rid: number } | undefined;
    const ceiling = ceilingRow?.rid ?? 0;

    // Step 3: offset-gate. Skip path reports how many events COULD be
    // pruned if offsets advanced, so the caller can surface visibility
    // ("12k events queued, no consumer has read past id 42 in 6h").
    if (ceiling <= floor) {
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM events WHERE rowid <= ?").get(floor) as {
        n: number;
      };
      return {
        deleted: 0,
        skipped: n,
        reason: "offsets stale — no consumers advanced past prune_state.cursor since last prune",
      };
    }

    // Step 4: TTL path — DELETE rows in (floor, ceiling] older than
    // `now - ttlSec`. Uses the rowid-IN trick because SQLite's DELETE
    // ... LIMIT requires SQLITE_ENABLE_UPDATE_DELETE_LIMIT (not on by
    // default for bun:sqlite).
    const ttlCutoffSec = nowSec() - ttlSec;
    const ttlRes = db
      .prepare(
        `DELETE FROM events
         WHERE rowid IN (
           SELECT rowid FROM events
           WHERE rowid > ? AND rowid <= ? AND emitted_at_sec < ?
           ORDER BY rowid ASC
         )`,
      )
      .run(floor, ceiling, ttlCutoffSec);
    const ttlDeleted = Number(ttlRes.changes ?? 0);

    // Step 5: max-rows soft-cap. After TTL prune, if the table is
    // still over capacity, FIFO-evict the oldest rows from the
    // offset-allowed window. Cap still respects offset-gating: we
    // only delete rows with rowid <= ceiling.
    let maxDeleted = 0;
    const { remaining } = db.prepare("SELECT COUNT(*) AS remaining FROM events").get() as {
      remaining: number;
    };
    if (remaining > maxRows) {
      const excess = remaining - maxRows;
      const maxRes = db
        .prepare(
          `DELETE FROM events
           WHERE rowid IN (
             SELECT rowid FROM events
             WHERE rowid > ? AND rowid <= ?
             ORDER BY rowid ASC
             LIMIT ?
           )`,
        )
        .run(floor, ceiling, excess);
      maxDeleted = Number(maxRes.changes ?? 0);
    }

    // Step 6: advance the cursor + stamp the sweep time.
    const now = nowSec();
    db.prepare(
      `INSERT INTO prune_state (team_name, cursor, last_pruned_at_sec)
       VALUES (?, ?, ?)
       ON CONFLICT(team_name) DO UPDATE SET
         cursor = excluded.cursor,
         last_pruned_at_sec = excluded.last_pruned_at_sec`,
    ).run(teamName, ceiling, now);

    return { deleted: ttlDeleted + maxDeleted, skipped: 0 };
  })();
}
