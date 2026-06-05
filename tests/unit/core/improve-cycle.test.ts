// Unit tests for src/core/improve-cycle.ts (ADR-052 T7 cycle mechanics).
//
// Coverage:
//   - openCycle / closeCycle (history append + cap + budget decrement)
//   - pauseCycle / resumeCycle (paused flag set + clear + idempotence)
//   - recordDispatch / recordLanded / recordDone (idempotent appends)
//   - tickTokens (negative delta clamped to 0)
//   - isCycleClosable (status: 'done' AND completedAt non-null) +
//     custom commitChecker injection
//   - shouldTerminate (budgetRemaining ≤ 0 boundary)
//   - isDriverPreempt (in-progress + epic !== improvement)
//   - buildArmMessage (template format)
//   - armCycle (file write side-effect; first-call writes header)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_RING_MAX } from "../../../src/core/improve.ts";
import {
  armCycle,
  buildArmMessage,
  closeCycle,
  defaultCommitChecker,
  IMPROVEMENT_EPIC_ID,
  improveDirectivesPath,
  isCycleClosable,
  isDriverPreempt,
  openCycle,
  pauseCycle,
  recordDispatch,
  recordDone,
  recordLanded,
  resumeCycle,
  selectLongstandingIssues,
  shouldTerminate,
  tickTokens,
} from "../../../src/core/improve-cycle.ts";
import type { EternalImprovementState } from "../../../src/schema/eternal-improvement.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-cycle-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Sample state ----------

function baseState(overrides?: Partial<EternalImprovementState>): EternalImprovementState {
  return {
    active: true,
    runId: "ei-deadbeef",
    startedAt: 1_800_000_000,
    mode: "user-invoked",
    budgetSpec: "1000000",
    budgetTotal: 1_000_000,
    budgetRemaining: 1_000_000,
    cycleN: 0,
    currentCycle: null,
    lastCycleClosedAt: null,
    history: [],
    ...overrides,
  };
}

function task(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    epic: null,
    completedAt: null,
    ...overrides,
  } as KanbanTask;
}

// ---------- Constants ----------

describe("constants", () => {
  test("IMPROVEMENT_EPIC_ID matches ADR-052 epic", () => {
    expect(IMPROVEMENT_EPIC_ID).toBe("e-a25968cc");
  });
});

// ---------- selectLongstandingIssues (ADR-257 §D1) ----------

describe("selectLongstandingIssues", () => {
  const NOW = 2_000_000;
  test("ranks open todos oldest-first, tie-break by priority (lower=higher)", () => {
    const tasks = [
      task({ id: "t-new", status: "todo", createdAt: 1_900_000, priority: 0 }),
      task({ id: "t-oldest", status: "todo", createdAt: 1_000_000, priority: 5 }),
      task({ id: "t-mid", status: "todo", createdAt: 1_500_000, priority: 1 }),
    ];
    const out = selectLongstandingIssues(tasks, NOW);
    expect(out.map((i) => i.id)).toEqual(["t-oldest", "t-mid", "t-new"]);
    expect(out[0]?.ageSec).toBe(NOW - 1_000_000);
  });

  test("tie on createdAt → lower priority number wins", () => {
    const tasks = [
      task({ id: "t-lo", status: "todo", createdAt: 1_000_000, priority: 3 }),
      task({ id: "t-hi", status: "todo", createdAt: 1_000_000, priority: 1 }),
    ];
    expect(selectLongstandingIssues(tasks, NOW).map((i) => i.id)).toEqual(["t-hi", "t-lo"]);
  });

  test("excludes non-todo, the improvement epic, and driverOnly Tasks", () => {
    const tasks = [
      task({ id: "t-done", status: "done", createdAt: 1_000_000 }),
      task({ id: "t-inprog", status: "in-progress", createdAt: 1_000_000 }),
      task({ id: "t-improve", status: "todo", createdAt: 1_000_000, epic: IMPROVEMENT_EPIC_ID }),
      task({ id: "t-driver", status: "todo", createdAt: 1_000_000, driverOnly: true }),
      task({ id: "t-ok", status: "todo", createdAt: 1_100_000 }),
    ];
    expect(selectLongstandingIssues(tasks, NOW).map((i) => i.id)).toEqual(["t-ok"]);
  });

  test("honors the limit (default 3)", () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      task({ id: `t-${i}`, status: "todo", createdAt: 1_000_000 + i }),
    );
    expect(selectLongstandingIssues(tasks, NOW)).toHaveLength(3);
    expect(selectLongstandingIssues(tasks, NOW, { limit: 2 })).toHaveLength(2);
  });

  test("empty backlog → empty selection (drives the net-new fallback directive)", () => {
    expect(selectLongstandingIssues([], NOW)).toEqual([]);
  });
});

