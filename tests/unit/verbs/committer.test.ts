// Unit tests for src/verbs/committer.ts (ADR-134 T4 / t-64e52aac).
//
// Coverage:
//   - parseCommitterArgs — --sweep / sweep / --team-dir / errors
//   - recordingQueueMergeAttempt — logs + always returns queued
//   - committerSweepVerb — autoMerge.enabled gate, team.json load,
//     state.db open + close, baseBranch resolution via merger-config,
//     sweep dispatch, logger summary line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import type { QueueMergeFn } from "../../../src/core/committer-sweep.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  committer,
  committerSweepVerb,
  parseCommitterArgs,
  recordingQueueMergeAttempt,
} from "../../../src/verbs/committer.ts";
import { orchd } from "../../../src/verbs/orchd.ts";

// ---------- parseCommitterArgs ----------

describe("parseCommitterArgs", () => {
  test("--sweep parses as sweep sub-verb", () => {
    expect(parseCommitterArgs(["--sweep"])).toEqual({ subverb: "sweep" });
  });

  test("'sweep' bare sub-verb form parses the same as --sweep", () => {
    expect(parseCommitterArgs(["sweep"])).toEqual({ subverb: "sweep" });
  });

  test("--team-dir captures path", () => {
    const out = parseCommitterArgs(["--sweep", "--team-dir", "/srv/demo"]);
    expect(out).toEqual({ subverb: "sweep", teamDir: "/srv/demo" });
  });

  test("--team-dir without value throws UsageError", () => {
    expect(() => parseCommitterArgs(["--sweep", "--team-dir"])).toThrow(UsageError);
  });

  test("no sub-verb throws UsageError", () => {
    expect(() => parseCommitterArgs([])).toThrow(UsageError);
    expect(() => parseCommitterArgs(["--team-dir", "/x"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseCommitterArgs(["--frobnicate"])).toThrow(UsageError);
  });

  test("unexpected positional arg throws UsageError", () => {
    expect(() => parseCommitterArgs(["--sweep", "extra"])).toThrow(UsageError);
  });

  test("--drain alias removed per ADR-266 §D2 → UsageError naming orchd --drain", () => {
    expect(() => parseCommitterArgs(["--drain"])).toThrow(UsageError);
    expect(() => parseCommitterArgs(["--drain"])).toThrow(/ADR-266.*orchd --drain/);
  });
  test("'drain' bare form likewise rejected", () => {
    expect(() => parseCommitterArgs(["drain"])).toThrow(UsageError);
  });
  test("--daemon alias removed per ADR-266 §D2 → UsageError naming orchd --start", () => {
    expect(() => parseCommitterArgs(["--daemon"])).toThrow(UsageError);
    expect(() => parseCommitterArgs(["--daemon"])).toThrow(/ADR-266.*orchd --start/);
  });
  test("'daemon' bare form likewise rejected", () => {
    expect(() => parseCommitterArgs(["daemon"])).toThrow(UsageError);
  });
  test("--once / --max-events still parse alongside --sweep (harmless no-op knobs)", () => {
    expect(parseCommitterArgs(["--sweep", "--once", "--max-events", "5"])).toEqual({
      subverb: "sweep",
      once: true,
      maxEvents: 5,
    });
  });
  test("--max-events 0 throws UsageError (must be positive)", () => {
    expect(() => parseCommitterArgs(["--sweep", "--max-events", "0"])).toThrow(UsageError);
  });
  test("--max-events without value throws", () => {
    expect(() => parseCommitterArgs(["--sweep", "--max-events"])).toThrow(UsageError);
  });
  test("--max-events non-numeric throws", () => {
    expect(() => parseCommitterArgs(["--sweep", "--max-events", "abc"])).toThrow(UsageError);
  });
});

// ---------- recordingQueueMergeAttempt ----------

describe("recordingQueueMergeAttempt", () => {
  test("logs the queue intent + returns {queued:true}", async () => {
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const fn = recordingQueueMergeAttempt(logger);
    const result = await fn({ memberBranch: "geoyws-fe-1", aheadCount: 3 });
    expect(result).toEqual({ queued: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("geoyws-fe-1");
    expect(logs[0]).toContain("+3 commits");
    expect(logs[0]).toContain("T3");
  });
});

// ---------- committerSweepVerb integration ----------

interface VerbFixture {
  scratch: string;
  atmuxDir: string;
  teamRoot: string;
}

async function seedTeam(fixture: VerbFixture, cfg: Record<string, unknown>): Promise<void> {
  await mkdir(fixture.atmuxDir, { recursive: true });
  await writeFile(join(fixture.atmuxDir, "team.json"), JSON.stringify(cfg));
}

function fakeSpawnResult(stdout: string, exitCode = 0): SpawnResult {
  return {
    cmd: "git",
    argv: [],
    exitCode,
    signalled: null,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

function makeGitSpawn(
  responders: Record<
    string,
    (rest: ReadonlyArray<string>) => { stdout: string; exitCode?: number }
  >,
): GitSpawn {
  return async (argv) => {
    // `argv` looks like ["-C", "<root>", "<subcmd>", ...] when called from
    // verb-layer; the resolveMergerConfig call uses
    // ["-C", "<root>", "branch", "--show-current"] — also matches the
    // "branch" key.
    const subcmd = argv[2];
    if (subcmd === undefined) return fakeSpawnResult("", 1);
    const responder = responders[subcmd];
    if (responder === undefined) return fakeSpawnResult("", 1);
    const r = responder(argv.slice(3));
    return fakeSpawnResult(r.stdout, r.exitCode ?? 0);
  };
}

describe("committerSweepVerb — integration with team.json + state.db", () => {
  let fixture: VerbFixture;
  beforeEach(async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-committer-verb-"));
    fixture = {
      scratch,
      atmuxDir: join(scratch, ".atmux"),
      teamRoot: scratch,
    };
  });
  afterEach(async () => {
    await rm(fixture.scratch, { recursive: true, force: true });
  });

  test("autoMerge.enabled !== true → fast no-op exit 0 + log line", async () => {
    await seedTeam(fixture, {
      name: "demo",
      members: [],
      autoMerge: { enabled: false },
    });
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const rc = await committerSweepVerb(
      { subverb: "sweep", teamDir: fixture.scratch },
      {
        logger,
        // Even with a git/queue/openDb plumbing, the gate fires
        // BEFORE any sweep work — pass no-ops.
        git: async () => fakeSpawnResult("", 0),
        queueMergeAttempt: async () => ({ queued: true }),
      },
    );
    expect(rc).toBe(0);
    expect(logs.some((l) => l.includes("autoMerge.enabled !== true"))).toBe(true);
    expect(logs.some((l) => l.includes("no-op"))).toBe(true);
  });

  test("no autoMerge block at all → same no-op path", async () => {
    await seedTeam(fixture, { name: "demo", members: [] });
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const rc = await committerSweepVerb(
      { subverb: "sweep", teamDir: fixture.scratch },
      {
        logger,
        git: async () => fakeSpawnResult("", 0),
        queueMergeAttempt: async () => ({ queued: true }),
      },
    );
    expect(rc).toBe(0);
    expect(logs.some((l) => l.includes("no-op"))).toBe(true);
  });

  test("autoMerge.enabled=true + 2 branches (1 ahead, 1 zero) → 1 queued via dispatcher", async () => {
    await seedTeam(fixture, {
      name: "demo",
      members: [],
      merger: { baseBranch: "geoyws" },
      autoMerge: { enabled: true },
    });
    const queueCalls: Array<{ memberBranch: string; aheadCount: number }> = [];
    const queue: QueueMergeFn = async (input) => {
      queueCalls.push(input);
      return { queued: true };
    };
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const rc = await committerSweepVerb(
      { subverb: "sweep", teamDir: fixture.scratch },
      {
        logger,
        git: makeGitSpawn({
          branch: (rest) => {
            // resolveMergerConfig calls `branch --show-current`; sweep
            // calls `branch --list --format=... geoyws-*`. Differentiate
            // by inspecting `rest`.
            if (rest.includes("--show-current")) return { stdout: "geoyws\n" };
            return { stdout: "geoyws-fe-1\ngeoyws-stale\n" };
          },
          "rev-list": (rest) => {
            const range = rest[1] ?? "";
            return { stdout: range.endsWith("geoyws-fe-1") ? "3\n" : "0\n" };
          },
        }),
        queueMergeAttempt: queue,
      },
    );
    expect(rc).toBe(0);
    expect(queueCalls).toEqual([{ memberBranch: "geoyws-fe-1", aheadCount: 3 }]);
    // Summary line emitted.
    const summary = logs.find(
      (l) => l.includes("team='demo'") && l.includes("checked=2") && l.includes("queued=1"),
    );
    expect(summary).toBeDefined();
  });

  test("default queueMergeAttempt is the production dispatcher (T9 / t-6987392a)", async () => {
    await seedTeam(fixture, {
      name: "demo",
      members: [],
      merger: { baseBranch: "geoyws" },
      autoMerge: { enabled: true },
    });
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    // No queueMergeAttempt override — should use the production
    // dispatcher (T9 swap; see src/core/intra-team-merge-dispatcher.ts).
    const rc = await committerSweepVerb(
      { subverb: "sweep", teamDir: fixture.scratch },
      {
        logger,
        git: makeGitSpawn({
          branch: (rest) => {
            if (rest.includes("--show-current")) return { stdout: "geoyws\n" };
            return { stdout: "geoyws-fe-1\n" };
          },
          "rev-list": () => ({ stdout: "2\n" }),
          // The production dispatcher probes worktree cleanliness +
          // merge-base before driving the state machine. Local
          // fixture: clean worktree, merge-base = base tip, no
          // movement; the dispatcher walks open → in_progress and
          // then gate-evaluates from kanban (zero open tasks since
          // the fixture's kanban table is empty).
          "merge-base": () => ({ stdout: "baseTip\n" }),
          "rev-parse": () => ({ stdout: "baseTip\n" }),
          status: () => ({ stdout: "" }),
          // mergeMember inside the production dispatcher
          // (src/abstractions/branch-merge.ts) walks fetch → checkout
          // → merge --no-ff after the rev-list count comes back > 0.
          // Hermetic fixture has no origin remote + no working tree
          // to mutate — fake each as a no-op success so the
          // dispatcher reaches its happy path (t-d78b9b67 sibling-A;
          // T5 sweep deferred the committer sub-cluster).
          fetch: () => ({ stdout: "" }),
          checkout: () => ({ stdout: "" }),
          merge: () => ({ stdout: "" }),
        }),
      },
    );
    expect(rc).toBe(0);
    // Production dispatcher emits its own structured log lines per
    // tick (prefix `[dispatcher]`).
    expect(logs.some((l) => l.includes("[dispatcher]"))).toBe(true);
  });
});

// ---------- top-level committer() dispatch ----------

describe("committer() top-level dispatch", () => {
  test("--sweep dispatches to committerSweepVerb", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-committer-disp-"));
    try {
      await mkdir(join(scratch, ".atmux"), { recursive: true });
      await writeFile(
        join(scratch, ".atmux", "team.json"),
        JSON.stringify({ name: "demo", members: [] }),
      );
      const logs: string[] = [];
      const logger = {
        log: (s: string) => logs.push(s),
        ok: () => {},
        warn: () => {},
        err: () => {},
      };
      const rc = await committer(["--sweep", "--team-dir", scratch], {
        logger,
        git: async () => fakeSpawnResult("", 0),
        queueMergeAttempt: async () => ({ queued: true }),
      });
      expect(rc).toBe(0);
      // autoMerge unset → no-op path
      expect(logs.some((l) => l.includes("no-op"))).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("missing sub-verb → UsageError propagates", async () => {
    await expect(committer([])).rejects.toThrow(UsageError);
  });
});

// ---------- orchd --drain / --start (ADR-202/203 event-driven) ----------
// These exercise the committerDrainVerb / committerDaemonVerb bodies via
// the canonical orchd surface; the `committer --drain` / `--daemon`
// aliases were removed per ADR-266 §D2.

describe("orchd --drain / --start integration (committer bodies)", () => {
  let scratch: string;
  let atmuxDir: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-committer-event-"));
    atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [{ name: "be-1", role: "member", lane: "be" }],
        autoMerge: { enabled: true },
        merger: { enabled: true, baseBranch: "main" },
      }),
    );
    // Pre-create state.db so context-build can open + boot Honker.
    const { closeDatabase, openDatabase } = await import("../../../src/abstractions/sqlite.ts");
    const { migrations } = await import("../../../src/abstractions/sqlite-migrations.ts");
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    closeDatabase(db);
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("--drain with empty events table exits 0 and logs processed=0", async () => {
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const rc = await orchd(["--drain", "--team-dir", scratch], {
      logger,
      git: async () => fakeSpawnResult("main\n", 0),
    });
    expect(rc).toBe(0);
    // Honker kill-switch defaults to ON now but ATMUX_HONKER=off in test env,
    // OR substrate present — either way the drain is honored. Check the log.
    expect(
      logs.some((l) => l.includes("committer --drain") || l.includes("ATMUX_HONKER=off")),
    ).toBe(true);
  });

  // ADR-224 §D6 + ADR-226/227/229 wire-up (driver P0 step 3/5
  // 2026-05-23) — `--drain` iterates `ORCHD_SUBSCRIPTIONS` so the
  // single dispatch path covers both the hardcoded consumers
  // (gitter / lane-router) AND the registry-sourced handlers.
  test("--drain populates ORCHD_SUBSCRIPTIONS via bootstrapOrchd and emits orchd-* totals", async () => {
    // Clear the module-level registry so this test sees the post-drain
    // population starting from a known-empty baseline.
    const { ORCHD_SUBSCRIPTIONS } = await import("../../../src/core/orchd-registry.ts");
    ORCHD_SUBSCRIPTIONS.length = 0;

    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const rc = await orchd(["--drain", "--team-dir", scratch], {
      logger,
      git: async () => fakeSpawnResult("main\n", 0),
    });
    expect(rc).toBe(0);

    // The drain log summary MUST surface orchd-* stats — drift detector
    // for step 3/5's contract. Phase 2 (ADR-231) added 3 consumers:
    // dissolve-solo-worker + spawn:on-ready + spawn:on-unblocked. Then
    // ADR-214 §D2 added the complaint consumer and ADR-212 / e-cc3728bf
    // added the rotation consumer, taking the canonical set to 8.
    const summary = logs.find((l) => l.includes("committer --drain: team="));
    expect(summary).toBeDefined();
    expect(summary).toContain("orchd-subs=8");
    expect(summary).toContain("orchd-errors=0");

    // Registry MUST have been populated with the eight canonical consumer
    // IDs (idempotency means a sibling call wouldn't double-push these).
    // ADR-231 §D2/§D6 added the spawn + solo-worker-dissolve entries on
    // top of parent's auto-merge/dissolve/push (ADR-226/227/229);
    // ADR-214 §D2 added complaint-consumer and ADR-212 / e-cc3728bf added
    // rotation-consumer.
    const consumerIds = ORCHD_SUBSCRIPTIONS.map((s) => s.consumerId).sort();
    expect(consumerIds).toEqual([
      "atmux:complaint-consumer",
      "atmux:orchd:auto-dissolve",
      "atmux:orchd:auto-merge",
      "atmux:orchd:auto-push",
      "atmux:orchd:dissolve-solo-worker",
      "atmux:orchd:spawn:on-ready",
      "atmux:orchd:spawn:on-unblocked",
      "atmux:rotation-consumer",
    ]);

    // Cleanup so sibling tests don't see leaked registry state.
    ORCHD_SUBSCRIPTIONS.length = 0;
  });

  test("--start --once with empty events exits 0 cleanly", async () => {
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    // Bound the loop with --once + --max-events 1 so the watcher exits.
    // Test fires SIGTERM after a short delay as belt-and-braces.
    // Timer bumped 800→1500ms post-Phase 2 (ADR-231) — bootstrap now
    // registers 6 orchd consumers (was 3), each walks an empty event
    // table on startup; the cumulative cold-start work pushes past
    // 800ms on slower CI nodes. 1500ms = ~250ms per consumer with
    // headroom for the watcher's own init.
    const timer = setTimeout(() => process.emit("SIGTERM"), 1500);
    try {
      const rc = await orchd(
        ["--start", "--team-dir", scratch, "--once", "--max-events", "1"],
        {
          logger,
          git: async () => fakeSpawnResult("main\n", 0),
        },
      );
      expect(rc).toBe(0);
      expect(logs.some((l) => l.includes("committer --daemon") && l.includes("starting"))).toBe(
        true,
      );
      expect(logs.some((l) => l.includes("committer --daemon") && l.includes("stopped"))).toBe(
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  });
});
