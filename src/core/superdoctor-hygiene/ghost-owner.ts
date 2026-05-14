// ADR-131 §D2 detector #1 — `ghost-owner`.
//
// Fingerprint: `task.owner` is a string that does not match any
// `team.members[].name`. Symptom: `atmux claim --next --as <real-member>`
// skips the task because owner is set; no real member can claim it; the
// work is structurally unreachable.
//
// Severity: P0 (blocks the auto-claim mechanism entirely on this task).
// Confidence: high — the fingerprint is unambiguous, and the
// reassignment fix lands on the deterministic-pick member.
//
// Refuse-and-ask escape: when no candidate exists (entire team is
// non-execution-roles, OR roster is empty), emit `kind: escalate` —
// the drain-loop pipes this to the `[hygiene-blocker]` Discord
// template (§D5).

import type { KanbanTask } from "../../schema/kanban.ts";
import {
  type FixDeps,
  type FixResult,
  type HygieneIssue,
  NON_EXECUTION_ROLES,
  pickCandidate,
  type TeamState,
} from "./_shared.ts";

/**
 * Scan `kanban` for tasks whose `owner` field references a member
 * absent from `team.members[]`. Returns one issue per offender. Tasks
 * with `owner: null` / `owner: undefined` / `owner: ""` are NOT
 * ghost-owned — they're simply unclaimed.
 *
 * Only `todo` / `in-progress` tasks qualify. `done` / `blocked` tasks
 * are out-of-scope per ADR-131 §"Out of scope" — historical drift is
 * not functional drag.
 */
export function detect(team: TeamState, kanban: ReadonlyArray<KanbanTask>): HygieneIssue[] {
  const validNames = new Set(team.members.map((m) => m.name));
  const issues: HygieneIssue[] = [];

  for (const task of kanban) {
    const owner = task.owner;
    if (owner == null || owner === "") continue;
    if (validNames.has(owner)) continue;
    if (task.status !== "todo" && task.status !== "in-progress") continue;

    const candidate = pickCandidate({
      members: team.members,
      kanban,
      lane: task.lane ?? null,
      excludeRoles: NON_EXECUTION_ROLES,
    });

    const taskLane = task.lane ?? "(none)";
    const diagnosis =
      `owner '${owner}' ∉ team.members; ` +
      `task.lane=${taskLane}; ` +
      `pick=${candidate?.name ?? "<none>"}`;

    issues.push({
      taskId: task.id,
      fingerprintClass: "ghost-owner",
      severity: "P0",
      confidence: "high",
      diagnosis,
      proposedFix:
        candidate !== null
          ? { kind: "reassign", toMember: candidate.name }
          : { kind: "escalate", reason: `ghost-owner '${owner}' — zero candidates` },
    });
  }

  return issues;
}

/**
 * Apply the proposed fix. Routes `reassign` through the injected
 * `assignVerb` (real impl shells `atmux task assign <id> <member>`);
 * `escalate` returns the no-op result so the drain-loop surfaces the
 * blocker to Discord via §D5 rather than touching state.
 *
 * Idempotent at the verb layer — the assign verb is itself idempotent
 * (writing the same owner twice is a no-op write). The detector's
 * re-fire on the next tick after a successful fix sees the now-valid
 * owner and emits zero issues for this task.
 */
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
  // Defensive — detect() only emits `reassign` or `escalate`. If the
  // shape drifts in a future refactor, surface as verb-failed so the
  // drain loop logs + retries rather than silently swallowing.
  return { applied: false, reason: "verb-failed", attempted: proposed };
}
