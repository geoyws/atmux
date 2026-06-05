// ADR-127 §Decision (5) + §OQ5: lane-drift-check helper.
// (renamed from ADR-062 per the 2026-05 renumber sweep; see ADR-093
// renumber map. See also ADR-176 for criterion (d) — epic-children-
// progressing — which tightens the 3-criterion algorithm by adding
// a 4th invariant. ADR-176 never relaxes a revert; only delays one
// when there's evidence an epic-team child is still shipping.)
//
// Pure-input helper. Scans `in-progress` Tasks and decides per-task
// whether the work is genuinely stuck (and the claim should revert to
// `todo` + raise a flag) or whether the Task is making progress (no-op).
//
// Three criteria — ALL must be true to revert:
//   (a) `claimedAt` more than `claimedAtThresholdMin` minutes ago
//       (default 30, configurable via verb flag).
//   (b) claiming worker's pane state is non-READY (current classify;
//       single-sample per ADR-127 §OQ5 — a follow-up can corroborate
//       with a 5-min-apart re-sample if false positives surface).
//   (c) no commit in the last N commits (default 30, scanned by the
//       verb) references the task's id pattern (`t-[0-9a-f]{8}`).
//   (d) NEW per ADR-176 — epic-children-progressing: a parent EPIC-class
//       Task (one whose `.id` is referenced by other Tasks' `.epic`) is
//       HELD when any of its children is progressing. A child progresses
//       iff its status is in {in-progress, review, testing, merging, done}
//       OR a commit ref to the child's id appears in the same
//       `recentCommitsText` window scanned for criterion (c). Additive
//       tightening — (a)+(b)+(c) still all required; (d) only ever skips
//       a revert, never causes one. Non-EPIC Tasks (no children) are
//       unaffected. The verb pre-builds `childrenByParentId`; an
//       empty/unset map preserves the legacy 3-criterion behavior.
//
// Pure / no-IO. Inputs: Tasks, a classifyMember probe (verb-injected),
// the recent-commits text (verb fetches via `git log`), an optional
// parentId→children map for criterion (d), and the thresholds. Output:
// per-task decisions describing action + evidence
// + (when action=="revert") a pre-formatted flag body for the verb to
// raise.
//
// This split lets future `groom` (when it ports) absorb the helper
// without touching the verb wrapper — the verb's only job is plumbing
// IO into the helper and the action-side mutations out of it.

import type { KanbanTask } from "../schema/kanban.ts";
import type { PaneClassification } from "./pane-state.ts";

// ---------- Public types ----------

/** Per-task evidence captured during the drift evaluation. Surfaced
 *  unconditionally so `--dry-run` / `--reset` callers see the same
 *  shape and operators can grep what was considered. */
export interface DriftEvidence {
  /** Task id under evaluation. */
  taskId: string;
  /** Task owner (claiming worker). Empty string when the Task lacks
   *  an owner — the helper skips owner-less Tasks (no member to revert
   *  from). */
  member: string;
  /** Epoch seconds when claimed. `null` on legacy / malformed Tasks
   *  whose `claimedAt` is absent or non-numeric. */
  claimedAtSec: number | null;
  /** Minutes since `claimedAt`. `null` when `claimedAtSec` is null. */
  claimedAgoMin: number | null;
  /** Pane classification at evaluation time. `null` when the probe
   *  failed (member missing window, capture error, etc.) — counts as
   *  criterion-(b) fail (we don't revert blindly). */
  pane: PaneClassification | null;
  /** Whether the recent-commits text included the task's id substring. */
  hasCommitRef: boolean;
  /** Number of commits scanned for the ref check (verb-side; surfaced
   *  here so summaries can render "scanned N commits, hit/miss"). */
  commitsScanned: number;
}

/** Verb-side action — `revert` flips the Task to `todo` + raises a
 *  flag; `skip` is a no-op (the helper logs the skip reason for
 *  observability). */
export type DriftAction = "revert" | "skip";

