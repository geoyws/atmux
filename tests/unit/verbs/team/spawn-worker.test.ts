// Unit tests for src/verbs/team/spawn-worker.ts (ADR-221 §v2).
//
// Strategy: arg-parser + worker-id normalisation tests run pure.
// End-to-end verb tests use a scratch dir + fake cockpit.json +
// mocked GitSpawn — identical scaffolding to spawn-epic.test.ts so
// the wrapper-epic + delegated spawn-epic side effects are observable
// without touching the real filesystem upstream of the scratch root.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import type { HostPressureVerdict } from "../../../../src/core/host-pressure.ts";
import type { SpawnEpicOpts } from "../../../../src/verbs/team/spawn-epic.ts";
import {
  normaliseWorkerId,
  parseSpawnWorkerArgs,
  type SpawnWorkerOpts,
  spawnWorker,
} from "../../../../src/verbs/team/spawn-worker.ts";

const permissivePressure: NonNullable<SpawnEpicOpts["probeHostPressure"]> = async () =>
  ({
    ok: true,
    reasons: [],
    probe: null,
    thresholds: null,
    skipped: true,
  }) satisfies HostPressureVerdict;

let scratch: string;
let cockpitPath: string;
let templatesDir: string;
let parentRoot: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-spawn-worker-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  cockpitPath = join(scratch, "cockpit.json");
  templatesDir = join(scratch, "templates", "epic-rosters");
  parentRoot = join(scratch, "parent-team");
  await mkdir(parentRoot, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  // `solo` roster preset — matches the production template.
  await writeFile(
    join(templatesDir, "solo.json"),
    JSON.stringify({
      members: [{ name: "solo", role: "member", lane: "misc", tui: "claude" }],
    }),
  );
  // `solo+committer` for one override test.
  await writeFile(
    join(templatesDir, "solo+committer.json"),
    JSON.stringify({
      members: [
        { name: "solo", role: "member", lane: "misc", tui: "claude" },
        { name: "committer", role: "committer", lane: "misc", tui: "claude" },
      ],
    }),
  );
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

describe("parseSpawnWorkerArgs", () => {
  test("minimal — taskId + --from", () => {
    const r = parseSpawnWorkerArgs(["t-abc123", "--from", "parent-team"]);
    expect(r.taskId).toBe("t-abc123");
    expect(r.parentTeam).toBe("parent-team");
    expect(r.roster).toBe("solo");
    expect(r.initSubmodules).toBe(true);
    expect(r.forceSpawn).toBe(false);
  });

  test("--roster override carries through", () => {
    const r = parseSpawnWorkerArgs(["t-x", "--from", "p", "--roster", "solo+committer"]);
    expect(r.roster).toBe("solo+committer");
  });

  test("--parent-base captured", () => {
    const r = parseSpawnWorkerArgs(["t-x", "--from", "p", "--parent-base", "geoyws"]);
    expect(r.parentBase).toBe("geoyws");
  });

  test("--no-init-submodules flips initSubmodules", () => {
    const r = parseSpawnWorkerArgs(["t-x", "--from", "p", "--no-init-submodules"]);
    expect(r.initSubmodules).toBe(false);
  });

  test("--force-spawn captured", () => {
    const r = parseSpawnWorkerArgs(["t-x", "--from", "p", "--force-spawn"]);
    expect(r.forceSpawn).toBe(true);
  });

  test("missing taskId refuses", () => {
    expect(() => parseSpawnWorkerArgs(["--from", "p"])).toThrow(/<task-id> required/);
  });

  test("missing --from refuses", () => {
    expect(() => parseSpawnWorkerArgs(["t-x"])).toThrow(/--from/);
  });

  test("unknown flag refuses", () => {
    expect(() => parseSpawnWorkerArgs(["t-x", "--from", "p", "--bogus"])).toThrow(/unknown flag/);
  });

  test("extra positional refuses", () => {
    expect(() => parseSpawnWorkerArgs(["t-x", "extra", "--from", "p"])).toThrow(
      /unexpected positional/,
    );
  });
});

// ---------- Worker-id normalisation ----------

describe("normaliseWorkerId", () => {
  test("t- prefix → w-", () => {
    expect(normaliseWorkerId("t-abc123")).toBe("w-abc123");
  });

  test("w- prefix passes through", () => {
    expect(normaliseWorkerId("w-abc123")).toBe("w-abc123");
  });

  test("bare id gets w- prefix", () => {
    expect(normaliseWorkerId("abc123")).toBe("w-abc123");
  });

  test("trims whitespace", () => {
    expect(normaliseWorkerId("  t-abc  ")).toBe("w-abc");
  });

  test("empty input refuses", () => {
    expect(() => normaliseWorkerId("")).toThrow(/cannot be empty/);
    expect(() => normaliseWorkerId("   ")).toThrow(/cannot be empty/);
  });
});

// ---------- Caller-scope gate ----------

describe("spawnWorker — caller-scope gate (ADR-033)", () => {
  test("refuses when caller is member — before any disk mutation", async () => {
    let epicCreatorCalls = 0;
    const opts: SpawnWorkerOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "member",
      git: makeGitStub({ initialBranch: "main" }),
      addEpic: async () => {
        epicCreatorCalls += 1;
        return "e-mock";
      },
    };
    await expect(spawnWorker(["t-abc", "--from", "parent-team"], opts)).rejects.toThrow(
      /refused.*caller scope is not 'driver'/,
    );
    expect(epicCreatorCalls).toBe(0);
  });
});

