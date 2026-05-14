// ADR-131 §D2 detector #5 — `prio-null`.
//
// Fingerprint: `task.priority IS NULL` AND `task.status` ∈
// {todo, in-progress}. Symptom: no functional blocker — priority-sort
// places null-priority entries at the bottom of `atmux task list`,
// disturbing the visible ordering during operator triage.
//
// Severity: P3 (cosmetic — claim mechanism still works).
// Confidence: low — the "default to 3 (mid)" is a guess; the original
// author may have intentionally left priority=null for explicit-only
// prioritization workflows. Per §D2 confidence ladder, fires only when
// no P0/P1 fingerprints exist in the same drain pass.

import type { KanbanTask } from "../../schema/kanban.ts";
import type { FixDeps, FixResult, HygieneIssue, TeamState } from "./_shared.ts";

/** Default priority assigned by the prio-null fix. ADR-131 §D2 row 5
 *  ("Default to 3 (mid)"). Exposed as a constant so consumers
 *  (drain-loop logs, complaint-box body, T6 e2e assertions) can
 *  reference the same value. */
export const DEFAULT_PRIORITY = 3;

export function detect(_team: TeamState, kanban: ReadonlyArray<KanbanTask>): HygieneIssue[] {
  const issues: HygieneIssue[] = [];

  for (const task of kanban) {
    if (task.priority != null) continue;
    if (task.status !== "todo" && task.status !== "in-progress") continue;

    issues.push({
      taskId: task.id,
      fingerprintClass: "prio-null",
      severity: "P3",
      confidence: "low",
      diagnosis: `priority=null on live task (status='${task.status ?? "(none)"}'); defaulting to ${DEFAULT_PRIORITY}`,
      proposedFix: { kind: "set-priority", priority: DEFAULT_PRIORITY },
    });
  }

  return issues;
}

export async function fix(issue: HygieneIssue, deps: FixDeps): Promise<FixResult> {
  const proposed = issue.proposedFix;
  if (proposed.kind === "set-priority") {
    try {
      await deps.priorityVerb(issue.taskId, proposed.priority);
      return { applied: true, attempted: proposed };
    } catch {
      return { applied: false, reason: "verb-failed", attempted: proposed };
    }
  }
  return { applied: false, reason: "verb-failed", attempted: proposed };
}
