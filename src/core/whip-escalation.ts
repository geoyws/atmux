// ADR-087 §T2 (Task t-e91fec98) — whip→superdoctor escalation orchestrator.
//
// The strike kernel (`whip-strikes.ts`) writes counters; the complaint
// filer (`complaints.ts`) writes rows. This module is the glue: when
// strikes hit threshold, build the complaint title + body, file it
// dedup-aware, reset the strike record. Task body §1-6 in one place.
//
// Why a separate module (not extending whip-strikes.ts directly): the
// escalation depends on `bun:sqlite` (via `fileDedupedComplaint`)
// whereas whip-strikes.ts is pure FS + JSON. Keeping the SQL dependency
// in a sibling module lets whip-strikes.ts continue to be testable
// without a Database fixture, which is the property V1's 100%-cover
// suite already relies on.
//
// Why a separate module (not in complaints.ts): the escalation owns the
// title/body templating + the strike-reset side effect. Complaints.ts
// stays narrowly focused on the dedup-aware insert contract. Two
// modules, two concerns.

import type { Database } from "bun:sqlite";
import { type FileDedupedResult, fileDedupedComplaint } from "./complaints.ts";
import { renderStrikeTimeline, resetStrikeRecord, type StrikeRecord } from "./whip-strikes.ts";

/** Default strike threshold — matches Task t-e91fec98 §1 ("when whip
 *  strike counter ≥ 3 for a team") + the ADR-087 schema default. The
 *  whip caller may override via `team.json::whip.velocityGate
 *  .strikeThreshold` (read in the deferred wire-up Task t-5d85dddb;
 *  this module accepts the threshold as a parameter). */
export const DEFAULT_STRIKE_THRESHOLD = 3;

/** Inputs to `maybeEscalateStrikes`. All evidence needed to template
 *  the complaint title + body comes from the caller — this module
 *  doesn't reach into pane state or git log. */
export interface MaybeEscalateOpts {
  /** Open SQLite handle on the team's `.atmux/state.db`. */
  db: Database;
  /** Path to the team's `.atmux/` directory — used only for the
   *  strike-record reset (whip-strikes.ts is FS-based). */
  atmuxDir: string;
  /** Team name; participates in the complaint `targetTeam` field +
   *  the `openedBy` attribution. */
  teamName: string;
  /** Stable hash for the symptom — must be one of the four built-in
   *  hashes (`velocityStalledSymptomHash` /
   *  `etaLiedSymptomHash` / `classifierSwallowSymptomHash` /
   *  `processFrozenSymptomHash`) OR a future caller's custom hash.
   *  Used as the complaint's `sourceId` for dedup keying. */
  symptomHash: string;
  /** Human-readable label for the symptom — populates the title.
   *  Examples: "eta-lied", "classifier-swallow", "process-frozen". */
  symptomLabel: string;
  /** What the whip saw — populates the title. Examples: "lead picked
   *  D=Standby 5 times without ETA hitting" / "queued reply
   *  unchanged across 4 ticks". */
  observableEvidence: string;
  /** How many menu nudges the whip has fired before escalating —
   *  populates the title's `whip-tried-N-menus` suffix (Task body §3). */
  whipMenusTried: number;
  /** Task IDs that went unship during the strike run — populates the
   *  body (Task body §4 "which Tasks went unship"). Empty array OK
   *  for symptoms not tied to a specific work claim. */
  unshippedTasks: string[];
  /** Current strike record from `readStrikeRecord` — the caller is
   *  responsible for reading + the count threshold check happens
   *  HERE so callers can call this unconditionally on every tick. */
  record: StrikeRecord;
  /** Epoch seconds; threaded into both the complaint's openedAt and
   *  the strike-timeline rendering. */
  nowSec: number;
  /** Strike threshold; default `DEFAULT_STRIKE_THRESHOLD`. */
  strikeThreshold?: number;
}

/** Outcome of `maybeEscalateStrikes`. The discriminated union lets
 *  callers branch on the "did anything happen" question without
 *  inspecting optional fields. */
export type MaybeEscalateResult =
  | {
      /** Strikes are below threshold — no complaint, no reset. */
      kind: "below-threshold";
      strikes: number;
      threshold: number;
    }
  | {
      /** A complaint was filed (fresh or bumped) + the strike record
       *  was reset. */
      kind: "filed";
      complaintId: string;
      /** True if a fresh complaint row was inserted; false if an
       *  existing open row's source_count was bumped (Task body §5). */
      isNew: boolean;
      /** `extra.source_count` after the operation — useful for logs
       *  ("complaint X re-armed for the Nth time"). */
      sourceCount: number;
    };

