// ADR-199 — Claude account pool for epic-team spawning.
//
// Resolves the manual jq-patch + restart dance after every spawn-epic
// (memory `feedback_spawn_epic_claude_account_inheritance_gap`) by
// drawing `team.claudeAccount` from a least-loaded pool at spawn-time.
//
// **Minimal slice shipped 2026-05-22:**
//   - Pool schema + read helpers
//   - selectAccount() pure function — least-loaded by 5h budget %
//   - spawn-epic integration (when team.claudeAccount unset + pool
//     configured, populate from the selector)
//
// **Deferred to follow-up Tasks on EPIC e-7471f008:**
//   - CLI verbs (atmux cockpit account-pool add/remove/list)
//   - Honker subscription to budget.warning / budget.recovered
//   - Cron-backstop 5min poll
//   - Doctor probe row
//
// The minimal slice fills the spawn-epic gap; the deferred items are
// optimizations + ergonomics that don't block the migration.
//
// Reads budget probe state from `~/.atmux/state/budget-probe-<label>.json`
// per the existing budget skill convention. Selection picks the entry
// with the lowest `h5_util` (5-hour utilization fraction). Ties broken
// by `weight` (default 1.0) and finally by pool-array order.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import type { ClaudeAccountPoolEntry } from "../schema/cockpit.ts";

/** Shape of `~/.atmux/state/budget-probe-<label>.json` per the existing
 *  budget skill output. Mirrored here without a schema import so the
 *  account-pool module stays decoupled from the budget skill layout. */
export interface BudgetProbeState {
  /** 5-hour rolling window utilization, 0..1. */
  h5_util: number;
  /** Weekly window utilization, 0..1. */
  wk_util: number;
  /** Unix epoch seconds when h5 resets. */
  h5_reset: number;
  /** Unix epoch seconds when weekly resets. */
  wk_reset: number;
  /** `allowed` | `throttled` | etc. — exact enum unspecified, treated
   *  as opaque except `allowed` which is the green path. */
  status: string;
  /** Unix epoch seconds when probe last ran. */
  probedAt: number;
}

/** Default stale-grace for budget probe data. Entries with `probedAt`
 *  older than this threshold are treated as unknown utilization
 *  (selector falls back to weight + array order). 30 minutes. */
export const DEFAULT_STALE_THRESHOLD_SEC = 30 * 60;

/** Verdict shape returned by {@link selectAccount}. */
export interface SelectAccountResult {
  /** Selected pool entry, or `null` when no entry is selectable. */
  account: ClaudeAccountPoolEntry | null;
  /** Why this entry was chosen (or why nothing was). Operator-readable. */
  reason: string;
}

/** Dependencies for the pure selector. */
export interface SelectAccountDeps {
  /** Pool entries — caller resolves from cockpit.json::claudeAccountPool[]
   *  or team.json::epicSpawnPool[] override. Empty array → returns
   *  `{account: null, reason: "pool empty"}`. */
  pool: readonly ClaudeAccountPoolEntry[];
  /** Per-label budget probe state. Missing labels are treated as
   *  "no data" (selector still considers the entry but its priority
   *  drops to weight + order). */
  budgetByLabel: Map<string, BudgetProbeState | null>;
  /** Current epoch seconds for staleness check. Defaults to `Date.now() / 1000`. */
  now?: number;
  /** Stale threshold in seconds. Defaults to {@link DEFAULT_STALE_THRESHOLD_SEC}. */
  staleThresholdSec?: number;
}

interface ScoredEntry {
  entry: ClaudeAccountPoolEntry;
  /** Effective h5 utilization. `null` when data is stale/missing. */
  h5Util: number | null;
  /** Effective weight. */
  weight: number;
  /** Position in original pool array — final tie-breaker. */
  index: number;
  /** `true` when budget probe says `throttled` (or any non-allowed status).
   *  Throttled entries are last-resort: only selected when nothing else
   *  is available. */
  throttled: boolean;
}

