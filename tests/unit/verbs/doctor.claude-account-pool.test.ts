// Unit tests for the claudeAccountPool doctor probe (ADR-199 §D1 /
// §Impl-status deferred row):
//   - claudeAccountPoolRows()   — pure mapping ClaudeAccountPoolVerdict → DoctorRow[]
//   - checkClaudeAccountPool()  — wrapper that resolves cockpit pool +
//                                 budget probe staleness, then maps rows
//
// Sibling to tests/unit/verbs/doctor-host-pressure.test.ts — kept
// separate per the doctor-honker.test.ts precedent.

import { describe, expect, test } from "bun:test";
import type { BudgetProbeState } from "../../../src/core/account-pool.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import {
  type ClaudeAccountPoolVerdict,
  checkClaudeAccountPool,
  claudeAccountPoolRows,
} from "../../../src/verbs/doctor.ts";

describe("claudeAccountPoolRows (pure)", () => {
  test("empty pool + a team missing claudeAccount → RED with team names + hint", () => {
    const v: ClaudeAccountPoolVerdict = {
      poolSize: 0,
      freshLabels: [],
      staleLabels: [],
      teamsMissingAccount: ["alpha", "beta"],
    };
    const rows = claudeAccountPoolRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("claudeAccountPool");
    expect(rows[0]?.detail).toContain("pool empty");
    expect(rows[0]?.detail).toContain("alpha");
    expect(rows[0]?.detail).toContain("beta");
    expect(rows[0]?.hint).toContain("claudeAccountPool");
    expect(rows[0]?.hint).toContain("401");
  });

  test("empty pool but every team pins its own account → INFO (not red)", () => {
    const v: ClaudeAccountPoolVerdict = {
      poolSize: 0,
      freshLabels: [],
      staleLabels: [],
      teamsMissingAccount: [],
    };
    const rows = claudeAccountPoolRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.label).toBe("claudeAccountPool");
    expect(rows[0]?.detail).toContain("unconfigured");
    expect(rows[0]?.hint).toBeUndefined();
  });

  test("populated pool, all fresh → GREEN listing the labels", () => {
    const v: ClaudeAccountPoolVerdict = {
      poolSize: 2,
      freshLabels: ["personal", "ifca"],
      staleLabels: [],
      teamsMissingAccount: [],
    };
    const rows = claudeAccountPoolRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toContain("2 account(s)");
    expect(rows[0]?.detail).toContain("all fresh");
    expect(rows[0]?.detail).toContain("personal");
    expect(rows[0]?.detail).toContain("ifca");
    expect(rows[0]?.hint).toBeUndefined();
  });

  test("populated pool, some stale → YELLOW naming the stale labels + refresh hint", () => {
    const v: ClaudeAccountPoolVerdict = {
      poolSize: 3,
      freshLabels: ["personal"],
      staleLabels: ["ifca", "icloud"],
      teamsMissingAccount: [],
    };
    const rows = claudeAccountPoolRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("3 account(s)");
    expect(rows[0]?.detail).toContain("2 with stale/missing");
    expect(rows[0]?.detail).toContain("ifca");
    expect(rows[0]?.detail).toContain("icloud");
    // Fresh-only label must NOT appear in the stale list.
    expect(rows[0]?.detail).not.toContain("personal");
    expect(rows[0]?.hint).toContain("budget");
    expect(rows[0]?.hint).toContain("Stale-grace");
  });

  test("populated pool with a stale entry does NOT short-circuit to green", () => {
    // Guard against a "green if poolSize>0" lie: one stale label must
    // force yellow even when most are fresh.
    const v: ClaudeAccountPoolVerdict = {
      poolSize: 2,
      freshLabels: ["personal"],
      staleLabels: ["ifca"],
      teamsMissingAccount: [],
    };
    expect(claudeAccountPoolRows(v)[0]?.status).toBe("yellow");
  });
});

// ----- wrapper test scaffolding -----

function cockpitWith(opts: {
  pool?: { configDir: string; label: string; weight?: number }[];
  teams?: { name: string; root: string; claudeAccount?: { configDir: string } }[];
}): LoadedCockpit {
  return {
    schemaVersion: 1,
    cockpitSession: "atmux_cockpit",
    sessions: [],
    teams: (opts.teams ?? []) as LoadedCockpit["teams"],
    ...(opts.pool ? { claudeAccountPool: opts.pool } : {}),
  } as unknown as LoadedCockpit;
}

function freshProbe(probedAt: number): BudgetProbeState {
  return {
    h5_util: 0.1,
    wk_util: 0.2,
    h5_reset: probedAt + 3600,
    wk_reset: probedAt + 86400,
    status: "allowed",
    probedAt,
  };
}

