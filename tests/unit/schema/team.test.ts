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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG,
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_CADENCE_THRESHOLDS,
  DEFAULT_LANE_TICK_CRON_MINS,
  DEFAULT_SENTINEL_CADENCE_SEC,
  DEFAULT_SENTINEL_ESCALATION_CONFIDENCE,
  DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS,
  DEFAULT_REFUSAL_DETECTION_CONFIG,
  DEFAULT_WORKTREE_ROOT,
  resolveRefusalConfig,
  SentinelImpl,
  Team,
  TeamAutoEmitTrunkMerge,
  TeamCadence,
  TeamCadenceThresholds,
  TeamCrons,
  TeamEpic,
  TeamFallback,
  TeamSentinelOverrides,
  TeamMember,
  TeamOmbudsman,
  TeamRefusalDetection,
  TeamWhip,
} from "../../../src/schema/team.ts";

// ---------- TeamWhip — valid + defaults ----------

describe("TeamWhip — valid shape + defaults", () => {
  test("empty object parses to all defaults", () => {
    const w = TeamWhip.parse({});
    // intervalMins default raised from 5 → 15 on 2026-05-13 per
    // t-dcbff97c §4: auto-drain teams only need the lead awake ~4×/hr,
    // and the prior 5min cadence amplified the whip rate-limit footprint
    // without commensurate benefit. Schema doc-comment is the SoT.
    expect(w.intervalMins).toBe(15);
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
    expect(w.intervalMins).toBe(15); // default (2026-05-13 bump per t-dcbff97c)
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

// ---------- TeamMember.label (ADR-136 TR2) ----------

describe("TeamMember — label field (ADR-136 Option B)", () => {
  test("missing label parses successfully — backward compat with existing team.json", () => {
    const m = TeamMember.parse({ name: "up-impl" });
    expect(m.name).toBe("up-impl");
    expect(m.label).toBeUndefined();
  });

  test("plain ASCII label parses successfully", () => {
    const m = TeamMember.parse({ name: "up-impl", label: "My Custom Display" });
    expect(m.label).toBe("My Custom Display");
  });

  test("label with ':' rejected — tmux separator", () => {
    expect(() => TeamMember.parse({ name: "up-impl", label: "name:with:colon" })).toThrow();
  });

  test("label with '.' rejected — tmux separator", () => {
    expect(() => TeamMember.parse({ name: "up-impl", label: "name.with.dot" })).toThrow();
  });

  test("unicode + emoji label parses successfully — freeform allowed", () => {
    const m = TeamMember.parse({ name: "up-impl", label: "🎨 freeform unicode" });
    expect(m.label).toBe("🎨 freeform unicode");
  });
});

// ---------- ADR-159 TR3: TeamMember.role gitter → committer shim ----------

describe("TeamMember — role gitter→committer accept-both shim (ADR-159 TR3)", () => {
  test("legacy `role: \"gitter\"` value coerces to canonical `\"committer\"` on parse", () => {
    const m = TeamMember.parse({ name: "g", role: "gitter" });
    expect(m.role).toBe("committer");
  });

  test("canonical `role: \"committer\"` parses unchanged (idempotent)", () => {
    const m = TeamMember.parse({ name: "c", role: "committer" });
    expect(m.role).toBe("committer");
  });

  test("other role values pass through unchanged (open-string shim — does NOT tighten enum)", () => {
    // Current rosters use a wide variety of roles (docs / devops / dba /
    // unblocker / discorder). Closing the enum here would break them;
    // the shim coerces ONLY the gitter→committer value, leaves
    // everything else alone.
    for (const role of ["team-lead", "planner", "reviewer", "ombudsman", "docs", "devops", "dba", "unblocker", "discorder", "member", "lead"]) {
      const m = TeamMember.parse({ name: "x", role });
      expect(m.role).toBe(role);
    }
  });

  test("missing role parses successfully (optional field) — backward compat", () => {
    const m = TeamMember.parse({ name: "no-role" });
    expect(m.role).toBeUndefined();
  });
});

// ---------- ADR-132 §D6: SentinelImpl + TeamSentinelOverrides ----------

describe("SentinelImpl — 2026-05-14 two-impl enum", () => {
  test("accepts 'claude' and 'cursor' literals", () => {
    expect(SentinelImpl.parse("claude")).toBe("claude");
    expect(SentinelImpl.parse("cursor")).toBe("cursor");
  });

  test("rejects dropped backends 'minimax' and 'kimi'", () => {
    // Per the 2026-05-14 12:53 MYT driver simplification: MiniMax +
    // Kimi were dropped pre-implementation ("unreliable and not
    // smart enough"). The schema is the canonical fence — re-
    // introducing either requires both this enum AND the
    // `Sentinel["name"]` literal in src/abstractions/sentinel.ts
    // to be updated in lockstep.
    expect(() => SentinelImpl.parse("minimax")).toThrow();
    expect(() => SentinelImpl.parse("kimi")).toThrow();
  });

  test("rejects arbitrary strings", () => {
    expect(() => SentinelImpl.parse("gpt5")).toThrow();
    expect(() => SentinelImpl.parse("")).toThrow();
    expect(() => SentinelImpl.parse("CLAUDE")).toThrow(); // case-sensitive
  });
});

describe("TeamSentinelOverrides — defaults + bounds", () => {
  test("empty object parses cleanly — both fields are opt-in", () => {
    const o = TeamSentinelOverrides.parse({});
    expect(o.cadenceSec).toBeUndefined();
    expect(o.escalationConfidenceThreshold).toBeUndefined();
  });

  test("cadenceSec accepts positive integers", () => {
    const o = TeamSentinelOverrides.parse({ cadenceSec: 300 });
    expect(o.cadenceSec).toBe(300);
  });

  test("cadenceSec rejects zero / negatives / non-integers", () => {
    expect(() => TeamSentinelOverrides.parse({ cadenceSec: 0 })).toThrow();
    expect(() => TeamSentinelOverrides.parse({ cadenceSec: -30 })).toThrow();
    expect(() => TeamSentinelOverrides.parse({ cadenceSec: 1.5 })).toThrow();
  });

  test("escalationConfidenceThreshold accepts 0.0-1.0 bounds inclusive", () => {
    expect(
      TeamSentinelOverrides.parse({ escalationConfidenceThreshold: 0 })
        .escalationConfidenceThreshold,
    ).toBe(0);
    expect(
      TeamSentinelOverrides.parse({ escalationConfidenceThreshold: 1 })
        .escalationConfidenceThreshold,
    ).toBe(1);
    expect(
      TeamSentinelOverrides.parse({ escalationConfidenceThreshold: 0.7 })
        .escalationConfidenceThreshold,
    ).toBe(0.7);
  });

  test("escalationConfidenceThreshold rejects out-of-range values", () => {
    expect(() =>
      TeamSentinelOverrides.parse({ escalationConfidenceThreshold: -0.01 }),
    ).toThrow();
    expect(() =>
      TeamSentinelOverrides.parse({ escalationConfidenceThreshold: 1.01 }),
    ).toThrow();
  });

  test("unknown keys rejected (.strict drift detection)", () => {
    expect(() =>
      TeamSentinelOverrides.parse({ cadenceSecondz: 270 }),
    ).toThrow();
  });

  test("Team accepts sentinel + sentinelOverrides at top-level", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinel: "cursor",
      sentinelOverrides: { cadenceSec: 180, escalationConfidenceThreshold: 0.8 },
    });
    expect(team.sentinel).toBe("cursor");
    expect(team.sentinelOverrides?.cadenceSec).toBe(180);
    expect(team.sentinelOverrides?.escalationConfidenceThreshold).toBe(0.8);
  });

  test("Team without sentinel field parses (backward compat — defaults to undefined)", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.sentinel).toBeUndefined();
    expect(team.sentinelOverrides).toBeUndefined();
  });

  test("Team.sentinel rejects dropped 'minimax' value at the top-level too", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        sentinel: "minimax" as unknown as SentinelImpl,
      }),
    ).toThrow();
  });
});

