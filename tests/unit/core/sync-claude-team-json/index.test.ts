// Unit tests for src/core/sync-claude-team-json/index.ts (ADR-164 T3
// orchestrator — t-312fe824, asserted under T7 t-4329b053).
//
// The orchestrator composes:
//   1. tryLoadTeam (reads .atmux/team.json via existing common.ts chain)
//   2. readLooseJson on .claude/team.json (prior) + .claude/team-colors.json (sidecar)
//   3. mapRoster (T3) + mergeBriefs (T4)
//
// Tests use real fs under mkdtemp + the ResolveDirOpts `dir` injection
// point + the ComputeOpts.claudeDir injection point — no mocking, hermetic
// per-test temp dirs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMappedTeam } from "../../../../src/core/sync-claude-team-json/index.ts";

interface Harness {
  root: string;
  atmuxDir: string;
  claudeDir: string;
}

async function newHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "atmux-sync-index-"));
  const atmuxDir = join(root, ".atmux");
  const claudeDir = join(root, ".claude");
  await mkdir(atmuxDir, { recursive: true });
  return { root, atmuxDir, claudeDir };
}

async function writeAtmuxTeam(h: Harness, body: unknown): Promise<void> {
  await writeFile(join(h.atmuxDir, "team.json"), JSON.stringify(body), "utf8");
}

async function writeClaudeTeam(h: Harness, body: unknown): Promise<void> {
  await mkdir(h.claudeDir, { recursive: true });
  await writeFile(join(h.claudeDir, "team.json"), JSON.stringify(body), "utf8");
}

async function writeSidecar(h: Harness, body: unknown): Promise<void> {
  await mkdir(h.claudeDir, { recursive: true });
  await writeFile(join(h.claudeDir, "team-colors.json"), JSON.stringify(body), "utf8");
}

let h: Harness;
beforeEach(async () => {
  h = await newHarness();
});
afterEach(async () => {
  await rm(h.root, { recursive: true, force: true });
});

describe("computeMappedTeam — happy path", () => {
  test("fresh-file: no prior .claude/team.json, no sidecar — returns prior=null + computed roster", async () => {
    await writeAtmuxTeam(h, {
      name: "fixture",
      description: "test team",
      members: [
        { name: "lead", role: "team-lead", emoji: "🧭" },
        { name: "planner", role: "planner", emoji: "🎯" },
        { name: "fe-1", role: "member", lane: "fe", emoji: "🌸" },
      ],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.prior).toBeNull();
    expect(result.sidecar).toBeNull();
    expect(result.computed.name).toBe("fixture");
    expect(result.computed.description).toBe("test team");
    expect(result.computed.members).toHaveLength(3);
    expect(result.computed.members[0]?.name).toBe("team-lead"); // rewritten
    expect(result.computed.members[0]?.agentType).toBe("team-lead");
    expect(result.computed.members[0]?.color).toBe("white"); // 🧭
    expect(result.computed.members[1]?.name).toBe("planner");
    expect(result.computed.members[1]?.color).toBe("magenta"); // 🎯
    expect(result.computed.members[2]?.name).toBe("fe-1");
    expect(result.computed.members[2]?.color).toBe("orange"); // 🌸
  });

  test("description undefined when atmux team has none", async () => {
    await writeAtmuxTeam(h, {
      name: "no-desc-team",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.description).toBeUndefined();
  });
});

describe("computeMappedTeam — prior .claude/team.json present", () => {
  test("returns parsed prior + brief-preservation seeds atmux role on first match miss", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    await writeClaudeTeam(h, {
      name: "t",
      members: [{ name: "team-lead", agentType: "team-lead", color: "white", role: "preserved-text" }],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.prior).not.toBeNull();
    expect(result.prior?.members?.[0]?.role).toBe("preserved-text");
    // Default overwriteBriefs=false → preserve prior text
    expect(result.computed.members[0]?.role).toBe("preserved-text");
  });

  test("overwriteBriefs=true threads through to mergeBriefs (atmux role wins)", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    await writeClaudeTeam(h, {
      name: "t",
      members: [{ name: "team-lead", role: "previously-handauthored" }],
    });
    const result = await computeMappedTeam({
      dir: h.atmuxDir,
      claudeDir: h.claudeDir,
      overwriteBriefs: true,
    });
    expect(result.computed.members[0]?.role).toBe("team-lead");
  });

  test("default opts (overwriteBriefs unset) → preserve-by-default", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeClaudeTeam(h, {
      members: [{ name: "fe-1", role: "kept" }],
    });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.members[0]?.role).toBe("kept");
  });
});

describe("computeMappedTeam — sidecar present", () => {
  test("sidecar._byMemberName beats fixed-table color resolution", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeSidecar(h, { _byMemberName: { "fe-1": "blue" } });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.sidecar).not.toBeNull();
    expect(result.computed.members[0]?.color).toBe("blue");
  });

  test("sidecar top-level emoji override engaged", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeSidecar(h, { "🌸": "yellow" });
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.members[0]?.color).toBe("yellow");
  });

  test("sidecar present but empty → falls through to fixed table", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await writeSidecar(h, {});
    const result = await computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir });
    expect(result.computed.members[0]?.color).toBe("orange");
  });
});

describe("computeMappedTeam — error paths", () => {
  test("missing .atmux/team.json → throws actionable error", async () => {
    // Fresh tmpdir, no team.json written
    await expect(
      computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir }),
    ).rejects.toThrow(/no \.atmux\/team\.json/);
  });

  test("malformed prior .claude/team.json → SyntaxError surfaces (caller decides UX)", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await mkdir(h.claudeDir, { recursive: true });
    await writeFile(join(h.claudeDir, "team.json"), "{ this is not json", "utf8");
    await expect(
      computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  test("malformed sidecar JSON → SyntaxError surfaces", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    await mkdir(h.claudeDir, { recursive: true });
    await writeFile(join(h.claudeDir, "team-colors.json"), "{ malformed", "utf8");
    await expect(
      computeMappedTeam({ dir: h.atmuxDir, claudeDir: h.claudeDir }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("computeMappedTeam — claudeDir resolution", () => {
  test("defaults to <process.cwd()>/.claude when claudeDir is omitted", async () => {
    await writeAtmuxTeam(h, {
      name: "t",
      members: [{ name: "fe-1", role: "member", emoji: "🌸" }],
    });
    // We can't safely override process.cwd() in-test (Bun's chdir
    // is process-global + would race with sibling tests). Instead
    // verify the default path is exercised by providing `dir` for
    // atmux side + leaving claudeDir unset — the orchestrator will
    // attempt to read `<cwd>/.claude/team.json` which almost certainly
    // doesn't exist under the test runner's cwd, so prior should be
    // null without crashing.
    const result = await computeMappedTeam({ dir: h.atmuxDir });
    // Prior comes from <cwd>/.claude/team.json — typically absent in CI
    // and the repo root (we don't ship a .claude/team.json). Sidecar
    // similarly absent. Both null OR populated (if a dev runs the test
    // with a populated .claude/ next to the repo) is acceptable; the
    // contract under test is "no crash + computed populated."
    expect(result.computed.name).toBe("t");
    expect(result.computed.members).toHaveLength(1);
  });
});
