// Unit tests for src/core/cockpit.ts — ADR-063 cockpit roster loader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATMUX_NESTING_LEVEL_ENV,
  cageSessionName,
  cageSocketPath,
  callerScopeAllowed,
  childNestingEnv,
  DEFAULT_PREFIX_CHAIN,
  defaultCockpitConfigPath,
  enabledTeams,
  findTeamByName,
  loadCockpit,
  MAX_NESTING_LEVEL,
  migrateLegacyShape,
  migrateSuperdoctorBlockToMedic,
  perTeamCageSocketPath,
  readNestingLevel,
  resolveCageSocket,
  resolveCockpitConfigPath,
  resolvePrefix,
  validatePrefixChain,
  walkSessions,
} from "../../../src/core/cockpit.ts";
import { ConfigError, SchemaError } from "../../../src/errors.ts";
import type {
  Cockpit as CockpitShape,
  CockpitSessionT,
} from "../../../src/schema/cockpit.ts";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "atmux-cockpit-test-"));
  await mkdir(join(homeDir, ".atmux"), { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

async function writeCockpit(body: unknown): Promise<string> {
  const path = join(homeDir, ".atmux", "cockpit.json");
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  return path;
}

describe("defaultCockpitConfigPath", () => {
  test("resolves to <home>/.atmux/cockpit.json", () => {
    expect(defaultCockpitConfigPath("/root")).toBe("/root/.atmux/cockpit.json");
    expect(defaultCockpitConfigPath("/Users/me")).toBe("/Users/me/.atmux/cockpit.json");
  });
});

describe("resolveCockpitConfigPath", () => {
  test("opts.path wins over env + home default", () => {
    expect(
      resolveCockpitConfigPath({
        path: "/explicit",
        env: { ATMUX_COCKPIT_CONFIG: "/from-env", HOME: "/h" },
      }),
    ).toBe("/explicit");
  });
  test("env.ATMUX_COCKPIT_CONFIG wins over home default", () => {
    expect(
      resolveCockpitConfigPath({ env: { ATMUX_COCKPIT_CONFIG: "/from-env", HOME: "/h" } }),
    ).toBe("/from-env");
  });
  test("falls through to <HOME>/.atmux/cockpit.json", () => {
    expect(resolveCockpitConfigPath({ env: { HOME: "/h" } })).toBe("/h/.atmux/cockpit.json");
  });
  test("opts.home overrides env.HOME", () => {
    expect(resolveCockpitConfigPath({ env: { HOME: "/h" }, home: "/other" })).toBe(
      "/other/.atmux/cockpit.json",
    );
  });
  test("throws ConfigError when neither home nor explicit path is set", () => {
    expect(() => resolveCockpitConfigPath({ env: {} })).toThrow(ConfigError);
  });
});

describe("loadCockpit", () => {
  test("reads + validates a valid roster", async () => {
    await writeCockpit({
      cockpitSession: "atmux_cockpit",
      teams: [
        { name: "sopx", root: "/p/sopx", enabled: true },
        { name: "atmux", root: "/p/atmux", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.cockpitSession).toBe("atmux_cockpit");
    expect(cockpit.teams).toHaveLength(2);
    expect(cockpit.teams[0]?.name).toBe("sopx");
  });

  test("applies cockpitSession default when omitted", async () => {
    await writeCockpit({ teams: [{ name: "x", root: "/x", enabled: true }] });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    // ADR-135: default is `atmux_cockpit` (was `atmux_teams` pre-rename).
    expect(cockpit.cockpitSession).toBe("atmux_cockpit");
  });

  test("ADR-135 §D5 — coerces legacy cockpitSession 'atmux_teams' literal → 'atmux_cockpit' with deprecation warning", async () => {
    await writeCockpit({
      cockpitSession: "atmux_teams",
      teams: [{ name: "x", root: "/x", enabled: true }],
    });
    const warnings: string[] = [];
    const cockpit = await loadCockpit({
      home: homeDir,
      warn: (m) => warnings.push(m),
    });
    // Coerced to canonical at parse time.
    expect(cockpit.cockpitSession).toBe("atmux_cockpit");
    // Deprecation warning fired.
    const warned = warnings.some(
      (m) => m.includes("cockpitSession literal 'atmux_teams'") && m.includes("ADR-135"),
    );
    expect(warned).toBe(true);
  });

  test("ADR-135 §D5 — operator-chosen arbitrary cockpitSession passes through unchanged (only legacy literal triggers shim)", async () => {
    await writeCockpit({
      cockpitSession: "geoyws_cockpit",
      teams: [{ name: "x", root: "/x", enabled: true }],
    });
    const warnings: string[] = [];
    const cockpit = await loadCockpit({
      home: homeDir,
      warn: (m) => warnings.push(m),
    });
    expect(cockpit.cockpitSession).toBe("geoyws_cockpit");
    // No ADR-135 deprecation warning for arbitrary names.
    const adr135Warned = warnings.some((m) => m.includes("ADR-135"));
    expect(adr135Warned).toBe(false);
  });

  test("applies team.enabled default (true) when omitted", async () => {
    await writeCockpit({ teams: [{ name: "x", root: "/x" }] });
    const cockpit = await loadCockpit({ home: homeDir });
    expect(cockpit.teams[0]?.enabled).toBe(true);
  });

  test("t-72a6b7d7: cageMode flows from session entry → synthesized legacy CockpitTeam", async () => {
    // Walks the loader's sessions[] → teams[] DFS to confirm
    // operator-declared cageMode survives the synthesis pass. Medic
    // sweeps + audit verbs read `cockpit.teams[].cageMode` directly.
    await writeCockpit({
      sessions: [
        { type: "team", name: "a", root: "/a", cageMode: "autonomous" },
        { type: "team", name: "b", root: "/b", cageMode: "direct" },
        { type: "team", name: "c", root: "/c", cageMode: "paused" },
        { type: "team", name: "d", root: "/d" }, // omitted → undefined (defaults at consumer layer)
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir });
    const byName = new Map(cockpit.teams.map((t) => [t.name, t.cageMode]));
    expect(byName.get("a")).toBe("autonomous");
    expect(byName.get("b")).toBe("direct");
    expect(byName.get("c")).toBe("paused");
    expect(byName.get("d")).toBeUndefined();
  });

  test("throws ConfigError with seed snippet when file missing", async () => {
    await expect(loadCockpit({ home: homeDir })).rejects.toThrow(ConfigError);
    try {
      await loadCockpit({ home: homeDir });
    } catch (e) {
      expect((e as ConfigError).message).toContain("no cockpit config");
      expect((e as ConfigError).message).toContain("seed it with a roster");
    }
  });

  test("throws SchemaError on malformed roster", async () => {
    await writeCockpit({ teams: [{ name: "" /* min 1 */, root: "/x" }] });
    await expect(loadCockpit({ home: homeDir })).rejects.toThrow(SchemaError);
  });

  test("rejects unknown keys on inner CockpitTeam (.strict)", async () => {
    await writeCockpit({
      teams: [{ name: "x", root: "/x", enabled: true, typo: "should-fail" }],
    });
    await expect(loadCockpit({ home: homeDir })).rejects.toThrow(SchemaError);
  });

  test("respects ATMUX_COCKPIT_CONFIG env override", async () => {
    const altPath = join(homeDir, "alt.json");
    await writeFile(
      altPath,
      JSON.stringify({ teams: [{ name: "alt", root: "/alt", enabled: true }] }),
      "utf8",
    );
    const cockpit = await loadCockpit({ env: { ATMUX_COCKPIT_CONFIG: altPath, HOME: homeDir } });
    expect(cockpit.teams[0]?.name).toBe("alt");
  });

  test("respects opts.path override", async () => {
    const altPath = join(homeDir, "explicit.json");
    await writeFile(
      altPath,
      JSON.stringify({ teams: [{ name: "ex", root: "/e", enabled: true }] }),
      "utf8",
    );
    const cockpit = await loadCockpit({ path: altPath });
    expect(cockpit.teams[0]?.name).toBe("ex");
  });
});

describe("enabledTeams", () => {
  test("returns only enabled entries in declared order", async () => {
    await writeCockpit({
      teams: [
        { name: "a", root: "/a", enabled: true },
        { name: "b", root: "/b", enabled: false },
        { name: "c", root: "/c", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir });
    const enabled = enabledTeams(cockpit);
    expect(enabled.map((t) => t.name)).toEqual(["a", "c"]);
  });
});

// HEAD's `resolveCageSocket(cockpitTeam, opts)` tests removed —
// superseded by ADR-063 follow-up (t-31bef86e) which switched the
// signature to `(teamName, teamRoot, deps)` with `exists`-based dual-
// probe. The new test suite below covers the same scenarios with the
// new contract. See merge commit body for the supersession trail.

describe("cageSocketPath", () => {
  test("returns /tmp/atmux-<team>/sock", () => {
    expect(cageSocketPath("sopx")).toBe("/tmp/atmux-sopx/sock");
    expect(cageSocketPath("atmux")).toBe("/tmp/atmux-atmux/sock");
  });
});

describe("perTeamCageSocketPath", () => {
  test("returns <teamRoot>/.atmux/tmux/tmux-<uid>/default", () => {
    const uid = process.getuid?.() ?? 0;
    expect(perTeamCageSocketPath("/p/sopx")).toBe(`/p/sopx/.atmux/tmux/tmux-${uid}/default`);
    expect(perTeamCageSocketPath("/root/work/src/atmux")).toBe(
      `/root/work/src/atmux/.atmux/tmux/tmux-${uid}/default`,
    );
  });
});

describe("resolveCageSocket (ADR-063 follow-up)", () => {
  test("returns legacy path when only legacy exists", async () => {
    const seen: string[] = [];
    const exists = async (p: string) => {
      seen.push(p);
      return p === "/tmp/atmux-x/sock";
    };
    expect(await resolveCageSocket("x", "/root/x", { exists })).toBe("/tmp/atmux-x/sock");
    // Probe stopped at legacy hit; per-team path never queried.
    expect(seen).toEqual(["/tmp/atmux-x/sock"]);
  });

  test("returns per-team path when only per-team exists", async () => {
    const perTeam = perTeamCageSocketPath("/root/x");
    const exists = async (p: string) => p === perTeam;
    expect(await resolveCageSocket("x", "/root/x", { exists })).toBe(perTeam);
  });

  test("returns legacy first when both exist (backward-compat precedence)", async () => {
    const exists = async () => true;
    expect(await resolveCageSocket("x", "/root/x", { exists })).toBe("/tmp/atmux-x/sock");
  });

  test("falls through to legacy when neither exists", async () => {
    const exists = async () => false;
    expect(await resolveCageSocket("x", "/root/x", { exists })).toBe("/tmp/atmux-x/sock");
  });

  test("probe order matches helper output (legacy → per-team)", async () => {
    const seen: string[] = [];
    const exists = async (p: string) => {
      seen.push(p);
      return false;
    };
    await resolveCageSocket("z", "/some/root", { exists });
    expect(seen).toEqual(["/tmp/atmux-z/sock", perTeamCageSocketPath("/some/root")]);
  });
});

describe("cageSessionName", () => {
  test("atmux team uses bare 'atmux' session", () => {
    expect(cageSessionName("atmux")).toBe("atmux");
  });
  test("every other team uses 'atmux_<name>'", () => {
    expect(cageSessionName("sopx")).toBe("atmux_sopx");
    expect(cageSessionName("unum")).toBe("atmux_unum");
  });
});

// ---------- ADR-089: migration shim ----------

describe("migrateLegacyShape — flat teams[] → recursive sessions[]", () => {
  test("legacy flat with one team lifts cleanly", () => {
    const warned: string[] = [];
    const out = migrateLegacyShape(
      { teams: [{ name: "sopx", root: "/p/sopx", enabled: true }] },
      "/fake/path.json",
      (m) => warned.push(m),
    );
    expect(out).toMatchObject({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "sopx", root: "/p/sopx", enabled: true }],
    });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("legacy flat teams[]");
    expect(warned[0]).toContain("/fake/path.json");
  });
  test("legacy singleton superdoctor lifts into sessions[]", () => {
    const out = migrateLegacyShape(
      {
        teams: [{ name: "x", root: "/x", enabled: true }],
        superdoctor: { enabled: true },
      },
      "/p.json",
      () => {},
    ) as { sessions: Array<Record<string, unknown>> };
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions[1]).toMatchObject({
      type: "superdoctor",
      name: "superdoctor",
      enabled: true,
    });
  });
  test("already-new shape (sessions[]) passes through without warning", () => {
    const warned: string[] = [];
    const input = {
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
    };
    const out = migrateLegacyShape(input, "/p.json", (m) => warned.push(m));
    expect(out).toBe(input);
    expect(warned).toHaveLength(0);
  });
  test("input without teams[] or sessions[] passes through unchanged", () => {
    const warned: string[] = [];
    const input = { cockpitSession: "atmux_teams" };
    const out = migrateLegacyShape(input, "/p.json", (m) => warned.push(m));
    expect(out).toBe(input);
    expect(warned).toHaveLength(0);
  });
  test("non-object input passes through unchanged", () => {
    const warned: string[] = [];
    expect(migrateLegacyShape(null, "/p.json", (m) => warned.push(m))).toBe(null);
    expect(migrateLegacyShape("string", "/p.json", (m) => warned.push(m))).toBe("string");
    expect(warned).toHaveLength(0);
  });
});

describe("loadCockpit — migration shim end-to-end", () => {
  test("legacy flat teams[] roster still loads + warns", async () => {
    const warned: string[] = [];
    // Use canonical cockpitSession to keep this test focused on the
    // teams[]-shape shim — the ADR-135 cockpitSession-literal shim is
    // covered separately above and would produce an extra warning that
    // muddies the assertion.
    await writeCockpit({
      cockpitSession: "atmux_cockpit",
      teams: [
        { name: "sopx", root: "/p/sopx", enabled: true },
        { name: "atmux", root: "/p/atmux", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.sessions).toHaveLength(2);
    expect(cockpit.sessions[0]?.type).toBe("team");
    expect(cockpit.teams).toHaveLength(2);
    expect(cockpit.teams[0]?.name).toBe("sopx");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("legacy flat teams[]");
  });
  test("legacy roster with superdoctor lifts both into sessions[]", async () => {
    await writeCockpit({
      teams: [{ name: "x", root: "/x", enabled: true }],
      superdoctor: { enabled: true },
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.sessions).toHaveLength(2);
    // Legacy back-compat: synthesized superdoctor singleton field still
    // populated from the lifted sessions[] entry.
    expect(cockpit.superdoctor?.enabled).toBe(true);
  });
  test("new sessions[]-shape roster loads without warning", async () => {
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "superdriver", name: "superdriver" },
        { type: "team", name: "sopx", root: "/p/sopx" },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.sessions).toHaveLength(2);
    expect(warned).toHaveLength(0);
  });
  test("loaded cockpit synthesizes legacy teams[] from sessions[]", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "superdriver", name: "sd" },
        { type: "team", name: "sopx", root: "/p/sopx" },
        {
          type: "team",
          name: "outer",
          root: "/p/outer",
          sessions: [{ type: "team", name: "inner", root: "/p/inner" }],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    // Synthesized teams[]: DFS-ordered, type==="team" only. Excludes
    // superdriver (cockpit singleton) but INCLUDES nested team children.
    expect(cockpit.teams.map((t) => t.name)).toEqual(["sopx", "outer", "inner"]);
  });
});

// ---------- ADR-133 TR2: migrateSuperdoctorBlockToMedic shim ----------

describe("migrateSuperdoctorBlockToMedic — top-level superdoctor → medic", () => {
  test("only `superdoctor` set → lifts to `medic` + warns deprecated", () => {
    const warned: string[] = [];
    const out = migrateSuperdoctorBlockToMedic(
      {
        schemaVersion: 1,
        sessions: [],
        superdoctor: { enabled: true, autoStart: false },
      },
      "/fake/path.json",
      (m) => warned.push(m),
    ) as Record<string, unknown>;
    expect(out.medic).toEqual({ enabled: true, autoStart: false });
    expect(out.superdoctor).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("deprecated top-level 'superdoctor' key");
    expect(warned[0]).toContain("rename to 'medic'");
    expect(warned[0]).toContain("ADR-133");
    expect(warned[0]).toContain("/fake/path.json");
  });

  test("only `medic` set → no-op, no warning", () => {
    const warned: string[] = [];
    const input = {
      schemaVersion: 1,
      sessions: [],
      medic: { enabled: true },
    };
    const out = migrateSuperdoctorBlockToMedic(input, "/p.json", (m) => warned.push(m));
    expect(out).toBe(input);
    expect(warned).toHaveLength(0);
  });

  test("BOTH `medic` and `superdoctor` set → medic wins, superdoctor stripped, warns dual", () => {
    const warned: string[] = [];
    const out = migrateSuperdoctorBlockToMedic(
      {
        schemaVersion: 1,
        sessions: [],
        medic: { enabled: true },
        superdoctor: { enabled: false }, // operator forgot to delete this
      },
      "/p.json",
      (m) => warned.push(m),
    ) as Record<string, unknown>;
    expect(out.medic).toEqual({ enabled: true });
    expect(out.superdoctor).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("BOTH");
    expect(warned[0]).toContain("'medic' wins");
    expect(warned[0]).toContain("ADR-133");
  });

  test("neither set → passes through unchanged + no warning", () => {
    const warned: string[] = [];
    const input = { schemaVersion: 1, sessions: [] };
    const out = migrateSuperdoctorBlockToMedic(input, "/p.json", (m) => warned.push(m));
    expect(out).toBe(input);
    expect(warned).toHaveLength(0);
  });

  test("non-object input passes through unchanged", () => {
    const warned: string[] = [];
    expect(migrateSuperdoctorBlockToMedic(null, "/p.json", (m) => warned.push(m))).toBe(null);
    expect(migrateSuperdoctorBlockToMedic("string", "/p.json", (m) => warned.push(m))).toBe(
      "string",
    );
    expect(warned).toHaveLength(0);
  });

  test("preserves all other top-level fields when lifting", () => {
    const warned: string[] = [];
    const out = migrateSuperdoctorBlockToMedic(
      {
        schemaVersion: 1,
        cockpitSession: "custom_session",
        sessions: [{ type: "team", name: "x", root: "/x" }],
        prefixChain: ["F1", "F2"],
        superdoctor: { enabled: true },
      },
      "/p.json",
      (m) => warned.push(m),
    ) as Record<string, unknown>;
    expect(out.schemaVersion).toBe(1);
    expect(out.cockpitSession).toBe("custom_session");
    expect(out.sessions).toEqual([{ type: "team", name: "x", root: "/x" }]);
    expect(out.prefixChain).toEqual(["F1", "F2"]);
    expect(out.medic).toEqual({ enabled: true });
    expect(out.superdoctor).toBeUndefined();
  });
});

describe("loadCockpit — ADR-133 TR2 medic / superdoctor end-to-end", () => {
  test("config with only `medic` block → cockpit.medic populated, no warning", async () => {
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
      medic: { enabled: true },
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic?.enabled).toBe(true);
    expect(warned).toHaveLength(0);
  });

  test("config with only `superdoctor` top-level block → cockpit.medic populated + deprecation warn", async () => {
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
      superdoctor: { enabled: true },
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic?.enabled).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("deprecated top-level 'superdoctor'");
    expect(warned[0]).toContain("ADR-133");
  });

  test("config with BOTH `medic` and `superdoctor` → medic wins + dual-key warn", async () => {
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
      medic: { enabled: true, autoStart: false },
      superdoctor: { enabled: false },
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic?.enabled).toBe(true);
    expect(cockpit.medic?.autoStart).toBe(false);
    // ADR-133 back-compat: cockpit.superdoctor is intentionally surfaced
    // as the resolved medic shape during the deprecation window (per
    // src/core/cockpit.ts::enrichLegacyFields synthesis comment "Surface
    // BOTH `medic` (canonical) AND `superdoctor` (deprecated alias)").
    // Duck-typed callers reading either field see the same shape.
    expect(cockpit.superdoctor?.enabled).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("BOTH");
    expect(warned[0]).toContain("'medic' wins");
  });

  test("config with neither key → defaults applied, both fields undefined", async () => {
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic).toBeUndefined();
    expect(cockpit.superdoctor).toBeUndefined();
    expect(warned).toHaveLength(0);
  });

  test('sessions[] `type: "superdoctor"` entry synthesizes BOTH cockpit.medic AND cockpit.superdoctor', async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "team", name: "x", root: "/x" },
        { type: "superdoctor", name: "sd", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.superdoctor?.enabled).toBe(true);
    expect(cockpit.medic?.enabled).toBe(true);
  });

  test('sessions[] `type: "medic"` entry synthesizes BOTH cockpit.medic AND cockpit.superdoctor (canonical path)', async () => {
    // ADR-133 canonical session-walk path — operators landing on the
    // new discriminator literal get both back-compat fields populated
    // so duck-typed callers across the deprecation window keep working.
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "superdriver", name: "superdriver" },
        { type: "medic", name: "medic", enabled: true },
        { type: "team", name: "sopx", root: "/p/sopx" },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic?.enabled).toBe(true);
    expect(cockpit.superdoctor?.enabled).toBe(true);
    expect(warned).toHaveLength(0);
  });

  test("legacy flat roster (teams[] + superdoctor) shape-migrates first, no top-level superdoctor remains after shim", async () => {
    // Legacy flat case: migrateLegacyShape lifts both teams[] + the
    // top-level superdoctor INTO sessions[]; by the time the medic
    // shim runs, the on-disk top-level superdoctor key is already
    // gone. Only ADR-089 §B warning fires; no ADR-133 warning fires.
    const warned: string[] = [];
    await writeCockpit({
      teams: [{ name: "x", root: "/x", enabled: true }],
      superdoctor: { enabled: true },
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic?.enabled).toBe(true);
    expect(cockpit.superdoctor?.enabled).toBe(true);
    // Two warnings legitimately fire from `migrateLegacyShape`:
    //   (1) ADR-089 flat-shape lift warning (`legacy flat teams[]`)
    //   (2) ADR-133 deprecated-superdoctor warning (`deprecated
    //       'superdoctor' block — rename to 'medic'`) — fired when the
    //       lift sees a top-level `superdoctor` without a paired
    //       `medic` block.
    // The TR2 medic shim (`migrateSuperdoctorBlockToMedic`) itself
    // does NOT fire — migrateLegacyShape already stripped the
    // top-level superdoctor during the flat-to-recursive lift, so by
    // the time the TR2 shim runs the on-disk top-level superdoctor is
    // gone. So the "no double-warn from the TR2 shim" intent of the
    // original assertion is preserved; the second warning is from the
    // ADR-089 lift, NOT the TR2 shim.
    expect(warned).toHaveLength(2);
    expect(warned.some((m) => m.includes("legacy flat teams[]"))).toBe(true);
    expect(warned.some((m) => m.includes("deprecated 'superdoctor' block"))).toBe(true);
  });
});

