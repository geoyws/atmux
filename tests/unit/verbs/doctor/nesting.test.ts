// Unit tests for src/verbs/doctor/nesting.ts — ADR-287 §D7 probes.
//
// Coverage strategy
// -----------------
// The two pure row builders (`teamInsideTeamRows`,
// `deprecatedMemberWindowsRows`) are driven on parsed objects — no IO.
// The two async wrappers are driven twice: once through the injected
// `loadCockpitFn` / `loadTeamForRoot` seams (every branch of the target
// set logic), and once through the DEFAULT seams against a temp dir
// (`ATMUX_COCKPIT_CONFIG` pointed at a temp cockpit.json; real
// `<root>/.atmux/team.json` files) so the production closures — success,
// absent AND refused arms — execute. The red `cockpit.json` row (ADR-287
// §D7: a cockpit.json that is present but refused at load) is pinned
// through both the injected seam and the production loader. No tmux is
// touched anywhere in this file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedCockpit } from "../../../../src/core/cockpit.ts";
import type { Team } from "../../../../src/schema/team.ts";
import {
  checkDeprecatedMemberWindows,
  checkTeamInsideTeam,
  cockpitLoadRefusedRow,
  deprecatedMemberWindowsRows,
  teamInsideTeamRows,
} from "../../../../src/verbs/doctor.ts";

const TEAM_INSIDE_TEAM_HINT =
  "move it under a group — team-inside-team is deprecated per ADR-287 §D3 (groups are branches, teams are leaf cages)";
const MEMBER_WINDOWS_HINT =
  "default roster is drivers-only per ADR-287 §D5; drop members[] when the lead/planner/reviewer loop is not in use";
const COCKPIT_REFUSED_HINT =
  "every verb that loads the cockpit stops on this until the file loads (ADR-287 §D4 / §D7) — fix cockpit.json; for a depth refusal lengthen prefixChain or reduce nesting depth";

/** Minimal Team fixture — only the fields the roster probe reads. */
function team(name: string, memberNames: ReadonlyArray<string>): Team {
    return {
    name,
    members: memberNames.map((m) => ({ name: m, role: "member", tui: "claude" })),
    drivers: [
      { name: "driver", tui: null, cwd: "." },
      { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
      { name: "driver-3", tui: null, cwd: ".atmux/worktrees/driver-3" },
    ],
    driverPair: {
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          tui: null,
          command: null,
        },
      ],
    },
  };
}

