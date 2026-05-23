// ADR-202 §Amendment 2026-05-22 (VIII) — running-number-with-hash ID
// generators.
//
// Format: `<scope>-<N>-<hash>` where:
//   - `<scope>` is `t` / `s` / `e` (task / story / epic)
//   - `<N>` is a per-team monotonic positive integer starting at 1
//   - `<hash>` is 8 hex chars random (same generator as legacy)
//
// Example: `e-1-3b017960`, `t-1203-a1b2c3d4`, `s-7-deadbeef`.
//
// Operator rationale (2026-05-22):
//
//   1. **Easier to remember.** "Epic 1 / Epic 1203" beats "Epic e-7a1014f9".
//      The running-number gives human recall + reads naturally in
//      reviews ("the 12th epic", "task 47 of 50").
//
//   2. **Easier to grep.** `grep e-1 logs/*.log` matches too many things
//      (every event-id starting with e-1...). `grep e-1-3b017960`
//      matches exactly the one ID. Best of both worlds: short for
//      humans, hash for tools.
//
// **Per-team scope.** Each team's state.db has its own counters. `e-1-X`
// in team A and `e-1-Y` in team B are distinct (different hash suffixes).
// Matches atmux's existing per-team isolation.
//
// **Backward compat.** Legacy hex-only IDs (`t-3b017960`, no running
// number) stay valid forever — kanban refs, ADR pointers, git branches
// all keep working. Lookups use string equality + partial-prefix match
// (see `matchesIdPrefix`).
//
// **Partial-prefix matching** (concern #8 from operator's /btw): user
// types `atmux task show t-1203` → resolves to the full `t-1203-X`
// ID via prefix match. Convenience for humans; full form is canonical
// for storage + logging.
//
// **Atomicity.** Counter increment via `INSERT ... ON CONFLICT DO
// UPDATE ... RETURNING` is a single statement under SQLite write lock.
// Concurrent processes get distinct sequential values.
//
// **Bootstrap.** Counter starts at 0; first nextId returns 1 (with
// fresh hash). No pre-seed; no schema-version coupling.

import { randomBytes } from "node:crypto";
import type { Database } from "../abstractions/sqlite.ts";

/** Single-character prefix discriminator for the sequence scope. */
export type IdScope = "t" | "s" | "e";

/**
 * Atomically allocate the next compound ID for `scope` in `db`.
 *
 * Returns `${scope}-${N}-${hash8}` — running number + 8-char hex hash.
 *
 * @param hashOverride — Test injection seam. Production callers omit
 *                       and get `randomBytes(4).toString("hex")`.
 */
export function nextId(db: Database, scope: IdScope, hashOverride?: () => string): string {
  const row = db
    .prepare(
      `INSERT INTO id_sequences (scope, last_id) VALUES (?, 1)
       ON CONFLICT(scope) DO UPDATE SET last_id = id_sequences.last_id + 1
       RETURNING last_id`,
    )
    .get(scope) as { last_id: number } | undefined;
  if (row === undefined) {
    throw new Error(`nextId(${scope}): SQLite RETURNING produced no row`);
  }
  const hash = hashOverride ? hashOverride() : randomBytes(4).toString("hex");
  return `${scope}-${row.last_id}-${hash}`;
}

/** Read the current counter without incrementing. Returns 0 when the
 *  scope has never been used. Useful for tests + observability. */
export function peekId(db: Database, scope: IdScope): number {
  const row = db
    .prepare("SELECT last_id FROM id_sequences WHERE scope = ?")
    .get(scope) as { last_id: number } | undefined;
  return row?.last_id ?? 0;
}

// ---------- Legacy-id → compound-id sequence assignment ----------

/**
 * Atomically allocate the next sequence number for `scope` and pair
 * it with the `legacyHex` ID's existing 8-char hash to produce a
 * compound `<scope>-<N>-<hash>` ID.
 *
 * The legacy ID's hash is PRESERVED in the compound form — `t-3b017960`
 * becomes `t-N-3b017960`. This is the building block for
 * `atmux migrate-hex-ids` (T4.1 / ADR-202 §XIII): the running number
 * gives humans recall, the preserved hash keeps every existing grep /
 * log / branch / ADR reference partially valid.
 *
 * Pure with respect to the sequence row (one atomic INSERT … ON
 * CONFLICT … RETURNING per call). Caller wraps the migration's
 * multi-row updates in a transaction; this helper is the per-row
 * primitive.
 *
 * @throws If `legacyHex` is not a `<scope>-<8 hex>` legacy ID — the
 *         caller is responsible for filtering before calling.
 */
