// ADR-077 §F6: superdoctor self-escalation attempts repository.
//
// SQL is owned here; the skill (via a future verb) sees a typed surface.
// Pattern mirrors `complaints-repo.ts` — row interface, row↔domain
// bridges, methods on the repo class.
//
// The load-bearing query is `countFailedFor(complaintId)`: when it
// reaches 3, the skill renders `renderSelfHealFailed` and emits one
// Discord ping (deduped via state_kv). Everything else (resolved /
// partial / older buckets) is observability for the audit trail.

import type { Database } from "bun:sqlite";
import {
  type AttemptOutcome,
  type SuperdoctorAttempt,
  SuperdoctorAttempt as SuperdoctorAttemptSchema,
} from "../../schema/superdoctor-attempts.ts";

// ---------- Row shape (SQL columns; raw bun:sqlite output) ----------

interface AttemptRow {
  id: number;
  complaint_id: string;
  attempt_n: number;
  outcome: string;
  attempted_at: number;
  action: string | null;
  note: string | null;
  extra: string | null;
}

// ---------- Row ↔ domain bridges ----------

export function attemptFromRow(row: AttemptRow): SuperdoctorAttempt {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  return SuperdoctorAttemptSchema.parse({
    id: row.id,
    complaintId: row.complaint_id,
    attemptN: row.attempt_n,
    outcome: row.outcome,
    attemptedAt: row.attempted_at,
    action: row.action,
    note: row.note,
    extra,
  });
}

/** Concrete input shape for `insert`. The Zod-inferred type carries
 *  `.passthrough()` index signatures that collapse field types to
 *  `unknown` at call sites; the typed-CRUD surface needs concrete
 *  types so bun:sqlite's `.run(...)` binding inference works. */
export interface SuperdoctorAttemptInput {
  complaintId: string;
  attemptN: number;
  outcome: AttemptOutcome;
  attemptedAt: number;
  action: string | null;
  note: string | null;
  extra: Record<string, unknown>;
}

// ---------- Repository ----------

export class SuperdoctorAttemptsRepo {
  constructor(private readonly db: Database) {}

  /** Insert a new attempt row. SQLite assigns `id`; the returned value
   *  is the rowid the insert produced. */
  insert(a: SuperdoctorAttemptInput): number {
    const extra = Object.keys(a.extra).length > 0 ? JSON.stringify(a.extra) : null;
    const result = this.db
      .prepare(
        `INSERT INTO superdoctor_attempts (
            complaint_id, attempt_n, outcome, attempted_at, action, note, extra
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.complaintId, a.attemptN, a.outcome, a.attemptedAt, a.action, a.note, extra);
    return Number(result.lastInsertRowid);
  }

  /** All attempts for a complaint, newest first. */
  listForComplaint(complaintId: string): SuperdoctorAttempt[] {
    const rows = this.db
      .query("SELECT * FROM superdoctor_attempts WHERE complaint_id = ? ORDER BY attempted_at DESC")
      .all(complaintId) as AttemptRow[];
    return rows.map(attemptFromRow);
  }

  /** Count attempts with a specific outcome for one complaint — the
   *  load-bearing query for the N=3-failed escalation trigger. */
  countByOutcomeFor(complaintId: string, outcome: AttemptOutcome): number {
    const r = this.db
      .query(
        "SELECT COUNT(*) AS n FROM superdoctor_attempts WHERE complaint_id = ? AND outcome = ?",
      )
      .get(complaintId, outcome) as { n: number } | null;
    return r?.n ?? 0;
  }

  /** Most recent attempt for a complaint, or null when none exist. */
  latestFor(complaintId: string): SuperdoctorAttempt | null {
    const row = this.db
      .query(
        "SELECT * FROM superdoctor_attempts WHERE complaint_id = ? ORDER BY attempted_at DESC LIMIT 1",
      )
      .get(complaintId) as AttemptRow | null;
    return row === null ? null : attemptFromRow(row);
  }

  /** Most recent attempted_at epoch across ALL complaints in this DB.
   *  Returns null when the table is empty. Used by the cockpit-pulse
   *  meta-watchdog (t-351318dc) to detect superdoctor dormancy — the
   *  aggregate caller takes MAX across every cockpit-enabled team's
   *  state.db to get the global latest activity. */
  latestAttemptedAt(): number | null {
    const r = this.db.query("SELECT MAX(attempted_at) AS max FROM superdoctor_attempts").get() as {
      max: number | null;
    } | null;
    return r?.max ?? null;
  }
}
