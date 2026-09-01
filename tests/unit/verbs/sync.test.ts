// Unit tests for src/verbs/sync.ts (ADR-164 T2 base + T4 flag-parse + T5
// write path + T6 --dry-run).
//
// Composed coverage:
//   - T2 (t-a890648c): dispatcher surface — bare invocation, empty-string
//     subverb, unknown subverb, known-subverb routing.
//   - T4 (t-87e81c8e): flag-parse surface — `--overwrite-briefs` accepted,
//     unknown `-`-prefixed flag refused, positional arg refused.
//   - T5 (t-c2b757c1 + 712b197 wire-through): `--force` flag-parse,
//     write path (writeSync) atomic-writes .claude/team.json with the
//     _atmuxSync marker, DriftAbortError → exit 65 + 3-line hint to
//     stderr, --force overrides drift.
//   - T6 (t-fe4a570e): `--dry-run` parses + wires through computeMappedTeam
//     → renderDiff → stdout sink; returns 0 without writing. Fresh-file
//     and existing-file cases both covered.
//
// T7 (t-4329b053) integrated bats round-trip layers atop these.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EX_DATAERR,
  SYNC_MARKER_KEY,
  computeFingerprint,
} from "../../../src/core/sync-claude-team-json/drift.ts";
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

  test("claude-team-json (no flags, no .atmux/team.json) → surfaces actionable error (routing OK)", async () => {
    // Routing assertion: the dispatcher reaches the claude-team-json
    // subverb (an unknown-subverb path would surface UsageError instead,
    // not the plain Error below). Pin `dir` + `stopAt` to a fresh tmpdir
    // with no team.json so the walk-up doesn't drift onto the parent
    // atmux repo's own .atmux/. writeSync's computeMappedTeam refuses
    // with "no .atmux/team.json" — proving we got past the dispatcher
    // into the real handler. Full happy-path write coverage lives in
    // the "write path (T5)" block below + the bats round-trip +
    // tests/unit/core/sync-claude-team-json/index.test.ts.
    const root = await mkdtemp(join(tmpdir(), "sync-route-bare-"));
    const atmuxDir = join(root, ".atmux");
    const claudeDir = join(root, ".claude");
    await mkdir(atmuxDir, { recursive: true });
    try {
      await expect(
        dispatchSyncSubverb(["claude-team-json"], {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
        }),
      ).rejects.toThrow(/no \.atmux\/team\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude-team-json --overwrite-briefs parses + routes (T4 flag-parse)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-route-briefs-"));
    const atmuxDir = join(root, ".atmux");
    const claudeDir = join(root, ".claude");
    await mkdir(atmuxDir, { recursive: true });
    try {
      await expect(
        dispatchSyncSubverb(["claude-team-json", "--overwrite-briefs"], {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
        }),
      ).rejects.toThrow(/no \.atmux\/team\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude-team-json --force parses + routes (T5 flag-parse)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-route-force-"));
    const atmuxDir = join(root, ".atmux");
    const claudeDir = join(root, ".claude");
    await mkdir(atmuxDir, { recursive: true });
    try {
      await expect(
        dispatchSyncSubverb(["claude-team-json", "--force"], {
          dir: atmuxDir,
          claudeDir,
          stopAt: root,
        }),
      ).rejects.toThrow(/no \.atmux\/team\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("claude-team-json unknown flag throws UsageError (T4 + T5 flag-parse)", async () => {
    // `--frobnicate` is not a recognized flag at any task; the parser
    // refuses with UsageError rather than swallowing it silently. Locks
    // in the typo-protection promise of the flag-parse surface across
    // T4 + T5 + T6.
    await expect(dispatchSyncSubverb(["claude-team-json", "--frobnicate"])).rejects.toThrow(
      UsageError,
    );
    await expect(dispatchSyncSubverb(["claude-team-json", "--frobnicate"])).rejects.toThrow(
      /unknown flag.*--frobnicate/,
    );
  });

  test("claude-team-json refuses positional args (T4 flag-parse)", async () => {
    await expect(dispatchSyncSubverb(["claude-team-json", "stray-positional"])).rejects.toThrow(
      UsageError,
    );
    await expect(dispatchSyncSubverb(["claude-team-json", "stray-positional"])).rejects.toThrow(
      /unexpected positional/,
    );
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
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(ATMUX_TEAM_FIXTURE));
    return { root, atmuxDir, claudeDir };
  }

  test("--dry-run on fresh file (no prior .claude/team.json) → all + prefixes, exit 0", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    try {
      let out = "";
      const rc = await dispatchSyncSubverb(["claude-team-json", "--dry-run"], {
        dir: atmuxDir,
        claudeDir,
        stopAt: root,
        stdout: (s) => {
          out += s;
        },
      });
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
      const rc = await dispatchSyncSubverb(["claude-team-json", "--dry-run"], {
        dir: atmuxDir,
        claudeDir,
        stopAt: root,
        stdout: (s) => {
          out += s;
        },
      });
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
      const after = JSON.parse(await Bun.file(join(claudeDir, "team.json")).text());
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

describe("dispatchSyncSubverb — write path (T5 / t-c2b757c1)", () => {
  // End-to-end coverage of the non-dry-run path through the verb
  // dispatcher: writeSync runs, .claude/team.json is materialized, the
  // _atmuxSync marker is stamped, drift detection / --force routing
  // surface as exit 0 vs exit 65. Pairs with the unit-level writeSync
  // coverage in tests/unit/core/sync-claude-team-json/index.test.ts — the
  // dispatcher tests assert exit codes + stderr surface, the unit tests
  // assert the SyncEvent log + payload composition.

  const FIXED_TS_DATE = new Date("2026-05-17T10:00:00.000Z");
  const FIXED_NOW = () => FIXED_TS_DATE;

  const ATMUX_TEAM_FIXTURE = {
    name: "fixture-team",
    description: "write-path coverage roster",
    members: [
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "be-1", role: "member", emoji: "📦" },
    ],
  };

  async function seedEnv() {
    const root = await mkdtemp(join(tmpdir(), "sync-claude-team-json-write-"));
    const atmuxDir = join(root, ".atmux");
    const claudeDir = join(root, ".claude");
    await mkdir(atmuxDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(ATMUX_TEAM_FIXTURE));
    return { root, atmuxDir, claudeDir };
  }

  test("fresh-file write → exit 0, .claude/team.json materialized with marker", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    try {
      const stderrBuf: string[] = [];
      const rc = await dispatchSyncSubverb(["claude-team-json"], {
        dir: atmuxDir,
        claudeDir,
        stopAt: root,
        now: FIXED_NOW,
        stderr: (s) => stderrBuf.push(s),
      });
      expect(rc).toBe(0);
      expect(stderrBuf).toHaveLength(0); // no drift on fresh file

      const raw = await readFile(join(claudeDir, "team.json"), "utf8");
      const written = JSON.parse(raw);
      expect(written.name).toBe("fixture-team");
      expect(written.members).toHaveLength(2);
      expect(written.members[0].name).toBe("team-lead"); // rewritten
      const marker = written[SYNC_MARKER_KEY];
      expect(marker.schemaRev).toBe("v1");
      expect(marker.lastSyncedAt).toBe(FIXED_TS_DATE.toISOString());
      expect(marker.sourceFingerprint).toBe(computeFingerprint(written.members));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("drift detected without --force → exit 65 + 3-line hint to stderr", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    // Seed .claude with a marker whose fingerprint won't match.
    await writeFile(
      join(claudeDir, "team.json"),
      JSON.stringify({
        name: "fixture-team",
        members: [
          { name: "team-lead", agentType: "team-lead", color: "white" },
          { name: "extra-1", color: "red" }, // hand-added
        ],
        [SYNC_MARKER_KEY]: {
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
          schemaRev: "v1",
          sourceFingerprint:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      }),
    );
    try {
      const stderrBuf: string[] = [];
      const rc = await dispatchSyncSubverb(["claude-team-json"], {
        dir: atmuxDir,
        claudeDir,
        stopAt: root,
        now: FIXED_NOW,
        stderr: (s) => stderrBuf.push(s),
      });
      expect(rc).toBe(EX_DATAERR);
      expect(rc).toBe(65);
      // One-line drift warning + 3-line hint + 1-line "refusing"
      // follow-up are all routed to stderr.
      const stderrOut = stderrBuf.join("");
      expect(stderrOut).toContain("🔧 [sync-claude-team-json]");
      expect(stderrOut).toContain("prior fingerprint:");
      expect(stderrOut).toContain("current fingerprint:");
      expect(stderrOut).toContain("last synced at:");
      expect(stderrOut).toContain("re-run with --force");
      // The hand-edited file MUST be untouched on the abort path.
      const after = JSON.parse(await readFile(join(claudeDir, "team.json"), "utf8"));
      expect(after.members).toHaveLength(2);
      expect(after.members[1].name).toBe("extra-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--force overrides drift → exit 0, file overwritten with fresh marker", async () => {
    const { root, atmuxDir, claudeDir } = await seedEnv();
    await writeFile(
      join(claudeDir, "team.json"),
      JSON.stringify({
        name: "fixture-team",
        members: [
          { name: "team-lead", agentType: "team-lead", color: "white" },
          { name: "extra-1", color: "red" },
        ],
        [SYNC_MARKER_KEY]: {
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
          schemaRev: "v1",
          sourceFingerprint:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      }),
    );
    try {
      const stderrBuf: string[] = [];
      const rc = await dispatchSyncSubverb(["claude-team-json", "--force"], {
        dir: atmuxDir,
        claudeDir,
        stopAt: root,
        now: FIXED_NOW,
        stderr: (s) => stderrBuf.push(s),
      });
      expect(rc).toBe(0);
      // Warning still emitted (transparency); no "refusing" follow-up.
      const stderrOut = stderrBuf.join("");
      expect(stderrOut).toContain("drift detected");
      expect(stderrOut).not.toContain("refusing to overwrite");
      // The atmux-side roster (extra-1 dropped) is now on disk.
      const after = JSON.parse(await readFile(join(claudeDir, "team.json"), "utf8"));
      expect(after.members.map((m: { name: string }) => m.name)).toEqual(["team-lead", "be-1"]);
      expect(after[SYNC_MARKER_KEY].lastSyncedAt).toBe(FIXED_TS_DATE.toISOString());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
