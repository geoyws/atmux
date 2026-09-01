// Unit tests for src/core/cadence-classifier.ts (ADR-148 T5 /
// t-ac95b267).
//
// Coverage:
//   - classifyCadence pure: all 4 verdict literals (shipping/idle/
//     dormant/ship-zero-window) + empty-log + ship-zero-window-is-
//     subset-of-dormant precedence + malformed log lines + epoch=0.
//   - classifyMemberCadence async: composes gitLog probe + classifier
//     + caps sinceSec at max(window, dormantMax) + clock injection.
//   - defaultGitLog: smoke (not coverage-critical — fail-soft path
//     already covered by the inject-stub branch).

import { describe, expect, test } from "bun:test";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import {
  type CadenceThresholds,
  classifyCadence,
  classifyMemberCadence,
  defaultGitLog,
  type GitLogFn,
} from "../../../src/core/cadence-classifier.ts";

// ---------- Helpers ----------

const NOW_SEC = 1_700_000_000;

const DEFAULT_THRESHOLDS: CadenceThresholds = {
  shippingMaxAgeSec: 1800,
  idleMaxAgeSec: 7200,
  dormantMaxAgeSec: 21600,
  shipZeroWindowSec: 7200,
};

/** Build a `git log` output line — `<sha> <epoch-sec>`. */
function logLine(sha: string, ageSec: number): string {
  return `${sha} ${NOW_SEC - ageSec}`;
}

