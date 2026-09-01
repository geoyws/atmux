// Unit tests for `atmux lane-drift-check` — ADR-062 §Decision (5) +
// §OQ5. Verb-side coverage:
//   - argv parser: --threshold-min / --commits / --reset / --dry-run /
//     --team-dir + mutual exclusion + bad values.
//   - runLaneDriftCheck: --dry-run vs --reset behavior; flag append
//     integration; report-only default; per-decision count summary.
//
// The pure-helper combination matrix lives in
// `tests/unit/core/lane-drift.test.ts`. The verb-side test wires
// injected `listInProgressTasks` + `classifyMember` + `git` + recorders
// for moveTask + raiseFlag, so no real kanban DB / tmux / git is needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { PaneClassification } from "../../../src/core/pane-state.ts";
import { UsageError } from "../../../src/errors.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  buildChildrenByParentId,
  laneDriftCheck,
  parseLaneDriftCheckArgs,
  runLaneDriftCheck,
} from "../../../src/verbs/lane-drift-check.ts";

// ---------- Argv parser ----------

describe("parseLaneDriftCheckArgs", () => {
  test("defaults: threshold=30, commits=30, reset=false, dryRun=false", () => {
    const p = parseLaneDriftCheckArgs([]);
    expect(p.thresholdMin).toBe(30);
    expect(p.commits).toBe(30);
    expect(p.reset).toBe(false);
    expect(p.dryRun).toBe(false);
  });

  test("--threshold-min N parses N", () => {
    expect(parseLaneDriftCheckArgs(["--threshold-min", "60"]).thresholdMin).toBe(60);
  });

  test("--commits N parses N", () => {
    expect(parseLaneDriftCheckArgs(["--commits", "50"]).commits).toBe(50);
  });

  test("--reset toggles reset=true", () => {
    expect(parseLaneDriftCheckArgs(["--reset"]).reset).toBe(true);
  });

  test("--dry-run toggles dryRun=true", () => {
    expect(parseLaneDriftCheckArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("--team-dir <dir> parses", () => {
    expect(parseLaneDriftCheckArgs(["--team-dir", "/tmp/foo"]).teamDir).toBe("/tmp/foo");
  });

  test("missing value for --threshold-min → UsageError", () => {
    expect(() => parseLaneDriftCheckArgs(["--threshold-min"])).toThrow(UsageError);
  });

  test("non-numeric --threshold-min → UsageError", () => {
    expect(() => parseLaneDriftCheckArgs(["--threshold-min", "abc"])).toThrow(UsageError);
  });

  test("zero / negative --threshold-min → UsageError", () => {
    expect(() => parseLaneDriftCheckArgs(["--threshold-min", "0"])).toThrow(UsageError);
    expect(() => parseLaneDriftCheckArgs(["--threshold-min", "-5"])).toThrow(UsageError);
  });

  test("missing --commits value → UsageError", () => {
    expect(() => parseLaneDriftCheckArgs(["--commits"])).toThrow(UsageError);
  });

  test("--reset and --dry-run together → UsageError (mutually exclusive)", () => {
    expect(() => parseLaneDriftCheckArgs(["--reset", "--dry-run"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseLaneDriftCheckArgs(["--bogus"])).toThrow(UsageError);
  });

  test("missing --team-dir value → UsageError", () => {
    expect(() => parseLaneDriftCheckArgs(["--team-dir"])).toThrow(UsageError);
  });
});

// ---------- runLaneDriftCheck ----------

describe("runLaneDriftCheck — verb-side dry-run / reset / report-only", () => {
  const NOW_SEC = 1_700_000_000;
  const TEAM: Team = {
    name: "demo",
    members: [
      { name: "alice", role: "member", tui: "claude" },
      { name: "bob", role: "member", tui: "claude" },
    ],
    whip: {
      staleMin: 90,
      leadMaxMin: 60,
      heartbeatStaleSec: 300,
      stallPrevention: { heartbeatStaleSec: 300 },
      autoRotate: true,
      autoSend: true,
      autoPush: { enabled: false, rebase: true, allowedPushBranches: [] },
      stallPreventionDefaults: { heartbeatStaleSec: 300 },
      cursorSelfHeal: { enabled: false },
      budgetPauseThreshold: 90,
      budgetResumeThreshold: 80,
      budgetWarningBands: [0.5, 0.25, 0.15],
      budgetRefreshLeadMins: 30,
      accountSwapEnabledDefault: false,
      accountSwapMaxAttempts: 3,
      accountSwapHealthThresholdPct: 50,
      accountSwapExcludeRoles: ["lead", "planner", "reviewer"],
    },
  } as unknown as Team;

  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-drift-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    // Seed session anchor so getSessionName doesn't fail.
    await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: TEAM.name, members: TEAM.members }),
    );
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  /** Build a drifty 1-task fixture: claimedAgoMin=60, pane COMPACTING,
   *  no commit ref. */
  function driftyFixture(): {
    inProgressTasks: KanbanTask[];
    classifyMember: (m: string) => Promise<PaneClassification | null>;
    git: (argv: ReadonlyArray<string>) => Promise<SpawnResult>;
  } {
    const tasks: KanbanTask[] = [
      {
        id: "t-deadbeef",
        owner: "alice",
        status: "in-progress",
        claimedAt: NOW_SEC - 60 * 60,
      },
    ];
    const classifyMember = async (m: string): Promise<PaneClassification | null> =>
      m === "alice"
        ? { state: "COMPACTING", evidence: "Compacting conversation", capturedAt: NOW_SEC * 1000 }
        : null;
    const git = async (_argv: ReadonlyArray<string>): Promise<SpawnResult> => ({
      cmd: "git",
      argv: ["log"],
      exitCode: 0,
      signalled: null,
      stdout: "abc1234\nfeat(unrelated): nothing\n\n--END--\n",
      stderr: "",
      durationMs: 1,
    });
    return { inProgressTasks: tasks, classifyMember, git };
  }

  test("default report-only mode: drift identified but NO mutation, NO flag write", async () => {
    const fx = driftyFixture();
    let moveCalls = 0;
    let flagCalls = 0;
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: false, dryRun: false },
      {
        listInProgressTasks: async () => fx.inProgressTasks,
        classifyMember: fx.classifyMember,
        git: fx.git,
        moveTask: async () => {
          moveCalls++;
        },
        raiseFlag: async () => {
          flagCalls++;
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.scanned).toBe(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.action).toBe("revert");
    expect(result.reverted).toBe(0);
    expect(result.flagsRaised).toBe(0);
    expect(moveCalls).toBe(0);
    expect(flagCalls).toBe(0);
  });

  test("--dry-run mode: same as report-only — drift surfaced, no mutation", async () => {
    const fx = driftyFixture();
    let moveCalls = 0;
    let flagCalls = 0;
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: false, dryRun: true },
      {
        listInProgressTasks: async () => fx.inProgressTasks,
        classifyMember: fx.classifyMember,
        git: fx.git,
        moveTask: async () => {
          moveCalls++;
        },
        raiseFlag: async () => {
          flagCalls++;
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.action).toBe("revert");
    expect(result.reverted).toBe(0);
    expect(result.flagsRaised).toBe(0);
    expect(moveCalls).toBe(0);
    expect(flagCalls).toBe(0);
  });

  test("--reset mode: revert to todo + raise flag", async () => {
    const fx = driftyFixture();
    const moveCalls: { id: string; status: string }[] = [];
    const flagCalls: string[] = [];
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => fx.inProgressTasks,
        classifyMember: fx.classifyMember,
        git: fx.git,
        moveTask: async (_dir: string, id: string, status: string) => {
          moveCalls.push({ id, status });
        },
        raiseFlag: async (_dir: string, body: string) => {
          flagCalls.push(body);
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.action).toBe("revert");
    expect(result.reverted).toBe(1);
    expect(result.flagsRaised).toBe(1);
    expect(moveCalls).toEqual([{ id: "t-deadbeef", status: "todo" }]);
    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0]).toContain("lane-drift-revert: t-deadbeef");
    expect(flagCalls[0]).toContain("auto-reverted to todo");
  });

  test("--reset: skip-decision tasks neither move nor raise", async () => {
    // Mixed fixture: one drifty (revert) + one ready (skip).
    const tasks: KanbanTask[] = [
      {
        id: "t-deadbeef",
        owner: "alice",
        status: "in-progress",
        claimedAt: NOW_SEC - 60 * 60,
      },
      {
        id: "t-cafebabe",
        owner: "bob",
        status: "in-progress",
        claimedAt: NOW_SEC - 60 * 60,
      },
    ];
    const classifyMember = async (m: string): Promise<PaneClassification | null> =>
      m === "alice"
        ? { state: "COMPACTING", evidence: "Compacting", capturedAt: NOW_SEC * 1000 }
        : { state: "READY", evidence: ">", capturedAt: NOW_SEC * 1000 };
    const git = async (_argv: ReadonlyArray<string>): Promise<SpawnResult> => ({
      cmd: "git",
      argv: ["log"],
      exitCode: 0,
      signalled: null,
      stdout: "no refs\n--END--\n",
      stderr: "",
      durationMs: 1,
    });
    const moveCalls: { id: string }[] = [];
    const flagCalls: string[] = [];
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => tasks,
        classifyMember,
        git,
        moveTask: async (_dir: string, id: string) => {
          moveCalls.push({ id });
        },
        raiseFlag: async (_dir: string, body: string) => {
          flagCalls.push(body);
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions).toHaveLength(2);
    expect(result.reverted).toBe(1);
    expect(result.flagsRaised).toBe(1);
    expect(moveCalls).toEqual([{ id: "t-deadbeef" }]);
    expect(flagCalls).toHaveLength(1);
  });

  test("--reset: moveTask error skips flag write for that task", async () => {
    const fx = driftyFixture();
    const flagCalls: string[] = [];
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => fx.inProgressTasks,
        classifyMember: fx.classifyMember,
        git: fx.git,
        moveTask: async () => {
          throw new Error("kanban locked");
        },
        raiseFlag: async (_dir: string, body: string) => {
          flagCalls.push(body);
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    // Decision still says revert (helper is pure), but reverted=0 and
    // no flag fired (move error short-circuits flag).
    expect(result.decisions[0]?.action).toBe("revert");
    expect(result.reverted).toBe(0);
    expect(result.flagsRaised).toBe(0);
    expect(flagCalls).toHaveLength(0);
  });

  test("--reset: raiseFlag error doesn't block the revert mutation", async () => {
    const fx = driftyFixture();
    const moveCalls: { id: string }[] = [];
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => fx.inProgressTasks,
        classifyMember: fx.classifyMember,
        git: fx.git,
        moveTask: async (_dir: string, id: string) => {
          moveCalls.push({ id });
        },
        raiseFlag: async () => {
          throw new Error("flags.md unwritable");
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.reverted).toBe(1);
    expect(result.flagsRaised).toBe(0);
    expect(moveCalls).toEqual([{ id: "t-deadbeef" }]);
  });

  test("--reset: default raiseFlag appends to <atmuxDir>/flags.md (integration)", async () => {
    const fx = driftyFixture();
    await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => fx.inProgressTasks,
        classifyMember: fx.classifyMember,
        git: fx.git,
        // No raiseFlag override — exercise the default that writes to flags.md.
        moveTask: async () => {},
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    const flagsPath = join(atmuxDir, "flags.md");
    expect(existsSync(flagsPath)).toBe(true);
    const body = await readFile(flagsPath, "utf8");
    expect(body).toContain("lane-drift-revert: t-deadbeef");
    expect(body).toContain("auto-reverted to todo");
    expect(body.startsWith("- ")).toBe(true);
  });

  test("git log failure: commitsScanned=0 and decisions still produced", async () => {
    const tasks: KanbanTask[] = [
      {
        id: "t-deadbeef",
        owner: "alice",
        status: "in-progress",
        claimedAt: NOW_SEC - 60 * 60,
      },
    ];
    const classifyMember = async (_m: string): Promise<PaneClassification | null> => ({
      state: "COMPACTING",
      evidence: "Compacting",
      capturedAt: NOW_SEC * 1000,
    });
    const git = async (_argv: ReadonlyArray<string>): Promise<SpawnResult> => ({
      cmd: "git",
      argv: ["log"],
      exitCode: 128,
      signalled: null,
      stdout: "",
      stderr: "fatal: not a git repository\n",
      durationMs: 1,
    });
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: false, dryRun: false },
      {
        listInProgressTasks: async () => tasks,
        classifyMember,
        git,
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.evidence.commitsScanned).toBe(0);
    expect(result.decisions[0]?.evidence.hasCommitRef).toBe(false);
    expect(result.decisions[0]?.action).toBe("revert");
  });

  test("empty in-progress kanban → scanned=0, no decisions, no work", async () => {
    let moveCalls = 0;
    let flagCalls = 0;
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => [],
        classifyMember: async () => null,
        git: async () => ({
          cmd: "git",
          argv: [],
          exitCode: 0,
          signalled: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
        }),
        moveTask: async () => {
          moveCalls++;
        },
        raiseFlag: async () => {
          flagCalls++;
        },
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.scanned).toBe(0);
    expect(result.decisions).toHaveLength(0);
    expect(result.reverted).toBe(0);
    expect(result.flagsRaised).toBe(0);
    expect(moveCalls).toBe(0);
    expect(flagCalls).toBe(0);
  });

  test("commitsScanned counts --END-- markers correctly", async () => {
    const tasks: KanbanTask[] = [
      {
        id: "t-aaaaaaaa",
        owner: "alice",
        status: "in-progress",
        claimedAt: NOW_SEC - 60 * 60,
      },
    ];
    const git = async (_argv: ReadonlyArray<string>): Promise<SpawnResult> => ({
      cmd: "git",
      argv: ["log"],
      exitCode: 0,
      signalled: null,
      stdout:
        "abc1234\nsubject 1\nbody1\n--END--\ndef5678\nsubject 2\n--END--\n012abcd\nsubject 3\n--END--\n",
      stderr: "",
      durationMs: 1,
    });
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM,
      { thresholdMin: 30, commits: 30, reset: false, dryRun: false },
      {
        listInProgressTasks: async () => tasks,
        classifyMember: async () => ({
          state: "COMPACTING",
          evidence: "Compacting",
          capturedAt: NOW_SEC * 1000,
        }),
        git,
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.evidence.commitsScanned).toBe(3);
  });
});

