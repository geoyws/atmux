// ADR-053 §D2: budget-pause state primitives (ADR-169 P3: the `budget`
// table in `<atmuxDir>/state.db`, row `budget-pause`).
//
// Mirrors bash `lib/whip.sh::_atmux_whip_budget_pause_*` helpers. The
// pre-migration file lived at `<atmuxDir>/state/budget-pause.json`
// (bash-byte-identical shape so the bash runtime could read pause state
// during the transition window); readers promote a leftover file into
// the table on first read, writers are table-only, and clear removes
// both (see `core/budget-state-repo.ts`).
//
// Schema (the TEXT-blob `state`, bash-compatible):

import { join } from "node:path";
import {
  clearBudgetTextAtDb,
  readBudgetTextAtDb,
  writeBudgetTextAtDb,
} from "./budget-state-repo.ts";
import { stateDbPath } from "./common.ts";

/** Per-member at-risk record carried in the state file. */
export interface AtRiskMember {
  /** Member name (matches team.json::members[].name). */
  member: string;
  /** 5h utilization, 0–100 integer pct used (NOT remaining). */
  h5: number;
  /** 7d utilization, 0–100 integer pct used. */
  wk: number;
}

/** Full state-file shape per ADR-053 §D2 (bash-compatible). */
export interface BudgetPauseState {
  paused: true;
  /** Epoch seconds. */
  pausedAt: number;
  /** Pre-formatted `HH:MM MYT` timestamp from the firing tick. */
  pausedAtTs: string;
  /** Roster captured at pause-entry — used by the resume Discord ping. */
  atRisk: ReadonlyArray<AtRiskMember>;
}

const STATE_FILENAME = "budget-pause.json";

const BUDGET_PROBE = "budget-pause";

/** Resolve the legacy state-file path (pre-migration address; still the
 *  fallback address for pre-migration teams). */
export function budgetPauseStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/**
 * `observed_at` extractor for the budget row (ADR-169 §Decision):
 * `pausedAt` (epoch seconds) × 1000. Falls back to `fallbackMs` when
 * the text is unparseable or carries no finite `pausedAt`.
 */
export function budgetPauseObservedAtMs(text: string, fallbackMs: number): number {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const at = (parsed as Record<string, unknown>).pausedAt;
      if (typeof at === "number" && Number.isFinite(at)) return Math.floor(at * 1000);
    }
  } catch {
    // fall through to the fallback below
  }
  return fallbackMs;
}

/** Read state if present; returns null when absent OR malformed. The
 *  loose decode mirrors bash's `[[ -f ]] && jq` short-circuit — neither
 *  side throws on absence. Row-first: promotes a leftover legacy file
 *  into the budget table on first read. */
export async function loadBudgetPauseState(atmuxDir: string): Promise<BudgetPauseState | null> {
  const path = budgetPauseStatePath(atmuxDir);
  const txt = await readBudgetTextAtDb(
    stateDbPath(atmuxDir),
    BUDGET_PROBE,
    path,
    budgetPauseObservedAtMs,
  );
  if (txt === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch {
    return null; // corrupt state — treat as not paused; next tick rewrites if needed
  }
  if (!isPauseState(parsed)) return null;
  return parsed;
}

/** True iff a valid pause state is present and `paused === true`. */
export async function isBudgetPauseActive(atmuxDir: string): Promise<boolean> {
  const s = await loadBudgetPauseState(atmuxDir);
  return s !== null && s.paused === true;
}

/** Table-only write of a fresh pause state (observed_at = pausedAt). */
export async function writeBudgetPauseState(
  atmuxDir: string,
  state: BudgetPauseState,
): Promise<void> {
  await writeBudgetTextAtDb(
    stateDbPath(atmuxDir),
    BUDGET_PROBE,
    JSON.stringify(state),
    Math.floor(state.pausedAt * 1000),
  );
}

/** Table-only clear that also removes a leftover legacy file
 *  (idempotent — absence on both sides is fine). */
export async function clearBudgetPauseState(atmuxDir: string): Promise<void> {
  await clearBudgetTextAtDb(stateDbPath(atmuxDir), BUDGET_PROBE, budgetPauseStatePath(atmuxDir));
}

// ---------- Internal ----------

function isPauseState(v: unknown): v is BudgetPauseState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.paused !== true) return false;
  if (typeof o.pausedAt !== "number") return false;
  if (typeof o.pausedAtTs !== "string") return false;
  if (!Array.isArray(o.atRisk)) return false;
  for (const r of o.atRisk) {
    if (typeof r !== "object" || r === null) return false;
    const m = r as Record<string, unknown>;
    if (typeof m.member !== "string") return false;
    if (typeof m.h5 !== "number") return false;
    if (typeof m.wk !== "number") return false;
  }
  return true;
}
