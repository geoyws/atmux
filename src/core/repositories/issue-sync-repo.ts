// ADR-261 §D4: issue_sync ledger repository.
//
// SQL is owned here; the sync engine sees a typed CRUD surface.
// Pattern mirrors `complaints-repo.ts` — row interface, row↔domain
// bridges, methods on the repo class. Wraps the `issue_sync` +
// `issue_sync_cursor` tables (migration v16→v17 in
// `src/abstractions/sqlite-migrations.ts`), both resident in the
// POLLING team's state.db (§D4 residency — the complaint row itself
// lives in the TARGET team's state.db per ADR-150 §D1, reached only
// through the `complaintId` back-pointer).
//
// Field naming convention: SQL columns are snake_case; domain objects
// (TS types) are camelCase. `issueSyncFromRow` / `issueSyncToRow` own
// the conversion. `extra` is a JSON-string column on disk; `Record<
// string, unknown>` in the domain.
//
// The §D4 ledger-first write ordering maps onto three methods:
//   1. `upsertPending`          — INSERT/UPDATE with
//                                 `filing_state = 'pending'` BEFORE the
//                                 complaint is filed in the target DB;
//   2. (caller files the complaint via `fileDedupedComplaint`);
//   3. `markFiled`              — flip to `filed` + record the
//                                 cross-DB `complaint_id` back-pointer.
// A kill between steps leaves a `pending` row that `listPending`
// surfaces at the next sync — the deterministic repair path.

import type { Database } from "../../abstractions/sqlite.ts";
import { transactImmediate } from "../../abstractions/sqlite.ts";
import {
  type IssueSyncCursor,
  IssueSyncCursor as IssueSyncCursorSchema,
  type IssueSyncRecord,
  IssueSyncRecord as IssueSyncRecordSchema,
} from "../../schema/issue-sync.ts";

// ---------- Row shapes (SQL columns; raw bun:sqlite output) ----------

interface IssueSyncRow {
  source_id: string;
  tracker_id: string;
  scope: string;
  complaint_id: string | null;
  target_team: string | null;
  upstream_state: string;
  upstream_updated_at_sec: number;
  local_resolution: string | null;
  filing_state: string;
  first_seen_sec: number;
  last_synced_sec: number;
  extra: string | null;
}

interface IssueSyncCursorRow {
  tracker_id: string;
  scope: string;
  cursor: string | null;
  updated_at_sec: number;
}

// ---------- Row ↔ domain bridges ----------

export function issueSyncFromRow(row: IssueSyncRow): IssueSyncRecord {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  return IssueSyncRecordSchema.parse({
    sourceId: row.source_id,
    trackerId: row.tracker_id,
    scope: row.scope,
    complaintId: row.complaint_id,
    targetTeam: row.target_team,
    upstreamState: row.upstream_state,
    upstreamUpdatedAtSec: row.upstream_updated_at_sec,
    localResolution: row.local_resolution,
    filingState: row.filing_state,
    firstSeenSec: row.first_seen_sec,
    lastSyncedSec: row.last_synced_sec,
    extra,
  });
}

export function issueSyncToRow(r: IssueSyncRecord): IssueSyncRow {
  return {
    source_id: r.sourceId,
    tracker_id: r.trackerId,
    scope: r.scope,
    complaint_id: r.complaintId ?? null,
    target_team: r.targetTeam ?? null,
    upstream_state: r.upstreamState,
    upstream_updated_at_sec: r.upstreamUpdatedAtSec,
    local_resolution: r.localResolution ?? null,
    filing_state: r.filingState,
    first_seen_sec: r.firstSeenSec,
    last_synced_sec: r.lastSyncedSec,
    extra: r.extra && Object.keys(r.extra).length > 0 ? JSON.stringify(r.extra) : null,
  };
}