describe("Sentinel per-impl default constants", () => {
  test("DEFAULT_SENTINEL_CADENCE_SEC is 270s (ADR-132 §D3)", () => {
    // Both shipping impls (claude + cursor) default to 270s — pin
    // the constant so a drift here surfaces in the resolver test
    // alongside this one.
    expect(DEFAULT_SENTINEL_CADENCE_SEC).toBe(270);
  });

  test("DEFAULT_SENTINEL_ESCALATION_CONFIDENCE is 0.7 (ADR-132 §D5 E5)", () => {
    expect(DEFAULT_SENTINEL_ESCALATION_CONFIDENCE).toBe(0.7);
  });
});

// ---------- ADR-147 T4: TeamOmbudsman ----------

describe("TeamOmbudsman — valid shape + defaults (ADR-147 §D1/§D2)", () => {
  test("empty object parses to enabled=false default; tickIntervalMins stays undefined", () => {
    // Empty block ≡ disabled — operators opt in explicitly via
    // `enabled: true`. Matches sibling pattern (TeamMerger,
    // TeamFallback). `tickIntervalMins` left undefined so call sites
    // apply DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS at read-time (mirrors
    // the `worktreeRoot` resolver pattern — schema default would shadow
    // a future ADR-driven bump of the constant).
    const o = TeamOmbudsman.parse({});
    expect(o.enabled).toBe(false);
    expect(o.tickIntervalMins).toBeUndefined();
  });

  test("explicit enabled=true is honored", () => {
    const o = TeamOmbudsman.parse({ enabled: true });
    expect(o.enabled).toBe(true);
  });

  test("tickIntervalMins accepts positive integer", () => {
    const o = TeamOmbudsman.parse({ enabled: true, tickIntervalMins: 30 });
    expect(o.tickIntervalMins).toBe(30);
  });
});

