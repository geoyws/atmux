// Unit tests for src/core/superdoctor-hygiene/ghost-owner.ts
// (ADR-131 §D2 detector #1 / t-e75ba5aa).
//
// Coverage strategy:
//   detect — hit (owner ∉ members), miss (owner ∈ members /
//   owner=null / status=done), pick (lane affinity + load tiebreak +
//   alphabetical tiebreak), escalate (zero candidates).
//   fix — reassign success, reassign verb-failure, escalate path.

import { describe, expect, test } from "bun:test";
import type {
  FixDeps,
  HygieneIssue,
  TeamState,
} from "../../../../src/core/superdoctor-hygiene/_shared.ts";
import { detect, fix } from "../../../../src/core/superdoctor-hygiene/ghost-owner.ts";
import type { KanbanTask } from "../../../../src/schema/kanban.ts";

// ---------- Helpers ----------

function task(o: Partial<KanbanTask>): KanbanTask {
  return { id: o.id ?? "t-x", status: o.status ?? "todo", ...o };
}

function team(members: TeamState["members"]): TeamState {
  return { members };
}

function recorderDeps(): FixDeps & {
  calls: { verb: string; taskId: string; arg: string | number }[];
} {
  const calls: { verb: string; taskId: string; arg: string | number }[] = [];
  return {
    calls,
    assignVerb: async (taskId, member) => {
      calls.push({ verb: "assign", taskId, arg: member });
    },
    laneVerb: async (taskId, lane) => {
      calls.push({ verb: "lane", taskId, arg: lane });
    },
    priorityVerb: async (taskId, priority) => {
      calls.push({ verb: "priority", taskId, arg: priority });
    },
  };
}

// ---------- detect ----------

