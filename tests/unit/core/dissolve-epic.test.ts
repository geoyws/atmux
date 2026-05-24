// Unit tests for src/core/dissolve-epic.ts (ADR-232 §D1 factored
// pure core of `atmux team dissolve-epic`).
//
// Scope: the structured-input contract — `performDissolveEpic({epicId,
// skipChecks, forcePrune}, opts)`. The verb wrapper's argv path is
// covered in tests/unit/verbs/team/dissolve-epic.test.ts (22 tests,
// unmodified post-factor). These tests confirm:
//
//   1. Structured-input parity with argv path (happy + refusal).
//   2. Zod input shape validates required fields + applies defaults.
//   3. Caller-scope gate (ADR-033) fires on structured-input entry.
//
// Anything deeper (cage teardown variants, branch-delete matrix,
// cockpit-mutate fidelity) is covered transitively by the verb tests
// since they exercise the same core module post-factor.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  type DissolveEpicOpts,
  performDissolveEpic,
  PerformDissolveEpicInput,
} from "../../../src/core/dissolve-epic.ts";

let scratch: string;
let cockpitPath: string;
let parentRoot: string;
let epicRoot: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-core-dissolve-epic-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  cockpitPath = join(scratch, "cockpit.json");
  parentRoot = join(scratch, "parent-team");
  epicRoot = join(scratch, "parent-team-epics", "e-1");

  await mkdir(parentRoot, { recursive: true });
  await mkdir(join(parentRoot, ".atmux"), { recursive: true });
  await mkdir(epicRoot, { recursive: true });
  await mkdir(join(epicRoot, ".atmux"), { recursive: true });

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

  const childDb = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  closeDatabase(childDb);

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

// ---------- Zod input shape ----------

describe("PerformDissolveEpicInput (Zod)", () => {
  test("epicId required", () => {
    expect(() => PerformDissolveEpicInput.parse({})).toThrow();
    expect(() => PerformDissolveEpicInput.parse({ epicId: "" })).toThrow();
  });

  test("skipChecks + forcePrune default false", () => {
    const r = PerformDissolveEpicInput.parse({ epicId: "e-1" });
    expect(r.skipChecks).toBe(false);
    expect(r.forcePrune).toBe(false);
  });

  test("explicit flags honored", () => {
    const r = PerformDissolveEpicInput.parse({
      epicId: "e-1",
      skipChecks: true,
      forcePrune: true,
    });
    expect(r.skipChecks).toBe(true);
    expect(r.forcePrune).toBe(true);
  });
});

// ---------- Caller-scope gate ----------

describe("performDissolveEpic — caller-scope gate", () => {
  test("refuses when caller is member (structured-input entry)", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "member",
      git: cleanGitStub(),
    };
    await expect(
      performDissolveEpic({ epicId: "e-1", skipChecks: false, forcePrune: false }, opts),
    ).rejects.toThrow(/refused.*caller scope is not 'driver'/);
  });
});

// ---------- Topology ----------

describe("performDissolveEpic — topology errors", () => {
  test("epic-team absent from cockpit → ConfigError", async () => {
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(
      performDissolveEpic({ epicId: "e-unknown", skipChecks: false, forcePrune: false }, opts),
    ).rejects.toThrow(/'e-unknown' not found in cockpit/);
  });
});

// ---------- Happy path via structured input ----------

describe("performDissolveEpic — happy path", () => {
  test("structured input drives full pipeline (parity with argv-wrapped verb)", async () => {
    let softStopFired = false;
    const opts: DissolveEpicOpts = {
      cockpitPath,
      callerScope: () => "driver",
      git: cleanGitStub(),
      softStopHook: async (_deps) => {
        softStopFired = true;
      },
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await performDissolveEpic(
      { epicId: "e-1", skipChecks: false, forcePrune: false },
      opts,
    );
    expect(rc).toBe(0);
    expect(softStopFired).toBe(true);

    // Cockpit entry removed.
    const cockpitAfter = JSON.parse(await readFile(cockpitPath, "utf8"));
    const parent = cockpitAfter.sessions[0];
    expect(parent.sessions).toBeUndefined();

    // Parent EPIC row marked done.
    const parentDb = openDatabase(join(parentRoot, ".atmux", "state.db"), migrations);
    const row = parentDb
      .query<{ status: string }, []>(`SELECT status FROM epics WHERE id = 'e-aabb0001'`)
      .get();
    closeDatabase(parentDb);
    expect(row?.status).toBe("done");
  });
});

// ---------- Helpers ----------

function cleanGitStub(): GitSpawn {
  return async (_argv: ReadonlyArray<string>) => okSpawn("", 0);
}

function okSpawn(stdout: string, exitCode = 0): SpawnResult {
  return {
    exitCode,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}
