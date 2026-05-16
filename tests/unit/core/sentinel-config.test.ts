// ADR-132 §D6 / T5 (t-f3e9ac2a): tests for the precedence resolver
// + override merge in src/core/sentinel-config.ts.
//
// Coverage matrix:
//   - Precedence: team > cockpit > hardcoded "claude"
//   - Override merge: explicit team-side fields win over per-impl
//     defaults; missing fields inherit
//   - Bounds: 0.0 and 1.0 inclusive for escalationConfidenceThreshold
//   - Type-only: function is pure (no I/O); no GitSpawn / fs / lock
//     stub required

import { describe, expect, test } from "bun:test";
import { resolveSentinel } from "../../../src/core/sentinel-config.ts";
import {
  DEFAULT_SENTINEL_CADENCE_SEC,
  DEFAULT_SENTINEL_ESCALATION_CONFIDENCE,
  Team,
} from "../../../src/schema/team.ts";
import { Cockpit } from "../../../src/schema/cockpit.ts";

// ---------- Precedence resolution ----------

describe("resolveSentinel — precedence: team > cockpit > hardcoded", () => {
  test("hardcoded 'claude' when both team + cockpit unset", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const r = resolveSentinel(team);
    expect(r.impl).toBe("claude");
  });

  test("hardcoded 'claude' when both team + cockpit explicitly omit field", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const cockpit = Cockpit.parse({ teams: [] });
    const r = resolveSentinel(team, cockpit);
    expect(r.impl).toBe("claude");
  });

  test("cockpit.defaultSentinel beats hardcoded when team unset", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const cockpit = Cockpit.parse({ teams: [], defaultSentinel: "cursor" });
    expect(resolveSentinel(team, cockpit).impl).toBe("cursor");
  });

  test("team.sentinel beats cockpit.defaultSentinel", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinel: "claude",
    });
    const cockpit = Cockpit.parse({ teams: [], defaultSentinel: "cursor" });
    // Team's explicit `claude` wins, even though cockpit recommends cursor.
    expect(resolveSentinel(team, cockpit).impl).toBe("claude");
  });

  test("team.sentinel beats hardcoded when cockpit unset", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinel: "cursor",
    });
    expect(resolveSentinel(team).impl).toBe("cursor");
  });

  test("undefined cockpit arg short-circuits to team > hardcoded", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinel: "cursor",
    });
    // Explicit-undefined second arg — `resolveSentinel` accepts both
    // omitted and explicit-undefined.
    expect(resolveSentinel(team, undefined).impl).toBe("cursor");
  });
});

// ---------- Override merge ----------

describe("resolveSentinel — overrides merge per-impl defaults", () => {
  test("no overrides → per-impl defaults applied", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const r = resolveSentinel(team);
    expect(r.cadenceSec).toBe(DEFAULT_SENTINEL_CADENCE_SEC);
    expect(r.escalationConfidenceThreshold).toBe(
      DEFAULT_SENTINEL_ESCALATION_CONFIDENCE,
    );
  });

  test("partial override merges over per-impl defaults", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinel: "cursor",
      sentinelOverrides: { cadenceSec: 180 },
    });
    const r = resolveSentinel(team);
    expect(r.cadenceSec).toBe(180);
    // Unspecified field inherits default — explicit > per-impl default.
    expect(r.escalationConfidenceThreshold).toBe(
      DEFAULT_SENTINEL_ESCALATION_CONFIDENCE,
    );
  });

  test("full override replaces both per-impl defaults", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinel: "cursor",
      sentinelOverrides: { cadenceSec: 90, escalationConfidenceThreshold: 0.9 },
    });
    const r = resolveSentinel(team);
    expect(r.cadenceSec).toBe(90);
    expect(r.escalationConfidenceThreshold).toBe(0.9);
  });

  test("escalationConfidenceThreshold=0 (boundary) honored — not falsy-coerced", () => {
    // The resolver uses ?? not || — `0` is a legitimate floor (always
    // escalate, never trust the impl). Pin the boundary.
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinelOverrides: { escalationConfidenceThreshold: 0 },
    });
    expect(resolveSentinel(team).escalationConfidenceThreshold).toBe(0);
  });

  test("escalationConfidenceThreshold=1 (boundary) honored", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      sentinelOverrides: { escalationConfidenceThreshold: 1 },
    });
    expect(resolveSentinel(team).escalationConfidenceThreshold).toBe(1);
  });

  test("overrides apply regardless of resolved impl (uniform v1 default)", () => {
    // Per ADR-132 §D3 both impls default to 270s at v1 — the merge is
    // by-field, so an override applies whether impl resolves to
    // claude or cursor.
    const teamClaude = Team.parse({
      name: "demo",
      members: [],
      sentinel: "claude",
      sentinelOverrides: { cadenceSec: 600 },
    });
    const teamCursor = Team.parse({
      name: "demo",
      members: [],
      sentinel: "cursor",
      sentinelOverrides: { cadenceSec: 600 },
    });
    expect(resolveSentinel(teamClaude).cadenceSec).toBe(600);
    expect(resolveSentinel(teamCursor).cadenceSec).toBe(600);
  });
});
