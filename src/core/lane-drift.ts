// ADR-062 §Decision (5) + §OQ5: lane-drift-check helper.
//
// Pure-input helper. Scans `in-progress` Tasks and decides per-task
// whether the work is genuinely stuck (and the claim should revert to
// `todo` + raise a flag) or whether the Task is making progress (no-op).
//
// Three criteria — ALL must be true to revert:
//   (a) `claimedAt` more than `claimedAtThresholdMin` minutes ago
//       (default 30, configurable via verb flag).
//   (b) claiming worker's pane state is non-READY (current classify;
//       single-sample per ADR-062 §OQ5 — a follow-up can corroborate
//       with a 5-min-apart re-sample if false positives surface).
//   (c) no commit in the last N commits (default 30, scanned by the
//       verb) references the task's id pattern (`t-[0-9a-f]{8}`).
//
// Pure / no-IO. Inputs: Tasks, a classifyMember probe (verb-injected),
// the recent-commits text (verb fetches via `git log`), and the
// thresholds. Output: per-task decisions describing action + evidence
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
   *    - `"no-owner"`            — Task has no owner to revert from
   *    - `"claimed-recently"`    — criterion (a) false (`claimedAgoMin <= thresholdMin`)
   *    - `"pane-unclassifiable"` — criterion (b) false because the probe returned null
   *    - `"pane-ready"`          — criterion (b) false because pane state is READY
   *    - `"commit-ref-found"`    — criterion (c) false (recent commit referenced the id)
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
}

// ---------- Public API ----------

/** Default criterion-(a) threshold (minutes). ADR-062 §OQ5. */
export const DEFAULT_CLAIMED_AT_THRESHOLD_MIN = 30;

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

    if (aOk && bOk && cOk) {
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
    } else {
      reason = "commit-ref-found";
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
  const dur = evidence.claimedAgoMin === null ? "?min" : formatDurationCompact(evidence.claimedAgoMin);
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
