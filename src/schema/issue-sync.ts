// ADR-261 §D4: issue_sync ledger + poll-cursor schemas.
//
// One `IssueSyncRecord` per canonical external issue identity
// (`sourceId`, §D3) in the POLLING team's state.db; one
// `IssueSyncCursor` per (trackerId, scope) pair, checkpointed per page
// so a killed paginating sync RESUMES rather than restarts. Schema
// field names match the SQL columns (`src/abstractions/
// sqlite-migrations.ts` v17) modulo snake/camel translation in the
// row↔domain bridge (`src/core/repositories/issue-sync-repo.ts`).
//
// `upstreamState` and `filingState` are intentionally free-form
// strings at the schema layer even though the verb constrains them
// (`open`/`closed` per `IssueState`; `pending`/`filed` per
// `ISSUE_SYNC_FILING_STATES`) — the bias matches `Complaint.status`
// (passthrough on the schema, enum at the verb) so future literals
// land without a schema break.
//
// `extra` is the forward-compat JSON bag — same pattern as
// `Complaint.extra`. Sync code may stash tracker metadata here (issue
// URL, labels, author) without churning the schema.

import { z } from "zod";

/** Allowed `filingState` values at the verb layer (ADR-261 §D4
 *  ledger-first crash-window flag). Schema stays free-form (TEXT):
 *    - `pending` — ledger row written, complaint NOT yet confirmed
 *      filed in the target team's DB. A `pending` row found at sync
 *      start is the crash-window repair signal.
 *    - `filed`   — the complaint landed; `complaintId` carries the
 *      cross-DB back-pointer. */
export const ISSUE_SYNC_FILING_STATES = ["pending", "filed"] as const;
export type IssueSyncFilingState = (typeof ISSUE_SYNC_FILING_STATES)[number];

export const IssueSyncRecord = z
  .object({
    /** Canonical external issue identity (ADR-261 §D3):
     *  `github:owner/repo#123`, `ado:org/project/42`. Primary key —
     *  the same string used as the complaints-row `sourceId`. */
    sourceId: z.string().min(1),
    /** Owning adapter's stable id (ADR-261 §D2): `github` /
     *  `azure-devops`. Free-form at schema; the allowlist lives on
     *  `TrackerId` (`src/abstractions/issue-tracker.ts`). */
    trackerId: z.string().min(1),
    /** Per-adapter scope string: `owner/repo` (github) /
     *  `org/project` (azure-devops). From the `team.json::issueSync`
     *  allowlist (ADR-261 §D7.2). */
    scope: z.string().min(1),
    /** Back-pointer to the filed complaint row. CROSS-DB (§D4
     *  residency): when `targetTeam` ≠ the polling team, the
     *  complaint lives in ANOTHER team's state.db per ADR-150 §D1 —
     *  no FK, no shared transaction. NULL while `filingState` is
     *  `pending` (or when the §D4 absent+closed arm recorded the row
     *  without ever filing). */
    complaintId: z.string().nullable().default(null),
    /** Team whose lead adjudicates — where the complaint row lives
     *  (ADR-261 §D9 routing). NULL ⇒ the polling team itself. */
    targetTeam: z.string().nullable().default(null),
    /** Normalized upstream state — `open`/`closed` at the verb layer
     *  (`IssueState`), free TEXT here. Drives the §D4 sync-state
     *  matrix (auto-resolve on close, re-surface on reopen). */
    upstreamState: z.string().min(1),
    /** Upstream last-modified, epoch seconds — the §D4 "newer
     *  updatedAt ⇒ refresh extra, no new row" comparator. */
    upstreamUpdatedAtSec: z.number().int().nonnegative(),
    /** Resolution PROVENANCE for the §D4 reopen-symmetry matrix:
     *  `tracker:<id>` when the sync auto-resolved as an upstream
     *  mirror (re-surfaces on upstream reopen); `lead` when the lead
     *  resolved/wontfixed (never re-litigated by a poll). NULL while
     *  the complaint is open / never filed. */
    localResolution: z.string().nullable().default(null),
    /** §D4 ledger-first crash-window flag — see
     *  {@link ISSUE_SYNC_FILING_STATES}. Free-form at schema; the
     *  repo writes only the allowlisted literals. */
    filingState: z.string().default("pending"),
    /** Epoch seconds the ledger first saw this `sourceId`. */
    firstSeenSec: z.number().int().nonnegative(),
    /** Epoch seconds of the most recent sync touch — advanced even on
     *  the §D4 no-op arm (open + unchanged updatedAt). */
    lastSyncedSec: z.number().int().nonnegative(),
    /** Forward-compat JSON bag (parsed on read; serialized on write). */
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type IssueSyncRecord = z.infer<typeof IssueSyncRecord>;

export const IssueSyncCursor = z
  .object({
    /** Owning adapter's stable id — first half of the composite PK. */
    trackerId: z.string().min(1),
    /** Per-adapter scope string — second half of the composite PK. */
    scope: z.string().min(1),
    /** Opaque adapter-owned resume token (GitHub page link / ADO
     *  continuation token — never parsed by consumers, per
     *  `IssueTrackerPage.nextCursor`). NULL = listing exhausted /
     *  start from the top. Checkpointed PER PAGE (§D4): a killed 900s
     *  tick resumes here, never restarts. */
    cursor: z.string().nullable().default(null),
    /** Epoch seconds of the last checkpoint write. */
    updatedAtSec: z.number().int().nonnegative(),
  })
  .passthrough();
export type IssueSyncCursor = z.infer<typeof IssueSyncCursor>;
