// ADR-053 §D3 4.2: refresh-soon dedup state for [whip-budget-refresh-soon].
//
// Once per `(account, window, resetEpoch)` triple. The "soon" notice
// fires when the OBSERVED reset epoch is within `lead-time` seconds of
// `now()`. After firing, the entry stays in state until the
// `resetEpoch` passes — at that point groom-side cleanup drops stale
// entries (or the next `wipeStaleEntries` call here, called per-tick
// from whip-tick).
//
// State file: `<atmuxDir>/state/budget-refresh-soon-state.json`. Schema
// per ADR-053 §D3:
//
//   {
//     "<account>:<window>:<resetEpoch>": <fire-epoch>,
//     ...
//   }
//
// Why include resetEpoch in the key (not just account+window): one
// 5h window can refresh multiple times in a single budget-pause cycle
// — the dedup must re-arm per cycle. resetEpoch is naturally unique
// per cycle.

import { join } from "node:path";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";

const STATE_FILENAME = "budget-refresh-soon-state.json";

export function budgetRefreshSoonStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** State map: `<account>:<window>:<resetEpoch>` → epoch-of-fire. */
export type RefreshSoonState = Record<string, number>;

/** Read state from disk; empty map on missing/malformed. */
export async function loadRefreshSoonState(
  atmuxDir: string,
): Promise<RefreshSoonState> {
  const path = budgetRefreshSoonStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: RefreshSoonState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {}; // corrupt — re-arm fresh
  }
}

/** Atomic-write the full state map. */
export async function writeRefreshSoonState(
  atmuxDir: string,
  state: RefreshSoonState,
): Promise<void> {
  await atomicWrite(budgetRefreshSoonStatePath(atmuxDir), JSON.stringify(state));
}

/** Compose the canonical key for a (account, window, resetEpoch) tuple. */
export function refreshSoonKey(
  account: string,
  window: "5h" | "wk",
  resetEpoch: number,
): string {
  return `${account}:${window}:${resetEpoch}`;
}

/** True iff the (account, window, resetEpoch) triple has already fired. */
export function hasRefreshSoonFired(
  state: RefreshSoonState,
  account: string,
  window: "5h" | "wk",
  resetEpoch: number,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    state,
    refreshSoonKey(account, window, resetEpoch),
  );
}

/** Stamp a refresh-soon fire. Returns the mutated state copy. */
export function recordRefreshSoonFire(
  state: RefreshSoonState,
  account: string,
  window: "5h" | "wk",
  resetEpoch: number,
  nowSec: number,
): RefreshSoonState {
  return { ...state, [refreshSoonKey(account, window, resetEpoch)]: nowSec };
}

/**
 * Drop entries whose `<resetEpoch>` is `≤ nowSec` (i.e., already
 * passed). Mirror of the bash-side cleanup that ADR-053 §D3 §"Per-
 * `(account, window-id, resetEpoch)` keying" describes ("once that
 * resetEpoch passes, the entry is moot; groom-side cleans entries
 * with `resetEpoch < now`"). Returns the mutated state.
 */
export function wipeStaleEntries(
  state: RefreshSoonState,
  nowSec: number,
): RefreshSoonState {
  const out: RefreshSoonState = {};
  let changed = false;
  for (const [k, v] of Object.entries(state)) {
    const epoch = extractResetEpoch(k);
    if (epoch === null || epoch > nowSec) {
      out[k] = v;
    } else {
      changed = true;
    }
  }
  return changed ? out : state;
}

function extractResetEpoch(key: string): number | null {
  // Key shape: `<account>:<window>:<resetEpoch>`. Parse the trailing
  // segment — accounts can contain colons in theory, so we split from
  // the right and take the last segment.
  const idx = key.lastIndexOf(":");
  if (idx < 0) return null;
  const tail = key.slice(idx + 1);
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}
