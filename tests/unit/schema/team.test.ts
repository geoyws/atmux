// Unit tests for src/schema/team.ts (ADR-054 R1-T4).
//
// TeamWhip Zod schema — strict-mode rejection of unknown keys + applied
// defaults + ADR-053/055/056 field type validation.
//
// Sister tests covering the drift-fallback path and helpers live in
// tests/unit/core/whip-config-drift.test.ts (R1-T3 / R1-T4 share the
// suite). This file focuses on the schema in isolation per ADR-054 §D5
// "tests/unit/schema/team.test.ts (extend)".

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKTREE_ROOT,
  Team,
  TeamFallback,
  TeamWhip,
} from "../../../src/schema/team.ts";

// ---------- TeamWhip — valid + defaults ----------

describe("TeamWhip — valid shape + defaults", () => {
  test("empty object parses to all defaults", () => {
    const w = TeamWhip.parse({});
    expect(w.intervalMins).toBe(5);
    expect(w.staleMin).toBe(90);
    expect(w.leadMaxMin).toBe(60);
    expect(w.autoRotate).toBe(false);
    expect(w.budgetPauseThreshold).toBe(90);
    expect(w.budgetResumeThreshold).toBe(80);
    expect(w.budgetWarningBands).toEqual([0.5, 0.25, 0.15]);
    expect(w.budgetRefreshLeadMins).toBe(30);
    expect(w.autoStopAfterIdleTicks).toBe(0);
    expect(w.selfHealEnabled).toBe(false);
    expect(w.selfHealRecipes).toEqual([]);
    expect(w.accountFallback).toEqual([]);
    expect(w.accountSwapTriggerThreshold).toBe(75);
    // Bash-parity preservation fields.
    expect(w.downConfirmTicks).toBe(2);
    expect(w.heartbeat).toBe(true);
  });

  test("partial shape applies defaults for missing fields", () => {
    const w = TeamWhip.parse({ staleMin: 120, autoRotate: true });
    expect(w.staleMin).toBe(120);
    expect(w.autoRotate).toBe(true);
    expect(w.intervalMins).toBe(5); // default
    expect(w.budgetPauseThreshold).toBe(90); // default
  });

  test("claudeAccount accepts a string override", () => {
    const w = TeamWhip.parse({ claudeAccount: "c-i" });
    expect(w.claudeAccount).toBe("c-i");
  });

  test("selfHealRecipes accepts an arbitrary string array", () => {
    const w = TeamWhip.parse({ selfHealRecipes: ["fix:typecheck", "fix:lint"] });
    expect(w.selfHealRecipes).toEqual(["fix:typecheck", "fix:lint"]);
  });

  test("accountFallback accepts ordered fallback chain", () => {
    const w = TeamWhip.parse({ accountFallback: ["c-i", "c-u"] });
    expect(w.accountFallback).toEqual(["c-i", "c-u"]);
  });

  test("budgetWarningBands accepts custom bands", () => {
    const w = TeamWhip.parse({ budgetWarningBands: [0.9, 0.5, 0.1] });
    expect(w.budgetWarningBands).toEqual([0.9, 0.5, 0.1]);
  });
});

// ---------- TeamWhip — strict-mode rejection ----------

describe("TeamWhip — strict-mode rejects unknown keys", () => {
  test("unknown key at top-level rejects", () => {
    expect(() => TeamWhip.parse({ unknownKey: 1 })).toThrow();
  });

  test("typo on a known field rejects (.strict() rule rationale)", () => {
    // ADR-054 §D1: "passthrough at this level would mask typos
    // (e.g. whip.budgetPauseTreshold — note the typo — falls through
    // silently with passthrough; strict catches it)".
    expect(() => TeamWhip.parse({ budgetPauseTreshold: 90 })).toThrow();
  });
});

// ---------- TeamWhip — type/range validation ----------

