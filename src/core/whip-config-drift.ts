// ADR-054: drift-report compose + safe-defaults rebuild + dedup state
// for `team.json::whip` Zod validation.
//
// Whip's per-tick path safe-parses team.json via the strict `Team`
// schema. On failure, this module:
//   - composes a `DriftReport` (canonical issue list + sha256 hash +
//     masked rawSnippet) — `composeDriftReport`.
//   - rebuilds a parseable shape by stripping invalid keys + applying
//     Zod defaults — `makeDriftSafeDefaults`.
//   - manages the hash-keyed dedup state-file at
//     `.atmux/state/whip-config-drift-state.json` with a 24h re-fire
//     window — `shouldFireDriftPing` + `recordDriftPing`.
//
// `composeDriftReport`'s issue list is canonical-sorted (by `path` then
// `code`) so the same drift hashes deterministically across ticks +
// across machines.
//
// `makeDriftSafeDefaults` only knows about the WHIP sub-shape today.
// The rest of the team.json shape is loose enough (`.passthrough()`)
// that Zod parses it without any invalid-key concerns. If the whip
// sub-shape is the issue (the typical drift), we strip its unknown
// keys + apply schema defaults. If the catastrophic shape is a missing
// `members` array, we fall back to a minimal valid team shape.

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ZodError } from "zod";
import { tryReadJson, writeJson } from "../abstractions/json.ts";
import { stateDir } from "./common.ts";
import { z } from "zod";
import { TeamWhip } from "../schema/team.ts";

// ---------- Types ----------

export interface DriftIssue {
  /** Path to the offending key, e.g. ["whip", "budgetPauseThreshold"]. */
  path: string[];
  /** Zod issue code (`unrecognized_keys`, `invalid_type`, etc.). */
  code: string;
  /** Human-readable Zod message. */
  message: string;
}

export interface DriftReport {
  /** sha256 hex of the canonical issue list. Stable across ticks. */
  driftHash: string;
  /** First N issues (capped at 5 per ADR-054 §D2). */
  issues: DriftIssue[];
  /** ≤500-char snippet of the raw text, secrets-masked per ADR-008
   *  chunker convention. May be empty when raw text was unavailable. */
  rawSnippet: string;
  /** True when the drift was a JSON-parse failure (catastrophic) — the
   *  raw text wasn't even parseable. Surfaces in the doctor + Discord
   *  output as a special "malformed JSON" prefix. */
  catastrophic: boolean;
}

// ---------- Path + state file ----------

export const DRIFT_STATE_FILENAME = "whip-config-drift-state.json";

export function whipConfigDriftStatePath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), DRIFT_STATE_FILENAME);
}

/** ADR-054 §D2: re-fire every 24h even on identical drift. */
export const DRIFT_REFIRE_WINDOW_SEC = 24 * 60 * 60;

/** Schema for `<atmuxDir>/state/whip-config-drift-state.json`. */
export const DriftStateSchema = z.record(z.string(), z.number().int().nonnegative());
export type DriftState = z.infer<typeof DriftStateSchema>;

// ---------- Issue extraction + canonical hash ----------

const MAX_ISSUES = 5;
const MAX_RAW_SNIPPET = 500;

/** Mask secret-shaped tokens in a raw snippet per ADR-008 chunker
 *  convention. Conservative: redact `key=value` and `"key": "value"`
 *  style substrings where `key` matches
 *  /(secret|token|password|webhook|cookie)/i, AND any base64-looking
 *  substrings ≥40 chars. */
function maskSecrets(text: string): string {
  let out = text;
  // JSON-style "key": "value" or "key": value (handles surrounding quotes).
  out = out.replace(
    /"?(\w*(?:secret|token|password|webhook|cookie)\w*)"?\s*[:=]\s*("[^"]*"|[^\s,}]*)/gi,
    '"$1": "<redacted>"',
  );
  // long base64-looking substrings (fallback for raw secrets in any context).
  out = out.replace(/[A-Za-z0-9+/]{40,}={0,3}/g, (m) => `<redacted:${m.length}c>`);
  return out;
}

/** Convert a Zod issue's path (mixed string|number|symbol) to all-string
 *  form for stable hashing. Symbol paths shouldn't appear in JSON-shaped
 *  inputs but we coerce defensively. */
function pathToStrings(path: ReadonlyArray<PropertyKey>): string[] {
  return path.map((p) => String(p));
}

/**
 * Compose a drift report from a Zod validation error + the raw text
 * the parse failed on. Up to 5 issues + canonical hash + masked
 * snippet. `catastrophic` defaults false — set true by the
 * malformed-JSON path via `composeCatastrophicDrift`.
 */
