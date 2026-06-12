// Unit tests for the ADR-209 §1 (Bug 1) fix in src/verbs/team/sweep-epics.ts:
// `lastCommitHoursAgo` must measure commits the epic branch carries past its
// merge-base with trunk — NOT the branch-tip date. A 0-ahead branch (tip ==
// spawn-base SHA) previously reported trunk's recent merge-base date (~2h),
// mislabeling a never-progressed team as freshly active.
//
// Strategy: drive the public `sweepEpics` verb with a recorded git stub that
// answers the merge-base-aware probe (`branch --show-current`, `rev-parse
// --verify origin/<base>`, `rev-list --count <trunk>..<branch>`, and the
// range-scoped `log -1 --format=%ct`). Assert the OBSERVABLE verdict + reason,
// and assert the exact rev-list range argv so the test fails if the metric
// regresses to a branch-tip lookup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import { type SweepEpicsOpts, sweepEpics } from "../../../src/verbs/team/sweep-epics.ts";

let scratch: string;
let parentRoot: string;

beforeEach(async () => {
  scratch = join(tmpdir(), `atmux-mbc-${Date.now()}-${Math.random()}`);
  await mkdir(scratch, { recursive: true });
  parentRoot = join(scratch, "parent");
  await mkdir(parentRoot, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const EPIC_ID = "e-abc12345";
// ADR-090 epic-branch convention: `<parentBase>-epic-<epicId>`.
const PARENT_BASE = "myproj-geoyws";
const EPIC_BRANCH = `${PARENT_BASE}-epic-${EPIC_ID}`;

describe("sweep-epics lastCommitHoursAgo — merge-base-aware count (ADR-209 §1)", () => {
  test("0-ahead branch → STALE-IDLE 'no branch-local commits', NOT recently-active", async () => {
    const epicRoot = await seedEpicWorktree(EPIC_ID);
    const recorded = recordedGit({
      branch: EPIC_BRANCH,
      // origin/<parentBase> resolves; branch is 0 commits ahead of it.
      verifyOriginBase: true,
      commitsAhead: 0,
      // tip date is ~2h ago — the sopx reproducer. If the metric wrongly read
      // the tip, the verdict would NOT be STALE-IDLE (2h < 24h idle window).
      tipEpochSec: nowSec() - 2 * 3600,
      rangeEpochSec: null, // no in-range commit exists for a 0-ahead branch
    });
    const captured = captureLogger();
    const rc = await sweepEpics(
      ["--idle-hours", "24"],
      baseOpts({
        cockpit: cockpitWithOneEpic(EPIC_ID),
        git: recorded.git,
        // not pushed → ladder reaches the lastCommit gate
        now: () => nowSec() * 1000,
        logger: captured.logger,
        epicRoot,
      }),
    );
    expect(rc).toBe(0);

    const out = captured.text();
    expect(out).toContain("| STALE-IDLE | parent | e-abc12345 |");
    expect(out).toContain("no branch-local commits since spawn");
    // The misleading "recently active" verdict must be gone for this team.
    expect(out).not.toContain("recently active");
    // Last-commit column renders the sentinel as "none", not "2h" / "99999h".
    expect(out).toContain("| none |");

    // The metric must have asked for the merge-base range, never a bare tip.
    expect(recorded.sawRevListRange(`origin/${PARENT_BASE}..${EPIC_BRANCH}`)).toBe(true);
  });

  test("N-ahead branch → reports the in-range last-commit age, not the tip", async () => {
    const epicRoot = await seedEpicWorktree(EPIC_ID);
    // 5 commits ahead; the newest in-range commit is 100h old → STALE-IDLE.
    // Tip date is set to 1h ago: a tip-reading metric would compute 1h and
    // misclassify as recently-active, so a green test here proves range use.
    const recorded = recordedGit({
      branch: EPIC_BRANCH,
      verifyOriginBase: true,
      commitsAhead: 5,
      tipEpochSec: nowSec() - 1 * 3600,
      rangeEpochSec: nowSec() - 100 * 3600,
    });
    const captured = captureLogger();
    const rc = await sweepEpics(
      ["--idle-hours", "24"],
      baseOpts({
        cockpit: cockpitWithOneEpic(EPIC_ID),
        git: recorded.git,
        now: () => nowSec() * 1000,
        logger: captured.logger,
        epicRoot,
      }),
    );
    expect(rc).toBe(0);

    const out = captured.text();
    expect(out).toContain("| STALE-IDLE | parent | e-abc12345 |");
    expect(out).toContain("100h since last commit");
    expect(out).toContain("| 100h |");
    expect(recorded.sawRevListRange(`origin/${PARENT_BASE}..${EPIC_BRANCH}`)).toBe(true);
  });

  test("N-ahead recent commit → RISKY (recently active), proving the age is honest", async () => {
    // 3 commits ahead, newest in-range commit only 2h old → below the 24h
    // idle window, so the team is genuinely recently-active. This guards the
    // inverse: the sentinel must NOT fire for a branch that really shipped.
    const epicRoot = await seedEpicWorktree(EPIC_ID);
    const recorded = recordedGit({
      branch: EPIC_BRANCH,
      verifyOriginBase: true,
      commitsAhead: 3,
      tipEpochSec: nowSec() - 2 * 3600,
      rangeEpochSec: nowSec() - 2 * 3600,
    });
    const captured = captureLogger();
    const rc = await sweepEpics(
      ["--idle-hours", "24"],
      baseOpts({
        cockpit: cockpitWithOneEpic(EPIC_ID),
        git: recorded.git,
        now: () => nowSec() * 1000,
        logger: captured.logger,
        epicRoot,
      }),
    );
    expect(rc).toBe(0);
    const out = captured.text();
    expect(out).toContain("| RISKY | parent | e-abc12345 |");
    expect(out).toContain("recently active");
    expect(out).toContain("| 2h |");
  });

  test("origin/<base> absent → falls back to local <base> ref for the count", async () => {
    const epicRoot = await seedEpicWorktree(EPIC_ID);
    const recorded = recordedGit({
      branch: EPIC_BRANCH,
      verifyOriginBase: false, // origin ref missing
      verifyLocalBase: true, // local <parentBase> ref present
      commitsAhead: 0,
      tipEpochSec: nowSec() - 2 * 3600,
      rangeEpochSec: null,
    });
    const captured = captureLogger();
    const rc = await sweepEpics(
      ["--idle-hours", "24"],
      baseOpts({
        cockpit: cockpitWithOneEpic(EPIC_ID),
        git: recorded.git,
        now: () => nowSec() * 1000,
        logger: captured.logger,
        epicRoot,
      }),
    );
    expect(rc).toBe(0);
    const out = captured.text();
    expect(out).toContain("| STALE-IDLE | parent | e-abc12345 |");
    expect(out).toContain("no branch-local commits since spawn");
    // Count ran against the local base ref, not the (missing) origin ref.
    expect(recorded.sawRevListRange(`${PARENT_BASE}..${EPIC_BRANCH}`)).toBe(true);
  });
});

// ---------- Recorded git stub ----------

interface RecordedGitConfig {
  branch: string;
  verifyOriginBase?: boolean;
  verifyLocalBase?: boolean;
  commitsAhead: number;
  tipEpochSec: number;
  rangeEpochSec: number | null;
}

function recordedGit(cfg: RecordedGitConfig): {
  git: GitSpawn;
  sawRevListRange: (range: string) => boolean;
} {
  const revListRanges: string[] = [];
  const git: GitSpawn = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    // worktree-clean probe → clean
    if (argv.includes("status") && argv.includes("--porcelain")) return ok("");

    if (argv.includes("branch") && argv.includes("--show-current")) {
      return ok(`${cfg.branch}\n`);
    }

    // trunk resolution: `rev-parse --verify --quiet <ref>`
    if (argv.includes("rev-parse") && argv.includes("--verify")) {
      const ref = argv[argv.length - 1];
      if (ref === `origin/${cfg.branch.replace(/-epic-.*$/, "")}`) {
        return cfg.verifyOriginBase === true ? ok("deadbeef\n") : empty();
      }
      if (ref === cfg.branch.replace(/-epic-.*$/, "")) {
        return cfg.verifyLocalBase === true ? ok("cafef00d\n") : empty();
      }
      return empty();
    }

    // merge-base-aware commit count: `rev-list --count <trunk>..<branch>`
    if (argv.includes("rev-list") && argv.includes("--count")) {
      const range = argv[argv.length - 1] ?? "";
      revListRanges.push(range);
      return ok(`${cfg.commitsAhead}\n`);
    }

    // range-scoped last-commit date: `log -1 --format=%ct <trunk>..<branch>`
    if (argv.includes("log") && argv.includes("--format=%ct")) {
      const last = argv[argv.length - 1] ?? "";
      if (last.includes("..")) {
        return cfg.rangeEpochSec === null ? empty() : ok(String(cfg.rangeEpochSec));
      }
      // bare tip lookup (fallback path only)
      return ok(String(cfg.tipEpochSec));
    }

    // branch-pushed probe: report NOT pushed so the ladder reaches lastCommit.
    if (argv.includes("rev-parse") && argv.includes("HEAD")) return ok("abc123\n");
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) return fail("");

    return ok("");
  };
  return {
    git,
    sawRevListRange: (range: string) => revListRanges.includes(range),
  };
}

// ---------- Cockpit + worktree seeding (mirrors sweep-epics.test.ts) ----------

async function seedEpicWorktree(epicId: string): Promise<string> {
  const epicsDir = join(scratch, "parent-epics");
  const epicRoot = join(epicsDir, epicId);
  await mkdir(join(epicRoot, ".atmux"), { recursive: true });
  const db = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  closeDatabase(db);
  return epicRoot;
}

function cockpitWithOneEpic(epicId: string): LoadedCockpit {
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
            name: epicId,
            enabled: true,
            parent: "parent",
            epicId,
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
  now: () => number;
  epicRoot: string;
}): SweepEpicsOpts {
  return {
    git: o.git,
    loadCockpitFn: async () => o.cockpit,
    logger: o.logger,
    now: o.now,
  };
}

// ---------- Small utils ----------

function nowSec(): number {
  return 1_750_000_000; // fixed deterministic clock (epoch seconds)
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

function empty(): SpawnResult {
  return baseSpawn(1, "");
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
