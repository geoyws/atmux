// e-cc3728bf T1 (ADR-212 §D2) — rotation observer core.
//
// Polls one team's cage state + kanban/git activity and classifies three
// signals: pane.stuck, member.no-progress, cage.starving. Pure
// classification over injected snapshots; the only IO is the optional
// `db` emit sink (tests inject fns, never tmux/git/kanban).
//
// Stuck rule (epic §D2.1): pane text classifies READY or SHELL via
// classifyText AND carries past-tense spinner residue (`✻ Baked for
// 1m 51s` — the ACTIVE_TURN_RE false-positive class: the glyph alone
// is not a live turn) AND last activity is older than stuckAfterMs.
// No-progress rule (§D2.2): oldest active claim older than
// noProgressClaimMs AND (no commit ever OR last commit older than
// noProgressCommitMs). Either side fresh means working-or-idle, never
// no-progress. Starving rule (§D2.3): cage idle past
// STARVING_THRESHOLD_S (re-exported, not redefined) under resource
// pressure (cpu or mem above 0.8).

import type { Database } from "bun:sqlite";
import { STARVING_THRESHOLD_S } from "./cage-state.ts";
import { classifyText } from "./pane-state.ts";
import type { TeamRotation } from "../schema/team.ts";
import { emit } from "../abstractions/events.ts";

export { STARVING_THRESHOLD_S };

/** Resolved observer thresholds (ms). Partial team blocks merge over these. */
export interface RotationThresholds {
  stuckAfterMs: number;
  noProgressCommitMs: number;
  noProgressClaimMs: number;
}

export const DEFAULT_ROTATION_THRESHOLDS: RotationThresholds = {
  stuckAfterMs: 15 * 60_000,
  noProgressCommitMs: 30 * 60_000,
  noProgressClaimMs: 60 * 60_000,
};

/** Merge a partial `team.json::rotation` block over the defaults. */
export function resolveThresholds(partial?: TeamRotation): RotationThresholds {
  return {
    stuckAfterMs: partial?.stuckAfterMs ?? DEFAULT_ROTATION_THRESHOLDS.stuckAfterMs,
    noProgressCommitMs: partial?.noProgressCommitMs ?? DEFAULT_ROTATION_THRESHOLDS.noProgressCommitMs,
    noProgressClaimMs: partial?.noProgressClaimMs ?? DEFAULT_ROTATION_THRESHOLDS.noProgressClaimMs,
  };
}

/**
 * Past-tense spinner residue: `<Verb> for <duration>` — `✻ Baked for
 * 1m 51s`, `✻ Cooked for 3m`. A live turn renders `✻ Honking…` or
 * `(12.4s · still thinking)`, never `<Verb> for <duration>`, so the
 * elapsed-time suffix (not a verb whitelist) is the discriminator.
 */
export const STUCK_RESIDUE_RE = /\bfor\s+\d+\s*(?:m(?:in)?\s+\d+\s*s(?:ec)?|[smh](?:ec|in|r)?)\b/i;

/** One pane capture: text plus wall-clock ms of last observed activity. */
export interface PaneSnapshot {
  member: string;
  text: string;
  lastActivityMs: number;
}

/** A stuck pane finding (pre-emit shape). */
export interface StuckPane {
  member: string;
  lastActivityMs: number;
  evidence: string;
}

/**
 * Stuck classification for one snapshot. Idle-state text (READY/SHELL)
 * + residue marker + idle past the threshold. BUSY/MODAL/RATE-LIMIT/
 * COMPACTING/TYPING/UNKNOWN are never stuck — UNKNOWN is missing data,
 * not evidence (forensics go through classifyPane, not here).
 */
export function isPaneStuck(
  snap: PaneSnapshot,
  thresholds: RotationThresholds = DEFAULT_ROTATION_THRESHOLDS,
  nowMs = Date.now(),
): StuckPane | null {
  if (nowMs - snap.lastActivityMs < thresholds.stuckAfterMs) return null;
  const cls = classifyText(snap.text);
  if (cls.state !== "READY" && cls.state !== "SHELL") return null;
  const hay = `${cls.evidence} ${snap.text}`;
  const m = STUCK_RESIDUE_RE.exec(hay);
  if (m === null) return null;
  return { member: snap.member, lastActivityMs: snap.lastActivityMs, evidence: m[0] };
}

/** Active claim: task id plus wall-clock ms it was claimed. */
export interface ActiveClaim {
  taskId: string;
  claimedAtMs: number;
}

/** Member activity: last commit ms (null = never) plus active claims. */
export interface MemberActivity {
  member: string;
  lastCommitMs: number | null;
  claims: ActiveClaim[];
}

/** A no-progress finding (pre-emit shape). */
export interface NoProgressMember {
  member: string;
  lastCommitMs: number | null;
  taskClaimedMs: number;
  hoursIdle: number;
}

/**
 * No-progress classification. BOTH sides must be stale: the oldest
 * active claim past the claim threshold AND (never committed OR last
 * commit past the commit threshold). No claims, or any fresh side,
 * means working-or-idle — never no-progress.
 */