// ---------- Cockpit-lookup gate ----------

describe("spawnWorker — cockpit parent resolution", () => {
  test("refuses when parent team not in cockpit", async () => {
    const opts: SpawnWorkerOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      addEpic: async () => "e-mock",
    };
    await expect(spawnWorker(["t-abc", "--from", "missing-parent"], opts)).rejects.toThrow(
      /parent team 'missing-parent' not found in cockpit/,
    );
  });
});

// ---------- End-to-end happy path ----------

describe("spawnWorker — happy path", () => {
  test("creates wrapper kanban EPIC + delegates to spawn-epic with derived worker-id", async () => {
    const epicCalls: Array<{ atmuxDir: string; opts: { title: string; driverRef?: string } }> = [];
    const opts: SpawnWorkerOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
      addEpic: async (atmuxDir, opts) => {
        epicCalls.push({ atmuxDir, opts });
        return "e-mock123";
      },
    };
    const rc = await spawnWorker(["t-abc123", "--from", "parent-team"], opts);
    expect(rc).toBe(0);

    // Wrapper kanban epic created in parent's .atmux/ with task-id-bearing title.
    expect(epicCalls).toHaveLength(1);
    expect(epicCalls[0]?.atmuxDir).toBe(join(parentRoot, ".atmux"));
    expect(epicCalls[0]?.opts.title).toBe("worker: t-abc123");
    expect(epicCalls[0]?.opts.driverRef).toBe("t-abc123");

    // Child team.json reflects derived worker-id + wrapper epic id.
    const childTeam = JSON.parse(
      await readFile(join(scratch, "parent-team-epics", "w-abc123", ".atmux", "team.json"), "utf8"),
    );
    expect(childTeam.name).toBe("w-abc123");
    expect(childTeam.epicTeam.parent).toBe("parent-team");
    expect(childTeam.epicTeam.parentEpicKanbanId).toBe("e-mock123");
    // Default roster is solo (1 member).
    expect(childTeam.members).toHaveLength(1);
    expect(childTeam.members[0].name).toBe("solo");

    // Cockpit gained the epic-team entry with the worker-id prefix.
    const cockpit = JSON.parse(await readFile(cockpitPath, "utf8"));
    expect(cockpit.sessions[0].sessions).toHaveLength(1);
    expect(cockpit.sessions[0].sessions[0].name).toBe("w-abc123");
    expect(cockpit.sessions[0].sessions[0].type).toBe("epic-team");
  });

  test("--roster solo+committer override creates 2-member team", async () => {
    const opts: SpawnWorkerOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
      addEpic: async () => "e-mock456",
    };
    const rc = await spawnWorker(
      ["t-deadbeef", "--from", "parent-team", "--roster", "solo+committer"],
      opts,
    );
    expect(rc).toBe(0);
    const childTeam = JSON.parse(
      await readFile(
        join(scratch, "parent-team-epics", "w-deadbeef", ".atmux", "team.json"),
        "utf8",
      ),
    );
    expect(childTeam.members).toHaveLength(2);
    expect(childTeam.members.map((m: { name: string }) => m.name).sort()).toEqual([
      "committer",
      "solo",
    ]);
  });

  test("bare task-id (no `t-` prefix) normalises to `w-<id>`", async () => {
    const opts: SpawnWorkerOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
      addEpic: async () => "e-mock789",
    };
    const rc = await spawnWorker(["abc999", "--from", "parent-team"], opts);
    expect(rc).toBe(0);
    const childTeam = JSON.parse(
      await readFile(join(scratch, "parent-team-epics", "w-abc999", ".atmux", "team.json"), "utf8"),
    );
    expect(childTeam.name).toBe("w-abc999");
  });
});

// ---------- Git stub helper ----------

interface GitStubOpts {
  initialBranch: string;
}

function makeGitStub(stubOpts: GitStubOpts): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    const argv_ = [...argv];
    if (argv_.includes("rev-parse") && argv_.includes("--abbrev-ref") && argv_.includes("HEAD")) {
      return ok(`${stubOpts.initialBranch}\n`);
    }
    if (argv_.includes("worktree") && argv_.includes("list")) {
      return ok("");
    }
    if (argv_.includes("rev-parse") && argv_.includes("--verify")) {
      return { ...ok(""), exitCode: 1 };
    }
    if (argv_.includes("worktree") && argv_.includes("add")) {
      const wtPath = argv_[argv_.length - 2];
      if (wtPath !== undefined) {
        await mkdir(wtPath, { recursive: true }).catch(() => undefined);
      }
      return ok("");
    }
    if (argv_.includes("submodule")) return ok("");
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
