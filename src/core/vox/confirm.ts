// ADR-272: voice operator interface — server-enforced mutation
// confirmation.
//
// A voice-triggered mutating tool call is held until the operator
// confirms it. The server issues a single-use token BOUND to the exact
// call (tool name + canonicalized args + session): redeeming with any
// other binding is a mismatch, so a confirmation can never be replayed
// against a different mutation. Clock is injected (no real timers);
// expiry is detected lazily at redeem and pruned on every issue.
//
// Single-use is strict: ANY redeem attempt that finds the token burns it
// — success, expiry, and mismatch all delete. A mismatch means the
// client is confused or malicious; failing safe forces a fresh
// confirmation round-trip.

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { tryParseJsonString } from "../../abstractions/json.ts";

/**
 * Deterministic JSON canonicalization: object keys sorted recursively,
 * array order preserved, `undefined` object values dropped (matching
 * `JSON.stringify`), `undefined` array slots rendered as `null`. Input
 * is expected to be a JSON value (the callers parse `argsJson` first).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ConfirmBinding {
  tool: string;
  argsJson: string;
  sessionId: string;
}

export type RedeemResult = { ok: true } | { ok: false; reason: "unknown" | "expired" | "mismatch" };

export interface ConfirmStore {
  issue(binding: ConfirmBinding): { token: string; expiresAtMs: number };
  redeem(token: string, binding: ConfirmBinding): RedeemResult;
}

/**
 * Binding hash: sha256 over `tool \n canonicalJson(parsed args) \n
 * sessionId`. Unparseable `argsJson` falls back to hashing the raw
 * string — still deterministic, still distinct per input (R3: JSON
 * parsing goes through `tryParseJsonString`).
 */
function bindingHash(binding: ConfirmBinding): string {
  const parsed = tryParseJsonString(binding.argsJson, z.unknown());
  const canonArgs = parsed === null ? binding.argsJson : canonicalJson(parsed);
  return createHash("sha256")
    .update(`${binding.tool}\n${canonArgs}\n${binding.sessionId}`)
    .digest("hex");
}

/** In-memory confirmation store. `clock` MUST be injected (fake in tests). */
export function createConfirmStore(opts: { clock: () => number; ttlMs: number }): ConfirmStore {
  const entries = new Map<string, { hash: string; expiresAtMs: number }>();
  return {
    issue(binding): { token: string; expiresAtMs: number } {
      const now = opts.clock();
      for (const [token, e] of entries) {
        if (e.expiresAtMs <= now) entries.delete(token); // lazy prune
      }
      const token = randomBytes(16).toString("hex");
      const expiresAtMs = now + opts.ttlMs;
      entries.set(token, { hash: bindingHash(binding), expiresAtMs });
      return { token, expiresAtMs };
    },
    redeem(token, binding): RedeemResult {
      const entry = entries.get(token);
      if (entry === undefined) return { ok: false, reason: "unknown" };
      entries.delete(token); // single-use: any found redeem burns the token
      if (entry.expiresAtMs <= opts.clock()) return { ok: false, reason: "expired" };
      if (entry.hash !== bindingHash(binding)) return { ok: false, reason: "mismatch" };
      return { ok: true };
    },
  };
}
