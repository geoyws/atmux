// Unit tests for the ADR-199 Claude-account-pool draw branch of
// src/verbs/team/spawn-epic.ts (e-7471f008 T3, t-0cf84b45).
//
// Coverage gap closed: the existing spawn-epic.test.ts "claudeAccount
// inheritance" block exercises ONLY parent-inheritance — it never
// populates `cockpit.claudeAccountPool[]`, so the pool-draw branch
// (resolvePoolFallback → inheritClaudeAccount's teamDefault-from-pool
// path at spawn-epic.ts:808-816) was uncovered.
//
// Strategy: scratch dir + fake cockpit.json carrying claudeAccountPool[]
// + a parent team.json with NO claudeAccount anywhere. `env.HOME` is
// pinned to a scratch home so `loadBudgetMap` reads the budget-probe
// files we author (deterministic selection — lowest h5_util wins). Then
// run spawnEpic and assert every child member's claudeAccount === the
// drawn pool entry's {configDir, label}. Two negative cases assert the
// pool is NOT used when (a) the pool is empty and (b) the parent already
// carries a claudeAccount.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import type { HostPressureVerdict } from "../../../../src/core/host-pressure.ts";
import { type SpawnEpicOpts, spawnEpic } from "../../../../src/verbs/team/spawn-epic.ts";

const permissivePressure: NonNullable<SpawnEpicOpts["probeHostPressure"]> = async () =>
  ({
    ok: true,
    reasons: [],
    probe: null,
    thresholds: null,
    skipped: true,
  }) satisfies HostPressureVerdict;

const permissiveEligibility: NonNullable<SpawnEpicOpts["eligibilityProbe"]> = async () => ({
  eligible: true,
  blockers: [],
});

let scratch: string;
let cockpitPath: string;
let templatesDir: string;
let parentRoot: string;
let fakeHome: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-spawn-epic-pool-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  cockpitPath = join(scratch, "cockpit.json");
  templatesDir = join(scratch, "templates", "epic-rosters");
  parentRoot = join(scratch, "parent-team");
  fakeHome = join(scratch, "home");
  await mkdir(parentRoot, { recursive: true });
  await mkdir(templatesDir, { recursive: true });
  await mkdir(join(fakeHome, ".atmux", "state"), { recursive: true });
  // Default roster preset — NO claudeAccount on any member, so the only
  // source of a team-default is the pool draw.
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
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Write the cockpit.json with one parent team + an optional
 *  claudeAccountPool[]. */
async function writeCockpit(pool?: Array<Record<string, unknown>>) {
  const cockpit: Record<string, unknown> = {
    schemaVersion: 1,
    sessions: [{ type: "team", name: "parent-team", enabled: true, root: parentRoot }],
  };
  if (pool !== undefined) cockpit.claudeAccountPool = pool;
  await writeFile(cockpitPath, JSON.stringify(cockpit));
}

/** Write the parent team.json with the given members. */
async function writeParentTeam(members: Array<Record<string, unknown>>) {
  await mkdir(join(parentRoot, ".atmux"), { recursive: true });
  await writeFile(
    join(parentRoot, ".atmux", "team.json"),
    JSON.stringify({ name: "parent-team", members }),
  );
}

/** Author a budget-probe file under the fake HOME so the selector reads
 *  deterministic live utilization for `label`. */
async function writeBudgetProbe(label: string, h5Util: number, status = "allowed") {
  await writeFile(
    join(fakeHome, ".atmux", "state", `budget-probe-${label}.json`),
    JSON.stringify({
      h5_util: h5Util,
      wk_util: 0.1,
      h5_reset: 0,
      wk_reset: 0,
      status,
      probedAt: Math.floor(Date.now() / 1000),
    }),
  );
}

async function readChild(epicId: string) {
  return JSON.parse(
    await readFile(join(scratch, "parent-team-epics", epicId, ".atmux", "team.json"), "utf8"),
  );
}