// ---------- ADR-089: walkSessions DFS ----------

describe("walkSessions — depth-first traversal", () => {
  test("visits flat siblings in declared order at level 0", () => {
    const seen: Array<{ name: string; level: number }> = [];
    const sessions: CockpitSessionT[] = [
      { type: "team", name: "a", root: "/a", enabled: true, sessions: [] },
      { type: "team", name: "b", root: "/b", enabled: true, sessions: [] },
      { type: "team", name: "c", root: "/c", enabled: true, sessions: [] },
    ];
    walkSessions(sessions, 0, (node, level) => {
      seen.push({ name: node.name, level });
    });
    expect(seen).toEqual([
      { name: "a", level: 0 },
      { name: "b", level: 0 },
      { name: "c", level: 0 },
    ]);
  });
  test("descends into nested team children DFS-first", () => {
    const seen: Array<{ name: string; level: number }> = [];
    const sessions: CockpitSessionT[] = [
      {
        type: "team",
        name: "L0",
        root: "/L0",
        enabled: true,
        sessions: [
          {
            type: "team",
            name: "L1a",
            root: "/L1a",
            enabled: true,
            sessions: [{ type: "team", name: "L2", root: "/L2", enabled: true, sessions: [] }],
          },
          { type: "team", name: "L1b", root: "/L1b", enabled: true, sessions: [] },
        ],
      },
    ];
    walkSessions(sessions, 0, (node, level) => {
      seen.push({ name: node.name, level });
    });
    expect(seen).toEqual([
      { name: "L0", level: 0 },
      { name: "L1a", level: 1 },
      { name: "L2", level: 2 },
      { name: "L1b", level: 1 },
    ]);
  });
  test("threads parentRoot to epic-team descendants", () => {
    const seen: Array<{ name: string; parentRoot: string | undefined }> = [];
    const sessions: CockpitSessionT[] = [
      {
        type: "team",
        name: "sopx",
        root: "/p/sopx",
        enabled: true,
        sessions: [
          {
            type: "epic-team",
            name: "sopx-deferred",
            parent: "sopx",
            epicId: "e-1",
            enabled: true,
            sessions: [],
          },
        ],
      },
    ];
    walkSessions(sessions, 0, (node, _level, parentRoot) => {
      seen.push({ name: node.name, parentRoot });
    });
    expect(seen[0]?.parentRoot).toBeUndefined(); // top-level team has no parent
    expect(seen[1]?.parentRoot).toBe("/p/sopx"); // nested epic-team inherits
  });
});

