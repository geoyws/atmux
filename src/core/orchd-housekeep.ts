// e-12-640853f3 §S4 — orchd housekeeping (in-process, daily tick).
//
// Operator framing (2026-05-24): "orchd cleans up and housekeeps as
// well (i'm not sure what this might mean..)". Translated to concrete
// recurring maintenance that would otherwise rot:
//
//   1. events table — unbounded growth. orchd dispatches each event
//      via per-consumer offsets, but the row stays forever. Prune
//      rows older than retention window (default 7 days) where
//      every consumer's offset has already passed them.
//
//   2. subscriber_offsets table — stale rows for retired consumer-ids
//      (e.g. legacy 'atmux:ombudsman' from pre-ADR-214). Drop rows
//      whose consumer-id isn't in the current CONSUMERS set AND
//      hasn't been written in 30 days.
//
//   3. .atmux/logs/*.log.N rotated files older than N days (default
//      30) get unlinked. orchd-log rotation (S1) keeps the active
//      file capped; this drops the rotated archives once stale.
//
//   4. merger_state terminal rows — rows in 'merged' / 'abandoned'
//      state older than retention window (default 30 days) get
//      pruned. The state machine doesn't read terminal rows; they're
//      kept for audit. Trim the tail.
//
// Fires from Rust orchd's daily ticker (24h interval) — NOT a
// crontab entry. Dies with orchd binary per anti-cron stance.

import type { Database } from "bun:sqlite";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Default retention windows — all overrideable via env. */
export const DEFAULT_EVENTS_RETENTION_SEC = 7 * 24 * 3600;          // 7 days
export const DEFAULT_OFFSETS_STALENESS_SEC = 30 * 24 * 3600;         // 30 days
export const DEFAULT_ROTATED_LOGS_MAX_AGE_SEC = 30 * 24 * 3600;      // 30 days
export const DEFAULT_MERGER_TERMINAL_RETENTION_SEC = 30 * 24 * 3600; // 30 days

/** Outcome counters surfaced to the operator log + summary line. */
export interface HousekeepResult {
  eventsPruned: number;
  offsetsPruned: number;
  rotatedLogsPruned: number;
  mergerTerminalPruned: number;
  errors: string[];
}

export interface HousekeepDeps {
  db: Database;
  atmuxDir: string;
  /** Active consumer-ids — rows in subscriber_offsets NOT in this
   *  set are candidates for staleness pruning. */
  activeConsumerIds: ReadonlyArray<string>;
  nowSec?: () => number;
  eventsRetentionSec?: number;
  offsetsStalenessSec?: number;
  rotatedLogsMaxAgeSec?: number;
  mergerTerminalRetentionSec?: number;
  log?: (msg: string) => void;
}

const NOOP_LOG = (): void => undefined;

export async function housekeep(deps: HousekeepDeps): Promise<HousekeepResult> {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const evtRet = deps.eventsRetentionSec ?? DEFAULT_EVENTS_RETENTION_SEC;
  const offStale = deps.offsetsStalenessSec ?? DEFAULT_OFFSETS_STALENESS_SEC;
  const logsMax = deps.rotatedLogsMaxAgeSec ?? DEFAULT_ROTATED_LOGS_MAX_AGE_SEC;
  const mergerRet = deps.mergerTerminalRetentionSec ?? DEFAULT_MERGER_TERMINAL_RETENTION_SEC;
  const log = deps.log ?? NOOP_LOG;
  const result: HousekeepResult = {
    eventsPruned: 0,
    offsetsPruned: 0,
    rotatedLogsPruned: 0,
    mergerTerminalPruned: 0,
    errors: [],
  };
  const now = nowSec();

  // 1. Prune events older than retention IF every consumer has
  //    progressed past them. Safe baseline: take the MIN offset
  //    (oldest unprocessed); only prune rows < MIN AND older than
  //    retention. event_id is UUIDv7 — lexicographic compare matches
  //    creation-time order.
  try {
    const minOffsetRow = deps.db
      .prepare("SELECT MIN(last_event_id) AS min_eid FROM subscriber_offsets")
      .get() as { min_eid: string | null };
    if (minOffsetRow.min_eid !== null && minOffsetRow.min_eid !== "") {
      const cutoff = now - evtRet;
      const r = deps.db
        .prepare(
          "DELETE FROM events WHERE emitted_at_sec < ? AND event_id < ?",
        )
        .run(cutoff, minOffsetRow.min_eid);
      result.eventsPruned = r.changes;
    }
  } catch (e) {
    result.errors.push(`events prune: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Prune stale subscriber_offsets rows whose consumer-id is not
  //    in the active set AND hasn't been written in offsetsStalenessSec.
  try {
    const placeholders = deps.activeConsumerIds.map(() => "?").join(",");
    const cutoff = now - offStale;
    const sql = placeholders.length > 0
      ? `DELETE FROM subscriber_offsets WHERE consumer_name NOT IN (${placeholders}) AND last_processed_at_sec < ?`
      : `DELETE FROM subscriber_offsets WHERE last_processed_at_sec < ?`;
    const params = placeholders.length > 0
      ? [...deps.activeConsumerIds, cutoff]
      : [cutoff];
    const r = deps.db.prepare(sql).run(...params);
    result.offsetsPruned = r.changes;
  } catch (e) {
    result.errors.push(`offsets prune: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Prune rotated .log.N files older than N days. The active
  //    orchd.log is left alone (S1 rotation handles size cap).
  try {
    const logsDir = join(deps.atmuxDir, "logs");
    if (existsSync(logsDir)) {
      const entries = await readdir(logsDir);
      const cutoff = now - logsMax;
      for (const f of entries) {
        if (!/\.log\.\d+$/.test(f)) continue; // only rotated files
        const path = join(logsDir, f);
        try {
          const st = statSync(path);
          if (Math.floor(st.mtimeMs / 1000) < cutoff) {
            unlinkSync(path);
            result.rotatedLogsPruned += 1;
            log(`housekeep: pruned rotated log ${path}`);
          }
        } catch (e) {
          result.errors.push(
            `log prune ${f}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
  } catch (e) {
    result.errors.push(`logs scan: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Prune merger_state rows in terminal state older than retention.
  //    Terminal states per merger_state.ts: 'merged' (success terminal)
  //    + 'abandoned' (operator-acked terminal). The state machine
  //    never re-reads these rows.
  try {
    const cutoff = now - mergerRet;
    const r = deps.db
      .prepare(
        "DELETE FROM merger_state WHERE state IN ('merged', 'abandoned') AND transitioned_at < ?",
      )
      .run(cutoff);
    result.mergerTerminalPruned = r.changes;
  } catch (e) {
    result.errors.push(`merger_state prune: ${e instanceof Error ? e.message : String(e)}`);
  }

  return result;
}
