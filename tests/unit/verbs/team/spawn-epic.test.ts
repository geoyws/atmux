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
import type { HostPressureVerdict } from "../../../../src/core/host-pressure.ts";
import {
  parseSpawnEpicArgs,
  type SpawnEpicOpts,
  spawnEpic,
} from "../../../../src/verbs/team/spawn-epic.ts";

// Host-pressure probe stub — always returns `ok: true, skipped: true` so
// the ADR-184 spawn gate never refuses in tests. Real-host probe lives
// under tests/unit/core/host-pressure.test.ts.
const permissivePressure: NonNullable<SpawnEpicOpts["probeHostPressure"]> = async () =>
  ({
    ok: true,
    reasons: [],
    probe: null,
    thresholds: null,
    skipped: true,
  }) satisfies HostPressureVerdict;

// ADR-225 eligibility-gate stub — pretend every epic is eligible. Tests
// that don't care about the gate use this so they don't have to seed a
// parent state.db with a real ready+done-deps epic row. The dedicated
// ADR-225 describe block below (further down) exercises the gate logic
// in isolation with a true predicate + seeded fixture.
const permissiveEligibility: NonNullable<SpawnEpicOpts["eligibilityProbe"]> = async () => ({
  eligible: true,
  blockers: [],
});

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

  test("autoDissolve defaults to true (ADR-227 §D3)", () => {
    const r = parseSpawnEpicArgs(["e-1", "--from", "p"]);
    expect(r.autoDissolve).toBe(true);
  });

  test("--no-auto-dissolve flips autoDissolve to false (operator opt-out per ADR-227 §D3)", () => {
    const r = parseSpawnEpicArgs(["e-1", "--from", "p", "--no-auto-dissolve"]);
    expect(r.autoDissolve).toBe(false);
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
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "member",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
    };
    await expect(spawnEpic(["e-1", "--from", "parent-team"], opts)).rejects.toThrow(
      /refused.*caller scope is not 'driver'/,
    );
  });
});

// ---------- Host-pressure gate (ADR-184 substrate) ----------

describe("spawnEpic — host-pressure gate (ADR-184)", () => {
  test("refuses with explanatory error when probe reports pressure", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: async () => ({
        ok: false,
        reasons: ["load 15min 20.00 > 12.00 (16 cores × 0.75)"],
        probe: {
          loadAvg1min: 20,
          loadAvg15min: 20,
          memAvailableMb: 16000,
          cpuCores: 16,
          memTotalMb: 65536,
          disks: [],
          missingMounts: [],
        },
        thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
        skipped: false,
      }),
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    // ADR-228 §D1 made queue-on-pressure the default; --no-queue selects
    // the original throw-on-pressure path this test asserts.
    await expect(spawnEpic(["e-aabb0001", "--from", "parent-team", "--no-queue"], opts)).rejects.toThrow(
      /host under pressure/,
    );
  });

  test("--force-spawn bypasses the gate even when probe red", async () => {
    let probeCalled = 0;
    const warnLines: string[] = [];
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: async () => {
        probeCalled += 1;
        return {
          ok: false,
          reasons: ["load 15min 20.00 > 12.00"],
          probe: null,
          thresholds: null,
          skipped: false,
        };
      },
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: (m) => warnLines.push(m) },
    };
    const rc = await spawnEpic(["e-aabb0001", "--from", "parent-team", "--force-spawn"], opts);
    expect(rc).toBe(0);
    expect(probeCalled).toBe(0); // probe NOT called under --force-spawn
    expect(warnLines.some((m) => m.includes("--force-spawn bypasses"))).toBe(true);
  });

  test("non-Linux probe (skipped) treated as ok — no refusal", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: async () => ({
        ok: true,
        reasons: [],
        probe: null,
        thresholds: null,
        skipped: true,
      }),
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await spawnEpic(["e-aabb0001", "--from", "parent-team"], opts);
    expect(rc).toBe(0);
  });

  test("--force-spawn arg parses + survives positional epicId", () => {
    const r = parseSpawnEpicArgs(["e-1", "--from", "parent", "--force-spawn"]);
    expect(r.forceSpawn).toBe(true);

    const r2 = parseSpawnEpicArgs(["--force-spawn", "e-1", "--from", "parent"]);
    expect(r2.forceSpawn).toBe(true);
    expect(r2.epicId).toBe("e-1");

    const r3 = parseSpawnEpicArgs(["e-1", "--from", "parent"]);
    expect(r3.forceSpawn).toBe(false);
  });
});

// ---------- End-to-end happy path ----------