// ---------- ADR-089: enabledTeams DFS flattener ----------

describe("enabledTeams — DFS flattener with level annotation", () => {
  test("flattens nested team tree depth-first with level annotation", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "superdriver", name: "sd" },
        {
          type: "team",
          name: "outer",
          root: "/p/outer",
          sessions: [
            {
              type: "team",
              name: "inner-a",
              root: "/p/inner-a",
              sessions: [{ type: "team", name: "leaf", root: "/p/leaf" }],
            },
            { type: "team", name: "inner-b", root: "/p/inner-b" },
          ],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    // superdriver excluded; teams DFS-ordered.
    expect(flat.map((t) => ({ name: t.name, level: t.level }))).toEqual([
      { name: "outer", level: 0 },
      { name: "inner-a", level: 1 },
      { name: "leaf", level: 2 },
      { name: "inner-b", level: 1 },
    ]);
  });
  test("skips type=team entries with enabled=false at any depth", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "team", name: "on", root: "/on" },
        { type: "team", name: "off", root: "/off", enabled: false },
        {
          type: "team",
          name: "parent",
          root: "/parent",
          sessions: [
            { type: "team", name: "child-off", root: "/c-off", enabled: false },
            { type: "team", name: "child-on", root: "/c-on" },
          ],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    expect(flat.map((t) => t.name)).toEqual(["on", "parent", "child-on"]);
  });
  test("epic-team entries inherit parent's root in flattened output", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
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
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toMatchObject({ type: "team", name: "sopx", root: "/p/sopx", level: 0 });
    expect(flat[1]).toMatchObject({
      type: "epic-team",
      name: "sopx-deferred",
      root: "/p/sopx", // inherited from parent
      level: 1,
      parent: "sopx",
      epicId: "e-1",
    });
  });
  test("legacy flat teams[] roster flattens with all at level 0", async () => {
    // Migration shim lifts legacy flat into single-level sessions[], so
    // the flattened result is the same as the legacy enabledTeams shape.
    await writeCockpit({
      teams: [
        { name: "a", root: "/a", enabled: true },
        { name: "b", root: "/b", enabled: false },
        { name: "c", root: "/c", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    expect(flat.map((t) => t.name)).toEqual(["a", "c"]);
    expect(flat.every((t) => t.level === 0)).toBe(true);
  });
});

// ---------- Schema validation — unknown discriminator strict refuse ----------

describe("loadCockpit — discriminated union strict mode", () => {
  test("rejects sessions[] entry with unknown `type` value", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "rogue-session-type", name: "x" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(SchemaError);
  });
  test("rejects legacy teams[] entry with unknown leaf key (post-shim .strict)", async () => {
    // The migration shim lifts teams[] entries verbatim into sessions[]
    // (type-tagged), so unknown leaf keys still surface via TeamSession's
    // .strict() rejection.
    await writeCockpit({
      teams: [{ name: "x", root: "/x", typo: "should-fail" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(SchemaError);
  });
});

// ---------- ADR-089 §C: prefix-chain + ATMUX_NESTING_LEVEL ----------

describe("DEFAULT_PREFIX_CHAIN — F-key default ladder", () => {
  test("contains 12 entries (F1..F12)", () => {
    expect(DEFAULT_PREFIX_CHAIN).toHaveLength(12);
    expect(DEFAULT_PREFIX_CHAIN[0]).toBe("F1");
    expect(DEFAULT_PREFIX_CHAIN[11]).toBe("F12");
  });

  test("covers MAX_NESTING_LEVEL with headroom", () => {
    expect(DEFAULT_PREFIX_CHAIN.length).toBeGreaterThanOrEqual(MAX_NESTING_LEVEL);
  });

  test("all entries are unique", () => {
    expect(new Set(DEFAULT_PREFIX_CHAIN).size).toBe(DEFAULT_PREFIX_CHAIN.length);
  });
});

describe("readNestingLevel — env-driven level parser", () => {
  test("missing env var → 1 (top-level default)", () => {
    expect(readNestingLevel({})).toBe(1);
  });

  test("empty env value → 1 (defensive)", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "" })).toBe(1);
  });

  test("valid integer → parsed value", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "3" })).toBe(3);
  });

  test("non-numeric → falls back to 1", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "abc" })).toBe(1);
  });

  test("zero / negative → falls back to 1", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "0" })).toBe(1);
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "-2" })).toBe(1);
  });
});

