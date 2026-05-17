// Unit tests for src/verbs/team/sweep-epics.ts (ADR-170).
//
// Strategy: build an in-memory LoadedCockpit + stub git/openDb so the
// verdict ladder exercises observably. Dissolve is mocked so --apply
// assertions check which epicIds got passed without touching the real
// filesystem.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../../src/abstractions/worktree.ts";
import type { SpawnResult } from "../../../../src/abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import type { LoadedCockpit } from "../../../../src/core/cockpit.ts";
import {
  type SweepEpicsOpts,
  parseSweepEpicsArgs,
  sweepEpics,
} from "../../../../src/verbs/team/sweep-epics.ts";

let scratch: string;
let parentRoot: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-sweep-epics-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  parentRoot = join(scratch, "parent");
  await mkdir(parentRoot, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Arg parsing ----------

describe("parseSweepEpicsArgs", () => {
  test("defaults — read-only, 24h idle, no filter, table output", () => {
    const r = parseSweepEpicsArgs([]);
    expect(r.apply).toBe(false);
    expect(r.idleHours).toBe(24);
    expect(r.parent).toBeUndefined();
    expect(r.json).toBe(false);
  });

  test("all flags honored", () => {
    const r = parseSweepEpicsArgs(["--apply", "--idle-hours", "48", "--parent", "sopx", "--json"]);
    expect(r.apply).toBe(true);
    expect(r.idleHours).toBe(48);
    expect(r.parent).toBe("sopx");
    expect(r.json).toBe(true);
  });

  test("--idle-hours rejects non-positive", () => {
    expect(() => parseSweepEpicsArgs(["--idle-hours", "0"])).toThrow(/positive integer/);
    expect(() => parseSweepEpicsArgs(["--idle-hours", "abc"])).toThrow(/positive integer/);
  });

  test("unknown arg refuses", () => {
    expect(() => parseSweepEpicsArgs(["--bogus"])).toThrow(/unexpected arg/);
  });
});

// ---------- Verdict ladder ----------

describe("sweepEpics — verdict ladder", () => {
  test("DRAIN when child kanban has open tasks", async () => {
    const epicRoot = await seedEpicWorktree("e-drain");
    await seedKanban(epicRoot, [{ id: "t-1", status: "todo" }]);
    const captured = captureLogger();
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-drain"),
      git: cleanPushedGitStub(epicRoot),
      logger: captured.logger,
    });
    const rc = await sweepEpics([], opts);
    expect(rc).toBe(0);
    expect(captured.text()).toContain("| DRAIN | parent | e-drain | 1 |");
  });

  test("SAFE-DISSOLVE when 0 open tasks + clean + pushed", async () => {
    await seedEpicWorktree("e-safe");
    const captured = captureLogger();
    const dissolveCalls: string[] = [];
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-safe"),
      git: cleanPushedGitStub(join(scratch, "parent-epics", "e-safe")),
      logger: captured.logger,
      dissolve: async (argv) => {
        dissolveCalls.push(argv[0] ?? "");
        return 0;
      },
    });
    const rc = await sweepEpics(["--apply"], opts);
    expect(rc).toBe(0);
    expect(captured.text()).toContain("| SAFE-DISSOLVE | parent | e-safe |");
    expect(dissolveCalls).toEqual(["e-safe"]);
  });

  test("STALE-IDLE when 0 open tasks + not pushed + commit older than idleHours", async () => {
    await seedEpicWorktree("e-stale");
    const captured = captureLogger();
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-stale"),
      // commit 100h ago, no `origin/<branch>`
      git: cleanUnpushedGitStub(100 * 3600),
      now: () => 0, // commit timestamp is then -100h relative; readLastCommitHoursAgo computes (now/1000 - epochSec)/3600
      logger: captured.logger,
    });
    const rc = await sweepEpics(["--idle-hours", "24"], opts);
    expect(rc).toBe(0);
    expect(captured.text()).toContain("| STALE-IDLE | parent | e-stale |");
  });

  test("RISKY when worktree dirty", async () => {
    await seedEpicWorktree("e-dirty");
    const captured = captureLogger();
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-dirty"),
      git: dirtyGitStub(),
      logger: captured.logger,
    });
    const rc = await sweepEpics([], opts);
    expect(rc).toBe(0);
    expect(captured.text()).toContain("| RISKY | parent | e-dirty |");
  });

  test("MISSING when worktree path doesn't exist", async () => {
    // No seedEpicWorktree — cockpit references an epicId with no on-disk worktree.
    const captured = captureLogger();
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-ghost"),
      git: cleanPushedGitStub("/nonexistent"),
      logger: captured.logger,
    });
    const rc = await sweepEpics([], opts);
    expect(rc).toBe(0);
    expect(captured.text()).toContain("| MISSING | parent | e-ghost |");
  });
});

// ---------- --apply gate ----------

