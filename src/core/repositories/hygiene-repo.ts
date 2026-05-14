// ADR-131 §D4 / T3: hygiene fingerprint repository.
//
// Wraps the `superdoctor_hygiene` table (migration v2→v3 in
// `src/abstractions/sqlite-migrations.ts`). Three operations cover the
// drain-loop's needs:
//
//   1. `upsertFingerprint(issue, now)` — called once per detector hit
//      per tick. Idempotent on (task_id, fingerprint_class): inserts
//      new rows OR bumps `last_seen_at` on existing rows. The detector
//      output's `diagnosis` / `attempted_fix` JSON / `severity` /
//      `confidence` are refreshed too — a detector that changes its
//      proposed-fix (e.g. ghost-owner re-picks a different candidate
//      because load changed) sees the new shape on the next tick.
//
//   2. `listUnfixed()` — drain-loop input. Returns rows with
//      `fix_applied_at IS NULL`, ordered by `severity ASC, detected_at
//      ASC` (P0 oldest first). Uses the partial index from v3.
//
//   3. `markFixed(taskId, fingerprintClass, now, successful)` — drain
//      output. Updates `fix_applied_at` + `fix_successful` so the row
//      drops out of `listUnfixed`. Fixed rows persist for audit per
//      ADR-077 §F2.

import type { Database } from "../../abstractions/sqlite.ts";
import type {
  HygieneConfidence,
  HygieneFingerprintClass,
  HygieneIssue,
  HygieneProposedFix,
  HygieneSeverity,
} from "../superdoctor-hygiene/_shared.ts";

/** Persisted shape of one hygiene fingerprint. Mirrors the SQL
 *  columns but lifts JSON encodings (severity INT → string,
 *  attempted_fix TEXT → object) for ergonomic consumption by the
 *  drain loop + T6 e2e assertions. */
export interface HygieneRow {
  taskId: string;
  fingerprintClass: HygieneFingerprintClass;
  severity: HygieneSeverity;
  confidence: HygieneConfidence;
  diagnosis: string;
  detectedAt: number;
  lastSeenAt: number;
  attemptedFix: HygieneProposedFix | null;
  fixAppliedAt: number | null;
  fixSuccessful: boolean | null;
}

/** Convert the string-form severity (ergonomic for detectors) to the
 *  integer-form severity (cheap `ORDER BY` in SQL). P0=0, P1=1, P3=3
 *  per ADR-131 task body. P2 reserved but unused — included for
 *  forward-compat without affecting existing rows. */
export function severityToInt(s: HygieneSeverity): number {
  if (s === "P0") return 0;
  if (s === "P1") return 1;
  return 3; // "P3"
}

export function intToSeverity(n: number): HygieneSeverity {
  if (n === 0) return "P0";
  if (n === 1) return "P1";
  return "P3";
}

interface HygieneRawRow {
  task_id: string;
  fingerprint_class: string;
  severity: number;
  confidence: string;
  diagnosis: string;
  detected_at: number;
  last_seen_at: number;
  attempted_fix: string | null;
  fix_applied_at: number | null;
  fix_successful: number | null;
}

function rowFromRaw(raw: HygieneRawRow): HygieneRow {
  let attempted: HygieneProposedFix | null = null;
  if (raw.attempted_fix !== null) {
    try {
      attempted = JSON.parse(raw.attempted_fix) as HygieneProposedFix;
    } catch {
      // Corrupt row — never happens via upsertFingerprint (we
      // stringify a typed union) but defensive against
      // hand-edited DBs. Treat as null.
      attempted = null;
    }
  }
  return {
    taskId: raw.task_id,
    fingerprintClass: raw.fingerprint_class as HygieneFingerprintClass,
    severity: intToSeverity(raw.severity),
    confidence: raw.confidence as HygieneConfidence,
    diagnosis: raw.diagnosis,
    detectedAt: raw.detected_at,
    lastSeenAt: raw.last_seen_at,
    attemptedFix: attempted,
    fixAppliedAt: raw.fix_applied_at,
    fixSuccessful:
      raw.fix_successful === null ? null : raw.fix_successful === 1,
  };
}