function cursorFromRow(row: IssueSyncCursorRow): IssueSyncCursor {
  return IssueSyncCursorSchema.parse({
    trackerId: row.tracker_id,
    scope: row.scope,
    cursor: row.cursor,
    updatedAtSec: row.updated_at_sec,
  });
}

// ---------- Repository ----------

/** Input to {@link IssueSyncRepo.upsertPending} — the §D4 step-1
 *  fields. `filingState` / `complaintId` / `localResolution` are NOT
 *  accepted: step 1 always lands `pending`, and on conflict the
 *  existing back-pointer + provenance are preserved (see the method
 *  doc). */
export interface UpsertPendingOpts {
  sourceId: string;
  trackerId: string;
  scope: string;
  /** ADR-261 §D9 routing — omit/null when the polling team is the
   *  target. */
  targetTeam?: string | null;
  /** Normalized upstream state (`open`/`closed` at the verb layer). */
  upstreamState: string;
  upstreamUpdatedAtSec: number;
  /** Stamped as `first_seen_sec` on fresh inserts only — preserved on
   *  conflict (the ledger remembers the FIRST sighting). */
  firstSeenSec: number;
  lastSyncedSec: number;
  /** Forward-compat JSON bag (issue URL, labels, author, …). */
  extra?: Record<string, unknown>;
}

export class IssueSyncRepo {
  constructor(private readonly db: Database) {}

  // ---------- issue_sync ledger ----------

  getBySourceId(sourceId: string): IssueSyncRecord | null {
    const row = this.db
      .query("SELECT * FROM issue_sync WHERE source_id = ?")
      .get(sourceId) as IssueSyncRow | null;
    if (row === null) return null;
    return issueSyncFromRow(row);
  }