describe("sweepEpics — --apply only fires for SAFE-DISSOLVE", () => {
  test("DRAIN + RISKY are skipped, only SAFE-DISSOLVE dispatched", async () => {
    await seedEpicWorktree("e-safe");
    const epicDrainRoot = await seedEpicWorktree("e-drain");
    await seedKanban(epicDrainRoot, [{ id: "t-1", status: "todo" }]);
    await seedEpicWorktree("e-dirty");

    const captured = captureLogger();
    const dissolveCalls: string[] = [];
    const opts = baseOpts({
      cockpit: cockpitWithEpics(["e-safe", "e-drain", "e-dirty"]),
      // Per-repo routing: only "e-safe" reports clean+pushed; e-drain is
      // clean+pushed but DRAIN gate fires first; e-dirty reports dirty.
      git: perRepoGitStub({
        [join(scratch, "parent-epics", "e-safe")]: { dirty: false, pushed: true },
        [join(scratch, "parent-epics", "e-drain")]: { dirty: false, pushed: true },
        [join(scratch, "parent-epics", "e-dirty")]: { dirty: true, pushed: false },
      }),
      logger: captured.logger,
      dissolve: async (argv) => {
        dissolveCalls.push(argv[0] ?? "");
        return 0;
      },
    });
    const rc = await sweepEpics(["--apply"], opts);
    expect(rc).toBe(0);
    expect(dissolveCalls).toEqual(["e-safe"]);
    const out = captured.text();
    expect(out).toContain("DRAIN");
    expect(out).toContain("SAFE-DISSOLVE");
    expect(out).toContain("RISKY");
  });

  test("--apply with no SAFE-DISSOLVE candidates is a no-op", async () => {
    await seedEpicWorktree("e-dirty");
    const captured = captureLogger();
    const dissolveCalls: string[] = [];
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-dirty"),
      git: dirtyGitStub(),
      logger: captured.logger,
      dissolve: async (argv) => {
        dissolveCalls.push(argv[0] ?? "");
        return 0;
      },
    });
    const rc = await sweepEpics(["--apply"], opts);
    expect(rc).toBe(0);
    expect(dissolveCalls).toEqual([]);
    expect(captured.text()).toContain("found no SAFE-DISSOLVE candidates");
  });

  test("--apply aborts on first dissolve failure", async () => {
    await seedEpicWorktree("e-a");
    await seedEpicWorktree("e-b");
    const captured = captureLogger();
    const dissolveCalls: string[] = [];
    const opts = baseOpts({
      cockpit: cockpitWithEpics(["e-a", "e-b"]),
      git: perRepoGitStub({
        [join(scratch, "parent-epics", "e-a")]: { dirty: false, pushed: true },
        [join(scratch, "parent-epics", "e-b")]: { dirty: false, pushed: true },
      }),
      logger: captured.logger,
      dissolve: async (argv) => {
        dissolveCalls.push(argv[0] ?? "");
        return argv[0] === "e-a" ? 65 : 0;
      },
    });
    const rc = await sweepEpics(["--apply"], opts);
    expect(rc).toBe(65);
    expect(dissolveCalls).toEqual(["e-a"]); // aborted before e-b
  });
});

// ---------- --parent filter ----------

describe("sweepEpics — --parent filter", () => {
  test("only candidates under <parent> are classified", async () => {
    await seedEpicWorktree("e-a");
    await seedEpicWorktreeUnder("alt-parent", "e-b");
    const captured = captureLogger();
    const opts = baseOpts({
      cockpit: cockpitWithMixedParents(),
      git: cleanPushedGitStub(join(scratch, "parent-epics", "e-a")),
      logger: captured.logger,
    });
    const rc = await sweepEpics(["--parent", "parent"], opts);
    expect(rc).toBe(0);
    const out = captured.text();
    expect(out).toContain("e-a");
    expect(out).not.toContain("e-b");
  });
});

// ---------- JSON output ----------

describe("sweepEpics — --json", () => {
  test("emits valid JSON with idleHours + verdicts", async () => {
    await seedEpicWorktree("e-safe");
    const captured = captureLogger();
    const opts = baseOpts({
      cockpit: cockpitWithOneEpic("e-safe"),
      git: cleanPushedGitStub(join(scratch, "parent-epics", "e-safe")),
      logger: captured.logger,
    });
    const rc = await sweepEpics(["--json", "--idle-hours", "12"], opts);
    expect(rc).toBe(0);
    const parsed = JSON.parse(captured.text());
    expect(parsed.idleHours).toBe(12);
    expect(parsed.verdicts).toHaveLength(1);
    expect(parsed.verdicts[0].epicId).toBe("e-safe");
    expect(parsed.verdicts[0].verdict).toBe("SAFE-DISSOLVE");
  });
});

// ---------- Helpers ----------

async function seedEpicWorktree(epicId: string): Promise<string> {
  return seedEpicWorktreeUnder("parent", epicId);
}

async function seedEpicWorktreeUnder(parentName: string, epicId: string): Promise<string> {
  const epicsDir = join(scratch, `${parentName}-epics`);
  const epicRoot = join(epicsDir, epicId);
  await mkdir(join(epicRoot, ".atmux"), { recursive: true });
  const db = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  closeDatabase(db);
  return epicRoot;
}

