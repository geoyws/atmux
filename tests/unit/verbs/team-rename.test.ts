// Unit tests for src/verbs/team-rename.ts (ADR-027 T1).
// Pure helpers + arg parser — no I/O. Every export exercised across
// happy / refuse / bypass branches for 100% line + branch coverage.

import { describe, expect, test } from "bun:test";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { Cockpit } from "../../../src/schema/cockpit.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";
import {
  collidesWithCockpit,
  hasInProgressTasks,
  parseTeamRenameArgs,
  type RollbackStep,
  rollbackWalk,
  runRefuseGates,
  validateTeamName,
} from "../../../src/verbs/team-rename.ts";

// ---------- parseTeamRenameArgs ----------

describe("parseTeamRenameArgs", () => {
  test("happy path — positional only", () => {
    expect(parseTeamRenameArgs(["acme"])).toEqual({
      newName: "acme",
      dryRun: false,
      force: false,
      forceBranches: false,
    });
  });

  test("missing positional → UsageError", () => {
    expect(() => parseTeamRenameArgs([])).toThrow(UsageError);
    expect(() => parseTeamRenameArgs(["--dry-run"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseTeamRenameArgs(["--nope", "acme"])).toThrow(UsageError);
  });

  test("duplicate flag → UsageError", () => {
    expect(() => parseTeamRenameArgs(["--dry-run", "--dry-run", "acme"])).toThrow(UsageError);
    expect(() => parseTeamRenameArgs(["--from", "old", "--from", "old2", "acme"])).toThrow(
      UsageError,
    );
  });

  test("--dry-run + --force combo", () => {
    expect(parseTeamRenameArgs(["--dry-run", "--force", "acme"])).toEqual({
      newName: "acme",
      dryRun: true,
      force: true,
      forceBranches: false,
    });
  });

  test("--from override captured", () => {
    expect(parseTeamRenameArgs(["--from", "atmux-kanban", "atmux"])).toEqual({
      newName: "atmux",
      dryRun: false,
      force: false,
      forceBranches: false,
      from: "atmux-kanban",
    });
  });

  test("--session override captured", () => {
    expect(parseTeamRenameArgs(["--session", "atmux", "acme"])).toEqual({
      newName: "acme",
      dryRun: false,
      force: false,
      forceBranches: false,
      session: "atmux",
    });
  });

  test("--force-branches round-trip", () => {
    expect(parseTeamRenameArgs(["--force-branches", "acme"])).toEqual({
      newName: "acme",
      dryRun: false,
      force: false,
      forceBranches: true,
    });
  });

  test("--socket + --team-dir captured", () => {
    expect(parseTeamRenameArgs(["--socket", "/s", "--team-dir", "/d", "acme"])).toEqual({
      newName: "acme",
      dryRun: false,
      force: false,
      forceBranches: false,
      socketPath: "/s",
      teamDir: "/d",
    });
  });

  test("value-flag without arg → UsageError", () => {
    expect(() => parseTeamRenameArgs(["--from"])).toThrow(UsageError);
    expect(() => parseTeamRenameArgs(["--session"])).toThrow(UsageError);
    expect(() => parseTeamRenameArgs(["--socket"])).toThrow(UsageError);
    expect(() => parseTeamRenameArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("too many positionals → UsageError", () => {
    expect(() => parseTeamRenameArgs(["acme", "bravo"])).toThrow(UsageError);
  });

  test("all flags + positional, mixed order", () => {
    expect(
      parseTeamRenameArgs([
        "--from",
        "old",
        "--session",
        "new-sess",
        "--dry-run",
        "--force",
        "--force-branches",
        "--socket",
        "/s",
        "--team-dir",
        "/d",
        "new-name",
      ]),
    ).toEqual({
      newName: "new-name",
      from: "old",
      session: "new-sess",
      dryRun: true,
      force: true,
      forceBranches: true,
      socketPath: "/s",
      teamDir: "/d",
    });
  });
});

// ---------- validateTeamName ----------

describe("validateTeamName", () => {
  test("valid names pass silently", () => {
    expect(() => validateTeamName("atmux")).not.toThrow();
    expect(() => validateTeamName("myteam-1")).not.toThrow();
    expect(() => validateTeamName("a_b")).not.toThrow();
    expect(() => validateTeamName("a")).not.toThrow();
    expect(() => validateTeamName("e-1e223687")).not.toThrow();
  });

  test("uppercase rejected", () => {
    expect(() => validateTeamName("Atmux")).toThrow(ConfigError);
  });

  test("space rejected", () => {
    expect(() => validateTeamName("my team")).toThrow(ConfigError);
  });

  test("empty rejected", () => {
    expect(() => validateTeamName("")).toThrow(ConfigError);
  });

  test("special chars rejected", () => {
    expect(() => validateTeamName("team!")).toThrow(ConfigError);
    expect(() => validateTeamName("team.x")).toThrow(ConfigError);
    expect(() => validateTeamName("team/x")).toThrow(ConfigError);
  });
});

// ---------- hasInProgressTasks ----------

describe("hasInProgressTasks", () => {
  test("empty → false", () => {
    expect(hasInProgressTasks([])).toBe(false);
  });

  test("only todo/done → false", () => {
    const tasks: KanbanTask[] = [
      { id: "t-1", status: "todo" },
      { id: "t-2", status: "done" },
      { id: "t-3", status: "blocked" },
    ];
    expect(hasInProgressTasks(tasks)).toBe(false);
  });

  test("one in-progress → true", () => {
    const tasks: KanbanTask[] = [
      { id: "t-1", status: "todo" },
      { id: "t-2", status: "in-progress" },
    ];
    expect(hasInProgressTasks(tasks)).toBe(true);
  });

  test("task with missing status → false", () => {
    const tasks: KanbanTask[] = [{ id: "t-1" }];
    expect(hasInProgressTasks(tasks)).toBe(false);
  });
});

// ---------- collidesWithCockpit ----------

function emptyCockpit(): Cockpit {
  return { schemaVersion: 1, cockpitSession: "atmux_cockpit", sessions: [] };
}

describe("collidesWithCockpit", () => {
  test("empty sessions → no collision", () => {
    expect(collidesWithCockpit(emptyCockpit(), "anything")).toBe(false);
  });

  test("top-level team match → collision", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        {
          type: "team",
          name: "atmux",
          enabled: true,
          root: "/r",
          sessions: [],
        },
      ],
    };
    expect(collidesWithCockpit(c, "atmux")).toBe(true);
    expect(collidesWithCockpit(c, "other")).toBe(false);
  });

  test("epic-team with same name does NOT collide (different namespace)", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        {
          type: "epic-team",
          name: "e-1",
          enabled: true,
          parent: "atmux",
          epicId: "e-1",
          sessions: [],
        },
      ],
    };
    expect(collidesWithCockpit(c, "e-1")).toBe(false);
  });

  test("nested team inside team match → collision (DFS)", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        {
          type: "team",
          name: "parent",
          enabled: true,
          root: "/r",
          sessions: [
            {
              type: "team",
              name: "child",
              enabled: true,
              root: "/r2",
              sessions: [],
            },
          ],
        },
      ],
    };
    expect(collidesWithCockpit(c, "child")).toBe(true);
  });

  test("nested team inside epic-team match → collision (DFS through epic-team)", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        {
          type: "epic-team",
          name: "e-1",
          enabled: true,
          parent: "atmux",
          epicId: "e-1",
          sessions: [
            {
              type: "team",
              name: "deep",
              enabled: true,
              root: "/r",
              sessions: [],
            },
          ],
        },
      ],
    };
    expect(collidesWithCockpit(c, "deep")).toBe(true);
  });

  test("non-team siblings ignored (superdriver / medic / sentinel)", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        { type: "superdriver", name: "atmux", enabled: true },
        { type: "medic", name: "atmux", enabled: true },
        { type: "sentinel", name: "atmux", enabled: true },
      ],
    };
    expect(collidesWithCockpit(c, "atmux")).toBe(false);
  });
});