// ---------- buildChildrenByParentId (ADR-176 criterion (d) indexing) ----------

describe("buildChildrenByParentId", () => {
  test("indexes children by their .epic parent id", () => {
    const tasks: KanbanTask[] = [
      { id: "t-parent", status: "in-progress" },
      { id: "t-c1", epic: "t-parent", status: "in-progress" },
      { id: "t-c2", epic: "t-parent", status: "todo" },
      { id: "t-c3", epic: "t-other", status: "done" },
    ];
    const map = buildChildrenByParentId(tasks);
    expect(map.get("t-parent")?.map((t) => t.id)).toEqual(["t-c1", "t-c2"]);
    expect(map.get("t-other")?.map((t) => t.id)).toEqual(["t-c3"]);
    // The parent itself is not a key (it has no `.epic`).
    expect(map.has("t-c1")).toBe(false);
  });

  test("skips tasks with null / empty / absent epic", () => {
    const tasks: KanbanTask[] = [
      { id: "t-a", status: "todo" },
      { id: "t-b", epic: null, status: "todo" },
      { id: "t-c", epic: "", status: "todo" },
      { id: "t-d", epic: "t-p", status: "todo" },
    ];
    const map = buildChildrenByParentId(tasks);
    expect(map.size).toBe(1);
    expect(map.get("t-p")?.map((t) => t.id)).toEqual(["t-d"]);
  });

  test("empty input → empty map", () => {
    expect(buildChildrenByParentId([]).size).toBe(0);
  });
});