/** A LoadedCockpit stand-in carrying only what the probes read. */
function cockpitWith(parts: {
  sessions?: unknown[];
  teams?: Array<{ root: string }>;
}): LoadedCockpit {
  return {
    schemaVersion: 1,
    sessions: parts.sessions ?? [],
    teams: parts.teams ?? [],
  } as never;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-doctor-nesting-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- teamInsideTeamRows (pure) ----------

describe("teamInsideTeamRows — pure", () => {
  test("flat fleet → []", () => {
    const rows = teamInsideTeamRows(
      cockpitWith({
        sessions: [
          { type: "team", name: "a", root: "/a", enabled: true, sessions: [] },
          { type: "team", name: "b", root: "/b", enabled: true, sessions: [] },
        ],
      }),
    );
    expect(rows).toEqual([]);
  });

  test("group → team (canonical shape) → []", () => {
    const rows = teamInsideTeamRows(
      cockpitWith({
        sessions: [
          {
            type: "group",
            name: "unum",
            enabled: true,
            sessions: [{ type: "team", name: "aix", root: "/aix", enabled: true, sessions: [] }],
          },
        ],
      }),
    );
    expect(rows).toEqual([]);
  });

  test("team → team → exactly one yellow row naming child and parent", () => {
    const rows = teamInsideTeamRows(
      cockpitWith({
        sessions: [
          {
            type: "team",
            name: "parent",
            root: "/p",
            enabled: true,
            sessions: [{ type: "team", name: "child", root: "/c", enabled: true, sessions: [] }],
          },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        status: "yellow",
        label: "team-inside-team",
        detail: "team 'child' is nested inside team 'parent' in cockpit.json",
        hint: TEAM_INSIDE_TEAM_HINT,
      },
    ]);
  });

  test("team → group → team → [] (direct nesting only)", () => {
    const rows = teamInsideTeamRows(
      cockpitWith({
        sessions: [
          {
            type: "team",
            name: "a",
            root: "/a",
            enabled: true,
            sessions: [
              {
                type: "group",
                name: "g",
                enabled: true,
                sessions: [{ type: "team", name: "b", root: "/b", enabled: true, sessions: [] }],
              },
            ],
          },
        ],
      }),
    );
    expect(rows).toEqual([]);
  });

  test("one row per nested pair — each parent's pairs together, parents in DFS pre-order", () => {
    const rows = teamInsideTeamRows(
      cockpitWith({
        sessions: [
          {
            type: "team",
            name: "a",
            root: "/a",
            enabled: true,
            sessions: [
              {
                type: "team",
                name: "b",
                root: "/b",
                enabled: true,
                sessions: [{ type: "team", name: "c", root: "/c", enabled: true, sessions: [] }],
              },
              { type: "team", name: "d", root: "/d", enabled: true, sessions: [] },
            ],
          },
        ],
      }),
    );
    expect(rows.map((r) => r.detail)).toEqual([
      "team 'b' is nested inside team 'a' in cockpit.json",
      "team 'd' is nested inside team 'a' in cockpit.json",
      "team 'c' is nested inside team 'b' in cockpit.json",
    ]);
    for (const r of rows) {
      expect(r.status).toBe("yellow");
      expect(r.label).toBe("team-inside-team");
    }
  });

  test("no sessions field at all → []", () => {
    expect(teamInsideTeamRows({})).toEqual([]);
  });
});

// ---------- checkTeamInsideTeam (async, seams) ----------

describe("checkTeamInsideTeam", () => {
  test("cockpit absent (loader → null) → []", async () => {
    const rows = await checkTeamInsideTeam({ loadCockpitFn: async () => null });
    expect(rows).toEqual([]);
  });

  test("loader throws (cockpit present but refused) → one red cockpit.json row carrying the message, never swallowed", async () => {
    const rows = await checkTeamInsideTeam({
      loadCockpitFn: async () => {
        throw new Error("boom: prefixChain has 1 entries");
      },
    });
    expect(rows).toEqual([
      {
        status: "red",
        label: "cockpit.json",
        detail: "refused at load — boom: prefixChain has 1 entries",
        hint: COCKPIT_REFUSED_HINT,
      },
    ]);
  });

  test("injected cockpit with a nested pair → one row", async () => {
    const rows = await checkTeamInsideTeam({
      loadCockpitFn: async () =>
        cockpitWith({
          sessions: [
            {
              type: "team",
              name: "parent",
              root: "/p",
              enabled: true,
              sessions: [{ type: "team", name: "child", root: "/c", enabled: true, sessions: [] }],
            },
          ],
        }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("team-inside-team");
    expect(rows[0]?.detail).toBe("team 'child' is nested inside team 'parent' in cockpit.json");
  });

  describe("default cockpit loader (ATMUX_COCKPIT_CONFIG)", () => {
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env.ATMUX_COCKPIT_CONFIG;
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
      else process.env.ATMUX_COCKPIT_CONFIG = prev;
    });

    test("missing cockpit.json → absent arm → []", async () => {
      process.env.ATMUX_COCKPIT_CONFIG = join(dir, "missing-cockpit.json");
      expect(await checkTeamInsideTeam()).toEqual([]);
    });

    test("no ATMUX_COCKPIT_CONFIG and no HOME → path unresolvable → treated as absent → []", async () => {
      const prevHome = process.env.HOME;
      delete process.env.ATMUX_COCKPIT_CONFIG;
      delete process.env.HOME;
      try {
        expect(await checkTeamInsideTeam()).toEqual([]);
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    });

    test("real cockpit.json with a nested pair → one row through the production loader", async () => {
      const path = join(dir, "cockpit.json");
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          sessions: [
            {
              type: "team",
              name: "parent",
              root: "/p",
              sessions: [{ type: "team", name: "child", root: "/c" }],
            },
          ],
        }),
      );
      process.env.ATMUX_COCKPIT_CONFIG = path;
      // NB: the loader's own §D3 warning goes to process.stderr here —
      // expected noise, this test is about the probe row.
      const rows = await checkTeamInsideTeam();
      expect(rows).toEqual([
        {
          status: "yellow",
          label: "team-inside-team",
          detail: "team 'child' is nested inside team 'parent' in cockpit.json",
          hint: TEAM_INSIDE_TEAM_HINT,
        },
      ]);
    });

    test("cockpit.json refused at load (over-deep for its chain) → one red cockpit.json row naming node, depth, rung and chain length", async () => {
      const path = join(dir, "cockpit.json");
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          prefixChain: ["F1"],
          sessions: [
            {
              type: "team",
              name: "parent",
              root: "/p",
              sessions: [{ type: "team", name: "child", root: "/c" }],
            },
          ],
        }),
      );
      process.env.ATMUX_COCKPIT_CONFIG = path;
      // The pair exists, but the loader throws (§D4) before the probe
      // sees it — the refusal is surfaced as the red row (§D7), never
      // swallowed, and the advisory pair row does not appear.
      const rows = await checkTeamInsideTeam();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.status).toBe("red");
      expect(row?.label).toBe("cockpit.json");
      expect(row?.detail).toContain(
        `refused at load — cockpit.json at ${path}: 'child' (type team) sits at depth L3 and needs prefix rung 3, but prefixChain has 1 entries`,
      );
      expect(row?.detail).toContain(
        "add entries to cockpit.prefixChain or reduce nesting depth (ADR-287 §D4)",
      );
      expect(row?.hint).toBe(COCKPIT_REFUSED_HINT);
      expect(rows.some((r) => r.label === "team-inside-team")).toBe(false);
    });

    test("cockpit.json with a schema mismatch → one red cockpit.json row (SchemaError surfaced)", async () => {
      const path = join(dir, "cockpit.json");
      await writeFile(path, JSON.stringify({ schemaVersion: 1, sessions: "not-an-array" }));
      process.env.ATMUX_COCKPIT_CONFIG = path;
      const rows = await checkTeamInsideTeam();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("red");
      expect(rows[0]?.label).toBe("cockpit.json");
      expect(rows[0]?.detail).toContain(`refused at load — schema mismatch in ${path}`);
      expect(rows[0]?.hint).toBe(COCKPIT_REFUSED_HINT);
    });
  });
});

