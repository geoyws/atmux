// ADR-131 §D2 detector #3 — `role-mismatch`.
//
// Fingerprint: `task.owner` resolves to a real member whose role is in
// the non-execution set {planner, lead, team-lead, reviewer, gitter,
// devops-encore}, AND the task is execution-class (lane ∈
// {fe, be, ops, test} OR body matches /\b(implement|feat:|fix:)\b/i).
// Symptom: planner / reviewer correctly refuses to claim the task but
// the assignment field still occupies the slot — task wedges until
// reassignment.
//
// Severity: P1 (blocks ONE execution slot — visible idle, not silent
// dormancy like P0).
// Confidence: high — the fingerprint is unambiguous (role lookup +
// execution-class classification are both deterministic).

import type { KanbanTask } from "../../schema/kanban.ts";
import {
  EXECUTION_BODY_RE,
  EXECUTION_LANES,
  type FixDeps,
  type FixResult,
  type HygieneIssue,
  NON_EXECUTION_ROLES,
  pickCandidate,
  type TeamState,
} from "./_shared.ts";

/** True when the task body / lane indicates execution-class work that
 *  shouldn't be owned by a planner / reviewer / lead. Two-axis test —
 *  lane OR body — so a docs-class lane with `feat:` body still trips.
 *  Exported for unit-test access. */
export function isExecutionTask(task: KanbanTask): boolean {
  if (task.lane != null && EXECUTION_LANES.includes(task.lane)) return true;
  const body = task.body;
  if (body != null && EXECUTION_BODY_RE.test(body)) return true;
  return false;
}

export function detect(team: TeamState, kanban: ReadonlyArray<KanbanTask>): HygieneIssue[] {
  const nonExecutionRoles = new Set(NON_EXECUTION_ROLES);
  const memberByName = new Map(team.members.map((m) => [m.name, m]));
  const issues: HygieneIssue[] = [];

  for (const task of kanban) {
    const owner = task.owner;
    if (owner == null || owner === "") continue;
    if (task.status !== "todo" && task.status !== "in-progress") continue;

    const member = memberByName.get(owner);
    if (member === undefined) continue; // ghost-owned — covered separately
    if (member.role === undefined) continue; // no declared role — out of scope
    if (!nonExecutionRoles.has(member.role)) continue; // role is fine
    if (!isExecutionTask(task)) continue; // task isn't execution-class — role is allowed to own

    const candidate = pickCandidate({
      members: team.members,
      kanban,
      lane: task.lane ?? null,
      excludeRoles: NON_EXECUTION_ROLES,
    });

    const taskLane = task.lane ?? "(none)";
    const diagnosis =
      `owner '${owner}' role='${member.role}' (non-execution) ` +
      `on execution-class task (lane=${taskLane}); ` +
      `pick=${candidate?.name ?? "<none>"}`;

    issues.push({
      taskId: task.id,
      fingerprintClass: "role-mismatch",
      severity: "P1",
      confidence: "high",
      diagnosis,
      proposedFix:
        candidate !== null
          ? { kind: "reassign", toMember: candidate.name }
          : { kind: "escalate", reason: `role-mismatch — zero execution-class candidates` },
    });
  }

  return issues;
}

export async function fix(issue: HygieneIssue, deps: FixDeps): Promise<FixResult> {
  const proposed = issue.proposedFix;
  if (proposed.kind === "reassign") {
    try {
      await deps.assignVerb(issue.taskId, proposed.toMember);
      return { applied: true, attempted: proposed };
    } catch {
      return { applied: false, reason: "verb-failed", attempted: proposed };
    }
  }
  if (proposed.kind === "escalate") {
    return { applied: false, reason: "escalate", attempted: proposed };
  }
  return { applied: false, reason: "verb-failed", attempted: proposed };
}
