// ADR-131 §D2-D4 / T3: drain-loop integration.
//
// One drain pass per superdoctor tick per team:
//   1. Run all 5 detectors over (team, kanban).
//   2. Upsert every issue into `superdoctor_hygiene` (idempotent on
//      (taskId, fingerprintClass) — bumps last_seen_at if present).
//   3. Filter unfixed rows by the confidence ladder (§D2):
//        high   → eligible on first detection
//        medium → eligible only when last_seen_at > detected_at
//                 (seen across multiple ticks — flap-dampener)
//        low    → eligible only when no P0/P1 fingerprints exist
//   4. Pick top-1 by `severity ASC, detected_at ASC`.
//   5. Apply fix() via the verb-injection deps; record result.
//
// One fix per tick per team — bounded blast radius. The
// superdoctor's hourly cadence + the rest-of-tick complaint /
// structural-fix passes still run alongside; this is one pass added
// to the chain.

import type { KanbanTask } from "../../schema/kanban.ts";
import * as ghostOwner from "./ghost-owner.ts";
import * as laneMismatch from "./lane-mismatch.ts";
import * as laneNullOrphan from "./lane-null-orphan.ts";
import * as prioNull from "./prio-null.ts";
import * as roleMismatch from "./role-mismatch.ts";
import type {
  FixDeps,
  FixResult,
  HygieneFingerprintClass,
  HygieneIssue,
  TeamState,
} from "./_shared.ts";
import type { HygieneRepo, HygieneRow } from "../repositories/hygiene-repo.ts";

/** Aggregate detector output across all 5 classes. Exposed for tests
 *  + future external consumers (e.g. an `atmux doctor` summary table
 *  that wants to see hygiene fingerprints without running the drain). */
export function detectAll(
  team: TeamState,
  kanban: ReadonlyArray<KanbanTask>,
): HygieneIssue[] {
  return [
    ...ghostOwner.detect(team, kanban),
    ...laneMismatch.detect(team, kanban),
    ...roleMismatch.detect(team, kanban),
    ...laneNullOrphan.detect(team, kanban),
    ...prioNull.detect(team, kanban),
  ];
}

/** Resolve the detector module owning a given fingerprint class.
 *  Centralised so additions in T6/T7 don't need to update the
 *  drain-loop's `switch`. */
function detectorFor(cls: HygieneFingerprintClass): {
  fix: (issue: HygieneIssue, deps: FixDeps) => Promise<FixResult>;
} {
  switch (cls) {
    case "ghost-owner":
      return ghostOwner;
    case "lane-mismatch":
      return laneMismatch;
    case "role-mismatch":
      return roleMismatch;
    case "lane-null-orphan":
      return laneNullOrphan;
    case "prio-null":
      return prioNull;
  }
}

/** Reconstruct a HygieneIssue from a persisted row. The drain loop
 *  needs this to pass to detector.fix() — fix() expects the same
 *  shape detect() emitted. The reconstruction is loss-free: every
 *  field stored in the row maps back to a HygieneIssue field. */
function issueFromRow(row: HygieneRow): HygieneIssue | null {
  if (row.attemptedFix === null) return null; // shouldn't happen — upsert always stringifies
  return {
    taskId: row.taskId,
    fingerprintClass: row.fingerprintClass,
    severity: row.severity,
    confidence: row.confidence,
    diagnosis: row.diagnosis,
    proposedFix: row.attemptedFix,
  };
}

/** ADR-131 §D2 confidence ladder. Returns true if the row is eligible
 *  for a fix this tick under the active confidence rule. `hasBlocking`
 *  is the tick-scoped flag — true when any unfixed P0/P1 row exists
 *  this tick (low-confidence rows are starved out until blocking is
 *  drained). */
function eligibleByLadder(row: HygieneRow, hasBlocking: boolean): boolean {
  if (row.confidence === "high") return true;
  if (row.confidence === "medium") {
    // Only eligible on 2nd-tick same-fingerprint — last_seen_at is
    // bumped on each detection, so when last_seen > detected the
    // fingerprint has been present across ≥2 ticks. First-detection
    // ticks have last_seen == detected.
    return row.lastSeenAt > row.detectedAt;
  }
  // low: defer until blocking classes drained
  return !hasBlocking;
}

export interface DrainTickResult {
  /** Total detector hits this tick (across all 5 classes). Equals
   *  `detectAll(team, kanban).length` — included for observability so
   *  the verb's JSON output can show the full work item count. */
  detected: number;
  /** Number of rows now sitting unfixed in `superdoctor_hygiene` at the
   *  end of this tick (post-upsert, pre-fix or post-failed-fix). */
  unfixedAfter: number;
  /** The single fingerprint that was drained this tick — null when
   *  no eligible row exists. Carries the full row + the FixResult so
   *  the verb output (and T6 e2e assertions) can inspect both. */
  drained: {
    row: HygieneRow;
    result: FixResult;
  } | null;
  /** Reason the drain skipped — populated when `drained === null` and
   *  unfixed rows DO exist but none were eligible under the confidence
   *  ladder. Empty string when no unfixed rows at all (truly idle). */
  skipReason: "no-unfixed" | "ladder-defer" | "";
}

/** ADR-131 §D2-D3 — execute one drain tick. Pure orchestration: the
 *  detectors are stateless, the repo carries the (taskId, class)
 *  identity across ticks, and the FixDeps shells to atmux verbs for
 *  the actual mutation.
 *
 *  Tests inject a mock `now` for determinism + a mock FixDeps that
 *  records verb calls; production callers pass `Date.now() / 1000`
 *  + the real verb shells. */
export async function drainTick(opts: {
  team: TeamState;
  kanban: ReadonlyArray<KanbanTask>;
  repo: HygieneRepo;
  deps: FixDeps;
  now: number;
}): Promise<DrainTickResult> {
  const { team, kanban, repo, deps, now } = opts;

  // (1) detect all 5 classes
  const issues = detectAll(team, kanban);

  // (2) upsert every issue — idempotent on (taskId, class)
  for (const issue of issues) {
    repo.upsertFingerprint(issue, now);
  }

  // (3) listUnfixed + ladder filter
  const unfixed = repo.listUnfixed();
  const result: DrainTickResult = {
    detected: issues.length,
    unfixedAfter: unfixed.length,
    drained: null,
    skipReason: "",
  };

  if (unfixed.length === 0) {
    result.skipReason = "no-unfixed";
    return result;
  }

  const hasBlocking = unfixed.some(
    (r) => r.severity === "P0" || r.severity === "P1",
  );
  const eligible = unfixed.filter((r) => eligibleByLadder(r, hasBlocking));

  if (eligible.length === 0) {
    result.skipReason = "ladder-defer";
    return result;
  }

  // (4) eligible is already sorted by severity ASC, detected_at ASC
  // (listUnfixed's ORDER BY); the ladder filter preserves order.
  // Pick top-1.
  const top = eligible[0]!;

  // (5) apply fix
  const issue = issueFromRow(top);
  if (issue === null) {
    // Defensive: corrupted row missing attempted_fix JSON. Mark as
    // failed-fix so it drops out of listUnfixed and doesn't wedge
    // the drain loop on a permanently un-pick'able row.
    repo.markFixed(top.taskId, top.fingerprintClass, now, false);
    result.drained = {
      row: top,
      result: { applied: false, reason: "verb-failed" },
    };
    return result;
  }

  const fixResult = await detectorFor(top.fingerprintClass).fix(issue, deps);
  repo.markFixed(top.taskId, top.fingerprintClass, now, fixResult.applied);

  result.drained = { row: top, result: fixResult };
  return result;
}