function driverOpts(): SpawnEpicOpts {
  return {
    cockpitPath,
    env: { HOME: fakeHome, ATMUX_CALLER_SCOPE: "driver" } as NodeJS.ProcessEnv,
    probeHostPressure: permissivePressure,
    templatesDir,
    callerScope: () => "driver",
    eligibilityProbe: permissiveEligibility,
    git: makeGitStub({ initialBranch: "main" }),
    logger: { log: () => undefined, warn: () => undefined },
  };
}

describe("spawnEpic — claudeAccount drawn from cockpit pool (ADR-199)", () => {
  test("parent has NO claudeAccount + pool configured — every child member inherits the least-loaded pool account as {configDir,label}", async () => {
    // Two-entry pool; "low" has the lowest h5 utilization → selected.
    await writeCockpit([
      { configDir: "/root/.claude-low", label: "low", weight: 1.0 },
      { configDir: "/root/.claude-high", label: "high", weight: 1.0 },
    ]);
    await writeBudgetProbe("low", 0.1);
    await writeBudgetProbe("high", 0.9);
    await writeParentTeam([
      { name: "lead", role: "lead" },
      { name: "planner", role: "planner" },
    ]);

    await spawnEpic(["e-pool01", "--from", "parent-team"], driverOpts());

    const child = await readChild("e-pool01");
    expect(child.members).toHaveLength(4);
    for (const m of child.members) {
      // The drawn pool entry maps 1:1 to the claudeAccount object.
      expect(m.claudeAccount).toEqual({ configDir: "/root/.claude-low", label: "low" });
    }
  });

  test("budget swing flips the selection — the lower-utilization entry wins (proves real least-loaded scoring, not array order)", async () => {
    // Same pool ordering, but now the SECOND entry ("high" label) has
    // the lowest utilization. If the test only asserted array-order it
    // would pass either way; the swing proves the selector actually
    // reads budget probe state.
    await writeCockpit([
      { configDir: "/root/.claude-low", label: "low", weight: 1.0 },
      { configDir: "/root/.claude-high", label: "high", weight: 1.0 },
    ]);
    await writeBudgetProbe("low", 0.95);
    await writeBudgetProbe("high", 0.05);
    await writeParentTeam([{ name: "lead", role: "lead" }]);

    await spawnEpic(["e-pool02", "--from", "parent-team"], driverOpts());

    const child = await readChild("e-pool02");
    for (const m of child.members) {
      expect(m.claudeAccount).toEqual({ configDir: "/root/.claude-high", label: "high" });
    }
  });

  test("empty pool — pool NOT used; child members keep no claudeAccount (parent has none either)", async () => {
    await writeCockpit([]); // claudeAccountPool present but empty
    await writeParentTeam([
      { name: "lead", role: "lead" },
      { name: "planner", role: "planner" },
    ]);

    await spawnEpic(["e-pool03", "--from", "parent-team"], driverOpts());

    const child = await readChild("e-pool03");
    for (const m of child.members) {
      expect(m.claudeAccount).toBeUndefined();
    }
  });

  test("parent already has a claudeAccount — that wins; pool is NOT drawn (parent-inheritance sits above the pool on the ladder)", async () => {
    // Pool is configured AND non-empty, but the parent supplies a
    // team-default, so the pool fallback must NOT be consulted.
    await writeCockpit([{ configDir: "/root/.claude-pool", label: "pool", weight: 1.0 }]);
    await writeBudgetProbe("pool", 0.01); // would be the obvious draw if pool were used
    await writeParentTeam([
      { name: "alpha", role: "lead", claudeAccount: "personal" },
      { name: "bravo", role: "planner", claudeAccount: "icloud" },
    ]);

    await spawnEpic(["e-pool04", "--from", "parent-team"], driverOpts());

    const child = await readChild("e-pool04");
    for (const m of child.members) {
      // teamDefault = parent's first-member account ("personal"); never
      // the pool's {configDir,label} object.
      expect(m.claudeAccount).toBe("personal");
    }
  });
});

// ---------- Git stub helper (mirrors spawn-epic.test.ts) ----------

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
