// ADR-169 §Decision (budget table, P3 — EPIC e-38ee9939): repository over
// the `budget` table
// (`probe_name, observed_at, state, updated_at, schema_version`). The 3
// whip budget files fold into one table in the team's
// `<atmuxDir>/state.db` (team scope — NOT the ADR-270 global
// `~/.atmux/state/budget.db`, which is a per-operator usage time-series
// for `atmux budget collect|report`; whip pause/warning dedup state is
// per-team, so it lives with the team's flags/role_state rows):
//
//   - `budget-pause` ← `budget-pause.json`
//     (observed_at = `pausedAt` × 1000 per ADR-169 §Decision)
//   - `budget-warning-state` ← `budget-warning-state.json`
//     (observed_at = max fire epoch × 1000)
//   - `budget-refresh-soon-state` ← `budget-refresh-soon-state.json`
//     (observed_at = max fire epoch × 1000)
//
// SQL is owned here (mirrors `core/flags-repo.ts`); core modules see
// a text-blob surface and keep their own parsing so each file's
// corruption posture (strict null vs loose re-arm) is unchanged by
// the move.
//
// Transition semantics (P1/P2 idiom): readers are row-first with a
// one-time legacy import — when the row is absent but the
// pre-migration JSON file is still on disk, the file's content is
// promoted into the table and returned. Writers are table-only.
// The `migrate-state --target=budget` verb archives the promoted
// sources; until it runs, deployment-edge teams keep working off
// their JSON files.

import { dirname } from "node:path";
import { ensureDir, exists, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";

/** Per-row forward-compat marker (ADR-169 OQ-2). All rows write 1. */
export const BUDGET_SCHEMA_VERSION = 1;

/** Budget probes resident in the TEAM `<atmuxDir>/state.db` (ADR-169 OQ-3). */
export const BUDGET_PROBES = [
  "budget-pause",
  "budget-refresh-soon-state",
  "budget-warning-state",
] as const;

/** One row per source file; `probe_name` = file basename without `.json`. */
export type BudgetProbe = (typeof BUDGET_PROBES)[number];

/** One budget row: the TEXT-blob state plus its queryable timestamp. */
export interface BudgetRow {
  state: string;
  observedAt: number;
}

/** Typed CRUD surface over `budget`. Construct per open DB handle —
 *  callers that need lifecycle management use `withBudgetDb`. */
export class BudgetRepo {
  constructor(private readonly db: Database) {}

  /** Row for `probe`, or null when no row exists. */
  get(probe: string): BudgetRow | null {
    const row = this.db
      .query("SELECT state, observed_at FROM budget WHERE probe_name = $probe")
      .get({ $probe: probe }) as { state: string; observed_at: number } | null;
    if (row === null) return null;
    return { state: row.state, observedAt: row.observed_at };
  }

  /** Upsert the row (ADR-169 OQ-5 — matches the kanban migration). */
  set(probe: string, state: string, observedAtMs: number, updatedAtMs: number): void {
    this.db
      .query(
        `INSERT INTO budget (probe_name, observed_at, state, updated_at, schema_version)
         VALUES ($probe, $observed_at, $state, $updated_at, $schema_version)
         ON CONFLICT(probe_name) DO UPDATE SET
           observed_at = excluded.observed_at,
           state = excluded.state,
           updated_at = excluded.updated_at,
           schema_version = excluded.schema_version`,
      )
      .run({
        $probe: probe,
        $observed_at: observedAtMs,
        $state: state,
        $updated_at: updatedAtMs,
        $schema_version: BUDGET_SCHEMA_VERSION,
      });
  }

  /** Delete the row. No-op when absent. */
  delete(probe: string): void {
    this.db.query("DELETE FROM budget WHERE probe_name = $probe").run({ $probe: probe });
  }
}

/** Open the budget DB at `dbPath` (creating + migrating on first open),
 *  run `fn`, then close. Parent dirs are created lazily so writers work
 *  on fresh teams without a prior `ensureDir` at the call site. */
export async function withBudgetDb<T>(
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
 * Shared `observed_at` extractor for the two fire-epoch dedup maps
 * (`budget-warning-state`, `budget-refresh-soon-state`): the max
 * fire-epoch value × 1000. Falls back to `fallbackMs` when the text
 * is unparseable or carries no finite numeric value (empty map —
 * nothing was ever observed).
 */
export function maxFireEpochObservedAtMs(text: string, fallbackMs: number): number {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallbackMs;
    let max: number | null = null;
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && (max === null || v > max)) max = v;
    }
    return max === null ? fallbackMs : Math.floor(max * 1000);
  } catch {
    return fallbackMs;
  }
}

/**
 * Row-first read with one-time legacy import. Returns the row blob when
 * present; otherwise, when the pre-migration JSON file still exists,
 * promotes its content into the table (so the next read is table-only)
 * and returns it; null when neither exists. `observe` derives
 * `observed_at` from the raw text (ADR-169 §Decision), falling back to
 * `updatedAtMs` when the payload carries no timestamp.
 */
export async function importLegacyBudgetText(
  db: Database,
  probe: string,
  legacyPath: string,
  observe: (text: string, fallbackMs: number) => number,
  updatedAtMs: number,
): Promise<string | null> {
  const repo = new BudgetRepo(db);
  const existing = repo.get(probe);
  if (existing !== null) return existing.state;
  const text = await readTextOrNull(legacyPath);
  if (text === null) return null;
  repo.set(probe, text, observe(text, updatedAtMs), updatedAtMs);
  return text;
}

/**
 * Read a budget blob without creating the DB. Teams that never wrote
 * budget state (no `state.db` yet) read straight from the legacy file —
 * keeps read-only probes side-effect free.
 */
export async function readBudgetTextAtDb(
  dbPath: string,
  probe: string,
  legacyPath: string,
  observe: (text: string, fallbackMs: number) => number,
  updatedAtMs: number = now(),
): Promise<string | null> {
  if (!(await exists(dbPath))) return readTextOrNull(legacyPath);
  return withBudgetDb(dbPath, (db) =>
    importLegacyBudgetText(db, probe, legacyPath, observe, updatedAtMs),
  );
}

/** Table-only write (creates + migrates the DB on first write). A stale
 *  legacy file left on disk is harmless — readers prefer the row. */
export async function writeBudgetTextAtDb(
  dbPath: string,
  probe: string,
  value: string,
  observedAtMs: number,
  updatedAtMs: number = now(),
): Promise<void> {
  await withBudgetDb(dbPath, (db) => {
    new BudgetRepo(db).set(probe, value, observedAtMs, updatedAtMs);
  });
}

/**
 * Table-only clear that also removes a leftover legacy file. The file
 * removal is load-bearing, not hygiene: without it the row-first
 * reader would resurrect cleared state from a pre-migration file.
 * Idempotent — absence on both sides is fine.
 */
export async function clearBudgetTextAtDb(
  dbPath: string,
  probe: string,
  legacyPath: string,
): Promise<void> {
  if (await exists(dbPath)) {
    await withBudgetDb(dbPath, (db) => {
      new BudgetRepo(db).delete(probe);
    });
  }
  await removeFile(legacyPath);
}