describe("TeamOmbudsman — strict-mode + type validation", () => {
  test("unknown key rejected (.strict drift detection)", () => {
    // ADR-054 §D3 precedent — typos like `enabld` / `tickIntervalMin`
    // (singular) surface here rather than silently falling through.
    expect(() => TeamOmbudsman.parse({ enabld: true })).toThrow();
    expect(() =>
      TeamOmbudsman.parse({ enabled: true, tickIntervalMin: 15 }),
    ).toThrow();
  });

  test("enabled rejects non-boolean", () => {
    expect(() => TeamOmbudsman.parse({ enabled: "yes" })).toThrow();
    expect(() => TeamOmbudsman.parse({ enabled: 1 })).toThrow();
  });

  test("tickIntervalMins rejects zero / negatives / non-integers", () => {
    expect(() =>
      TeamOmbudsman.parse({ enabled: true, tickIntervalMins: 0 }),
    ).toThrow();
    expect(() =>
      TeamOmbudsman.parse({ enabled: true, tickIntervalMins: -5 }),
    ).toThrow();
    expect(() =>
      TeamOmbudsman.parse({ enabled: true, tickIntervalMins: 1.5 }),
    ).toThrow();
  });

  test("tickIntervalMins rejects non-number type", () => {
    expect(() =>
      TeamOmbudsman.parse({ enabled: true, tickIntervalMins: "15" }),
    ).toThrow();
  });
});

describe("Team schema integrates TeamOmbudsman cleanly (ADR-147 §D1)", () => {
  test("Team.parse with valid ombudsman block applies enabled=false default", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      ombudsman: {},
    });
    expect(team.ombudsman?.enabled).toBe(false);
    expect(team.ombudsman?.tickIntervalMins).toBeUndefined();
  });

  test("Team.parse without ombudsman block keeps ombudsman undefined (.optional)", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.ombudsman).toBeUndefined();
  });

  test("Team.parse with ombudsman.enabled=true + custom interval round-trips", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      ombudsman: { enabled: true, tickIntervalMins: 5 },
    });
    expect(team.ombudsman?.enabled).toBe(true);
    expect(team.ombudsman?.tickIntervalMins).toBe(5);
  });

  test("Team.parse rejects unknown key in ombudsman sub-shape", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        ombudsman: { enabled: true, junk: "x" },
      }),
    ).toThrow();
  });

  test("Team.parse with member role=ombudsman parses cleanly (roster + config independent)", () => {
    // The cron line is gated on BOTH conditions (per ADR-147 §D2 brief);
    // the schema models them independently — a member with
    // role=ombudsman can exist without the `ombudsman` block (cron line
    // inert) and the block can exist without a member (cron line inert).
    // Both shapes parse — gating is enforced by the cron renderer.
    const team = Team.parse({
      name: "demo",
      members: [{ name: "ombudsman", role: "ombudsman" }],
    });
    expect(team.members[0]?.role).toBe("ombudsman");
    expect(team.ombudsman).toBeUndefined();
  });
});

describe("DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS constant (ADR-147 §D2)", () => {
  test("default is 15 minutes per ADR-147 §D2", () => {
    // Pin the constant — the cron renderer + tick verb read this
    // directly (mirrors DEFAULT_WORKTREE_ROOT / DEFAULT_MERGER_STALENESS_HOURS
    // precedent). A drift here is intentional — bump in lockstep with
    // the ADR §D2 default narrative.
    expect(DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS).toBe(15);
  });
});

// ---------- TeamCadence — ADR-148 §D7 ----------

