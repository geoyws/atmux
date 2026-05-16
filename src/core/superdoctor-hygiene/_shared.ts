// ADR-131 §D2-D3: shared types + deterministic-pick helper for the
// five kanban-hygiene detectors. Each detector file imports from here
// rather than redefining its own HygieneIssue / FixResult / candidate
// resolution rules — keeping the drain-loop invariants (severity
// ordering, confidence laddering, alphabetical tiebreak) in one place
// for T3's superdoctor tick integration to consume uniformly.
//
// Coverage of ADR-131 §D2 fingerprint classes:
//   ghost-owner       — task.owner ∉ team.members[].name   (P0)
//   lane-mismatch     — owner.lane ≠ task.lane + claimedAt:null (P0)
//   role-mismatch     — non-execution role on execution Task (P1)
//   lane-null-orphan  — lane=null + owner=null, cosmetic        (P3)
//   prio-null         — priority=null on live tasks, cosmetic   (P3)

import type { KanbanTask } from "../../schema/kanban.ts";
import type { TeamMember } from "../../schema/team.ts";

/** ADR-131 §D2 — severity ladder. P0 blocks auto-claim entirely
 *  (silent dormancy); P1 blocks one execution slot (visible idle);
 *  P3 is presentation drift (no functional impact). The drain loop
 *  in T3 will sort `severity ASC` (P0 first) then `detectedAt ASC`. */
export type HygieneSeverity = "P0" | "P1" | "P3";

/** ADR-131 §D2 confidence ladder — controls the drain loop's tick
 *  policy:
 *    - high   → apply on first detection
 *    - medium → apply only on 2nd-tick same-fingerprint (flap dampener)
 *    - low    → apply only when no P0/P1 fingerprints exist this tick
 *  Detectors return issues annotated with confidence; T3's drain loop
 *  honours the ladder. Confidence and severity are independent dimensions
 *  (a P0 issue can be `medium` confidence; a P3 can be `low`). */
export type HygieneConfidence = "high" | "medium" | "low";

/** The five fingerprint classes from ADR-131 §D2. Hard-coded enum
 *  ensures both detector files and the drain-loop sort key align on
 *  one canonical string per class — typos surface at compile time. */
export type HygieneFingerprintClass =
  | "ghost-owner"
  | "lane-mismatch"
  | "role-mismatch"
  | "lane-null-orphan"
  | "prio-null";

/** Concrete fix proposal emitted by a detector. Discriminated union
 *  on `kind` so `fix()` can dispatch verbs without nullability gymnastics
 *  and `escalate` cases carry the human-readable reason for the
 *  `[hygiene-blocker]` Discord template (T5). */
export type HygieneProposedFix =
  | { kind: "reassign"; toMember: string }
  | { kind: "set-lane"; lane: string }
  | { kind: "set-priority"; priority: number }
  | { kind: "escalate"; reason: string };

/** One issue surfaced by a detector. Flat record so the drain-loop
 *  pipeline (T3) can persist it to the `hygiene_fingerprints` SQLite
 *  table with no further shape munging. */
export interface HygieneIssue {
  taskId: string;
  fingerprintClass: HygieneFingerprintClass;
  severity: HygieneSeverity;
  confidence: HygieneConfidence;
  /** Human-readable root cause for the complaint-box audit row +
   *  Discord template body. Kept ≤120 chars for log line aesthetics. */
  diagnosis: string;
  proposedFix: HygieneProposedFix;
}

/** Outcome shape from a fix() call. The drain-loop persists
 *  `applied` + `appliedAction` + `reason` into `hygiene_fingerprints`'s
 *  `fix_applied_at` / `fix_successful` columns. */
export interface FixResult {
  applied: boolean;
  /** Populated on the no-op path so T3's complaint-box surface and
   *  T5's Discord template body can name the blocker shape:
   *    - `no-candidates` — deterministic-pick found zero members
   *      (refuse-and-ask escape per §D3 rule 4)
   *    - `escalate`      — detector emitted `kind: escalate` directly
   *    - `verb-failed`   — the wrapping verb threw (verb-level error
   *      surfaced through; superdoctor logs + retries next tick). */
  reason?: "no-candidates" | "escalate" | "verb-failed";
  /** The action that was attempted (success OR failure path), echoed
   *  back so the audit-log can record intent independent of outcome. */
  attempted?: HygieneProposedFix;
}

/** Verb-function injection surface for fix(). Each verb shells to the
 *  corresponding `atmux task <verb>` command in the real superdoctor
 *  tick; tests inject pure recorders. Per ADR-131 §D6 — verb surface
 *  is the authority bound, no direct SQL writes from detectors. */
export interface FixDeps {
  /** Reassigns `task.owner = member`. Per ADR-131 §D6 `atmux task
   *  assign <id> <member>` exists today. */
  assignVerb: (taskId: string, member: string) => Promise<void>;
  /** Sets `task.lane = lane`. Per ADR-131 §D6 `atmux task lane`
   *  shipped as part of T4 (sibling Task t-93b59741). */
  laneVerb: (taskId: string, lane: string) => Promise<void>;
  /** Sets `task.priority = priority`. Per ADR-131 §D6 `atmux task
   *  priority` shipped as part of T4 (sibling Task t-93b59741). */
  priorityVerb: (taskId: string, priority: number) => Promise<void>;
}

