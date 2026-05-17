// Unit tests for src/verbs/sync.ts (ADR-164 T2 base + T4 flag-parse + T6 --dry-run).
//
// Composed coverage:
//   - T2 (t-a890648c): dispatcher surface — bare invocation, empty-string
//     subverb, unknown subverb, known-subverb routing.
//   - T4 (t-87e81c8e): flag-parse surface — `--overwrite-briefs` accepted,
//     unknown `-`-prefixed flag refused, positional arg refused.
//   - T6 (t-fe4a570e): `--dry-run` parses + wires through computeMappedTeam
//     → renderDiff → stdout sink; returns 0 without writing. Fresh-file
//     and existing-file cases both covered.
//
// T5 (drift / --force) and T7 (integrated bats round-trip) layer on top.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../../src/errors.ts";
import { dispatchSyncSubverb } from "../../../src/verbs/sync.ts";

describe("dispatchSyncSubverb", () => {
  test("missing subverb throws UsageError listing known sub-verbs", async () => {
    await expect(dispatchSyncSubverb([])).rejects.toThrow(UsageError);
    await expect(dispatchSyncSubverb([])).rejects.toThrow(/claude-team-json/);
  });

  test("empty-string subverb throws UsageError (matches bare invocation)", async () => {
    await expect(dispatchSyncSubverb([""])).rejects.toThrow(UsageError);
  });

  test("unknown subverb throws UsageError naming the bad subverb + list", async () => {
    await expect(dispatchSyncSubverb(["frobnicate"])).rejects.toThrow(UsageError);
    await expect(dispatchSyncSubverb(["frobnicate"])).rejects.toThrow(
      /unknown subverb 'frobnicate'/,
    );
    await expect(dispatchSyncSubverb(["frobnicate"])).rejects.toThrow(/claude-team-json/);
  });

  test("claude-team-json (no flags) → stub error pointing at T4/T5 write path", async () => {
    // T6 (t-fe4a570e) ships the --dry-run preview path. The non-dry-run
    // write path still throws stub-status pointing at T4 + T5 follow-ups
    // — the dispatcher itself routed correctly (an unknown-subverb path
    // would surface UsageError instead, not plain Error).
    await expect(dispatchSyncSubverb(["claude-team-json"])).rejects.toThrow(
      /write path not yet implemented.*T4.*T5/,
    );
  });

  test("claude-team-json --overwrite-briefs parses + routes (T4 flag-parse)", async () => {
    // T4 (t-87e81c8e) parses --overwrite-briefs. Without --dry-run the
    // write path is still stub (T4 brief-preserve write wiring + T5 drift
    // land in follow-ups), so the dispatcher throws the not-yet-implemented
    // marker for the write branch.
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--overwrite-briefs"]),
    ).rejects.toThrow(/write path not yet implemented/);
  });

  test("claude-team-json unknown flag throws UsageError (T4 flag-parse)", async () => {
    // `--frobnicate` is not a recognized flag at any task; the parser
    // refuses with UsageError rather than swallowing it silently. Locks
    // in the typo-protection promise of the flag-parse surface across
    // T4 + T6 (and the future T5 --force).
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--frobnicate"]),
    ).rejects.toThrow(UsageError);
    await expect(
      dispatchSyncSubverb(["claude-team-json", "--frobnicate"]),
    ).rejects.toThrow(/unknown flag.*--frobnicate/);
  });

  test("claude-team-json refuses positional args (T4 flag-parse)", async () => {
    await expect(
      dispatchSyncSubverb(["claude-team-json", "stray-positional"]),
    ).rejects.toThrow(UsageError);
    await expect(
      dispatchSyncSubverb(["claude-team-json", "stray-positional"]),
    ).rejects.toThrow(/unexpected positional/);
  });
});