describe("TeamCadenceThresholds — valid + defaults (ADR-148 §D2)", () => {
  test("empty object parses cleanly — all fields optional", () => {
    const t = TeamCadenceThresholds.parse({});
    expect(t.shippingMaxAgeSec).toBeUndefined();
    expect(t.idleMaxAgeSec).toBeUndefined();
    expect(t.dormantMaxAgeSec).toBeUndefined();
    expect(t.shipZeroWindowSec).toBeUndefined();
  });

  test("explicit values round-trip", () => {
    const t = TeamCadenceThresholds.parse({
      shippingMaxAgeSec: 600,
      idleMaxAgeSec: 3600,
      dormantMaxAgeSec: 14400,
      shipZeroWindowSec: 7200,
    });
    expect(t.shippingMaxAgeSec).toBe(600);
    expect(t.idleMaxAgeSec).toBe(3600);
    expect(t.dormantMaxAgeSec).toBe(14400);
    expect(t.shipZeroWindowSec).toBe(7200);
  });

  test("strict-mode rejects unknown keys (drift detection — ADR-054 §D3)", () => {
    expect(() =>
      TeamCadenceThresholds.parse({
        shippingMaxAgeSec: 1800,
        shippingMaxAgesSec: 1800, // typo with trailing 's'
      }),
    ).toThrow();
  });

  test("negative thresholds rejected (must be positive integer)", () => {
    expect(() => TeamCadenceThresholds.parse({ shippingMaxAgeSec: -10 })).toThrow();
    expect(() => TeamCadenceThresholds.parse({ idleMaxAgeSec: 0 })).toThrow();
  });

  test("non-integer values rejected", () => {
    expect(() => TeamCadenceThresholds.parse({ shippingMaxAgeSec: 1.5 })).toThrow();
  });
});

describe("TeamCadence — valid + defaults (ADR-148 §D7)", () => {
  test("empty object parses cleanly", () => {
    const c = TeamCadence.parse({});
    expect(c.enabled).toBeUndefined();
    expect(c.windowSec).toBeUndefined();
    expect(c.thresholds).toBeUndefined();
    expect(c.laneStallEnabled).toBeUndefined();
    expect(c.exemptMembers).toBeUndefined();
  });

  test("full block round-trips", () => {
    const c = TeamCadence.parse({
      enabled: true,
      windowSec: 1800,
      thresholds: {
        shippingMaxAgeSec: 1800,
        idleMaxAgeSec: 7200,
        dormantMaxAgeSec: 21600,
        shipZeroWindowSec: 7200,
      },
      laneStallEnabled: true,
      laneStallMinAgeSec: 1800,
      exemptMembers: ["planner", "reviewer"],
    });
    expect(c.enabled).toBe(true);
    expect(c.windowSec).toBe(1800);
    expect(c.thresholds?.dormantMaxAgeSec).toBe(21600);
    expect(c.exemptMembers).toEqual(["planner", "reviewer"]);
  });

  test("partial block (only windowSec) parses with others undefined", () => {
    const c = TeamCadence.parse({ windowSec: 600 });
    expect(c.windowSec).toBe(600);
    expect(c.enabled).toBeUndefined();
  });

  test("strict-mode rejects unknown top-level keys", () => {
    expect(() => TeamCadence.parse({ enabledd: true })).toThrow();
  });

  test("negative laneStallMinAgeSec rejected", () => {
    expect(() => TeamCadence.parse({ laneStallMinAgeSec: -1 })).toThrow();
    expect(() => TeamCadence.parse({ windowSec: 0 })).toThrow();
  });

  test("exemptMembers accepts empty array (default-equivalent)", () => {
    const c = TeamCadence.parse({ exemptMembers: [] });
    expect(c.exemptMembers).toEqual([]);
  });
});

describe("Team schema integrates TeamCadence cleanly (ADR-148 §D7)", () => {
  test("Team.parse accepts a `cadence` block", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      cadence: { enabled: true, windowSec: 900 },
    });
    expect(team.cadence?.enabled).toBe(true);
    expect(team.cadence?.windowSec).toBe(900);
  });

  test("Team.parse without `cadence` block leaves field undefined", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.cadence).toBeUndefined();
  });

  test("nested invalid threshold rejects through Team.parse", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        cadence: { thresholds: { shippingMaxAgeSec: -1 } },
      }),
    ).toThrow();
  });
});

// ---------- TeamAutoEmitTrunkMerge — ADR-146 §D7 ----------

describe("TeamAutoEmitTrunkMerge — valid + defaults (ADR-146 §D7)", () => {
  test("empty block parses — all fields optional", () => {
    const c = TeamAutoEmitTrunkMerge.parse({});
    expect(c.enabled).toBeUndefined();
    expect(c.fallbackAssignee).toBeUndefined();
    expect(c.shortCircuitOnSharedBase).toBeUndefined();
  });

  test("full block round-trips", () => {
    const c = TeamAutoEmitTrunkMerge.parse({
      enabled: true,
      fallbackAssignee: "manual-merger",
      shortCircuitOnSharedBase: false,
    });
    expect(c.enabled).toBe(true);
    expect(c.fallbackAssignee).toBe("manual-merger");
    expect(c.shortCircuitOnSharedBase).toBe(false);
  });

  test("fallbackAssignee accepts null (explicit unassigned)", () => {
    const c = TeamAutoEmitTrunkMerge.parse({ fallbackAssignee: null });
    expect(c.fallbackAssignee).toBeNull();
  });

  test("strict-mode rejects unknown keys (drift detection — ADR-054 §D3)", () => {
    expect(() =>
      TeamAutoEmitTrunkMerge.parse({
        enabled: true,
        enabld: true, // typo
      }),
    ).toThrow();
  });

  test("non-boolean enabled rejected", () => {
    expect(() => TeamAutoEmitTrunkMerge.parse({ enabled: "yes" })).toThrow();
  });
});

