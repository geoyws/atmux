// ADR-131 §D2 detector #2 — `lane-mismatch`.
//
// Fingerprint: `task.owner` resolves to a real member, `member.lane !=
// task.lane`, AND `task.claimedAt IS NULL` (dispatched-not-claimed
// wedge). Symptom: `atmux dispatch` wrote the assignment but
// `atmux claim --next --as <member>` filters on lane and skips —
// task wedges indefinitely. The 4h+ SOPX screenshot is this exact
// shape.
//
// Severity: P0 (blocks a P0-priority dispatched task from getting
// picked up — same blast radius as ghost-owner).
// Confidence: medium — ADR-131 §D2 marks this "medium-high" because
// the assumption is "owner is right, lane was wrong" (dispatch typo
// in `--lane be` when the real intent was `--lane test`). The
// inverse (owner is wrong, lane is right) is equally possible; the
// medium-confidence ladder bumps fix to 2nd-tick same-fingerprint per
// §D2 confidence flap-dampener.

import type { KanbanTask } from "../../schema/kanban.ts";
import type { FixDeps, FixResult, HygieneIssue, TeamState } from "./_shared.ts";

/**
 * Scan `kanban` for `dispatched-not-claimed` tasks whose owner's
 * natural lane diverges from the task's recorded lane. Returns one
 * issue per offender with `confidence: medium` (per §D2 flap-dampener).
 *
 * Scoped to `status: "todo" | "in-progress"` — `claimedAt IS NULL`
 * already excludes completed tasks but the explicit status gate
 * matches the rest of the detector chain for consistency.
 */
export function detect(team: TeamState, kanban: ReadonlyArray<KanbanTask>): HygieneIssue[] {
  const memberByName = new Map(team.members.map((m) => [m.name, m]));
  const issues: HygieneIssue[] = [];

  for (const task of kanban) {
    const owner = task.owner;
    if (owner == null || owner === "") continue;
    if (task.claimedAt != null) continue; // already claimed → not the wedge fingerprint
    if (task.status !== "todo" && task.status !== "in-progress") continue;

    const member = memberByName.get(owner);
    if (member === undefined) continue; // ghost-owned — covered by ghost-owner detector

    const memberLane = member.lane;
    const taskLane = task.lane;
    // Mismatch shape: owner has a declared lane AND it differs from
    // the task's lane. Owner-with-no-lane: out of scope here (the
    // dispatch should still find them — no-lane members match any
    // lane via lane-affinity degrade-not-refuse).
    if (memberLane == null) continue;
    if (taskLane === memberLane) continue;

    const recordedLane = taskLane ?? "(null)";
    issues.push({
      taskId: task.id,
      fingerprintClass: "lane-mismatch",
      severity: "P0",
      confidence: "medium",
      diagnosis:
        `owner '${owner}'.lane='${memberLane}' but task.lane='${recordedLane}' ` +
        `and claimedAt=null (dispatched-not-claimed wedge)`,
      proposedFix: { kind: "set-lane", lane: memberLane },
    });
  }

  return issues;
}

/**
 * Apply the proposed fix. Routes `set-lane` through `laneVerb`
 * (real impl: `atmux task lane <id> <lane>` per ADR-131 §D6 / T4
 * sibling Task t-93b59741).
 *
 * Idempotent — re-firing with the same lane is a verb no-op.
 */
export async function fix(issue: HygieneIssue, deps: FixDeps): Promise<FixResult> {
  const proposed = issue.proposedFix;
  if (proposed.kind === "set-lane") {
    try {
      await deps.laneVerb(issue.taskId, proposed.lane);
      return { applied: true, attempted: proposed };
    } catch {
      return { applied: false, reason: "verb-failed", attempted: proposed };
    }
  }
  return { applied: false, reason: "verb-failed", attempted: proposed };
}
