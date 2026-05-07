// ADR-055 §D2: 24h dedup state for cursor self-heal recipe firings.
//
// Each whip-tick that runs the self-heal pass first checks per-recipe
// whether the recipe fired in the dedup window. If yes → skip; if no →
// detect → propose → invokeCursor → verify → stage → record-fire.
//
// State file: `<atmuxDir>/state/cursor-self-heal-state.json`. Schema
// is a flat key-value map per ADR-055 §D2 worked example:
//
//   {
//     "<recipeId>": <epoch-of-last-fire-in-seconds>,
//     ...
//   }
//
// Window: 24h fixed (ADR-055 §D2 "Dedup: don't re-fire if same recipe
// already fired in last 24h"). Caller passes `nowSec`; module is clock-
// agnostic for testability.
//
// Anti-pattern guard: corrupt/malformed state → empty map (re-arm
// fresh). Same posture as ADR-053's budget-warning-state — losing the
// dedup memory is cheaper than crashing the whip-tick.

import { join } from "node:path";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";

/** State-file path. */
const STATE_FILENAME = "cursor-self-heal-state.json";

/** Default dedup window — 24h per ADR-055 §D2. */
export const DEFAULT_DEDUP_TTL_SEC = 24 * 60 * 60;

export function cursorSelfHealStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** State map: `<recipeId>` → epoch-seconds-of-last-fire. */
export type SelfHealState = Record<string, number>;

/** Read state from disk; empty map on missing/malformed. */
export async function loadSelfHealState(atmuxDir: string): Promise<SelfHealState> {
  const path = cursorSelfHealStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: SelfHealState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {}; // corrupt — re-arm fresh
  }
}

/** Atomic-write the full state map. */
export async function writeSelfHealState(
  atmuxDir: string,
  state: SelfHealState,
): Promise<void> {
  await atomicWrite(cursorSelfHealStatePath(atmuxDir), JSON.stringify(state));
}

/**
 * True iff `recipeId` fired within `ttlSec` of `nowSec` per state map.
 * Default `ttlSec` is 24h (ADR-055 §D2).
 *
 * Future-stamped entries (`lastFire > nowSec`, e.g. clock-skew between
 * cron-host and writer) count as "recent" — defensive: skip the recipe
 * rather than re-fire on potentially-bad clock data.
 */
export function isRecentSelfHeal(
  state: SelfHealState,
  recipeId: string,
  nowSec: number,
  ttlSec: number = DEFAULT_DEDUP_TTL_SEC,
): boolean {
  const lastFire = state[recipeId];
  if (lastFire === undefined) return false;
  return lastFire >= nowSec - ttlSec;
}

/** Record a recipe as having fired now. Returns the mutated copy of state. */
export function recordSelfHealFire(
  state: SelfHealState,
  recipeId: string,
  nowSec: number,
): SelfHealState {
  return { ...state, [recipeId]: nowSec };
}
