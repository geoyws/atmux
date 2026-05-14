// Unit tests for src/schema/cockpit.ts — ADR-089 recursive sessions[]
// schema (replaces ADR-063 flat teams[]). Covers:
//   - discriminatedUnion across team / epic-team / superdriver / superdoctor
//   - .strict() leaf rejection of unknown keys
//   - .strict() rejection of unknown `type` discriminator values
//   - recursive nesting via z.lazy
//   - schemaVersion default + cockpitSession default + prefixChain pass-through
//   - legacy back-compat fields (`teams`, `superdoctor`) accepted as optional
//     so the loader's enrichment pass round-trips them
//
// Migration-shim + DFS-walk + flattener tests live in
// tests/unit/core/cockpit.test.ts.

import { describe, expect, test } from "bun:test";
import {
  Cockpit,
  CockpitSession,
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
    expect(() =>
      EpicTeamSession.parse({ type: "epic-team", name: "x", epicId: "e-1" }),
    ).toThrow();
  });
  test("rejects missing epicId", () => {
    expect(() =>
      EpicTeamSession.parse({ type: "epic-team", name: "x", parent: "p" }),
    ).toThrow();
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
    expect(() =>
      CockpitSession.parse({ type: "rogue-type", name: "x" }),
    ).toThrow();
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
    expect(c.cockpitSession).toBe("atmux_teams");
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
    expect(() =>
      Cockpit.parse({ sessions: [{ type: "rogue", name: "x" }] }),
    ).toThrow();
  });
});
