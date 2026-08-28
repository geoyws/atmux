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

  // ADR-276: with the orchd verb retired, --drain / --daemon returned
  // to committer as its own canonical sub-verbs (the ADR-266 §D2 alias
  // expiry pointed at `atmux orchd`, which no longer exists).
  test("--drain parses as drain sub-verb (re-homed per ADR-276)", () => {
    expect(parseCommitterArgs(["--drain"])).toEqual({ subverb: "drain" });
  });
  test("'drain' bare form parses the same", () => {
    expect(parseCommitterArgs(["drain"])).toEqual({ subverb: "drain" });
  });
  test("--daemon parses as daemon sub-verb (re-homed per ADR-276)", () => {
    expect(parseCommitterArgs(["--daemon"])).toEqual({ subverb: "daemon" });
  });
  test("'daemon' bare form parses the same", () => {
    expect(parseCommitterArgs(["daemon"])).toEqual({ subverb: "daemon" });
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

// ---------- committer --drain / --daemon (ADR-202/203 event-driven) ----------
// These exercise the committerDrainVerb / committerDaemonVerb bodies via
// the committer surface — the canonical home again since ADR-276 retired
// the orchd verb that had owned `--drain` / `--start` (ADR-224/266).

describe("committer --drain / --daemon integration (event-driven bodies)", () => {
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
    const rc = await committer(["--drain", "--team-dir", scratch], {
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

  // ADR-224 §D6 (slimmed by ADR-276) — `--drain` iterates
  // `EVENT_SUBSCRIPTIONS` so the single dispatch path covers both the
  // hardcoded consumers (gitter / lane-router) AND the registry-sourced
  // handlers.
  test("--drain populates EVENT_SUBSCRIPTIONS via bootstrapEventSubscriptions and emits subs-* totals", async () => {
    // Clear the module-level registry so this test sees the post-drain
    // population starting from a known-empty baseline.
    const { EVENT_SUBSCRIPTIONS } = await import("../../../src/core/event-subscriptions.ts");
    EVENT_SUBSCRIPTIONS.length = 0;

    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    const rc = await committer(["--drain", "--team-dir", scratch], {
      logger,
      git: async () => fakeSpawnResult("main\n", 0),
    });
    expect(rc).toBe(0);

    // The drain log summary MUST surface subs-* stats — drift detector
    // for the drain's registry contract. History of the canonical set:
    // 8 (ADR-226/227/229 auto-merge/dissolve/push + the ADR-231 spawn
    // trio + ADR-214 complaint + ADR-212 rotation) → 5 after ADR-280
    // stage 3 removed the spawn trio → 4 after ADR-276: auto-merge +
    // auto-dissolve (epic machinery, ADR-276 §Consequences), rotation
    // (its only producer, the pane-statusline context scan, died with
    // orchd) AND auto-push (nothing emits `epic.merged` once the
    // auto-merge handler — its only emitter — is gone) are deleted,
    // while the ADR-247 lead-stall watchdog trio — previously wired
    // only in the retired orchd verb's handle-one path — is now wired
    // by the drain itself. The shape of the assertion is UNCHANGED: an
    // exact count and an exact sorted ID list, so a consumer silently
    // appearing or disappearing still fails here.
    const summary = logs.find((l) => l.includes("committer --drain: team="));
    expect(summary).toBeDefined();
    expect(summary).toContain("subs=4");
    expect(summary).toContain("subs-processed=0");
    expect(summary).toContain("subs-errors=0");

    // Registry MUST have been populated with the four canonical consumer
    // IDs (idempotency means a sibling call wouldn't double-push these).
    // Consumer-id STRINGS keep their historical values — they are
    // durable subscriber_offsets keys (see event-subscriptions.ts).
    const consumerIds = EVENT_SUBSCRIPTIONS.map((s) => s.consumerId).sort();
    expect(consumerIds).toEqual([
      "atmux:complaint-consumer",
      "atmux:lead-stall-watchdog:story-ready",
      "atmux:lead-stall-watchdog:story-unclaimed",
      "atmux:lead-stall-watchdog:task-unclaimed",
    ]);
    // Retired consumers are gone from the REGISTRY, not merely
    // unexported — a stale row here would keep Honker draining a topic
    // into a handler that no longer exists.
    expect(consumerIds).not.toContain("atmux:orchd:auto-push");
    expect(consumerIds).not.toContain("atmux:orchd:auto-merge");
    expect(consumerIds).not.toContain("atmux:orchd:auto-dissolve");
    expect(consumerIds).not.toContain("atmux:rotation-consumer");
    expect(consumerIds).not.toContain("atmux:orchd:spawn:on-ready");
    expect(consumerIds).not.toContain("atmux:orchd:spawn:on-unblocked");
    expect(consumerIds).not.toContain("atmux:orchd:dissolve-solo-worker");

    // Cleanup so sibling tests don't see leaked registry state.
    EVENT_SUBSCRIPTIONS.length = 0;
  });

  test("--daemon --once with empty events exits 0 cleanly", async () => {
    const logs: string[] = [];
    const logger = {
      log: (s: string) => logs.push(s),
      ok: () => {},
      warn: () => {},
      err: () => {},
    };
    // Bound the loop with --once + --max-events 1 so the watcher exits.
    // Test fires SIGTERM after a short delay as belt-and-braces.
    const timer = setTimeout(() => process.emit("SIGTERM"), 1500);
    try {
      const rc = await committer(
        ["--daemon", "--team-dir", scratch, "--once", "--max-events", "1"],
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