describe("Team schema integrates TeamAutoEmitTrunkMerge cleanly (ADR-146 §D7)", () => {
  test("Team.parse accepts an `autoEmitTrunkMerge` block", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      autoEmitTrunkMerge: { enabled: true },
    });
    expect(team.autoEmitTrunkMerge?.enabled).toBe(true);
  });

  test("Team.parse without `autoEmitTrunkMerge` block leaves field undefined", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.autoEmitTrunkMerge).toBeUndefined();
  });

  test("nested invalid value (typo) rejects through Team.parse", () => {
    expect(() =>
      Team.parse({
        name: "demo",
        members: [],
        autoEmitTrunkMerge: { enableddd: true },
      }),
    ).toThrow();
  });
});

describe("DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG constant (ADR-146 §D7)", () => {
  test("constants match ADR-146 §D7 defaults", () => {
    expect(DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG.enabled).toBe(true);
    expect(DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG.fallbackAssignee).toBeNull();
    expect(DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG.shortCircuitOnSharedBase).toBe(true);
  });
});

describe("DEFAULT_CADENCE_THRESHOLDS / DEFAULT_CADENCE_CONFIG constants (ADR-148 §D7)", () => {
  test("threshold defaults match ADR-148 §D7 table", () => {
    expect(DEFAULT_CADENCE_THRESHOLDS.shippingMaxAgeSec).toBe(1800);
    expect(DEFAULT_CADENCE_THRESHOLDS.idleMaxAgeSec).toBe(7200);
    expect(DEFAULT_CADENCE_THRESHOLDS.dormantMaxAgeSec).toBe(21600);
    expect(DEFAULT_CADENCE_THRESHOLDS.shipZeroWindowSec).toBe(7200);
  });

  test("config defaults match ADR-148 §D7 narrative (cadence enabled by default)", () => {
    expect(DEFAULT_CADENCE_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CADENCE_CONFIG.windowSec).toBe(1800);
    expect(DEFAULT_CADENCE_CONFIG.laneStallEnabled).toBe(true);
    expect(DEFAULT_CADENCE_CONFIG.laneStallMinAgeSec).toBe(1800);
    expect(DEFAULT_CADENCE_CONFIG.exemptMembers).toEqual([]);
  });
});

// ---------- TeamEpic — ADR-090 §Schema ----------

describe("TeamEpic — ADR-090 §Schema valid shape + defaults", () => {
  test("auto-mode happy path: required fields + mergeMode defaults to 'auto'", () => {
    const e = TeamEpic.parse({
      parent: "sopx-geoyws",
      parentEpicKanbanId: "e-1a2b3c4d",
      parentBase: "sopx-geoyws",
    });
    expect(e.parent).toBe("sopx-geoyws");
    expect(e.parentEpicKanbanId).toBe("e-1a2b3c4d");
    expect(e.parentBase).toBe("sopx-geoyws");
    // §Decision-anchor #6: default to "auto"; "pr" is schema-accept-runtime-noop.
    expect(e.mergeMode).toBe("auto");
    expect(e.prTarget).toBeUndefined();
    expect(e.prAuthorUser).toBeUndefined();
  });

  test("pr-mode shape with full prTarget + prAuthorUser parses cleanly", () => {
    const e = TeamEpic.parse({
      parent: "sopx-geoyws",
      parentEpicKanbanId: "e-1a2b3c4d",
      parentBase: "sopx-geoyws",
      mergeMode: "pr",
      prTarget: { remote: "origin", base: "main" },
      prAuthorUser: "geoyws",
    });
    expect(e.mergeMode).toBe("pr");
    expect(e.prTarget).toEqual({ remote: "origin", base: "main" });
    expect(e.prAuthorUser).toBe("geoyws");
  });

  test("prTarget.remote defaults to 'origin' when omitted", () => {
    const e = TeamEpic.parse({
      parent: "p",
      parentEpicKanbanId: "e-x",
      parentBase: "main",
      mergeMode: "pr",
      prTarget: { base: "main" },
      prAuthorUser: "geoyws",
    });
    // §Decision-anchor #8: remote has a default; base does not.
    expect(e.prTarget?.remote).toBe("origin");
    expect(e.prTarget?.base).toBe("main");
  });

  test("required string fields refuse empty + missing", () => {
    expect(() => TeamEpic.parse({})).toThrow();
    expect(() =>
      TeamEpic.parse({ parent: "", parentEpicKanbanId: "e-1", parentBase: "main" }),
    ).toThrow();
    expect(() =>
      TeamEpic.parse({ parent: "p", parentEpicKanbanId: "", parentBase: "main" }),
    ).toThrow();
    expect(() =>
      TeamEpic.parse({ parent: "p", parentEpicKanbanId: "e-1", parentBase: "" }),
    ).toThrow();
  });

  test("mergeMode rejects values outside the enum", () => {
    expect(() =>
      TeamEpic.parse({
        parent: "p",
        parentEpicKanbanId: "e-1",
        parentBase: "main",
        mergeMode: "manual",
      }),
    ).toThrow();
  });

  test("strict mode rejects unknown keys (drift surface)", () => {
    expect(() =>
      TeamEpic.parse({
        parent: "p",
        parentEpicKanbanId: "e-1",
        parentBase: "main",
        // typo: should be `prAuthorUser`. Strict rejects the unknown key
        // rather than silently dropping it. Mirrors `whip` precedent.
        prAuthroUser: "geoyws",
      }),
    ).toThrow();
  });

  test("prTarget is strict — rejects unknown keys inside the sub-object", () => {
    expect(() =>
      TeamEpic.parse({
        parent: "p",
        parentEpicKanbanId: "e-1",
        parentBase: "main",
        mergeMode: "pr",
        prTarget: { remote: "origin", base: "main", branch: "main" }, // unknown `branch` key
        prAuthorUser: "geoyws",
      }),
    ).toThrow();
  });
});

