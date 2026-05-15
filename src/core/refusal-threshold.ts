// ADR-139 T2: refusal-threshold helper.
//
// Pure function — no I/O. Given a list of recent `RefusalEvent`s
// and a config, decides whether to fire auto-rotate per ADR-139
// §D3 threshold table:
//
//   Soft: 3 events in 30min        → rotate
//   Hard: 2 events in 10min        → rotate
//   Role: 1 event instant          → rotate
//   Meta: warn-class, no rotate    → always returns false
//
// Window-back is read from config (`windowMin` for soft; hard has
// its own ADR-139-fixed 10min; role is instant). Meta-class is
// logged for audit but never auto-rotates per ADR-139 §D3.
//
// The shouldRotate function is a pure decision over an EVENT
// LEDGER — the caller (medic / martinet observer in T3) feeds the
// recent events (typically read from the `refusal_events` SQLite
// table per ADR-139 §D2). Pure separation keeps the threshold
// logic unit-testable without touching SQLite.

import type { RefusalDetectionResult } from "./refusal-classifier.ts";

/** One persisted refusal observation. Mirrors the `refusal_events`
 *  table shape ADR-139 §D2 specifies — the caller hydrates rows
 *  from SQL into this shape before passing to {@link shouldRotate}. */
export interface RefusalEvent {
  member: string;
  team: string;
  /** Epoch seconds when the event was recorded. Window comparisons
   *  use this — caller computes "now" once per scan and passes
   *  through as the lower bound. */
  timestamp: number;
  result: RefusalDetectionResult;
}

/** Threshold + window config. Defaults applied at the call-site
 *  per ADR-139 §Config — `team.json::refusalDetection` block. */
export interface RefusalThresholdConfig {
  /** N soft-class events within `windowMin` to fire rotate.
   *  ADR-139 §D3 default: 3. */
  softThreshold: number;
  /** N hard-class events within hard-window (fixed 10min per
   *  ADR-139 §D3 "Hard: 2 events in 10min"). Default: 2. */
  hardThreshold: number;
  /** N role-class events within role-window (instant: 1 event,
   *  any time in soft-window). Default: 1. */
  roleThreshold: number;
  /** Window-back in minutes for soft-class + role-class
   *  (role-class is instant in practice but the window bounds the
   *  ledger walk). Default: 30. */
  windowMin: number;
}

/** Default threshold config per ADR-139 §Config defaults. Exported
 *  for non-Zod call-sites — mirrors the `DEFAULT_CADENCE_CONFIG`
 *  pattern (ADR-148). */
export const DEFAULT_REFUSAL_THRESHOLD_CONFIG: RefusalThresholdConfig = {
  softThreshold: 3,
  hardThreshold: 2,
  roleThreshold: 1,
  windowMin: 30,
};

/** Fixed window for hard-class threshold per ADR-139 §D3 "Hard: 2
 *  events in 10min". Tighter than the soft window so a member
 *  producing back-to-back hard refusals rotates faster. */
export const HARD_REFUSAL_WINDOW_MIN = 10;

/** Decision shape from {@link shouldRotate}. */
export interface ShouldRotateDecision {
  rotate: boolean;
  /** Operator-facing reason. Empty string when `rotate === false`. */
  reason: string;
  /** The class whose threshold triggered. Null when `rotate === false`. */
  triggeringClass: "soft" | "hard" | "role" | null;
}

/** ADR-139 §D3 threshold gate. Pure function — no I/O, no clock
 *  read (the caller resolves `nowSec` once per scan).
 *
 *  Decision precedence: role > hard > soft. The first class that
 *  crosses its threshold fires the rotate. Meta-class events are
 *  ignored entirely per ADR-139 §D3 ("warn-class — recorded for
 *  audit; never auto-rotates").
 *
 *  Window semantics: an event is "in window" iff
 *  `nowSec - event.timestamp <= windowSec`. Events older than the
 *  widest active window drop out of the count (caller is free to
 *  pre-filter for efficiency; this function tolerates any-size
 *  ledger). */
export function shouldRotate(
  recentEvents: ReadonlyArray<RefusalEvent>,
  config: RefusalThresholdConfig,
  nowSec: number,
): ShouldRotateDecision {
  const softWindowSec = config.windowMin * 60;
  const hardWindowSec = HARD_REFUSAL_WINDOW_MIN * 60;

  let softCount = 0;
  let hardCount = 0;
  let roleCount = 0;

  for (const ev of recentEvents) {
    const ageSec = nowSec - ev.timestamp;
    if (ageSec < 0) continue; // future event — ignore (clock skew)
    const sev = ev.result.severity;
    if (sev === "role" && ageSec <= softWindowSec) roleCount += 1;
    if (sev === "hard" && ageSec <= hardWindowSec) hardCount += 1;
    if (sev === "soft" && ageSec <= softWindowSec) softCount += 1;
    // meta + none ignored per ADR-139 §D3.
  }

  // Precedence: role > hard > soft. First threshold to trip wins.
  if (roleCount >= config.roleThreshold) {
    return {
      rotate: true,
      reason: `role-class refusal: ${roleCount} event(s) (threshold ${config.roleThreshold})`,
      triggeringClass: "role",
    };
  }
  if (hardCount >= config.hardThreshold) {
    return {
      rotate: true,
      reason: `hard-class refusal: ${hardCount} event(s) in ${HARD_REFUSAL_WINDOW_MIN}min (threshold ${config.hardThreshold})`,
      triggeringClass: "hard",
    };
  }
  if (softCount >= config.softThreshold) {
    return {
      rotate: true,
      reason: `soft-class refusal: ${softCount} event(s) in ${config.windowMin}min (threshold ${config.softThreshold})`,
      triggeringClass: "soft",
    };
  }
  return { rotate: false, reason: "", triggeringClass: null };
}
