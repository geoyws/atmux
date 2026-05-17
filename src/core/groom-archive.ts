// t-8287b37d C1: kanban + inbox archival into a sibling archive.db.
//
// Background — `state.db` accumulates indefinitely:
//   - `tasks`: every completed Task row stays forever
//   - `inbox_messages`: every `atmux send <member>` row stays forever
//   - (complaints: skipped for v1; F2 is recent, no volume yet)
//
// Solution: lazy archival into `<atmuxDir>/archive.db` (same schema,
// holds the long tail). Runs at the end of `atmux groom` when the
// caller passes `--archive`. Daily cron-fired.
//
// Atomicity — both halves (INSERT into archive, DELETE from main)
// share ONE state.db transaction by ATTACH-ing archive.db. A crash
// mid-archive can't leave duplicates OR lost rows. SQLite handles
// cross-DB transactional semantics correctly when both files are
// local + WAL is consistent.
//
// Idempotent: re-running on a settled cluster moves zero rows. Safe
// to fire multiple times per day. Empty state.db / archive.db on
// first run is fine — `openDatabase` creates + migrates lazily.

import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { closeDatabase, openDatabase, transact } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";

// ---------- Paths ----------

export function stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

export function archiveDbPath(atmuxDir: string): string {
  return join(atmuxDir, "archive.db");
}

// ---------- Result shape ----------

export interface GroomArchiveResult {
  /** Number of `tasks` rows moved from state.db → archive.db. */
  tasksArchived: number;
  /** Number of `inbox_messages` rows moved. */
  inboxArchived: number;
  /** Epoch-seconds cutoff that was applied (anything completed before
   *  this got moved). Surfaced so callers can render a meaningful log
   *  line ("archived rows completed before <iso>"). */
  cutoffEpoch: number;
}

// ---------- Options ----------

export interface GroomArchiveOpts {
  /** Days threshold — rows completed/older than this get archived.
   *  Default `30`. */
  days?: number;
  /** Inject epoch-ms for tests; defaults to `Date.now()`. */
  nowMs?: number;
  /** Dry-run: count rows that WOULD be archived without mutating. */
  dryRun?: boolean;
}

// ---------- Main archival ----------

/**
 * Move long-tail rows from `state.db` to a sibling `archive.db`.
 *
 *   - `tasks`: rows where `status='done' AND completed_at < cutoff`.
 *   - `inbox_messages`: rows where `ts < cutoff`.
 *   - `complaints`: SKIPPED (deferred to a later commit per task
 *     body — F2 just shipped, no volume yet).
 *
 * Both inserts + deletes share one state.db transaction via ATTACH
 * so atomicity holds across the two DBs. The archive.db is opened
 * once first to materialize its schema via the same migration
 * ladder, then closed so the ATTACH can re-open it under the state
 * connection.
 *
 * Returns the counts moved + the applied cutoff (epoch-seconds).
 * No-op (zero counts) when state.db doesn't exist yet OR when no
 * rows qualify.
 */
export async function groomArchive(
  atmuxDir: string,
  opts: GroomArchiveOpts = {},
): Promise<GroomArchiveResult> {
  const days = opts.days ?? 30;
  const stampMs = opts.nowMs ?? now();
  const cutoffEpoch = Math.floor(stampMs / 1000) - days * 86400;
  const dryRun = opts.dryRun === true;

  const statePath = stateDbPath(atmuxDir);
  if (!(await exists(statePath))) {
    return { tasksArchived: 0, inboxArchived: 0, cutoffEpoch };
  }

  const archivePath = archiveDbPath(atmuxDir);

  // Materialize the archive.db schema via the same migration ladder.
  // Cheap when it already exists (no migration runs); also creates the
  // file + applies migrations from v0 → latest on first call.
  const archiveDb = openDatabase(archivePath, migrations);
  closeDatabase(archiveDb);

  // Open state.db + ATTACH archive.db under a single connection. All
  // moves run in one transaction on the state connection so a crash
  // mid-flow can't leave half-moved rows in either direction.
  const db = openDatabase(statePath, migrations);
  try {
    // ATTACH uses a literal path; SQLite refuses parameterized paths
    // for ATTACH. Path is operator-internal (atmuxDir-rooted) so
    // injection risk is bounded by atmuxDir trust — same trust we
    // give the state.db path itself.
    db.exec(`ATTACH DATABASE '${archivePath.replace(/'/g, "''")}' AS archive`);
    try {
      if (dryRun) {
        const taskCount =
          (
            db
              .query(
                `SELECT COUNT(*) AS n FROM main.tasks WHERE status='done' AND completed_at IS NOT NULL AND completed_at < $cutoff`,
              )
              .get({ $cutoff: cutoffEpoch }) as { n: number } | null
          )?.n ?? 0;
        const inboxCount =
          (
            db
              .query(`SELECT COUNT(*) AS n FROM main.inbox_messages WHERE ts < $cutoff`)
              .get({ $cutoff: cutoffEpoch }) as { n: number } | null
          )?.n ?? 0;
        return { tasksArchived: taskCount, inboxArchived: inboxCount, cutoffEpoch };
      }
      return transact(db, () => {
        // ----- tasks -----
        // INSERT OR IGNORE — re-run safety: if a prior partial run
        // already moved a row, the archive primary key conflict is
        // benign; the DELETE-from-main below clears it from state.db.
        db.exec(
          `INSERT OR IGNORE INTO archive.tasks
             SELECT * FROM main.tasks
             WHERE status='done' AND completed_at IS NOT NULL AND completed_at < ${cutoffEpoch}`,
        );
        const taskDelResult = db
          .query(
            `DELETE FROM main.tasks
               WHERE status='done' AND completed_at IS NOT NULL AND completed_at < $cutoff`,
          )
          .run({ $cutoff: cutoffEpoch });

        // ----- inbox_messages -----
        // No primary key conflict to ignore — inbox rows use auto-
        // increment id which doesn't collide cross-db. Plain INSERT.
        db.exec(
          `INSERT INTO archive.inbox_messages
             (member, msg_id, sender, body, ts, kind, extra)
             SELECT member, msg_id, sender, body, ts, kind, extra
             FROM main.inbox_messages
             WHERE ts < ${cutoffEpoch}`,
        );
        const inboxDelResult = db
          .query(`DELETE FROM main.inbox_messages WHERE ts < $cutoff`)
          .run({ $cutoff: cutoffEpoch });

        return {
          tasksArchived: taskDelResult.changes,
          inboxArchived: inboxDelResult.changes,
          cutoffEpoch,
        };
      });
    } finally {
      // Always DETACH even on rollback so the connection is clean for
      // subsequent reuse (the caller's db variable is local; this is
      // defense-in-depth against connection-pool reuse).
      try {
        db.exec("DETACH DATABASE archive");
      } catch {
        // Already detached on transaction rollback — swallow.
      }
    }
  } finally {
    closeDatabase(db);
  }
}