describe("runLaneDriftCheck — ADR-176 criterion (d) threaded end-to-end", () => {
  const NOW_SEC = 1_700_000_000;
  const TEAM2: Team = {
    name: "demo",
    members: [{ name: "planner", role: "planner", tui: "claude" }],
  } as unknown as Team;

  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-drift-d-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: TEAM2.name, members: TEAM2.members }),
    );
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  /** EPIC parent that would revert under the 3-criterion algorithm
   *  (claimed 60min ago, pane COMPACTING, no commit ref to its own id). */
  const parent: KanbanTask = {
    id: "t-parent01",
    owner: "planner",
    status: "in-progress",
    claimedAt: NOW_SEC - 60 * 60,
  };
  const classifyPlanner = async (m: string): Promise<PaneClassification | null> =>
    m === "planner"
      ? { state: "COMPACTING", evidence: "Compacting", capturedAt: NOW_SEC * 1000 }
      : null;
  const gitNoRefs = async (_argv: ReadonlyArray<string>): Promise<SpawnResult> => ({
    cmd: "git",
    argv: ["log"],
    exitCode: 0,
    signalled: null,
    stdout: "abc1234\nfeat(unrelated): nothing\n\n--END--\n",
    stderr: "",
    durationMs: 1,
  });

  test("EPIC parent with progressing child → skip (no revert) even under --reset", async () => {
    const moveCalls: string[] = [];
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM2,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => [parent],
        listAllTasks: async () => [
          parent,
          { id: "t-child01", epic: "t-parent01", status: "in-progress" },
        ],
        classifyMember: classifyPlanner,
        git: gitNoRefs,
        moveTask: async (_dir: string, id: string) => {
          moveCalls.push(id);
        },
        raiseFlag: async () => {},
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.action).toBe("skip");
    expect(result.decisions[0]?.reason).toBe("epic-children-progressing");
    expect(result.reverted).toBe(0);
    expect(moveCalls).toEqual([]); // criterion (d) prevented the revert.
  });

  test("EPIC parent with all-todo children → STILL reverts (todo doesn't count)", async () => {
    const moveCalls: string[] = [];
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM2,
      { thresholdMin: 30, commits: 30, reset: true, dryRun: false },
      {
        listInProgressTasks: async () => [parent],
        listAllTasks: async () => [parent, { id: "t-child01", epic: "t-parent01", status: "todo" }],
        classifyMember: classifyPlanner,
        git: gitNoRefs,
        moveTask: async (_dir: string, id: string) => {
          moveCalls.push(id);
        },
        raiseFlag: async () => {},
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.action).toBe("revert");
    expect(result.reverted).toBe(1);
    expect(moveCalls).toEqual(["t-parent01"]);
  });

  test("default listAllTasks load is wired (no override) — reads real kanban DB without throwing", async () => {
    // No listAllTasks override: exercises the default listTasks(atmuxDir)
    // path. The temp atmuxDir has no kanban rows, so the children map is
    // empty → criterion (d) no-ops → the drifty parent reverts (report-only
    // here so no DB write is attempted).
    const result = await runLaneDriftCheck(
      atmuxDir,
      TEAM2,
      { thresholdMin: 30, commits: 30, reset: false, dryRun: false },
      {
        listInProgressTasks: async () => [parent],
        classifyMember: classifyPlanner,
        git: gitNoRefs,
        nowSec: () => NOW_SEC,
        log: () => {},
      },
    );
    expect(result.decisions[0]?.action).toBe("revert");
  });
});

// ---------- Verb argv-driven entrypoint ----------

describe("laneDriftCheck (entrypoint)", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-drift-cli-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "demo", members: [{ name: "alice" }] }),
    );
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("argv parse + flow: returns 0 with --team-dir override + injected deps", async () => {
    const exit = await laneDriftCheck(["--team-dir", teamDir, "--reset"], {
      listInProgressTasks: async () => [],
      classifyMember: async () => null,
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      moveTask: async () => {},
      raiseFlag: async () => {},
      log: () => {},
    });
    expect(exit).toBe(0);
  });

  test("--reset and --dry-run both passed → UsageError", async () => {
    let caught: unknown = null;
    try {
      await laneDriftCheck(["--reset", "--dry-run", "--team-dir", teamDir]);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof UsageError).toBe(true);
  });
});
