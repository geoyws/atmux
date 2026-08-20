// Unit tests for src/core/vox/team-context.ts — ADR-272 team index +
// ASR-tolerant name resolution.
//
// Pins:
//   - Ladder order: exact → case-fold → suffix-strip → unique prefix →
//     SEGMENT RUN → Levenshtein ≤2; FIRST rung with exactly one hit
//     wins; >1 hits on a rung → ambiguous with candidates; falling off →
//     unknown.
//   - ASR-ish inputs: "ATMUX", "sopx" (vs sopx-root), "atmuks" resolve;
//     "member ai" does NOT resolve to "mx-root" (never a silent
//     cross-name guess).
//   - ADR-273 §Supplement-8 segment rung: a distinctive TRAILING or
//     INTERIOR segment of a `<product>-<feature>-<user>[-driver-N]` name
//     resolves ("alpha", "geoyws", "driver 2"), spoken filler is dropped
//     ("the alpha team"), and every rung ABOVE it still wins outright —
//     that last group is the regression pin most likely to break.
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
  normalizeSpoken,
  RESOLVE_MAX_EDIT_DISTANCE,
  resolveTeamName,
  type VoxTeamIndex,
} from "../../../../src/core/vox/team-context.ts";

/** The real fleet's shape (CLAUDE.md §Branch naming):
 *  `<product>-<feature>-<user>[-driver-N]`, several products sharing a
 *  user segment and two of them sharing a driver lane number. Every
 *  §Supplement-8 assertion is made against THIS, not a two-name toy. */