describe("spawnEpic — happy path", () => {
  test("creates worktree + child team.json + child state.db + cockpit entry", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
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
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
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
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
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

// ---------- t-54ba3c49: soft-warn at 20+ concurrent epics (ADR-090 §Amendment 2026-05-20) ----------

describe("spawnEpic — soft-warn at 20+ concurrent epics under same parent", () => {
  async function writeCockpitWithNEpics(n: number) {
    const epicChildren = Array.from({ length: n }, (_, i) => ({
      type: "epic-team",
      name: `e-existing-${String(i).padStart(4, "0")}`,
      parent: "parent-team",
      epicId: `e-existing-${String(i).padStart(4, "0")}`,
      enabled: true,
    }));
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
            sessions: epicChildren,
          },
        ],
      }),
    );
  }

  test("19 existing epic-teams under parent — no warn (under threshold)", async () => {
    await writeCockpitWithNEpics(19);
    const warns: string[] = [];
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: (m) => warns.push(m) },
    };
    const rc = await spawnEpic(["e-new-spawn", "--from", "parent-team"], opts);
    expect(rc).toBe(0);
    expect(warns.filter((w) => w.includes("auto-merge queue depth may saturate"))).toHaveLength(0);
  });

  test("20 existing epic-teams under parent — soft-warn fires (at threshold)", async () => {
    await writeCockpitWithNEpics(20);
    const warns: string[] = [];
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: (m) => warns.push(m) },
    };
    const rc = await spawnEpic(["e-new-spawn", "--from", "parent-team"], opts);
    // Spawn still proceeds (warn, not refuse) per ADR-090 §Amendment.
    expect(rc).toBe(0);
    const matched = warns.filter((w) => w.includes("auto-merge queue depth may saturate"));
    expect(matched).toHaveLength(1);
    expect(matched[0]).toContain("20 concurrent epic-team");
    expect(matched[0]).toContain("parent-team");
    expect(matched[0]).toContain("ADR-090 §Amendment 2026-05-20");
  });

  test("25 existing epic-teams under parent — soft-warn fires (well past threshold)", async () => {
    await writeCockpitWithNEpics(25);
    const warns: string[] = [];
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: (m) => warns.push(m) },
    };
    const rc = await spawnEpic(["e-new-spawn", "--from", "parent-team"], opts);
    expect(rc).toBe(0);
    const matched = warns.filter((w) => w.includes("25 concurrent epic-team"));
    expect(matched).toHaveLength(1);
  });
});

// ---------- claudeAccount inheritance (t-72f90a08, fix shipped 2674670) ----------