describe("resolvePrefix — level → prefix lookup", () => {
  test("level=1 on default chain → F1", () => {
    expect(resolvePrefix(1)).toBe("F1");
  });

  test("level=4 on default chain → F4", () => {
    expect(resolvePrefix(4)).toBe("F4");
  });

  test("operator override chain wins over default", () => {
    expect(resolvePrefix(1, ["C-q", "C-w", "C-e", "C-r", "C-t", "C-y"])).toBe("C-q");
    expect(resolvePrefix(3, ["C-q", "C-w", "C-e", "C-r", "C-t", "C-y"])).toBe("C-e");
  });

  test("empty chain falls back to default (length-0 treated as unset)", () => {
    expect(resolvePrefix(2, [])).toBe("F2");
  });

  test("level=0 → ConfigError (must be positive)", () => {
    expect(() => resolvePrefix(0)).toThrow(ConfigError);
  });

  test("level exceeds chain length → ConfigError with helpful hint", () => {
    expect(() => resolvePrefix(7, ["F1", "F2", "F3"])).toThrow(/exceeds prefix chain length/);
  });

  test("non-integer level → ConfigError", () => {
    expect(() => resolvePrefix(1.5)).toThrow(ConfigError);
  });
});

describe("validatePrefixChain — load-time validation", () => {
  test("happy path — long unique chain → ok", () => {
    const v = validatePrefixChain(["F1", "F2", "F3", "F4", "F5", "F6"]);
    expect(v.ok).toBe(true);
  });

  test("chain shorter than MAX_NESTING_LEVEL → not ok with explicit reason", () => {
    const v = validatePrefixChain(["F1", "F2", "F3"]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(`≥${MAX_NESTING_LEVEL}`);
  });

  test("duplicate entry → not ok with collision reason", () => {
    const v = validatePrefixChain(["F1", "F2", "F2", "F3", "F4", "F5"]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("duplicated");
    expect(v.reason).toContain("F2");
  });

  test("empty entry → not ok", () => {
    const v = validatePrefixChain(["F1", "", "F3", "F4", "F5", "F6"]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("empty");
  });

  test("operator-preferred mobile chain (Ctrl-letter) → ok when long enough", () => {
    const v = validatePrefixChain(["C-q", "C-w", "C-e", "C-r", "C-t", "C-y"]);
    expect(v.ok).toBe(true);
  });
});

describe("childNestingEnv — parent → child level propagation (§Decision-anchor #5)", () => {
  test("parentLevel=1 → child env carries ATMUX_NESTING_LEVEL=2", () => {
    expect(childNestingEnv(1)).toEqual({ [ATMUX_NESTING_LEVEL_ENV]: "2" });
  });

  test("parentLevel=2 → child env carries ATMUX_NESTING_LEVEL=3", () => {
    expect(childNestingEnv(2)).toEqual({ [ATMUX_NESTING_LEVEL_ENV]: "3" });
  });

  test("parentLevel=0 → ConfigError (must be ≥1)", () => {
    expect(() => childNestingEnv(0)).toThrow(ConfigError);
  });

  test("parentLevel would push child past MAX_NESTING_LEVEL → ConfigError", () => {
    expect(() => childNestingEnv(MAX_NESTING_LEVEL)).toThrow(/exceed max depth/);
  });

  test("non-integer parentLevel → ConfigError", () => {
    expect(() => childNestingEnv(1.5)).toThrow(ConfigError);
  });
});

describe("loadCockpit — prefixChain validation (§Decision-anchor #4)", () => {
  test("valid 6+ unique chain → load succeeds", async () => {
    await writeCockpit({
      schemaVersion: 1,
      prefixChain: ["F1", "F2", "F3", "F4", "F5", "F6"],
      sessions: [{ type: "team", name: "x", root: "/x" }],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.prefixChain).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
  });

  test("missing prefixChain → load succeeds (default-chain fallback)", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.prefixChain).toBeUndefined();
  });

  test("too-short prefixChain → ConfigError at load", async () => {
    await writeCockpit({
      schemaVersion: 1,
      prefixChain: ["F1", "F2"],
      sessions: [{ type: "team", name: "x", root: "/x" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(ConfigError);
  });

  test("duplicate-entry prefixChain → ConfigError at load", async () => {
    await writeCockpit({
      schemaVersion: 1,
      prefixChain: ["F1", "F2", "F2", "F3", "F4", "F5"],
      sessions: [{ type: "team", name: "x", root: "/x" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(/duplicated/);
  });
});

// ---------- ADR-092: findTeamByName + callerScopeAllowed ----------

/** Helper — synthesize a minimal CockpitShape with a depth-3 fixture
 *  (`alpha` team with epic-team `alpha-epic-1` child; `beta` team
 *  standalone; `omega` epic-team under `beta`). Used by ADR-092 tests. */
function buildFixtureCockpit(): CockpitShape {
  return {
    schemaVersion: 1,
    sessions: [
      {
        type: "team",
        name: "alpha",
        enabled: true,
        root: "/teams/alpha",
        sessions: [
          {
            type: "epic-team",
            name: "alpha-epic-1",
            enabled: true,
            parent: "alpha",
            epicId: "e-alpha-1",
            sessions: [],
          },
        ],
      },
      {
        type: "team",
        name: "beta",
        enabled: true,
        root: "/teams/beta",
        sessions: [
          {
            type: "epic-team",
            name: "beta-omega",
            enabled: true,
            parent: "beta",
            epicId: "e-beta-omega",
            sessions: [],
          },
        ],
      },
    ],
    teams: [],
  } as unknown as CockpitShape;
}

describe("findTeamByName (ADR-092 §D2)", () => {
  test("matches type=team at root with own root", () => {
    const found = findTeamByName(buildFixtureCockpit(), "alpha");
    expect(found?.type).toBe("team");
    expect(found?.root).toBe("/teams/alpha");
    expect(found?.level).toBe(0);
    expect(found?.parent).toBeUndefined();
  });

  test("matches type=epic-team nested with parent root inherited", () => {
    const found = findTeamByName(buildFixtureCockpit(), "alpha-epic-1");
    expect(found?.type).toBe("epic-team");
    expect(found?.root).toBe("/teams/alpha");
    expect(found?.parent).toBe("alpha");
    expect(found?.level).toBe(1);
  });

  test("returns null on miss", () => {
    expect(findTeamByName(buildFixtureCockpit(), "nonexistent")).toBeNull();
  });

  test("walks depth-3 fixture deterministically (first match wins)", () => {
    // Add a sibling-named epic under beta with same name as alpha's
    // child to verify FIRST match by DFS order wins (Decision-anchor
    // #2 — name collision is operator error; lookup is deterministic).
    const cockpit = buildFixtureCockpit();
    (cockpit.sessions[1] as { sessions: CockpitSessionT[] }).sessions.push({
      type: "epic-team",
      name: "alpha-epic-1",
      enabled: true,
      parent: "beta",
      epicId: "e-clash",
      sessions: [],
    } as never);
    const found = findTeamByName(cockpit, "alpha-epic-1");
    // First match is under alpha (DFS visits alpha branch before beta).
    expect(found?.parent).toBe("alpha");
  });

  test("skips superdriver / medic / sentinel leaves (only team / epic-team)", () => {
    const cockpit: CockpitShape = {
      schemaVersion: 1,
      sessions: [
        { type: "medic", name: "alpha", enabled: true },
        { type: "superdriver", name: "alpha-driver", enabled: true },
      ],
      teams: [],
    } as unknown as CockpitShape;
    // The medic literally named "alpha" is NOT matched — only
    // team / epic-team types qualify.
    expect(findTeamByName(cockpit, "alpha")).toBeNull();
  });
});

describe("callerScopeAllowed (ADR-092 §D3)", () => {
  test("driver scope is master override", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "beta", "driver")).toBe(true);
    expect(callerScopeAllowed(cockpit, "alpha-epic-1", "beta-omega", "driver")).toBe(true);
  });

  test("same-team is trivially allowed", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "alpha", undefined)).toBe(true);
  });

  test("child epic-team → parent team allowed", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha-epic-1", "alpha", undefined)).toBe(true);
  });

  test("parent team → child epic-team allowed", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "alpha-epic-1", undefined)).toBe(true);
  });

  test("siblings under different parents refused", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha-epic-1", "beta-omega", undefined)).toBe(false);
  });

  test("siblings under SAME parent refused — must route via parent", () => {
    const cockpit = buildFixtureCockpit();
    // Add a sibling epic under alpha so we have two epic-teams sharing
    // parent=alpha. Per ADR-092 §D3 reviewer pre-flag: siblings must
    // route through the parent.
    (cockpit.sessions[0] as { sessions: CockpitSessionT[] }).sessions.push({
      type: "epic-team",
      name: "alpha-epic-2",
      enabled: true,
      parent: "alpha",
      epicId: "e-alpha-2",
      sessions: [],
    } as never);
    expect(
      callerScopeAllowed(cockpit, "alpha-epic-1", "alpha-epic-2", undefined),
    ).toBe(false);
  });

  test("unrelated standalone teams refused", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "beta", undefined)).toBe(false);
  });

  test("unknown source/target falls through to refused", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "ghost", "alpha", undefined)).toBe(false);
    expect(callerScopeAllowed(cockpit, "alpha", "ghost", undefined)).toBe(false);
  });
});
