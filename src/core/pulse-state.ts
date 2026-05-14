// ADR-086: dedup state for the cockpit-wide `atmux pulse` probe.
//
// One row per enabled team:
//   { verdict, lastFireEpoch, lastCommitCount }
//
// Fire policy (`shouldFire`):
//   - No prior state → fire (first observation).
//   - Verdict transition → fire always.
//   - Same verdict at severity ≥🔴 AND last fire ≥ dedupMins ago → re-fire
//     (sustained urgency).
//   - Same verdict <🔴 → skip (channel stays quiet during steady-state).
//
// State file lives at `~/.atmux/state/pulse-state.json` — cockpit-scoped,
// NOT per-team (the cron line runs once over the whole cockpit). Override
// via `pulseStatePath({ home: ... })` for tests.

import { join } from "node:path";
import { z } from "zod";
import { ensureDir } from "../abstractions/fs.ts";
import { tryReadJson, writeJson } from "../abstractions/json.ts";
import { ConfigError } from "../errors.ts";
import type { PulseVerdict } from "./pulse-verdict.ts";

/** Phase 1.1 fallback for the flat `cockpit.pulse.dedupMins` legacy
 *  knob. Kept as the soft-deprecated default when an operator config
 *  pins a single int; the verb populates the per-verdict ladder
 *  uniformly with this value in that case. ADR-086 §Phase 1.5
 *  documents the soft-deprecation. */
export const DEFAULT_PULSE_DEDUP_MIN = 120;

/** ADR-086 §Phase 1.5: verdict-specific dedup ladder. Operator config
 *  may override per-verdict via `cockpit.pulse.dedupLadderMins`;
 *  missing keys inherit from this default, explicit `null` disables
 *  re-fire for that verdict (silence until verdict transitions).
 *
 *  Rationale (ADR-086 §Phase 1.5):
 *   - 🚨 Need you  → 60min — loud-but-not-training-the-eye.
 *   - 🔴 Stalled   → 30min — degraded-state probe cadence.
 *   - 🟡 Cool/Idle → 4h    — confirm steady-state on long lull;
 *                            removes "cron broken or team cool?"
 *                            ambiguity from Phase 1.1 (silent past
 *                            first transition).
 *   - 🟢 Shipping  → null  — never re-fire on healthy steady-state;
 *                            transitions fire as usual (covered by
 *                            shouldFire's transition branch). */
export const DEFAULT_PULSE_DEDUP_LADDER: Readonly<Record<PulseVerdict, number | null>> = {
  "🚨 Need you": 60,
  "🔴 Stalled": 30,
  "🟡 Cool": 4 * 60,
  "🟡 Idle": 4 * 60,
  "🟢 Shipping": null,
};

/** Resolved dedup-ladder shape — operator override merges OVER the
 *  default ladder. Missing keys inherit; explicit `null` disables. */
export type PulseDedupLadder = Readonly<Record<PulseVerdict, number | null>>;

/** Default observation window for commit-cadence (verdict logic). */
export const DEFAULT_PULSE_WINDOW_MIN = 30;

/** Default cron interval — every 5 minutes (matches the manual install
 *  line in docs/RUNBOOK-pulse.md). */
export const DEFAULT_PULSE_INTERVAL_MIN = 5;

/** Stale-driver-ask threshold — open entries older than this count
 *  toward the 🚨 Need you verdict gate. */
export const PULSE_DRIVER_INBOX_STALE_MIN = 30;

/** Verdict literal-union, mirroring `PulseVerdict` from pulse-verdict.
 *  Restated as a Zod enum here so the state schema can validate it. */
export const VerdictSchema = z.enum([
  "🟢 Shipping",
  "🟡 Cool",
  "🟡 Idle",
  "🔴 Stalled",
  "🚨 Need you",
]);

/** Per-team row stored in `~/.atmux/state/pulse-state.json`. */
export const PulseTeamStateSchema = z
  .object({
    verdict: VerdictSchema,
    lastFireEpoch: z.number().int().nonnegative(),
    lastCommitCount: z.number().int().nonnegative(),
  })
  .strict();
export type PulseTeamState = z.infer<typeof PulseTeamStateSchema>;

/** t-351318dc: meta-watchdog dedup row. One per cockpit. `paged` flips
 *  true on the first dormancy page of a streak; resets to false when
 *  dormancy clears (an attempt lands OR all complaints resolve).
 *  `dormantSinceSec` carries the streak's start epoch — load-bearing
 *  for "1 ping per streak" semantics across pulse ticks. */
