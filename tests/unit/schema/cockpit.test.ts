// Unit tests for src/schema/cockpit.ts — ADR-089 recursive sessions[]
// schema (replaces ADR-063 flat teams[]) AND ADR-132 §D6 martinet block.
// Covers:
//   - discriminatedUnion across team / epic-team / superdriver / superdoctor
//   - .strict() leaf rejection of unknown keys
//   - .strict() rejection of unknown `type` discriminator values
//   - recursive nesting via z.lazy
//   - schemaVersion default + cockpitSession default + prefixChain pass-through
//   - legacy back-compat fields (`teams`, `superdoctor`) accepted as optional
//     so the loader's enrichment pass round-trips them
//   - ADR-132 §D6 (t-f3e9ac2a) CockpitMartinet defaults + bounds + top-level
//     defaultMartinet / martinet integration
//
// Migration-shim + DFS-walk + flattener tests live in
// tests/unit/core/cockpit.test.ts.

import { describe, expect, test } from "bun:test";
import {
  Cockpit,
  CockpitMartinet,
  CockpitMedic,
  CockpitSession,
  CockpitSuperdoctor,
  EpicTeamSession,
  SuperdoctorSession,
  SuperdriverSession,
  TeamSession,
} from "../../../src/schema/cockpit.ts";

// ---------- Leaf schemas — discriminated union members ----------

describe("TeamSession — leaf shape", () => {
  test("parses a minimal team entry with default sessions[] + enabled", () => {
    const t = TeamSession.parse({ type: "team", name: "sopx", root: "/p/sopx" });
    expect(t.type).toBe("team");
    expect(t.name).toBe("sopx");
    expect(t.root).toBe("/p/sopx");
    expect(t.enabled).toBe(true);
    expect(t.sessions).toEqual([]);
  });
  test("rejects empty name (min(1))", () => {
    expect(() => TeamSession.parse({ type: "team", name: "", root: "/p" })).toThrow();
  });
  test("rejects empty root (min(1))", () => {
    expect(() => TeamSession.parse({ type: "team", name: "x", root: "" })).toThrow();
  });
  test("rejects unknown leaf keys (.strict)", () => {
    expect(() =>
      TeamSession.parse({ type: "team", name: "x", root: "/p", typo: "fail" }),
    ).toThrow();
  });
  // t-72a6b7d7 / c-a99bf461 — cageMode operator-intent flag.
  test("t-72a6b7d7: cageMode accepts 'autonomous' / 'direct' / 'paused' literals", () => {
    for (const mode of ["autonomous", "direct", "paused"] as const) {
      const t = TeamSession.parse({ type: "team", name: "x", root: "/p", cageMode: mode });
      expect(t.cageMode).toBe(mode);
    }
  });
  test("t-72a6b7d7: cageMode is optional (legacy configs without it parse cleanly)", () => {
    const t = TeamSession.parse({ type: "team", name: "x", root: "/p" });
    expect(t.cageMode).toBeUndefined();
  });
  test("t-72a6b7d7: cageMode rejects unknown literal values", () => {
    expect(() =>
      TeamSession.parse({ type: "team", name: "x", root: "/p", cageMode: "bogus" }),
    ).toThrow();
  });
});

describe("EpicTeamSession — leaf shape", () => {
  test("parses a minimal epic-team entry with parent + epicId", () => {
    const e = EpicTeamSession.parse({
      type: "epic-team",
      name: "sopx-deferred",
      parent: "sopx",
      epicId: "e-1",
    });
    expect(e.type).toBe("epic-team");
    expect(e.parent).toBe("sopx");
    expect(e.epicId).toBe("e-1");
    expect(e.sessions).toEqual([]);
  });
  test("rejects missing parent", () => {
    expect(() => EpicTeamSession.parse({ type: "epic-team", name: "x", epicId: "e-1" })).toThrow();
  });
  test("rejects missing epicId", () => {
    expect(() => EpicTeamSession.parse({ type: "epic-team", name: "x", parent: "p" })).toThrow();
  });
  test("rejects unknown leaf keys (.strict)", () => {
    expect(() =>
      EpicTeamSession.parse({
        type: "epic-team",
        name: "x",
        parent: "p",
        epicId: "e-1",
        typo: "fail",
      }),
    ).toThrow();
  });
  // t-72a6b7d7: epic-team carries the same cageMode taxonomy as standalone team.
  test("t-72a6b7d7: epic-team accepts cageMode literal + rejects unknown", () => {
    const e = EpicTeamSession.parse({
      type: "epic-team",
      name: "x",
      parent: "p",
      epicId: "e-1",
      cageMode: "paused",
    });
    expect(e.cageMode).toBe("paused");
    expect(() =>
      EpicTeamSession.parse({
        type: "epic-team",
        name: "x",
        parent: "p",
        epicId: "e-1",
        cageMode: "nope",
      }),
    ).toThrow();
  });
});

