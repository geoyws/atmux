// e-11-446429c9 §S5 — sweep ready-but-unattended epics for merge/dissolve.
//
// Backstop for the event-driven auto-merge chain: if a task.done event
// was missed (orchd offline, emit failed pre-Honker, or dispatcher
// returned skipped-not-mine on first try), this sweep catches up.
//
// Operator's framing (2026-05-24): "a loop running every 5mins within
// orchd that basically checks to see if worktrees are not being
// attended to (if they're being worked on leave them alone, but if
// they're ready and not merged and dissolved then orchd needs to make
// that happen) ... no crons because they're leaky and dangerous."
//
// In-orchd ticker (Rust side) dies with the orchd binary — no
// crontab artifact, no on-disk scheduler state.
//
// "Attended" predicate (skip the sweep for an epic when ANY of these
// match — work is in flight, hands-off):
//   - any task with status='in-progress' on the epic
//   - any task moved to done within the last activeWindowSec (default
//     300s — same window as the sweep cadence; freshly-done tasks may
//     have an event in flight or a follow-up commit pending)
//   - recent commit on the epic-team's branch (last activeWindowSec)
//
// "Unattended + ready" predicate (dispatch sweep for):
//   - all stories status='done' (or no stories — pure task epic)
//   - all tasks status='done'
//   - epic.status='done' OR every story's status='done'
//   - mergedAt (kanban.epics column / extra) is null
//   - no attended signal above

import type { Database } from "bun:sqlite";

import type { DispatchEpicMergeResult } from "./orchd-merge.ts";

/** Default "attended" lookback window. Mirrors the sweep cadence so
 *  the predicate's grace period matches how often we re-evaluate. */
export const DEFAULT_ATTENDED_WINDOW_SEC = 300;

/** Per-epic outcome reported by the sweep for operator log lines. */
export type SweepEpicOutcome =
  | "skipped-attended"
  | "skipped-not-ready"
  | "skipped-already-merged"
  | "dispatched-merged"
  | "dispatched-gate-held"
  | "dispatched-skipped"
  | "errored";

/** Aggregated counters from one sweep pass. Surfaces in the log line
 *  for operators to grep + understand sweep cadence + verdicts. */
export interface SweepResult {
  epicsConsidered: number;
  epicsAttended: number;
  epicsNotReady: number;
  epicsAlreadyMerged: number;
  epicsDispatchedMerged: number;
  epicsDispatchedGateHeld: number;
  epicsDispatchedSkipped: number;
  epicsErrored: number;
  perEpic: Array<{ epicId: string; outcome: SweepEpicOutcome; reason?: string }>;
}

export interface SweepDeps {
  /** Open per-team state.db. */
  db: Database;
  /** Wall-clock seconds — injected for tests. */
  nowSec?: () => number;
  /** Attended lookback window. Default 300s. */
  attendedWindowSec?: number;
  /** Dispatcher to call for each unattended ready epic. Same shape as
   *  `AutoMergeHandlerDeps.dispatchEpicMerge`. Production callers pass
   *  the same closure used in `bootstrapOrchd({mergeDeps})` so sweep
   *  + event-driven dispatch share one code path. */
  dispatchEpicMerge: (epicId: string) => Promise<DispatchEpicMergeResult>;
  /** Optional logger. */
  log?: (msg: string) => void;
}

const NOOP_LOG = (): void => undefined;

/** Run one sweep pass. Reads epics from the per-team state.db, applies
 *  ready + attended predicates, dispatches the merge for unattended
 *  candidates. Never throws — per-epic errors get caught + counted. */
