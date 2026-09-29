// Unit tests for src/core/role-state-repo.ts (ADR-169 P2).
//
// Strategy: hermetic temp dirs as synthetic atmux dirs; real
// bun:sqlite via the repo (no mocks — mirrors
// tests/unit/core/flags-repo.test.ts). Every public function +
// every fallback branch is exercised: row hits, legacy-file
// promotion, absent-everywhere nulls, namespaced listing, and the
// clear-removes-legacy-file invariant.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import {
  COST_NAMESPACE,
  clearRoleTextAtDb,
  importLegacyRoleText,
  MODAL_HISTORY_NAMESPACE,
  ROLE_STATE_SCHEMA_VERSION,
  RoleStateRepo,
  readRoleTextAtDb,
  TEAM_ROLE_STATE,
  TEAM_ROLE_STATE_FILES,
  teamRoleStateDbPath,
  withRoleStateDb,
  writeRoleTextAtDb,
} from "../../../src/core/role-state-repo.ts";

let root: string;
let atmuxDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atmux-role-state-repo-"));
  atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("namespace lists + schema version", () => {
  test("role-scoped namespaces are cost + modal-history", () => {
    expect(COST_NAMESPACE).toBe("cost");
    expect(MODAL_HISTORY_NAMESPACE).toBe("modal-history");
  });

  test("team list holds the 3 team-scoped files under sentinel role", () => {
    expect(TEAM_ROLE_STATE).toBe("_");
    expect([...TEAM_ROLE_STATE_FILES]).toEqual([
      "heads-up-cursor",
      "brief-versions",
      "ombudsman-pending",
    ]);
  });

  test("schema version marker is 1", () => {
    expect(ROLE_STATE_SCHEMA_VERSION).toBe(1);
  });
});

describe("path helpers", () => {
  test("teamRoleStateDbPath appends state.db", () => {
    expect(teamRoleStateDbPath("/x/.atmux")).toBe("/x/.atmux/state.db");
  });
});

describe("RoleStateRepo CRUD", () => {
  test("get misses on empty table; set/get roundtrips; set overwrites", async () => {
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), (db) => {
      const repo = new RoleStateRepo(db);
      expect(repo.get("alpha", "cost")).toBeNull();
      repo.set("alpha", "cost", '{"a":1}', 1000);
      expect(repo.get("alpha", "cost")).toBe('{"a":1}');
      repo.set("alpha", "cost", '{"a":2}', 2000);
      expect(repo.get("alpha", "cost")).toBe('{"a":2}');
      const row = db
        .query(
          "SELECT updated_at, schema_version FROM role_state WHERE role = $role AND namespace = $namespace",
        )
        .get({ $role: "alpha", $namespace: "cost" }) as {
        updated_at: number;
        schema_version: number;
      };
      expect(row.updated_at).toBe(2000);
      expect(row.schema_version).toBe(ROLE_STATE_SCHEMA_VERSION);
    });
  });

  test("composite key: same role across namespaces + same namespace across roles", async () => {
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), (db) => {
      const repo = new RoleStateRepo(db);
      repo.set("alpha", "cost", '{"n":1}', 1);
      repo.set("alpha", "modal-history", "[]", 1);
      repo.set("bravo", "cost", '{"n":2}', 1);
      expect(repo.get("alpha", "cost")).toBe('{"n":1}');
      expect(repo.get("alpha", "modal-history")).toBe("[]");
      expect(repo.get("bravo", "cost")).toBe('{"n":2}');
      expect(repo.get("bravo", "modal-history")).toBeNull();
    });
  });

  test("delete removes the row; no-op when absent", async () => {
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), (db) => {
      const repo = new RoleStateRepo(db);
      repo.delete("alpha", "cost");
      expect(repo.get("alpha", "cost")).toBeNull();
      repo.set("alpha", "cost", "{}", 1);
      repo.delete("alpha", "cost");
      expect(repo.get("alpha", "cost")).toBeNull();
    });
  });

  test("list returns every (role, payload) under one namespace", async () => {
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), (db) => {
      const repo = new RoleStateRepo(db);
      expect(repo.list("cost")).toEqual([]);
      repo.set("alpha", "cost", '{"n":1}', 1);
      repo.set("bravo", "cost", '{"n":2}', 1);
      repo.set("alpha", "modal-history", "[]", 1);
      const rows = repo.list("cost").sort((a, b) => (a.role < b.role ? -1 : 1));
      expect(rows).toEqual([
        { role: "alpha", payload: '{"n":1}' },
        { role: "bravo", payload: '{"n":2}' },
      ]);
    });
  });

  test("withRoleStateDb returns the callback value", async () => {
    const out = await withRoleStateDb(teamRoleStateDbPath(atmuxDir), () => 42);
    expect(out).toBe(42);
  });
});