export class HygieneRepo {
  constructor(private db: Database) {}

  /** Insert OR refresh a fingerprint row. On insert: `detected_at` +
   *  `last_seen_at` both = `now`. On conflict: `last_seen_at` = `now`,
   *  `detected_at` preserved (history-accurate), severity / confidence
   *  / diagnosis / attempted_fix refreshed from the new issue. Fixed
   *  rows (fix_applied_at IS NOT NULL) are NOT re-opened — re-detecting
   *  a fixed fingerprint is a re-flap and gets its own NEW row at the
   *  same key only if the prior row is cleared. The unique constraint
   *  prevents duplication; the upsert refreshes the existing audit row. */
  upsertFingerprint(issue: HygieneIssue, now: number): void {
    const sev = severityToInt(issue.severity);
    const attempted = JSON.stringify(issue.proposedFix);
    this.db
      .query(
        `INSERT INTO superdoctor_hygiene (
					task_id, fingerprint_class, severity, confidence, diagnosis,
					detected_at, last_seen_at, attempted_fix
				)
				VALUES ($task_id, $fingerprint_class, $severity, $confidence, $diagnosis,
				        $detected_at, $last_seen_at, $attempted_fix)
				ON CONFLICT(task_id, fingerprint_class) DO UPDATE SET
					last_seen_at = excluded.last_seen_at,
					severity = excluded.severity,
					confidence = excluded.confidence,
					diagnosis = excluded.diagnosis,
					attempted_fix = excluded.attempted_fix`,
      )
      .run({
        $task_id: issue.taskId,
        $fingerprint_class: issue.fingerprintClass,
        $severity: sev,
        $confidence: issue.confidence,
        $diagnosis: issue.diagnosis,
        $detected_at: now,
        $last_seen_at: now,
        $attempted_fix: attempted,
      });
  }

  /** List unfixed rows ordered by severity (P0 first) then
   *  detected_at (oldest first). Hits the partial v3 index for
   *  hot-path performance. */
  listUnfixed(): HygieneRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM superdoctor_hygiene
				 WHERE fix_applied_at IS NULL
				 ORDER BY severity ASC, detected_at ASC`,
      )
      .all() as HygieneRawRow[];
    return rows.map(rowFromRaw);
  }

  /** Fetch one row by composite key. Used by tests + drain-loop audit
   *  after `markFixed`. Returns null when the key doesn't exist. */
  getFingerprint(
    taskId: string,
    fingerprintClass: HygieneFingerprintClass,
  ): HygieneRow | null {
    const raw = this.db
      .query(
        `SELECT * FROM superdoctor_hygiene
				 WHERE task_id = $task_id AND fingerprint_class = $fingerprint_class`,
      )
      .get({
        $task_id: taskId,
        $fingerprint_class: fingerprintClass,
      }) as HygieneRawRow | null;
    return raw === null ? null : rowFromRaw(raw);
  }

  /** Mark a fingerprint as fixed. `successful: true` → fix_successful=1,
   *  `false` → fix_successful=0. Either way the row drops out of
   *  listUnfixed via the WHERE fix_applied_at IS NULL clause; fix
   *  failures still consume the drain slot for the tick so the loop
   *  doesn't infinite-retry. */
  markFixed(
    taskId: string,
    fingerprintClass: HygieneFingerprintClass,
    now: number,
    successful: boolean,
  ): void {
    this.db
      .query(
        `UPDATE superdoctor_hygiene
				 SET fix_applied_at = $fix_applied_at, fix_successful = $fix_successful
				 WHERE task_id = $task_id AND fingerprint_class = $fingerprint_class`,
      )
      .run({
        $task_id: taskId,
        $fingerprint_class: fingerprintClass,
        $fix_applied_at: now,
        $fix_successful: successful ? 1 : 0,
      });
  }
}
