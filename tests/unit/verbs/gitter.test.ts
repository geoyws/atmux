// Unit tests for src/verbs/gitter.ts (ADR-134 T4 / t-64e52aac).
//
// Coverage:
//   - parseGitterArgs — --sweep / sweep / --team-dir / errors
//   - recordingQueueMergeAttempt — logs + always returns queued
//   - gitterSweepVerb — autoMerge.enabled gate, team.json load,
//     state.db open + close, baseBranch resolution via merger-config,
//     sweep dispatch, logger summary line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import type { QueueMergeFn } from "../../../src/core/gitter-sweep.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  parseGitterArgs,
  gitter,
  gitterSweepVerb,
  recordingQueueMergeAttempt,
} from "../../../src/verbs/gitter.ts";

// ---------- parseGitterArgs ----------

describe("parseGitterArgs", () => {
  test("--sweep parses as sweep sub-verb", () => {
    expect(parseGitterArgs(["--sweep"])).toEqual({ subverb: "sweep" });
  });

  test("'sweep' bare sub-verb form parses the same as --sweep", () => {
    expect(parseGitterArgs(["sweep"])).toEqual({ subverb: "sweep" });
  });

  test("--team-dir captures path", () => {
    const out = parseGitterArgs(["--sweep", "--team-dir", "/srv/demo"]);
    expect(out).toEqual({ subverb: "sweep", teamDir: "/srv/demo" });
  });

  test("--team-dir without value throws UsageError", () => {
    expect(() => parseGitterArgs(["--sweep", "--team-dir"])).toThrow(UsageError);
  });

  test("no sub-verb throws UsageError", () => {
    expect(() => parseGitterArgs([])).toThrow(UsageError);
    expect(() => parseGitterArgs(["--team-dir", "/x"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseGitterArgs(["--frobnicate"])).toThrow(UsageError);
  });

  test("unexpected positional arg throws UsageError", () => {
    expect(() => parseGitterArgs(["--sweep", "extra"])).toThrow(UsageError);
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

// ---------- gitterSweepVerb integration ----------

interface VerbFixture {
  scratch: string;
  atmuxDir: string;
  teamRoot: string;
}

async function seedTeam(
  fixture: VerbFixture,
  cfg: Record<string, unknown>,
): Promise<void> {
  await mkdir(fixture.atmuxDir, { recursive: true });
  await writeFile(
    join(fixture.atmuxDir, "team.json"),
    JSON.stringify(cfg),
  );
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

describe("gitterSweepVerb — integration with team.json + state.db", () => {
  let fixture: VerbFixture;
  beforeEach(async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-gitter-verb-"));
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
    const rc = await gitterSweepVerb(
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
    const rc = await gitterSweepVerb(
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
    const rc = await gitterSweepVerb(
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
    const summary = logs.find((l) =>
      l.includes("team='demo'") && l.includes("checked=2") && l.includes("queued=1"),
    );
    expect(summary).toBeDefined();
  });

  test("default queueMergeAttempt falls back to recordingQueueMergeAttempt", async () => {
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
    // No queueMergeAttempt override — should use the recording stub.
    const rc = await gitterSweepVerb(
      { subverb: "sweep", teamDir: fixture.scratch },
      {
        logger,
        git: makeGitSpawn({
          branch: (rest) => {
            if (rest.includes("--show-current")) return { stdout: "geoyws\n" };
            return { stdout: "geoyws-fe-1\n" };
          },
          "rev-list": () => ({ stdout: "2\n" }),
        }),
      },
    );
    expect(rc).toBe(0);
    // Recording stub log line.
    expect(logs.some((l) => l.includes("would queue merge") && l.includes("T3"))).toBe(true);
  });
});

// ---------- top-level gitter() dispatch ----------

describe("gitter() top-level dispatch", () => {
  test("--sweep dispatches to gitterSweepVerb", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-gitter-disp-"));
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
      const rc = await gitter(["--sweep", "--team-dir", scratch], {
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
    await expect(gitter([])).rejects.toThrow(UsageError);
  });
});