  /** §D4 ledger-first step 1: land (or refresh) the ledger row with
   *  `filing_state = 'pending'` BEFORE the complaint is filed in the
   *  target team's DB — a kill after this write leaves a repairable
   *  `pending` row, never an absent one.
   *
   *  UPSERT semantics — fresh `sourceId` inserts; an existing row
   *  (e.g. the §D4 reopen re-file arm, or a crash-repair retry)
   *  refreshes the upstream/scope/extra fields and resets
   *  `filing_state` to `pending`, but PRESERVES `first_seen_sec`
   *  (first sighting), `complaint_id` (a crash-repair retry must not
   *  drop an already-recorded back-pointer) and `local_resolution`
   *  (the reopen-symmetry matrix reads the prior provenance).
   *  BEGIN IMMEDIATE so a concurrent manual verb + orchd tick on the
   *  same `sourceId` serialize rather than race a double-write.
   *  Returns the post-write row. */
  upsertPending(opts: UpsertPendingOpts): IssueSyncRecord {
    const extraStr =
      opts.extra && Object.keys(opts.extra).length > 0 ? JSON.stringify(opts.extra) : null;
    return transactImmediate(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO issue_sync (
              source_id, tracker_id, scope, complaint_id, target_team,
              upstream_state, upstream_updated_at_sec, local_resolution,
              filing_state, first_seen_sec, last_synced_sec, extra
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 'pending', ?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
              tracker_id = excluded.tracker_id,
              scope = excluded.scope,
              target_team = excluded.target_team,
              upstream_state = excluded.upstream_state,
              upstream_updated_at_sec = excluded.upstream_updated_at_sec,
              filing_state = 'pending',
              last_synced_sec = excluded.last_synced_sec,
              extra = excluded.extra`,
        )
        .run(
          opts.sourceId,
          opts.trackerId,
          opts.scope,
          opts.targetTeam ?? null,
          opts.upstreamState,
          opts.upstreamUpdatedAtSec,
          opts.firstSeenSec,
          opts.lastSyncedSec,
          extraStr,
        );
      // Read-back inside the same transaction so the returned row
      // reflects exactly what landed (preserved-on-conflict columns
      // included).
      const row = this.db
        .query("SELECT * FROM issue_sync WHERE source_id = ?")
        .get(opts.sourceId) as IssueSyncRow;
      return issueSyncFromRow(row);
    });
  }

  /** §D4 ledger-first step 3: the complaint landed in the target
   *  team's DB — flip the row to `filed` and record the cross-DB
   *  `complaint_id` back-pointer. Returns true on update, false when
   *  no row matched the `sourceId`. */
  markFiled(sourceId: string, complaintId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE issue_sync SET filing_state = 'filed', complaint_id = ?
         WHERE source_id = ?`,
      )
      .run(complaintId, sourceId);
    return result.changes > 0;
  }

  /** Record resolution PROVENANCE for the §D4 reopen-symmetry matrix:
   *  `tracker:<id>` when the sync auto-resolved the complaint as an
   *  upstream mirror (re-surfaces on upstream reopen); `lead` when the
   *  lead resolved/wontfixed (never re-litigated by a poll). Returns
   *  true on update, false when no row matched the `sourceId`. */
  recordLocalResolution(sourceId: string, provenance: string): boolean {
    const result = this.db
      .prepare("UPDATE issue_sync SET local_resolution = ? WHERE source_id = ?")
      .run(provenance, sourceId);
    return result.changes > 0;
  }

  /** Advance the upstream mirror fields after a poll touch — the §D4
   *  no-op / refresh / close arms all land here (the matrix decides
   *  what ELSE to do; this method is the persistence-only primitive).
   *  Returns true on update, false when no row matched the
   *  `sourceId`. */
  updateUpstream(
    sourceId: string,
    state: string,
    updatedAtSec: number,
    lastSyncedSec: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE issue_sync
         SET upstream_state = ?, upstream_updated_at_sec = ?, last_synced_sec = ?
         WHERE source_id = ?`,
      )
      .run(state, updatedAtSec, lastSyncedSec, sourceId);
    return result.changes > 0;
  }

  /** Crash-window repair scan (§D4): every row a kill stranded at
   *  `pending` for one (trackerId, scope) pair. The next sync walks
   *  these FIRST — looks up the target DB by `sourceId` and either
   *  records the existing complaint's id or completes the file.
   *  Oldest-first so repair order matches original sighting order.
   *  Hits `idx_issue_sync_filing_state`. */
  listPending(trackerId: string, scope: string): IssueSyncRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM issue_sync
         WHERE filing_state = 'pending' AND tracker_id = ? AND scope = ?
         ORDER BY first_seen_sec ASC`,
      )
      .all(trackerId, scope) as IssueSyncRow[];
    return rows.map(issueSyncFromRow);
  }

  // ---------- issue_sync_cursor (per-page checkpoint, §D4) ----------

  /** Read the poll cursor for one (trackerId, scope) pair. `null`
   *  when no checkpoint has ever been written (first sync — start
   *  from the top of the listing). */
  getCursor(trackerId: string, scope: string): IssueSyncCursor | null {
    const row = this.db
      .query("SELECT * FROM issue_sync_cursor WHERE tracker_id = ? AND scope = ?")
      .get(trackerId, scope) as IssueSyncCursorRow | null;
    if (row === null) return null;
    return cursorFromRow(row);
  }

  /** Checkpoint the poll cursor — called PER PAGE (§D4) so a killed
   *  900s tick resumes from the last page, never restarts. `cursor`
   *  is the adapter's opaque `nextCursor` token; pass `null` when the
   *  listing is exhausted (the next sync starts a fresh walk). UPSERT
   *  on the (tracker_id, scope) composite PK. */
  setCursor(trackerId: string, scope: string, cursor: string | null, updatedAtSec: number): void {
    this.db
      .prepare(
        `INSERT INTO issue_sync_cursor (tracker_id, scope, cursor, updated_at_sec)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tracker_id, scope) DO UPDATE SET
            cursor = excluded.cursor,
            updated_at_sec = excluded.updated_at_sec`,
      )
      .run(trackerId, scope, cursor, updatedAtSec);
  }
}