describe("SuperdriverSession + SuperdoctorSession — leaf shape", () => {
  test("Superdriver — minimal entry", () => {
    const s = SuperdriverSession.parse({ type: "superdriver", name: "superdriver" });
    expect(s.type).toBe("superdriver");
    expect(s.enabled).toBe(true);
  });
  test("Superdoctor — minimal entry", () => {
    const s = SuperdoctorSession.parse({ type: "superdoctor", name: "superdoctor" });
    expect(s.type).toBe("superdoctor");
    expect(s.enabled).toBe(true);
  });
  test("Superdriver rejects unknown leaf keys (.strict)", () => {
    expect(() =>
      SuperdriverSession.parse({ type: "superdriver", name: "x", typo: "fail" }),
    ).toThrow();
  });
});

// ---------- CockpitMartinet — discriminated union (ADR-132 §D4) ----------
//
// Post-merge reshape per Task t-b86fd8cb: CockpitMartinet is now a
// discriminated union on `impl` (claude variant + cursor variant).
// Tests below cover both variants explicitly + the discriminator gate.

describe("CockpitMartinet — discriminated union on `impl`", () => {
  test("rejects parse with no `impl` discriminator", () => {
    expect(() => CockpitMartinet.parse({})).toThrow();
    expect(() => CockpitMartinet.parse({ enabled: true })).toThrow();
  });

  test("rejects unknown `impl` literal", () => {
    expect(() =>
      CockpitMartinet.parse({ impl: "minimax" as unknown as "claude" }),
    ).toThrow();
  });
});

describe("CockpitMartinet — claude variant", () => {
  test("claude variant parses with defaults", () => {
    const m = CockpitMartinet.parse({ impl: "claude" });
    expect(m.impl).toBe("claude");
    expect(m.enabled).toBe(false);
  });

  test("claude variant accepts claudeAccount + tuiOverrides + autoStart fields", () => {
    const m = CockpitMartinet.parse({
      impl: "claude",
      enabled: true,
      claudeAccount: { configDir: "/root/.claude-unum", label: "unum" },
      tuiOverrides: { effortLevel: "xhigh" },
      autoStart: false,
      autoStartTimeoutSec: 60,
    });
    if (m.impl !== "claude") throw new Error("variant narrowing failed");
    expect(m.claudeAccount?.configDir).toBe("/root/.claude-unum");
    expect(m.tuiOverrides?.effortLevel).toBe("xhigh");
    expect(m.autoStart).toBe(false);
    expect(m.autoStartTimeoutSec).toBe(60);
  });

  test("claude variant rejects cursor-only fields (.strict drift detection)", () => {
    expect(() =>
      CockpitMartinet.parse({ impl: "claude", cursorBinPath: "/usr/bin/cursor" }),
    ).toThrow();
    expect(() =>
      CockpitMartinet.parse({ impl: "claude", model: "composer-2" }),
    ).toThrow();
  });
});