export interface DriftDecision {
  taskId: string;
  member: string;
  evidence: DriftEvidence;
  action: DriftAction;
  /** Why the helper chose `skip`. One of:
   *    - `"no-owner"`                  — Task has no owner to revert from
   *    - `"claimed-recently"`          — criterion (a) false (`claimedAgoMin <= thresholdMin`)
   *    - `"pane-unclassifiable"`       — criterion (b) false because the probe returned null
   *    - `"pane-ready"`                — criterion (b) false because pane state is READY
   *    - `"commit-ref-found"`          — criterion (c) false (recent commit referenced the id)
   *    - `"epic-children-progressing"` — criterion (d) false (ADR-176): an EPIC
   *                                      parent with a progressing child; the
   *                                      EPIC is correctly in-progress.
   *  Set on action="skip" only. */
  reason?: string;
  /** Pre-formatted flag body per ADR-062 §OQ5 prescription. Set when
   *  `action === "revert"`; absent on skip. */
  flagBody?: string;
}

export interface CheckLaneDriftOpts {
  /** Tasks pre-filtered to status==="in-progress" by the caller. */
  inProgressTasks: ReadonlyArray<KanbanTask>;
  /** Probe one member's pane. Returns `null` when classification is
   *  unavailable (member missing from team.json, capture failure, no
   *  session). The helper treats null as criterion-(b) fail. */
  classifyMember: (memberName: string) => Promise<PaneClassification | null>;
  /** Concatenated subject+body text of the last N commits. The helper
   *  greps the task-id substring to evaluate criterion (c). The verb
   *  fetches this via `git log -<n> --format=%H%n%s%n%b` and passes
   *  the joined string in. */
  recentCommitsText: string;
  /** N — count of commits scanned. Carried into evidence for
   *  observability; not used in the algorithm itself. */
  commitsScanned: number;
  /** "Now" in epoch seconds. */
  nowSec: number;
  /** Criterion (a) threshold in minutes. Default 30 per ADR-062 §OQ5. */
  claimedAtThresholdMin?: number;
  /** ADR-176 criterion (d): map of parentTaskId → child Tasks for
   *  EPIC-awareness. The verb pre-builds it by indexing all Tasks on
   *  their `.epic` field. When a Task under evaluation appears as a key
   *  AND any of its children is progressing (status in {in-progress,
   *  review, testing, merging, done} OR a commit ref in
   *  `recentCommitsText`), the revert is held with reason
   *  `"epic-children-progressing"`. Empty / unset map → criterion (d)
   *  is a no-op (legacy 3-criterion behavior). */
  childrenByParentId?: ReadonlyMap<string, ReadonlyArray<KanbanTask>>;
}

/** ADR-176 §Decision: a child Task counts as "progressing" when its
 *  status shows motion. `todo` and `blocked` do NOT count — decomp
 *  existence is not progress (ADR-176 OQ1). */
const PROGRESSING_STATUSES: ReadonlySet<string> = new Set([
  "in-progress",
  "review",
  "testing",
  "merging",
  "done",
]);

// ---------- Public API ----------

/** Default criterion-(a) threshold (minutes). ADR-062 §OQ5. */
export const DEFAULT_CLAIMED_AT_THRESHOLD_MIN = 30;

/**
 * ADR-176 criterion (d) predicate. `true` when `taskId` is an EPIC
 * parent (has entries in `childrenByParentId`) AND at least one child
 * is "progressing": its `status` is in {in-progress, review, testing,
 * merging, done} OR a commit ref to the child's id appears in
 * `recentCommitsText` (the same window scanned for criterion (c)).
 *
 * Returns `false` for non-EPIC Tasks (no children) and for EPIC parents
 * whose every child is `todo` / `blocked` with no commit ref — those
 * remain revert-eligible (ADR-176 OQ1: stuck decomp SHOULD flag). When
 * `childrenByParentId` is unset/empty the predicate is always `false`,
 * preserving the legacy 3-criterion behavior.
 *
 * Exported for direct unit coverage of each progressing branch.
 */