async function seedKanban(
  epicRoot: string,
  rows: ReadonlyArray<{ id: string; status: string }>,
): Promise<void> {
  const db = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  try {
    for (const r of rows) {
      db.query(
        `INSERT INTO tasks (id, status, created_at) VALUES ($id, $status, $now)`,
      ).run({ $id: r.id, $status: r.status, $now: 1000 });
    }
  } finally {
    closeDatabase(db);
  }
}

function cockpitWithOneEpic(epicId: string): LoadedCockpit {
  return cockpitWithEpics([epicId]);
}

function cockpitWithEpics(epicIds: ReadonlyArray<string>): LoadedCockpit {
  return {
    schemaVersion: 1 as const,
    sessions: [
      {
        type: "team" as const,
        name: "parent",
        enabled: true,
        root: parentRoot,
        sessions: epicIds.map((id) => ({
          type: "epic-team" as const,
          name: id,
          enabled: true,
          parent: "parent",
          epicId: id,
          sessions: [],
        })),
      },
    ],
    teams: [],
  } as unknown as LoadedCockpit;
}

function cockpitWithMixedParents(): LoadedCockpit {
  return {
    schemaVersion: 1 as const,
    sessions: [
      {
        type: "team" as const,
        name: "parent",
        enabled: true,
        root: parentRoot,
        sessions: [
          {
            type: "epic-team" as const,
            name: "e-a",
            enabled: true,
            parent: "parent",
            epicId: "e-a",
            sessions: [],
          },
        ],
      },
      {
        type: "team" as const,
        name: "alt-parent",
        enabled: true,
        root: join(scratch, "alt-parent"),
        sessions: [
          {
            type: "epic-team" as const,
            name: "e-b",
            enabled: true,
            parent: "alt-parent",
            epicId: "e-b",
            sessions: [],
          },
        ],
      },
    ],
    teams: [],
  } as unknown as LoadedCockpit;
}

function baseOpts(o: {
  cockpit: LoadedCockpit;
  git: GitSpawn;
  logger: { log: (m: string) => void };
  dissolve?: SweepEpicsOpts["dissolve"];
  now?: () => number;
}): SweepEpicsOpts {
  const opts: SweepEpicsOpts = {
    git: o.git,
    loadCockpitFn: async () => o.cockpit,
    logger: o.logger,
  };
  if (o.dissolve !== undefined) opts.dissolve = o.dissolve;
  if (o.now !== undefined) opts.now = o.now;
  return opts;
}

function cleanPushedGitStub(repoPath: string): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) return ok("");
    if (argv.includes("log") && argv.includes("--format=%ct")) return ok("100");
    if (argv.includes("branch") && argv.includes("--show-current")) return ok("main\n");
    if (argv.includes("rev-parse") && argv.includes("HEAD")) return ok("abc123\n");
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return ok("");
    // Default — match repoPath used for context; unmatched git calls return ok("")
    if (repoPath !== "" && !argv.includes(repoPath)) return ok("");
    return ok("");
  };
}

function cleanUnpushedGitStub(commitEpochSec: number): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) return ok("");
    if (argv.includes("log") && argv.includes("--format=%ct")) return ok(String(-commitEpochSec));
    if (argv.includes("branch") && argv.includes("--show-current")) return ok("feat\n");
    if (argv.includes("rev-parse") && argv.includes("HEAD")) return ok("abc123\n");
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return fail("");
    return ok("");
  };
}

function dirtyGitStub(): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    if (argv.includes("status") && argv.includes("--porcelain")) return ok(" M f.ts\n");
    if (argv.includes("log") && argv.includes("--format=%ct")) return ok("100");
    if (argv.includes("branch") && argv.includes("--show-current")) return ok("main\n");
    if (argv.includes("rev-parse") && argv.includes("HEAD")) return ok("abc\n");
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return fail("");
    return ok("");
  };
}

function perRepoGitStub(
  config: Record<string, { dirty: boolean; pushed: boolean }>,
): GitSpawn {
  return async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    const cIdx = argv.indexOf("-C");
    const repo = cIdx >= 0 ? argv[cIdx + 1] : undefined;
    const cfg = repo !== undefined ? config[repo] : undefined;
    if (argv.includes("status") && argv.includes("--porcelain")) {
      return ok(cfg?.dirty === true ? " M f.ts\n" : "");
    }
    if (argv.includes("log") && argv.includes("--format=%ct")) return ok("100");
    if (argv.includes("branch") && argv.includes("--show-current")) return ok("main\n");
    if (argv.includes("rev-parse") && argv.includes("HEAD")) return ok("abc\n");
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) {
      return cfg?.pushed === true ? ok("") : fail("");
    }
    return ok("");
  };
}

function captureLogger(): { logger: { log: (m: string) => void }; text: () => string } {
  const lines: string[] = [];
  return {
    logger: { log: (m: string) => lines.push(m) },
    text: () => lines.join("\n"),
  };
}

function ok(stdout: string): SpawnResult {
  return baseSpawn(0, stdout);
}

function fail(stdout: string): SpawnResult {
  return baseSpawn(1, stdout);
}

function baseSpawn(exitCode: number, stdout: string): SpawnResult {
  return {
    exitCode,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}
