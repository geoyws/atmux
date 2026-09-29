// ADR-169 §Decision (role_state table, P2 — EPIC e-38ee9939):
// repository over the `role_state` table
// (`role, namespace, payload, updated_at, schema_version`).
// Per-role tracking files fold into one table in the team's
// `<atmuxDir>/state.db`:
//
//   - role-scoped: `cost-<member>.json` → (`<member>`, `cost`),
//     `modal-history-<member>.json` → (`<member>`, `modal-history`).
//   - team-scoped (sentinel `role='_'`): `heads-up-cursor`,
//     `brief-versions`, `ombudsman-pending`.
//
// SQL is owned here (mirrors `core/flags-repo.ts`); core modules see
// a text-blob surface and keep their own parsing so each file's
// corruption posture (strict SchemaError vs loose fallback) is
// unchanged by the move.
//
// Transition semantics (P1 idiom): readers are row-first with a
// one-time legacy import — when the row is absent but the
// pre-migration JSON file is still on disk, the file's content is
// promoted into the table and returned. Writers are table-only.
// The `migrate-state --target=role-state` verb archives the promoted
// sources; until it runs, deployment-edge teams keep working off
// their JSON files.
//
// Out of scope: `modal-cycling-dedup-state.json` (not enumerated in
// ADR-169 §Context — stays a JSON file) and the budget files
// (`budget` table owns those exclusively per ADR-169 OQ-3, P3).

import { dirname, join } from "node:path";
import { ensureDir, exists, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";

/** Per-row forward-compat marker (ADR-169 OQ-2). All rows write 1. */
export const ROLE_STATE_SCHEMA_VERSION = 1;

/** Sentinel role for team-scoped namespaces (ADR-169 §Decision). */
export const TEAM_ROLE_STATE = "_";

/** Role-scoped namespaces (one row per member). */
export const COST_NAMESPACE = "cost";
export const MODAL_HISTORY_NAMESPACE = "modal-history";

/** Team-scoped namespaces (one row each under `TEAM_ROLE_STATE`). */
export const TEAM_ROLE_STATE_FILES = [
  "heads-up-cursor",
  "brief-versions",
  "ombudsman-pending",
] as const;

/** Resolve the team-scope role_state DB. */
export function teamRoleStateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

/** Typed CRUD surface over `role_state`. Construct per open DB handle —
 *  callers that need lifecycle management use `withRoleStateDb`. */
export class RoleStateRepo {
  constructor(private readonly db: Database) {}

  /** Raw blob for `(role, namespace)`, or null when no row exists. */
  get(role: string, namespace: string): string | null {
    const row = this.db
      .query("SELECT payload FROM role_state WHERE role = $role AND namespace = $namespace")
      .get({ $role: role, $namespace: namespace }) as { payload: string } | null;
    return row?.payload ?? null;
  }

  /** Upsert the blob (ADR-169 OQ-5 — matches the kanban migration). */
  set(role: string, namespace: string, payload: string, updatedAtMs: number): void {
    this.db
      .query(
        `INSERT INTO role_state (role, namespace, payload, updated_at, schema_version)
         VALUES ($role, $namespace, $payload, $updated_at, $schema_version)
         ON CONFLICT(role, namespace) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           schema_version = excluded.schema_version`,
      )
      .run({
        $role: role,
        $namespace: namespace,
        $payload: payload,
        $updated_at: updatedAtMs,
        $schema_version: ROLE_STATE_SCHEMA_VERSION,
      });
  }

  /** Delete the row. No-op when absent. */
  delete(role: string, namespace: string): void {
    this.db
      .query("DELETE FROM role_state WHERE role = $role AND namespace = $namespace")
      .run({ $role: role, $namespace: namespace });
  }

  /** All `(role, payload)` rows under one namespace. */
  list(namespace: string): Array<{ role: string; payload: string }> {
    return this.db
      .query("SELECT role, payload FROM role_state WHERE namespace = $namespace")
      .all({ $namespace: namespace }) as Array<{ role: string; payload: string }>;
  }
}

/** Open the role_state DB at `dbPath` (creating + migrating on first open),
 *  run `fn`, then close. Parent dirs are created lazily so writers work
 *  on fresh teams without a prior `ensureDir` at the call site. */
export async function withRoleStateDb<T>(
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
export async function importLegacyRoleText(
  db: Database,
  role: string,
  namespace: string,
  legacyPath: string,
  updatedAtMs: number,
): Promise<string | null> {
  const repo = new RoleStateRepo(db);
  const existing = repo.get(role, namespace);
  if (existing !== null) return existing;
  const text = await readTextOrNull(legacyPath);
  if (text === null) return null;
  repo.set(role, namespace, text, updatedAtMs);
  return text;
}

/**
 * Read a role_state blob without creating the DB. Teams that never wrote
 * role state (no `state.db` yet) read straight from the legacy file —
 * keeps read-only probes side-effect free.
 */
export async function readRoleTextAtDb(
  dbPath: string,
  role: string,
  namespace: string,
  legacyPath: string,
  updatedAtMs: number = now(),
): Promise<string | null> {
  if (!(await exists(dbPath))) return readTextOrNull(legacyPath);
  return withRoleStateDb(dbPath, (db) =>
    importLegacyRoleText(db, role, namespace, legacyPath, updatedAtMs),
  );
}

/** Table-only write (creates + migrates the DB on first write). A stale
 *  legacy file left on disk is harmless — readers prefer the row. */
export async function writeRoleTextAtDb(
  dbPath: string,
  role: string,
  namespace: string,
  payload: string,
  updatedAtMs: number = now(),
): Promise<void> {
  await withRoleStateDb(dbPath, (db) => {
    new RoleStateRepo(db).set(role, namespace, payload, updatedAtMs);
  });
}

/**
 * Table-only clear that also removes a leftover legacy file. The file
 * removal is load-bearing, not hygiene: without it the row-first
 * reader would resurrect cleared state from a pre-migration file.
 * Idempotent — absence on both sides is fine.
 */
export async function clearRoleTextAtDb(
  dbPath: string,
  role: string,
  namespace: string,
  legacyPath: string,
): Promise<void> {
  if (await exists(dbPath)) {
    await withRoleStateDb(dbPath, (db) => {
      new RoleStateRepo(db).delete(role, namespace);
    });
  }
  await removeFile(legacyPath);
}