/**
 * Pick the least-loaded account from the pool.
 *
 * Selection ladder:
 *   1. Exclude entries with `status: throttled` UNLESS all entries are throttled.
 *   2. Among the eligible set, prefer lower `h5_util` (most headroom).
 *   3. On tie, prefer higher `weight`.
 *   4. On further tie, preserve pool-array order.
 *
 * Stale / missing budget data is treated as h5_util=null and sorts
 * AFTER all entries with fresh data (so the selector prefers fresh
 * probes; stale entries are a "we don't know — try the others first"
 * fallback). When ALL entries are stale, the selector falls back to
 * weight + order.
 */
export function selectAccount(deps: SelectAccountDeps): SelectAccountResult {
  if (deps.pool.length === 0) {
    return { account: null, reason: "pool empty" };
  }
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const staleThreshold = deps.staleThresholdSec ?? DEFAULT_STALE_THRESHOLD_SEC;

  const scored: ScoredEntry[] = deps.pool.map((entry, index) => {
    const state = deps.budgetByLabel.get(entry.label) ?? null;
    const stale = state === null || now - state.probedAt > staleThreshold;
    return {
      entry,
      h5Util: stale ? null : state.h5_util,
      weight: entry.weight ?? 1.0,
      index,
      throttled: state !== null && state.status !== "allowed",
    };
  });

  // Tier 1: throttled exclusion — only excludes when at least one entry
  // is NOT throttled (otherwise we'd return null + force a spawn refusal
  // when at least one throttled entry can be tried).
  const anyHealthy = scored.some((s) => !s.throttled);
  const eligible = anyHealthy ? scored.filter((s) => !s.throttled) : scored;

  if (eligible.length === 0) {
    // Theoretically unreachable (pool.length > 0 guard above + always
    // at least one in `scored`), but type-narrow safely.
    return { account: null, reason: "pool empty after throttled exclusion" };
  }

  // Sort: fresh-data-first, then by h5_util ASC, then by weight DESC,
  // then by index ASC.
  eligible.sort((a, b) => {
    // Fresh data wins over stale (h5Util !== null).
    const aFresh = a.h5Util !== null;
    const bFresh = b.h5Util !== null;
    if (aFresh !== bFresh) return aFresh ? -1 : 1;
    // Both fresh OR both stale.
    if (aFresh && bFresh) {
      // Both have h5Util — lower wins.
      if (a.h5Util !== b.h5Util) return (a.h5Util ?? 0) - (b.h5Util ?? 0);
    }
    // Tie on h5Util — higher weight wins.
    if (a.weight !== b.weight) return b.weight - a.weight;
    // Final: pool-array order.
    return a.index - b.index;
  });

  const winner = eligible[0]!;
  const reason = buildReason(winner, anyHealthy, scored.length);
  return { account: winner.entry, reason };
}

function buildReason(winner: ScoredEntry, anyHealthy: boolean, total: number): string {
  if (!anyHealthy) {
    return `all ${total} entries throttled; chose '${winner.entry.label}' as least-bad`;
  }
  if (winner.h5Util === null) {
    return `chose '${winner.entry.label}' (stale/missing budget data; fell back to weight + order)`;
  }
  return `chose '${winner.entry.label}' (h5 util ${(winner.h5Util * 100).toFixed(1)}%)`;
}

/** Read a single budget probe state file. Returns `null` when the file
 *  is absent or unreadable — caller treats that as "no data". */
export async function readBudgetProbe(
  label: string,
  homeDir: string,
): Promise<BudgetProbeState | null> {
  const path = join(homeDir, ".atmux", "state", `budget-probe-${label}.json`);
  if (!(await exists(path))) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "h5_util" in parsed &&
      "probedAt" in parsed &&
      "status" in parsed
    ) {
      // Shape check above is intentionally loose — budget skill schema
      // may add fields; we only require the ones the selector reads.
      return parsed as BudgetProbeState;
    }
    return null;
  } catch {
    return null;
  }
}

/** Collect budget probe state for every label in the pool. Returns a
 *  Map keyed by label; missing labels map to `null`. */
export async function loadBudgetMap(
  pool: readonly ClaudeAccountPoolEntry[],
  homeDir: string,
): Promise<Map<string, BudgetProbeState | null>> {
  const m = new Map<string, BudgetProbeState | null>();
  await Promise.all(
    pool.map(async (entry) => {
      m.set(entry.label, await readBudgetProbe(entry.label, homeDir));
    }),
  );
  return m;
}