// ---------- Team — ADR-090 cross-field superRefine ----------

describe("Team superRefine — ADR-090 cross-field gates", () => {
  test("auto-mode epic-team without worktreeIsolation parses cleanly", () => {
    const team = Team.parse({
      name: "checkout-flow",
      members: [
        { name: "lead", role: "lead", tui: "claude" },
        { name: "be-1", role: "member", lane: "be", tui: "claude" },
      ],
      epicTeam: {
        parent: "sopx-geoyws",
        parentEpicKanbanId: "e-1a2b3c4d",
        parentBase: "sopx-geoyws",
      },
    });
    expect(team.epicTeam?.parent).toBe("sopx-geoyws");
    expect(team.epicTeam?.mergeMode).toBe("auto");
    expect(team.worktreeIsolation).toBeUndefined();
  });

  test("§Decision-anchor #3: epicTeam + worktreeIsolation=true refuses (HARD CONFLICT with ADR-084)", () => {
    expect(() =>
      Team.parse({
        name: "checkout-flow",
        members: [{ name: "lead", role: "lead" }],
        worktreeIsolation: true,
        epicTeam: {
          parent: "sopx-geoyws",
          parentEpicKanbanId: "e-1a2b3c4d",
          parentBase: "sopx-geoyws",
        },
      }),
    ).toThrow(/Decision-anchor #3|HARD CONFLICT/i);
  });

  test("§Decision-anchor #3: epicTeam with worktreeIsolation=false is allowed", () => {
    const team = Team.parse({
      name: "checkout-flow",
      members: [{ name: "lead", role: "lead" }],
      worktreeIsolation: false,
      epicTeam: {
        parent: "sopx-geoyws",
        parentEpicKanbanId: "e-1a2b3c4d",
        parentBase: "sopx-geoyws",
      },
    });
    expect(team.worktreeIsolation).toBe(false);
    expect(team.epicTeam).toBeDefined();
  });

  test("§Decision-anchor #8: pr-mode without prTarget.base refuses", () => {
    expect(() =>
      Team.parse({
        name: "checkout-flow",
        members: [{ name: "lead", role: "lead" }],
        epicTeam: {
          parent: "p",
          parentEpicKanbanId: "e-1",
          parentBase: "main",
          mergeMode: "pr",
          prAuthorUser: "geoyws",
        },
      }),
    ).toThrow(/Decision-anchor #8|prTarget\.base/i);
  });

  test("§Decision-anchor #9: pr-mode without prAuthorUser refuses", () => {
    expect(() =>
      Team.parse({
        name: "checkout-flow",
        members: [{ name: "lead", role: "lead" }],
        epicTeam: {
          parent: "p",
          parentEpicKanbanId: "e-1",
          parentBase: "main",
          mergeMode: "pr",
          prTarget: { base: "main" },
        },
      }),
    ).toThrow(/Decision-anchor #9|prAuthorUser/i);
  });

  test("normal team (no epicTeam, with worktreeIsolation=true) keeps parsing — additive change", () => {
    // Existing teams MUST NOT break. epicTeam is absent → all three
    // refinements early-exit on the `!== undefined` guard.
    const team = Team.parse({
      name: "atmux",
      worktreeIsolation: true,
      members: [{ name: "lead", role: "lead" }],
    });
    expect(team.worktreeIsolation).toBe(true);
    expect(team.epicTeam).toBeUndefined();
  });

  test("normal team with no epicTeam, no worktreeIsolation — baseline parses", () => {
    const team = Team.parse({
      name: "atmux",
      members: [{ name: "lead", role: "lead" }],
    });
    expect(team.epicTeam).toBeUndefined();
    expect(team.worktreeIsolation).toBeUndefined();
  });
});

// ---------- templates/epic-rosters/default.json — ADR-090 §Roster preset ----------

describe("templates/epic-rosters/default.json — ADR-090 §Roster preset", () => {
  /** Resolve the on-disk roster relative to repo root.
   *  Test file: tests/unit/schema/team.test.ts → ../../.. → repo root. */
  const rosterPath = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "templates",
    "epic-rosters",
    "default.json",
  );

  test("file parses as JSON without error", () => {
    const raw = readFileSync(rosterPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("ADR-090 §Roster preset: seven members in the required role+lane shape", () => {
    const raw = readFileSync(rosterPath, "utf-8");
    const parsed = JSON.parse(raw) as { members?: unknown };
    expect(Array.isArray(parsed.members)).toBe(true);
    // Each member entry passes TeamMember validation.
    const members = (parsed.members as unknown[]).map((m) => TeamMember.parse(m));
    // ADR-090: lead + planner + reviewer + 2 fe + 2 be.
    expect(members).toHaveLength(7);
    const roles = members.map((m) => m.role);
    expect(roles).toEqual(["lead", "planner", "reviewer", "member", "member", "member", "member"]);
    // fe / be lanes split 2+2.
    const lanes = members.map((m) => m.lane);
    expect(lanes).toEqual([undefined, undefined, undefined, "fe", "fe", "be", "be"]);
    // Every member ships with tui=claude (Opus-all-the-way per CLAUDE.md
    // §Model Selection).
    for (const m of members) {
      expect(m.tui).toBe("claude");
    }
  });

  test("roster member shape composes into a synthesised Team that passes ADR-090 cross-field gates", () => {
    // Simulates spawn-epic's synth pass: roster.members[] + an epicTeam
    // block + worktreeIsolation:false → loadTeam must accept.
    const raw = readFileSync(rosterPath, "utf-8");
    const parsed = JSON.parse(raw) as { members: unknown[] };
    const team = Team.parse({
      name: "checkout-flow",
      members: parsed.members,
      worktreeIsolation: false,
      worktreeInitSubmodules: true,
      epicTeam: {
        parent: "sopx-geoyws",
        parentEpicKanbanId: "e-1a2b3c4d",
        parentBase: "sopx-geoyws",
      },
    });
    expect(team.members).toHaveLength(7);
    expect(team.epicTeam?.parent).toBe("sopx-geoyws");
    expect(team.worktreeIsolation).toBe(false);
    expect(team.worktreeInitSubmodules).toBe(true);
  });
});

// ---------- ADR-157 §D6: TeamCrons.laneTickMins ----------

describe("TeamCrons.laneTickMins (ADR-157 §D6)", () => {
  test("default value is 5 (T5 relaxed from pre-T5 default of 2)", () => {
    const parsed = TeamCrons.parse({});
    expect(parsed.laneTickMins).toBe(5);
    expect(DEFAULT_LANE_TICK_CRON_MINS).toBe(5);
  });

  test("explicit value 10 accepted (within ceiling)", () => {
    const parsed = TeamCrons.parse({ laneTickMins: 10 });
    expect(parsed.laneTickMins).toBe(10);
  });

  test("explicit value 2 accepted (backward-compat / opt into pre-T5 cadence)", () => {
    const parsed = TeamCrons.parse({ laneTickMins: 2 });
    expect(parsed.laneTickMins).toBe(2);
  });

  test("non-divisor of 60 REJECTED — 7 fails refinement", () => {
    expect(() => TeamCrons.parse({ laneTickMins: 7 })).toThrow(/divisor of 60/);
  });

  test("non-divisor of 60 REJECTED — 8 fails refinement", () => {
    expect(() => TeamCrons.parse({ laneTickMins: 8 })).toThrow(/divisor of 60/);
  });

  test("zero / negative REJECTED — must be positive int", () => {
    expect(() => TeamCrons.parse({ laneTickMins: 0 })).toThrow();
    expect(() => TeamCrons.parse({ laneTickMins: -5 })).toThrow();
  });

  test("non-integer REJECTED", () => {
    expect(() => TeamCrons.parse({ laneTickMins: 5.5 })).toThrow();
  });

  test("Team.parse with crons.laneTickMins=10 round-trips cleanly", () => {
    const parsed = Team.parse({
      name: "demo",
      members: [],
      crons: { laneTickMins: 10 },
    });
    expect(parsed.crons?.laneTickMins).toBe(10);
  });
});

// ---------- TeamRefusalDetection — ADR-139 §Config ----------

describe("TeamRefusalDetection — valid + defaults (ADR-139 §Config)", () => {
  test("empty block parses — every field optional", () => {
    const c = TeamRefusalDetection.parse({});
    expect(c.enabled).toBeUndefined();
    expect(c.softThreshold).toBeUndefined();
    expect(c.hardThreshold).toBeUndefined();
    expect(c.roleThreshold).toBeUndefined();
    expect(c.windowMin).toBeUndefined();
    expect(c.exemptMembers).toBeUndefined();
    expect(c.maxRotationsPerDay).toBeUndefined();
  });

  test("full block round-trips", () => {
    const c = TeamRefusalDetection.parse({
      enabled: true,
      softThreshold: 5,
      hardThreshold: 3,
      roleThreshold: 1,
      windowMin: 45,
      exemptMembers: ["planner", "reviewer"],
      maxRotationsPerDay: 5,
    });
    expect(c.softThreshold).toBe(5);
    expect(c.hardThreshold).toBe(3);
    expect(c.windowMin).toBe(45);
    expect(c.exemptMembers).toEqual(["planner", "reviewer"]);
    expect(c.maxRotationsPerDay).toBe(5);
  });

  test("strict-mode rejects unknown top-level keys (ADR-054 §D3 drift detection)", () => {
    expect(() =>
      TeamRefusalDetection.parse({ enabled: true, softTreshold: 3 }),
    ).toThrow();
  });

  test("zero/negative thresholds rejected", () => {
    expect(() => TeamRefusalDetection.parse({ softThreshold: 0 })).toThrow();
    expect(() => TeamRefusalDetection.parse({ hardThreshold: -1 })).toThrow();
    expect(() => TeamRefusalDetection.parse({ windowMin: 0 })).toThrow();
    expect(() => TeamRefusalDetection.parse({ maxRotationsPerDay: 0 })).toThrow();
  });

  test("exemptMembers accepts empty array", () => {
    const c = TeamRefusalDetection.parse({ exemptMembers: [] });
    expect(c.exemptMembers).toEqual([]);
  });
});

describe("DEFAULT_REFUSAL_DETECTION_CONFIG constant (ADR-139 §Config)", () => {
  test("defaults mirror ADR-139 §D3 threshold table verbatim", () => {
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.enabled).toBe(true);
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.softThreshold).toBe(3);
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.hardThreshold).toBe(2);
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.roleThreshold).toBe(1);
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.windowMin).toBe(30);
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.exemptMembers).toEqual([]);
    // OQ-2 resolved-default: 3 rotations/day max per member.
    expect(DEFAULT_REFUSAL_DETECTION_CONFIG.maxRotationsPerDay).toBe(3);
  });
});