describe("CockpitMartinet — cursor variant", () => {
  test("cursor variant parses with defaults", () => {
    const m = CockpitMartinet.parse({ impl: "cursor" });
    expect(m.impl).toBe("cursor");
    if (m.impl !== "cursor") throw new Error("variant narrowing failed");
    expect(m.enabled).toBe(false);
    expect(m.cursorBinPath).toBe("/usr/local/bin/cursor-agent");
    expect(m.model).toBe("composer-2-fast");
    expect(m.cageTier).toBe("tier-2");
  });

  test("model accepts 'composer-2-fast' and 'composer-2' only", () => {
    const a = CockpitMartinet.parse({ impl: "cursor", model: "composer-2-fast" });
    const b = CockpitMartinet.parse({ impl: "cursor", model: "composer-2" });
    if (a.impl !== "cursor" || b.impl !== "cursor") {
      throw new Error("variant narrowing failed");
    }
    expect(a.model).toBe("composer-2-fast");
    expect(b.model).toBe("composer-2");
  });

  test("model rejects arbitrary strings", () => {
    expect(() =>
      CockpitMartinet.parse({ impl: "cursor", model: "composer-2-slow" }),
    ).toThrow();
    expect(() => CockpitMartinet.parse({ impl: "cursor", model: "gpt-4" })).toThrow();
  });

  test("cageTier pinned to 'tier-2' (ADR-132 §D4)", () => {
    const m = CockpitMartinet.parse({ impl: "cursor", cageTier: "tier-2" });
    if (m.impl !== "cursor") throw new Error("variant narrowing failed");
    expect(m.cageTier).toBe("tier-2");
    expect(() =>
      CockpitMartinet.parse({ impl: "cursor", cageTier: "tier-3" as unknown as "tier-2" }),
    ).toThrow();
    expect(() =>
      CockpitMartinet.parse({ impl: "cursor", cageTier: "tier-1" as unknown as "tier-2" }),
    ).toThrow();
  });

  test("cursor variant rejects claude-only fields (.strict drift detection)", () => {
    expect(() =>
      CockpitMartinet.parse({
        impl: "cursor",
        claudeAccount: { configDir: "/x", label: "y" },
      }),
    ).toThrow();
    expect(() =>
      CockpitMartinet.parse({ impl: "cursor", autoStart: true }),
    ).toThrow();
  });

  test("unknown keys rejected (.strict drift detection)", () => {
    expect(() =>
      CockpitMartinet.parse({ impl: "cursor", enbled: true }),
    ).toThrow();
    expect(() =>
      CockpitMartinet.parse({ impl: "cursor", cursorBin: "/usr/bin/cursor" }),
    ).toThrow();
  });
});

// ---------- Discriminated union — strict on `type` ----------

describe("CockpitSession discriminated union", () => {
  test("dispatches to TeamSession on type=team", () => {
    const s = CockpitSession.parse({ type: "team", name: "x", root: "/p" });
    expect(s.type).toBe("team");
  });
  test("dispatches to EpicTeamSession on type=epic-team", () => {
    const s = CockpitSession.parse({
      type: "epic-team",
      name: "x",
      parent: "p",
      epicId: "e-1",
    });
    expect(s.type).toBe("epic-team");
  });
  test("dispatches to SuperdriverSession on type=superdriver", () => {
    const s = CockpitSession.parse({ type: "superdriver", name: "x" });
    expect(s.type).toBe("superdriver");
  });
  test("dispatches to SuperdoctorSession on type=superdoctor", () => {
    const s = CockpitSession.parse({ type: "superdoctor", name: "x" });
    expect(s.type).toBe("superdoctor");
  });
  test("rejects unknown `type` discriminator value (reviewer pre-flag)", () => {
    expect(() => CockpitSession.parse({ type: "rogue-type", name: "x" })).toThrow();
  });
  test("rejects missing `type` discriminator", () => {
    expect(() => CockpitSession.parse({ name: "x" })).toThrow();
  });
});

// ---------- Recursive nesting via z.lazy ----------