export function hasProgressingChildren(
  taskId: string,
  childrenByParentId: ReadonlyMap<string, ReadonlyArray<KanbanTask>> | undefined,
  recentCommitsText: string,
): boolean {
  const children = childrenByParentId?.get(taskId);
  if (children === undefined || children.length === 0) return false;
  for (const child of children) {
    if (typeof child.status === "string" && PROGRESSING_STATUSES.has(child.status)) {
      return true;
    }
    if (recentCommitsText.includes(child.id)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk in-progress Tasks; emit one decision per task. Pure — never
 * mutates the kanban or fires a flag itself; the verb wrapper does
 * the action-side IO using the decisions.
 */
export async function checkLaneDrift(opts: CheckLaneDriftOpts): Promise<DriftDecision[]> {
  const threshold = opts.claimedAtThresholdMin ?? DEFAULT_CLAIMED_AT_THRESHOLD_MIN;
  const decisions: DriftDecision[] = [];
  for (const task of opts.inProgressTasks) {
    const member = typeof task.owner === "string" ? task.owner : "";
    const claimedAtSec =
      typeof task.claimedAt === "number" && task.claimedAt > 0 ? task.claimedAt : null;
    const claimedAgoMin =
      claimedAtSec !== null ? Math.floor((opts.nowSec - claimedAtSec) / 60) : null;

    if (member.length === 0) {
      const evidence: DriftEvidence = {
        taskId: task.id,
        member: "",
        claimedAtSec,
        claimedAgoMin,
        pane: null,
        hasCommitRef: opts.recentCommitsText.includes(task.id),
        commitsScanned: opts.commitsScanned,
      };
      decisions.push({
        taskId: task.id,
        member: "",
        evidence,
        action: "skip",
        reason: "no-owner",
      });
      continue;
    }

    const pane = await opts.classifyMember(member);
    const hasCommitRef = opts.recentCommitsText.includes(task.id);

    const evidence: DriftEvidence = {
      taskId: task.id,
      member,
      claimedAtSec,
      claimedAgoMin,
      pane,
      hasCommitRef,
      commitsScanned: opts.commitsScanned,
    };

    // Criterion (a): claimedAt > thresholdMin ago.
    const aOk = claimedAgoMin !== null && claimedAgoMin > threshold;
    // Criterion (b): pane non-READY.
    const bOk = pane !== null && pane.state !== "READY";
    // Criterion (c): no commit reference in last N commits.
    const cOk = !hasCommitRef;
    // Criterion (d) — ADR-176: NOT an EPIC parent with a progressing
    // child. Additive — only holds a revert, never causes one.
    const dOk = !hasProgressingChildren(task.id, opts.childrenByParentId, opts.recentCommitsText);

    if (aOk && bOk && cOk && dOk) {
      decisions.push({
        taskId: task.id,
        member,
        evidence,
        action: "revert",
        flagBody: formatFlagBody(evidence),
      });
      continue;
    }

    let reason: string;
    if (!aOk) {
      reason = "claimed-recently";
    } else if (!bOk) {
      reason = pane === null ? "pane-unclassifiable" : "pane-ready";
    } else if (!cOk) {
      reason = "commit-ref-found";
    } else {
      reason = "epic-children-progressing";
    }
    decisions.push({
      taskId: task.id,
      member,
      evidence,
      action: "skip",
      reason,
    });
  }
  return decisions;
}

/**
 * Render the flag body per ADR-062 §OQ5 prescription:
 *
 *   `lane-drift-revert: <task-id> claimed by <member> for <Hh>min, pane <state>, no commit ref — auto-reverted to todo`
 *
 * Duration formatting follows the global CLAUDE.md compact convention
 * (47min for <60m, 6h45m / 2h / 25h49m for ≥60m; never days). Pane
 * state defaults to `UNKNOWN` when the probe returned null.
 */
export function formatFlagBody(evidence: DriftEvidence): string {
  const dur =
    evidence.claimedAgoMin === null ? "?min" : formatDurationCompact(evidence.claimedAgoMin);
  const paneLabel = evidence.pane?.state ?? "UNKNOWN";
  return (
    `lane-drift-revert: ${evidence.taskId} claimed by ${evidence.member} for ${dur}, ` +
    `pane ${paneLabel}, no commit ref — auto-reverted to todo`
  );
}

/** Compact duration per CLAUDE.md global convention. Exported for
 *  verb-side summary rendering + test assertions. */
export function formatDurationCompact(minutes: number): string {
  if (minutes < 0) return `${minutes}min`;
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}