describe("spawnEpic — claudeAccount inheritance from parent (ADR-091)", () => {
  async function writeParentTeam(members: Array<Record<string, unknown>>) {
    await mkdir(join(parentRoot, ".atmux"), { recursive: true });
    await writeFile(
      join(parentRoot, ".atmux", "team.json"),
      JSON.stringify({ name: "parent-team", members }),
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
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
  }

  test("per-member name match wins — each child member inherits its parent namesake's claudeAccount", async () => {
    await writeParentTeam([
      { name: "lead", role: "lead", claudeAccount: "personal" },
      { name: "planner", role: "planner", claudeAccount: "personal" },
      { name: "reviewer", role: "reviewer", claudeAccount: "icloud" },
      { name: "fe-1", role: "member", claudeAccount: "ifca" },
    ]);
    await spawnEpic(["e-aa01", "--from", "parent-team"], driverOpts());
    const child = await readChild("e-aa01");
    const byName = Object.fromEntries(child.members.map((m: { name: string }) => [m.name, m]));
    expect(byName.lead.claudeAccount).toBe("personal");
    expect(byName.planner.claudeAccount).toBe("personal");
    expect(byName.reviewer.claudeAccount).toBe("icloud");
    expect(byName["fe-1"].claudeAccount).toBe("ifca");
  });

  test("team-default fallback — child members without a parent namesake inherit the parent's first-member claudeAccount", async () => {
    // Parent has different member names than the default roster.
    await writeParentTeam([
      { name: "alpha", role: "lead", claudeAccount: "personal" },
      { name: "bravo", role: "planner", claudeAccount: "icloud" },
    ]);
    await spawnEpic(["e-aa02", "--from", "parent-team"], driverOpts());
    const child = await readChild("e-aa02");
    // All 4 default-roster members fall back to teamDefault = "personal"
    // (the first parent member's claudeAccount).
    for (const m of child.members) {
      expect(m.claudeAccount).toBe("personal");
    }
  });

  test("does NOT overwrite roster entries that already specify claudeAccount", async () => {
    // Custom roster preset where one member pins its own account.
    await writeFile(
      join(templatesDir, "pinned.json"),
      JSON.stringify({
        members: [
          { name: "lead", role: "lead", tui: "claude", claudeAccount: "ifca" },
          { name: "fe-1", role: "member", lane: "fe", tui: "claude" },
        ],
      }),
    );
    await writeParentTeam([
      { name: "lead", role: "lead", claudeAccount: "personal" },
      { name: "fe-1", role: "member", claudeAccount: "personal" },
    ]);
    await spawnEpic(["e-aa03", "--from", "parent-team", "--roster", "pinned"], driverOpts());
    const child = await readChild("e-aa03");
    const byName = Object.fromEntries(child.members.map((m: { name: string }) => [m.name, m]));
    // Roster-pinned value preserved; non-pinned member inherits.
    expect(byName.lead.claudeAccount).toBe("ifca");
    expect(byName["fe-1"].claudeAccount).toBe("personal");
  });

  test("parent team.json with no claudeAccount anywhere — child members unchanged (no synthetic injection)", async () => {
    await writeParentTeam([
      { name: "lead", role: "lead" },
      { name: "planner", role: "planner" },
    ]);
    await spawnEpic(["e-aa04", "--from", "parent-team"], driverOpts());
    const child = await readChild("e-aa04");
    for (const m of child.members) {
      expect(m.claudeAccount).toBeUndefined();
    }
  });

  test("parent team.json missing — early return, child members unchanged (regression guard for the helper's no-parent-file path)", async () => {
    // Default beforeEach creates parentRoot WITHOUT .atmux/team.json,
    // so this test verifies the early-return branch at the top of
    // inheritClaudeAccount (the originally-broken path before 2674670
    // was a no-op that left members un-inherited — same observable as
    // the no-file case, so this is the contract-level guard).
    await spawnEpic(["e-aa05", "--from", "parent-team"], driverOpts());
    const child = await readChild("e-aa05");
    for (const m of child.members) {
      expect(m.claudeAccount).toBeUndefined();
    }
  });
});

// ---------- Refusal paths ----------

describe("spawnEpic — refusal paths", () => {
  test("refuses when parent team not in cockpit", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
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
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
    };
    await expect(spawnEpic(["e-1", "--from", "parent-team"], opts)).rejects.toThrow(
      /already exists/,
    );
  });

  test("refuses when roster preset not found", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
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

// ---------- ADR-225 eligibility gate (T5 / t-1fbd2aa4) ----------

describe("spawnEpic — ADR-225 eligibility gate", () => {
  test("eligible epic spawns normally (smoke — probe returns eligible:true)", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: async () => ({ eligible: true, blockers: [] }),
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await spawnEpic(["e-elig-ok", "--from", "parent-team"], opts);
    expect(rc).toBe(0);
  });

  test("ineligible epic (is_ready=0) refused — UsageError names the blocker", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: async () => ({ eligible: false, blockers: ["is_ready=0"] }),
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(spawnEpic(["e-ineligible", "--from", "parent-team"], opts)).rejects.toThrow(
      /not eligible.*is_ready=0/s,
    );
  });

  test("ineligible epic (unmet dep) refused — message names dep id + status", async () => {
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: async () => ({
        eligible: false,
        blockers: ["dep e-up1 not done (status=in-progress)"],
      }),
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    await expect(spawnEpic(["e-blocked", "--from", "parent-team"], opts)).rejects.toThrow(
      /dep e-up1 not done.*status=in-progress/s,
    );
  });

  test("--force on ineligible epic proceeds + writes override log line + invokes Discord", async () => {
    const homeDir = join(scratch, "home");
    await mkdir(homeDir, { recursive: true });
    const discordCalls: Array<Record<string, unknown>> = [];
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: async () => ({
        eligible: false,
        blockers: ["is_ready=0", "dep e-up1 not done (status=planning)"],
      }),
      sendSpawnForceDiscord: async (payload) => {
        discordCalls.push(payload as unknown as Record<string, unknown>);
      },
      logSpawnOverrideOpts: { homeDir, now: () => 1_700_000_000_000 },
      env: { ...process.env, HOME: homeDir, ATMUX_MEMBER: "be-1" },
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await spawnEpic(["e-forced", "--from", "parent-team", "--force"], opts);
    expect(rc).toBe(0);

    // Discord call landed with the expected payload shape.
    expect(discordCalls).toHaveLength(1);
    const payload = discordCalls[0] as {
      topic: string;
      epicId: string;
      team: string;
      blockers: string[];
      callerMember: string;
      callerScope: string;
    };
    expect(payload.topic).toBe("spawn-force");
    expect(payload.epicId).toBe("e-e-forced");
    expect(payload.team).toBe("parent-team");
    expect(payload.blockers).toContain("is_ready=0");
    expect(payload.callerMember).toBe("be-1");
    expect(payload.callerScope).toBe("driver");

    // Override log file lands at $HOME/.atmux/state/spawn-overrides.log
    // with the same payload + ts + iso.
    const logPath = join(homeDir, ".atmux", "state", "spawn-overrides.log");
    const raw = await readFile(logPath, "utf8");
    const lines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    const line = lines[0] as {
      ts: number;
      iso: string;
      epicId: string;
      team: string;
      blockers: string[];
      callerMember: string;
      callerScope: string;
    };
    expect(line.ts).toBe(1_700_000_000);
    expect(line.iso).toBe(new Date(1_700_000_000_000).toISOString());
    expect(line.epicId).toBe("e-e-forced");
    expect(line.team).toBe("parent-team");
    expect(line.blockers).toEqual(["is_ready=0", "dep e-up1 not done (status=planning)"]);
    expect(line.callerMember).toBe("be-1");
    expect(line.callerScope).toBe("driver");
  });

  test("--force on eligible epic STILL spawns + does NOT log (gate already green)", async () => {
    const homeDir = join(scratch, "home");
    await mkdir(homeDir, { recursive: true });
    let discordCalled = 0;
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: async () => ({ eligible: true, blockers: [] }),
      sendSpawnForceDiscord: async () => {
        discordCalled += 1;
      },
      logSpawnOverrideOpts: { homeDir, now: () => 1_700_000_000_000 },
      env: { ...process.env, HOME: homeDir, ATMUX_MEMBER: "be-1" },
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
    };
    const rc = await spawnEpic(["e-clean", "--from", "parent-team", "--force"], opts);
    expect(rc).toBe(0);
    // No override fired because the gate didn't refuse.
    expect(discordCalled).toBe(0);
    // No log file written.
    const logPath = join(homeDir, ".atmux", "state", "spawn-overrides.log");
    const logExists = await readFile(logPath, "utf8")
      .then(() => true)
      .catch(() => false);
    expect(logExists).toBe(false);
  });

  test("--force flag round-trips via the parser", () => {
    const r = parseSpawnEpicArgs(["e-1", "--from", "p", "--force"]);
    expect(r.forceEligibility).toBe(true);

    const r2 = parseSpawnEpicArgs(["--force", "e-1", "--from", "p"]);
    expect(r2.forceEligibility).toBe(true);
    expect(r2.epicId).toBe("e-1");

    const r3 = parseSpawnEpicArgs(["e-1", "--from", "p"]);
    expect(r3.forceEligibility).toBe(false);
  });

  test("--force-spawn and --force are independent flags", () => {
    const both = parseSpawnEpicArgs(["e-1", "--from", "p", "--force-spawn", "--force"]);
    expect(both.forceSpawn).toBe(true);
    expect(both.forceEligibility).toBe(true);

    const onlyEligibility = parseSpawnEpicArgs(["e-1", "--from", "p", "--force"]);
    expect(onlyEligibility.forceSpawn).toBe(false);
    expect(onlyEligibility.forceEligibility).toBe(true);

    const onlySpawn = parseSpawnEpicArgs(["e-1", "--from", "p", "--force-spawn"]);
    expect(onlySpawn.forceSpawn).toBe(true);
    expect(onlySpawn.forceEligibility).toBe(false);
  });
});

