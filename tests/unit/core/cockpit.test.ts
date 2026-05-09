// Unit tests for src/core/cockpit.ts — ADR-063 cockpit roster loader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cageSessionName,
  cageSocketPath,
  defaultCockpitConfigPath,
  enabledTeams,
  loadCockpit,
  resolveCockpitConfigPath,
} from "../../../src/core/cockpit.ts";
import { ConfigError, SchemaError } from "../../../src/errors.ts";

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
