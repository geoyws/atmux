// Unit tests for src/core/superdoctor-hygiene/role-mismatch.ts
// (ADR-131 §D2 detector #3 / t-e75ba5aa).

import { describe, expect, test } from "bun:test";
import type {
  FixDeps,
  HygieneIssue,
  TeamState,
} from "../../../../src/core/superdoctor-hygiene/_shared.ts";
import {
  detect,
  fix,
  isExecutionTask,
} from "../../../../src/core/superdoctor-hygiene/role-mismatch.ts";
import type { KanbanTask } from "../../../../src/schema/kanban.ts";

function task(o: Partial<KanbanTask>): KanbanTask {
  return { id: o.id ?? "t-x", status: o.status ?? "todo", ...o };
}

function team(members: TeamState["members"]): TeamState {
  return { members };
}

// ---------- isExecutionTask helper ----------

describe("isExecutionTask", () => {
  test("lane='fe' → true", () => {
    expect(isExecutionTask(task({ lane: "fe" }))).toBe(true);
  });
  test("lane='be' / 'ops' / 'test' → true", () => {
    expect(isExecutionTask(task({ lane: "be" }))).toBe(true);
    expect(isExecutionTask(task({ lane: "ops" }))).toBe(true);
    expect(isExecutionTask(task({ lane: "test" }))).toBe(true);
  });
  test("lane='review' / 'misc' / null → false (unless body matches)", () => {
    expect(isExecutionTask(task({ lane: "review" }))).toBe(false);
    expect(isExecutionTask(task({ lane: "misc" }))).toBe(false);
    expect(isExecutionTask(task({ lane: null }))).toBe(false);
  });
  test("body contains 'implement' / 'feat:' / 'fix:' → true even when lane is non-execution", () => {
    expect(isExecutionTask(task({ lane: "review", body: "implement the X surface" }))).toBe(true);
    expect(isExecutionTask(task({ lane: null, body: "feat: ship Y" }))).toBe(true);
    expect(isExecutionTask(task({ body: "fix: bug Z" }))).toBe(true);
    expect(isExecutionTask(task({ body: "FIX: case-insensitive" }))).toBe(true);
  });
  test("body 'non-feature' word-boundary → false (no 'feat:' substring match)", () => {
    expect(isExecutionTask(task({ body: "discuss non-feature variants" }))).toBe(false);
  });
});

// ---------- detect ----------

describe("role-mismatch detect", () => {
  test("HIT: planner owns lane=fe task → P1/high issue + reassign", () => {
    const t = team([
      { name: "planner", role: "planner" },
      { name: "fe-1", role: "member", lane: "fe" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "planner", lane: "fe" })]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.fingerprintClass).toBe("role-mismatch");
    expect(issue.severity).toBe("P1");
    expect(issue.confidence).toBe("high");
    expect(issue.proposedFix).toEqual({ kind: "reassign", toMember: "fe-1" });
  });

  test("HIT: reviewer owns body='feat: X' task (non-execution lane) → fires on body match", () => {
    const t = team([
      { name: "reviewer", role: "reviewer" },
      { name: "fe-1", role: "member", lane: "fe" },
    ]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "reviewer", lane: "misc", body: "feat: implement the X" }),
    ]);
    expect(issues).toHaveLength(1);
  });

  test("MISS: planner owns lane='review' task (legitimate coordination work)", () => {
    const t = team([{ name: "planner", role: "planner" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "planner", lane: "review", body: "draft ADR-XXX" }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: member (role!=non-execution) owns execution task", () => {
    const t = team([{ name: "fe-1", role: "member", lane: "fe" }]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-1", lane: "fe" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: ghost owner → out of scope (ghost-owner detector handles)", () => {
    const t = team([{ name: "fe-1", lane: "fe" }]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-ghost", lane: "fe" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: status=done → out of scope", () => {
    const t = team([
      { name: "planner", role: "planner" },
      { name: "fe-1", role: "member", lane: "fe" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "planner", lane: "fe", status: "done" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: member has no declared role → out of scope (no role to mismatch)", () => {
    const t = team([{ name: "x" }]); // no role
    const issues = detect(t, [task({ id: "t-001", owner: "x", lane: "fe" })]);
    expect(issues).toHaveLength(0);
  });

  test("ESCALATE: planner-owned task with zero execution-class candidates → kind:escalate", () => {
    const t = team([
      { name: "planner", role: "planner" },
      { name: "reviewer", role: "reviewer" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "planner", lane: "fe" })]);
    expect(issues).toHaveLength(1);
    const fix0 = issues[0]!.proposedFix;
    expect(fix0.kind).toBe("escalate");
  });

  test("EDGE: team-lead role is also in NON_EXECUTION_ROLES (gitter / devops-encore too)", () => {
    const t = team([
      { name: "lead", role: "team-lead" },
      { name: "gitter", role: "gitter" },
      { name: "devops", role: "devops-encore" },
      { name: "fe-1", role: "member", lane: "fe" },
    ]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "lead", lane: "fe" }),
      task({ id: "t-002", owner: "gitter", lane: "be" }),
      task({ id: "t-003", owner: "devops", lane: "ops" }),
    ]);
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.taskId).sort()).toEqual(["t-001", "t-002", "t-003"]);
  });
});

// ---------- fix ----------

describe("role-mismatch fix", () => {
  test("reassign success", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "role-mismatch",
      severity: "P1",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "reassign", toMember: "fe-1" },
    };
    const calls: string[] = [];
    const deps: FixDeps = {
      assignVerb: async (id, m) => {
        calls.push(`${id}→${m}`);
      },
      laneVerb: async () => {},
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(true);
    expect(calls).toEqual(["t-001→fe-1"]);
  });

  test("escalate → applied:false reason:'escalate'", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "role-mismatch",
      severity: "P1",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "escalate", reason: "no candidates" },
    };
    const deps: FixDeps = {
      assignVerb: async () => {
        throw new Error("should not have been called");
      },
      laneVerb: async () => {},
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("escalate");
  });

  test("verb-failure → reason:'verb-failed'", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "role-mismatch",
      severity: "P1",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "reassign", toMember: "fe-1" },
    };
    const deps: FixDeps = {
      assignVerb: async () => {
        throw new Error("boom");
      },
      laneVerb: async () => {},
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
  });

  test("defensive: non-reassign / non-escalate proposed → verb-failed", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "role-mismatch",
      severity: "P1",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "set-priority", priority: 3 },
    };
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async () => {},
      priorityVerb: async () => {
        throw new Error("should not have been called");
      },
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
  });
});