export async function sweepMerges(deps: SweepDeps): Promise<SweepResult> {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const windowSec = deps.attendedWindowSec ?? DEFAULT_ATTENDED_WINDOW_SEC;
  const log = deps.log ?? NOOP_LOG;
  const result: SweepResult = {
    epicsConsidered: 0,
    epicsAttended: 0,
    epicsNotReady: 0,
    epicsAlreadyMerged: 0,
    epicsDispatchedMerged: 0,
    epicsDispatchedGateHeld: 0,
    epicsDispatchedSkipped: 0,
    epicsErrored: 0,
    perEpic: [],
  };

  // Pull every epic + its derived status. We do per-epic SQL queries
  // for ready + attended (one or two cheap queries each; epic counts
  // are O(10s) in practice — measured in fleet today).
  const epicRows = deps.db
    .prepare(
      `SELECT id, status, extra FROM epics WHERE status != 'done' OR id IN
        (SELECT id FROM epics WHERE json_extract(extra, '$.mergedAt') IS NULL)`,
    )
    .all() as Array<{ id: string; status: string; extra: string | null }>;

  const now = nowSec();
  for (const epic of epicRows) {
    result.epicsConsidered += 1;

    const extra = parseExtra(epic.extra);
    if (extra.mergedAt != null) {
      result.epicsAlreadyMerged += 1;
      result.perEpic.push({ epicId: epic.id, outcome: "skipped-already-merged" });
      continue;
    }

    // Ready check — every story done OR every task done (treat
    // story-less epics as task-direct).
    const ready = await isEpicReady(deps.db, epic.id);
    if (!ready.ready) {
      result.epicsNotReady += 1;
      result.perEpic.push({ epicId: epic.id, outcome: "skipped-not-ready", reason: ready.reason });
      continue;
    }

    // Attended check — work-in-flight signal blocks dispatch.
    const att = await isEpicAttended(deps.db, epic.id, now, windowSec);
    if (att.attended) {
      result.epicsAttended += 1;
      result.perEpic.push({ epicId: epic.id, outcome: "skipped-attended", reason: att.reason });
      continue;
    }

    // Dispatch.
    try {
      const dispatch = await deps.dispatchEpicMerge(epic.id);
      switch (dispatch.state) {
        case "merged":
          result.epicsDispatchedMerged += 1;
          result.perEpic.push({ epicId: epic.id, outcome: "dispatched-merged" });
          break;
        case "merge-conflict":
        case "gate-held":
          result.epicsDispatchedGateHeld += 1;
          result.perEpic.push({
            epicId: epic.id,
            outcome: "dispatched-gate-held",
            reason: dispatch.reason,
          });
          break;
        case "skipped-not-mine":
        case "already-merged":
          result.epicsDispatchedSkipped += 1;
          result.perEpic.push({
            epicId: epic.id,
            outcome: "dispatched-skipped",
            reason: dispatch.state === "skipped-not-mine" ? dispatch.reason : "already-merged",
          });
          break;
      }
    } catch (e) {
      result.epicsErrored += 1;
      const reason = e instanceof Error ? e.message : String(e);
      result.perEpic.push({ epicId: epic.id, outcome: "errored", reason });
      log(`sweepMerges: epic=${epic.id} threw: ${reason}`);
    }
  }

  return result;
}

function parseExtra(raw: string | null): { mergedAt?: number | null; [k: string]: unknown } {
  if (raw === null || raw === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Ready predicate: all stories status='done' (or no stories) AND all
 *  tasks status='done'. */
async function isEpicReady(
  db: Database,
  epicId: string,
): Promise<{ ready: boolean; reason?: string }> {
  const storyRows = db
    .prepare("SELECT status FROM stories WHERE epic = ?")
    .all(epicId) as Array<{ status: string }>;
  for (const s of storyRows) {
    if (s.status !== "done") return { ready: false, reason: `story status=${s.status}` };
  }
  const taskRows = db
    .prepare("SELECT status FROM tasks WHERE epic = ?")
    .all(epicId) as Array<{ status: string }>;
  if (taskRows.length === 0 && storyRows.length === 0) {
    return { ready: false, reason: "no tasks or stories" };
  }
  for (const t of taskRows) {
    if (t.status !== "done") return { ready: false, reason: `task status=${t.status}` };
  }
  return { ready: true };
}

/** Attended predicate: in-progress task, recently-done task, or
 *  recent kanban activity within the window. Recent-commit check
 *  deferred to S5b — needs git probe per epic-team branch which
 *  adds dependency on cage-resolver; can layer in safely later. */
async function isEpicAttended(
  db: Database,
  epicId: string,
  nowSec: number,
  windowSec: number,
): Promise<{ attended: boolean; reason?: string }> {
  const since = nowSec - windowSec;
  const inProg = db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE epic = ? AND status = 'in-progress'")
    .get(epicId) as { n: number };
  if (inProg.n > 0) {
    return { attended: true, reason: `${inProg.n} in-progress task(s)` };
  }
  const recentDone = db
    .prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE epic = ? AND status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?",
    )
    .get(epicId, since) as { n: number };
  if (recentDone.n > 0) {
    return {
      attended: true,
      reason: `${recentDone.n} task(s) done in last ${windowSec}s — leaving grace window`,
    };
  }
  return { attended: false };
}
