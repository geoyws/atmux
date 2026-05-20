// Unit tests for src/core/merger-config.ts (ADR-179 W4 / t-f9f49ded).
//
// Coverage (per ADR test plan + 100%-on-new-code rule):
//   - resolveMergerConfig with no `team.merger` block → defaults
//     (enabled=false, stalenessHours=24, baseBranch from git).
//   - With partial config (just enabled: true) → fills other fields
//     from defaults; baseBranch from git.
//   - With full config (all three fields explicit) → no git call.
//   - git branch --show-current returns empty (detached HEAD) →
//     ConfigError naming detached HEAD.
//   - git branch --show-current fails → ConfigError surfacing rc + stderr.
//   - Schema: TeamMerger Zod parses default / partial / full shapes
//     correctly under the Team schema; rejects bogus fields.

import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import { resolveMergerConfig } from "../../../src/core/merger-config.ts";
import { ConfigError } from "../../../src/errors.ts";
import { Team, TeamMerger } from "../../../src/schema/team.ts";

function ok(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function fail(stderr: string, code = 128): SpawnResult {
  return {
    exitCode: code,
    stdout: "",
    stderr,
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

/** Minimal Team object that parses through Zod with the merger field
 *  set or unset. The `members: []` + bare `name` satisfy the Team
 *  schema's required fields. */
function teamWith(merger: unknown): Team {
  const raw = { name: "atmux", members: [], merger };
  return Team.parse(raw);
}

// ---------- TeamMerger Zod block ----------

describe("TeamMerger schema", () => {
  test("empty merger block → defaults filled by Zod", () => {
    const parsed = TeamMerger.parse({});
    expect(parsed).toEqual({ enabled: false, stalenessHours: 24 });
  });

  test("partial: enabled only → fills stalenessHours default", () => {
    const parsed = TeamMerger.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.stalenessHours).toBe(24);
    expect(parsed.baseBranch).toBeUndefined();
  });

  test("full: all three fields explicit pass through", () => {
    const parsed = TeamMerger.parse({
      enabled: true,
      baseBranch: "geoyws",
      stalenessHours: 48,
    });
    expect(parsed).toEqual({ enabled: true, baseBranch: "geoyws", stalenessHours: 48 });
  });

  test("stalenessHours: rejects 0 and negative (min(1))", () => {
    expect(() => TeamMerger.parse({ stalenessHours: 0 })).toThrow();
    expect(() => TeamMerger.parse({ stalenessHours: -1 })).toThrow();
  });

  test("stalenessHours: rejects non-integer", () => {
    expect(() => TeamMerger.parse({ stalenessHours: 1.5 })).toThrow();
  });

  test("baseBranch: rejects empty string (min(1))", () => {
    expect(() => TeamMerger.parse({ baseBranch: "" })).toThrow();
  });

  test("strict: unknown keys rejected", () => {
    expect(() => TeamMerger.parse({ enabled: true, bogus: "field" })).toThrow();
  });
});

// ---------- resolveMergerConfig ----------

describe("resolveMergerConfig", () => {
  test("no merger block on team → enabled:false, stalenessHours:24, baseBranch from git", async () => {
    const team = teamWith(undefined);
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("geoyws\n");
    };
    const result = await resolveMergerConfig(team, "/srv/repo", { git });
    expect(result).toEqual({ enabled: false, baseBranch: "geoyws", stalenessHours: 24 });
    // Single git call: branch --show-current.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["-C", "/srv/repo", "branch", "--show-current"]);
  });

  test("partial: enabled:true only → baseBranch resolved via git, stalenessHours default", async () => {
    const team = teamWith({ enabled: true });
    const git: GitSpawn = async () => ok("main\n");
    const result = await resolveMergerConfig(team, "/srv/repo", { git });
    expect(result).toEqual({ enabled: true, baseBranch: "main", stalenessHours: 24 });
  });

  test("full: all three set → ZERO git calls (baseBranch explicit)", async () => {
    const team = teamWith({ enabled: true, baseBranch: "geoyws", stalenessHours: 12 });
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    const result = await resolveMergerConfig(team, "/srv/repo", { git });
    expect(result).toEqual({ enabled: true, baseBranch: "geoyws", stalenessHours: 12 });
    expect(calls).toHaveLength(0);
  });

  test("detached HEAD (git returns empty stdout) AND no explicit baseBranch → ConfigError", async () => {
    const team = teamWith({ enabled: true });
    const git: GitSpawn = async () => ok("\n");
    await expect(resolveMergerConfig(team, "/srv/repo", { git })).rejects.toThrow(ConfigError);
    await expect(resolveMergerConfig(team, "/srv/repo", { git })).rejects.toThrow(/detached HEAD/);
  });

  test("detached HEAD BUT explicit baseBranch → succeeds (git never called)", async () => {
    // Explicit pin in team.json overrides the runtime resolution.
    const team = teamWith({ enabled: true, baseBranch: "geoyws" });
    const git: GitSpawn = async () => ok("\n"); // would be detached if called
    const result = await resolveMergerConfig(team, "/srv/repo", { git });
    expect(result.baseBranch).toBe("geoyws");
  });

  test("git failure → ConfigError surfacing rc + stderr", async () => {
    const team = teamWith({ enabled: true });
    const git: GitSpawn = async () => fail("fatal: not a git repository", 128);
    await expect(resolveMergerConfig(team, "/not-a-repo", { git })).rejects.toThrow(ConfigError);
    await expect(resolveMergerConfig(team, "/not-a-repo", { git })).rejects.toThrow(
      /branch --show-current` failed/,
    );
  });

  test("empty-string baseBranch (defensive) treated as unset → resolves via git", async () => {
    // Zod rejects empty strings at parse-time (min(1)), but a non-Zod
    // caller could synthesize one. The helper should still resolve
    // rather than emit an empty branch downstream.
    const team = {
      name: "atmux",
      members: [],
      merger: { enabled: true, baseBranch: "" },
    } as unknown as Team;
    const git: GitSpawn = async () => ok("geoyws\n");
    const result = await resolveMergerConfig(team, "/srv/repo", { git });
    expect(result.baseBranch).toBe("geoyws");
  });
});

// ---------- Team schema integration ----------

describe("Team schema integration", () => {
  test("Team.parse: no merger field → team.merger undefined", () => {
    const parsed = Team.parse({ name: "atmux", members: [] });
    expect(parsed.merger).toBeUndefined();
  });

  test("Team.parse: merger field with default-only → Zod fills defaults", () => {
    const parsed = Team.parse({ name: "atmux", members: [], merger: {} });
    expect(parsed.merger).toEqual({ enabled: false, stalenessHours: 24 });
  });

  test("Team.parse: rejects merger.bogus key", () => {
    expect(() =>
      Team.parse({ name: "atmux", members: [], merger: { enabled: true, bogus: 1 } }),
    ).toThrow();
  });
});