describe("dispatchSyncSubverb — --dry-run (T6 / t-fe4a570e)", () => {
  // Per-test mkdtemp so the atmux team.json + .claude/team.json fixtures
  // are scoped to one case each. `opts.dir` pins the atmux .atmux/ dir
  // and `opts.claudeDir` pins the .claude/ dir — both bypass the cwd
  // walk-up so the test can't accidentally read a host .atmux from /tmp.

  const ATMUX_TEAM_FIXTURE = {
    name: "fixture-team",
    description: "fixture roster for T6 dry-run preview tests",
    members: [
      { name: "lead", role: "team-lead", emoji: "🧭", model: "default" },
      { name: "planner", role: "planner", emoji: "🎯", model: "claude-opus-4-7" },
      { name: "be-1", role: "member", emoji: "📦" },
    ],
  };

  async function seedEnv() {
    const root = await mkdtemp(join(tmpdir(), "sync-claude-team-json-test-"));
    const atmuxDir = join(root, ".atmux");
    const claudeDir = join(root, ".claude");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify(ATMUX_TEAM_FIXTURE),
    );
    return { root, atmuxDir, claudeDir };
  }

  test("--dry-run on fresh file (no prior .claude/team.json) → all + prefixes, exit 0", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    try {
      let out = "";
      const rc = await dispatchSyncSubverb(
        ["claude-team-json", "--dry-run"],
        {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
          stdout: (s) => {
            out += s;
          },
        },
      );
      expect(rc).toBe(0);
      // Fresh-file header
      expect(out).toContain("fresh file");
      // Top-level fields rendered with + prefix
      expect(out).toMatch(/^\+ {2}name: fixture-team/m);
      // Each member rendered with + prefix
      expect(out).toContain("+  [member: team-lead]"); // lead → team-lead rewrite
      expect(out).toContain("+  [member: planner]");
      expect(out).toContain("+  [member: be-1]");
      // No - lines on fresh file
      expect(out.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--dry-run vs existing .claude/team.json → diff against prior, no write", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    // Pre-seed the Claude side with an out-of-date roster — drop be-1,
    // add a stale extra-1 (so the diff covers both addition + removal).
    await writeFile(
      join(claudeDir, "team.json"),
      JSON.stringify({
        name: "fixture-team",
        members: [
          { name: "team-lead", agentType: "team-lead", color: "white" },
          { name: "planner", color: "magenta" },
          { name: "extra-1", color: "red" },
        ],
      }),
    );
    try {
      let out = "";
      const rc = await dispatchSyncSubverb(
        ["claude-team-json", "--dry-run"],
        {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
          stdout: (s) => {
            out += s;
          },
        },
      );
      expect(rc).toBe(0);
      // Non-fresh header
      expect(out).toContain("no write performed");
      // be-1 is an addition
      expect(out).toContain("+  [member: be-1]");
      // extra-1 is a removal
      expect(out).toContain("-  [member: extra-1]");
      // Pre-existing unchanged member rendered with space prefix on header
      expect(out).toMatch(/^ {3}\[member: team-lead\]/m);
      // SIDE-EFFECT: .claude/team.json must NOT have been modified —
      // re-read and assert the stale roster is still present.
      const after = JSON.parse(
        await Bun.file(join(claudeDir, "team.json")).text(),
      );
      expect(after.members).toHaveLength(3);
      expect(after.members[2].name).toBe("extra-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--dry-run + --overwrite-briefs both parse (combined flags)", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    try {
      let out = "";
      const rc = await dispatchSyncSubverb(
        ["claude-team-json", "--dry-run", "--overwrite-briefs"],
        {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
          stdout: (s) => {
            out += s;
          },
        },
      );
      expect(rc).toBe(0);
      // --overwrite-briefs parses cleanly + does NOT short-circuit dry-run.
      // T4's mergeBriefs is not yet threaded into computeMappedTeam (out of
      // scope for T6), so the diff render is the same as the bare --dry-run
      // case — the test asserts both flags coexist, not the brief content.
      expect(out).toContain("fresh file");
      expect(out).toContain("+  [member: team-lead]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--dry-run with no .atmux/team.json → user-facing error (not silent)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-claude-team-json-noteam-"));
    const atmuxDir = join(root, ".atmux");
    const claudeDir = join(root, ".claude");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    try {
      await expect(
        dispatchSyncSubverb(["claude-team-json", "--dry-run"], {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
          stdout: () => {},
        }),
      ).rejects.toThrow(/no \.atmux\/team\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
