// e-50 T2 (t-114d9f8e): cockpit-global budget database opener.
//
// `~/.atmux/state/budget.db` holds per-operator usage snapshots
// (docs/briefs/budget-tracker.md) — separate file + separate ladder
// (`budgetMigrations`) from the per-team state.db. Created on first
// `collect`; migrations apply on open (idempotent).

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { ensureDir } from "../abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { budgetMigrations } from "../abstractions/sqlite-migrations.ts";
import { ConfigError } from "../errors.ts";

export interface BudgetDbPathOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Resolve `~/.atmux/state/budget.db`. Throws ConfigError when HOME
 *  is unresolvable (mirrors pulse-state path contract). */
export function budgetDbPath(opts: BudgetDbPathOpts = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME;
  if (home === undefined || home.length === 0) {
    throw new ConfigError({
      what: "cannot resolve budget.db path: HOME unset",
      hint: "set $HOME or pass `home` opt for tests",
    });
  }
  return join(home, ".atmux", "state", "budget.db");
}

/** Ensure the state dir exists, open the DB (migrations apply on
 *  open, idempotent), run `fn`, close. */
export async function withBudgetDb<T>(
  fn: (db: Database) => T | Promise<T>,
  opts: BudgetDbPathOpts = {},
): Promise<T> {
  const path = budgetDbPath(opts);
  await ensureDir(join(path, ".."));
  const db = openDatabase(path, budgetMigrations);
  try {
    return await fn(db);
  } finally {
    closeDatabase(db);
  }
}