// ---------- runRefuseGates ----------

describe("runRefuseGates", () => {
  const baseInput = (over: {
    tasks?: KanbanTask[];
    cockpit?: Cockpit;
    newName?: string;
    force?: boolean;
  }) => ({
    tasks: over.tasks ?? [],
    cockpit: over.cockpit ?? emptyCockpit(),
    newName: over.newName ?? "newteam",
    force: over.force ?? false,
  });

  test("happy path → refuse=false", () => {
    expect(runRefuseGates(baseInput({}))).toEqual({ refuse: false });
  });

  test("invalid name → hard refuse with EX_CONFIG", () => {
    const r = runRefuseGates(baseInput({ newName: "Bad Name" }));
    expect(r.refuse).toBe(true);
    expect(r.exitCode).toBe(78);
    expect(r.reason).toMatch(/invalid team-name/);
  });

  test("invalid name not bypassable by --force", () => {
    const r = runRefuseGates(baseInput({ newName: "Bad Name", force: true }));
    expect(r.refuse).toBe(true);
    expect(r.reason).toMatch(/invalid team-name/);
  });

  test("collision → hard refuse", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        {
          type: "team",
          name: "atmux",
          enabled: true,
          root: "/r",
          sessions: [],
        },
      ],
    };
    const r = runRefuseGates(baseInput({ newName: "atmux", cockpit: c }));
    expect(r.refuse).toBe(true);
    expect(r.exitCode).toBe(78);
    expect(r.reason).toMatch(/collision/);
  });

  test("collision not bypassable by --force", () => {
    const c: Cockpit = {
      ...emptyCockpit(),
      sessions: [
        {
          type: "team",
          name: "atmux",
          enabled: true,
          root: "/r",
          sessions: [],
        },
      ],
    };
    const r = runRefuseGates(baseInput({ newName: "atmux", cockpit: c, force: true }));
    expect(r.refuse).toBe(true);
    expect(r.reason).toMatch(/collision/);
  });

  test("in-progress refuse without --force", () => {
    const tasks: KanbanTask[] = [{ id: "t-1", status: "in-progress" }];
    const r = runRefuseGates(baseInput({ tasks }));
    expect(r.refuse).toBe(true);
    expect(r.exitCode).toBe(78);
    expect(r.reason).toMatch(/in-progress/);
  });

  test("--force bypasses in-progress refuse", () => {
    const tasks: KanbanTask[] = [{ id: "t-1", status: "in-progress" }];
    expect(runRefuseGates(baseInput({ tasks, force: true }))).toEqual({ refuse: false });
  });
});

