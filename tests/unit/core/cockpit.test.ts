// Unit tests for src/core/cockpit.ts — ADR-063 cockpit roster loader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATMUX_NESTING_LEVEL_ENV,
  buildGroupTopology,
  cageSessionName,
  cageSocketPath,
  callerScopeAllowed,
  childNestingEnv,
  DEFAULT_PREFIX_CHAIN,
  defaultCockpitConfigPath,
  enabledTeams,
  findTeamByName,
  groupSocketPath,
  loadCockpit,
  MAX_NESTING_LEVEL,
  migrateLegacyShape,
  perTeamCageSocketPath,
  readNestingLevel,
  rejectSuperdoctorConfig,
  resolveCageSessionName,
  resolveCageSocket,
  resolveCockpitConfigPath,
  resolvePrefix,
  resolveTopLevelGroup,
  validatePrefixChain,
  walkSessions,
} from "../../../src/core/cockpit.ts";
import { ConfigError, SchemaError } from "../../../src/errors.ts";
import type { CockpitSessionT, Cockpit as CockpitShape } from "../../../src/schema/cockpit.ts";

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
  test("a-e0199c53 regression: opts.home outranks env.ATMUX_COCKPIT_CONFIG", () => {
    // Every atmux cage exports ATMUX_COCKPIT_CONFIG, so when the env var
    // resolved BEFORE opts.home, the documented test-injection point
    // silently lost to ambient env and tests read the operator's real
    // 20-session cockpit (found 2026-08-27 when a deleted test file
    // changed which tests saw it). Programmatic injection must win.
    expect(
      resolveCockpitConfigPath({
        env: { ATMUX_COCKPIT_CONFIG: "/operators/real/cockpit.json", HOME: "/h" },
        home: "/injected",
      }),
    ).toBe("/injected/.atmux/cockpit.json");
  });
  test("a-e0199c53 regression: loadCockpit with injected home ignores env.ATMUX_COCKPIT_CONFIG", async () => {
    await writeCockpit({ teams: [{ name: "inj", root: "/inj", enabled: true }] });
    const cockpit = await loadCockpit({
      home: homeDir,
      env: { ATMUX_COCKPIT_CONFIG: "/nonexistent/operator-cockpit.json", HOME: "/h" },
      warn: () => {},
    });
    // Had env won, this load would have thrown ConfigError (no file at
    // the env path); instead the injected home's roster is read.
    expect(cockpit.teams.map((t) => t.name)).toEqual(["inj"]);
  });
  test("throws ConfigError when neither home nor explicit path is set", () => {
    expect(() => resolveCockpitConfigPath({ env: {} })).toThrow(ConfigError);
  });
});