export function isMemberNoProgress(
  activity: MemberActivity,
  thresholds: RotationThresholds = DEFAULT_ROTATION_THRESHOLDS,
  nowMs = Date.now(),
): NoProgressMember | null {
  if (activity.claims.length === 0) return null;
  const oldest = Math.min(...activity.claims.map((c) => c.claimedAtMs));
  if (nowMs - oldest < thresholds.noProgressClaimMs) return null;
  if (activity.lastCommitMs !== null && nowMs - activity.lastCommitMs < thresholds.noProgressCommitMs) {
    return null;
  }
  return {
    member: activity.member,
    lastCommitMs: activity.lastCommitMs,
    taskClaimedMs: oldest,
    hoursIdle: (nowMs - oldest) / 3_600_000,
  };
}

/** Cage load: 0..1 pressure fractions, null when the probe failed. */
export interface CageLoad {
  cpuPressure: number | null;
  memPressure: number | null;
}

/** A starving cage finding (pre-emit shape). */
export interface StarvingCage {
  sinceMs: number;
  cpuPressure: number | null;
  memPressure: number | null;
}

/** Pressure above which an idle cage counts as starving (v1 rule). */
export const STARVING_PRESSURE = 0.8;

/**
 * Starving classification. The cage is starving when its last activity
 * is older than STARVING_THRESHOLD_S AND either pressure is above
 * STARVING_PRESSURE. Null pressures with a stale clock still report
 * (pressure unknown — the idle duration alone is the signal).
 */
export function isCageStarving(
  lastActivityMs: number,
  load: CageLoad | null,
  nowMs = Date.now(),
): StarvingCage | null {
  if (nowMs - lastActivityMs < STARVING_THRESHOLD_S * 1000) return null;
  const cpu = load?.cpuPressure ?? null;
  const mem = load?.memPressure ?? null;
  if (cpu !== null && cpu < STARVING_PRESSURE && mem !== null && mem < STARVING_PRESSURE) return null;
  return { sinceMs: lastActivityMs, cpuPressure: cpu, memPressure: mem };
}

/** Injected IO for one observe pass (tests inject fns; no live backends). */
export interface ObserveDeps {
  capturePanes: () => PaneSnapshot[] | Promise<PaneSnapshot[]>;
  readActivity: (member: string) => MemberActivity | Promise<MemberActivity>;
  readLoad: () => CageLoad | null | Promise<CageLoad | null>;
  nowMs?: () => number;
}

/** One observe pass over a team. */
export interface ObserveResult {
  stuck: StuckPane[];
  noProgress: NoProgressMember[];
  starving: StarvingCage | null;
}

/**
 * Run one observe pass: classify every captured pane, check activity
 * for members with snapshots, evaluate cage starvation once per team.
 * Optionally emits pane.stuck / member.no-progress / cage.starving via
 * emit() when `db` is provided (emittedAtSec/observedAtSec pinned by
 * the same clock). Returns findings regardless.
 */
export async function observeTeam(
  team: string,
  thresholds: RotationThresholds,
  deps: ObserveDeps,
  db?: Database,
): Promise<ObserveResult> {
  const now = deps.nowMs ?? Date.now;
  const nowMs = now();
  const snapshots = await deps.capturePanes();
  const stuck = snapshots
    .map((s) => isPaneStuck(s, thresholds, nowMs))
    .filter((s): s is StuckPane => s !== null);
  const noProgress: NoProgressMember[] = [];
  for (const snap of snapshots) {
    const activity = await deps.readActivity(snap.member);
    const found = isMemberNoProgress(activity, thresholds, nowMs);
    if (found !== null) noProgress.push(found);
  }
  const load = await deps.readLoad();
  const lastActive = snapshots.length > 0 ? Math.max(...snapshots.map((s) => s.lastActivityMs)) : nowMs;
  const starving = isCageStarving(lastActive, load, nowMs);

  if (db !== undefined) {
    const observedAtSec = Math.floor(nowMs / 1000);
    for (const s of stuck) {
      emit(db, {
        topic: "pane.stuck",
        team,
        member: s.member,
        lastActivitySec: Math.floor(s.lastActivityMs / 1000),
        captureExcerpt: s.evidence.slice(0, 200),
        observedAtSec,
      });
    }
    for (const n of noProgress) {
      emit(db, {
        topic: "member.no-progress",
        team,
        member: n.member,
        lastCommitSec: n.lastCommitMs === null ? null : Math.floor(n.lastCommitMs / 1000),
        taskClaimedSec: Math.floor(n.taskClaimedMs / 1000),
        hoursIdle: n.hoursIdle,
        observedAtSec,
      });
    }
    if (starving !== null) {
      emit(db, {
        topic: "cage.starving",
        team,
        cpuPressure: starving.cpuPressure,
        memPressure: starving.memPressure,
        sinceSec: Math.floor(starving.sinceMs / 1000),
        observedAtSec,
      });
    }
  }
  return { stuck, noProgress, starving };
}
