// ADR-060 §D2: bun:sqlite wrapper. Single canonical entry point for
// opening + migrating + transacting a `.atmux/state.db` SQLite file.
//
// Keep this module thin: it owns DB lifecycle (open + WAL config +
// migration apply + close) and exposes a `Database` handle plus a
// transaction helper. Repository modules (`src/core/repositories/*`)
// own the SQL strings + Zod-row-bridge. Verbs talk to repositories,
// not to this module directly.
//
// WAL mode + 5s busy-timeout is mandatory per ADR-060 §D10 — readers
// don't block writers, writes serialize, multi-process opens are safe.

import { Database } from "bun:sqlite";

export type { Database };

/** Schema migration: bump `user_version` from `from` to `to`. */
export interface Migration {
  from: number;
  to: number;
  up: (db: Database) => void;
}

/**
 * Open a SQLite DB at the given path, configure WAL + busy-timeout,
 * and run any pending migrations. Idempotent.
 *
 * @param path Filesystem path (parent dir must exist).
 * @param migrations Ordered migration ladder; `from === user_version`
 *                   then run `up` and bump to `to`.
 */
export function openDatabase(path: string, migrations: readonly Migration[]): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  let current = readUserVersion(db);
  for (const m of migrations) {
    if (m.from < current) continue;
    if (m.from !== current) {
      throw new Error(
        `migration gap: db at user_version=${current}, next migration starts at from=${m.from}`,
      );
    }
    db.transaction(() => {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.to}`);
    })();
    current = m.to;
  }

  return db;
}

/** Read the current `user_version` PRAGMA. */
export function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

/**
 * Wrap a function in a transaction. Returns the function's return value;
 * rolls back on throw. Thin wrapper over `db.transaction()` for callers
 * that want a typed return.
 */
export function transact<T>(db: Database, fn: () => T): T {
  let result!: T;
  db.transaction(() => {
    result = fn();
  })();
  return result;
}

/**
 * Wrap a function in an IMMEDIATE-mode transaction — acquires the
 * write lock at BEGIN time rather than at first write. Required by
 * ADR-134 §state-machine + the ADR-091 reviewer pre-flag audit §3 for
 * the merger state transitions: when the event-driven path and the
 * cron backstop fire concurrently on the same `<base>-<member>`, the
 * second BEGIN IMMEDIATE waits on the busy_timeout for the first to
 * commit + then sees the post-transition state. DEFERRED (the
 * `transact` default) would let both reads escape the lock and race
 * a double-write.
 *
 * bun:sqlite's wrapped-function form exposes `.immediate()` for this
 * mode — call THAT (not the default closure) to get
 * `BEGIN IMMEDIATE` instead of `BEGIN`. Rolls back on throw.
 */
export function transactImmediate<T>(db: Database, fn: () => T): T {
  let result!: T;
  db.transaction(() => {
    result = fn();
  }).immediate();
  return result;
}

/** Close DB and flush WAL. Call from verb teardown / test cleanup. */
export function closeDatabase(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