export function assignSequenceToLegacyId(
  db: Database,
  scope: IdScope,
  legacyHex: string,
): { compoundId: string; sequenceN: number } {
  const expected = new RegExp(`^${scope}-([0-9a-f]{8})$`);
  const match = expected.exec(legacyHex);
  if (match === null) {
    throw new Error(
      `assignSequenceToLegacyId: '${legacyHex}' is not a legacy hex id for scope '${scope}'`,
    );
  }
  const hash = match[1];
  const row = db
    .prepare(
      `INSERT INTO id_sequences (scope, last_id) VALUES (?, 1)
       ON CONFLICT(scope) DO UPDATE SET last_id = id_sequences.last_id + 1
       RETURNING last_id`,
    )
    .get(scope) as { last_id: number } | undefined;
  if (row === undefined) {
    throw new Error(`assignSequenceToLegacyId(${scope}): SQLite RETURNING produced no row`);
  }
  return {
    compoundId: `${scope}-${row.last_id}-${hash}`,
    sequenceN: row.last_id,
  };
}

// ---------- Format detection ----------

/**
 * Compound format (current): `<scope>-<N>-<hash>` where N is a positive
 * integer and hash is 8 hex chars. Example: `e-1-3b017960`.
 */
export function isCompoundId(id: string): boolean {
  return /^[tse]-[1-9][0-9]*-[0-9a-f]{8}$/.test(id);
}

/**
 * Pure-sequence format (intermediate, deprecated): `<scope>-<N>`.
 * Briefly used between this amendment's pure-sequence draft and the
 * final compound shape. Accepted as input for backward compat with any
 * in-flight reference; never emitted.
 */
export function isSequenceId(id: string): boolean {
  return /^[tse]-[1-9][0-9]*$/.test(id);
}

/** Legacy hex format: `<scope>-<hash>` (8 hex chars, no running
 *  number). Pre-§VIII IDs. Stays valid forever via string equality. */
export function isHexId(id: string): boolean {
  return /^[tse]-[0-9a-f]{8}$/.test(id);
}

/** Detect any valid atmux ID shape — compound, sequence, or legacy hex. */
export function isAnyId(id: string): boolean {
  return isCompoundId(id) || isSequenceId(id) || isHexId(id);
}

// ---------- Prefix matching ----------

/**
 * Does `candidate` start with `query`? Used for partial-prefix lookup
 * (concern #8 from operator's /btw): `atmux task show t-1203` resolves
 * to `t-1203-X` via prefix match.
 *
 * Rules:
 *  - Empty query never matches.
 *  - Query must include the scope prefix (`t-` / `s-` / `e-`).
 *  - Exact equality is also a prefix match (trivially).
 *  - Hex-format candidates (no running number) require exact match —
 *    `t-3b01` against `t-3b017960` is ambiguous in legacy land so we
 *    refuse to partial-match hex IDs.
 *
 * Returns true on match. Caller resolves uniqueness (in case multiple
 * candidates share a prefix — shouldn't happen with per-team counters
 * but defensive).
 */
export function matchesIdPrefix(candidate: string, query: string): boolean {
  if (query.length === 0) return false;
  if (candidate === query) return true;
  // Hex-only legacy IDs: exact equality only (refused above already).
  if (isHexId(candidate) && !isCompoundId(candidate)) return false;
  // Compound IDs: prefix match against the `<scope>-<N>` or
  // `<scope>-<N>-` part. `t-12` against `t-12-abc` should match;
  // `t-1` against `t-12-abc` should NOT (would be ambiguous with t-1).
  if (isCompoundId(candidate)) {
    // Split into `t-N-hash`; allow query of forms `t-N`, `t-N-`,
    // or `t-N-<partial-hash>`. Note: query forms like `t` or `t-`
    // alone are too broad — reject to avoid false matches across
    // running numbers.
    const lastDashIdx = candidate.lastIndexOf("-");
    const prefixNoHash = candidate.slice(0, lastDashIdx); // `t-N`
    // Exact match on the `t-N` part (running number) is allowed.
    if (query === prefixNoHash) return true;
    // Allow `t-N-partial-hash` — full prefix of candidate AND query
    // already crosses the second dash (i.e. into the hash portion).
    // The second-dash threshold prevents `t-1` matching `t-12-abc`:
    // `t-1` has one dash, doesn't cross the second dash, so the
    // exact-prefixNoHash branch above handles it (or rejects).
    if (candidate.startsWith(query)) {
      const queryDashCount = (query.match(/-/g) ?? []).length;
      if (queryDashCount >= 2) return true; // into hash portion
      // queryDashCount === 1: query is `t-NNN<...>`; check digit
      // boundary to prevent `t-1` matching `t-12-abc`.
      const queryChar = query.charCodeAt(query.length - 1);
      const nextChar = candidate.charCodeAt(query.length);
      const queryIsDigit = queryChar >= 48 && queryChar <= 57;
      const nextIsDigit = nextChar >= 48 && nextChar <= 57;
      if (queryIsDigit && nextIsDigit) return false;
      return true;
    }
  }
  return false;
}
