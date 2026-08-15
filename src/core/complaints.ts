// ADR-177 §T2 (Task t-e91fec98) — dedup-aware complaint filer.
//
// The whip→superdoctor escalation pipeline must coalesce repeated strikes
// into a single complaint row + a bumped `source_count`, NOT flood the
// complaints box with one row per tick. Task body §5: "Dedup: re-file
// within 1h of an open same-hash complaint = no new row, just bump
// source_count + last_seen on the existing row."
//
// This module owns the orchestration: look up an existing open row by
// `source_id` within a configurable window, bump it if found, otherwise
// insert fresh. SQL primitives live on `ComplaintsRepo`
// (`findOpenBySourceId` + `bumpSourceCount`); this layer is the only
// caller that combines them, so the dedup contract lives here.
//
// The function is intentionally synchronous (bun:sqlite is sync) and
// pure-aside-from-the-db-argument — `nowSec` is injected so tests can
// pin the clock and exercise the window boundary deterministically.

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { emit } from "../abstractions/events.ts";
import type { Complaint } from "../schema/complaints.ts";
import { ComplaintsRepo } from "./repositories/complaints-repo.ts";

/** Default dedup window — matches Task t-e91fec98 §5 "re-file within 1h
 *  of an open same-hash complaint". Operators can pass a shorter window
 *  in tests via `dedupWindowSec`; production callers use the default. */
export const DEFAULT_DEDUP_WINDOW_SEC = 3600;

/** Inputs to the dedup-aware filer. `sourceKind` / `sourceId` /
 *  `targetTeam` are the three fields that participate in dedup keying;
 *  the remaining fields populate the new row when we're not coalescing. */
export interface FileDedupedOpts {
  /** Complaint source kind (per `COMPLAINT_SOURCE_KINDS`). Stamped on the
   *  new row; ignored on bumps (the existing row's sourceKind wins). */
  sourceKind: string;
  /** Structured source identifier — the dedup key. For whip escalations
   *  this is the symptom-hash from `whip-strikes.ts`. */
  sourceId: string;
  /** Team the complaint is ABOUT — distinct from the team whose state.db
   *  holds the row (Complaint.targetTeam comment). */
  targetTeam: string;
  /** One-line summary; becomes `incidentSummary`. Required (schema-min). */
  incidentSummary: string;
  /** One-sentence diagnosis; becomes `rootCause`. */
  rootCause?: string | null;
  /** Structural-fix proposal; becomes `preventiveAsk`. */
  preventiveAsk?: string | null;
  /** Free-form attribution; becomes `openedBy`. */
  openedBy?: string | null;
  /** Forward-compat JSON bag. `source_count` + `last_seen` are managed
   *  by this filer and overwrite any caller-supplied values for those
   *  two keys — every other key from `extra` is preserved verbatim. */
  extra?: Record<string, unknown>;
  /** Dedup lookback in seconds. Default 3600 (1h). */
  dedupWindowSec?: number;
}

/** Outcome of `fileDedupedComplaint`. `isNew` lets the caller decide
 *  whether to log a "duplicate suppressed" event vs a "new complaint
 *  filed" event; `sourceCount` lets the caller surface "complaint X
 *  re-armed N times" in the eventual escalation message. */
export interface FileDedupedResult {
  /** Complaint row id — newly minted (when `isNew`) or the existing
   *  row's id (when bumped). */
  id: string;
  /** True if a fresh row was inserted; false if an existing row's
   *  source_count + last_seen were bumped. */
  isNew: boolean;
  /** `extra.source_count` after the operation. 1 for fresh rows; N+1
   *  for bumps (with N being the previous count, defaulting to 1 when
   *  the existing row pre-dates this dedup convention). */
  sourceCount: number;
}

/**
 * File a complaint with dedup by `source_id`. If an OPEN complaint with
 * the same `source_id` was filed at or after `nowSec - dedupWindowSec`,
 * bump that row's `extra.source_count` + `extra.last_seen` and return
 * `{ isNew: false, ... }`. Otherwise insert a fresh row with
 * `extra.source_count = 1` + `extra.last_seen = nowSec` and return
 * `{ isNew: true, ... }`.
 *
 * Why `isNew` matters: T2 (Task t-e91fec98 §6) resets the strike
 * counter after a complaint lands. Resetting on bumps too is correct —
 * the strikes have done their job once a complaint exists, and the
 * next escalation should land on a clean window. The strike-reset
 * decision lives in the caller; this filer just reports what happened.
 *
 * Pure: synchronous (bun:sqlite is sync) and clockless (nowSec
 * injected). Tests construct an in-memory DB via
 * `openDatabase(":memory:", migrations)` and call this directly — no
 * filesystem, no Date.now().
 */
