// ADR-077 §F6: superdoctor self-escalation event log.
//
// One row per structural-fix attempt the skill takes against a complaint
// (rotate-lead, kill+respawn, /clear, etc.). Field names match the SQL
// columns in `src/abstractions/sqlite-migrations.ts` v3 modulo
// snake/camel translation in the repo's row↔domain bridge.
//
// `outcome` is the load-bearing field for the escalation trigger:
// three consecutive `failed` rows for the same `complaintId` fire
// the `[self-heal-failed]` Discord ping (dedup state in state_kv).
//
// `extra` is the forward-compat JSON bag — same pattern as
// `Complaint.extra` and `KanbanTask.extra`.

import { z } from "zod";

/** The closed set of attempt outcomes. SQL-side CHECK constraint
 *  mirrors this list. */
export const ATTEMPT_OUTCOMES = ["resolved", "partial", "failed"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const SuperdoctorAttempt = z
  .object({
    /** Autoincrement row id from SQLite. Optional on insert (DB assigns). */
    id: z.number().int().nonnegative().nullable().default(null),
    /** FK-style reference to `complaints.id`. Not enforced as a SQL
     *  foreign key — superdoctor may file attempts for synthetic
     *  complaint hashes that pre-exist a complaint row, and the
     *  per-team complaints table is local. */
    complaintId: z.string().min(1),
    /** 1-based attempt counter within the same complaintId. The skill
     *  composes this; the table stores. */
    attemptN: z.number().int().positive(),
    /** Outcome of THIS attempt. The triple-`failed` trigger uses
     *  COUNT(*) WHERE outcome='failed' GROUP BY complaint_id. */
    outcome: z.enum(ATTEMPT_OUTCOMES),
    /** Epoch seconds when the attempt completed. */
    attemptedAt: z.number().int().nonnegative(),
    /** Free-form action label, e.g. `rotate-lead`, `kill-respawn`,
     *  `clear-member:fe0`. Surfaced in the Discord footer line. */
    action: z.string().nullable().default(null),
    /** Free-form one-line observation — verify reason, pane state,
     *  SHA the attempt landed at. */
    note: z.string().nullable().default(null),
    /** Forward-compat JSON bag — parsed on read, serialized on write. */
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type SuperdoctorAttempt = z.infer<typeof SuperdoctorAttempt>;