// ---------- rollbackWalk ----------

describe("rollbackWalk", () => {
  test("empty completed → walked=0, no failures", async () => {
    const r = await rollbackWalk([]);
    expect(r.walked).toBe(0);
    expect(r.failures).toEqual([]);
  });

  test("single step undone", async () => {
    const calls: string[] = [];
    const steps: RollbackStep[] = [{ label: "s1", undo: async () => void calls.push("s1") }];
    const r = await rollbackWalk(steps);
    expect(r.walked).toBe(1);
    expect(r.failures).toEqual([]);
    expect(calls).toEqual(["s1"]);
  });

  test("multi-step walked in reverse order", async () => {
    const calls: string[] = [];
    const steps: RollbackStep[] = [
      { label: "s1", undo: async () => void calls.push("s1") },
      { label: "s2", undo: async () => void calls.push("s2") },
      { label: "s3", undo: async () => void calls.push("s3") },
    ];
    const r = await rollbackWalk(steps);
    expect(r.walked).toBe(3);
    expect(r.failures).toEqual([]);
    expect(calls).toEqual(["s3", "s2", "s1"]);
  });

  test("undo-throws collected into failures, walk continues", async () => {
    const calls: string[] = [];
    const boom = new Error("boom");
    const steps: RollbackStep[] = [
      { label: "s1", undo: async () => void calls.push("s1") },
      {
        label: "s2",
        undo: async () => {
          throw boom;
        },
      },
      { label: "s3", undo: async () => void calls.push("s3") },
    ];
    const r = await rollbackWalk(steps);
    expect(r.walked).toBe(3);
    expect(calls).toEqual(["s3", "s1"]);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]?.step.label).toBe("s2");
    expect(r.failures[0]?.error).toBe(boom);
  });
});
