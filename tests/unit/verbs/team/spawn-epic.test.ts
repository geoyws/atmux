// Unit tests for src/verbs/team/spawn-epic.ts (ADR-090 §spawn-epic,
// t-b430b185).
//
// Strategy: arg-parser tests run pure; end-to-end verb tests use a
// scratch dir + fake cockpit.json + mocked GitSpawn so the worktree
// + state.db + child team.json + cockpit-mutate path can be
// observed without touching the real filesystem upstream of the
// scratch root. Caller-scope override is the load-bearing gate —
// most tests pin it to `driver`; the refusal-path test pins
// `member`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import {
  parseSpawnEpicArgs,
  type SpawnEpicOpts,
  spawnEpic,
} from "../../../../src/verbs/team/spawn-epic.ts";

let scratch: string;
let cockpitPath: string;
let templatesDir: string;
let parentRoot: string;

beforeEach(async () => {
  scratch = await mkdir(join(tmpdir(), `atmux-spawn-epic-${Date.now()}-${Math.random()}`), {
    recursive: true,
  }).then(() => join(tmpdir(), `atmux-spawn-epic-${Date.now()}-${Math.random()}`));
  // The double-mkdir above intentionally returns a fresh path; we
  // create it again here to ensure exists.
  await mkdir(scratch, { recursive: true });
  cockpitPath = join(scratch, "cockpit.json");
  templatesDir = join(scratch, "templates", "epic-rosters");
  parentRoot = join(scratch, "parent-team");
  await mkdir(parentRoot, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  // Default roster preset.
  await writeFile(
    join(templatesDir, "default.json"),
    JSON.stringify({
      members: [
        { name: "lead", role: "lead", tui: "claude" },
        { name: "planner", role: "planner", tui: "claude" },
        { name: "reviewer", role: "reviewer", tui: "claude" },
        { name: "fe-1", role: "member", lane: "fe", tui: "claude" },
      ],
    }),
  );
  // Minimal cockpit.json with one parent team.
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
        },
      ],
    }),
  );
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Arg parsing ----------

describe("parseSpawnEpicArgs", () => {
  test("minimal — epicId + --from", () => {
    const r = parseSpawnEpicArgs(["e-aabb0001", "--from", "parent-team"]);
    expect(r.epicId).toBe("e-aabb0001");
    expect(r.parentTeam).toBe("parent-team");
    expect(r.initSubmodules).toBe(true);
    expect(r.roster).toBeUndefined();
  });

  test("--no-init-submodules flips initSubmodules", () => {
    const r = parseSpawnEpicArgs(["e-1", "--from", "p", "--no-init-submodules"]);
    expect(r.initSubmodules).toBe(false);
  });

  test("--merge-mode pr accepted", () => {
    const r = parseSpawnEpicArgs(["e-1", "--from", "p", "--merge-mode", "pr"]);
    expect(r.mergeMode).toBe("pr");
  });

  test("--merge-mode bogus refuses", () => {
    expect(() => parseSpawnEpicArgs(["e-1", "--from", "p", "--merge-mode", "force"])).toThrow(
      /must be 'auto' or 'pr'/,
    );
  });

  test("--roster + --roster-file mutually exclusive (§Decision-anchor #4)", () => {
    expect(() =>
      parseSpawnEpicArgs([
        "e-1",
        "--from",
        "p",
        "--roster",
        "small",
        "--roster-file",
        "/tmp/x.json",
      ]),
    ).toThrow(/mutually exclusive/);
  });

  test("missing epicId refuses", () => {
    expect(() => parseSpawnEpicArgs(["--from", "p"])).toThrow(/<epicId> required/);
  });

  test("missing --from refuses", () => {
    expect(() => parseSpawnEpicArgs(["e-1"])).toThrow(/--from/);
  });

  test("unknown flag refuses", () => {
    expect(() => parseSpawnEpicArgs(["e-1", "--from", "p", "--bogus"])).toThrow(/unknown flag/);
  });
});

// ---------- Caller-scope gate ----------

describe("spawnEpic — caller-scope gate (ADR-033)", () => {
  test("refuses with explanatory error when caller is member", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "member",
      git: makeGitStub({ initialBranch: "main" }),
    };
    await expect(spawnEpic(["e-1", "--from", "parent-team"], opts)).rejects.toThrow(
      /refused.*caller scope is not 'driver'/,
    );
  });
});

// ---------- End-to-end happy path ----------

