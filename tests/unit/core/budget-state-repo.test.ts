// Unit tests for src/core/budget-state-repo.ts (ADR-169 P3).
//
// Strategy: hermetic temp dirs as synthetic atmux dirs; real
// bun:sqlite via the repo (no mocks — mirrors
// tests/unit/core/flags-repo.test.ts). Every public function +
// every fallback branch is exercised: row hits, legacy-file promotion
// with observed_at derivation, absent-everywhere nulls, and the
// clear-removes-legacy-file invariant.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import {
  BUDGET_PROBES,
  BUDGET_SCHEMA_VERSION,
  BudgetRepo,
  clearBudgetTextAtDb,
  importLegacyBudgetText,
  maxFireEpochObservedAtMs,
  readBudgetTextAtDb,
  teamBudgetDbPath,
  withBudgetDb,
  writeBudgetTextAtDb,
} from "../../../src/core/budget-state-repo.ts";

let root: string;
let atmuxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-budget-repo-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Observe stub: pausedAt-style payloads (used for budget-pause-shaped text). */
const observePausedAt = (text: string, fallbackMs: number): number => {
  const parsed: unknown = JSON.parse(text);
  const at = (parsed as Record<string, unknown>).pausedAt;
  return typeof at === "number" ? Math.floor(at * 1000) : fallbackMs;
};

describe("probe list + schema version", () => {
  test("probe list holds the 3 budget probes (ADR-169 OQ-3)", () => {
    expect([...BUDGET_PROBES]).toEqual([
      "budget-pause",
      "budget-refresh-soon-state",
      "budget-warning-state",
    ]);
  });

  test("schema version marker is 1", () => {
    expect(BUDGET_SCHEMA_VERSION).toBe(1);
  });

  test("teamBudgetDbPath appends state.db", () => {
    expect(teamBudgetDbPath("/x/.atmux")).toBe("/x/.atmux/state.db");
  });
});

describe("BudgetRepo CRUD", () => {
  test("get misses on empty table; set/get roundtrips observed_at; set overwrites", async () => {
    await withBudgetDb(teamBudgetDbPath(atmuxDir), (db) => {
      const repo = new BudgetRepo(db);
      expect(repo.get("budget-pause")).toBeNull();
      repo.set("budget-pause", '{"paused":true}', 1_700_000_000_000, 1000);
      expect(repo.get("budget-pause")).toEqual({
        state: '{"paused":true}',
        observedAt: 1_700_000_000_000,
      });
      repo.set("budget-pause", '{"paused":true}', 1_700_000_100_000, 2000);
      expect(repo.get("budget-pause")).toEqual({
        state: '{"paused":true}',
        observedAt: 1_700_000_100_000,
      });
      const row = db
        .query("SELECT updated_at, schema_version FROM budget WHERE probe_name = $probe")
        .get({ $probe: "budget-pause" }) as { updated_at: number; schema_version: number };
      expect(row.updated_at).toBe(2000);
      expect(row.schema_version).toBe(BUDGET_SCHEMA_VERSION);
    });
  });

  test("delete removes the row; no-op when absent", async () => {
    await withBudgetDb(teamBudgetDbPath(atmuxDir), (db) => {
      const repo = new BudgetRepo(db);
      repo.delete("budget-pause");
      expect(repo.get("budget-pause")).toBeNull();
      repo.set("budget-pause", "{}", 1, 1);
      repo.delete("budget-pause");
      expect(repo.get("budget-pause")).toBeNull();
    });
  });

  test("withBudgetDb returns the callback value", async () => {
    const out = await withBudgetDb(teamBudgetDbPath(atmuxDir), () => 42);
    expect(out).toBe(42);
  });
});

describe("maxFireEpochObservedAtMs", () => {
  test("returns max fire epoch × 1000", () => {
    expect(maxFireEpochObservedAtMs(JSON.stringify({ "a:5h:0.5": 100, "b:wk:0.25": 200 }), 9)).toBe(
      200_000,
    );
  });

  test("unparseable text → fallback", () => {
    expect(maxFireEpochObservedAtMs("not json{", 9)).toBe(9);
  });

  test("non-object roots → fallback", () => {
    expect(maxFireEpochObservedAtMs(JSON.stringify(["array"]), 9)).toBe(9);
    expect(maxFireEpochObservedAtMs(JSON.stringify(null), 9)).toBe(9);
  });

  test("empty map + non-numeric values → fallback", () => {
    expect(maxFireEpochObservedAtMs(JSON.stringify({}), 9)).toBe(9);
    expect(maxFireEpochObservedAtMs(JSON.stringify({ "a:5h:0.5": "soon" }), 9)).toBe(9);
    expect(maxFireEpochObservedAtMs(JSON.stringify({ "a:5h:0.5": Number.NaN }), 9)).toBe(9);
  });
});

