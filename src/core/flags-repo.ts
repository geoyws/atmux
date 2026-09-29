// ADR-169 §Decision (flags table, P1 — EPIC e-38ee9939): repository over
// the `flags` table (`key, value, updated_at, schema_version`). Six
// single-row JSON toggles fold into one table per DB scope (ADR-169
// OQ-3: budget files live in the future `budget` table exclusively,
// never in `flags`):
//
//   - team scope (`<atmuxDir>/state.db`): paused, resume,
//     eternal-improvement, whip-config-drift-state.
//   - cockpit scope (`~/.atmux/state.db`): pulse-state, sentinel-state.
//
// SQL is owned here (mirrors `core/repositories/kanban-repo.ts`); core
// modules see a text-blob surface and keep their own Zod parsing so
// each flag's corruption posture (strict SchemaError vs loose
// fallback) is unchanged by the move.
//
// Transition semantics: readers are row-first with a one-time legacy
// import — when the row is absent but the pre-migration JSON file is
// still on disk, the file's content is promoted into the table and
// returned. Writers and clears are table-only, except that clear also
// removes a leftover legacy file so the fallback cannot resurrect
// cleared state. The `migrate-state --target=flags` verb archives the
// promoted sources; until it runs, deployment-edge teams keep working
// off their JSON files.

import { dirname, join } from "node:path";
import { ensureDir, exists, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";

/** Per-row forward-compat marker (ADR-169 OQ-2). All rows write 1. */
export const FLAGS_SCHEMA_VERSION = 1;

/** Flags keys resident in the TEAM `<atmuxDir>/state.db`. */
export const TEAM_FLAG_FILES = [
  "paused",
  "resume",
  "eternal-improvement",
  "whip-config-drift-state",
] as const;

/** Flags keys resident in the COCKPIT `~/.atmux/state.db`. */
export const COCKPIT_FLAG_FILES = ["pulse-state", "sentinel-state"] as const;

/** Resolve the cockpit-scope flags DB from a home directory. */
export function cockpitFlagsDbPath(home: string): string {
  return join(home, ".atmux", "state.db");
}

/** Resolve the cockpit-scope flags DB from a legacy state-file path
 *  (`<home>/.atmux/state/<name>.json` → `<home>/.atmux/state.db`). */
export function cockpitDbPathForStateFile(stateFilePath: string): string {
  return join(dirname(dirname(stateFilePath)), "state.db");
}

/** Typed CRUD surface over `flags`. Construct per open DB handle —
 *  callers that need lifecycle management use `withFlagsDb`. */
export class FlagsRepo {
  constructor(private readonly db: Database) {}

  /** Raw blob for `key`, or null when no row exists. */
  get(key: string): string | null {
    const row = this.db.query("SELECT value FROM flags WHERE key = $key").get({ $key: key }) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  /** Upsert the blob (ADR-169 OQ-5 — matches the kanban migration). */
  set(key: string, value: string, updatedAtMs: number): void {
    this.db
      .query(
        `INSERT INTO flags (key, value, updated_at, schema_version)
         VALUES ($key, $value, $updated_at, $schema_version)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           schema_version = excluded.schema_version`,
      )
      .run({
        $key: key,
        $value: value,
        $updated_at: updatedAtMs,
        $schema_version: FLAGS_SCHEMA_VERSION,
      });
  }

  /** Delete the row. No-op when absent. */
  delete(key: string): void {
    this.db.query("DELETE FROM flags WHERE key = $key").run({ $key: key });
  }
}

/** Open the flags DB at `dbPath` (creating + migrating on first open),
 *  run `fn`, then close. Parent dirs are created lazily so writers work
 *  on fresh teams without a prior `ensureDir` at the call site. */
export async function withFlagsDb<T>(
  dbPath: string,
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  await ensureDir(dirname(dbPath));
  const db = openDatabase(dbPath, migrations);
  try {
    return await fn(db);
  } finally {
    closeDatabase(db);
  }
}

/**
 * Row-first read with one-time legacy import. Returns the row blob when
 * present; otherwise, when the pre-migration JSON file still exists,
 * promotes its content into the table (so the next read is table-only)
 * and returns it; null when neither exists.
 */
export async function importLegacyFlagText(
  db: Database,
  key: string,
  legacyPath: string,
  updatedAtMs: number,
): Promise<string | null> {
  const repo = new FlagsRepo(db);
  const existing = repo.get(key);
  if (existing !== null) return existing;
  const text = await readTextOrNull(legacyPath);
  if (text === null) return null;
  repo.set(key, text, updatedAtMs);
  return text;
}

/**
 * Read a flag blob without creating the DB. Teams that never wrote a
 * flag (no `state.db` yet) read straight from the legacy file — keeps
 * read-only probes (doctor, dispatch gates) side-effect free.
 */
export async function readFlagTextAtDb(
  dbPath: string,
  key: string,
  legacyPath: string,
  updatedAtMs: number = now(),
): Promise<string | null> {
  if (!(await exists(dbPath))) return readTextOrNull(legacyPath);
  return withFlagsDb(dbPath, (db) => importLegacyFlagText(db, key, legacyPath, updatedAtMs));
}

/** Table-only write (creates + migrates the DB on first write). A stale
 *  legacy file left on disk is harmless — readers prefer the row. */
export async function writeFlagTextAtDb(
  dbPath: string,
  key: string,
  value: string,
  updatedAtMs: number = now(),
): Promise<void> {
  await withFlagsDb(dbPath, (db) => {
    new FlagsRepo(db).set(key, value, updatedAtMs);
  });
}

/**
 * Table-only clear that also removes a leftover legacy file. The file
 * removal is load-bearing, not hygiene: without it the row-first
 * reader would resurrect cleared state from a pre-migration file.
 * Idempotent — absence on both sides is fine.
 */
export async function clearFlagTextAtDb(
  dbPath: string,
  key: string,
  legacyPath: string,
): Promise<void> {
  if (await exists(dbPath)) {
    await withFlagsDb(dbPath, (db) => {
      new FlagsRepo(db).delete(key);
    });
  }
  await removeFile(legacyPath);
}