describe("importLegacyRoleText", () => {
  test("existing row wins; legacy file untouched", async () => {
    const legacy = join(atmuxDir, "state", "cost-alpha.json");
    await writeFile(legacy, '{"from":"file"}');
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), async (db) => {
      const repo = new RoleStateRepo(db);
      repo.set("alpha", "cost", '{"from":"row"}', 7);
      expect(await importLegacyRoleText(db, "alpha", "cost", legacy, 8)).toBe('{"from":"row"}');
      expect(await readFile(legacy, "utf8")).toBe('{"from":"file"}');
    });
  });

  test("absent row + present file → promotes file content into the row", async () => {
    const legacy = join(atmuxDir, "state", "cost-alpha.json");
    await writeFile(legacy, '{"from":"file"}');
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), async (db) => {
      expect(await importLegacyRoleText(db, "alpha", "cost", legacy, 9)).toBe('{"from":"file"}');
      expect(new RoleStateRepo(db).get("alpha", "cost")).toBe('{"from":"file"}');
    });
  });

  test("absent row + absent file → null", async () => {
    await withRoleStateDb(teamRoleStateDbPath(atmuxDir), async (db) => {
      expect(
        await importLegacyRoleText(db, "alpha", "cost", join(atmuxDir, "state", "nope.json"), 9),
      ).toBeNull();
    });
  });
});

describe("readRoleTextAtDb", () => {
  test("no DB yet + legacy file → file content, DB not created", async () => {
    const legacy = join(atmuxDir, "state", "cost-alpha.json");
    await writeFile(legacy, '{"a":1}');
    const dbPath = teamRoleStateDbPath(atmuxDir);
    expect(await readRoleTextAtDb(dbPath, "alpha", "cost", legacy)).toBe('{"a":1}');
    expect(await exists(dbPath)).toBe(false);
  });

  test("no DB + no file → null", async () => {
    expect(
      await readRoleTextAtDb(
        teamRoleStateDbPath(atmuxDir),
        "alpha",
        "cost",
        join(atmuxDir, "state", "nope.json"),
      ),
    ).toBeNull();
  });

  test("DB row wins over legacy file", async () => {
    const legacy = join(atmuxDir, "state", "cost-alpha.json");
    await writeFile(legacy, '{"from":"file"}');
    const dbPath = teamRoleStateDbPath(atmuxDir);
    await writeRoleTextAtDb(dbPath, "alpha", "cost", '{"from":"row"}', 3);
    expect(await readRoleTextAtDb(dbPath, "alpha", "cost", legacy)).toBe('{"from":"row"}');
  });

  test("DB present + no row + legacy file → promotes and returns", async () => {
    const legacy = join(atmuxDir, "state", "cost-alpha.json");
    await writeFile(legacy, '{"from":"file"}');
    const dbPath = teamRoleStateDbPath(atmuxDir);
    await writeRoleTextAtDb(dbPath, "other", "cost", "{}", 3);
    expect(await readRoleTextAtDb(dbPath, "alpha", "cost", legacy)).toBe('{"from":"file"}');
    await withRoleStateDb(dbPath, (db) => {
      expect(new RoleStateRepo(db).get("alpha", "cost")).toBe('{"from":"file"}');
    });
  });

  test("DB present + neither → null", async () => {
    const dbPath = teamRoleStateDbPath(atmuxDir);
    await writeRoleTextAtDb(dbPath, "other", "cost", "{}", 3);
    expect(
      await readRoleTextAtDb(dbPath, "alpha", "cost", join(atmuxDir, "state", "nope.json")),
    ).toBeNull();
  });
});

describe("writeRoleTextAtDb / clearRoleTextAtDb", () => {
  test("write creates the DB + row with default clock", async () => {
    const dbPath = teamRoleStateDbPath(atmuxDir);
    await writeRoleTextAtDb(dbPath, "_", "heads-up-cursor", "{}");
    await withRoleStateDb(dbPath, (db) => {
      expect(new RoleStateRepo(db).get("_", "heads-up-cursor")).toBe("{}");
    });
  });

  test("clear removes row + leftover legacy file", async () => {
    const legacy = join(atmuxDir, "state", "ombudsman-pending.json");
    await writeFile(legacy, '{"stale":true}');
    const dbPath = teamRoleStateDbPath(atmuxDir);
    await writeRoleTextAtDb(dbPath, "_", "ombudsman-pending", '{"fresh":true}', 3);
    await clearRoleTextAtDb(dbPath, "_", "ombudsman-pending", legacy);
    expect(await exists(legacy)).toBe(false);
    await withRoleStateDb(dbPath, (db) => {
      expect(new RoleStateRepo(db).get("_", "ombudsman-pending")).toBeNull();
    });
  });

  test("clear with no DB still removes a legacy file", async () => {
    const legacy = join(atmuxDir, "state", "ombudsman-pending.json");
    await writeFile(legacy, '{"stale":true}');
    await clearRoleTextAtDb(teamRoleStateDbPath(atmuxDir), "_", "ombudsman-pending", legacy);
    expect(await exists(legacy)).toBe(false);
  });

  test("clear idempotent when both sides absent", async () => {
    await clearRoleTextAtDb(
      teamRoleStateDbPath(atmuxDir),
      "_",
      "ombudsman-pending",
      join(atmuxDir, "state", "nope.json"),
    );
  });
});