// ---------- Parent-cage viewer window (ADR-089 §Pillar 1 §Amendment / t-2183f488) ----------

// Fake tmux factory recording newWindow calls. Drives the
// addEpicViewerToParentCage path in spawn-epic without a real tmux
// server. `aliveSessions` controls whether the parent session is
// reported running; `preexistingWindows` lets the idempotent test seed
// a viewer window so the helper's window-name check fires.
interface NewWindowCall {
  sessionName: string;
  name: string;
  detached: boolean;
  shellCommand: string;
}
function makeViewerTmuxFactory(cfg: {
  aliveSessions: string[];
  preexistingWindows?: Array<{ name: string; index: number }>;
}): {
  factory: NonNullable<SpawnEpicOpts["tmuxFactory"]>;
  newWindowCalls: NewWindowCall[];
} {
  const newWindowCalls: NewWindowCall[] = [];
  const windows = cfg.preexistingWindows ?? [{ name: "lead", index: 0 }];
  const factory: NonNullable<SpawnEpicOpts["tmuxFactory"]> = () => ({
    session: {
      listSessions: async () => cfg.aliveSessions.map((name) => ({ name })),
    },
    window: {
      listWindows: async () => windows,
      newWindow: async (args: NewWindowCall) => {
        newWindowCalls.push(args);
        return { windowIndex: windows.length };
      },
    },
  });
  return { factory, newWindowCalls };
}

