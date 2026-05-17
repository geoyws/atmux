// ADR-131 §D2 detector #4 — `lane-null-orphan`.
//
// Fingerprint: `task.lane IS NULL` AND `task.owner IS NULL` AND at
// least one candidate member exists. Symptom: direct member claims
// (`atmux claim <task-id> --as <member>`) work fine but
// `atmux claim --next --as <member>` (lane-affinity matcher) cannot
// surface the orphan because `WHERE lane = ?` returns zero rows when
// `lane IS NULL`.
//
// Severity: P3 (cosmetic — direct claim still works; the orphan is
// invisible to lane-fallback but not structurally wedged).
// Confidence: low — backfills lane from the deterministic-pick
// member's natural lane, which is a guess (the original Task author
// may have intentionally left lane=null for cross-lane orchestration).
// The low-confidence ladder defers fix to "blocking classes drained"
// per §D2 confidence policy.

import type { KanbanTask } from "../../schema/kanban.ts";
import {
  type FixDeps,
  type FixResult,
  type HygieneIssue,
  NON_EXECUTION_ROLES,
  pickCandidate,
  type TeamState,
} from "./_shared.ts";

export function detect(team: TeamState, kanban: ReadonlyArray<KanbanTask>): HygieneIssue[] {
  const issues: HygieneIssue[] = [];

  for (const task of kanban) {
    if (task.lane != null && task.lane !== "") continue;
    if (task.owner != null && task.owner !== "") continue;
    if (task.status !== "todo" && task.status !== "in-progress") continue;

    // Pick a member to read its natural lane from. We don't actually
    // reassign here (owner stays null — `claim --next` will still
    // arbitrate ownership). We just backfill lane so the
    // lane-affinity matcher can surface the task as a candidate.
    const candidate = pickCandidate({
      members: team.members,
      kanban,
      // No lane affinity (the task lane IS null — that's the
      // fingerprint). Just pick any execution-class member.
      lane: null,
      excludeRoles: NON_EXECUTION_ROLES,
    });

    if (candidate === null) continue; // §D2: only fires when >=1 candidate exists
    const candidateLane = candidate.lane;
    if (candidateLane == null || candidateLane === "") continue; // candidate has no lane to copy

    issues.push({
      taskId: task.id,
      fingerprintClass: "lane-null-orphan",
      severity: "P3",
      confidence: "low",
      diagnosis: `lane=null owner=null orphan; backfilling lane='${candidateLane}' from pick='${candidate.name}'`,
      proposedFix: { kind: "set-lane", lane: candidateLane },
    });
  }

  return issues;
}

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