describe("ghost-owner detect", () => {
  test("HIT: owner string not in members → emits one P0/high issue per offender", () => {
    const t = team([
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "be-1", role: "member", lane: "be" },
    ]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", status: "todo" }),
    ]);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.taskId).toBe("t-001");
    expect(issue.fingerprintClass).toBe("ghost-owner");
    expect(issue.severity).toBe("P0");
    expect(issue.confidence).toBe("high");
    expect(issue.proposedFix.kind).toBe("reassign");
    if (issue.proposedFix.kind === "reassign") {
      // lane-affinity narrows to fe-1 (only fe lane member)
      expect(issue.proposedFix.toMember).toBe("fe-1");
    }
  });

  test("MISS: owner ∈ members → no issue", () => {
    const t = team([{ name: "fe-1", lane: "fe" }]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-1", lane: "fe" })]);
    expect(issues).toHaveLength(0);
  });

  test("MISS: owner is null / empty → no issue (unclaimed, not ghost)", () => {
    const t = team([{ name: "fe-1" }]);
    expect(detect(t, [task({ id: "t-a", owner: null })])).toHaveLength(0);
    expect(detect(t, [task({ id: "t-b", owner: "" })])).toHaveLength(0);
    expect(detect(t, [task({ id: "t-c" })])).toHaveLength(0); // owner undefined
  });

  test("MISS: status=done → out of scope (historical drift not functional drag)", () => {
    const t = team([{ name: "fe-1", lane: "fe" }]);
    const issues = detect(t, [
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", status: "done" }),
      task({ id: "t-002", owner: "fe-ghost", lane: "fe", status: "blocked" }),
    ]);
    expect(issues).toHaveLength(0);
  });

  test("PICK: lane affinity narrows candidate set (fe-ghost on fe-lane → fe-1, not be-1)", () => {
    const t = team([
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "fe-2", role: "member", lane: "fe" },
      { name: "be-1", role: "member", lane: "be" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-ghost", lane: "fe" })]);
    const fix0 = issues[0]!.proposedFix;
    // Both fe-1 and fe-2 have lane affinity + same load (0 in-progress).
    // Alphabetical tiebreak: fe-1.
    expect(fix0.kind).toBe("reassign");
    if (fix0.kind === "reassign") expect(fix0.toMember).toBe("fe-1");
  });

  test("PICK: load tiebreak — fe-1 has in-progress task → fe-2 wins", () => {
    const t = team([
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "fe-2", role: "member", lane: "fe" },
    ]);
    const kanban: KanbanTask[] = [
      task({ id: "t-other", owner: "fe-1", status: "in-progress", lane: "fe" }),
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", status: "todo" }),
    ];
    const issues = detect(t, kanban);
    expect(issues).toHaveLength(1);
    const fix0 = issues[0]!.proposedFix;
    if (fix0.kind === "reassign") expect(fix0.toMember).toBe("fe-2");
  });

  test("PICK: lane-affinity DEGRADE — no fe member but fe-ghost → falls back to any execution member", () => {
    const t = team([
      { name: "be-1", role: "member", lane: "be" },
      { name: "ops-1", role: "member", lane: "ops" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-ghost", lane: "fe" })]);
    expect(issues).toHaveLength(1);
    // No fe lane member; degrade-not-refuse picks alphabetically.
    const fix0 = issues[0]!.proposedFix;
    if (fix0.kind === "reassign") expect(fix0.toMember).toBe("be-1");
  });

  test("PICK: excludes planner/lead/reviewer/gitter/devops-encore from reassign target", () => {
    const t = team([
      { name: "planner", role: "planner" },
      { name: "lead", role: "team-lead" },
      { name: "reviewer", role: "reviewer" },
      { name: "fe-1", role: "member", lane: "fe" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-ghost", lane: "fe" })]);
    const fix0 = issues[0]!.proposedFix;
    if (fix0.kind === "reassign") expect(fix0.toMember).toBe("fe-1");
  });

  test("ESCALATE: zero candidates (only non-execution roles in team) → kind:escalate", () => {
    const t = team([
      { name: "planner", role: "planner" },
      { name: "reviewer", role: "reviewer" },
    ]);
    const issues = detect(t, [task({ id: "t-001", owner: "fe-ghost" })]);
    expect(issues).toHaveLength(1);
    const fix0 = issues[0]!.proposedFix;
    expect(fix0.kind).toBe("escalate");
    if (fix0.kind === "escalate") {
      expect(fix0.reason).toContain("fe-ghost");
      expect(fix0.reason).toContain("zero candidates");
    }
  });

  test("ESCALATE: empty roster → kind:escalate", () => {
    const issues = detect(team([]), [task({ id: "t-001", owner: "fe-ghost" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.proposedFix.kind).toBe("escalate");
  });
});

// ---------- fix ----------

describe("ghost-owner fix", () => {
  test("reassign success → applied:true, assignVerb called with the right args", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "ghost-owner",
      severity: "P0",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "reassign", toMember: "fe-2" },
    };
    const deps = recorderDeps();
    const result = await fix(issue, deps);
    expect(result.applied).toBe(true);
    expect(result.attempted).toEqual({ kind: "reassign", toMember: "fe-2" });
    expect(deps.calls).toEqual([{ verb: "assign", taskId: "t-001", arg: "fe-2" }]);
  });

  test("reassign verb-failure → applied:false, reason:'verb-failed'", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "ghost-owner",
      severity: "P0",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "reassign", toMember: "fe-2" },
    };
    const deps: FixDeps = {
      assignVerb: async () => {
        throw new Error("verb boom");
      },
      laneVerb: async () => {},
      priorityVerb: async () => {},
    };
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
    expect(result.attempted).toEqual({ kind: "reassign", toMember: "fe-2" });
  });

  test("escalate path → applied:false, reason:'escalate', no verb invoked", async () => {
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "ghost-owner",
      severity: "P0",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "escalate", reason: "zero candidates" },
    };
    const deps = recorderDeps();
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("escalate");
    expect(deps.calls).toHaveLength(0);
  });

  test("defensive: detect-shape drift (non-reassign / non-escalate proposed) → verb-failed", async () => {
    // Shape this should never emit per detect() but kept defensive
    // so a future refactor that changes the union doesn't silently
    // swallow.
    const issue: HygieneIssue = {
      taskId: "t-001",
      fingerprintClass: "ghost-owner",
      severity: "P0",
      confidence: "high",
      diagnosis: "...",
      proposedFix: { kind: "set-lane", lane: "fe" }, // wrong kind for this detector
    };
    const deps = recorderDeps();
    const result = await fix(issue, deps);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("verb-failed");
    expect(deps.calls).toHaveLength(0); // never called the lane verb
  });
});
