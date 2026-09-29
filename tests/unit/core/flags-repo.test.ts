// Unit tests for src/core/flags-repo.ts (ADR-169 P1).
//
// Strategy: hermetic temp dirs as synthetic atmux/home dirs; real
// bun:sqlite via the repo (no mocks — mirrors
// tests/unit/verbs/migrate-state.test.ts). Every public function +
// every fallback branch is exercised: row hits, legacy-file promotion,
// absent-everywhere nulls, and the clear-removes-legacy-file invariant.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import {
  COCKPIT_FLAG_FILES,
  clearFlagTextAtDb,
  cockpitDbPathForStateFile,
  cockpitFlagsDbPath,
  FLAGS_SCHEMA_VERSION,
  FlagsRepo,
  importLegacyFlagText,
  readFlagTextAtDb,
  TEAM_FLAG_FILES,
  teamFlagsDbPath,
  withFlagsDb,
  writeFlagTextAtDb,
} from "../../../src/core/flags-repo.ts";

let root: string;
let atmuxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-flags-repo-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("flag key lists + schema version", () => {
  test("team list holds the 4 team-scoped keys (ADR-169 OQ-3: no budget keys)", () => {
    expect([...TEAM_FLAG_FILES]).toEqual([
      "paused",
      "resume",
      "eternal-improvement",
      "whip-config-drift-state",
    ]);
  });

  test("cockpit list holds the 2 cockpit-scoped keys", () => {
    expect([...COCKPIT_FLAG_FILES]).toEqual(["pulse-state", "sentinel-state"]);
  });

  test("schema version marker is 1", () => {
    expect(FLAGS_SCHEMA_VERSION).toBe(1);
  });
});

describe("path helpers", () => {
  test("teamFlagsDbPath appends state.db", () => {
    expect(teamFlagsDbPath("/x/.atmux")).toBe("/x/.atmux/state.db");
  });

  test("cockpitFlagsDbPath resolves under home", () => {
    expect(cockpitFlagsDbPath("/home/op")).toBe("/home/op/.atmux/state.db");
  });

  test("cockpitDbPathForStateFile derives the sibling state.db", () => {
    expect(cockpitDbPathForStateFile("/home/op/.atmux/state/pulse-state.json")).toBe(
      "/home/op/.atmux/state.db",
    );
  });
});

describe("FlagsRepo CRUD", () => {
  test("get misses on empty table; set/get roundtrips; set overwrites", async () => {
    await withFlagsDb(teamFlagsDbPath(atmuxDir), (db) => {
      const repo = new FlagsRepo(db);
      expect(repo.get("paused")).toBeNull();
      repo.set("paused", '{"a":1}', 1000);
      expect(repo.get("paused")).toBe('{"a":1}');
      repo.set("paused", '{"a":2}', 2000);
      expect(repo.get("paused")).toBe('{"a":2}');
      const row = db.query("SELECT updated_at, schema_version FROM flags WHERE key = $key").get({
        $key: "paused",
      }) as { updated_at: number; schema_version: number };
      expect(row.updated_at).toBe(2000);
      expect(row.schema_version).toBe(FLAGS_SCHEMA_VERSION);
    });
  });

  test("delete removes the row; no-op when absent", async () => {
    await withFlagsDb(teamFlagsDbPath(atmuxDir), (db) => {
      const repo = new FlagsRepo(db);
      repo.delete("paused");
      expect(repo.get("paused")).toBeNull();
      repo.set("paused", "{}", 1);
      repo.delete("paused");
      expect(repo.get("paused")).toBeNull();
    });
  });

  test("withFlagsDb returns the callback value", async () => {
    const out = await withFlagsDb(teamFlagsDbPath(atmuxDir), () => 42);
    expect(out).toBe(42);
  });
});

