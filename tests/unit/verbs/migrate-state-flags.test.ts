// Unit tests for e-38 P1 flags migration (t-62feffe0):
//   - FlagsRepo CRUD + replace over state_kv (real DB, temp dir)
//   - pause.ts dual-path: kv writes when state.db present, JSON otherwise,
//     legacy merge on load
//   - migrate-state --target=state: legacy toggle JSONs → state_kv,
//     archive moves, audit record, dry-run writes nothing
//
// Strategy mirrors tests/unit/verbs/migrate-state.test.ts: per-test
// tmpdir as `.atmux/`, real bun:sqlite, SELECT to verify. No mocks.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { isPaused, loadPausedMap, pauseMember, resumeMember } from "../../../src/core/pause.ts";
import { FlagsRepo } from "../../../src/core/repositories/flags-repo.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { migrateState } from "../../../src/verbs/migrate-state.ts";

let root = "";
let atmuxDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-flags-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    log: (m) => lines.push(`LOG ${m}`),
    ok: (m) => lines.push(`OK ${m}`),
    warn: (m) => lines.push(`WARN ${m}`),
    err: (m) => lines.push(`ERR ${m}`),
  };
  return { logger, lines };
}

describe("FlagsRepo", () => {
  test("set/get/list/delete/replace round-trip", async () => {
    const dbPath = join(atmuxDir, "state.db");
    const db = openDatabase(dbPath, migrations);
    try {
      const repo = new FlagsRepo(db);
      expect(repo.get("pause", "driver")).toBeNull();
      repo.set("pause", "driver", { at: 1, reason: "manual" });
      expect(repo.get("pause", "driver")).toEqual({ at: 1, reason: "manual" });
      repo.set("pause", "lead", { at: 2, reason: "x" });
      expect(repo.list("pause")).toEqual({
        driver: { at: 1, reason: "manual" },
        lead: { at: 2, reason: "x" },
      });
      repo.replace("pause", { lead: { at: 3, reason: "y" } });
      expect(repo.list("pause")).toEqual({ lead: { at: 3, reason: "y" } });
      repo.delete("pause", "lead");
      expect(repo.list("pause")).toEqual({});
    } finally {
      closeDatabase(db);
    }
  });
});

describe("pause dual-path", () => {
  test("no state.db → legacy JSON path unchanged", async () => {
    await pauseMember(atmuxDir, "driver", { reason: "t", nowEpochSec: 7 });
    expect(await isPaused(atmuxDir, "driver")).toBe(true);
    expect(await exists(join(atmuxDir, "state.db"))).toBe(false);
    expect(await exists(join(atmuxDir, "state", "paused.json"))).toBe(true);
  });

  test("state.db present → kv canonical, legacy merges underneath", async () => {
    // Legacy row written pre-migration.
    await pauseMember(atmuxDir, "legacy-member", { reason: "old", nowEpochSec: 1 });
    // Creating state.db flips the canonical path (migrations on open).
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await pauseMember(atmuxDir, "kv-member", { reason: "new", nowEpochSec: 2 });
    const map = await loadPausedMap(atmuxDir);
    expect(map["legacy-member"]).toEqual({ at: 1, reason: "old" });
    expect(map["kv-member"]).toEqual({ at: 2, reason: "new" });
    await resumeMember(atmuxDir, "kv-member");
    expect(await isPaused(atmuxDir, "kv-member")).toBe(false);
    // Legacy row still visible (modules never archive; verb does).
    expect(await isPaused(atmuxDir, "legacy-member")).toBe(true);
  });
});

describe("migrate-state --target=state", () => {
  test("imports toggle JSONs to state_kv + archives sources + audit", async () => {
    await writeFile(
      join(atmuxDir, "state", "paused.json"),
      JSON.stringify({ driver: { at: 1, reason: "manual" } }),
    );
    await writeFile(join(atmuxDir, "state", "budget-warning-state.json"), JSON.stringify({ a: 5 }));
    const { logger } = makeLogger();
    const out: string[] = [];
    const code = await migrateState(
      ["json-to-sqlite", "--target=state", "--team-dir", atmuxDir],
      { logger, stdout: (m) => out.push(m) },
    );
    expect(code).toBe(0);
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new FlagsRepo(db);
      expect(repo.get("pause", "driver")).toEqual({ at: 1, reason: "manual" });
      expect(repo.get("budget-warning", "a")).toBe(5);
    } finally {
      closeDatabase(db);
    }
    // Sources archived, audit written.
    expect(await exists(join(atmuxDir, "state", "paused.json"))).toBe(false);
    expect(await exists(join(atmuxDir, "migration-state-sqlite.json"))).toBe(true);
    // Post-migration reads hit kv.
    expect(await isPaused(atmuxDir, "driver")).toBe(true);
  });

  test("dry-run scans without writing kv rows", async () => {
    await writeFile(
      join(atmuxDir, "state", "paused.json"),
      JSON.stringify({ driver: { at: 1, reason: "manual" } }),
    );
    const { logger } = makeLogger();
    const out: string[] = [];
    const code = await migrateState(
      ["json-to-sqlite", "--target=state", "--team-dir", atmuxDir, "--dry-run"],
      { logger, stdout: (m) => out.push(m) },
    );
    expect(code).toBe(0);
    const summary = JSON.parse(out.join("")) as { counts: { state: { keys: number } } };
    expect(summary.counts.state.keys).toBe(1);
    expect(await exists(join(atmuxDir, "state", "paused.json"))).toBe(true);
  });
});