describe("spawnEpic — happy path", () => {
  test("creates worktree + child team.json + child state.db + cockpit entry", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await spawnEpic(["e-aabb0001", "--from", "parent-team"], opts);
    expect(rc).toBe(0);

    // Child team.json exists + carries epicTeam block.
    const childTeamRaw = await readFile(
      join(scratch, "parent-team-epics", "e-aabb0001", ".atmux", "team.json"),
      "utf8",
    );
    const childTeam = JSON.parse(childTeamRaw);
    expect(childTeam.name).toBe("e-aabb0001");
    expect(childTeam.worktreeIsolation).toBe(false);
    expect(childTeam.epicTeam).toBeDefined();
    expect(childTeam.epicTeam.parent).toBe("parent-team");
    expect(childTeam.epicTeam.parentBase).toBe("main");
    expect(childTeam.epicTeam.mergeMode).toBe("auto");
    expect(childTeam.epicTeam.parentEpicKanbanId).toBe("e-e-aabb0001");
    expect(childTeam.members).toHaveLength(4);

    // Child state.db file exists.
    const stateDbStat = await readFile(
      join(scratch, "parent-team-epics", "e-aabb0001", ".atmux", "state.db"),
    )
      .then(() => true)
      .catch(() => false);
    expect(stateDbStat).toBe(true);

    // Cockpit.json gained the epic-team session under the parent.
    const cockpitRaw = JSON.parse(await readFile(cockpitPath, "utf8"));
    const parentSession = cockpitRaw.sessions[0];
    expect(parentSession.sessions).toBeDefined();
    expect(parentSession.sessions).toHaveLength(1);
    expect(parentSession.sessions[0].type).toBe("epic-team");
    expect(parentSession.sessions[0].name).toBe("e-aabb0001");
  });

  test("--parent-base override pins the branch suffix", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await spawnEpic(["e-1", "--from", "parent-team", "--parent-base", "geoyws"], opts);
    const childTeam = JSON.parse(
      await readFile(join(scratch, "parent-team-epics", "e-1", ".atmux", "team.json"), "utf8"),
    );
    expect(childTeam.epicTeam.parentBase).toBe("geoyws");
  });

  test("--parent-epic-kanban-id override carries through", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await spawnEpic(
      ["e-1", "--from", "parent-team", "--parent-epic-kanban-id", "e-deadbeef"],
      opts,
    );
    const childTeam = JSON.parse(
      await readFile(join(scratch, "parent-team-epics", "e-1", ".atmux", "team.json"), "utf8"),
    );
    expect(childTeam.epicTeam.parentEpicKanbanId).toBe("e-deadbeef");
  });
});

// ---------- Refusal paths ----------

describe("spawnEpic — refusal paths", () => {
  test("refuses when parent team not in cockpit", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
    };
    await expect(spawnEpic(["e-1", "--from", "no-such-team"], opts)).rejects.toThrow(
      /parent team 'no-such-team' not found/,
    );
  });

  test("refuses when epic-team root already exists", async () => {
    await mkdir(join(scratch, "parent-team-epics", "e-1"), {
      recursive: true,
    });
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
    };
    await expect(spawnEpic(["e-1", "--from", "parent-team"], opts)).rejects.toThrow(
      /already exists/,
    );
  });

  test("refuses when roster preset not found", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
    };
    await expect(
      spawnEpic(["e-1", "--from", "parent-team", "--roster", "non-existent"], opts),
    ).rejects.toThrow(/roster file not found/);
  });
});

// ---------- Git stub helper ----------

interface GitStubOpts {
  initialBranch: string;
}

function makeGitStub(stubOpts: GitStubOpts): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    const argv_ = [...argv];
    // git -C <path> rev-parse --abbrev-ref HEAD → return stubbed branch
    if (argv_.includes("rev-parse") && argv_.includes("--abbrev-ref") && argv_.includes("HEAD")) {
      return ok(`${stubOpts.initialBranch}\n`);
    }
    // git -C <path> worktree list --porcelain → empty (no existing worktrees)
    if (argv_.includes("worktree") && argv_.includes("list")) {
      return ok("");
    }
    // git -C <path> rev-parse --verify --quiet refs/heads/... → exit 1 (no branch)
    if (argv_.includes("rev-parse") && argv_.includes("--verify")) {
      return { ...ok(""), exitCode: 1 };
    }
    // git -C <path> worktree add ... → succeed + create the directory side-effect
    if (argv_.includes("worktree") && argv_.includes("add")) {
      // The verb relies on the actual directory existing post-provision;
      // simulate by creating it here.
      const wtPath = argv_[argv_.length - 2];
      if (wtPath !== undefined) {
        // best-effort mkdir; ignored if already exists
        await mkdir(wtPath, { recursive: true }).catch(() => undefined);
      }
      return ok("");
    }
    // Submodule init → succeed (no-op).
    if (argv_.includes("submodule")) {
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