// ---------- cockpitLoadRefusedRow (pure) ----------

describe("cockpitLoadRefusedRow — pure", () => {
  test("Error → red cockpit.json row carrying err.message verbatim", () => {
    expect(
      cockpitLoadRefusedRow(new Error("schema mismatch in /x/cockpit.json: sessions bad")),
    ).toEqual({
      status: "red",
      label: "cockpit.json",
      detail: "refused at load — schema mismatch in /x/cockpit.json: sessions bad",
      hint: COCKPIT_REFUSED_HINT,
    });
  });

  test("non-Error throw value → String(value)", () => {
    expect(cockpitLoadRefusedRow("plain string").detail).toBe("refused at load — plain string");
    expect(cockpitLoadRefusedRow(42).detail).toBe("refused at load — 42");
  });
});

// ---------- deprecatedMemberWindowsRows (pure) ----------

describe("deprecatedMemberWindowsRows — pure", () => {
  test("no teams → []", () => {
    expect(deprecatedMemberWindowsRows([])).toEqual([]);
  });

  test("drivers-only teams (members: []) → []", () => {
    expect(deprecatedMemberWindowsRows([team("a", []), team("b", [])])).toEqual([]);
  });

  test("one team with members → one yellow row listing names and count", () => {
    expect(deprecatedMemberWindowsRows([team("atmux", ["lead", "planner", "reviewer"])])).toEqual([
      {
        status: "yellow",
        label: "deprecated-member-windows",
        detail: "team 'atmux' declares 3 member window(s): lead, planner, reviewer",
        hint: MEMBER_WINDOWS_HINT,
      },
    ]);
  });

  test("mixed fleet → one row per declaring team, input order, non-declaring teams skipped", () => {
    const rows = deprecatedMemberWindowsRows([
      team("drivers-only", []),
      team("unum", ["lead"]),
      team("also-drivers-only", []),
      team("aix", ["lead", "gitter"]),
    ]);
    expect(rows.map((r) => r.detail)).toEqual([
      "team 'unum' declares 1 member window(s): lead",
      "team 'aix' declares 2 member window(s): lead, gitter",
    ]);
  });
});

