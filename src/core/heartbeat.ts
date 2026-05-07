// ADR-057 §D6a: per-member heartbeat write/read primitives.
//
// The supervisor (when it lands TS-side; currently bash-only) writes
// `<atmuxDir>/heartbeats/<member>.epoch` every 60s with the current
// epoch-seconds as a single line. The watchdog verb (§D6b) reads
// these files to detect stalled members; `atmux status` (§D6c) reads
// freshness as the primary liveness signal.
//
// Atomic via `atomicWrite` (D3c-equivalent), so the watchdog never
// reads a torn file. Per-member files (not a single rolled-up file)
// keep concurrent writers from racing on the same path — each member's
// heartbeat is owned by exactly one supervisor write thread.

import { join } from "node:path";
import { atomicWrite, exists, readTextOrNull, statOrNull } from "../abstractions/fs.ts";
import { now } from "../abstractions/time.ts";

export const HEARTBEATS_DIRNAME = "heartbeats";
/** ADR-057 §D6 default — 300s (5min) staleness threshold. Configurable
 *  via team.json::stallPrevention.heartbeatStaleSec. */
export const DEFAULT_HEARTBEAT_STALE_SEC = 300;

/** `<atmuxDir>/heartbeats/`. */
export function heartbeatsDir(atmuxDir: string): string {
  return join(atmuxDir, HEARTBEATS_DIRNAME);
}

/** `<atmuxDir>/heartbeats/<member>.epoch`. */
export function heartbeatPath(atmuxDir: string, member: string): string {
  return join(heartbeatsDir(atmuxDir), `${member}.epoch`);
}

/**
 * Write `epochSec` to the per-member heartbeat file atomically.
 * Default `epochSec` is the current real clock; tests pin a value.
 */
export async function writeHeartbeat(
  atmuxDir: string,
  member: string,
  epochSec: number = Math.floor(now() / 1000),
): Promise<void> {
  await atomicWrite(heartbeatPath(atmuxDir, member), `${epochSec}\n`);
}

/**
 * Read the per-member heartbeat epoch. Returns `null` when the file
 * is absent OR contains an unparseable value (defensive — heartbeat
 * absence is a real signal: "supervisor never wrote one for this
 * member"; corrupt content is treated the same).
 */
export async function readHeartbeat(
  atmuxDir: string,
  member: string,
): Promise<number | null> {
  const path = heartbeatPath(atmuxDir, member);
  if (!(await exists(path))) return null;
  const text = await readTextOrNull(path);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * True when the heartbeat is stale (older than `staleSec` seconds OR
 * absent). The watchdog verb's primary check.
 */
export async function isHeartbeatStale(
  atmuxDir: string,
  member: string,
  nowSec: number,
  staleSec: number = DEFAULT_HEARTBEAT_STALE_SEC,
): Promise<boolean> {
  const epoch = await readHeartbeat(atmuxDir, member);
  if (epoch === null) return true;
  return nowSec - epoch > staleSec;
}

/**
 * Read all heartbeat ages (in seconds, relative to `nowSec`) for the
 * given members. Returns `{member, ageSec | null}` per entry —
 * `ageSec === null` when the heartbeat is absent.
 */
export interface HeartbeatAge {
  member: string;
  ageSec: number | null;
}

export async function readHeartbeatAges(
  atmuxDir: string,
  members: ReadonlyArray<string>,
  nowSec: number,
): Promise<HeartbeatAge[]> {
  const out: HeartbeatAge[] = [];
  for (const m of members) {
    const path = heartbeatPath(atmuxDir, m);
    const stat = await statOrNull(path);
    if (stat === null) {
      out.push({ member: m, ageSec: null });
      continue;
    }
    // Prefer the file's content over mtime — content is what the
    // supervisor explicitly stamped; mtime can drift on shared FS.
    const epoch = await readHeartbeat(atmuxDir, m);
    if (epoch === null) {
      out.push({ member: m, ageSec: null });
      continue;
    }
    out.push({ member: m, ageSec: nowSec - epoch });
  }
  return out;
}
