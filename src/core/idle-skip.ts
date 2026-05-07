// ADR-057 §D4b: idle false-positive guard via heartbeat freshness.
//
// Cross-references heartbeat freshness (D6 substrate) against the
// per-member idle-tick counter (ADR-043, currently deprecated under
// R1 but back-compat-readable per `team.json::whip.autoStopAfterIdle
// Ticks`). When a member has a fresh heartbeat AND a non-empty
// inProgress inbox, we MUST NOT increment its idle counter — the
// member is actively working; a "stalled" classification would be
// a false positive.
//
// Today the bun whip-tick doesn't consume autoStopAfterIdleTicks (it's
// deprecated; budget-pause + Mode B supersede). This module ships the
// per-member skip predicate ahead of any future revival or
// per-member idle-tick replacement so the heartbeat check is in
// place when the consumer code lands. Test-coverage today; wire-up
// when/if the per-member idle-tick mechanism returns.
//
// ADR-043's body-hash whip-last.hash file remains the team-level
// "did the team produce new findings this tick" signal — that's
// orthogonal and continues to work as before.

import { readHeartbeat } from "./heartbeat.ts";

/** ADR-057 §D4b default — heartbeat younger than 5min counts as "fresh". */
export const DEFAULT_FRESH_HEARTBEAT_SEC = 300;

export interface IdleSkipOpts {
  /** Override the freshness threshold (default 300s). */
  freshSec?: number;
}

/**
 * True when the per-member idle-counter should be SKIPPED (not
 * incremented) for this tick. The decision rule:
 *
 *   skip  ⇔  heartbeat is fresh AND inProgress is non-empty
 *
 * Either condition alone is insufficient: a fresh heartbeat with no
 * in-progress task is genuinely idle (member is alive but unassigned);
 * an inbox with stale heartbeat means the member crashed mid-task and
 * the idle-counter SHOULD increment to surface the stall.
 *
 * Returns false when the heartbeat is absent — same posture as the
 * watchdog: absence is treated as "unknown / not fresh" rather than
 * "fresh".
 */
export async function shouldSkipIdleIncrement(
  atmuxDir: string,
  member: string,
  inProgressCount: number,
  nowSec: number,
  opts: IdleSkipOpts = {},
): Promise<boolean> {
  if (inProgressCount <= 0) return false;
  const epoch = await readHeartbeat(atmuxDir, member);
  if (epoch === null) return false;
  const freshSec = opts.freshSec ?? DEFAULT_FRESH_HEARTBEAT_SEC;
  return nowSec - epoch <= freshSec;
}