export function composeDriftReport(error: ZodError, rawText: string): DriftReport {
  const allIssues: DriftIssue[] = error.issues.map((i) => ({
    path: pathToStrings(i.path),
    code: i.code,
    message: i.message,
  }));
  // Canonical sort by path-string then code so the hash is stable.
  const sorted = [...allIssues].sort((a, b) => {
    const ap = a.path.join(".");
    const bp = b.path.join(".");
    if (ap !== bp) return ap < bp ? -1 : 1;
    return a.code < b.code ? -1 : 1;
  });
  const issues = sorted.slice(0, MAX_ISSUES);
  const driftHash = sha256OfIssues(sorted);
  const rawSnippet = maskSecrets(rawText.slice(0, MAX_RAW_SNIPPET));
  return { driftHash, issues, rawSnippet, catastrophic: false };
}

/**
 * Compose a "catastrophic" drift — the raw text wasn't valid JSON.
 * No Zod issue list available; we synthesize a single
 * `invalid_json`-coded issue. `parseError` becomes the message.
 */
export function composeCatastrophicDrift(parseError: unknown, rawText: string): DriftReport {
  const message = parseError instanceof Error ? parseError.message : String(parseError);
  const issues: DriftIssue[] = [
    {
      path: [],
      code: "invalid_json",
      message: `team.json is not valid JSON: ${message}`,
    },
  ];
  const driftHash = sha256OfIssues(issues);
  const rawSnippet = maskSecrets(rawText.slice(0, MAX_RAW_SNIPPET));
  return { driftHash, issues, rawSnippet, catastrophic: true };
}

function sha256OfIssues(issues: ReadonlyArray<DriftIssue>): string {
  const canonical = issues
    .map((i) => `${i.path.join(".")}|${i.code}|${i.message}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------- Safe defaults rebuild ----------

/** Wrap-key the raw shape: pull off everything that isn't a TeamWhip
 *  field, then apply schema defaults via `TeamWhip.parse({})`. */
function safeDefaultsForWhip(rawWhip: unknown): unknown {
  const known = TeamWhip.shape;
  // Build a shape carrying only known keys with valid types. Keys with
  // wrong types or unknown names are stripped; missing keys are filled
  // by Zod defaults at the parent parse.
  const filtered: Record<string, unknown> = {};
  if (rawWhip !== null && typeof rawWhip === "object" && !Array.isArray(rawWhip)) {
    const obj = rawWhip as Record<string, unknown>;
    for (const key of Object.keys(known)) {
      if (!(key in obj)) continue;
      const fieldSchema = (known as Record<string, z.ZodTypeAny>)[key];
      if (fieldSchema === undefined) continue;
      const result = fieldSchema.safeParse(obj[key]);
      if (result.success) filtered[key] = result.data;
      // type-mismatch fields: dropped → Zod default fills via TeamWhip.parse.
    }
  }
  // Parse through TeamWhip so defaults land for any missing keys.
  return TeamWhip.parse(filtered);
}

/**
 * Rebuild a parseable team.json shape from the raw input + Zod defaults.
 * Strips invalid `whip` sub-keys; applies whip defaults; preserves
 * top-level fields verbatim where they're parseable.
 *
 * If `raw` is missing required top-level fields (e.g. `members`), we
 * fall back to a minimal valid team shape carrying just `name`
 * (synthesized as `unknown-team` if absent).
 */
export function makeDriftSafeDefaults(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { name: "unknown-team", members: [], whip: TeamWhip.parse({}) };
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  if (typeof out.name !== "string" || out.name.length === 0) {
    out.name = "unknown-team";
  }
  if (!Array.isArray(out.members)) {
    out.members = [];
  }
  out.whip = safeDefaultsForWhip(obj.whip);
  return out;
}

// ---------- Dedup state ----------

/**
 * Decide whether to fire the drift ping. Returns `true` when:
 *   - the hash isn't in the dedup state file, OR
 *   - the recorded epoch is more than DRIFT_REFIRE_WINDOW_SEC ago.
 */
export async function shouldFireDriftPing(
  atmuxDir: string,
  driftHash: string,
  nowSec: number,
): Promise<boolean> {
  const path = whipConfigDriftStatePath(atmuxDir);
  const state = await tryReadJson(path, DriftStateSchema);
  if (state === null) return true;
  const lastFired = state[driftHash];
  if (lastFired === undefined) return true;
  return nowSec - lastFired >= DRIFT_REFIRE_WINDOW_SEC;
}

/** Record `driftHash → nowSec` in the dedup state file. Creates the
 *  file if absent. */
export async function recordDriftPing(
  atmuxDir: string,
  driftHash: string,
  nowSec: number,
): Promise<void> {
  const path = whipConfigDriftStatePath(atmuxDir);
  const existing = (await tryReadJson(path, DriftStateSchema)) ?? {};
  const next = { ...existing, [driftHash]: nowSec };
  await writeJson(path, DriftStateSchema, next);
}