describe("CockpitSession — recursive nesting", () => {
  test("team carries nested team children", () => {
    const parsed = TeamSession.parse({
      type: "team",
      name: "outer",
      root: "/p/outer",
      sessions: [
        { type: "team", name: "inner-a", root: "/p/inner-a" },
        { type: "team", name: "inner-b", root: "/p/inner-b" },
      ],
    });
    expect(parsed.sessions).toHaveLength(2);
    const inner = parsed.sessions[0];
    if (inner === undefined || inner.type !== "team") throw new Error("expected team");
    expect(inner.name).toBe("inner-a");
  });
  test("team carries nested epic-team child", () => {
    const parsed = TeamSession.parse({
      type: "team",
      name: "sopx",
      root: "/p/sopx",
      sessions: [
        {
          type: "epic-team",
          name: "sopx-deferred",
          parent: "sopx",
          epicId: "e-1",
        },
      ],
    });
    expect(parsed.sessions).toHaveLength(1);
    const child = parsed.sessions[0];
    if (child === undefined || child.type !== "epic-team") {
      throw new Error("expected epic-team child");
    }
    expect(child.parent).toBe("sopx");
  });
  test("deep recursive nesting (3 levels) parses cleanly", () => {
    const parsed = TeamSession.parse({
      type: "team",
      name: "L0",
      root: "/p/L0",
      sessions: [
        {
          type: "team",
          name: "L1",
          root: "/p/L1",
          sessions: [
            {
              type: "team",
              name: "L2",
              root: "/p/L2",
              sessions: [],
            },
          ],
        },
      ],
    });
    const l1 = parsed.sessions[0];
    if (l1 === undefined || l1.type !== "team") throw new Error("expected L1 team");
    const l2 = l1.sessions[0];
    if (l2 === undefined || l2.type !== "team") throw new Error("expected L2 team");
    expect(l2.name).toBe("L2");
  });
  test("epic-team also carries nested children", () => {
    const parsed = EpicTeamSession.parse({
      type: "epic-team",
      name: "outer-epic",
      parent: "p",
      epicId: "e-1",
      sessions: [{ type: "superdoctor", name: "epic-superdoctor" }],
    });
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.type).toBe("superdoctor");
  });
});

// ---------- Cockpit top-level shape ----------

describe("Cockpit — top-level shape + defaults", () => {
  test("empty object parses to schema defaults", () => {
    const c = Cockpit.parse({});
    expect(c.schemaVersion).toBe(1);
    // ADR-135 §D1: default cockpitSession is `atmux_cockpit` (was
    // `atmux_teams` pre-rename). Legacy literal is coerced at load
    // time via the migrateCockpitSessionLegacyLiteral shim; the schema
    // default itself has flipped to the canonical form.
    expect(c.cockpitSession).toBe("atmux_cockpit");
    expect(c.sessions).toEqual([]);
  });
  test("parses a typical recursive cockpit", () => {
    const c = Cockpit.parse({
      schemaVersion: 1,
      cockpitSession: "atmux_teams",
      sessions: [
        { type: "superdriver", name: "superdriver" },
        { type: "superdoctor", name: "superdoctor" },
        {
          type: "team",
          name: "sopx",
          root: "/p/sopx",
          sessions: [
            {
              type: "epic-team",
              name: "sopx-deferred",
              parent: "sopx",
              epicId: "e-1",
            },
          ],
        },
      ],
    });
    expect(c.sessions).toHaveLength(3);
    const team = c.sessions[2];
    if (team === undefined || team.type !== "team") throw new Error("expected team at idx 2");
    expect(team.sessions).toHaveLength(1);
  });
  test("preserves prefixChain pass-through", () => {
    const c = Cockpit.parse({
      sessions: [],
      prefixChain: ["F1", "F2", "F3"],
    });
    expect(c.prefixChain).toEqual(["F1", "F2", "F3"]);
  });
  test("top-level passthrough — unknown fields preserved", () => {
    const c = Cockpit.parse({
      sessions: [],
      futureFieldXYZ: "preserved-via-passthrough",
    });
    expect((c as Record<string, unknown>).futureFieldXYZ).toBe("preserved-via-passthrough");
  });
  test("accepts legacy back-compat `teams[]` field (loader-populated)", () => {
    // The legacy fields are typed as optional on the schema so
    // `enrichLegacyFields` can re-attach them post-parse without a
    // schema break. A raw input that already includes a `teams[]`
    // array (e.g. a re-serialized loaded cockpit round-trip) parses
    // without rejection.
    const c = Cockpit.parse({
      sessions: [{ type: "team", name: "sopx", root: "/p/sopx" }],
      teams: [{ name: "sopx", root: "/p/sopx", enabled: true }],
    });
    expect(c.teams).toHaveLength(1);
  });
  test("rejects sessions[] entries with unknown `type`", () => {
    expect(() => Cockpit.parse({ sessions: [{ type: "rogue", name: "x" }] })).toThrow();
  });

  // ADR-133 TR2: medic / superdoctor top-level keys coexist during
  // the deprecation window. The schema accepts both shapes; the
  // loader's `migrateSuperdoctorBlockToMedic` pre-parse shim resolves
  // precedence + warns (covered in tests/unit/core/cockpit.test.ts).
  test("accepts top-level `medic` block (ADR-133 new canonical key)", () => {
    const c = Cockpit.parse({
      sessions: [],
      medic: { enabled: true },
    });
    expect(c.medic?.enabled).toBe(true);
    expect(c.superdoctor).toBeUndefined();
  });
  test("accepts top-level `superdoctor` block (deprecated; back-compat)", () => {
    const c = Cockpit.parse({
      sessions: [],
      superdoctor: { enabled: true },
    });
    expect(c.superdoctor?.enabled).toBe(true);
    expect(c.medic).toBeUndefined();
  });
  test("accepts BOTH `medic` AND `superdoctor` top-level blocks (precedence in loader, not schema)", () => {
    const c = Cockpit.parse({
      sessions: [],
      medic: { enabled: true },
      superdoctor: { enabled: false },
    });
    expect(c.medic?.enabled).toBe(true);
    expect(c.superdoctor?.enabled).toBe(false);
  });
});

