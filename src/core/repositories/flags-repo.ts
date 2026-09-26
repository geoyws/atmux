// e-38 P1 (t-62feffe0): typed CRUD over the `state_kv` table
// (sqlite-migrations v1: feature/key/value-JSON/updated_at) for the
// single-row toggle files (paused, resume, budget-*, pulse, sentinel,
// eternal-improvement, whip-config-drift). SQL is owned here; core
// toggle modules see get/set/delete/list and keep their domain types.
// Mirrors core/repositories/kanban-repo.ts conventions (snake_case
// columns, sync methods, constructor-injected Database).

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { exists } from "../../abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";

interface FlagsRow {
  feature: string;
  key: string;
  value: string;
  updated_at: number;
}

export class FlagsRepo {
  constructor(private db: Database) {}

  get(feature: string, key: string): unknown | null {
    const row = this.db
      .query(`SELECT value FROM state_kv WHERE feature = $feature AND key = $key`)
      .get({ $feature: feature, $key: key }) as Pick<FlagsRow, "value"> | null;
    if (row === null) return null;
    return JSON.parse(row.value) as unknown;
  }

  set(feature: string, key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO state_kv (feature, key, value, updated_at)
         VALUES ($feature, $key, $value, $now)
         ON CONFLICT (feature, key) DO UPDATE SET value = $value, updated_at = $now`,
      )
      .run({
        $feature: feature,
        $key: key,
        $value: JSON.stringify(value),
        $now: Date.now(),
      });
  }

  delete(feature: string, key: string): void {
    this.db
      .query(`DELETE FROM state_kv WHERE feature = $feature AND key = $key`)
      .run({ $feature: feature, $key: key });
  }

  /** Whole feature namespace as key→parsed-value. Empty object when absent. */
  list(feature: string): Record<string, unknown> {
    const rows = this.db
      .query(`SELECT key, value FROM state_kv WHERE feature = $feature`)
      .all({ $feature: feature }) as Pick<FlagsRow, "key" | "value">[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value) as unknown;
    return out;
  }

  /** Replace a whole namespace: delete keys absent from `map`, set the rest. */
  replace(feature: string, map: Record<string, unknown>): void {
    const current = this.list(feature);
    for (const k of Object.keys(current)) {
      if (!(k in map)) this.delete(feature, k);
    }
    for (const [k, v] of Object.entries(map)) this.set(feature, k, v);
  }
}

/** True when `<atmuxDir>/state.db` exists — the kv path is canonical. */
export async function flagsDbPresent(atmuxDir: string): Promise<boolean> {
  return exists(join(atmuxDir, "state.db"));
}

/** Open DB (migrations apply on open, idempotent), run `fn`, close. */
export async function withFlags<T>(
  atmuxDir: string,
  fn: (repo: FlagsRepo) => T | Promise<T>,
): Promise<T> {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    return await fn(new FlagsRepo(db));
  } finally {
    closeDatabase(db);
  }
}
