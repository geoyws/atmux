// Unit tests for the atmux-skills-plugin doctor probe (ADR-217 §D5):
//   - skillsPluginStateRows() — pure mapping from SkillsPluginState → DoctorRow[]
//   - checkSkillsPlugin()     — I/O wrapper that probes the install path,
//                                opt-out marker, plugin.json existence +
//                                shape, and emits the row
//
// Pattern mirror: tests/unit/verbs/doctor-honker.test.ts. Same describe
// split (pure / I/O wrapper), same scratch-via-mkdtemp + cleanup,
// same per-branch coverage strategy.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSkillsPlugin,
  type SkillsPluginState,
  skillsPluginStateRows,
} from "../../../src/verbs/doctor.ts";

describe("skillsPluginStateRows (pure)", () => {
  test("opted-out → info row 'opt-out marker present'", () => {
    const rows = skillsPluginStateRows({ kind: "opted-out" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.label).toBe("atmux-skills-plugin");
    expect(rows[0]?.detail).toMatch(/opted out/);
    expect(rows[0]?.detail).toMatch(/skills-plugin-opted-out/);
  });

  test("symlink-missing → yellow row + skills-only install hint", () => {
    const rows = skillsPluginStateRows({ kind: "symlink-missing" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/not installed/);
    expect(rows[0]?.detail).toMatch(/~\/\.claude\/plugins\/atmux/);
    expect(rows[0]?.hint).toMatch(/atmux init --skills-only/);
  });

  test("plugin-json-missing → yellow row with full path + --force hint", () => {
    const rows = skillsPluginStateRows({
      kind: "plugin-json-missing",
      installPath: "/home/x/.claude/plugins/atmux",
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(
      /plugin\.json missing at \/home\/x\/\.claude\/plugins\/atmux\/\.claude-plugin\/plugin\.json/,
    );
    expect(rows[0]?.hint).toMatch(/--skills-only --force/);
  });

  test("plugin-json-malformed → yellow row with parse reason", () => {
    const rows = skillsPluginStateRows({
      kind: "plugin-json-malformed",
      installPath: "/home/x/.claude/plugins/atmux",
      reason: "Unexpected token } at position 42",
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/malformed/);
    expect(rows[0]?.detail).toMatch(/Unexpected token \}/);
  });

  test("plugin-json-schema-fail → yellow row with schema reason", () => {
    const rows = skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath: "/home/x/.claude/plugins/atmux",
      reason: "missing or empty 'name' field",
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/schema validation failed/);
    expect(rows[0]?.detail).toMatch(/missing or empty 'name' field/);
  });

  test("green → green row with install path + plugin name", () => {
    const rows = skillsPluginStateRows({
      kind: "green",
      installPath: "/home/x/.claude/plugins/atmux",
      pluginName: "atmux",
    });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toMatch(/installed at \/home\/x/);
    expect(rows[0]?.detail).toMatch(/plugin=atmux/);
  });

  test("exhaustiveness — every SkillsPluginState kind returns exactly one row", () => {
    const kinds: SkillsPluginState[] = [
      { kind: "opted-out" },
      { kind: "symlink-missing" },
      { kind: "plugin-json-missing", installPath: "/x" },
      { kind: "plugin-json-malformed", installPath: "/x", reason: "r" },
      { kind: "plugin-json-schema-fail", installPath: "/x", reason: "r" },
      { kind: "green", installPath: "/x", pluginName: "atmux" },
    ];
    for (const s of kinds) {
      const rows = skillsPluginStateRows(s);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.label).toBe("atmux-skills-plugin");
    }
  });
});

describe("checkSkillsPlugin (I/O wrapper)", () => {
  let scratch: string;
  let home: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-doctor-skills-"));
    home = scratch;
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("$HOME unset → empty row array (no doctor row emitted)", async () => {
    const rows = await checkSkillsPlugin({ home: "" });
    expect(rows).toEqual([]);
  });

  test("opt-out marker present → info 'opted out' row (wins over everything)", async () => {
    const stateDir = join(home, ".atmux", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "skills-plugin-opted-out"), "");
    // Also create a valid install — marker should still win.
    const installPath = join(home, ".claude", "plugins", "atmux");
    const manifestDir = join(installPath, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "plugin.json"),
      JSON.stringify({ name: "atmux", skills: [] }),
    );

    const rows = await checkSkillsPlugin({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.detail).toMatch(/opted out/);
  });

  test("install path absent → yellow 'symlink-missing' row", async () => {
    const rows = await checkSkillsPlugin({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/not installed/);
  });

  test("install path present but plugin.json missing → yellow 'plugin-json-missing' row", async () => {
    const installPath = join(home, ".claude", "plugins", "atmux");
    await mkdir(installPath, { recursive: true });

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/plugin\.json missing/);
  });

  test("plugin.json malformed JSON → yellow 'malformed' row with parse reason", async () => {
    const installPath = join(home, ".claude", "plugins", "atmux");
    const manifestDir = join(installPath, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "plugin.json"), "{not valid json");

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/malformed/);
  });

  test("plugin.json shape-fail (missing name) → yellow 'schema-fail' row", async () => {
    const installPath = join(home, ".claude", "plugins", "atmux");
    const manifestDir = join(installPath, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "plugin.json"), JSON.stringify({ skills: [] }));

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/schema validation failed/);
    expect(rows[0]?.detail).toMatch(/missing or empty 'name'/);
  });

  test("plugin.json shape-fail (skills not array) → yellow 'schema-fail' row", async () => {
    const installPath = join(home, ".claude", "plugins", "atmux");
    const manifestDir = join(installPath, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "plugin.json"),
      JSON.stringify({ name: "atmux", skills: "not-an-array" }),
    );

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/skills.*not an array/);
  });

  test("plugin.json shape-fail (root not object — null) → yellow row", async () => {
    const installPath = join(home, ".claude", "plugins", "atmux");
    const manifestDir = join(installPath, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "plugin.json"), "null");

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/not an object/);
  });

  test("valid plugin.json (real dir) → green row with plugin name", async () => {
    const installPath = join(home, ".claude", "plugins", "atmux");
    const manifestDir = join(installPath, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "plugin.json"),
      JSON.stringify({
        name: "atmux",
        version: "0.1.0",
        skills: [{ name: "team", path: "skills/team/SKILL.md" }],
      }),
    );

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toMatch(/installed at/);
    expect(rows[0]?.detail).toMatch(/plugin=atmux/);
  });

  test("valid plugin.json via symlink → green row (symlink treated equivalent to real dir)", async () => {
    // Create real source dir + plugin.json, then symlink the canonical
    // install path to it. Probe should treat both shapes identically.
    const sourceDir = join(scratch, "atmux-source", "plugins", "atmux");
    const manifestDir = join(sourceDir, ".claude-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "plugin.json"),
      JSON.stringify({ name: "atmux", skills: [] }),
    );

    const installParent = join(home, ".claude", "plugins");
    await mkdir(installParent, { recursive: true });
    await symlink(sourceDir, join(installParent, "atmux"));

    const rows = await checkSkillsPlugin({ home });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toMatch(/plugin=atmux/);
  });
});
