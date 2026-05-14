// ADR-132 §D6 / T5 (t-f3e9ac2a): tests for the precedence resolver
// + override merge in src/core/martinet-config.ts.
//
// Coverage matrix:
//   - Precedence: team > cockpit > hardcoded "claude"
//   - Override merge: explicit team-side fields win over per-impl
//     defaults; missing fields inherit
//   - Bounds: 0.0 and 1.0 inclusive for escalationConfidenceThreshold
//   - Type-only: function is pure (no I/O); no GitSpawn / fs / lock
//     stub required

import { describe, expect, test } from "bun:test";
import { resolveMartinet } from "../../../src/core/martinet-config.ts";
import {
  DEFAULT_MARTINET_CADENCE_SEC,
  DEFAULT_MARTINET_ESCALATION_CONFIDENCE,
  Team,
} from "../../../src/schema/team.ts";
import { Cockpit } from "../../../src/schema/cockpit.ts";

// ---------- Precedence resolution ----------

describe("resolveMartinet — precedence: team > cockpit > hardcoded", () => {
  test("hardcoded 'claude' when both team + cockpit unset", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const r = resolveMartinet(team);
    expect(r.impl).toBe("claude");
  });

  test("hardcoded 'claude' when both team + cockpit explicitly omit field", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const cockpit = Cockpit.parse({ teams: [] });
    const r = resolveMartinet(team, cockpit);
    expect(r.impl).toBe("claude");
  });

  test("cockpit.defaultMartinet beats hardcoded when team unset", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const cockpit = Cockpit.parse({ teams: [], defaultMartinet: "cursor" });
    expect(resolveMartinet(team, cockpit).impl).toBe("cursor");
  });

  test("team.martinet beats cockpit.defaultMartinet", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      martinet: "claude",
    });
    const cockpit = Cockpit.parse({ teams: [], defaultMartinet: "cursor" });
    // Team's explicit `claude` wins, even though cockpit recommends cursor.
    expect(resolveMartinet(team, cockpit).impl).toBe("claude");
  });

  test("team.martinet beats hardcoded when cockpit unset", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      martinet: "cursor",
    });
    expect(resolveMartinet(team).impl).toBe("cursor");
  });

  test("undefined cockpit arg short-circuits to team > hardcoded", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      martinet: "cursor",
    });
    // Explicit-undefined second arg — `resolveMartinet` accepts both
    // omitted and explicit-undefined.
    expect(resolveMartinet(team, undefined).impl).toBe("cursor");
  });
});

// ---------- Override merge ----------

describe("resolveMartinet — overrides merge per-impl defaults", () => {
  test("no overrides → per-impl defaults applied", () => {
    const team = Team.parse({ name: "demo", members: [] });
    const r = resolveMartinet(team);
    expect(r.cadenceSec).toBe(DEFAULT_MARTINET_CADENCE_SEC);
    expect(r.escalationConfidenceThreshold).toBe(
      DEFAULT_MARTINET_ESCALATION_CONFIDENCE,
    );
  });

  test("partial override merges over per-impl defaults", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      martinet: "cursor",
      martinetOverrides: { cadenceSec: 180 },
    });
    const r = resolveMartinet(team);
    expect(r.cadenceSec).toBe(180);
    // Unspecified field inherits default — explicit > per-impl default.
    expect(r.escalationConfidenceThreshold).toBe(
      DEFAULT_MARTINET_ESCALATION_CONFIDENCE,
    );
  });

  test("full override replaces both per-impl defaults", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      martinet: "cursor",
      martinetOverrides: { cadenceSec: 90, escalationConfidenceThreshold: 0.9 },
    });
    const r = resolveMartinet(team);
    expect(r.cadenceSec).toBe(90);
    expect(r.escalationConfidenceThreshold).toBe(0.9);
  });

  test("escalationConfidenceThreshold=0 (boundary) honored — not falsy-coerced", () => {
    // The resolver uses ?? not || — `0` is a legitimate floor (always
    // escalate, never trust the impl). Pin the boundary.
    const team = Team.parse({
      name: "demo",
      members: [],
      martinetOverrides: { escalationConfidenceThreshold: 0 },
    });
    expect(resolveMartinet(team).escalationConfidenceThreshold).toBe(0);
  });

  test("escalationConfidenceThreshold=1 (boundary) honored", () => {
    const team = Team.parse({
      name: "demo",
      members: [],
      martinetOverrides: { escalationConfidenceThreshold: 1 },
    });
    expect(resolveMartinet(team).escalationConfidenceThreshold).toBe(1);
  });

  test("overrides apply regardless of resolved impl (uniform v1 default)", () => {
    // Per ADR-132 §D3 both impls default to 270s at v1 — the merge is
    // by-field, so an override applies whether impl resolves to
    // claude or cursor.
    const teamClaude = Team.parse({
      name: "demo",
      members: [],
      martinet: "claude",
      martinetOverrides: { cadenceSec: 600 },
    });
    const teamCursor = Team.parse({
      name: "demo",
      members: [],
      martinet: "cursor",
      martinetOverrides: { cadenceSec: 600 },
    });
    expect(resolveMartinet(teamClaude).cadenceSec).toBe(600);
    expect(resolveMartinet(teamCursor).cadenceSec).toBe(600);
  });
});