export function fileDedupedComplaint(
  db: Database,
  nowSec: number,
  opts: FileDedupedOpts,
): FileDedupedResult {
  const repo = new ComplaintsRepo(db);
  const windowSec = opts.dedupWindowSec ?? DEFAULT_DEDUP_WINDOW_SEC;
  const since = nowSec - windowSec;
  const existing = repo.findOpenBySourceId(opts.sourceId, since);
  if (existing !== null) {
    // Bump: prev count defaults to 1 for legacy rows that pre-date the
    // source_count convention (e.g. complaints filed manually via the
    // CLI before T2 landed). Treating those as "first occurrence" and
    // incrementing to 2 matches operator intuition.
    const prevCount =
      typeof existing.extra.source_count === "number" ? existing.extra.source_count : 1;
    const newCount = prevCount + 1;
    repo.bumpSourceCount(existing.id, nowSec, newCount);
    emitComplaintFiled(db, {
      complaintId: existing.id,
      targetTeam: opts.targetTeam,
      sourceKind: opts.sourceKind,
      sourceId: opts.sourceId,
      incidentSummary: opts.incidentSummary,
      openedBy: opts.openedBy ?? null,
      severity: extractSeverity(opts.extra),
      sourceCount: newCount,
      bumped: true,
      filedAtSec: nowSec,
    });
    return { id: existing.id, isNew: false, sourceCount: newCount };
  }
  // Fresh row. `source_count` + `last_seen` overwrite any caller-supplied
  // values for those keys — the filer owns those fields. Everything else
  // in `extra` is preserved verbatim so callers can stash `kind`,
  // `severity`, etc. without conflict.
  const newExtra: Record<string, unknown> = {
    ...(opts.extra ?? {}),
    source_count: 1,
    last_seen: nowSec,
  };
  const id = `c-${randomBytes(4).toString("hex")}`;
  const c: Complaint = {
    id,
    openedAt: nowSec,
    openedBy: opts.openedBy ?? null,
    incidentSummary: opts.incidentSummary,
    rootCause: opts.rootCause ?? null,
    preventiveAsk: opts.preventiveAsk ?? null,
    status: "open",
    resolvedAt: null,
    resolvedBy: null,
    relatedTaskId: null,
    sourceKind: opts.sourceKind,
    sourceId: opts.sourceId,
    targetTeam: opts.targetTeam,
    extra: newExtra,
  };
  repo.insert(c);
  emitComplaintFiled(db, {
    complaintId: id,
    targetTeam: opts.targetTeam,
    sourceKind: opts.sourceKind,
    sourceId: opts.sourceId,
    incidentSummary: opts.incidentSummary,
    openedBy: opts.openedBy ?? null,
    severity: extractSeverity(opts.extra),
    sourceCount: 1,
    bumped: false,
    filedAtSec: nowSec,
  });
  return { id, isNew: true, sourceCount: 1 };
}

/** Pull `severity` out of the caller-supplied extra bag. Free-form by
 *  convention (commonly `info`/`warn`/`urgent`/`critical` per ADR-214). */
function extractSeverity(extra: Record<string, unknown> | undefined): string | null {
  if (extra === undefined) return null;
  const v = extra.severity;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** ADR-214 §D2 wire — emit `complaint.filed` post-write. Best-effort: a
 *  thrown error here (schema drift, db full) must NOT abort the file
 *  operation; the complaint row is already durable. Consumer wakes off
 *  the row regardless on its next drain via the cron-backstop sweep. */
function emitComplaintFiled(
  db: Database,
  payload: {
    complaintId: string;
    targetTeam: string;
    sourceKind: string;
    sourceId: string;
    incidentSummary: string;
    openedBy: string | null;
    severity: string | null;
    sourceCount: number;
    bumped: boolean;
    filedAtSec: number;
  },
): void {
  try {
    emit(db, {
      topic: "complaint.filed",
      ...payload,
    });
  } catch {
    // Substrate degradation — durable INSERT already succeeded. The
    // cron-backstop drain (ADR-202 §D6) catches the consumer up on
    // next tick.
  }
}
