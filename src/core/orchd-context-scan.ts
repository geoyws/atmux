// e-13-04c8b3bf — orchd context-% scan core.
//
// Walks each team member's pane, captures statusline, parses
// context-%, emits member.context-high event when >= threshold.
// Lead consumer (ADR-212 / e-cc3728bf) wakes and decides preclear /
// rotate-member / leave-alone.
//
// Cadence: every 15min from Rust orchd's in-process ticker (the
// operator's call — sweep-merges fires every 5min, context-scan
// every 15min). Same NOT-a-cron in-process timer pattern as
// e-11-446429c9 §S6.

import type { Database } from "bun:sqlite";

import { emit } from "../abstractions/events.ts";
import { capturePaneTail, parseContextPercent } from "./pane-statusline.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import type { Tmux } from "../abstractions/tmux.ts";

/** Default threshold — operator's stated preference (40%). Overrideable
 *  via team.json::contextThreshold (read at call-site). */
export const DEFAULT_CONTEXT_THRESHOLD = 40;

/** Dedup window — same member already over-threshold within this
 *  many seconds → skip emit (lead already saw the prior signal).
 *  Chosen to be longer than the 15-min scan cadence so we re-emit
 *  at most once per cycle for a stuck member. */
export const DEFAULT_DEDUP_WINDOW_SEC = 1800; // 30min

/** Per-member scan outcome. */
export type ContextScanOutcome =
  | { member: string; outcome: "ok"; percent: number }
  | { member: string; outcome: "over-threshold"; percent: number; emitted: boolean; dedupReason?: string }
  | { member: string; outcome: "unknown"; reason: string }
  | { member: string; outcome: "errored"; reason: string };

/** Aggregated scan result for one tick. */
export interface ContextScanResult {
  membersConsidered: number;
  membersOverThreshold: number;
  membersEmitted: number;
  membersDeduped: number;
  membersUnknown: number;
  membersErrored: number;
  perMember: ContextScanOutcome[];
}

export interface ContextScanDeps {
  db: Database;
  team: Team;
  tmux: Tmux;
  /** Session name (resolved from team.name + namespace conventions). */
  sessionName: string;
  /** Buildings the per-member window target string (window-name lookup
   *  varies by team setup). Production callers pass the existing
   *  `buildWindowName` resolver; tests inject a stub. */
  resolveWindowTarget: (member: TeamMember) => string;
  /** Threshold override (default 40). */
  threshold?: number;
  /** Dedup window (default 1800s). */
  dedupWindowSec?: number;
  /** Clock — injected for tests. */
  nowSec?: () => number;
  /** Optional log line emitter. */
  log?: (msg: string) => void;
}

const NOOP_LOG = (): void => undefined;

/** Run one context-scan pass. Returns aggregated counts + per-member
 *  outcomes. Never throws — per-member tmux/parse failures are
 *  caught + reported in `perMember`. */
export async function scanContextAcrossMembers(
  deps: ContextScanDeps,
): Promise<ContextScanResult> {
  const threshold = deps.threshold ?? DEFAULT_CONTEXT_THRESHOLD;
  const dedupWindowSec = deps.dedupWindowSec ?? DEFAULT_DEDUP_WINDOW_SEC;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? NOOP_LOG;
  const now = nowSec();

  const result: ContextScanResult = {
    membersConsidered: 0,
    membersOverThreshold: 0,
    membersEmitted: 0,
    membersDeduped: 0,
    membersUnknown: 0,
    membersErrored: 0,
    perMember: [],
  };

  for (const member of deps.team.members) {
    result.membersConsidered += 1;
    let target: string;
    try {
      target = deps.resolveWindowTarget(member);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      result.membersErrored += 1;
      result.perMember.push({ member: member.name, outcome: "errored", reason });
      log(`ctx-scan: ${member.name} — target resolve failed: ${reason}`);
      continue;
    }

    let raw: string;
    try {
      raw = await capturePaneTail(deps.tmux, target);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      result.membersErrored += 1;
      result.perMember.push({ member: member.name, outcome: "errored", reason });
      log(`ctx-scan: ${member.name} — capture failed: ${reason}`);
      continue;
    }

    const usage = parseContextPercent(raw);
    if (usage === null) {
      result.membersUnknown += 1;
      result.perMember.push({
        member: member.name,
        outcome: "unknown",
        reason: "no context-bar pattern in capture (member may not be running Claude TUI)",
      });
      continue;
    }
    if (usage.percent < threshold) {
      result.perMember.push({ member: member.name, outcome: "ok", percent: usage.percent });
      continue;
    }

    // Over threshold — check dedup before emit.
    result.membersOverThreshold += 1;
    const dedup = recentContextEmitForMember(deps.db, deps.team.name, member.name, now - dedupWindowSec);
    if (dedup !== null) {
      result.membersDeduped += 1;
      result.perMember.push({
        member: member.name,
        outcome: "over-threshold",
        percent: usage.percent,
        emitted: false,
        dedupReason: `already emitted at ${new Date(dedup * 1000).toISOString()}`,
      });
      continue;
    }

    try {
      emit(deps.db, {
        topic: "member.context-high",
        team: deps.team.name,
        member: member.name,
        percent: usage.percent,
        threshold,
        matchedSegment: usage.matchedSegment,
        capturedAtSec: now,
      });
      result.membersEmitted += 1;
      result.perMember.push({
        member: member.name,
        outcome: "over-threshold",
        percent: usage.percent,
        emitted: true,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      result.membersErrored += 1;
      result.perMember.push({ member: member.name, outcome: "errored", reason });
      log(`ctx-scan: ${member.name} — emit failed: ${reason}`);
    }
  }
  return result;
}

/** Look up the most recent `member.context-high` event for this
 *  (team, member) since `sinceSec`. Returns the emitted-at second, or
 *  null when nothing recent. Used for dedup. */
function recentContextEmitForMember(
  db: Database,
  team: string,
  member: string,
  sinceSec: number,
): number | null {
  // Cheap query: walk recent events with topic match, JSON-extract
  // team/member from payload, return the latest matching.
  const row = db
    .prepare(
      `SELECT emitted_at_sec FROM events
        WHERE topic = 'member.context-high'
          AND emitted_at_sec >= ?
          AND json_extract(payload, '$.team') = ?
          AND json_extract(payload, '$.member') = ?
        ORDER BY emitted_at_sec DESC
        LIMIT 1`,
    )
    .get(sinceSec, team, member) as { emitted_at_sec: number } | undefined;
  return row?.emitted_at_sec ?? null;
}