describe("checkClaudeAccountPool (verb-side wrapper)", () => {
  const NOW = 1_900_000_000;

  test("no cockpit (loader returns null) + empty pool → INFO, no budget read", async () => {
    let budgetCalled = false;
    const rows = await checkClaudeAccountPool("/home/x", {
      loadCockpitFn: async () => null,
      loadBudgetMapFn: async () => {
        budgetCalled = true;
        return new Map();
      },
      nowSec: NOW,
    });
    expect(budgetCalled).toBe(false);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.label).toBe("claudeAccountPool");
  });

  test("empty pool + cockpit team missing claudeAccount → RED", async () => {
    const rows = await checkClaudeAccountPool("/home/x", {
      loadCockpitFn: async () =>
        cockpitWith({ teams: [{ name: "alpha", root: "/r/alpha" }] }),
      nowSec: NOW,
    });
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("alpha");
  });

  test("empty pool + every team pins claudeAccount → INFO (not red)", async () => {
    const rows = await checkClaudeAccountPool("/home/x", {
      loadCockpitFn: async () =>
        cockpitWith({
          teams: [{ name: "alpha", root: "/r/alpha", claudeAccount: { configDir: "/c/a" } }],
        }),
      nowSec: NOW,
    });
    expect(rows[0]?.status).toBe("info");
  });

  test("populated pool, all budget probes fresh → GREEN", async () => {
    const rows = await checkClaudeAccountPool("/home/x", {
      loadCockpitFn: async () =>
        cockpitWith({
          pool: [
            { configDir: "/c/p", label: "personal" },
            { configDir: "/c/i", label: "ifca" },
          ],
        }),
      loadBudgetMapFn: async (pool) => {
        // Every label has data probed 1 minute ago — well within grace.
        const m = new Map<string, BudgetProbeState | null>();
        for (const e of pool) m.set(e.label, freshProbe(NOW - 60));
        return m;
      },
      nowSec: NOW,
    });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toContain("personal");
    expect(rows[0]?.detail).toContain("ifca");
  });

  test("populated pool, one probe stale (probedAt past threshold) → YELLOW naming it", async () => {
    const rows = await checkClaudeAccountPool("/home/x", {
      loadCockpitFn: async () =>
        cockpitWith({
          pool: [
            { configDir: "/c/p", label: "personal" },
            { configDir: "/c/i", label: "ifca" },
          ],
        }),
      loadBudgetMapFn: async () => {
        const m = new Map<string, BudgetProbeState | null>();
        m.set("personal", freshProbe(NOW - 60)); // fresh
        m.set("ifca", freshProbe(NOW - 7200)); // 2h old → stale (>30min)
        return m;
      },
      nowSec: NOW,
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("ifca");
    expect(rows[0]?.detail).toContain("1 with stale/missing");
  });

  test("populated pool, a label with NO budget probe data → YELLOW (missing == stale)", async () => {
    const rows = await checkClaudeAccountPool("/home/x", {
      loadCockpitFn: async () =>
        cockpitWith({ pool: [{ configDir: "/c/p", label: "personal" }] }),
      loadBudgetMapFn: async () => {
        // Label maps to null — probe file absent.
        const m = new Map<string, BudgetProbeState | null>();
        m.set("personal", null);
        return m;
      },
      nowSec: NOW,
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("personal");
  });

  test("custom staleThresholdSec is honoured (tighter window flips fresh→stale)", async () => {
    const probe = freshProbe(NOW - 120); // 2 minutes old
    const make = (staleThresholdSec: number) =>
      checkClaudeAccountPool("/home/x", {
        loadCockpitFn: async () =>
          cockpitWith({ pool: [{ configDir: "/c/p", label: "personal" }] }),
        loadBudgetMapFn: async () => new Map([["personal", probe]]),
        nowSec: NOW,
        staleThresholdSec,
      });
    // 5min grace → fresh → green
    expect((await make(300))[0]?.status).toBe("green");
    // 60s grace → 2min-old probe is stale → yellow
    expect((await make(60))[0]?.status).toBe("yellow");
  });

  test("default loadCockpitFn (real loadCockpit) completes without throwing → single row", async () => {
    // No loadCockpitFn injected: exercises the default-arg branch. The
    // default tries the real loadCockpit() which throws ConfigError on an
    // absent ~/.atmux/cockpit.json; the wrapper must catch it (and any
    // schema error) and fall to the empty-pool path, NOT propagate.
    const rows = await checkClaudeAccountPool(undefined, { nowSec: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("claudeAccountPool");
    expect(["green", "yellow", "red", "info"]).toContain(rows[0]?.status ?? "<undef>");
  });
});
