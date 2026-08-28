// Unit tests for src/schema/cockpit.ts — ADR-089 recursive sessions[]
// schema (replaces ADR-063 flat teams[]).
// Covers:
//   - discriminatedUnion across team / superdriver / medic, and the
//     LOUD rejection of the retired `epic-team` discriminator
//   - .strict() leaf rejection of unknown keys
//   - .strict() rejection of unknown `type` discriminator values
//   - recursive nesting via z.lazy
//   - schemaVersion, cockpitSession, and operator-window defaults + prefixChain pass-through
//   - legacy back-compat field (`teams`) accepted as optional
//     so the loader's enrichment pass round-trips it
//
// Migration-shim + DFS-walk + flattener tests live in
// tests/unit/core/cockpit.test.ts.

import { describe, expect, test } from "bun:test";
import {
  Cockpit,
  CockpitMedic,
  CockpitSession,
  CockpitWindow,
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

// ADR-280 stage 3 removed the `EpicTeamSession` leaf and its `epicId` /
// `parent` fields from the union. The leaf-shape suite that stood here
// is gone with the schema it described; what replaces it is the
// EXPIRED-CONTRACT guard (ADR-266 §D2, restated in ADR-280 §Consequences):
// a config still carrying `type: "epic-team"` must fail to parse LOUD,
// never degrade to an ignored entry. `CockpitSession` is a
// discriminatedUnion of `.strict()` leaves, so this is what enforces it —
// and it is the single most load-bearing assertion of the retirement,
// because the alternative (silent aliasing) is what ADR-266 forbids.

describe("epic-team — retired discriminator fails loud (ADR-280 / ADR-266 §D2)", () => {
  test("a bare epic-team entry is REJECTED by the union", () => {
    expect(() =>
      CockpitSession.parse({ type: "epic-team", name: "sopx-deferred", parent: "sopx", epicId: "e-1" }),
    ).toThrow();
  });

  test("a full epic-team entry — every field the old leaf accepted — is still rejected", () => {
    expect(() =>
      CockpitSession.parse({
        type: "epic-team",
        name: "x",
        parent: "p",
        epicId: "e-1",
        enabled: true,
        cageMode: "paused",
        sessions: [],
      }),
    ).toThrow();
  });

  test("`epicId` / `parent` are no longer accepted on a type=team entry either (.strict)", () => {
    // The fields left with the leaf; a team entry that inherits them
    // from a hand-edited config must fail rather than silently drop them.
    expect(() =>
      TeamSession.parse({ type: "team", name: "x", root: "/p", epicId: "e-1" }),
    ).toThrow();
    expect(() =>
      TeamSession.parse({ type: "team", name: "x", root: "/p", parent: "sopx" }),
    ).toThrow();
  });

  test("a NESTED epic-team is rejected too — the union is enforced at every depth", () => {
    expect(() =>
      TeamSession.parse({
        type: "team",
        name: "sopx",
        root: "/p/sopx",
        sessions: [{ type: "epic-team", name: "sopx-deferred", parent: "sopx", epicId: "e-1" }],
      }),
    ).toThrow();
  });
});

describe("SuperdriverSession — leaf shape", () => {
  test("Superdriver — minimal entry", () => {
    const s = SuperdriverSession.parse({ type: "superdriver", name: "superdriver" });
    expect(s.type).toBe("superdriver");
    expect(s.enabled).toBe(true);
  });
  test("Superdriver rejects unknown leaf keys (.strict)", () => {
    expect(() =>
      SuperdriverSession.parse({ type: "superdriver", name: "x", typo: "fail" }),
    ).toThrow();
  });
});

// ---------- Discriminated union — strict on `type` ----------

describe("CockpitSession discriminated union", () => {
  test("dispatches to TeamSession on type=team", () => {
    const s = CockpitSession.parse({ type: "team", name: "x", root: "/p" });
    expect(s.type).toBe("team");
  });
  test("rejects retired type=epic-team (ADR-280 stage 3 narrowed the union)", () => {
    expect(() =>
      CockpitSession.parse({ type: "epic-team", name: "x", parent: "p", epicId: "e-1" }),
    ).toThrow();
  });
  test("dispatches to SuperdriverSession on type=superdriver", () => {
    const s = CockpitSession.parse({ type: "superdriver", name: "x" });
    expect(s.type).toBe("superdriver");
  });
  test("rejects legacy type=superdoctor (ADR-133 shim removed per ADR-266 §D2)", () => {
    expect(() => CockpitSession.parse({ type: "superdoctor", name: "x" })).toThrow();
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
  // ADR-280 stage 4: was "team carries nested epic-team child". Nesting
  // survives the retirement — only the child TYPE changed — so the case
  // is kept against a nested `team`, which is now the general shape
  // (ADR-089 §Amendment 2026-08-27 §(A)).
  test("team carries a nested team child that keeps its own root", () => {
    const parsed = TeamSession.parse({
      type: "team",
      name: "sopx",
      root: "/p/sopx",
      sessions: [{ type: "team", name: "sopx-deferred", root: "/p/sopx-deferred" }],
    });
    expect(parsed.sessions).toHaveLength(1);
    const child = parsed.sessions[0];
    if (child === undefined || child.type !== "team") {
      throw new Error("expected team child");
    }
    expect(child.name).toBe("sopx-deferred");
    expect(child.root).toBe("/p/sopx-deferred");
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
  // ADR-280 stage 4: was "epic-team also carries nested children". The
  // property — a nesting-capable node accepts a NON-team leaf as a child
  // — belongs to `team` now that it is the only such node.
  test("team also carries a non-team nested child (medic leaf)", () => {
    const parsed = TeamSession.parse({
      type: "team",
      name: "outer",
      root: "/p/outer",
      sessions: [{ type: "medic", name: "outer-medic" }],
    });
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.type).toBe("medic");
  });
});

// ---------- Cockpit top-level shape ----------

describe("Cockpit — top-level shape + defaults", () => {
  test("empty object parses to schema defaults", () => {
    const c = Cockpit.parse({});
    expect(c.schemaVersion).toBe(1);
    // ADR-264 §D1: default cockpitSession is `atx`; ADR-279 keeps an
    // explicitly persisted literal authoritative.
    expect(c.cockpitSession).toBe("atx");
    expect(c.sessions).toEqual([]);
    expect(c.windows).toEqual([]);
  });

  test("ADR-279: operator window accepts null or omitted command and defaults enabled", () => {
    expect(CockpitWindow.parse({ name: "_misc", cwd: "/root/work", command: null })).toEqual({
      name: "_misc",
      enabled: true,
      cwd: "/root/work",
      command: null,
    });
    expect(CockpitWindow.parse({ name: "scratch", cwd: "/tmp" })).toEqual({
      name: "scratch",
      enabled: true,
      cwd: "/tmp",
    });
    expect(() => CockpitWindow.parse({ name: "scratch", cwd: "", command: "zsh" })).toThrow();
  });
  test("parses a typical recursive cockpit", () => {
    const c = Cockpit.parse({
      schemaVersion: 1,
      cockpitSession: "atmux_teams",
      sessions: [
        { type: "superdriver", name: "superdriver" },
        { type: "medic", name: "medic" },
        {
          type: "team",
          name: "sopx",
          root: "/p/sopx",
          sessions: [{ type: "team", name: "sopx-deferred", root: "/p/sopx-deferred" }],
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

  // ADR-133: `medic` is the canonical top-level key. The deprecated
  // `superdoctor` key was removed per ADR-266 §D2 — the loader
  // hard-fails on it before parse (covered in
  // tests/unit/core/cockpit.test.ts).
  test("accepts top-level `medic` block (ADR-133 canonical key)", () => {
    const c = Cockpit.parse({
      sessions: [],
      medic: { enabled: true },
    });
    expect(c.medic?.enabled).toBe(true);
  });
});

// ---------- ADR-133: CockpitMedic schema (re-anchored per ADR-266 §D2) ----------

describe("CockpitMedic — canonical singleton shape", () => {
  test("parses a minimal block", () => {
    const m = CockpitMedic.parse({ enabled: true });
    expect(m.enabled).toBe(true);
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

// ---------- ADR-229 §DA-Gate-2: cockpit pushPolicy ----------

describe("Cockpit.pushPolicy — ADR-229 §DA-Gate-2 (orchd-push allowlist / refusedlist)", () => {
  test("absent → undefined (additive — no operator overrides)", () => {
    const c = Cockpit.parse({});
    expect(c.pushPolicy).toBeUndefined();
  });

  test("empty {} applies sub-defaults — both lists empty", () => {
    const c = Cockpit.parse({ pushPolicy: {} });
    expect(c.pushPolicy).toEqual({ refusedBases: [], allowedBases: [] });
  });

  test("refusedBases populated (project-specific additions)", () => {
    const c = Cockpit.parse({
      pushPolicy: { refusedBases: ["foo-canary", "bar-release"] },
    });
    expect(c.pushPolicy?.refusedBases).toEqual(["foo-canary", "bar-release"]);
    expect(c.pushPolicy?.allowedBases).toEqual([]); // sub-default
  });

  test("allowedBases populated (escape-hatch override — e.g. geoy.ws)", () => {
    const c = Cockpit.parse({
      pushPolicy: { allowedBases: ["geoyws-main", "geoyws-personal"] },
    });
    expect(c.pushPolicy?.allowedBases).toEqual(["geoyws-main", "geoyws-personal"]);
    expect(c.pushPolicy?.refusedBases).toEqual([]); // sub-default
  });

  test("both lists populated simultaneously (independent layers)", () => {
    const c = Cockpit.parse({
      pushPolicy: {
        refusedBases: ["foo-canary"],
        allowedBases: ["geoyws-main"],
      },
    });
    expect(c.pushPolicy?.refusedBases).toEqual(["foo-canary"]);
    expect(c.pushPolicy?.allowedBases).toEqual(["geoyws-main"]);
  });

  test("non-array refusedBases refused (Zod type guard)", () => {
    expect(() =>
      Cockpit.parse({
        pushPolicy: { refusedBases: "foo-canary" as unknown as string[] },
      }),
    ).toThrow();
  });

  test("strict mode rejects unknown keys inside pushPolicy (drift surface)", () => {
    expect(() =>
      Cockpit.parse({
        pushPolicy: { refusedBases: [], allowdBases: [] }, // typo
      }),
    ).toThrow();
  });
});
