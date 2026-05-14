// Unit tests for src/core/cockpit.ts — ADR-063 cockpit roster loader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATMUX_NESTING_LEVEL_ENV,
  cageSessionName,
  cageSocketPath,
  childNestingEnv,
  DEFAULT_PREFIX_CHAIN,
  defaultCockpitConfigPath,
  enabledTeams,
  loadCockpit,
  MAX_NESTING_LEVEL,
  migrateLegacyShape,
  readNestingLevel,
  resolveCockpitConfigPath,
  resolvePrefix,
  validatePrefixChain,
  walkSessions,
} from "../../../src/core/cockpit.ts";
import { ConfigError, SchemaError } from "../../../src/errors.ts";
import type { CockpitSessionT } from "../../../src/schema/cockpit.ts";

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
      cockpitSession: "atmux_teams",
      teams: [
        { name: "sopx", root: "/p/sopx", enabled: true },
        { name: "atmux", root: "/p/atmux", enabled: true },
      ],
    });
    const cockpit = await loadCockpit({ home: homeDir });
    expect(cockpit.cockpitSession).toBe("atmux_teams");
    expect(cockpit.teams).toHaveLength(2);
    expect(cockpit.teams[0]?.name).toBe("sopx");
  });

  test("applies cockpitSession default when omitted", async () => {
    await writeCockpit({ teams: [{ name: "x", root: "/x", enabled: true }] });
    const cockpit = await loadCockpit({ home: homeDir });
    expect(cockpit.cockpitSession).toBe("atmux_teams");
  });

  test("applies team.enabled default (true) when omitted", async () => {
    await writeCockpit({ teams: [{ name: "x", root: "/x" }] });
    const cockpit = await loadCockpit({ home: homeDir });
    expect(cockpit.teams[0]?.enabled).toBe(true);
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

describe("cageSocketPath", () => {
  test("returns /tmp/atmux-<team>/sock", () => {
    expect(cageSocketPath("sopx")).toBe("/tmp/atmux-sopx/sock");
    expect(cageSocketPath("atmux")).toBe("/tmp/atmux-atmux/sock");
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
    await writeCockpit({
      cockpitSession: "atmux_teams",
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
            sessions: [
              { type: "team", name: "L2", root: "/L2", enabled: true, sessions: [] },
            ],
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
              sessions: [
                { type: "team", name: "leaf", root: "/p/leaf" },
              ],
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