describe("spawnEpic — parent-cage viewer (ADR-089 §Pillar 1 §Amendment / t-2183f488)", () => {
  test("running parent — adds 🌳-<epicId> window with retry-attach shell command into the nested epic cage", async () => {
    // Parent session name resolves to `atmux-<parentName>` when no
    // session-anchor file exists (the scratch parent has none).
    const { factory, newWindowCalls } = makeViewerTmuxFactory({
      aliveSessions: ["atmux-parent-team"],
    });
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
      tmuxFactory: factory,
    };
    const rc = await spawnEpic(["e-viewer-01", "--from", "parent-team"], opts);
    expect(rc).toBe(0);

    // Exactly one viewer window was created in the parent session.
    expect(newWindowCalls).toHaveLength(1);
    const call = newWindowCalls[0]!;
    expect(call.sessionName).toBe("atmux-parent-team");
    expect(call.name).toBe("🌳-e-viewer-01");
    expect(call.detached).toBe(true);

    // The shell command is the 1s-retry attach loop into the CHILD cage's
    // nested socket + session (so the viewer connects on later cage boot).
    // epicSocket derives from childTeam.tmuxTmpdir per ADR-089 §Pillar 1:
    // /tmp/atmux-<parent>/epics/<epicId>/tmux-<uid>/default.
    const uid = process.getuid?.() ?? 0;
    const expectedEpicSocket = `/tmp/atmux-parent-team/epics/e-viewer-01/tmux-${uid}/default`;
    expect(call.shellCommand).toContain(`tmux -S ${expectedEpicSocket} attach -t atmux-e-viewer-01`);
    expect(call.shellCommand).toContain("while true;");
    expect(call.shellCommand).toContain("sleep 1");
  });

  test("parent cage NOT running — soft-fails (no window, spawn still returns 0)", async () => {
    // listSessions returns the WRONG session name → helper sees the parent
    // as down and skips the viewer add (warn-only). The spawn itself must
    // still succeed: worktree + team.json + state.db + cockpit registration
    // are all landed before the viewer step.
    const { factory, newWindowCalls } = makeViewerTmuxFactory({
      aliveSessions: ["some-other-session"],
    });
    const warnings: string[] = [];
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: (m) => warnings.push(m) },
      tmuxFactory: factory,
    };
    const rc = await spawnEpic(["e-viewer-down", "--from", "parent-team"], opts);
    expect(rc).toBe(0);

    // No window created because the parent session wasn't alive.
    expect(newWindowCalls).toHaveLength(0);
    // The soft-fail warn surfaced (parent session not running).
    expect(warnings.some((w) => /not running/.test(w))).toBe(true);

    // The spawn's structural side-effects still landed — proves the viewer
    // step is non-load-bearing (cockpit entry present).
    const cockpitRaw = JSON.parse(await readFile(cockpitPath, "utf8"));
    expect(cockpitRaw.sessions[0].sessions[0].name).toBe("e-viewer-down");
  });

  test("idempotent — viewer window already present → no duplicate newWindow call", async () => {
    // Seed the parent's window list with the viewer window already there
    // (the shape a re-spawn or a prior cold-boot start would leave). The
    // helper's window-name check must short-circuit before newWindow.
    const { factory, newWindowCalls } = makeViewerTmuxFactory({
      aliveSessions: ["atmux-parent-team"],
      preexistingWindows: [
        { name: "lead", index: 0 },
        { name: "🌳-e-viewer-dup", index: 1 },
      ],
    });
    const opts: SpawnEpicOpts = {
      cockpitPath,
      probeHostPressure: permissivePressure,
      templatesDir,
      callerScope: () => "driver",
      eligibilityProbe: permissiveEligibility,
      git: makeGitStub({ initialBranch: "main" }),
      logger: { log: () => undefined, warn: () => undefined },
      tmuxFactory: factory,
    };
    const rc = await spawnEpic(["e-viewer-dup", "--from", "parent-team"], opts);
    expect(rc).toBe(0);
    // No new window — the existing one was detected by name.
    expect(newWindowCalls).toHaveLength(0);
  });
});