// ---------- buildArmMessage (ADR-257 burndown-first) ----------

describe("buildArmMessage", () => {
  test("no longstanding items → net-new fallback + worktree-isolation contract", () => {
    const msg = buildArmMessage(3);
    expect(msg).toContain("cycle 3 requested");
    expect(msg).toContain("burndown-first");
    expect(msg).toContain("No longstanding backlog");
    expect(msg).toContain("ask each lane member");
    expect(msg).toContain("spawn-epic"); // isolation contract present every cycle
    expect(msg).toContain("committer");
    expect(msg.startsWith("🌱")).toBe(true);
  });

  test("longstanding items → names them oldest→newest, BEFORE net-new", () => {
    const msg = buildArmMessage(4, [
      { id: "t-old1", subject: "x", ageSec: 999, priority: 1 },
      { id: "t-old2", subject: "y", ageSec: 50, priority: 2 },
    ]);
    expect(msg).toContain("LONGSTANDING ISSUES FIRST");
    expect(msg).toContain("t-old1, t-old2");
    expect(msg).not.toContain("ask each lane member"); // net-new suppressed when backlog present
    expect(msg).toContain("spawn-epic");
    expect(msg).toContain("verified");
  });
});

// ---------- openCycle ----------

describe("openCycle", () => {
  test("increments cycleN and initializes a fresh currentCycle", () => {
    const opened = openCycle(baseState({ cycleN: 0 }), 1_800_000_500);
    expect(opened.cycleN).toBe(1);
    expect(opened.currentCycle).toEqual({
      startedAt: 1_800_000_500,
      tasksLanded: [],
      tasksDispatched: [],
      tasksDone: [],
      tokensSpent: 0,
    });
  });

  test("preserves history + budget across a re-arm cycle", () => {
    const opened = openCycle(
      baseState({
        cycleN: 5,
        budgetRemaining: 750_000,
        history: [
          { cycleN: 1, startedAt: 1, closedAt: 2, tasksLanded: 1, tasksDone: 1, tokensSpent: 100 },
        ],
      }),
      999,
    );
    expect(opened.cycleN).toBe(6);
    expect(opened.budgetRemaining).toBe(750_000);
    expect(opened.history).toHaveLength(1);
  });
});

// ---------- closeCycle ----------

