// ADR-003: pause-flag read/write + dispatch-gate check.
//
// Encapsulates the bash `lib/pause.sh` state-flag pattern: pausing a
// member writes `<atmuxDir>/state/paused.json[member] = {at, reason}`;
// resuming deletes the entry; `isPaused` checks presence. Used by the
// `pause`/`resume` verbs (Phase 2) and by the dispatch-gate check in
// `dispatch` + `whip` (also Phase 2).
//
// Per ADR-003, this core lib takes its dependencies as args (no global
// state); callers pass `atmuxDir` so tests can inject any directory.
// All JSON IO routes through `src/abstractions/json.ts` (atomic write +
// flock-protected mutation per ADR-005).
//
// Parity contract (PLAN.md §4.1, ADR-013). The TS port runs side-by-side
// with bash atmux during the burn-in window; both binaries read + write
// the SAME `paused.json`. So:
//   - `at` is epoch SECONDS (bash `date +%s`), not ms.
//   - No `schemaVersion` field; bash didn't write one.
//   - Default reason is `"manual"` (bash `${ATMUX_PAUSE_REASON:-manual}`).
//   - `resume` is idempotent on already-resumed members (bash `del()`).
//
// Note on task-description scope. Task #8's prose mentions "send-pause
// signal", "interrupt to target pane", and "restart on resume" — none
// of those exist in bash `lib/pause.sh` (HEAD `2aadc3f`). The bash
// behaviour is purely state-flag manipulation; tmux signalling is a
// non-existent feature, not a port-target. This file ports bash exactly
// per ADR-013; any redesign waits for Phase 6 / ADR-014.

import { join } from "node:path";
import { readJsonOr, updateJson } from "../abstractions/json.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { type PausedMap, PausedMapSchema, type PauseEntry } from "../schema/paused.ts";

/** Default reason string when no override is supplied. Mirrors bash
 *  `${ATMUX_PAUSE_REASON:-manual}` from `lib/pause.sh:22`. */
export const DEFAULT_PAUSE_REASON = "manual";

/** Resolve `<atmuxDir>/state/paused.json`. Mirrors bash
 *  `$(atmux::state_dir)/paused.json` from `lib/common.sh:71` + `lib/pause.sh:15`. */
export function pausedJsonPath(atmuxDir: string): string {
  return join(atmuxDir, "state", "paused.json");
}

/**
 * Load the paused map. Returns `{}` if the file is absent (first-run).
 * Throws `SchemaError` on malformed-but-existing files (no silent
 * fallback to defaults — ADR-005 rule).
 */
export async function loadPausedMap(atmuxDir: string): Promise<PausedMap> {
  return readJsonOr(pausedJsonPath(atmuxDir), PausedMapSchema, {});
}

export interface PauseOpts {
  /** Override the reason string. Default: `"manual"`. */
  reason?: string;
  /**
   * Override the `at` epoch (in SECONDS) to pin a deterministic time
   * for tests. Default: `Math.floor(time.now() / 1000)`.
   */
  nowEpochSec?: number;
}

/**
 * Mark `member` as paused. Idempotent on the writer side: re-pausing an
 * already-paused member overwrites the entry (matching bash's
 * `'.[$m] = {…}'` jq filter, which is unconditional assignment).
 */
export async function pauseMember(
  atmuxDir: string,
  member: string,
  opts?: PauseOpts,
): Promise<void> {
  const reason = opts?.reason ?? DEFAULT_PAUSE_REASON;
  const at = opts?.nowEpochSec ?? Math.floor(nowMs() / 1000);
  await updateJson(
    pausedJsonPath(atmuxDir),
    PausedMapSchema,
    (current) => ({ ...current, [member]: { at, reason } }),
    { initial: {} },
  );
}

/**
 * Resume `member`. No-op if the member wasn't paused — matches bash
 * `del(.[$m])` which silently leaves the map unchanged when the key is
 * absent. Returns nothing; caller checks via `isPaused` if it cares.
 */
export async function resumeMember(atmuxDir: string, member: string): Promise<void> {
  await updateJson(
    pausedJsonPath(atmuxDir),
    PausedMapSchema,
    (current) => {
      if (!(member in current)) return current;
      const { [member]: _removed, ...rest } = current;
      return rest;
    },
    { initial: {} },
  );
}

/**
 * True if `member` is currently paused. The dispatch-gate check used by
 * `dispatch` + `whip` to refuse to queue tasks against a paused member
 * (mirrors bash `atmux::is_paused` from `lib/pause.sh:34`).
 */
export async function isPaused(atmuxDir: string, member: string): Promise<boolean> {
  const map = await loadPausedMap(atmuxDir);
  return member in map;
}

/** Returns the pause entry for `member`, or `null` if not paused. */
export async function getPauseInfo(atmuxDir: string, member: string): Promise<PauseEntry | null> {
  const map = await loadPausedMap(atmuxDir);
  return map[member] ?? null;
}

/** Read-only snapshot of all currently-paused members. */
export async function listPaused(atmuxDir: string): Promise<PausedMap> {
  return loadPausedMap(atmuxDir);
}