const FLEET: VoxTeamIndex = {
  teams: [
    { name: "atmux-geoyws", root: "/w/atmux", type: "team" },
    { name: "px-crm-geoyws-driver-2", root: "/w/crm", type: "team" },
    { name: "px-crm-geoyws-driver-3", root: "/w/crm", type: "team" },
    { name: "px-sales-geoyws", root: "/w/px", type: "team" },
    { name: "vox-e2e-alpha", root: "/w/vox", type: "team" },
    { name: "vox-e2e-ghost", root: "/w/vox", type: "team" },
    { name: "mx-root", root: "/w/mx", type: "team" },
  ],
};

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

  test("rung 6: Levenshtein ≤2 ('atmuks' → atmux)", () => {
    const r = resolveTeamName(INDEX, "atmuks");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux");
  });

  // Was a rung-5 Levenshtein hit before ADR-273 §Supplement-8; the
  // segment rung now catches it one rung earlier and EXACTLY (the
  // normalized utterance "crm-react" is the whole name). Same answer,
  // reached by a precise match instead of a fuzzy one.
  test("rung 5: 'crm react' (ASR drops the hyphen) → crm-react", () => {
    const r = resolveTeamName(INDEX, "crm react");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("crm-react");
  });

  test("rung 6: two names within distance 2 → ambiguous", () => {
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

describe("normalizeSpoken", () => {
  test.each([
    // identity on a name already in canonical shape
    ["vox-e2e-alpha", "vox-e2e-alpha"],
    // case-fold + trim, same as `fold`
    ["  ATMUX-Geoyws  ", "atmux-geoyws"],
    // speech gives spaces where the name has hyphens
    ["driver 2", "driver-2"],
    ["px crm geoyws driver 2", "px-crm-geoyws-driver-2"],
    // leading article + trailing common noun are filler
    ["the alpha team", "alpha"],
    ["the vox e2e alpha team", "vox-e2e-alpha"],
    ["the driver teams", "driver"],
    // possessive clitic, straight and curly
    ["the alpha team's", "alpha"],
    ["the alpha team\u2019s", "alpha"],
    ["alpha's", "alpha"],
    // filler is NEVER dropped down to nothing — a team can be called `team`
    ["team", "team"],
    ["the team", "team"],
    ["the", "the"],
    // ...but the guard is per-step, so "the teams" loses only the
    // article: stripping the last token would leave nothing to match.
    ["the teams", "teams"],
    // punctuation-only utterances normalize away entirely; the caller
    // must then match NOTHING rather than everything
    ["-", ""],
    ["'s", ""],
  ])("normalizeSpoken(%j) = %j", (spoken, expected) => {
    expect(normalizeSpoken(spoken)).toBe(expected);
  });
});

describe("resolveTeamName — rung 5 segment run (ADR-273 §Supplement-8)", () => {
  // Every row here returned `unknown` before §Supplement-8: the ladder
  // had no rung below `prefix`, so only a LEADING segment resolved,
  // which on this fleet is the least distinctive part of the name.
  test.each([
    ["alpha", "vox-e2e-alpha"],
    ["ghost", "vox-e2e-ghost"],
    ["the alpha team", "vox-e2e-alpha"],
    ["ALPHA", "vox-e2e-alpha"],
    ["driver 2", "px-crm-geoyws-driver-2"],
    ["driver-2", "px-crm-geoyws-driver-2"],
    ["driver 3", "px-crm-geoyws-driver-3"],
    ["geoyws driver 2", "px-crm-geoyws-driver-2"],
    ["sales", "px-sales-geoyws"],
  ])("%j → %s", (spoken, expected) => {
    const r = resolveTeamName(FLEET, spoken);
    expect(r).toEqual({
      ok: true,
      team: FLEET.teams.find((t) => t.name === expected) as never,
    });
  });

  test("a multi-word run that spans two teams is ambiguous, not a lane guess", () => {
    // "crm geoyws" normalizes to `crm-geoyws`, a contiguous run in BOTH
    // driver lanes. Speech giving us more words does not license picking
    // one.
    expect(resolveTeamName(FLEET, "crm geoyws")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["px-crm-geoyws-driver-2", "px-crm-geoyws-driver-3"],
    });
  });

  test("interior AND trailing segments are ONE rung: an interior hit resolves", () => {
    // "crm" is interior in `px-crm-geoyws-driver-2` / `-driver-3` and
    // absent everywhere else; both hits → ambiguous, not a positional
    // tie-break toward either.
    expect(resolveTeamName(FLEET, "crm")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["px-crm-geoyws-driver-2", "px-crm-geoyws-driver-3"],
    });
  });

  test("a trailing segment unique to ONE team resolves it", () => {
    // The brief's `atmux-geoyws` / "geoyws" row. It only resolves where
    // the segment is unique — see the ambiguity suite for the real fleet.
    const idx: VoxTeamIndex = {
      teams: [
        { name: "atmux-geoyws", root: "/w/atmux", type: "team" },
        { name: "vox-e2e-alpha", root: "/w/vox", type: "team" },
      ],
    };
    const r = resolveTeamName(idx, "geoyws");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux-geoyws");
  });

  test("spoken filler in front of a whole name still resolves it", () => {
    const r = resolveTeamName(FLEET, "the atmux geoyws team");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux-geoyws");
  });

  test("a bare lane number is a real segment and resolves when unique", () => {
    // Documented, not accidental: `2` appears as a whole segment in
    // exactly one fleet name. `3` likewise. If both lanes existed under
    // two products this would be ambiguous (next suite).
    const r = resolveTeamName(FLEET, "2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("px-crm-geoyws-driver-2");
  });

  test("segment matching is boundary-anchored: a segment PREFIX is not a hit", () => {
    // "e" is a prefix of the `e2e` segment. If the rung used a plain
    // substring test it would hit both vox teams; anchored, it hits
    // neither and the utterance falls through to Levenshtein → unknown.
    expect(resolveTeamName(FLEET, "e")).toEqual({ ok: false, reason: "unknown" });
  });

  test("segment matching is contiguous: a non-adjacent word pair is not a hit", () => {
    // "px geoyws" normalizes to `px-geoyws`, which is NOT a contiguous
    // run of `px-crm-geoyws-driver-2` (crm sits between them).
    expect(resolveTeamName(FLEET, "px geoyws")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("resolveTeamName — the new rungs still ASK rather than guess", () => {
  test("'px' is ambiguous across every px sibling, with all candidates", () => {
    expect(resolveTeamName(FLEET, "px")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["px-crm-geoyws-driver-2", "px-crm-geoyws-driver-3", "px-sales-geoyws"],
    });
  });

  test("'geoyws' is ambiguous on the real fleet — the shared user segment", () => {
    expect(resolveTeamName(FLEET, "geoyws")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: [
        "atmux-geoyws",
        "px-crm-geoyws-driver-2",
        "px-crm-geoyws-driver-3",
        "px-sales-geoyws",
      ],
    });
  });

  test("'driver 2' is ambiguous when two products both have that lane", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "px-crm-geoyws-driver-2", root: "/w/crm", type: "team" },
        { name: "mx-api-geoyws-driver-2", root: "/w/mx", type: "team" },
      ],
    };
    expect(resolveTeamName(idx, "driver 2")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["px-crm-geoyws-driver-2", "mx-api-geoyws-driver-2"],
    });
  });

  test("'e2e' is ambiguous across the two vox teams", () => {
    expect(resolveTeamName(FLEET, "e2e")).toEqual({
      ok: false,
      reason: "ambiguous",
      candidates: ["vox-e2e-alpha", "vox-e2e-ghost"],
    });
  });

  test.each([
    // pure filler: normalization leaves "team", which is nobody's segment
    ["the team"],
    // punctuation-only: normalization leaves the EMPTY string, which must
    // match nothing — a rung that matches everything is the worst failure
    // mode this module has
    ["-"],
    ["'s"],
    // a real English phrase that is nobody's segment and nobody's typo
    ["hotel booking"],
    ["kanban"],
    // a segment of a segment
    ["geo"],
  ])("%j stays unknown — the new rungs resolve nothing to everything", (spoken) => {
    expect(resolveTeamName(FLEET, spoken)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("resolveTeamName — the empty-needle guard", () => {
  // The segment rung builds a `-<run>-` needle. If normalization consumed
  // the whole utterance the run is EMPTY, and an unguarded needle would be
  // the bare `--` — which matches any name carrying an empty segment. A
  // rung that matches everything is the worst failure mode this module
  // has, so the guard makes the rung match nothing instead. Only a
  // pathological name distinguishes the guard from the `-` anchoring, so
  // this suite supplies one on purpose.
  const idx: VoxTeamIndex = {
    teams: [
      { name: "vox--alpha", root: "/w/1", type: "team" },
      { name: "vox--ghost", root: "/w/2", type: "team" },
    ],
  };

  test.each([
    ["-"],
    ["'s"],
    ["--"],
  ])("%j matches NOTHING even against a name with an empty segment", (spoken) => {
    expect(resolveTeamName(idx, spoken)).toEqual({ ok: false, reason: "unknown" });
  });

  test("the same index still resolves a real segment", () => {
    const r = resolveTeamName(idx, "alpha");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("vox--alpha");
  });
});

describe("resolveTeamName — rung ORDER regression pins (segment must not outrank)", () => {
  // Each index below is built so the segment rung would hit ≥2 names —
  // i.e. would return `ambiguous` — if it were moved above the rung under
  // test. A green here means the higher rung still wins outright.

  test("rung 1 (exact) beats the segment rung", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "alpha", root: "/w/1", type: "team" },
        { name: "vox-e2e-alpha", root: "/w/2", type: "team" },
        { name: "beta-alpha-two", root: "/w/3", type: "team" },
      ],
    };
    expect(resolveTeamName(idx, "alpha")).toEqual({
      ok: true,
      team: { name: "alpha", root: "/w/1", type: "team" },
    });
  });

  test("rung 2 (case-fold) beats the segment rung", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "ALPHA", root: "/w/1", type: "team" },
        { name: "vox-e2e-alpha", root: "/w/2", type: "team" },
        { name: "beta-alpha-two", root: "/w/3", type: "team" },
      ],
    };
    expect(resolveTeamName(idx, "alpha")).toEqual({
      ok: true,
      team: { name: "ALPHA", root: "/w/1", type: "team" },
    });
  });

  test("rung 3 (suffix-strip) beats the segment rung", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "mx-root", root: "/w/1", type: "team" },
        { name: "px-mx-tools", root: "/w/2", type: "team" },
      ],
    };
    const r = resolveTeamName(idx, "mx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("mx-root");
  });

  test("rung 4 (prefix) beats the segment rung", () => {
    const idx: VoxTeamIndex = {
      teams: [
        { name: "crm-react", root: "/w/1", type: "team" },
        { name: "px-crm-geoyws", root: "/w/2", type: "team" },
      ],
    };
    const r = resolveTeamName(idx, "crm");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("crm-react");
  });

  test("rung 5 (segment) beats rung 6 (Levenshtein)", () => {
    // `alpht` is edit-distance 1 from "alpha"; `vox-e2e-alpha` carries
    // `alpha` as a literal segment. The exact segment must win — a typo
    // match outranking a word the operator actually said would be worse
    // than the bug this rung fixes.
    const idx: VoxTeamIndex = {
      teams: [
        { name: "vox-e2e-alpha", root: "/w/1", type: "team" },
        { name: "alpht", root: "/w/2", type: "team" },
      ],
    };
    const r = resolveTeamName(idx, "alpha");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("vox-e2e-alpha");
  });
});

describe("RESOLVE_MAX_EDIT_DISTANCE — unchanged by the segment rung", () => {
  const idx: VoxTeamIndex = { teams: [{ name: "atmux", root: "/w/1", type: "team" }] };

  test("the exported bound is still 2", () => {
    expect(RESOLVE_MAX_EDIT_DISTANCE).toBe(2);
  });

  test("distance exactly RESOLVE_MAX_EDIT_DISTANCE still resolves", () => {
    expect(levenshtein("atmux", "atmuks")).toBe(RESOLVE_MAX_EDIT_DISTANCE);
    const r = resolveTeamName(idx, "atmuks");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.team.name).toBe("atmux");
  });

  test("distance RESOLVE_MAX_EDIT_DISTANCE + 1 is still unknown", () => {
    expect(levenshtein("atmux", "atmukss")).toBe(RESOLVE_MAX_EDIT_DISTANCE + 1);
    expect(resolveTeamName(idx, "atmukss")).toEqual({ ok: false, reason: "unknown" });
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
