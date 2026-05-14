// Unit tests for src/core/cockpit.ts — ADR-063 cockpit roster loader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cageSessionName,
  defaultCockpitConfigPath,
  enabledTeams,
  loadCockpit,
  resolveCageSocket,
  resolveCockpitConfigPath,
} from "../../../src/core/cockpit.ts";
import { ConfigError, SchemaError } from "../../../src/errors.ts";
import type { Team as TeamShape } from "../../../src/schema/team.ts";

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

describe("resolveCageSocket", () => {
  function fakeTeam(extras: Partial<TeamShape>): TeamShape {
    return { name: "demo", members: [], ...extras } as unknown as TeamShape;
  }

  test("(a) team with custom tmuxTmpdir → <tmuxTmpdir>/tmux-<uid>/default", async () => {
    const cockpitTeam = { name: "atmux", root: "/p/atmux" };
    const sock = await resolveCageSocket(cockpitTeam, {
      loadTeam: async () =>
        fakeTeam({ name: "atmux", tmuxTmpdir: "/root/work/src/atmux/.atmux/tmux" }),
      uid: 0,
    });
    expect(sock).toBe("/root/work/src/atmux/.atmux/tmux/tmux-0/default");
  });

  test("(b) team without tmuxTmpdir → /tmp/atmux-<team>/sock fallback", async () => {
    const cockpitTeam = { name: "sopx", root: "/p/sopx" };
    const sock = await resolveCageSocket(cockpitTeam, {
      loadTeam: async () => fakeTeam({ name: "sopx" }),
      uid: 1000,
    });
    expect(sock).toBe("/tmp/atmux-sopx/sock");
  });

  test("(c) atmux dogfood team (real tmuxTmpdir shape) — honours uid in path segment", async () => {
    const cockpitTeam = { name: "atmux", root: "/root/work/src/atmux" };
    const sock = await resolveCageSocket(cockpitTeam, {
      loadTeam: async () =>
        fakeTeam({ name: "atmux", tmuxTmpdir: "/root/work/src/atmux/.atmux/tmux" }),
      uid: 0,
    });
    // Bug repro source-of-truth: the manual-fix tmux invocation in
    // t-b5864443's body uses exactly this socket path.
    expect(sock).toBe("/root/work/src/atmux/.atmux/tmux/tmux-0/default");
  });

  test("empty-string tmuxTmpdir falls back to /tmp/atmux-<team>/sock", async () => {
    const sock = await resolveCageSocket(
      { name: "x", root: "/x" },
      { loadTeam: async () => fakeTeam({ name: "x", tmuxTmpdir: "" }) },
    );
    expect(sock).toBe("/tmp/atmux-x/sock");
  });

  test("loadTeam failure (missing team.json) → /tmp/atmux-<team>/sock fallback", async () => {
    const sock = await resolveCageSocket(
      { name: "ghost", root: "/missing" },
      {
        loadTeam: async () => {
          throw new Error("ENOENT team.json");
        },
      },
    );
    expect(sock).toBe("/tmp/atmux-ghost/sock");
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