describe("TeamWhip — type + range validation", () => {
  test("type mismatch on a numeric field rejects", () => {
    expect(() => TeamWhip.parse({ budgetPauseThreshold: "ninety" })).toThrow();
    expect(() => TeamWhip.parse({ leadMaxMin: "sixty" })).toThrow();
  });

  test("budgetPauseThreshold > 100 rejects", () => {
    expect(() => TeamWhip.parse({ budgetPauseThreshold: 101 })).toThrow();
  });

  test("budgetPauseThreshold < 0 rejects", () => {
    expect(() => TeamWhip.parse({ budgetPauseThreshold: -1 })).toThrow();
  });

  test("budgetWarningBands rejects values > 1", () => {
    expect(() => TeamWhip.parse({ budgetWarningBands: [1.5] })).toThrow();
  });

  test("budgetWarningBands rejects values < 0", () => {
    expect(() => TeamWhip.parse({ budgetWarningBands: [-0.1] })).toThrow();
  });

  test("intervalMins must be positive integer", () => {
    expect(() => TeamWhip.parse({ intervalMins: 0 })).toThrow();
    expect(() => TeamWhip.parse({ intervalMins: -1 })).toThrow();
    expect(() => TeamWhip.parse({ intervalMins: 1.5 })).toThrow();
  });

  test("autoStopAfterIdleTicks accepts 0 (default — disabled per R1)", () => {
    const w = TeamWhip.parse({ autoStopAfterIdleTicks: 0 });
    expect(w.autoStopAfterIdleTicks).toBe(0);
  });

  test("boolean fields reject non-booleans", () => {
    expect(() => TeamWhip.parse({ autoRotate: "yes" })).toThrow();
    expect(() => TeamWhip.parse({ selfHealEnabled: 1 })).toThrow();
  });
});

// ---------- Parent Team schema integration ----------

describe("Team schema integrates TeamWhip cleanly", () => {
  test("Team.parse with valid whip block applies whip defaults", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      whip: { staleMin: 60 },
    });
    expect(team.whip?.staleMin).toBe(60);
    expect(team.whip?.leadMaxMin).toBe(60); // default applied
    expect(team.whip?.budgetPauseThreshold).toBe(90); // default applied
  });

  test("Team.parse without whip block keeps whip undefined (.optional())", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.whip).toBeUndefined();
  });

  test("Team.parse rejects unknown key in whip sub-shape", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        whip: { unknownTypoKey: 1 },
      }),
    ).toThrow();
  });
});

// ---------- TeamFallback — ADR-058 multi-tier fallback chain ----------

describe("TeamFallback — valid shape + defaults", () => {
  test("empty input applies enabled=false default", () => {
    const f = TeamFallback.parse({});
    expect(f.enabled).toBe(false);
    expect(f.tierBudgetThresholds).toBeUndefined();
  });

  test("explicit enabled=true is honored", () => {
    const f = TeamFallback.parse({ enabled: true });
    expect(f.enabled).toBe(true);
  });

  test("tierBudgetThresholds optional sub-block accepts integer pcts", () => {
    const f = TeamFallback.parse({
      enabled: true,
      tierBudgetThresholds: { tier2Pct: 70, tier3Pct: 50 },
    });
    expect(f.tierBudgetThresholds?.tier2Pct).toBe(70);
    expect(f.tierBudgetThresholds?.tier3Pct).toBe(50);
  });

  test("tierBudgetThresholds rejects out-of-range pct", () => {
    expect(() =>
      TeamFallback.parse({ enabled: true, tierBudgetThresholds: { tier2Pct: 150 } }),
    ).toThrow();
  });

  test("strict-mode rejects typos at top level", () => {
    expect(() => TeamFallback.parse({ enabld: true })).toThrow();
  });

  test("strict-mode rejects typos inside tierBudgetThresholds", () => {
    expect(() =>
      TeamFallback.parse({
        enabled: true,
        tierBudgetThresholds: { tier99Pct: 50 },
      }),
    ).toThrow();
  });
});

