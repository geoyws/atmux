// ADR-053 §D3 4.1: band-crossing dedup state for [whip-budget-warning].
//
// Each (account, window, band) crossing fires the warning template
// ONCE per window-reset cycle. The dedup state tracks per-band fire
// epochs so subsequent ticks don't re-ping until either:
//
//   (a) the next band crossing fires (lower remaining%), OR
//   (b) the window resets (h5_reset_epoch / wk_reset_epoch advances
//       past the previously observed value), at which point the
//       per-window entries are wiped + bands re-arm.
//
// State file: `<atmuxDir>/state/budget-warning-state.json`. Schema
// per ADR-053 §D3 is a flat key-value map with composite keys:
//
//   {
//     "<account>:<window>:<band-fraction>": <epoch-of-fire>,
//     ...
//   }
//
// Window-reset wipe semantics: callers pass the previously-observed
// reset epoch + the current reset epoch; if it advanced, all
// `<account>:<window>:*` entries are cleared.

import { join } from "node:path";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";

/** State-file path. */
const STATE_FILENAME = "budget-warning-state.json";

export function budgetWarningStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** State map: `<account>:<window>:<band-fraction>` → epoch-seconds-of-fire. */
export type WarningState = Record<string, number>;

/** Read state from disk; empty map on missing/malformed. */
export async function loadWarningState(atmuxDir: string): Promise<WarningState> {
  const path = budgetWarningStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: WarningState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {}; // corrupt — re-arm fresh
  }
}

/** Atomic-write the full state map. */
export async function writeWarningState(atmuxDir: string, state: WarningState): Promise<void> {
  await atomicWrite(budgetWarningStatePath(atmuxDir), JSON.stringify(state));
}

/** Compose the canonical key for a (account, window, band) tuple. */
export function warningKey(account: string, window: "5h" | "wk", band: number): string {
  return `${account}:${window}:${band}`;
}

/** True iff the band has already fired in the current window cycle (per
 *  state map). Callers should call `wipeForResetWindow` first when the
 *  observed reset epoch has advanced. */
export function hasBandFired(
  state: WarningState,
  account: string,
  window: "5h" | "wk",
  band: number,
): boolean {
  return Object.prototype.hasOwnProperty.call(state, warningKey(account, window, band));
}

/** Record a band as having fired now. Returns the mutated copy of state. */
export function recordBandFire(
  state: WarningState,
  account: string,
  window: "5h" | "wk",
  band: number,
  nowSec: number,
): WarningState {
  return { ...state, [warningKey(account, window, band)]: nowSec };
}

/**
 * Wipe all entries for `(account, window)` when the window-reset epoch
 * has advanced past `priorResetEpoch`. Returns the (possibly mutated)
 * state.
 *
 * The caller passes the per-tick OBSERVED reset epoch (from the budget
 * probe) and the previously-observed value (from the state map's
 * `<account>:<window>:reset` sentinel key, set on each wipe). When
 * `currentResetEpoch > priorResetEpoch`, every `<account>:<window>:*`
 * key (including the sentinel) is replaced with the new sentinel.
 *
 * If `priorResetEpoch` is null (first observation), the sentinel is
 * stamped without wiping.
 */
export function wipeForResetWindow(
  state: WarningState,
  account: string,
  window: "5h" | "wk",
  currentResetEpoch: number,
): WarningState {
  const sentinelKey = `${account}:${window}:reset`;
  const prior = state[sentinelKey];
  // First observation OR current matches prior → just ensure sentinel
  // is set (no wipe needed).
  if (prior === undefined || currentResetEpoch === prior) {
    if (prior === undefined) return { ...state, [sentinelKey]: currentResetEpoch };
    return state;
  }
  // Reset advanced: drop all `<account>:<window>:*` keys, restamp sentinel.
  if (currentResetEpoch > prior) {
    const out: WarningState = {};
    const prefix = `${account}:${window}:`;
    for (const [k, v] of Object.entries(state)) {
      if (!k.startsWith(prefix)) out[k] = v;
    }
    out[sentinelKey] = currentResetEpoch;
    return out;
  }
  // Reset went backwards (clock-skew / stale data) — keep state as-is.
  return state;
}
