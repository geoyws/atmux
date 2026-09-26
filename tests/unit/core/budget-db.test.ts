// Unit tests for e-50 T2 usage_snapshot schema (t-114d9f8e):
//   - budgetMigrations apply on a fresh file (table + indexes + v1)
//   - withBudgetDb creates ~/.atmux/state/budget.db under a temp home
//   - budgetDbPath throws ConfigError without HOME
//   - reopen is idempotent; rows round-trip

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { budgetMigrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { budgetDbPath, withBudgetDb } from "../../../src/core/budget-db.ts";
import { ConfigError } from "../../../src/errors.ts";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atmux-budget-db-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("budgetMigrations", () => {
  test("fresh file gains usage_snapshot + indexes at v1", async () => {
    const dbPath = join(home, "budget.db");
    const db = openDatabase(dbPath, budgetMigrations);
    try {
      const ver = db.query("PRAGMA user_version").get() as { user_version: number };
      expect(ver.user_version).toBe(1);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>;
      expect(tables.map((t) => t.name)).toContain("usage_snapshot");
      const idx = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>;
      const names = idx.map((i) => i.name);
      expect(names).toContain("idx_usage_ts");
      expect(names).toContain("idx_usage_pa");
    } finally {
      closeDatabase(db);
    }
  });

  test("snapshot rows round-trip", async () => {
    await withBudgetDb(async (db) => {
      db.query(
        `INSERT INTO usage_snapshot (ts, provider, account, metric, value, unit, ok)
         VALUES ('2026-07-31T00:00:00Z', 'deepseek', 'deepseek', 'balance_usd', 12.5, 'usd', 1)`,
      ).run();
    }, { home });
    await withBudgetDb(async (db) => {
      const rows = db.query("SELECT provider, value FROM usage_snapshot").all() as Array<{
        provider: string;
        value: number;
      }>;
      expect(rows).toEqual([{ provider: "deepseek", value: 12.5 }]);
    }, { home });
  });
});

describe("budgetDbPath", () => {
  test("resolves under home/.atmux/state", () => {
    expect(budgetDbPath({ home })).toBe(join(home, ".atmux", "state", "budget.db"));
  });

  test("throws ConfigError without HOME", () => {
    expect(() => budgetDbPath({ env: {} })).toThrow(ConfigError);
  });

  test("withBudgetDb creates the file on first open", async () => {
    expect(await exists(join(home, ".atmux", "state", "budget.db"))).toBe(false);
    await withBudgetDb(async () => {}, { home });
    expect(await exists(join(home, ".atmux", "state", "budget.db"))).toBe(true);
  });
});