describe("Team schema integrates TeamFallback cleanly", () => {
  test("Team.parse with valid fallback block applies enabled=false default", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      fallback: {},
    });
    expect(team.fallback?.enabled).toBe(false);
  });

  test("Team.parse without fallback block keeps fallback undefined", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.fallback).toBeUndefined();
  });

  test("Team.parse rejects unknown key in fallback sub-shape", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        fallback: { enabled: true, junk: "x" },
      }),
    ).toThrow();
  });
});

// ---------- driverSession — ADR-064 §5/§OQ5 dead-field drop ----------

describe("Team schema — driverSession (ADR-044 + ADR-064 §5)", () => {
  test("Team.parse with driverSession.tui parses cleanly (the only wired field)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: { tui: "shell" },
    });
    expect(team.driverSession).toEqual({ tui: "shell" });
  });

  test("Team.parse with driverSession=null is accepted (explicitly disabled)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      driverSession: null,
    });
    expect(team.driverSession).toBeNull();
  });

  test("Team.parse REJECTS dead `command` key (ADR-064 §5/§OQ5 — strict-mode drop)", () => {
    // `command` was on the schema in e624592 but never read by any
    // consumer. Per ADR-064 §OQ5 it's a clean cut, no deprecation
    // cycle — the strict() shape now rejects it. Any team.json still
    // setting it surfaces via [whip-config-drift] (ADR-054).
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        driverSession: { tui: "shell", command: "claude" },
      }),
    ).toThrow();
  });

  test("Team.parse rejects unknown key in driverSession sub-shape (general strict guard)", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        driverSession: { tui: "shell", typoField: "x" },
      }),
    ).toThrow();
  });
});

// ---------- worktreeIsolation / worktreeRoot — ADR-082 §2 ----------

describe("Team schema — worktreeIsolation + worktreeRoot (ADR-082 §2)", () => {
  test("legacy team.json (neither field present) parses with both fields undefined", () => {
    // Existing teams pick up the new fields on the next atmux start
    // schema-load with NO team.json migration. Both fields are
    // `.optional()` — read-sites apply the effective defaults
    // (`isolation === true` truthy check; root || DEFAULT_WORKTREE_ROOT)
    // so the schema output stays backwards-compatible with every
    // existing Team-literal in the codebase (`singleSession` pattern).
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.worktreeIsolation).toBeUndefined();
    expect(team.worktreeRoot).toBeUndefined();
  });

  test("explicit worktreeIsolation=true parses; root stays undefined → consumer uses DEFAULT_WORKTREE_ROOT", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      worktreeIsolation: true,
    });
    expect(team.worktreeIsolation).toBe(true);
    expect(team.worktreeRoot).toBeUndefined();
    expect(team.worktreeRoot ?? DEFAULT_WORKTREE_ROOT).toBe(".atmux/worktrees");
  });

  test("explicit worktreeRoot overrides the effective default", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      worktreeIsolation: true,
      worktreeRoot: ".worktrees-custom",
    });
    expect(team.worktreeIsolation).toBe(true);
    expect(team.worktreeRoot).toBe(".worktrees-custom");
  });

  test("explicit worktreeIsolation=false parses cleanly (matches default behaviour)", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      worktreeIsolation: false,
    });
    expect(team.worktreeIsolation).toBe(false);
  });

  test("non-boolean worktreeIsolation rejected (input-time type validation)", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        worktreeIsolation: "true" as unknown as boolean,
      }),
    ).toThrow();
  });

  test("non-string worktreeRoot rejected (input-time type validation)", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        worktreeRoot: 42 as unknown as string,
      }),
    ).toThrow();
  });

  test("DEFAULT_WORKTREE_ROOT exports the canonical relative path", () => {
    // Read-sites (W3 start / W4 stop / W5 doctor) import this constant
    // so the effective default has a single source of truth. Pin the
    // value so a rename in the schema file surfaces here.
    expect(DEFAULT_WORKTREE_ROOT).toBe(".atmux/worktrees");
  });
});