describe("closeCycle", () => {
  test("moves currentCycle to history with counts + decrements budgetRemaining", () => {
    const before = baseState({
      cycleN: 1,
      budgetRemaining: 1_000_000,
      currentCycle: {
        startedAt: 1_800_000_000,
        tasksLanded: ["t-aaaaaaaa", "t-bbbbbbbb"],
        tasksDispatched: ["t-aaaaaaaa", "t-bbbbbbbb"],
        tasksDone: ["t-aaaaaaaa", "t-bbbbbbbb"],
        tokensSpent: 50_000,
      },
    });
    const closed = closeCycle(before, 1_800_001_000);
    expect(closed.currentCycle).toBeNull();
    expect(closed.lastCycleClosedAt).toBe(1_800_001_000);
    expect(closed.budgetRemaining).toBe(950_000);
    expect(closed.history).toHaveLength(1);
    expect(closed.history[0]).toEqual({
      cycleN: 1,
      startedAt: 1_800_000_000,
      closedAt: 1_800_001_000,
      tasksLanded: 2,
      tasksDone: 2,
      tokensSpent: 50_000,
    });
  });

  test("no-op when currentCycle is null", () => {
    const before = baseState({ currentCycle: null });
    const closed = closeCycle(before, 999);
    expect(closed).toBe(before);
  });

  test("history caps at HISTORY_RING_MAX (oldest dropped)", () => {
    const seedHistory = Array.from({ length: HISTORY_RING_MAX }, (_, i) => ({
      cycleN: i + 1,
      startedAt: i,
      closedAt: i + 1,
      tasksLanded: 0,
      tasksDone: 0,
      tokensSpent: 0,
    }));
    const before = baseState({
      cycleN: HISTORY_RING_MAX + 1,
      history: seedHistory,
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const closed = closeCycle(before, 999);
    expect(closed.history).toHaveLength(HISTORY_RING_MAX);
    // Oldest entry (cycleN=1) dropped; newest at the end is the just-closed one.
    expect(closed.history[0]?.cycleN).toBe(2);
    expect(closed.history.at(-1)?.cycleN).toBe(HISTORY_RING_MAX + 1);
  });

  test("mid-cycle overage allowed (budgetRemaining can go negative)", () => {
    // ADR-052 §"Loop mechanics": "feature must be fully built even
    // though a bit more tokens are used".
    const before = baseState({
      cycleN: 1,
      budgetRemaining: 100_000,
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-a"],
        tasksDone: ["t-a"],
        tokensSpent: 150_000, // overage
      },
    });
    const closed = closeCycle(before, 999);
    expect(closed.budgetRemaining).toBe(-50_000);
  });
});

// ---------- pauseCycle / resumeCycle ----------

describe("pauseCycle", () => {
  test("sets currentCycle.paused = true", () => {
    const before = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const paused = pauseCycle(before);
    expect(paused.currentCycle?.paused).toBe(true);
  });

  test("no-op when currentCycle is null", () => {
    const before = baseState({ currentCycle: null });
    expect(pauseCycle(before)).toBe(before);
  });

  test("idempotent on already-paused", () => {
    const before = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
        paused: true,
      },
    });
    const paused = pauseCycle(before);
    expect(paused.currentCycle?.paused).toBe(true);
  });
});

describe("resumeCycle", () => {
  test("clears the paused flag entirely (key removed, not flipped to false)", () => {
    const before = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
        paused: true,
      },
    });
    const resumed = resumeCycle(before);
    expect(resumed.currentCycle?.paused).toBeUndefined();
  });

  test("no-op when currentCycle is null", () => {
    const before = baseState({ currentCycle: null });
    expect(resumeCycle(before)).toBe(before);
  });

  test("no-op when not paused (returns same reference)", () => {
    const before = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    expect(resumeCycle(before)).toBe(before);
  });
});

// ---------- recordDispatch / recordLanded / recordDone ----------

describe("recordDispatch", () => {
  test("appends to tasksDispatched", () => {
    const before = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const after = recordDispatch(before, "t-aaaaaaaa");
    expect(after.currentCycle?.tasksDispatched).toEqual(["t-aaaaaaaa"]);
  });

  test("idempotent on duplicate id", () => {
    const before = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-aaaaaaaa"],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const after = recordDispatch(before, "t-aaaaaaaa");
    expect(after.currentCycle?.tasksDispatched).toEqual(["t-aaaaaaaa"]);
  });

  test("no-op when currentCycle is null", () => {
    const before = baseState({ currentCycle: null });
    expect(recordDispatch(before, "t-x")).toBe(before);
  });
});

describe("recordLanded + recordDone", () => {
  const cur = {
    startedAt: 1,
    tasksLanded: [],
    tasksDispatched: [],
    tasksDone: [],
    tokensSpent: 0,
  };

  test("recordLanded appends + idempotent", () => {
    const a = recordLanded(baseState({ currentCycle: cur }), "t-a");
    expect(a.currentCycle?.tasksLanded).toEqual(["t-a"]);
    const b = recordLanded(a, "t-a");
    expect(b.currentCycle?.tasksLanded).toEqual(["t-a"]);
  });

  test("recordLanded no-op when null currentCycle", () => {
    const before = baseState({ currentCycle: null });
    expect(recordLanded(before, "t-x")).toBe(before);
  });

  test("recordDone appends + idempotent", () => {
    const a = recordDone(baseState({ currentCycle: cur }), "t-a");
    expect(a.currentCycle?.tasksDone).toEqual(["t-a"]);
    const b = recordDone(a, "t-a");
    expect(b.currentCycle?.tasksDone).toEqual(["t-a"]);
  });

  test("recordDone no-op when null currentCycle", () => {
    const before = baseState({ currentCycle: null });
    expect(recordDone(before, "t-x")).toBe(before);
  });
});

