// e-14 S1 — per-account budget sweep for the orchd budget monitor.
//
// Thin wrapper over the whip-budget-check probe
// (`abstractions/budget-probe.ts::probeBudget`) plus the warning-epoch
// dedup in `core/budget-warning-state.ts`: one warning per
// (account, window) per reset cycle, so a saturated account does not
// re-fire every tick. Pure over injected IO; Discord emission + ticker
// wiring are deliberately OUT (owner decision on tick source — see
// e-14 epic note 2026-09-28).

import {
  type BudgetProbeResult,
  probeBudget as defaultProbeBudget,
} from "../abstractions/budget-probe.ts";
import {
  hasBandFired,
  loadWarningState,
  recordBandFire,
  type WarningState,
  wipeForResetWindow,
  writeWarningState,
} from "./budget-warning-state.ts";

/** Warn when either window utilization reaches this percent. */
export const BUDGET_WARN_PCT = 80;
/** Warning band number used in the warning-state keys for S1 warns. */
export const BUDGET_WARN_BAND = 80;

/** Per-account sweep row. */
export interface AccountBudget {
  username: string;
  fiveHourPct: number;
  weekPct: number;
  fiveHourReset: number;
  weekReset: number;
}

/** An account/window crossing newly warned this sweep. */
export interface BudgetWarning {
  account: string;
  window: "5h" | "wk";
  pct: number;
}

/** Injected IO (tests inject fns; production passes atmuxDir). */
export interface BudgetScanDeps {
  probe?: (account: string) => Promise<BudgetProbeResult>;
  loadState?: () => WarningState | Promise<WarningState>;
  saveState?: (state: WarningState) => void | Promise<void>;
  warnAtPct?: number;
}

/** One sweep result. */
export interface BudgetScan {
  accounts: AccountBudget[];
  newlyWarned: BudgetWarning[];
}

/**
 * Sweep accounts, return per-account utilization plus the warnings
 * that newly fired this sweep (crossed threshold AND band not fired
 * in the current reset cycle). Fired bands are recorded; reset epochs
 * that advanced wipe the stale cycle first. State persists via the
 * injected load/save (production: warning-state file under atmuxDir).
 */
export async function scanBudgetAcrossAccounts(
  accounts: ReadonlyArray<string>,
  deps: BudgetScanDeps = {},
  atmuxDir?: string,
): Promise<BudgetScan> {
  // t-eb67d998: the production probe resolves via the canonical dir
  // (never a cwd join). When the caller passes no atmuxDir, the probe
  // fails closed with UsageError instead of probing the wrong project.
  const probe =
    deps.probe ??
    ((account: string) =>
      defaultProbeBudget(account, { ...(atmuxDir !== undefined ? { atmuxDir } : {}) }));
  const threshold = deps.warnAtPct ?? BUDGET_WARN_PCT;
  const loadState =
    deps.loadState ?? (() => (atmuxDir !== undefined ? loadWarningState(atmuxDir) : {}));
  const saveState =
    deps.saveState ??
    ((s) => (atmuxDir !== undefined ? writeWarningState(atmuxDir, s) : undefined));
  const rows: AccountBudget[] = [];
  for (const username of accounts) {
    const r = await probe(username);
    rows.push({
      username,
      fiveHourPct: r.h5_pct_used,
      weekPct: r.wk_pct_used,
      fiveHourReset: r.h5_reset_epoch,
      weekReset: r.wk_reset_epoch,
    });
  }

  let state = await loadState();
  const newlyWarned: BudgetWarning[] = [];
  for (const row of rows) {
    const windows = [
      { window: "5h", pct: row.fiveHourPct, reset: row.fiveHourReset },
      { window: "wk", pct: row.weekPct, reset: row.weekReset },
    ] as const;
    for (const w of windows) {
      if (w.pct < threshold) continue;
      state = wipeForResetWindow(state, row.username, w.window, w.reset);
      if (hasBandFired(state, row.username, w.window, BUDGET_WARN_BAND)) continue;
      state = recordBandFire(
        state,
        row.username,
        w.window,
        BUDGET_WARN_BAND,
        Math.floor(Date.now() / 1000),
      );
      newlyWarned.push({ account: row.username, window: w.window, pct: w.pct });
    }
  }
  await saveState(state);
  return { accounts: rows, newlyWarned };
}
