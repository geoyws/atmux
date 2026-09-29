// ADR-003: pause-flag read/write + dispatch-gate check.
//
// ADR-169 P1 (EPIC e-38ee9939): the paused map lives in the `flags`
// table (`key='paused'`) of `<atmuxDir>/state.db`, not in
// `<atmuxDir>/state/paused.json`. Readers promote a leftover legacy
// file on first read; writers are table-only. The legacy path helper
// stays as the fallback address.
//
// Encapsulates the bash `lib/pause.sh` state-flag pattern: pausing a
// member writes `<atmuxDir>/state/paused.json[member] = {at, reason}`;
// resuming deletes the entry; `isPaused` checks presence. Used by the
// `pause`/`resume` verbs (Phase 2) and by the dispatch-gate check in
// `dispatch` + `whip` (also Phase 2).
//
// Per ADR-003, this core lib takes its dependencies as args (no global
// state); callers pass `atmuxDir` so tests can inject any directory.
// All state IO routes through the `flags` table
// (`src/core/flags-repo.ts`); JSON parsing still validates via
// `src/abstractions/json.ts` per ADR-005.
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
import { parseJsonString } from "../abstractions/json.ts";
import { transactImmediate } from "../abstractions/sqlite.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { type PausedMap, PausedMapSchema, type PauseEntry } from "../schema/paused.ts";
import {
  FlagsRepo,
  importLegacyFlagText,
  readFlagTextAtDb,
  teamFlagsDbPath,
  withFlagsDb,
} from "./flags-repo.ts";

/** Default reason string when no override is supplied. Mirrors bash
 *  `${ATMUX_PAUSE_REASON:-manual}` from `lib/pause.sh:22`. */
export const DEFAULT_PAUSE_REASON = "manual";

/** Legacy path: `<atmuxDir>/state/paused.json`. Still the fallback
 *  address for pre-migration teams (mirrors bash
 *  `$(atmux::state_dir)/paused.json`). */
export function pausedJsonPath(atmuxDir: string): string {
  return join(atmuxDir, "state", "paused.json");
}
/**
 * Load the paused map. Returns `{}` when neither a flags row nor a
 * legacy file exists (first-run). Throws `SchemaError` on
 * malformed-but-existing state (no silent fallback — ADR-005 rule).
 */
export async function loadPausedMap(atmuxDir: string): Promise<PausedMap> {
  const path = pausedJsonPath(atmuxDir);
  const text = await readFlagTextAtDb(teamFlagsDbPath(atmuxDir), "paused", path);
  if (text === null) return {};
  return parseJsonString(path, PausedMapSchema, text);
}

/**
 * Read-modify-write the paused map inside one IMMEDIATE transaction
 * (the SQLite successor to the old flock-guarded `updateJson` — concurrent
 * `pause`/`resume` verbs serialize instead of losing updates). Output
 * re-validates, mirroring the old mutation path.
 */
async function updatePausedMap(
  atmuxDir: string,
  mutator: (current: PausedMap) => PausedMap,
): Promise<PausedMap> {
  const path = pausedJsonPath(atmuxDir);
  const dbPath = teamFlagsDbPath(atmuxDir);
  return withFlagsDb(dbPath, async (db) => {
    await importLegacyFlagText(db, "paused", path, nowMs());
    return transactImmediate(db, () => {
      const repo = new FlagsRepo(db);
      const raw = repo.get("paused");
      const current = raw === null ? {} : parseJsonString(path, PausedMapSchema, raw);
      const next = PausedMapSchema.parse(mutator(current));
      repo.set("paused", JSON.stringify(next), nowMs());
      return next;
    });
  });
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
  await updatePausedMap(atmuxDir, (current) => ({ ...current, [member]: { at, reason } }));
}

/**
 * Resume `member`. No-op if the member wasn't paused — matches bash
 * `del(.[$m])` which silently leaves the map unchanged when the key is
 * absent. Returns nothing; caller checks via `isPaused` if it cares.
 */
export async function resumeMember(atmuxDir: string, member: string): Promise<void> {
  await updatePausedMap(atmuxDir, (current) => {
    if (!(member in current)) return current;
    const { [member]: _removed, ...rest } = current;
    return rest;
  });
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