// ---------- tickTokens ----------

describe("tickTokens", () => {
  const cur = {
    startedAt: 1,
    tasksLanded: [],
    tasksDispatched: [],
    tasksDone: [],
    tokensSpent: 1000,
  };

  test("adds positive delta", () => {
    const after = tickTokens(baseState({ currentCycle: cur }), 500);
    expect(after.currentCycle?.tokensSpent).toBe(1500);
  });

  test("clamps negative delta to 0 (no decrement)", () => {
    const after = tickTokens(baseState({ currentCycle: cur }), -500);
    expect(after.currentCycle?.tokensSpent).toBe(1000);
  });

  test("no-op when currentCycle is null", () => {
    const before = baseState({ currentCycle: null });
    expect(tickTokens(before, 500)).toBe(before);
  });
});

// ---------- isCycleClosable ----------

describe("isCycleClosable", () => {
  test("false when no current cycle", () => {
    expect(isCycleClosable(baseState({ currentCycle: null }), [])).toBe(false);
  });

  test("false when tasksDispatched is empty", () => {
    const state = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    expect(isCycleClosable(state, [])).toBe(false);
  });

  test("false when any dispatched task is missing from kanban", () => {
    const state = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-a", "t-b"],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    expect(isCycleClosable(state, [task({ id: "t-a", status: "done", completedAt: 1 })])).toBe(
      false,
    );
  });

  test("false when any task is not status:'done'", () => {
    const state = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-a", "t-b"],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const tasks = [
      task({ id: "t-a", status: "done", completedAt: 1 }),
      task({ id: "t-b", status: "in-progress", completedAt: null }),
    ];
    expect(isCycleClosable(state, tasks)).toBe(false);
  });

  test("false when status:'done' but completedAt null (gitter not yet committed)", () => {
    const state = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-a"],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const tasks = [task({ id: "t-a", status: "done", completedAt: null })];
    expect(isCycleClosable(state, tasks)).toBe(false);
  });

  test("true when all dispatched tasks are done + completedAt non-null", () => {
    const state = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-a", "t-b"],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const tasks = [
      task({ id: "t-a", status: "done", completedAt: 100 }),
      task({ id: "t-b", status: "done", completedAt: 200 }),
    ];
    expect(isCycleClosable(state, tasks)).toBe(true);
  });

  test("custom commitChecker is honored (e.g., explicit git log probe)", () => {
    const state = baseState({
      currentCycle: {
        startedAt: 1,
        tasksLanded: [],
        tasksDispatched: ["t-a"],
        tasksDone: [],
        tokensSpent: 0,
      },
    });
    const tasks = [task({ id: "t-a", status: "done", completedAt: 100 })];
    // Default checker → true. Custom checker that returns false → false.
    expect(isCycleClosable(state, tasks, defaultCommitChecker)).toBe(true);
    expect(isCycleClosable(state, tasks, () => false)).toBe(false);
  });
});

// ---------- shouldTerminate ----------

describe("shouldTerminate", () => {
  test("false when budgetRemaining > 0", () => {
    expect(shouldTerminate(baseState({ budgetRemaining: 1 }))).toBe(false);
    expect(shouldTerminate(baseState({ budgetRemaining: 1_000_000 }))).toBe(false);
  });

  test("true when budgetRemaining = 0 (boundary inclusive)", () => {
    expect(shouldTerminate(baseState({ budgetRemaining: 0 }))).toBe(true);
  });

  test("true when budgetRemaining < 0 (mid-cycle overage)", () => {
    expect(shouldTerminate(baseState({ budgetRemaining: -50_000 }))).toBe(true);
  });
});