/** Subset of `Team` the detectors need — narrow to the roster so
 *  drain-loop callers can pass a stripped Team without dragging the
 *  full schema. */
export interface TeamState {
  members: ReadonlyArray<TeamMember>;
}

// ---------- Deterministic candidate pick ----------

/** ADR-131 §D3 — the four-rule resolution applied by every reassign
 *  detector (ghost-owner, role-mismatch) AND the lane-backfill detector
 *  (lane-null-orphan, which picks a member first then reads its lane):
 *
 *   1. Lane affinity — `opts.lane` (when set) narrows candidates to
 *      members whose declared `lane` matches. If zero match, the lane
 *      filter is **dropped** (degrade-not-refuse — the lane-affinity
 *      filter is a preference, not a hard gate).
 *   2. Role exclusion — `opts.excludeRoles` strips non-execution roles
 *      (planner, lead, reviewer, gitter, devops-encore) for the
 *      role-mismatch detector. Applied BEFORE lane affinity so a
 *      planner with the right lane doesn't shadow a real worker.
 *   3. Current load — within the post-filter candidate set, lowest
 *      count of `status === "in-progress"` tasks (per the `kanban`
 *      arg) wins.
 *   4. Alphabetical — tied-load tiebreak via `localeCompare(b.name)`.
 *      Deterministic across Node runtimes per ICU.
 *
 *  Returns `null` if zero candidates survive every filter (i.e. the
 *  excluded set IS the entire roster). The detector's `fix()` then
 *  emits `kind: escalate` per §D5's refuse-and-ask escape. */
export function pickCandidate(opts: {
  members: ReadonlyArray<TeamMember>;
  kanban: ReadonlyArray<KanbanTask>;
  /** Optional lane-affinity preference. Empty string is treated as
   *  "no preference" (lane=null orphans pass undefined / null). */
  lane?: string | null;
  /** Optional role exclusion. Members with any role in this set are
   *  filtered out. Used by role-mismatch + ghost-owner (never
   *  reassigns ghost-owned execution tasks to a planner). */
  excludeRoles?: ReadonlyArray<string>;
}): TeamMember | null {
  let candidates: ReadonlyArray<TeamMember> = opts.members;

  if (opts.excludeRoles !== undefined && opts.excludeRoles.length > 0) {
    const excluded = new Set(opts.excludeRoles);
    candidates = candidates.filter((m) => {
      const role = m.role;
      return role === undefined || !excluded.has(role);
    });
  }

  if (opts.lane !== undefined && opts.lane !== null && opts.lane !== "") {
    const laneFiltered = candidates.filter((m) => m.lane === opts.lane);
    // Degrade-not-refuse: if NO member matches the lane affinity,
    // keep the post-role-exclusion set rather than narrowing to zero.
    if (laneFiltered.length > 0) {
      candidates = laneFiltered;
    }
  }

  if (candidates.length === 0) return null;

  // Load count: in-progress tasks per current owner. Snapshot map
  // computed once per call (O(K) over kanban) so the sort below is
  // O(N log N) over candidates without nested scans.
  const loadByMember = new Map<string, number>();
  for (const t of opts.kanban) {
    if (t.status === "in-progress" && t.owner != null && t.owner !== "") {
      loadByMember.set(t.owner, (loadByMember.get(t.owner) ?? 0) + 1);
    }
  }

  const sorted = [...candidates].sort((a, b) => {
    const la = loadByMember.get(a.name) ?? 0;
    const lb = loadByMember.get(b.name) ?? 0;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  });

  return sorted[0] ?? null;
}

/** ADR-131 §D2-3 role-mismatch detector exclusion list — roles that
 *  do not own execution-class Tasks. Co-located so both
 *  role-mismatch.ts (detection) and ghost-owner.ts (reassignment
 *  guard, so we don't accidentally reassign a ghost-owned execution
 *  task to a planner) read the same source of truth. */
export const NON_EXECUTION_ROLES: ReadonlyArray<string> = [
  "planner",
  "lead",
  "team-lead",
  "reviewer",
  "gitter",
  "devops-encore",
];

/** ADR-131 §D2 role-mismatch detector — set of lanes that mark a Task
 *  as "execution-class" for the role-mismatch fingerprint. Other lanes
 *  (`review`, `misc`, etc.) are coordination/admin Tasks that planners
 *  + reviewers legitimately own. */
export const EXECUTION_LANES: ReadonlyArray<string> = ["fe", "be", "ops", "test"];

/** ADR-131 §D2 role-mismatch detector — regex matching execution-class
 *  body verbs. Each alternative carries its own trailing anchor:
 *  `implement\b` requires a word→non-word boundary (rejects
 *  "implementation"); `feat:` / `fix:` self-terminate at the colon
 *  (rejects "non-feature"). A trailing `\b` after the colon never
 *  matches — `\b` needs a word/non-word transition and `:` is
 *  non-word, so `:`-followed-by-non-word has no boundary. The earlier
 *  shape `(implement|feat:|fix:)\b` silently rejected every `feat:` /
 *  `fix:` body — t-5251b666 sibling-E (EPIC t-2b801707). */
export const EXECUTION_BODY_RE = /\b(implement\b|feat:|fix:)/i;