function spawnResult(stdout: string, exitCode = 0): SpawnResult {
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

// ---------- classifyCadence — verdict matrix ----------

describe("classifyCadence — verdict matrix", () => {
  test("shipping: 1 commit in window + age < shippingMax", () => {
    const out = classifyCadence(
      [logLine("aaaaaaa1234", 300)], // 5min ago
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("shipping");
    expect(out.commitsInWindow).toBe(1);
    expect(out.ageOfLastCommitSec).toBe(300);
    expect(out.lastCommitSha).toBe("aaaaaaa");
    expect(out.lastCommitAt).toBe(NOW_SEC - 300);
  });

  test("shipping: multiple commits in window — all counted", () => {
    const out = classifyCadence(
      [logLine("aaaaaaa1234", 300), logLine("bbbbbbb1234", 600), logLine("ccccccc1234", 1000)],
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("shipping");
    expect(out.commitsInWindow).toBe(3);
    // Most-recent commit wins for sha/at.
    expect(out.lastCommitSha).toBe("aaaaaaa");
  });

  test("idle: no commits in window, age < idleMax", () => {
    // Most-recent commit at 5000s ago (within shipZero-7200 window
    // floor → falls to idle path because age < idleMax=7200).
    const out = classifyCadence([logLine("ddddddd1234", 5000)], NOW_SEC, 1800, DEFAULT_THRESHOLDS);
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("idle");
    expect(out.commitsInWindow).toBe(0);
    expect(out.ageOfLastCommitSec).toBe(5000);
  });

  test("ship-zero-window: 0 in-window + age ≥ shipZero + age < dormantMax", () => {
    const out = classifyCadence(
      [logLine("eeeeeee1234", 10_000)], // 2h47m ago — ≥7200 + <21600
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("ship-zero-window");
    expect(out.commitsInWindow).toBe(0);
    expect(out.ageOfLastCommitSec).toBe(10_000);
  });

  test("dormant: 0 in-window + age ≥ dormantMax", () => {
    const out = classifyCadence(
      [logLine("fffffff1234", 30_000)], // 8h20m ago — well past dormantMax
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("dormant");
    expect(out.ageOfLastCommitSec).toBe(30_000);
  });

  test("idle (no commits ever): empty log → ageOfLastCommitSec=null + verdict=idle", () => {
    // ageOfLastCommitSec === null + the `age >= shipZero` gate
    // requires non-null, so this falls to the idle branch via the
    // `null < idleMax` path in the classifier.
    const out = classifyCadence([], NOW_SEC, 1800, DEFAULT_THRESHOLDS);
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("idle");
    expect(out.commitsInWindow).toBe(0);
    expect(out.lastCommitAt).toBeNull();
    expect(out.lastCommitSha).toBeNull();
    expect(out.ageOfLastCommitSec).toBeNull();
  });

  test("ship-zero-window precedence: when dormantMax > shipZero AND age between → ship-zero-window wins", () => {
    // Verify the §D2 "subset of dormant; surface escalation FIRST"
    // explicit precedence.
    const wideThresholds: CadenceThresholds = {
      shippingMaxAgeSec: 1800,
      idleMaxAgeSec: 7200,
      dormantMaxAgeSec: 86_400, // 24h — wide
      shipZeroWindowSec: 7200, // 2h
    };
    const out = classifyCadence(
      [logLine("ggggggg1234", 10_000)], // between shipZero + dormant
      NOW_SEC,
      1800,
      wideThresholds,
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("ship-zero-window");
  });

  test("dormant precedence: when age ≥ dormantMax → dormant wins over ship-zero-window", () => {
    const wideThresholds: CadenceThresholds = {
      shippingMaxAgeSec: 1800,
      idleMaxAgeSec: 7200,
      dormantMaxAgeSec: 86_400,
      shipZeroWindowSec: 7200,
    };
    const out = classifyCadence([logLine("hhhhhhh1234", 100_000)], NOW_SEC, 1800, wideThresholds);
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("dormant");
  });

  test("commitsInWindow boundary: commit AT windowSec → counted (≤ inclusive)", () => {
    const out = classifyCadence(
      [logLine("iiiiiii1234", 1800)], // exactly at window edge
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out.commitsInWindow).toBe(1);
  });

  test("commitsInWindow boundary: commit 1s past windowSec → not counted", () => {
    const out = classifyCadence([logLine("jjjjjjj1234", 1801)], NOW_SEC, 1800, DEFAULT_THRESHOLDS);
    expect(out.commitsInWindow).toBe(0);
  });

  test("malformed log line (missing fields) → skipped, no crash", () => {
    const out = classifyCadence(
      ["broken-line-no-sha", logLine("kkkkkkk1234", 100), ""],
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out.commitsInWindow).toBe(1);
    expect(out.lastCommitSha).toBe("kkkkkkk");
  });

  test("malformed timestamp (NaN) → skipped, no crash", () => {
    const out = classifyCadence(
      [`xxx not-a-number`, logLine("lllllll1234", 100)],
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out.commitsInWindow).toBe(1);
    expect(out.lastCommitSha).toBe("lllllll");
  });

  test("future-timestamp commit (clock skew): negative age clamped to 0", () => {
    const out = classifyCadence(
      [`mmmmmmm1234 ${NOW_SEC + 60}`], // 1min in future
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    // Clamped via Math.max(0, ...) — age=0 → < shippingMax → shipping
    // when commitsInWindow >= 1. The diff is 0 - 60 = -60 ≤ 1800, so
    // commitsInWindow=1, age=0 → shipping.
    expect(out.ageOfLastCommitSec).toBe(0);
    expect(out.commitsInWindow).toBe(1);
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("shipping");
  });

  test("lastCommitSha truncated to 7 chars for long input SHA", () => {
    const out = classifyCadence(
      [`abcdef0123456789abcdef0123456789abcdef01 ${NOW_SEC - 100}`],
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(out.lastCommitSha).toBe("abcdef0");
  });

  test("dormant fallthrough: age 10000 with idle7200 / shipZero12000 / dormant24000", () => {
    const thresholds: CadenceThresholds = {
      shippingMaxAgeSec: 1800,
      idleMaxAgeSec: 7200,
      dormantMaxAgeSec: 24_000,
      shipZeroWindowSec: 12_000,
    };
    const out = classifyCadence([logLine("ppppppp1234", 10_000)], NOW_SEC, 1800, thresholds);
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("dormant");
  });
});

// ---------- classifyMemberCadence — async wrapper ----------

describe("classifyMemberCadence — async wrapper", () => {
  test("composes gitLog + classifier — sinceSec = max(window, dormantMax)", async () => {
    const calls: Array<{ path: string; sinceSec: number; author: string }> = [];
    const gitLog: GitLogFn = async (path, sinceSec, author) => {
      calls.push({ path, sinceSec, author });
      return [logLine("nnnnnnn1234", 100)];
    };
    const out = await classifyMemberCadence(
      "fe-1",
      "/srv/demo/worktrees/fe-1",
      {
        windowSec: 1800,
        thresholds: DEFAULT_THRESHOLDS,
      },
      { gitLog, nowSec: () => NOW_SEC },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/srv/demo/worktrees/fe-1");
    expect(calls[0]?.author).toBe("fe-1");
    // max(windowSec=1800, dormantMax=21600) = 21600
    expect(calls[0]?.sinceSec).toBe(21_600);
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("shipping");
  });

  test("sinceSec uses windowSec when it's wider than dormantMax", async () => {
    const calls: Array<{ sinceSec: number }> = [];
    const gitLog: GitLogFn = async (_p, sinceSec) => {
      calls.push({ sinceSec });
      return [];
    };
    await classifyMemberCadence(
      "fe-1",
      "/x",
      {
        windowSec: 100_000, // way wider than dormantMax 21600
        thresholds: DEFAULT_THRESHOLDS,
      },
      { gitLog, nowSec: () => NOW_SEC },
    );
    expect(calls[0]?.sinceSec).toBe(100_000);
  });

  test("default nowSec injected — uses real clock (smoke; just verify no crash)", async () => {
    const gitLog: GitLogFn = async () => [];
    // No nowSec override — exercises the Math.floor(Date.now()/1000) path.
    const out = await classifyMemberCadence(
      "fe-1",
      "/x",
      {
        windowSec: 1800,
        thresholds: DEFAULT_THRESHOLDS,
      },
      { gitLog },
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("idle");
  });

  test("gitLog returning [] → idle (no-commits-ever path)", async () => {
    const out = await classifyMemberCadence(
      "fe-1",
      "/missing",
      { windowSec: 1800, thresholds: DEFAULT_THRESHOLDS },
      { gitLog: async () => [], nowSec: () => NOW_SEC },
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("idle");
    expect(out.lastCommitAt).toBeNull();
  });

  test("gitLog returning null → NO verdict at all (could not read a repo)", async () => {
    // The distinction this whole seam exists for. `[]` above means "a
    // repository with no matching commits" and legitimately reads `idle`.
    // `null` means "I could not look" — a missing path, a directory that
    // is not a git repo, a spawn failure. Turning that into `idle (never)`
    // is a confident verdict about work that was never observable, and
    // `atmux status` handed it to `team_status`, which SPOKE it: the vox
    // drilldown transcript reported a scratch team's panes as "all idle".
    const out = await classifyMemberCadence(
      "fe-1",
      "/not-a-repo",
      { windowSec: 1800, thresholds: DEFAULT_THRESHOLDS },
      { gitLog: async () => null, nowSec: () => NOW_SEC },
    );
    expect(out).toBeNull();
  });

  test("gitLog returning ship-zero-window-fixture → escalation verdict", async () => {
    const out = await classifyMemberCadence(
      "fe-1",
      "/x",
      { windowSec: 1800, thresholds: DEFAULT_THRESHOLDS },
      {
        gitLog: async () => [logLine("ooooooo1234", 8000)],
        nowSec: () => NOW_SEC,
      },
    );
    expect(out).not.toBeNull();
    if (out === null) throw new Error("cadence probe returned null");
    expect(out.verdict).toBe("ship-zero-window");
    expect(out.ageOfLastCommitSec).toBe(8000);
  });
});

describe("defaultGitLog — injected spawn seam", () => {
  test("splits, trims, and filters stdout lines", async () => {
    const calls: Array<{
      cmd: string;
      argv: ReadonlyArray<string>;
      expectExitCode?: unknown;
      timeoutMs?: number;
    }> = [];
    const out = await defaultGitLog("wt", 123, "fe-1", {
      spawn: async (opts) => {
        calls.push({ ...opts, argv: opts.argv ?? [] });
        return spawnResult("  abcdef0 100  \n\n  bcdef01 200\t\n   \n");
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("git");
    expect(calls[0]?.argv).toEqual([
      "-C",
      "wt",
      "log",
      "--since=123s",
      "--author=fe-1",
      "--format=%H %ct",
    ]);
    expect(calls[0]?.expectExitCode).toBe("any");
    expect(calls[0]?.timeoutMs).toBe(5000);
    expect(out).toEqual(["abcdef0 100", "bcdef01 200"]);
  });

  test("non-zero exit returns null", async () => {
    const out = await defaultGitLog("wt", 123, "fe-1", {
      spawn: async () => spawnResult("ignored\n", 128),
    });
    expect(out).toBeNull();
  });

  test("thrown spawn rejection returns null", async () => {
    const out = await defaultGitLog("wt", 123, "fe-1", {
      spawn: async () => {
        throw new Error("boom");
      },
    });
    expect(out).toBeNull();
  });
});