// ---------- checkDeprecatedMemberWindows (async, seams) ----------

describe("checkDeprecatedMemberWindows", () => {
  test("no current team + no cockpit → []", async () => {
    const rows = await checkDeprecatedMemberWindows(null, { loadCockpitFn: async () => null });
    expect(rows).toEqual([]);
  });

  test("current team declares members + no cockpit → one row for the current team", async () => {
    const rows = await checkDeprecatedMemberWindows(team("here", ["lead", "reviewer"]), {
      loadCockpitFn: async () => null,
    });
    expect(rows).toEqual([
      {
        status: "yellow",
        label: "deprecated-member-windows",
        detail: "team 'here' declares 2 member window(s): lead, reviewer",
        hint: MEMBER_WINDOWS_HINT,
      },
    ]);
  });

  test("drivers-only current team + no cockpit → []", async () => {
    const rows = await checkDeprecatedMemberWindows(team("here", []), {
      loadCockpitFn: async () => null,
    });
    expect(rows).toEqual([]);
  });

  test("loader throws (cockpit present but refused) → current team alone, no red row here (that row belongs to checkTeamInsideTeam)", async () => {
    const rows = await checkDeprecatedMemberWindows(team("here", ["lead"]), {
      loadCockpitFn: async () => {
        throw new Error("refused");
      },
    });
    expect(rows).toEqual([
      {
        status: "yellow",
        label: "deprecated-member-windows",
        detail: "team 'here' declares 1 member window(s): lead",
        hint: MEMBER_WINDOWS_HINT,
      },
    ]);
  });

  test("cockpit walk: rows for cockpit teams that load AND declare members; null roots skipped", async () => {
    const byRoot: Record<string, Team | null> = {
      "/a": team("a", ["lead"]),
      "/b": null,
      "/c": team("c", []),
    };
    const asked: string[] = [];
    const rows = await checkDeprecatedMemberWindows(null, {
      loadCockpitFn: async () =>
        cockpitWith({ teams: [{ root: "/a" }, { root: "/b" }, { root: "/c" }] }),
      loadTeamForRoot: async (root) => {
        asked.push(root);
        return byRoot[root] ?? null;
      },
    });
    expect(asked).toEqual(["/a", "/b", "/c"]);
    expect(rows.map((r) => r.detail)).toEqual(["team 'a' declares 1 member window(s): lead"]);
  });

  test("dedup by name: a cockpit team appearing twice, and the current team also in the cockpit, each count once", async () => {
    const rows = await checkDeprecatedMemberWindows(team("a", ["lead"]), {
      loadCockpitFn: async () => cockpitWith({ teams: [{ root: "/a" }, { root: "/a-again" }] }),
      loadTeamForRoot: async () => team("a", ["lead"]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe("team 'a' declares 1 member window(s): lead");
  });

  test("ordering: cockpit teams first, then the current team when it is not on the cockpit", async () => {
    const rows = await checkDeprecatedMemberWindows(team("solo", ["planner"]), {
      loadCockpitFn: async () => cockpitWith({ teams: [{ root: "/a" }] }),
      loadTeamForRoot: async () => team("a", ["lead"]),
    });
    expect(rows.map((r) => r.detail)).toEqual([
      "team 'a' declares 1 member window(s): lead",
      "team 'solo' declares 1 member window(s): planner",
    ]);
  });

  test("default loadTeamForRoot: reads <root>/.atmux/team.json; absent AND malformed roots are skipped", async () => {
    const withMembers = join(dir, "with-members");
    const driversOnly = join(dir, "drivers-only");
    const malformed = join(dir, "malformed");
    const absent = join(dir, "absent");
    for (const root of [withMembers, driversOnly, malformed]) {
      await mkdir(join(root, ".atmux"), { recursive: true });
    }
    await writeFile(
      join(withMembers, ".atmux", "team.json"),
      JSON.stringify({
        name: "px",
        members: [{ name: "lead", role: "team-lead", tui: "claude" }],
      }),
    );
    await writeFile(
      join(driversOnly, ".atmux", "team.json"),
      JSON.stringify({ name: "aix", drivers: [{ name: "driver", cwd: "." }], members: [] }),
    );
    await writeFile(join(malformed, ".atmux", "team.json"), "{not-json");
    const rows = await checkDeprecatedMemberWindows(null, {
      loadCockpitFn: async () =>
        cockpitWith({
          teams: [
            { root: withMembers },
            { root: driversOnly },
            { root: malformed },
            { root: absent },
          ],
        }),
    });
    expect(rows).toEqual([
      {
        status: "yellow",
        label: "deprecated-member-windows",
        detail: "team 'px' declares 1 member window(s): lead",
        hint: MEMBER_WINDOWS_HINT,
      },
    ]);
  });

  describe("default cockpit loader (ATMUX_COCKPIT_CONFIG)", () => {
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env.ATMUX_COCKPIT_CONFIG;
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
      else process.env.ATMUX_COCKPIT_CONFIG = prev;
    });

    test("missing cockpit.json → falls back to the current team alone", async () => {
      process.env.ATMUX_COCKPIT_CONFIG = join(dir, "missing-cockpit.json");
      const rows = await checkDeprecatedMemberWindows(team("here", ["lead"]));
      expect(rows.map((r) => r.detail)).toEqual(["team 'here' declares 1 member window(s): lead"]);
    });

    test("cockpit.json refused at load (over-deep) → production loader throws → current team alone, no red row here", async () => {
      const path = join(dir, "cockpit.json");
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          prefixChain: ["F1"],
          sessions: [{ type: "team", name: "solo", root: "/s" }],
        }),
      );
      process.env.ATMUX_COCKPIT_CONFIG = path;
      const rows = await checkDeprecatedMemberWindows(team("here", ["lead"]));
      expect(rows.map((r) => `${r.status}:${r.label}:${r.detail}`)).toEqual([
        "yellow:deprecated-member-windows:team 'here' declares 1 member window(s): lead",
      ]);
    });

    test("real cockpit.json → cockpit teams are walked through the production loader", async () => {
      const root = join(dir, "fleet-team");
      await mkdir(join(root, ".atmux"), { recursive: true });
      await writeFile(
        join(root, ".atmux", "team.json"),
        JSON.stringify({
          name: "fleet",
          members: [{ name: "gitter", role: "committer", tui: "claude" }],
        }),
      );
      const path = join(dir, "cockpit.json");
      await writeFile(
        path,
        JSON.stringify({ schemaVersion: 1, sessions: [{ type: "team", name: "fleet", root }] }),
      );
      process.env.ATMUX_COCKPIT_CONFIG = path;
      const rows = await checkDeprecatedMemberWindows(null);
      expect(rows.map((r) => r.detail)).toEqual([
        "team 'fleet' declares 1 member window(s): gitter",
      ]);
    });
  });
});