/**
 * Check the strike record against `strikeThreshold` (default 3) and,
 * if exceeded, file a complaint via the dedup-aware filer + reset the
 * strike record. Returns a discriminated-union result.
 *
 * Task body wiring (§1-6):
 *   - §1 "when strike counter ≥ 3" → `record.count >= threshold` gate
 *   - §2 "symptom hashes" → caller passes `symptomHash`; this module
 *     doesn't enforce a particular shape (allows future caller-defined
 *     hashes without code change here)
 *   - §3 "Complaint title: <team>: <symptom> · <observable> ·
 *     whip-tried-N-menus" → `buildComplaintTitle(...)`
 *   - §4 "Body: timeline of strikes + which Tasks went unship" →
 *     `buildComplaintBody(...)`
 *   - §5 "Dedup within 1h" → `fileDedupedComplaint` with default
 *     `DEFAULT_DEDUP_WINDOW_SEC` (1h)
 *   - §6 "Reset strike counter after complaint filed" →
 *     `resetStrikeRecord` after a successful file (both fresh + bumps;
 *     once a complaint exists, strikes have done their job)
 *
 * Pure-aside-from-IO: the SQL goes through `db` (sync, injected); the
 * strike-file reset goes through `atmuxDir` (async). `nowSec` is
 * injected for clock determinism in tests. The threshold defaults
 * here, not at the schema layer, so callers without a `team.json`
 * value still escalate at 3.
 */
export async function maybeEscalateStrikes(opts: MaybeEscalateOpts): Promise<MaybeEscalateResult> {
  const threshold = opts.strikeThreshold ?? DEFAULT_STRIKE_THRESHOLD;
  if (opts.record.count < threshold) {
    return { kind: "below-threshold", strikes: opts.record.count, threshold };
  }
  const title = buildComplaintTitle({
    teamName: opts.teamName,
    symptomLabel: opts.symptomLabel,
    observableEvidence: opts.observableEvidence,
    whipMenusTried: opts.whipMenusTried,
  });
  const body = buildComplaintBody({
    record: opts.record,
    nowSec: opts.nowSec,
    unshippedTasks: opts.unshippedTasks,
  });
  const filed: FileDedupedResult = fileDedupedComplaint(opts.db, opts.nowSec, {
    sourceKind: "whip",
    sourceId: opts.symptomHash,
    targetTeam: opts.teamName,
    incidentSummary: title,
    rootCause: body,
    openedBy: `whip:${opts.teamName}`,
    // Task body §1 passes `--severity high --kind heads-up`; the verb
    // doesn't have first-class severity, so we stash both in `extra`
    // for the superdoctor consumer to read.
    extra: { kind: "heads-up", severity: "high" },
  });
  // Reset after the file, whether fresh or bumped. Bumping = the
  // existing complaint absorbed the new strikes; the counter should
  // restart so the next round of strikes lands on a clean window
  // (preserving the "complaint represents the next failure mode
  // observed" semantics).
  await resetStrikeRecord(opts.atmuxDir, opts.teamName, opts.symptomHash);
  return {
    kind: "filed",
    complaintId: filed.id,
    isNew: filed.isNew,
    sourceCount: filed.sourceCount,
  };
}

/** Build the complaint title per Task t-e91fec98 §3:
 *  `<team>: <symptom> · <observable-evidence> · whip-tried-N-menus`.
 *  Exported so consumers (tests, future debugging tools) can match
 *  the exact title format without re-deriving it. */
export function buildComplaintTitle(opts: {
  teamName: string;
  symptomLabel: string;
  observableEvidence: string;
  whipMenusTried: number;
}): string {
  return `${opts.teamName}: ${opts.symptomLabel} · ${opts.observableEvidence} · whip-tried-${opts.whipMenusTried}-menus`;
}

/** Build the complaint body per Task t-e91fec98 §4:
 *  "timeline of strikes + which Tasks went unship". The two pieces
 *  are joined by ". " for greppability — superdoctor's consumer can
 *  split on that delimiter if needed.
 *
 *  Degenerate `unshippedTasks=[]` is rendered as a literal
 *  "no unshipped tasks tracked" rather than an empty trailing clause,
 *  so the body always carries both facts (timeline + task list)
 *  even when one side is empty. */
export function buildComplaintBody(opts: {
  record: StrikeRecord;
  nowSec: number;
  unshippedTasks: string[];
}): string {
  const timeline = renderStrikeTimeline(opts.record, opts.nowSec);
  const tasks =
    opts.unshippedTasks.length === 0
      ? "no unshipped tasks tracked"
      : `unshipped tasks: ${opts.unshippedTasks.join(", ")}`;
  return `${timeline}. ${tasks}.`;
}
