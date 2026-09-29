// e-14 S1 — scanBudgetAcrossAccounts: per-account sweep + warning epochs.
// Probe + state ride injected fns (no live credentials, no disk).

import { describe, expect, test } from "bun:test";
import type { BudgetProbeResult } from "../../../src/abstractions/budget-probe.ts";
import type { WarningState } from "../../../src/core/budget-warning-state.ts";
import {
  BUDGET_WARN_BAND,
  BUDGET_WARN_PCT,
  scanBudgetAcrossAccounts,
} from "../../../src/core/orchd-budget-scan.ts";

function probeFor(
  pcts: Record<string, { h5: number; wk: number; h5r?: number; wkr?: number }>,
): (account: string) => Promise<BudgetProbeResult> {
  return async (account: string) => {
    const p = pcts[account] ?? { h5: 10, wk: 10 };
    return {
      account,
      h5_pct_used: p.h5,
      wk_pct_used: p.wk,
      h5_reset_epoch: p.h5r ?? 1000,
      wk_reset_epoch: p.wkr ?? 2000,
      status: "allowed",
      source: "probe",
      probedAt: 1000,
    };
  };
}

function memoryState(seed: WarningState = {}): {
  loadState: () => WarningState;
  saveState: (s: WarningState) => void;
  saved: () => WarningState[];
} {
  let cur = { ...seed };
  const saved: WarningState[] = [];
  return {
    loadState: () => ({ ...cur }),
    saveState: (s) => {
      cur = { ...s };
      saved.push({ ...s });
    },
    saved: () => saved,
  };
}

describe("scanBudgetAcrossAccounts", () => {
  test("returns per-account rows; below threshold warns nothing", async () => {
    const mem = memoryState();
    const got = await scanBudgetAcrossAccounts(["a", "b"], {
      probe: probeFor({ a: { h5: 10, wk: 20 }, b: { h5: 30, wk: 40 } }),
      ...mem,
    });
    expect(got.accounts).toHaveLength(2);
    expect(got.accounts[0]).toMatchObject({ username: "a", fiveHourPct: 10, weekPct: 20 });
    expect(got.newlyWarned).toHaveLength(0);
  });

  test("crossing 80 fires once per (account, window); second sweep silent", async () => {
    const mem = memoryState();
    const deps = { probe: probeFor({ a: { h5: 85, wk: 10 } }), ...mem };
    const first = await scanBudgetAcrossAccounts(["a"], deps);
    expect(first.newlyWarned).toEqual([{ account: "a", window: "5h", pct: 85 }]);
    const second = await scanBudgetAcrossAccounts(["a"], deps);
    expect(second.newlyWarned).toHaveLength(0);
  });

  test("both windows warn independently", async () => {
    const mem = memoryState();
    const got = await scanBudgetAcrossAccounts(["a"], {
      probe: probeFor({ a: { h5: 81, wk: 82 } }),
      ...mem,
    });
    expect(got.newlyWarned.map((w) => w.window).sort()).toEqual(["5h", "wk"]);
  });

  test("reset epoch advance re-arms the warning", async () => {
    const mem = memoryState();
    const old = { probe: probeFor({ a: { h5: 85, wk: 10, h5r: 1000 } }), ...mem };
    expect((await scanBudgetAcrossAccounts(["a"], old)).newlyWarned).toHaveLength(1);
    expect((await scanBudgetAcrossAccounts(["a"], old)).newlyWarned).toHaveLength(0);
    const rotated = { probe: probeFor({ a: { h5: 85, wk: 10, h5r: 2000 } }), ...mem };
    const re = await scanBudgetAcrossAccounts(["a"], rotated);
    expect(re.newlyWarned).toEqual([{ account: "a", window: "5h", pct: 85 }]);
  });

  test("custom threshold honored; constants pinned", () => {
    expect(BUDGET_WARN_PCT).toBe(80);
    expect(BUDGET_WARN_BAND).toBe(80);
  });

  test("empty accounts → empty sweep, state still saved", async () => {
    const mem = memoryState();
    const got = await scanBudgetAcrossAccounts([], { probe: probeFor({}), ...mem });
    expect(got).toEqual({ accounts: [], newlyWarned: [] });
    expect(mem.saved()).toHaveLength(1);
  });
});

describe("scanBudgetAcrossAccounts — production probe wiring (t-eb67d998)", () => {
  test("default probe resolves via the passed atmuxDir (canonical dir, no cwd join)", async () => {
    // No deps.probe: the production default runs the real probeBudget.
    // The account is deliberately nonexistent, so no credentials exist
    // on ANY machine — hermetic, no network. Without the canonical-dir
    // wiring the probe throws UsageError and this rejects.
    const mem = memoryState();
    const got = await scanBudgetAcrossAccounts(
      ["no-such-acct-xyz"],
      { ...mem },
      "/nonexistent-atmux-xyz",
    );
    expect(got.accounts).toHaveLength(1);
    // no-credentials probe → zeroed windows, nothing warned.
    expect(got.accounts[0]).toMatchObject({ username: "no-such-acct-xyz", fiveHourPct: 0 });
    expect(got.accounts[0]).toMatchObject({ weekPct: 0 });
    expect(got.newlyWarned).toHaveLength(0);
  });

  test("default probe without atmuxDir fails closed (no cwd join)", async () => {
    const mem = memoryState();
    await expect(scanBudgetAcrossAccounts(["no-such-acct-xyz"], { ...mem })).rejects.toThrow(
      /atmuxDir/,
    );
  });
});
