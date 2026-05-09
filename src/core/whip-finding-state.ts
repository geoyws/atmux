// ADR-079 §D: per-template Discord-emit dedup state for whip findings.
//
// Each whip-tick batches findings into three named-template emits
// (`whip-blocker`, `whip-overdue`, `whip-progress`). Without dedup, an
// unchanged finding set re-fires the same Discord ping every 5min,
// drowning the operator's channel — ~275 pings/24h observed in sopx;
// 90% boilerplate (sopx-driver, 2026-05-08 18:30 MYT). Target ≤80/24h
// (~70% reduction).
//
// State file: `<atmuxDir>/state/whip-finding-state.json`. Schema is a
// flat per-template-key map:
//
//   {
//     "<template-key>": { "hash": "<sha256_16>", "lastFireSec": <epoch> },
//     ...
//   }
//
// `template-key` is one of `whip-blocker` / `whip-overdue` /
// `whip-progress` (matches the `DiscordTemplate` literal). Future
// caller may key per-member-per-kind for finer granularity (OQ-D1
// recommended default — kept open by the key-string contract being
// caller-defined rather than enum-locked here).
//
// `hash` is sha256 of the bullets array (canonical JSON), truncated to
// 16 hex chars. Truncation is fine — bullets-collision-on-different-
// content is astronomically rare and the worst-case is one missed ping
// per 2^64 ticks.
//
// Heartbeat policy: when the hash is unchanged AND `nowSec -
// lastFireSec >= heartbeatSec`, emit anyway as a forced re-affirmation
// (operator needs liveness even on quiet teams). Default 3600s
// (hourly). Caller can opt out by passing `Number.POSITIVE_INFINITY`.
//
// Anti-pattern guard: corrupt/malformed state → empty map. Losing the
// dedup memory is cheaper than crashing the whip-tick (mirrors
// perm-mode-drift-state.ts and budget-warning-state.ts).

import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";

const STATE_FILENAME = "whip-finding-state.json";

/** Default heartbeat re-fire window — 1h per ADR-079 §D. Mirrors the
 *  hourly cadence of `[whip-heartbeat]` (`whip.ts:1451`) so the
 *  observability rhythm stays consistent across templates. */
export const DEFAULT_HEARTBEAT_SEC = 3600;

/** Truncated sha256 length. 16 hex chars = 64 bits — plenty for the
 *  collision domain (one missed ping per 2^64 ticks; whip ticks every
 *  5min so collision-rate is negligible on geologic timescales). */
export const HASH_HEX_LEN = 16;

export function whipFindingStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** Per-template-key dedup row. */
export interface FindingState {
  hash: string;
  lastFireSec: number;
}

/** State map: `<template-key>` → `{hash, lastFireSec}`. */
export type WhipFindingState = Record<string, FindingState>;

/** Outcome of the dedup gate — caller branches on this. */
export type FindingGateVerdict = "transition" | "heartbeat" | "suppress";

/**
 * Compute the sha256_16 hash of a bullets array. Canonical JSON
 * serialization keeps the hash stable across object-identity changes
 * — caller can pass freshly-constructed arrays each tick without
 * tripping false transitions.
 *
 * Order matters: `["a", "b"]` and `["b", "a"]` hash differently. That
 * matches the operator's expectation — a re-ordered finding set IS a
 * different observation.
 */
export function hashFindingBullets(bullets: ReadonlyArray<string>): string {
  const canonical = JSON.stringify(bullets);
  return createHash("sha256").update(canonical).digest("hex").slice(0, HASH_HEX_LEN);
}

/**
 * Decide whether the named emit-template should fire this tick:
 *   - `transition` — never fired before OR hash changed since last fire.
 *   - `heartbeat`  — hash unchanged AND last-fire age ≥ `heartbeatSec`.
 *   - `suppress`   — hash unchanged AND within heartbeat window.
 *
 * Caller treats `transition` + `heartbeat` identically for the Discord
 * call (both emit); the distinction lets the caller log the cause
 * (`state changed` vs `hourly re-affirmation`) for operator clarity.
 *
 * Pass `heartbeatSec = Number.POSITIVE_INFINITY` to disable heartbeat
 * re-fires entirely (suppress permanently when state is stable).
 */
export function shouldFireFinding(
  state: WhipFindingState,
  key: string,
  newHash: string,
  nowSec: number,
  heartbeatSec: number = DEFAULT_HEARTBEAT_SEC,
): FindingGateVerdict {
  const prior = state[key];
  if (prior === undefined) return "transition";
  if (prior.hash !== newHash) return "transition";
  if (nowSec - prior.lastFireSec >= heartbeatSec) return "heartbeat";
  return "suppress";
}

/** Pure: record the fire — returns the next state with `key` stamped
 *  to `{newHash, nowSec}`. Caller persists via `saveWhipFindingState`. */
export function recordFindingFire(
  state: WhipFindingState,
  key: string,
  newHash: string,
  nowSec: number,
): WhipFindingState {
  return { ...state, [key]: { hash: newHash, lastFireSec: nowSec } };
}

/** Read state from disk; empty map on missing/malformed. */
export async function loadWhipFindingState(atmuxDir: string): Promise<WhipFindingState> {
  const path = whipFindingStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: WhipFindingState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null) continue;
      const o = v as Record<string, unknown>;
      if (
        typeof o.hash === "string" &&
        o.hash.length > 0 &&
        typeof o.lastFireSec === "number" &&
        Number.isFinite(o.lastFireSec)
      ) {
        out[k] = { hash: o.hash, lastFireSec: o.lastFireSec };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write via abstractions/fs. */
export async function saveWhipFindingState(
  atmuxDir: string,
  state: WhipFindingState,
): Promise<void> {
  await atomicWrite(whipFindingStatePath(atmuxDir), `${JSON.stringify(state, null, 2)}\n`);
}