export const PulseMetaWatchdogSchema = z
  .object({
    paged: z.boolean(),
    dormantSinceSec: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PulseMetaWatchdogState = z.infer<typeof PulseMetaWatchdogSchema>;

/** Top-level shape of `~/.atmux/state/pulse-state.json`. */
export const PulseStateSchema = z
  .object({
    teams: z.record(z.string(), PulseTeamStateSchema),
    /** t-351318dc: meta-watchdog dedup. Optional — absent on
     *  pulse-state files frozen before this Task. */
    metaWatchdog: PulseMetaWatchdogSchema.optional(),
  })
  .passthrough();
export type PulseState = z.infer<typeof PulseStateSchema>;

// ADR-086 §Phase 1.5: `URGENT_VERDICTS` removed. The
// binary urgent-set semantics is replaced by "ladder[verdict] !== null"
// — per-verdict ladder governs re-fire cadence (see
// `DEFAULT_PULSE_DEDUP_LADDER`).

export interface PulseStatePathOpts {
  /** Override the home directory (test injection). */
  home?: string;
  /** Override the env hash that supplies HOME (test injection). */
  env?: NodeJS.ProcessEnv;
}

/** Resolve `~/.atmux/state/pulse-state.json` per the cockpit-scoped
 *  layout. Throws ConfigError when HOME is unresolvable. */
export function pulseStatePath(opts: PulseStatePathOpts = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME;
  if (home === undefined || home.length === 0) {
    throw new ConfigError({
      what: "cannot resolve pulse-state path: HOME unset",
      hint: "set $HOME or pass `home` opt for tests",
    });
  }
  return join(home, ".atmux", "state", "pulse-state.json");
}

/** Empty initial state — used when first observation lands. */
export function emptyPulseState(): PulseState {
  return { teams: {} };
}

/** Read state from disk; return empty state on absence. Malformed state
 *  still throws `SchemaError` (per ADR-005 — never silent fallback). */
export async function readPulseState(path: string): Promise<PulseState> {
  const got = await tryReadJson(path, PulseStateSchema);
  return got ?? emptyPulseState();
}

/** Persist state atomically. Parent dirs created lazily. */
export async function writePulseState(path: string, state: PulseState): Promise<void> {
  await ensureDir(dirnameOf(path));
  await writeJson(path, PulseStateSchema, state);
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : ".";
}

export interface ShouldFireInputs {
  /** Prior recorded state for this team. `null` on first observation. */
  prior: PulseTeamState | null;
  /** Currently computed verdict. */
  current: PulseVerdict;
  /** Currently observed commit count (recorded into state for the
   *  next tick's transition detection). Carried into return value
   *  on a fire so callers don't have to re-thread it. */
  currentCommitCount: number;
  /** Epoch-seconds (test injection). */
  nowSec: number;
  /** ADR-086 §Phase 1.5: resolved per-verdict ladder of re-fire windows
   *  in minutes. Lookup `ladder[current]`: `null` → skip (deduped);
   *  number → compare against elapsed-since-`prior.lastFireEpoch`.
   *  Transitions always fire regardless of ladder (handled by the
   *  transition branch). */
  dedupLadderMins: PulseDedupLadder;
}

export interface ShouldFireResult {
  didFire: boolean;
  /** Reason string for logs / --json output. */
  reason: "first-observation" | "transition" | "sustained-urgency" | "deduped";
  /** Next state row to persist when `didFire === true`. When
   *  `didFire === false`, the prior row stays put (we don't bump
   *  lastFireEpoch on a no-fire tick). */
  next: PulseTeamState | null;
}

/**
 * Pure: decide whether to fire + compute the next stored state.
 *
 * Rules:
 *   1. No prior state                       → fire (`first-observation`).
 *   2. Verdict differs from prior           → fire (`transition`).
 *   3. Same verdict, urgent, past dedup     → fire (`sustained-urgency`).
 *   4. Otherwise                            → skip (`deduped`).
 *
 * Caller persists `next` to disk only when `didFire === true`. On a
 * skipped tick the prior row stays unchanged — we deliberately don't
 * bump `lastFireEpoch` for non-fires so the sustained-urgency window
 * is measured against the LAST FIRE, not against ticks observed.
 */
export function shouldFire(inputs: ShouldFireInputs): ShouldFireResult {
  const { prior, current, currentCommitCount, nowSec, dedupLadderMins } = inputs;

  // 1. First observation.
  if (prior === null) {
    return {
      didFire: true,
      reason: "first-observation",
      next: { verdict: current, lastFireEpoch: nowSec, lastCommitCount: currentCommitCount },
    };
  }

  // 2. Transition.
  if (prior.verdict !== current) {
    return {
      didFire: true,
      reason: "transition",
      next: { verdict: current, lastFireEpoch: nowSec, lastCommitCount: currentCommitCount },
    };
  }

  // 3. ADR-086 §Phase 1.5: ladder lookup. `null` (or missing) → silent;
  //    a number → re-fire when elapsed-since-last-fire ≥ that many
  //    minutes. The binary URGENT_VERDICTS semantic is replaced; 🟡
  //    Cool / Idle now re-fires every 4h by default (removes the
  //    "cron broken or team cool?" ambiguity Phase 1.1 left behind).
  const cadenceMins = dedupLadderMins[current];
  if (cadenceMins !== null && cadenceMins !== undefined) {
    const elapsedSec = nowSec - prior.lastFireEpoch;
    if (elapsedSec >= cadenceMins * 60) {
      return {
        didFire: true,
        reason: "sustained-urgency",
        next: { verdict: current, lastFireEpoch: nowSec, lastCommitCount: currentCommitCount },
      };
    }
  }

  // 4. Deduped — leave the row untouched.
  return { didFire: false, reason: "deduped", next: null };
}