// ---------- isDriverPreempt ----------

describe("isDriverPreempt", () => {
  test("false on empty kanban", () => {
    expect(isDriverPreempt([])).toBe(false);
  });

  test("false when only improvement tasks are in-progress", () => {
    const tasks = [task({ id: "t-a", status: "in-progress", epic: IMPROVEMENT_EPIC_ID })];
    expect(isDriverPreempt(tasks)).toBe(false);
  });

  test("true when a foreign-epic task is in-progress", () => {
    const tasks = [task({ id: "t-a", status: "in-progress", epic: "e-other" })];
    expect(isDriverPreempt(tasks)).toBe(true);
  });

  test("true when an in-progress task has null epic (driver Tasks lack the improvement epic)", () => {
    const tasks = [task({ id: "t-a", status: "in-progress", epic: null })];
    expect(isDriverPreempt(tasks)).toBe(true);
  });

  test("false when foreign-epic tasks are done / todo / blocked (not in-progress)", () => {
    const tasks = [
      task({ id: "t-a", status: "done", epic: "e-other", completedAt: 1 }),
      task({ id: "t-b", status: "todo", epic: null }),
      task({ id: "t-c", status: "blocked", epic: "e-other" }),
    ];
    expect(isDriverPreempt(tasks)).toBe(false);
  });

  test("custom improvementEpicId override", () => {
    const tasks = [task({ id: "t-a", status: "in-progress", epic: "e-custom" })];
    // Default epic-id check → preempt (e-custom !== improvement default).
    expect(isDriverPreempt(tasks)).toBe(true);
    // Override → not a preempt.
    expect(isDriverPreempt(tasks, "e-custom")).toBe(false);
  });
});

// ---------- armCycle (file IO) ----------

describe("armCycle", () => {
  test("creates the directives file with header on first call", async () => {
    const state = baseState({ runId: "ei-firstone", cycleN: 1 });
    const body = await armCycle(atmuxDir, state, { timestamp: "11:30 MYT" });
    const text = await readFile(improveDirectivesPath(atmuxDir), "utf8");
    expect(text).toContain("Improve Directives");
    expect(text).toContain("## Open");
    expect(text).toContain("[11:30 MYT]");
    expect(text).toContain("runId=ei-firstone");
    expect(text).toContain("cycle=1");
    expect(text).toContain("ask each lane member");
    // Returns the prompt body.
    expect(body).toContain("cycle 1 requested");
  });

  test("appends entry to existing file (no header re-write)", async () => {
    // Pre-populate.
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      improveDirectivesPath(atmuxDir),
      "# Pre-existing header\n\n## Open\n- [old] entry\n",
    );
    const state = baseState({ runId: "ei-secondrun", cycleN: 7 });
    await armCycle(atmuxDir, state, { timestamp: "12:00 MYT" });
    const text = await readFile(improveDirectivesPath(atmuxDir), "utf8");
    expect(text).toContain("# Pre-existing header");
    expect(text).toContain("- [old] entry");
    expect(text).toContain("[12:00 MYT]");
    expect(text).toContain("runId=ei-secondrun");
    expect(text).toContain("cycle=7");
    // Header NOT duplicated.
    expect((text.match(/# Pre-existing header/g) ?? []).length).toBe(1);
  });

  test("default timestamp uses formatMyt() shape", async () => {
    const state = baseState({ runId: "ei-defaultts", cycleN: 1 });
    await armCycle(atmuxDir, state);
    const text = await readFile(improveDirectivesPath(atmuxDir), "utf8");
    // Format: "HH:MM MYT" — match by regex.
    expect(text).toMatch(/\[\d{2}:\d{2} MYT\]/);
  });
});

// ---------- improveDirectivesPath ----------

describe("improveDirectivesPath", () => {
  test("appends improve-directives.md to atmuxDir", () => {
    expect(improveDirectivesPath("/tmp/foo")).toBe("/tmp/foo/improve-directives.md");
  });
});
