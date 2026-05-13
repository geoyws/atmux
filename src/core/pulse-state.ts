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

/** Default re-fire dedup window for sustained urgency (🔴 / 🚨). 120min
 *  default matches the verdict-defaults table in `cockpit.pulse.dedupMins`
 *  (per ADR-086 §Phase 1.1). */
export const DEFAULT_PULSE_DEDUP_MIN = 120;

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

/** Top-level shape of `~/.atmux/state/pulse-state.json`. */
export const PulseStateSchema = z
  .object({
    teams: z.record(z.string(), PulseTeamStateSchema),
  })
  .passthrough();
export type PulseState = z.infer<typeof PulseStateSchema>;

/** Severity ladder — used to decide "is this a sustained-urgency
 *  verdict worth re-firing past the dedup window?" */
const URGENT_VERDICTS: ReadonlySet<PulseVerdict> = new Set<PulseVerdict>([
  "🔴 Stalled",
  "🚨 Need you",
]);

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
  /** Re-fire window in minutes — used only when current verdict is
   *  sustained-urgency (🔴 / 🚨). */
  dedupMins: number;
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
  const { prior, current, currentCommitCount, nowSec, dedupMins } = inputs;

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

  // 3. Sustained urgency.
  if (URGENT_VERDICTS.has(current)) {
    const elapsedSec = nowSec - prior.lastFireEpoch;
    if (elapsedSec >= dedupMins * 60) {
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