// ---------- ADR-133 TR2: CockpitMedic schema alias ----------

describe("CockpitMedic — ADR-133 alias of CockpitSuperdoctor", () => {
  test("parses the same shape as CockpitSuperdoctor", () => {
    const sd = CockpitSuperdoctor.parse({ enabled: true });
    const m = CockpitMedic.parse({ enabled: true });
    expect(m).toEqual(sd);
  });
  test("inherits tuiOverrides + claudeAccount + autoStart fields", () => {
    const m = CockpitMedic.parse({
      enabled: true,
      claudeAccount: { configDir: "/root/.claude-ifca" },
      tuiOverrides: { effortLevel: "xhigh", permissionMode: "auto" },
      autoStart: false,
      autoStartTimeoutSec: 45,
    });
    expect(m.claudeAccount?.configDir).toBe("/root/.claude-ifca");
    expect(m.autoStart).toBe(false);
    expect(m.autoStartTimeoutSec).toBe(45);
  });
  test("rejects unknown keys (.strict carried over)", () => {
    expect(() => CockpitMedic.parse({ enabled: true, typo: "fail" })).toThrow();
  });
});

// ---------- Cockpit — top-level defaultMartinet + martinet integration ----------

describe("Cockpit — top-level defaultMartinet + martinet integration", () => {
  test("Cockpit accepts defaultMartinet + cursor-variant martinet block at top-level", () => {
    const c = Cockpit.parse({
      teams: [],
      defaultMartinet: "cursor",
      martinet: { impl: "cursor", enabled: true, model: "composer-2" },
    });
    expect(c.defaultMartinet).toBe("cursor");
    expect(c.martinet?.enabled).toBe(true);
    if (c.martinet?.impl !== "cursor") {
      throw new Error("expected cursor variant after discriminator narrowing");
    }
    expect(c.martinet.model).toBe("composer-2");
    expect(c.martinet.cursorBinPath).toBe("/usr/local/bin/cursor-agent");
  });

  test("Cockpit accepts claude-variant martinet block at top-level (degenerate impl)", () => {
    const c = Cockpit.parse({
      teams: [],
      defaultMartinet: "claude",
      martinet: { impl: "claude", enabled: true, autoStart: false },
    });
    expect(c.defaultMartinet).toBe("claude");
    if (c.martinet?.impl !== "claude") {
      throw new Error("expected claude variant after discriminator narrowing");
    }
    expect(c.martinet.enabled).toBe(true);
    expect(c.martinet.autoStart).toBe(false);
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
