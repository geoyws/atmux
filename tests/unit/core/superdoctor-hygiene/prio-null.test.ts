// Unit tests for src/core/superdoctor-hygiene/prio-null.ts
// (ADR-131 §D2 detector #5 / t-e75ba5aa).

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PRIORITY,
  detect,
  fix,
} from "../../../../src/core/superdoctor-hygiene/prio-null.ts";
import type {
  FixDeps,
  HygieneIssue,
  TeamState,
} from "../../../../src/core/superdoctor-hygiene/_shared.ts";
import type { KanbanTask } from "../../../../src/schema/kanban.ts";

function task(o: Partial<KanbanTask>): KanbanTask {
  return { id: o.id ?? "t-x", status: o.status ?? "todo", ...o };
}

function team(members: TeamState["members"]): TeamState {
  return { members };
}

// ---------- detect ----------

describe("prio-null detect", () => {
  test("HIT: priority=null on todo → P3/low + DEFAULT_PRIORITY (3)", () => {
    const issues = detect(team([]), [task({ id: "t-001", priority: null, status: "todo" })]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.fingerprintClass).toBe("prio-null");
    expect(issue.severity).toBe("P3");
    expect(issue.confidence).toBe("low");
    expect(issue.proposedFix).toEqual({ kind: "set-priority", priority: DEFAULT_PRIORITY });
    expect(DEFAULT_PRIORITY).toBe(3);
  });

  test("HIT: priority=undefined on in-progress → fires too", () => {
    const issues = detect(team([]), [task({ id: "t-001", status: "in-progress" })]);
    expect(issues).toHaveLength(1);
  });

  test("MISS: priority=0 → not null, no issue", () => {
    const issues = detect(team([]), [task({ id: "t-001", priority: 0, status: "todo" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: priority=5 → not null, no issue", () => {
    const issues = detect(team([]), [task({ id: "t-001", priority: 5, status: "todo" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: status=done → out of scope (cosmetic drift on completed work is historical)", () => {
    const issues = detect(team([]), [task({ id: "t-001", priority: null, status: "done" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: status=blocked → out of scope", () => {
    const issues = detect(team([]), [task({ id: "t-001", priority: null, status: "blocked" })]);
    expect(issues).toHaveLength(0);
  });

  test("HIT: multiple live tasks with null priority → multiple issues", () => {
    const issues = detect(team([]), [
      task({ id: "t-001", priority: null, status: "todo" }),
      task({ id: "t-002", priority: null, status: "in-progress" }),
    ]);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.taskId).sort()).toEqual(["t-001", "t-002"]);
  });

  test("team argument unused (detector is roster-agnostic)", () => {
    // Sanity: pass distinct teams, same kanban → same output. The
    // detector doesn't read team.members[].
    const a = detect(team([]), [task({ id: "t-001", priority: null, status: "todo" })]);
    const b = detect(team([{ name: "fe-1", lane: "fe" }]), [
      task({ id: "t-001", priority: null, status: "todo" }),
    ]);
    expect(a).toEqual(b);
  });
});

// ---------- fix ----------

describe("prio-null fix", () => {
  test("set-priority success → priorityVerb called with the right args", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "prio-null",
      severity: "P3",
      confidence: "low",
      diagnosis: "...",
      proposedFix: { kind: "set-priority", priority: 3 },
    };
    const calls: { id: string; p: number }[] = [];
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async () => {},
      priorityVerb: async (id, p) => {
        calls.push({ id, p });
      },
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(true);
    expect(calls).toEqual([{ id: "t-001", p: 3 }]);
  });

  test("verb-failure → verb-failed", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "prio-null",
      severity: "P3",
      confidence: "low",
      diagnosis: "...",
      proposedFix: { kind: "set-priority", priority: 3 },
    };
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async () => {},
      priorityVerb: async () => {
        throw new Error("boom");
      },
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
  });

  test("defensive: non-set-priority proposed → verb-failed", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "prio-null",
      severity: "P3",
      confidence: "low",
      diagnosis: "...",
      proposedFix: { kind: "set-lane", lane: "fe" },
    };
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async () => {
        throw new Error("should not have been called");
      },
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
  });
});
