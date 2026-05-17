// Unit tests for src/core/superdoctor-hygiene/lane-null-orphan.ts
// (ADR-131 §D2 detector #4 / t-e75ba5aa).

import { describe, expect, test } from "bun:test";
import type {
  FixDeps,
  HygieneIssue,
  TeamState,
} from "../../../../src/core/superdoctor-hygiene/_shared.ts";
import { detect, fix } from "../../../../src/core/superdoctor-hygiene/lane-null-orphan.ts";
import type { KanbanTask } from "../../../../src/schema/kanban.ts";

function task(o: Partial<KanbanTask>): KanbanTask {
  return { id: o.id ?? "t-x", status: o.status ?? "todo", ...o };
}

function team(members: TeamState["members"]): TeamState {
  return { members };
}

// ---------- detect ----------

describe("lane-null-orphan detect", () => {
  test("HIT: lane=null + owner=null + member with lane exists → P3/low + backfill candidate.lane", () => {
    const t = team([
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "be-1", role: "member", lane: "be" },
    ]);
    const issues = detect(t, [task({ id: "t-001", lane: null, owner: null })]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.fingerprintClass).toBe("lane-null-orphan");
    expect(issue.severity).toBe("P3");
    expect(issue.confidence).toBe("low");
    expect(issue.proposedFix.kind).toBe("set-lane");
    if (issue.proposedFix.kind === "set-lane") {
      // No lane affinity; alphabetical tiebreak → be-1.lane=be
      expect(issue.proposedFix.lane).toBe("be");
    }
  });

  test("MISS: lane is set → no issue", () => {
    const t = team([{ name: "fe-1", lane: "fe" }]);
    const issues = detect(t, [task({ id: "t-001", lane: "fe", owner: null })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: owner is set → not an orphan (claim --next ignores owned-tasks)", () => {
    const t = team([{ name: "fe-1", lane: "fe" }]);
    const issues = detect(t, [task({ id: "t-001", lane: null, owner: "fe-1" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: status=done → out of scope", () => {
    const t = team([{ name: "fe-1", lane: "fe" }]);
    const issues = detect(t, [task({ id: "t-001", lane: null, owner: null, status: "done" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: zero candidate members (entire roster is non-execution roles)", () => {
    const t = team([
      { name: "planner", role: "planner" },
      { name: "reviewer", role: "reviewer" },
    ]);
    const issues = detect(t, [task({ id: "t-001", lane: null, owner: null })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: candidate exists but has no declared lane → skip (can't backfill from nothing)", () => {
    const t = team([{ name: "fe-1", role: "member" /* no lane */ }]);
    const issues = detect(t, [task({ id: "t-001", lane: null, owner: null })]);
    expect(issues).toHaveLength(0);
  });

  test("PICK: alphabetical tiebreak when multiple candidates tied on load", () => {
    const t = team([
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "fe-2", role: "member", lane: "fe" },
    ]);
    const issues = detect(t, [task({ id: "t-001", lane: null, owner: null })]);
    expect(issues[0]!.proposedFix.kind).toBe("set-lane");
    if (issues[0]!.proposedFix.kind === "set-lane") {
      expect(issues[0]!.proposedFix.lane).toBe("fe"); // fe-1 wins, lane=fe
    }
  });

  test("PICK: load tiebreak — fe-1 is overloaded, fe-2's lane backfill wins", () => {
    const t = team([
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "be-1", role: "member", lane: "be" },
    ]);
    // fe-1 has 2 in-progress, be-1 has 0. be-1 wins. Backfill lane='be'.
    const kanban: KanbanTask[] = [
      task({ id: "t-prev-1", owner: "fe-1", status: "in-progress" }),
      task({ id: "t-prev-2", owner: "fe-1", status: "in-progress" }),
      task({ id: "t-001", lane: null, owner: null }),
    ];
    const issues = detect(t, kanban);
    if (issues[0]!.proposedFix.kind === "set-lane") {
      expect(issues[0]!.proposedFix.lane).toBe("be");
    }
  });
});

// ---------- fix ----------

describe("lane-null-orphan fix", () => {
  test("set-lane success", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "lane-null-orphan",
      severity: "P3",
      confidence: "low",
      diagnosis: "...",
      proposedFix: { kind: "set-lane", lane: "fe" },
    };
    const calls: string[] = [];
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async (id, lane) => {
        calls.push(`${id}=${lane}`);
      },
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(true);
    expect(calls).toEqual(["t-001=fe"]);
  });

  test("set-lane verb-failure → verb-failed", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "lane-null-orphan",
      severity: "P3",
      confidence: "low",
      diagnosis: "...",
      proposedFix: { kind: "set-lane", lane: "fe" },
    };
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async () => {
        throw new Error("boom");
      },
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
  });

  test("defensive: non-set-lane proposed → verb-failed", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "lane-null-orphan",
      severity: "P3",
      confidence: "low",
      diagnosis: "...",
      proposedFix: { kind: "reassign", toMember: "fe-1" },
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
    expect(result.reason).toBe("verb-failed");
  });
});
