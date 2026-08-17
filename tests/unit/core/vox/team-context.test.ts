// Unit tests for src/core/vox/team-context.ts — ADR-272 team index +
// ASR-tolerant name resolution.
//
// Pins:
//   - Ladder order: exact → case-fold → suffix-strip → unique prefix →
//     Levenshtein ≤2; FIRST rung with exactly one hit wins; >1 hits on
//     a rung → ambiguous with candidates; falling off → unknown.
//   - ASR-ish inputs: "ATMUX", "sopx" (vs sopx-root), "atmuks" resolve;
//     "member ai" does NOT resolve to "mx-root" (never a silent
//     cross-name guess).
//   - buildTeamIndex flattens enabled team + epic-team sessions via the
//     cockpit walker (epic-teams inherit the parent root) and honours
//     the injectable loader; the default loader reads the cockpit.json
//     that ATMUX_COCKPIT_CONFIG points at.

import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedCockpit } from "../../../../src/core/cockpit.ts";
import {
  buildTeamIndex,
  levenshtein,
  resolveTeamName,
  type VoxTeamIndex,
} from "../../../../src/core/vox/team-context.ts";

const INDEX: VoxTeamIndex = {
  teams: [
    { name: "atmux", root: "/w/atmux", type: "team" },
    { name: "sopx-root", root: "/w/sopx", type: "team" },
    { name: "mx-root", root: "/w/mx", type: "team" },
    { name: "crm-react", root: "/w/crm", type: "team" },
    { name: "e-payments", root: "/w/mx", type: "epic-team" },
  ],
};

describe("levenshtein", () => {
  test.each([
    ["", "", 0],
    ["a", "", 1],
    ["", "abc", 3],
    ["kitten", "sitting", 3],
    ["atmux", "atmux", 0],
    ["atmux", "atmuks", 2],
    ["crm-react", "crm react", 1],
    ["flaw", "lawn", 2],
  ])("d(%j, %j) = %d", (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected);
    expect(levenshtein(b, a)).toBe(expected);
  });
});

describe("resolveTeamName — ladder rungs", () => {
  test("rung 1: exact match wins", () => {
    const r = resolveTeamName(INDEX, "atmux");
    expect(r).toEqual({ ok: true, team: { name: "atmux", root: "/w/atmux", type: "team" } });
  });

  test("rung 1 beats rung 2: exact hit wins even when case-fold would be ambiguous", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "Alpha", root: "/w/A", type: "team" },
        { name: "alpha", root: "/w/a", type: "team" },
      ],
    };
    const r = resolveTeamName(idx, "alpha");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.root).toBe("/w/a");
  });

  test("rung 2: case-fold ('ATMUX' → atmux)", () => {
    const r = resolveTeamName(INDEX, "ATMUX");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux");
  });

  test("rung 2: surrounding whitespace is trimmed", () => {
    const r = resolveTeamName(INDEX, "  atmux  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux");
  });

  test.each([
    ["sopx", "sopx-root"],
    ["mx", "mx-root"],
    ["MX", "mx-root"],
  ])("rung 3: suffix-strip (%j → %s)", (spoken, expected) => {
    const r = resolveTeamName(INDEX, spoken);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe(expected);
  });

  test("rung 3 strips BOTH sides: spoken 'mx-team' hits mx-root", () => {
    const r = resolveTeamName(INDEX, "mx-team");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("mx-root");
  });

  test("rung 4: unique prefix ('crm' → crm-react)", () => {
    const r = resolveTeamName(INDEX, "crm");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("crm-react");
  });

  test("rung 4: prefix shared by two names → ambiguous with candidates", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "px-crm", root: "/w/1", type: "team" },
        { name: "px-sales", root: "/w/2", type: "team" },
      ],
    };
    expect(resolveTeamName(idx, "px")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["px-crm", "px-sales"],
    });
  });

  test("rung 5: Levenshtein ≤2 ('atmuks' → atmux)", () => {
    const r = resolveTeamName(INDEX, "atmuks");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux");
  });

  test("rung 5: 'crm react' (ASR drops the hyphen) → crm-react", () => {
    const r = resolveTeamName(INDEX, "crm react");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("crm-react");
  });

  test("rung 5: two names within distance 2 → ambiguous", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "teama", root: "/w/1", type: "team" },
        { name: "teamb", root: "/w/2", type: "team" },
      ],
    };
    expect(resolveTeamName(idx, "teamc")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["teama", "teamb"],
    });
  });

  test("ASR-ish product name ('member ai') does NOT silently map to mx-root", () => {
    expect(resolveTeamName(INDEX, "member ai")).toEqual({ ok: false, reason: "unknown" });
  });

  test.each([[""], ["   "], ["zzzzzzzz"]])("%j → unknown", (spoken) => {
    expect(resolveTeamName(INDEX, spoken)).toEqual({ ok: false, reason: "unknown" });
  });

  test("epic-team entries resolve too", () => {
    const r = resolveTeamName(INDEX, "e-payments");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.type).toBe("epic-team");
  });

  test("empty index → unknown", () => {
    expect(resolveTeamName({ teams: [] }, "atmux")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("buildTeamIndex", () => {
  const cockpitFixture = {
    schemaVersion: 1,
    sessions: [
      {
        type: "team",
        name: "alpha",
        root: "/w/alpha",
        enabled: true,
        sessions: [{ type: "epic-team", name: "e-pay", parent: "alpha", enabled: true }],
      },
      { type: "team", name: "beta", root: "/w/beta", enabled: false },
      { type: "team", name: "gamma", root: "/w/gamma", enabled: true },
    ],
    teams: [],
  } as unknown as LoadedCockpit;

  test("injected loader: enabled teams + epic-teams (parent root inherited); disabled dropped", async () => {
    const index = await buildTeamIndex({ loadCockpit: async () => cockpitFixture });
    expect(index.teams).toEqual([
      { name: "alpha", root: "/w/alpha", type: "team" },
      { name: "e-pay", root: "/w/alpha", type: "epic-team" },
      { name: "gamma", root: "/w/gamma", type: "team" },
    ]);
  });

  test("default loader reads the cockpit.json ATMUX_COCKPIT_CONFIG points at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atmux-vox-cockpit-"));
    const path = join(dir, "cockpit.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        sessions: [{ type: "team", name: "envteam", root: "/w/envteam", enabled: true }],
      }),
    );
    const prev = process.env.ATMUX_COCKPIT_CONFIG;
    process.env.ATMUX_COCKPIT_CONFIG = path;
    try {
      const index = await buildTeamIndex();
      expect(index.teams).toEqual([{ name: "envteam", root: "/w/envteam", type: "team" }]);
    } finally {
      if (prev === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
      else process.env.ATMUX_COCKPIT_CONFIG = prev;
    }
  });
});