describe("importLegacyFlagText", () => {
  test("existing row wins; legacy file untouched", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"from":"file"}');
    await withFlagsDb(teamFlagsDbPath(atmuxDir), async (db) => {
      const repo = new FlagsRepo(db);
      repo.set("paused", '{"from":"row"}', 7);
      expect(await importLegacyFlagText(db, "paused", legacy, 8)).toBe('{"from":"row"}');
      expect(await readFile(legacy, "utf8")).toBe('{"from":"file"}');
    });
  });

  test("absent row + present file → promotes file content into the row", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"from":"file"}');
    await withFlagsDb(teamFlagsDbPath(atmuxDir), async (db) => {
      expect(await importLegacyFlagText(db, "paused", legacy, 9)).toBe('{"from":"file"}');
      expect(new FlagsRepo(db).get("paused")).toBe('{"from":"file"}');
    });
  });

  test("absent row + absent file → null", async () => {
    await withFlagsDb(teamFlagsDbPath(atmuxDir), async (db) => {
      expect(
        await importLegacyFlagText(db, "paused", join(atmuxDir, "state", "nope.json"), 9),
      ).toBeNull();
    });
  });
});

describe("readFlagTextAtDb", () => {
  test("no DB yet + legacy file → file content, DB not created", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"a":1}');
    const dbPath = teamFlagsDbPath(atmuxDir);
    expect(await readFlagTextAtDb(dbPath, "paused", legacy)).toBe('{"a":1}');
    expect(await exists(dbPath)).toBe(false);
  });

  test("no DB + no file → null", async () => {
    expect(
      await readFlagTextAtDb(
        teamFlagsDbPath(atmuxDir),
        "paused",
        join(atmuxDir, "state", "nope.json"),
      ),
    ).toBeNull();
  });

  test("DB row wins over legacy file", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"from":"file"}');
    const dbPath = teamFlagsDbPath(atmuxDir);
    await writeFlagTextAtDb(dbPath, "paused", '{"from":"row"}', 3);
    expect(await readFlagTextAtDb(dbPath, "paused", legacy)).toBe('{"from":"row"}');
  });

  test("DB present + no row + legacy file → promotes and returns", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"from":"file"}');
    const dbPath = teamFlagsDbPath(atmuxDir);
    await writeFlagTextAtDb(dbPath, "other", "{}", 3);
    expect(await readFlagTextAtDb(dbPath, "paused", legacy)).toBe('{"from":"file"}');
    await withFlagsDb(dbPath, (db) => {
      expect(new FlagsRepo(db).get("paused")).toBe('{"from":"file"}');
    });
  });

  test("DB present + neither → null", async () => {
    const dbPath = teamFlagsDbPath(atmuxDir);
    await writeFlagTextAtDb(dbPath, "other", "{}", 3);
    expect(
      await readFlagTextAtDb(dbPath, "paused", join(atmuxDir, "state", "nope.json")),
    ).toBeNull();
  });
});

describe("writeFlagTextAtDb / clearFlagTextAtDb", () => {
  test("write creates the DB + row with default clock", async () => {
    const dbPath = teamFlagsDbPath(atmuxDir);
    await writeFlagTextAtDb(dbPath, "paused", "{}");
    await withFlagsDb(dbPath, (db) => {
      expect(new FlagsRepo(db).get("paused")).toBe("{}");
    });
  });

  test("clear removes row + leftover legacy file", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"stale":true}');
    const dbPath = teamFlagsDbPath(atmuxDir);
    await writeFlagTextAtDb(dbPath, "paused", '{"fresh":true}', 3);
    await clearFlagTextAtDb(dbPath, "paused", legacy);
    expect(await exists(legacy)).toBe(false);
    await withFlagsDb(dbPath, (db) => {
      expect(new FlagsRepo(db).get("paused")).toBeNull();
    });
  });

  test("clear with no DB still removes a legacy file", async () => {
    const legacy = join(atmuxDir, "state", "paused.json");
    await writeFile(legacy, '{"stale":true}');
    await clearFlagTextAtDb(teamFlagsDbPath(atmuxDir), "paused", legacy);
    expect(await exists(legacy)).toBe(false);
  });

  test("clear idempotent when both sides absent", async () => {
    await clearFlagTextAtDb(
      teamFlagsDbPath(atmuxDir),
      "paused",
      join(atmuxDir, "state", "nope.json"),
    );
  });
});
