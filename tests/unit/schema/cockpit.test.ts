// ADR-132 §D6 / T5 (t-f3e9ac2a): unit tests for the cockpit-level
// `martinet` schema additions.
//
// Targets ONLY the new fields (`CockpitMartinet`, `Cockpit.defaultMartinet`,
// `Cockpit.martinet`) — the surrounding ADR-063 / ADR-077 / ADR-086
// surfaces (CockpitTeam, CockpitSuperdoctor, CockpitPulse) have their
// own coverage in tests/unit/core/cockpit.test.ts. Same layering as
// the existing TeamWhip / TeamFallback split in tests/unit/schema/-
// team.test.ts vs tests/unit/core/whip-config-drift.test.ts.

import { describe, expect, test } from "bun:test";
import {
  Cockpit,
  CockpitMartinet,
} from "../../../src/schema/cockpit.ts";

// ---------- CockpitMartinet — defaults + bounds ----------

describe("CockpitMartinet — defaults + bounds", () => {
  test("empty object parses to all defaults (W3 disabled by default)", () => {
    const m = CockpitMartinet.parse({});
    expect(m.enabled).toBe(false);
    expect(m.cursorBinPath).toBe("/usr/local/bin/cursor-agent");
    expect(m.model).toBe("composer-2-fast");
    expect(m.cageTier).toBe("tier-2");
    expect(m.claudeAccount).toBeUndefined();
  });

  test("model accepts 'composer-2-fast' and 'composer-2' only", () => {
    expect(CockpitMartinet.parse({ model: "composer-2-fast" }).model).toBe(
      "composer-2-fast",
    );
    expect(CockpitMartinet.parse({ model: "composer-2" }).model).toBe(
      "composer-2",
    );
  });

  test("model rejects arbitrary strings", () => {
    expect(() =>
      CockpitMartinet.parse({ model: "composer-2-slow" }),
    ).toThrow();
    expect(() => CockpitMartinet.parse({ model: "gpt-4" })).toThrow();
  });

  test("cageTier pinned to 'tier-2' (ADR-132 §D4)", () => {
    expect(CockpitMartinet.parse({ cageTier: "tier-2" }).cageTier).toBe(
      "tier-2",
    );
    // Future cage tiers need both ADR-132 enum bump AND new ADR
    // approving the Linux-user-isolated cage shape — fenced here.
    expect(() =>
      CockpitMartinet.parse({ cageTier: "tier-3" as unknown as "tier-2" }),
    ).toThrow();
    expect(() =>
      CockpitMartinet.parse({ cageTier: "tier-1" as unknown as "tier-2" }),
    ).toThrow();
  });

  test("claudeAccount accepts the existing CockpitClaudeAccount shape", () => {
    const m = CockpitMartinet.parse({
      claudeAccount: { configDir: "/root/.claude-unum", label: "unum" },
    });
    expect(m.claudeAccount?.configDir).toBe("/root/.claude-unum");
    expect(m.claudeAccount?.label).toBe("unum");
  });

  test("claudeAccount rejects empty configDir (re-used min(1) constraint)", () => {
    expect(() =>
      CockpitMartinet.parse({
        claudeAccount: { configDir: "", label: "x" },
      }),
    ).toThrow();
  });

  test("unknown keys rejected (.strict drift detection)", () => {
    expect(() =>
      CockpitMartinet.parse({ enbled: true }),
    ).toThrow();
    expect(() =>
      CockpitMartinet.parse({ cursorBin: "/usr/bin/cursor" }),
    ).toThrow();
  });
});

// ---------- Cockpit — top-level defaultMartinet + martinet integration ----------

describe("Cockpit — top-level defaultMartinet + martinet integration", () => {
  test("Cockpit accepts defaultMartinet + martinet block at top-level", () => {
    const c = Cockpit.parse({
      teams: [],
      defaultMartinet: "cursor",
      martinet: { enabled: true, model: "composer-2" },
    });
    expect(c.defaultMartinet).toBe("cursor");
    expect(c.martinet?.enabled).toBe(true);
    expect(c.martinet?.model).toBe("composer-2");
    expect(c.martinet?.cursorBinPath).toBe("/usr/local/bin/cursor-agent");
  });

  test("Cockpit without martinet fields parses (backward compat — defaults to undefined)", () => {
    const c = Cockpit.parse({ teams: [] });
    expect(c.defaultMartinet).toBeUndefined();
    expect(c.martinet).toBeUndefined();
  });

  test("Cockpit.defaultMartinet rejects dropped 'minimax' + 'kimi' values", () => {
    expect(() =>
      Cockpit.parse({
        teams: [],
        defaultMartinet: "minimax" as unknown as "cursor",
      }),
    ).toThrow();
    expect(() =>
      Cockpit.parse({
        teams: [],
        defaultMartinet: "kimi" as unknown as "claude",
      }),
    ).toThrow();
  });

  test("Cockpit.defaultMartinet accepts 'claude' (degenerate fallback)", () => {
    const c = Cockpit.parse({ teams: [], defaultMartinet: "claude" });
    expect(c.defaultMartinet).toBe("claude");
  });
});