describe("importLegacyBudgetText", () => {
  test("existing row wins; legacy file untouched", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, '{"from":"file"}');
    await withBudgetDb(teamBudgetDbPath(atmuxDir), async (db) => {
      const repo = new BudgetRepo(db);
      repo.set("budget-pause", '{"from":"row"}', 7, 7);
      expect(await importLegacyBudgetText(db, "budget-pause", legacy, observePausedAt, 8)).toBe(
        '{"from":"row"}',
      );
      expect(await readFile(legacy, "utf8")).toBe('{"from":"file"}');
    });
  });

  test("empty dedup map → updatedAtMs as observed_at (nothing observed yet)", async () => {
    const legacy = join(atmuxDir, "state", "budget-warning-state.json");
    await writeFile(legacy, JSON.stringify({}));
    await withBudgetDb(teamBudgetDbPath(atmuxDir), async (db) => {
      expect(
        await importLegacyBudgetText(
          db,
          "budget-warning-state",
          legacy,
          maxFireEpochObservedAtMs,
          9,
        ),
      ).toBe(JSON.stringify({}));
      expect(new BudgetRepo(db).get("budget-warning-state")).toEqual({
        state: JSON.stringify({}),
        observedAt: 9,
      });
    });
  });
  test("absent row + present file → promotes content + derived observed_at", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, JSON.stringify({ paused: true, pausedAt: 1_700_000_000 }));
    await withBudgetDb(teamBudgetDbPath(atmuxDir), async (db) => {
      expect(await importLegacyBudgetText(db, "budget-pause", legacy, observePausedAt, 9)).toBe(
        JSON.stringify({ paused: true, pausedAt: 1_700_000_000 }),
      );
      expect(new BudgetRepo(db).get("budget-pause")).toEqual({
        state: JSON.stringify({ paused: true, pausedAt: 1_700_000_000 }),
        observedAt: 1_700_000_000_000,
      });
    });
  });

  test("absent row + absent file → null", async () => {
    await withBudgetDb(teamBudgetDbPath(atmuxDir), async (db) => {
      expect(
        await importLegacyBudgetText(
          db,
          "budget-pause",
          join(atmuxDir, "state", "nope.json"),
          observePausedAt,
          9,
        ),
      ).toBeNull();
    });
  });
});

describe("readBudgetTextAtDb", () => {
  test("no DB yet + legacy file → file content, DB not created", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, '{"a":1}');
    const dbPath = teamBudgetDbPath(atmuxDir);
    expect(await readBudgetTextAtDb(dbPath, "budget-pause", legacy, observePausedAt)).toBe(
      '{"a":1}',
    );
    expect(await exists(dbPath)).toBe(false);
  });

  test("no DB + no file → null", async () => {
    expect(
      await readBudgetTextAtDb(
        teamBudgetDbPath(atmuxDir),
        "budget-pause",
        join(atmuxDir, "state", "nope.json"),
        observePausedAt,
      ),
    ).toBeNull();
  });

  test("DB row wins over legacy file", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, '{"from":"file"}');
    const dbPath = teamBudgetDbPath(atmuxDir);
    await writeBudgetTextAtDb(dbPath, "budget-pause", '{"from":"row"}', 3);
    expect(await readBudgetTextAtDb(dbPath, "budget-pause", legacy, observePausedAt)).toBe(
      '{"from":"row"}',
    );
  });

  test("DB present + no row + legacy file → promotes and returns", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, '{"from":"file"}');
    const dbPath = teamBudgetDbPath(atmuxDir);
    await writeBudgetTextAtDb(dbPath, "budget-warning-state", "{}", 3);
    expect(await readBudgetTextAtDb(dbPath, "budget-pause", legacy, observePausedAt)).toBe(
      '{"from":"file"}',
    );
    await withBudgetDb(dbPath, (db) => {
      expect(new BudgetRepo(db).get("budget-pause")?.state).toBe('{"from":"file"}');
    });
  });

  test("DB present + neither → null", async () => {
    const dbPath = teamBudgetDbPath(atmuxDir);
    await writeBudgetTextAtDb(dbPath, "budget-warning-state", "{}", 3);
    expect(
      await readBudgetTextAtDb(
        dbPath,
        "budget-pause",
        join(atmuxDir, "state", "nope.json"),
        observePausedAt,
      ),
    ).toBeNull();
  });
});

describe("writeBudgetTextAtDb / clearBudgetTextAtDb", () => {
  test("write creates the DB + row with default clock", async () => {
    const dbPath = teamBudgetDbPath(atmuxDir);
    await writeBudgetTextAtDb(dbPath, "budget-pause", "{}", 11);
    await withBudgetDb(dbPath, (db) => {
      expect(new BudgetRepo(db).get("budget-pause")).toEqual({ state: "{}", observedAt: 11 });
    });
  });

  test("clear removes row + leftover legacy file", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, '{"stale":true}');
    const dbPath = teamBudgetDbPath(atmuxDir);
    await writeBudgetTextAtDb(dbPath, "budget-pause", '{"fresh":true}', 3);
    await clearBudgetTextAtDb(dbPath, "budget-pause", legacy);
    expect(await exists(legacy)).toBe(false);
    await withBudgetDb(dbPath, (db) => {
      expect(new BudgetRepo(db).get("budget-pause")).toBeNull();
    });
  });

  test("clear with no DB still removes a legacy file", async () => {
    const legacy = join(atmuxDir, "state", "budget-pause.json");
    await writeFile(legacy, '{"stale":true}');
    await clearBudgetTextAtDb(teamBudgetDbPath(atmuxDir), "budget-pause", legacy);
    expect(await exists(legacy)).toBe(false);
  });

  test("clear idempotent when both sides absent", async () => {
    await clearBudgetTextAtDb(
      teamBudgetDbPath(atmuxDir),
      "budget-pause",
      join(atmuxDir, "state", "nope.json"),
    );
  });
});