describe("resolveRefusalConfig — defaults applier", () => {
  test("undefined block resolves to full defaults", () => {
    const c = resolveRefusalConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.softThreshold).toBe(3);
    expect(c.maxRotationsPerDay).toBe(3);
  });

  test("partial block fills missing fields from defaults", () => {
    const c = resolveRefusalConfig({ softThreshold: 7 });
    expect(c.softThreshold).toBe(7);
    expect(c.hardThreshold).toBe(2);
    expect(c.windowMin).toBe(30);
  });

  test("explicit enabled=false survives resolution", () => {
    const c = resolveRefusalConfig({ enabled: false });
    expect(c.enabled).toBe(false);
  });

  test("explicit exemptMembers list survives resolution", () => {
    const c = resolveRefusalConfig({ exemptMembers: ["planner"] });
    expect(c.exemptMembers).toEqual(["planner"]);
  });
});

describe("Team schema integrates TeamRefusalDetection cleanly (ADR-139 §Config)", () => {
  test("Team.parse accepts a `refusalDetection` block", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      refusalDetection: { enabled: true, softThreshold: 4 },
    });
    expect(team.refusalDetection?.enabled).toBe(true);
    expect(team.refusalDetection?.softThreshold).toBe(4);
  });

  test("Team.parse without `refusalDetection` leaves field undefined (back-compat)", () => {
    const team = Team.parse({ name: "demo", members: [] });
    expect(team.refusalDetection).toBeUndefined();
  });
});