describe("loadCockpit", () => {
  test("reads + validates a valid roster", async () => {
    await writeCockpit({
      cockpitSession: "atx",
      teams: [
        { name: "sopx", root: "/p/sopx", enabled: true },
        { name: "atmux", root: "/p/atmux", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.cockpitSession).toBe("atx");
    expect(cockpit.teams).toHaveLength(2);
    expect(cockpit.teams[0]?.name).toBe("sopx");
  });

  test("applies cockpitSession default when omitted", async () => {
    await writeCockpit({ teams: [{ name: "x", root: "/x", enabled: true }] });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    // ADR-264: default is `atx` (was `atmux_cockpit` per ADR-135,
    // `atmux_teams` pre-ADR-135).
    expect(cockpit.cockpitSession).toBe("atx");
  });

  test("ADR-279 — preserves explicit cockpitSession 'atmux_teams' literally", async () => {
    await writeCockpit({
      cockpitSession: "atmux_teams",
      teams: [{ name: "x", root: "/x", enabled: true }],
    });
    const warnings: string[] = [];
    const cockpit = await loadCockpit({
      home: homeDir,
      warn: (m) => warnings.push(m),
    });
    expect(cockpit.cockpitSession).toBe("atmux_teams");
    expect(warnings.some((m) => m.includes("ADR-264"))).toBe(false);
  });

  test("ADR-279 — preserves explicit cockpitSession 'atmux_cockpit' literally", async () => {
    await writeCockpit({
      cockpitSession: "atmux_cockpit",
      teams: [{ name: "x", root: "/x", enabled: true }],
    });
    const warnings: string[] = [];
    const cockpit = await loadCockpit({
      home: homeDir,
      warn: (m) => warnings.push(m),
    });
    expect(cockpit.cockpitSession).toBe("atmux_cockpit");
    expect(warnings.some((m) => m.includes("ADR-264"))).toBe(false);
  });

  test("ADR-279 — operator-chosen arbitrary cockpitSession passes through unchanged", async () => {
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
    // No ADR-264 deprecation warning for arbitrary names.
    const adr264Warned = warnings.some((m) => m.includes("ADR-264"));
    expect(adr264Warned).toBe(false);
  });

  test("ADR-279 — loads operator windows and defaults null command to declarative null", async () => {
    await writeCockpit({
      sessions: [{ type: "team", name: "x", root: "/x" }],
      windows: [{ name: "_misc", cwd: "/root/work", command: null }],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.windows).toEqual([
      { name: "_misc", enabled: true, cwd: "/root/work", command: null },
    ]);
  });

  test("ADR-279 — rejects operator-window collisions with role and team names", async () => {
    await writeCockpit({
      sessions: [{ type: "team", name: "x", root: "/x" }],
      windows: [{ name: "x", cwd: "/root/work" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(ConfigError);

    await writeCockpit({ windows: [{ name: "_medic", cwd: "/root/work" }] });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(ConfigError);

    // e-419553c6: GROUP names occupy the cockpit window namespace too —
    // a top-level group gets a cockpit viewer window embedding its server.
    await writeCockpit({
      sessions: [
        { type: "group", name: "geoyws", sessions: [{ type: "team", name: "t", root: "/t" }] },
      ],
      windows: [{ name: "geoyws", cwd: "/root/work" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(ConfigError);
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

describe("cageSessionName (deprecated synchronous)", () => {
  test("atmux team uses bare 'atmux' session", () => {
    expect(cageSessionName("atmux")).toBe("atmux");
  });
  test("every other team uses 'atmux_<name>'", () => {
    expect(cageSessionName("sopx")).toBe("atmux_sopx");
    expect(cageSessionName("unum")).toBe("atmux_unum");
  });
});

describe("resolveCageSessionName (anchor-aware)", () => {
  // Regression: cockpit retry-loops + doctor probes targeted `atmux_<name>`
  // (underscore) while start.ts created `atmux-<name>` (hyphen) for any
  // team without a state/session.txt anchor. Bites every dash-bearing
  // team (e.g. ifca-docs) and every fresh-start team without a rename
  // history. Resolver below MUST match what start.ts actually creates.
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "resolve-cage-session-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads state/session.txt anchor when present (anchored team)", async () => {
    await mkdir(join(tmpDir, ".atmux/state"), { recursive: true });
    await writeFile(join(tmpDir, ".atmux/state/session.txt"), "atmux_unum\n");
    expect(await resolveCageSessionName({ name: "unum", root: tmpDir })).toBe("atmux_unum");
  });

  test("falls back to the bare <name> when anchor absent (e-419553c6)", async () => {
    // No state/session.txt — must match getSessionName fallback from
    // common.ts, which start.ts uses to actually create the session.
    // e-419553c6 dropped the `atmux-` prefix: the session IS the team.
    expect(await resolveCageSessionName({ name: "ifca-docs", root: tmpDir })).toBe("ifca-docs");
    expect(await resolveCageSessionName({ name: "rentx", root: tmpDir })).toBe("rentx");
  });

  test("the 'atmux' team needs no special case any more — bare is universal", async () => {
    expect(await resolveCageSessionName({ name: "atmux", root: tmpDir })).toBe("atmux");
  });

  test("trims whitespace from anchor content", async () => {
    await mkdir(join(tmpDir, ".atmux/state"), { recursive: true });
    await writeFile(join(tmpDir, ".atmux/state/session.txt"), "  atmux_custom  \n\n");
    expect(await resolveCageSessionName({ name: "x", root: tmpDir })).toBe("atmux_custom");
  });

  test("legacy prefixed forms stay reachable via an explicit anchor", async () => {
    await mkdir(join(tmpDir, ".atmux/state"), { recursive: true });
    await writeFile(join(tmpDir, ".atmux/state/session.txt"), "atmux-legacy-pin\n");
    expect(await resolveCageSessionName({ name: "legacy-pin", root: tmpDir })).toBe(
      "atmux-legacy-pin",
    );
  });

  test("treats empty-string anchor as absent (falls back)", async () => {
    await mkdir(join(tmpDir, ".atmux/state"), { recursive: true });
    await writeFile(join(tmpDir, ".atmux/state/session.txt"), "   \n");
    expect(await resolveCageSessionName({ name: "demo", root: tmpDir })).toBe("demo");
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
  test("legacy singleton medic block lifts into sessions[]", () => {
    const out = migrateLegacyShape(
      {
        teams: [{ name: "x", root: "/x", enabled: true }],
        medic: { enabled: true },
      },
      "/p.json",
      () => {},
    ) as { sessions: Array<Record<string, unknown>> };
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions[1]).toMatchObject({
      type: "medic",
      name: "medic",
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
    // teams[]-shape shim — the ADR-264 cockpitSession-literal shim is
    // covered separately above and would produce an extra warning that
    // muddies the assertion.
    await writeCockpit({
      cockpitSession: "atx",
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
  test("legacy roster with medic block lifts both into sessions[]", async () => {
    await writeCockpit({
      teams: [{ name: "x", root: "/x", enabled: true }],
      medic: { enabled: true },
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(cockpit.sessions).toHaveLength(2);
    // Synthesized medic singleton field populated from the lifted
    // sessions[] entry.
    expect(cockpit.medic?.enabled).toBe(true);
  });
  test("legacy roster carrying a superdoctor block → ConfigError naming ADR-266", async () => {
    await writeCockpit({
      teams: [{ name: "x", root: "/x", enabled: true }],
      superdoctor: { enabled: true },
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(/ADR-266/);
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

// ---------- ADR-266 §D2: rejectSuperdoctorConfig hard-fail ----------

describe("rejectSuperdoctorConfig — ADR-133 shim expiry (ADR-266 §D2)", () => {
  test("top-level `superdoctor` key → ConfigError naming ADR-266 + rename hint", () => {
    expect(() =>
      rejectSuperdoctorConfig(
        { schemaVersion: 1, sessions: [], superdoctor: { enabled: true } },
        "/fake/path.json",
      ),
    ).toThrow(ConfigError);
    expect(() =>
      rejectSuperdoctorConfig(
        { schemaVersion: 1, sessions: [], superdoctor: { enabled: true } },
        "/fake/path.json",
      ),
    ).toThrow(/ADR-266.*rename the top-level 'superdoctor' block to 'medic'/s);
  });

  test("BOTH `medic` and `superdoctor` set → still fails (legacy key must go)", () => {
    expect(() =>
      rejectSuperdoctorConfig(
        { schemaVersion: 1, sessions: [], medic: { enabled: true }, superdoctor: { enabled: false } },
        "/p.json",
      ),
    ).toThrow(ConfigError);
  });

  test('sessions[] entry with type "superdoctor" → ConfigError naming ADR-266', () => {
    expect(() =>
      rejectSuperdoctorConfig(
        {
          schemaVersion: 1,
          sessions: [
            { type: "team", name: "x", root: "/x" },
            { type: "superdoctor", name: "sd", enabled: true },
          ],
        },
        "/p.json",
      ),
    ).toThrow(/ADR-266.*"type" to "medic"/s);
  });

  test('nested sessions[] entry with type "superdoctor" → ConfigError', () => {
    expect(() =>
      rejectSuperdoctorConfig(
        {
          schemaVersion: 1,
          sessions: [
            {
              type: "team",
              name: "x",
              root: "/x",
              sessions: [{ type: "superdoctor", name: "sd" }],
            },
          ],
        },
        "/p.json",
      ),
    ).toThrow(ConfigError);
  });

  test("only `medic` set → no-op", () => {
    expect(() =>
      rejectSuperdoctorConfig({ schemaVersion: 1, sessions: [], medic: { enabled: true } }, "/p.json"),
    ).not.toThrow();
  });

  test("neither set / non-object input → no-op", () => {
    expect(() => rejectSuperdoctorConfig({ schemaVersion: 1, sessions: [] }, "/p.json")).not.toThrow();
    expect(() => rejectSuperdoctorConfig(null, "/p.json")).not.toThrow();
    expect(() => rejectSuperdoctorConfig("string", "/p.json")).not.toThrow();
  });
});

describe("loadCockpit — ADR-133 medic end-to-end (post ADR-266 §D2)", () => {
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

  test("config with `superdoctor` top-level block → ConfigError naming ADR-266 (shim expired)", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
      superdoctor: { enabled: true },
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(/ADR-266/);
  });

  test("config with BOTH `medic` and `superdoctor` → ConfigError (legacy key must be dropped)", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
      medic: { enabled: true, autoStart: false },
      superdoctor: { enabled: false },
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(/ADR-266/);
  });

  test("config with neither key → defaults applied, medic undefined", async () => {
    const warned: string[] = [];
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "team", name: "x", root: "/x" }],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: (m) => warned.push(m) });
    expect(cockpit.medic).toBeUndefined();
    expect(warned).toHaveLength(0);
  });

  test('sessions[] `type: "superdoctor"` entry → ConfigError naming ADR-266', async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        { type: "team", name: "x", root: "/x" },
        { type: "superdoctor", name: "sd", enabled: true },
      ],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(/ADR-266/);
  });

  test('sessions[] `type: "medic"` entry synthesizes cockpit.medic (canonical path)', async () => {
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
    expect(warned).toHaveLength(0);
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
  // ADR-280 stage 4: the nested node was an `epic-team`; that type is
  // retired and a team nested under a team is now the general case
  // (ADR-089 §Amendment 2026-08-27 §(A)). The threading property is
  // unchanged.
  test("threads parentRoot AND parentName to nested-team descendants", () => {
    const seen: Array<{
      name: string;
      parentRoot: string | undefined;
      parentName: string | undefined;
    }> = [];
    const sessions: CockpitSessionT[] = [
      {
        type: "team",
        name: "sopx",
        root: "/p/sopx",
        enabled: true,
        sessions: [
          {
            type: "team",
            name: "sopx-deferred",
            root: "/p/sopx-deferred",
            enabled: true,
            sessions: [],
          },
        ],
      },
    ];
    walkSessions(sessions, 0, (node, _level, parentRoot, parentName) => {
      seen.push({ name: node.name, parentRoot, parentName });
    });
    expect(seen[0]?.parentRoot).toBeUndefined(); // top-level team has no parent
    expect(seen[0]?.parentName).toBeUndefined();
    expect(seen[1]?.parentRoot).toBe("/p/sopx"); // nested team sees ancestor root
    expect(seen[1]?.parentName).toBe("sopx"); // …and ancestor name (stage-3 arg)
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
  // ADR-280 stage 4: was "epic-team entries inherit parent's root". The
  // `epic-team` row is gone along with the root-inheritance it needed
  // (an epic-team had no root of its own); a nested `team` carries its
  // OWN root. What the flattener must still do — and what stage 3
  // rewired from an `epic-team`-only back-pointer to walk ancestry — is
  // populate `parent` on the nested entry, because `callerScopeAllowed`
  // (ADR-092 §D3) joins on it.
  test("nested team entries flatten with their own root and an ancestry-derived parent", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "team",
          name: "sopx",
          root: "/p/sopx",
          sessions: [
            {
              type: "team",
              name: "sopx-deferred",
              root: "/p/sopx-deferred",
            },
          ],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toMatchObject({ type: "team", name: "sopx", root: "/p/sopx", level: 0 });
    expect(flat[0]?.parent).toBeUndefined(); // top level ⇒ no parent
    expect(flat[1]).toMatchObject({
      type: "team",
      name: "sopx-deferred",
      root: "/p/sopx-deferred", // its OWN root, not the parent's
      level: 1,
      parent: "sopx", // derived from the walk, not declared on the node
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

// ---------- e-419553c6: group tier (non-cage organisational container) ----------

describe('type: "group" — schema', () => {
  test("accepts a group with team children, at top level and nested in a team", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "group",
          name: "ifca",
          sessions: [
            { type: "team", name: "mx", root: "/p/mx" },
            { type: "team", name: "px", root: "/p/px" },
          ],
        },
        {
          type: "team",
          name: "host",
          root: "/p/host",
          sessions: [
            { type: "group", name: "inner", sessions: [{ type: "team", name: "deep", root: "/p/deep" }] },
          ],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(enabledTeams(cockpit).map((t) => t.name)).toEqual(["mx", "px", "host", "deep"]);
  });

  test("enabled defaults to true; sessions defaults to []", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "group", name: "empty-group" }],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const g = (cockpit.sessions ?? [])[0];
    expect(g).toMatchObject({ type: "group", name: "empty-group", enabled: true, sessions: [] });
  });

  test(".strict() rejects unknown keys on a group", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "group", name: "g", typo: "nope" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(SchemaError);
  });

  test("rejects cage-facing fields a group has no consumer for (root, claudeAccount)", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "group", name: "g", root: "/p/g" }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(SchemaError);
    await writeCockpit({
      schemaVersion: 1,
      sessions: [{ type: "group", name: "g", claudeAccount: { configDir: "/c" } }],
    });
    await expect(loadCockpit({ home: homeDir, warn: () => {} })).rejects.toThrow(SchemaError);
  });
});

describe('type: "group" — walkSessions', () => {
  const tree: CockpitSessionT[] = [
    {
      type: "group",
      name: "geoyws",
      enabled: true,
      sessions: [
        { type: "team", name: "unum", root: "/p/unum", enabled: true, sessions: [] },
        {
          type: "team",
          name: "kanban",
          root: "/p/kanban",
          enabled: true,
          sessions: [
            { type: "team", name: "nested", root: "/p/nested", enabled: true, sessions: [] },
          ],
        },
      ],
    },
    { type: "team", name: "solo", root: "/p/solo", enabled: true, sessions: [] },
  ];

  test("recurses through groups in DFS order, keeping a group's children contiguous", () => {
    const seen: string[] = [];
    walkSessions(tree, 0, (node) => {
      seen.push(node.name);
    });
    expect(seen).toEqual(["geoyws", "unum", "kanban", "nested", "solo"]);
  });

  test("groups DO increment level — every group backs a real server that consumes a rung (2026-08-28)", () => {
    const seen: Array<{ name: string; level: number }> = [];
    walkSessions(tree, 0, (node, level) => {
      seen.push({ name: node.name, level });
    });
    expect(seen).toEqual([
      { name: "geoyws", level: 0 }, // top-level group server ⇒ F2 via level+2
      { name: "unum", level: 1 }, // one GROUP ancestor ⇒ one rung down (F3)
      { name: "kanban", level: 1 },
      { name: "nested", level: 2 }, // group + team ancestors ⇒ F4
      { name: "solo", level: 0 }, // ungrouped top-level team stays F2
    ]);
  });

  test("threads the nearest ancestor group name; teams pass it through", () => {
    const seen: Array<{ name: string; parentGroup: string | undefined }> = [];
    walkSessions(tree, 0, (node, _level, _parentRoot, _parentName, parentGroup) => {
      seen.push({ name: node.name, parentGroup });
    });
    expect(seen).toEqual([
      { name: "geoyws", parentGroup: undefined },
      { name: "unum", parentGroup: "geoyws" },
      { name: "kanban", parentGroup: "geoyws" },
      { name: "nested", parentGroup: "geoyws" }, // survives the intermediate team
      { name: "solo", parentGroup: undefined },
    ]);
  });

  test("a deeper group overrides the ancestor group (nearest wins)", () => {
    const nestedGroups: CockpitSessionT[] = [
      {
        type: "group",
        name: "outer",
        enabled: true,
        sessions: [
          {
            type: "group",
            name: "inner",
            enabled: true,
            sessions: [{ type: "team", name: "t", root: "/t", enabled: true, sessions: [] }],
          },
        ],
      },
    ];
    let got: string | undefined;
    walkSessions(nestedGroups, 0, (node, _l, _r, _n, parentGroup) => {
      if (node.name === "t") got = parentGroup;
    });
    expect(got).toBe("inner");
  });

  test("groups are transparent to team ancestry (parentRoot / parentName pass through)", () => {
    const mixed: CockpitSessionT[] = [
      {
        type: "team",
        name: "host",
        root: "/p/host",
        enabled: true,
        sessions: [
          {
            type: "group",
            name: "g",
            enabled: true,
            sessions: [{ type: "team", name: "child", root: "/p/child", enabled: true, sessions: [] }],
          },
        ],
      },
    ];
    let seen: { parentRoot?: string; parentName?: string } = {};
    walkSessions(mixed, 0, (node, _l, parentRoot, parentName) => {
      if (node.name === "child") seen = { ...(parentRoot !== undefined ? { parentRoot } : {}), ...(parentName !== undefined ? { parentName } : {}) };
    });
    // The nearest TEAM ancestor is `host`, not the group between them.
    expect(seen).toEqual({ parentRoot: "/p/host", parentName: "host" });
  });

  test("a disabled group prunes its whole subtree from the walk", () => {
    const pruned: CockpitSessionT[] = [
      {
        type: "group",
        name: "off",
        enabled: false,
        sessions: [{ type: "team", name: "hidden", root: "/p/hidden", enabled: true, sessions: [] }],
      },
      { type: "team", name: "visible", root: "/p/visible", enabled: true, sessions: [] },
    ];
    const seen: string[] = [];
    walkSessions(pruned, 0, (node) => {
      seen.push(node.name);
    });
    // The group node itself is visited (like a disabled team); its
    // children are not.
    expect(seen).toEqual(["off", "visible"]);
  });
});

describe('type: "group" — enabledTeams', () => {
  test("never emits a group as a team; threads group onto entries", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "group",
          name: "ifca",
          sessions: [
            { type: "team", name: "mx", root: "/p/mx" },
            { type: "team", name: "px", root: "/p/px" },
          ],
        },
        { type: "team", name: "solo", root: "/p/solo" },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    expect(flat.map((t) => t.name)).toEqual(["mx", "px", "solo"]);
    expect(flat.every((t) => t.type === "team")).toBe(true);
    expect(flat[0]?.group).toBe("ifca");
    expect(flat[1]?.group).toBe("ifca");
    expect(flat[2]?.group).toBeUndefined();
  });

  test("children of a disabled group are skipped entirely, even when themselves enabled", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "group",
          name: "parked",
          enabled: false,
          sessions: [{ type: "team", name: "inside", root: "/p/inside", enabled: true }],
        },
        { type: "team", name: "outside", root: "/p/outside" },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    expect(enabledTeams(cockpit).map((t) => t.name)).toEqual(["outside"]);
  });

  test("prefix arithmetic: the group consumes the F2 rung; teams under it shift down (2026-08-28)", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "group",
          name: "grp",
          sessions: [
            {
              type: "team",
              name: "proj",
              root: "/p/proj",
              sessions: [{ type: "team", name: "sub", root: "/p/sub" }],
            },
          ],
        },
        { type: "team", name: "solo", root: "/p/solo" },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const flat = enabledTeams(cockpit);
    const proj = flat.find((t) => t.name === "proj");
    const sub = flat.find((t) => t.name === "sub");
    const solo = flat.find((t) => t.name === "solo");
    // True containment (ADR-089 2026-08-28 group-tier note): the group
    // backs a real server at F2, so its teams shift one rung down —
    // the same arithmetic verbs/cockpit.ts Phase 3 applies (level + 2).
    expect(resolvePrefix((proj?.level ?? -1) + 2)).toBe("F3");
    expect(resolvePrefix((sub?.level ?? -1) + 2)).toBe("F4");
    // An ungrouped top-level team keeps F2.
    expect(resolvePrefix((solo?.level ?? -1) + 2)).toBe("F2");
  });

  test("legacy back-compat teams[] synthesis also sees through groups", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "group",
          name: "g",
          sessions: [{ type: "team", name: "inner", root: "/p/inner" }],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    // enrichLegacyFields walks the same tree: the synthesized legacy
    // roster contains the group's teams, never the group.
    expect(cockpit.teams.map((t) => t.name)).toEqual(["inner"]);
  });
});

describe('type: "group" — findTeamByName', () => {
  test("resolves a team inside a group, with group threading + team-ancestry transparency", async () => {
    await writeCockpit({
      schemaVersion: 1,
      sessions: [
        {
          type: "team",
          name: "host",
          root: "/p/host",
          sessions: [
            {
              type: "group",
              name: "g",
              sessions: [{ type: "team", name: "child", root: "/p/child" }],
            },
          ],
        },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir, warn: () => {} });
    const hit = findTeamByName(cockpit, "child");
    expect(hit).toMatchObject({ type: "team", name: "child", root: "/p/child" });
    expect(hit?.parent).toBe("host"); // nearest TEAM ancestor — the group is transparent
    expect(hit?.group).toBe("g");
    expect(findTeamByName(cockpit, "g")).toBeNull(); // a group is not a team
  });
});

// ---------- e-419553c6: group servers (true containment, 2026-08-28) ----------

describe("groupSocketPath — collision-freedom", () => {
  test("carries the -grp- infix", () => {
    expect(groupSocketPath("geoyws")).toBe("/tmp/atmux-grp-geoyws/sock");
  });

  test("a group and a team sharing a name never share a socket", () => {
    // The live fleet has both a `unum` group and a `unum` team — the
    // -grp- infix keeps their servers apart.
    expect(groupSocketPath("unum")).not.toBe(cageSocketPath("unum"));
    for (const n of ["a", "grp", "atmux", "x-y"]) {
      expect(groupSocketPath(n)).not.toBe(cageSocketPath(n));
    }
  });
});

describe("buildGroupTopology", () => {
  const shape = (sessions: unknown[]): CockpitShape =>
    ({ schemaVersion: 1, cockpitSession: "atx", sessions, windows: [] }) as unknown as CockpitShape;

  test("derives group servers + cockpit entries from a mixed tree, DFS order", () => {
    const topo = buildGroupTopology(
      shape([
        {
          type: "group",
          name: "geoyws",
          enabled: true,
          sessions: [
            { type: "team", name: "unum", root: "/p/unum", enabled: true, sessions: [] },
            {
              type: "team",
              name: "kanban",
              root: "/p/kanban",
              enabled: true,
              sessions: [
                { type: "team", name: "nested", root: "/p/nested", enabled: true, sessions: [] },
              ],
            },
          ],
        },
        { type: "team", name: "solo", root: "/p/solo", enabled: true, sessions: [] },
      ]),
    );
    expect(topo.groups.map((g) => g.name)).toEqual(["geoyws"]);
    const g = topo.groups[0];
    expect(g?.level).toBe(0);
    expect(g?.parentGroup).toBeUndefined();
    // Nearest-group teams in DFS order — the team nested under `kanban`
    // (nearest group still geoyws) gets its own viewer window too,
    // mirroring the cockpit session's pre-group behaviour.
    expect(
      g?.children.map((c) => (c.kind === "team" ? `t:${c.team.name}` : `g:${c.name}`)),
    ).toEqual(["t:unum", "t:kanban", "t:nested"]);
    // Cockpit session: the top-level group + the ungrouped team only.
    expect(
      topo.cockpitEntries.map((e) => (e.kind === "group" ? `g:${e.group.name}` : `t:${e.team.name}`)),
    ).toEqual(["g:geoyws", "t:solo"]);
  });

  test("nested groups chain: child group is a window in the parent's server; teams attribute to the NEAREST group", () => {
    const topo = buildGroupTopology(
      shape([
        {
          type: "group",
          name: "outer",
          enabled: true,
          sessions: [
            { type: "team", name: "a", root: "/p/a", enabled: true, sessions: [] },
            {
              type: "group",
              name: "inner",
              enabled: true,
              sessions: [{ type: "team", name: "b", root: "/p/b", enabled: true, sessions: [] }],
            },
          ],
        },
      ]),
    );
    expect(topo.groups.map((g) => `${g.name}@${g.level}`)).toEqual(["outer@0", "inner@1"]);
    expect(topo.groups[1]?.parentGroup).toBe("outer");
    const outer = topo.groups[0];
    expect(
      outer?.children.map((c) => (c.kind === "team" ? `t:${c.team.name}` : `g:${c.name}`)),
    ).toEqual(["t:a", "g:inner"]);
    const inner = topo.groups[1];
    expect(inner?.children.map((c) => (c.kind === "team" ? c.team.name : c.name))).toEqual(["b"]);
    // Only the top-level group reaches the cockpit.
    expect(topo.cockpitEntries.map((e) => (e.kind === "group" ? e.group.name : ""))).toEqual([
      "outer",
    ]);
  });

  test("a disabled group contributes no server and prunes its subtree; disabled teams are skipped", () => {
    const topo = buildGroupTopology(
      shape([
        {
          type: "group",
          name: "parked",
          enabled: false,
          sessions: [{ type: "team", name: "inside", root: "/p/in", enabled: true, sessions: [] }],
        },
        {
          type: "group",
          name: "live",
          enabled: true,
          sessions: [
            { type: "team", name: "on", root: "/p/on", enabled: true, sessions: [] },
            { type: "team", name: "off", root: "/p/off", enabled: false, sessions: [] },
          ],
        },
      ]),
    );
    expect(topo.groups.map((g) => g.name)).toEqual(["live"]);
    expect(topo.groups[0]?.children.map((c) => (c.kind === "team" ? c.team.name : c.name))).toEqual(
      ["on"],
    );
  });

  test("a group hosted only under a TEAM (no group ancestor) embeds in the cockpit", () => {
    const topo = buildGroupTopology(
      shape([
        {
          type: "team",
          name: "host",
          root: "/p/host",
          enabled: true,
          sessions: [
            {
              type: "group",
              name: "g",
              enabled: true,
              sessions: [{ type: "team", name: "child", root: "/p/child", enabled: true, sessions: [] }],
            },
          ],
        },
      ]),
    );
    expect(topo.cockpitEntries.map((e) => (e.kind === "group" ? `g:${e.group.name}` : `t:${e.team.name}`))).toEqual([
      "t:host",
      "g:g",
    ]);
  });

  test("refuses duplicate enabled group names (shared socket + session)", () => {
    expect(() =>
      buildGroupTopology(
        shape([
          { type: "group", name: "x", enabled: true, sessions: [] },
          { type: "group", name: "x", enabled: true, sessions: [] },
        ]),
      ),
    ).toThrow(ConfigError);
  });

  test("refuses a viewer-name collision within one namespace; allows the same name across namespaces", () => {
    // Collision: top-level group `unum` next to an UNGROUPED team `unum`
    // — both would claim the cockpit window named `unum`.
    expect(() =>
      buildGroupTopology(
        shape([
          {
            type: "group",
            name: "unum",
            enabled: true,
            sessions: [{ type: "team", name: "inner", root: "/p/i", enabled: true, sessions: [] }],
          },
          { type: "team", name: "unum", root: "/p/unum", enabled: true, sessions: [] },
        ]),
      ),
    ).toThrow(ConfigError);
    // No collision: the `unum` TEAM lives INSIDE the `unum` GROUP —
    // different namespaces (group server vs cockpit).
    const topo = buildGroupTopology(
      shape([
        {
          type: "group",
          name: "unum",
          enabled: true,
          sessions: [{ type: "team", name: "unum", root: "/p/unum", enabled: true, sessions: [] }],
        },
      ]),
    );
    expect(topo.groups[0]?.children.map((c) => (c.kind === "team" ? c.team.name : c.name))).toEqual(
      ["unum"],
    );
  });
});

describe("resolveTopLevelGroup", () => {
  const topo = buildGroupTopology({
    schemaVersion: 1,
    cockpitSession: "atx",
    windows: [],
    sessions: [
      {
        type: "group",
        name: "outer",
        enabled: true,
        sessions: [
          {
            type: "group",
            name: "inner",
            enabled: true,
            sessions: [{ type: "team", name: "t", root: "/t", enabled: true, sessions: [] }],
          },
        ],
      },
    ],
  } as unknown as CockpitShape);

  test("walks the parentGroup chain to the cockpit-level group", () => {
    expect(resolveTopLevelGroup(topo, "inner")).toBe("outer");
    expect(resolveTopLevelGroup(topo, "outer")).toBe("outer");
  });

  test("unknown name → null", () => {
    expect(resolveTopLevelGroup(topo, "nope")).toBeNull();
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
  // 2026-05-24: default flipped 1 → 2 per ADR-089 §C alignment.
  // Standalone `atmux start` invokes a top-level team cage which is L2
  // (L1 is the cockpit itself). Pre-flip default of 1 collided cockpit
  // and team into the same chain slot (F1) and relied on socket
  // separation to avoid physical collision.
  test("missing env var → 2 (standalone team-cage default per ADR-089 §C)", () => {
    expect(readNestingLevel({})).toBe(2);
  });

  test("empty env value → 2 (defensive)", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "" })).toBe(2);
  });

  test("valid integer → parsed value", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "3" })).toBe(3);
  });

  test("non-numeric → falls back to 2", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "abc" })).toBe(2);
  });

  test("zero / negative → falls back to 2", () => {
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "0" })).toBe(2);
    expect(readNestingLevel({ [ATMUX_NESTING_LEVEL_ENV]: "-2" })).toBe(2);
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

/** Helper — synthesize a minimal CockpitShape with a two-level fixture
 *  (`alpha` team with nested child `alpha-child-1`; `beta` team with
 *  nested child `beta-omega`). Used by ADR-092 tests.
 *
 *  ADR-280 stage 4: the children were `epic-team` nodes carrying a
 *  declared `parent`. That type is retired; they are now ordinary nested
 *  `team` nodes and `parent` is derived by the walk. The fixture is
 *  deliberately still a real `CockpitShape` (no `as never` on the nodes)
 *  so a future schema narrowing breaks the build here rather than
 *  silently passing on a cast. */
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
            type: "team",
            name: "alpha-child-1",
            enabled: true,
            root: "/teams/alpha/children/1",
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
            type: "team",
            name: "beta-omega",
            enabled: true,
            root: "/teams/beta/children/omega",
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

  test("matches a NESTED team, reporting its own root and its ancestry-derived parent", () => {
    const found = findTeamByName(buildFixtureCockpit(), "alpha-child-1");
    expect(found?.type).toBe("team");
    expect(found?.root).toBe("/teams/alpha/children/1");
    expect(found?.parent).toBe("alpha");
    expect(found?.level).toBe(1);
  });

  test("returns null on miss", () => {
    expect(findTeamByName(buildFixtureCockpit(), "nonexistent")).toBeNull();
  });

  test("walks depth-3 fixture deterministically (first match wins)", () => {
    // Add a child under beta with the same name as alpha's child to
    // verify FIRST match by DFS order wins (Decision-anchor #2 — name
    // collision is operator error; lookup is deterministic).
    const cockpit = buildFixtureCockpit();
    (cockpit.sessions[1] as { sessions: CockpitSessionT[] }).sessions.push({
      type: "team",
      name: "alpha-child-1",
      enabled: true,
      root: "/teams/beta/children/clash",
      sessions: [],
    });
    const found = findTeamByName(cockpit, "alpha-child-1");
    // First match is under alpha (DFS visits alpha branch before beta).
    expect(found?.parent).toBe("alpha");
  });

  test("skips superdriver / medic leaves (only type=team qualifies)", () => {
    const cockpit: CockpitShape = {
      schemaVersion: 1,
      sessions: [
        { type: "medic", name: "alpha", enabled: true },
        { type: "superdriver", name: "alpha-driver", enabled: true },
      ],
      teams: [],
    } as unknown as CockpitShape;
    // The medic literally named "alpha" is NOT matched — only the
    // `team` type qualifies (the union lost `epic-team` in ADR-280
    // stage 3, so `team` is now the sole team-bearing member).
    expect(findTeamByName(cockpit, "alpha")).toBeNull();
  });
});

describe("callerScopeAllowed (ADR-092 §D3)", () => {
  test("driver scope is master override", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "beta", "driver")).toBe(true);
    expect(callerScopeAllowed(cockpit, "alpha-child-1", "beta-omega", "driver")).toBe(true);
  });

  test("same-team is trivially allowed", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "alpha", undefined)).toBe(true);
  });

  // ADR-280 stage 3 WIDENED both of these: the gate used to reach a
  // parent only through the `epic-team` node's own back-pointer, so it
  // covered epic-teams alone. It now covers any nested team.
  test("child team → parent team allowed", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha-child-1", "alpha", undefined)).toBe(true);
  });

  test("parent team → child team allowed", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha", "alpha-child-1", undefined)).toBe(true);
  });

  test("siblings under different parents refused", () => {
    const cockpit = buildFixtureCockpit();
    expect(callerScopeAllowed(cockpit, "alpha-child-1", "beta-omega", undefined)).toBe(false);
  });

  test("siblings under SAME parent refused — must route via parent", () => {
    const cockpit = buildFixtureCockpit();
    // Add a second child under alpha so we have two nested teams sharing
    // parent=alpha. Per ADR-092 §D3 reviewer pre-flag: siblings must
    // route through the parent.
    (cockpit.sessions[0] as { sessions: CockpitSessionT[] }).sessions.push({
      type: "team",
      name: "alpha-child-2",
      enabled: true,
      root: "/teams/alpha/children/2",
      sessions: [],
    });
    expect(callerScopeAllowed(cockpit, "alpha-child-1", "alpha-child-2", undefined)).toBe(false);
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
