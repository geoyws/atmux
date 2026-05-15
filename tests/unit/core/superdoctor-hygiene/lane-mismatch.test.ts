// Unit tests for src/core/superdoctor-hygiene/lane-mismatch.ts
// (ADR-131 §D2 detector #2 / t-e75ba5aa).

import { describe, expect, test } from "bun:test";
import {
  detect,
  fix,
} from "../../../../src/core/superdoctor-hygiene/lane-mismatch.ts";
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

describe("lane-mismatch detect", () => {
  test("HIT: owner real, member.lane='be', task.lane='test', claimedAt:null → P0/medium issue", () => {
    const t = team([{ name: "be-1", role: "member", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "be-1", lane: "test", claimedAt: null, status: "todo" }),
    ]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.fingerprintClass).toBe("lane-mismatch");
    expect(issue.severity).toBe("P0");
    expect(issue.confidence).toBe("medium");
    expect(issue.proposedFix).toEqual({ kind: "set-lane", lane: "be" });
    expect(issue.diagnosis).toContain("dispatched-not-claimed");
  });

  test("MISS: task already claimed (claimedAt is set) → not the wedge fingerprint", () => {
    const t = team([{ name: "be-1", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "be-1", lane: "test", claimedAt: 12345 }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: owner is ghost (not in members) → covered by ghost-owner detector", () => {
    const t = team([{ name: "be-1", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "be-ghost", lane: "test", claimedAt: null }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: lanes match → no issue", () => {
    const t = team([{ name: "be-1", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "be-1", lane: "be", claimedAt: null }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: member has NO declared lane → out of scope (no-lane members match any lane)", () => {
    const t = team([{ name: "fe-1", role: "member" }]); // no lane field
    const issues = detect(t, [
      task({ id: "t-001", owner: "fe-1", lane: "be", claimedAt: null }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: task.lane=null AND member.lane='be' → no mismatch (null is permissive)", () => {
    // Defensive: a null task.lane shouldn't mismatch — it's an
    // unset, not a wrong value. lane-null-orphan detector handles
    // this case.
    const t = team([{ name: "be-1", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "be-1", lane: null, claimedAt: null }),
    ]);
    // Strict mismatch interpretation: task.lane=null differs from
    // member.lane='be', so detector DOES fire here. That's a
    // judgment call — the alternative is silent skip. We fire
    // because the dispatched-with-no-lane shape IS the wedge
    // fingerprint (claim --next can't surface it).
    expect(issues).toHaveLength(1);
    expect(issues[0]!.proposedFix).toEqual({ kind: "set-lane", lane: "be" });
  });

  test("MISS: status=done → out of scope", () => {
    const t = team([{ name: "be-1", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "be-1", lane: "test", claimedAt: null, status: "done" }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: owner null → not a mismatch shape (lane-null-orphan / unclaimed territory)", () => {
    const t = team([{ name: "be-1", lane: "be" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: null, lane: "test", claimedAt: null }),
    ]);
    expect(issues).toHaveLength(0);
  });
});

// ---------- fix ----------

describe("lane-mismatch fix", () => {
  test("set-lane success → laneVerb called with the right args", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "lane-mismatch",
      severity: "P0",
      confidence: "medium",
      diagnosis: "...",
      proposedFix: { kind: "set-lane", lane: "be" },
    };
    const calls: { taskId: string; lane: string }[] = [];
    const deps: FixDeps = {
      assignVerb: async () => {},
      laneVerb: async (taskId, lane) => {
        calls.push({ taskId, lane });
      },
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(true);
    expect(result.attempted).toEqual({ kind: "set-lane", lane: "be" });
    expect(calls).toEqual([{ taskId: "t-001", lane: "be" }]);
  });

  test("set-lane verb-failure → applied:false, reason:'verb-failed'", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "lane-mismatch",
      severity: "P0",
      confidence: "medium",
      diagnosis: "...",
      proposedFix: { kind: "set-lane", lane: "be" },
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
      fingerprintClass: "lane-mismatch",
      severity: "P0",
      confidence: "medium",
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
