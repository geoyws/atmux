// Unit tests for src/verbs/team/dissolve-epic.ts (ADR-090
// §dissolve-epic, t-b430b185).
//
// Strategy: scratch dir + fake cockpit.json + pre-spawned epic-team
// fixture + mocked GitSpawn so the soft-stop + prune + cockpit-mutate
// + parent-EPIC-mark-done paths exercise observably. Caller-scope
// override mirrors spawn-epic.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import {
  type DissolveEpicOpts,
  dissolveEpic,
  parseDissolveEpicArgs,
} from "../../../../src/verbs/team/dissolve-epic.ts";

let scratch: string;
let cockpitPath: string;
let parentRoot: string;
let epicRoot: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-dissolve-epic-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  cockpitPath = join(scratch, "cockpit.json");
  parentRoot = join(scratch, "parent-team");
  epicRoot = join(scratch, "parent-team-epics", "e-1");

  await mkdir(parentRoot, { recursive: true });
  await mkdir(join(parentRoot, ".atmux"), { recursive: true });
  await mkdir(epicRoot, { recursive: true });
  await mkdir(join(epicRoot, ".atmux"), { recursive: true });

  // Cockpit with the parent + epic-team already registered.
  await writeFile(
    cockpitPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [
        {
          type: "team",
          name: "parent-team",
          enabled: true,
          root: parentRoot,
          sessions: [
            {
              type: "epic-team",
              name: "e-1",
              parent: "parent-team",
              epicId: "e-1",
            },
          ],
        },
      ],
    }),
  );

  // Child team.json with the epicTeam block populated.
  await writeFile(
    join(epicRoot, ".atmux", "team.json"),
    JSON.stringify({
      name: "e-1",
      members: [{ name: "lead", role: "lead" }],
      worktreeIsolation: false,
      epicTeam: {
        parent: "parent-team",
        parentEpicKanbanId: "e-aabb0001",
        parentBase: "main",
        mergeMode: "auto",
      },
    }),
  );

  // Child state.db — seed via openDatabase so migrations apply.
  const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  closeDatabase(childDb);

  // Parent state.db with an EPIC row matching parentEpicKanbanId so
  // dissolve-epic step 8 has something to mark done.
  const parentDb = openDatabase(join(parentRoot, ".atmux", "state.db"), migrations);
  parentDb
    .query(
      `INSERT INTO epics (id, title, status, created_at)
       VALUES ($id, $title, $status, $now)`,
    )
    .run({
      $id: "e-aabb0001",
      $title: "test epic",
      $status: "in-progress",
      $now: 1000,
    });
  closeDatabase(parentDb);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Arg parsing ----------

describe("parseDissolveEpicArgs", () => {
  test("minimal — epicId only", () => {
    const r = parseDissolveEpicArgs(["e-1"]);
    expect(r.epicId).toBe("e-1");
    expect(r.skipChecks).toBe(false);
    expect(r.forcePrune).toBe(false);
  });

  test("--skip-checks + --force-prune both honored", () => {
    const r = parseDissolveEpicArgs(["e-1", "--skip-checks", "--force-prune"]);
    expect(r.skipChecks).toBe(true);
    expect(r.forcePrune).toBe(true);
  });

  test("missing epicId refuses", () => {
    expect(() => parseDissolveEpicArgs([])).toThrow(/<epicId> required/);
  });

  test("unknown flag refuses", () => {
    expect(() => parseDissolveEpicArgs(["e-1", "--bogus"])).toThrow(/unknown flag/);
  });
});

// ---------- Caller-scope gate ----------

describe("dissolveEpic — caller-scope gate", () => {
  test("refuses when caller is member", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "member",
      git: cleanGitStub(),
    };
    await expect(dissolveEpic(["e-1"], opts)).rejects.toThrow(
      /refused.*caller scope is not 'driver'/,
    );
  });
});

// ---------- Pre-flight gates ----------

describe("dissolveEpic — pre-flight gates", () => {
  test("refuses when child kanban has open tasks (clean worktree)", async () => {
    // Insert one open task into the child kanban.
    const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
    childDb
      .query(
        `INSERT INTO tasks (id, status, created_at)
         VALUES ($id, $status, $now)`,
      )
      .run({ $id: "t-open", $status: "todo", $now: 1000 });
    closeDatabase(childDb);

    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(dissolveEpic(["e-1"], opts)).rejects.toThrow(/epic-team has 1 open task/);
  });

  test("refuses when worktree is dirty (no open tasks)", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: dirtyGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(dissolveEpic(["e-1"], opts)).rejects.toThrow(/worktree.*has uncommitted/);
  });

  test("--skip-checks bypasses both gates", async () => {
    // Seed an open task + dirty worktree.
    const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
    childDb
      .query(
        `INSERT INTO tasks (id, status, created_at)
         VALUES ($id, $status, $now)`,
      )
      .run({ $id: "t-open", $status: "todo", $now: 1000 });
    closeDatabase(childDb);

    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: dirtyGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1", "--skip-checks"], opts);
    expect(rc).toBe(0);
  });
});

// ---------- Happy path ----------

describe("dissolveEpic — happy path", () => {
  test("clean state → soft-stop + worktree prune + cockpit unregister + parent EPIC marked done", async () => {
    let softStopFired = false;
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      softStopHook: async () => {
        softStopFired = true;
      },
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1"], opts);
    expect(rc).toBe(0);
    expect(softStopFired).toBe(true);

    // Cockpit entry removed.
    const cockpitAfter = JSON.parse(await readFile(cockpitPath, "utf8"));
    const parentSession = cockpitAfter.sessions[0];
    // Either the sessions[] was deleted (empty case) OR it's an empty
    // array.
    if (parentSession.sessions !== undefined) {
      expect(parentSession.sessions).toHaveLength(0);
    }

    // Parent EPIC row flipped to done.
    const parentDb = openDatabase(join(parentRoot, ".atmux", "state.db"), migrations);
    const row = parentDb
      .query<{ status: string; completed_at: number | null }, []>(
        `SELECT status, completed_at FROM epics WHERE id = 'e-aabb0001'`,
      )
      .get();
    closeDatabase(parentDb);
    expect(row?.status).toBe("done");
    expect(row?.completed_at).not.toBeNull();
  });

  test("dissolve of partially-spawned remnant (no child team.json) still cleans cockpit", async () => {
    // Remove the child team.json — simulate a failed spawn-epic.
    await rm(join(epicRoot, ".atmux", "team.json"), { force: true });
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await dissolveEpic(["e-1"], opts);
    expect(rc).toBe(0);
    // Cockpit entry cleaned regardless.
    const cockpitAfter = JSON.parse(await readFile(cockpitPath, "utf8"));
    const parentSession = cockpitAfter.sessions[0];
    if (parentSession.sessions !== undefined) {
      expect(parentSession.sessions).toHaveLength(0);
    }
  });
});

// ---------- Refusal paths ----------

describe("dissolveEpic — refusal paths", () => {
  test("refuses when epic-team not in cockpit", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
    };
    await expect(dissolveEpic(["no-such-epic"], opts)).rejects.toThrow(/not found in cockpit/);
  });
});

// ---------- Git stub helpers ----------

function cleanGitStub(): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) {
      return ok("");
    }
    if (argv.includes("worktree") && argv.includes("remove")) {
      return ok("");
    }
    return ok("");
  };
}

function dirtyGitStub(): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) {
      return ok(" M file1.ts\n M file2.ts\n");
    }
    if (argv.includes("worktree") && argv.includes("remove")) {
      return ok("");
    }
    return ok("");
  };
}

function ok(stdout: string): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}
