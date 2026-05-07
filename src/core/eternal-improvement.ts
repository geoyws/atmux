// ADR-052 T2: read/write/idempotence-guard primitives over
// `<atmuxDir>/state/eternal-improvement.json`.
//
// Per ADR-003 layering: takes `atmuxDir` as an arg (no global state);
// JSON IO routes through `src/abstractions/json.ts` (atomic write +
// flock). The state file is bash-shared — `lib/improve.sh` writes the
// SAME file via `atmux::jq_update`, so the lock sidecar `<path>.lock`
// is required (writes lock; matches the `whip-idle-state.json.lock`
// pattern called out in ADR-052 §State-file-schema).
//
// `writeState({ skipOnContention: true })` is the best-effort write
// path used by mid-cycle accounting — on a `LockTimeoutError` it logs
// a non-fatal `improve: state-file locked, skipping` line and returns
// `false` instead of throwing. This matches the bash-side
// `_atmux_improve_state_write_jq` helper's non-blocking flock posture
// (per ADR-052 §State-file-schema "matches `whip-idle-state.json.lock`").
//
// `isActive` and `isStale` implement ADR-052 §Idempotence:
//   - `active: true` AND `runId < 24h` → second invocation is benign,
//     `atmux improve` exits 0 with the "already active" log line.
//   - `active: true` AND `startedAt > 24h` AND no `currentCycle.startedAt`
//     in last 6h → run is stale (crashed / abandoned); state can be
//     cleared and a fresh run started.

import { join } from "node:path";
import { LockTimeoutError } from "../errors.ts";
import { tryReadJson, updateJson, writeJson } from "../abstractions/json.ts";
import { now as nowMs } from "../abstractions/time.ts";
import {
  type EternalImprovementState,
  EternalImprovementState as EternalImprovementStateSchema,
} from "../schema/eternal-improvement.ts";

const TWENTY_FOUR_HOURS_S = 24 * 60 * 60;
const SIX_HOURS_S = 6 * 60 * 60;

// Short flock budget for skip-on-contention writes. Long enough to
// absorb a ~tens-of-ms write from a peer; short enough that a stuck
// lock doesn't wedge the caller (whip ticks every 5min — a write that
// blocks for >250ms is already too long for the single-tick budget).
const SKIP_ON_CONTENTION_TIMEOUT_MS = 250;

/** Resolve `<atmuxDir>/state/eternal-improvement.json`. Mirrors bash
 *  `_atmux_improve_state_path` in `lib/improve.sh`. */
export function eternalImprovementStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", "eternal-improvement.json");
}

/**
 * Read the state file. Returns `null` on ENOENT (first-run / between
 * runs after termination has wiped the file) — caller decides whether
 * absence is benign.
 *
 * Existing-but-invalid files still throw `SchemaError` (no silent
 * fallback to defaults — ADR-005 rule).
 */
export async function readState(atmuxDir: string): Promise<EternalImprovementState | null> {
  return await tryReadJson(eternalImprovementStatePath(atmuxDir), EternalImprovementStateSchema);
}

export interface WriteStateOpts {
  /** When true, contention-on-the-flock is non-fatal: log + skip, return
   *  `false`. When false (the default), throw `LockTimeoutError` like a
   *  normal `updateJson` write. Used by mid-cycle accounting which would
   *  rather lose a tick than wedge the caller. */
  skipOnContention?: boolean;
}

/**
 * Write the state file atomically under the file's flock. Returns
 * `true` on success.
 *
 * `skipOnContention: true` swaps the flock budget to a short one and
 * returns `false` on `LockTimeoutError` (logs to stderr) — see the
 * doc-comment at the top of this file for the rationale.
 */
export async function writeState(
  atmuxDir: string,
  state: EternalImprovementState,
  opts?: WriteStateOpts,
): Promise<boolean> {
  const path = eternalImprovementStatePath(atmuxDir);
  if (opts?.skipOnContention !== true) {
    await writeJson(path, EternalImprovementStateSchema, state);
    return true;
  }
  try {
    await updateJson(path, EternalImprovementStateSchema, () => state, {
      initial: state,
      lock: { timeoutMs: SKIP_ON_CONTENTION_TIMEOUT_MS },
    });
    return true;
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      process.stderr.write("improve: state-file locked, skipping (non-fatal)\n");
      return false;
    }
    throw err;
  }
}

/**
 * ADR-052 §Idempotence: a run is "active" when `active: true` AND its
 * `startedAt` is within the last 24h. Beyond 24h the run is presumed
 * crashed / abandoned (see `isStale`).
 *
 * `nowSec` defaults to the real clock; tests pin to deterministic values.
 */
export function isActive(
  state: EternalImprovementState | null,
  nowSec: number = Math.floor(nowMs() / 1000),
): boolean {
  if (state === null) return false;
  if (state.active !== true) return false;
  return nowSec - state.startedAt < TWENTY_FOUR_HOURS_S;
}

/**
 * ADR-052 §Idempotence: a run is "stale" when `active: true` AND
 * `startedAt > 24h ago` AND no `currentCycle.startedAt` in the last 6h.
 * Conservative thresholds — a real improvement run shouldn't go 6h
 * without a cycle close.
 *
 * Stale runs can be cleared safely (next `atmux improve` invocation
 * starts fresh).
 */
export function isStale(
  state: EternalImprovementState | null,
  nowSec: number = Math.floor(nowMs() / 1000),
): boolean {
  if (state === null) return false;
  if (state.active !== true) return false;
  if (nowSec - state.startedAt <= TWENTY_FOUR_HOURS_S) return false;
  const cycleStartedAt = state.currentCycle?.startedAt;
  if (cycleStartedAt === undefined || cycleStartedAt === null) return true;
  return nowSec - cycleStartedAt > SIX_HOURS_S;
}
