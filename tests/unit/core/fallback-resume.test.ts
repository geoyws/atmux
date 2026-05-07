// Unit tests for src/core/fallback-resume.ts (ADR-058 T3 PART B).
//
// Pure-orchestration module; tests inject readFn / spawnFn / sendFn /
// destroyFn stubs and exercise:
//
//   1. Path helpers — tierHandoffDir / tierHandoffLogPath / cycleHeader.
//   2. Cycle parsing — parseCycleBlocks + latestCycleBlock with empty,
//      single-cycle, multi-cycle, and missing-header inputs.
//   3. SHA extraction — Tier 2 cage-output → SHA list.
//   4. Diff parsing — parseDiffRqOutput pure parser handles ADDED /
//      MODIFIED / DELETED + filters cage-context files.
//   5. buildLaneSummary — Tier 2 vs. Tier 3 paths produce the right
//      shape via injected readFn / spawnFn.
//   6. composeContinuityBrief — pure composer renders Tier 2 SHAs +
//      Tier 3+ delta lists + reconcile pointer.
//   7. resumeFromBudgetPause — orchestrator walks handles, calls send
//      + destroy per lane, accumulates errors without short-circuiting.

import { describe, expect, test } from "bun:test";
import type { CageHandle, FallbackTier } from "../../../src/abstractions/fallback-cage.ts";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import {
  buildLaneSummary,
  composeContinuityBrief,
  composeMultiLaneBrief,
  cycleHeader,
  enumerateCageDeltas,
  extractShasFromCageLog,
  latestCycleBlock,
  parseCycleBlocks,
  parseDiffRqOutput,
  resumeFromBudgetPause,
  tierHandoffDir,
  tierHandoffLogPath,
  type CageDelta,
  type LaneSummary,
} from "../../../src/core/fallback-resume.ts";

// ---------- shared helpers ----------

function mkHandle(overrides: Partial<CageHandle> = {}): CageHandle {
  return {
    tier: 3,
    team: "alpha",
    lane: "fe",
    taskId: "t-fefefe",
    agent: "kimi-agent",
    tmuxTmpdir: "/tmp/atmux_fallback_alpha_fe_kimi-agent/",
    tmuxSocket: "fallback_alpha_fe",
    workDir: "/home/kimi-agent/cages/alpha-fe/work",
    sessionName: "fallback-alpha-fe",
    windowName: "tier3-fe",
    createdAt: 1_700_000_000,
    ...overrides,
  } as CageHandle;
}

// ---------- 1. path helpers ----------

describe("tierHandoffDir / tierHandoffLogPath", () => {
  test("Tier 3 dir + log path", () => {
    expect(tierHandoffDir("/atmux", 3)).toBe("/atmux/tier3-handoff");
    expect(tierHandoffLogPath("/atmux", 3, "fe")).toBe("/atmux/tier3-handoff/fe.log");
  });

  test("Tier 2 dir + log path", () => {
    expect(tierHandoffDir("/atmux", 2)).toBe("/atmux/tier2-handoff");
    expect(tierHandoffLogPath("/atmux", 2, "be")).toBe("/atmux/tier2-handoff/be.log");
  });

  test("Tier 4 dir + log path", () => {
    expect(tierHandoffLogPath("/atmux", 4, "lane-x")).toBe(
      "/atmux/tier4-handoff/lane-x.log",
    );
  });
});

describe("cycleHeader", () => {
  test("emits the canonical marker shape ADR-058 §OQ2 specifies", () => {
    expect(cycleHeader(1_700_000_000)).toBe("=== cycle 1700000000 ===\n");
  });
});

// ---------- 2. cycle parsing ----------

describe("parseCycleBlocks / latestCycleBlock", () => {
  test("empty / null log returns []", () => {
    expect(parseCycleBlocks("")).toEqual([]);
    expect(parseCycleBlocks(null)).toEqual([]);
    expect(parseCycleBlocks(undefined)).toEqual([]);
  });

  test("log without any cycle markers returns [] (legacy entries dropped)", () => {
    const log = "some\nlines\nwith no marker\n";
    expect(parseCycleBlocks(log)).toEqual([]);
  });

  test("single cycle block parses body verbatim sans trailing newline", () => {
    const log = "=== cycle 1700000000 ===\nhello\nworld\n";
    expect(parseCycleBlocks(log)).toEqual([
      { epochSec: 1_700_000_000, body: "hello\nworld" },
    ]);
  });

  test("multiple cycle blocks parse independently", () => {
    const log =
      "=== cycle 1700000000 ===\nfirst\n" +
      "=== cycle 1700001000 ===\nsecond\nbody\n";
    expect(parseCycleBlocks(log)).toEqual([
      { epochSec: 1_700_000_000, body: "first" },
      { epochSec: 1_700_001_000, body: "second\nbody" },
    ]);
  });

  test("latestCycleBlock returns the highest-epoch block", () => {
    const log =
      "=== cycle 1700000000 ===\nfirst\n" +
      "=== cycle 1700002000 ===\nlater\n" +
      "=== cycle 1700001000 ===\nmiddle\n";
    const latest = latestCycleBlock(log);
    expect(latest).not.toBeNull();
    expect(latest!.epochSec).toBe(1_700_002_000);
    expect(latest!.body).toBe("later");
  });

  test("latestCycleBlock returns null on empty log", () => {
    expect(latestCycleBlock("")).toBeNull();
    expect(latestCycleBlock(null)).toBeNull();
  });
});

// ---------- 3. SHA extraction ----------

describe("extractShasFromCageLog", () => {
  test("captures bare 7-char SHA tokens", () => {
    expect(extractShasFromCageLog("commit a1b2c3d landed")).toEqual(["a1b2c3d"]);
  });

  test("captures the prefixed `commit <sha>` form", () => {
    const log = "commit deadbeef1234567890\nlater commit cafebabe1\n";
    expect(extractShasFromCageLog(log)).toEqual(["deadbeef1234567890", "cafebabe1"]);
  });

  test("dedupes repeated SHAs", () => {
    const log = "abcdef1\nabcdef1\n";
    expect(extractShasFromCageLog(log)).toEqual(["abcdef1"]);
  });

  test("filters all-decimal tokens (not real SHAs)", () => {
    const log = "1778131854 epoch then a1b2c3d sha";
    expect(extractShasFromCageLog(log)).toEqual(["a1b2c3d"]);
  });

  test("empty log → []", () => {
    expect(extractShasFromCageLog("")).toEqual([]);
  });
});

// ---------- 4. diff parsing ----------

describe("parseDiffRqOutput", () => {
  const cage = "/home/kimi-agent/cages/alpha-fe/work";
  const project = "/atmux/project";

  test("ADDED: 'Only in <cage>: file' at root", () => {
    const stdout = `Only in ${cage}: newfile.ts\n`;
    expect(parseDiffRqOutput(stdout, cage, project)).toEqual([
      { kind: "added", relpath: "newfile.ts" },
    ]);
  });

  test("ADDED: 'Only in <cage>/sub: file' in subdir", () => {
    const stdout = `Only in ${cage}/src/core: newfile.ts\n`;
    expect(parseDiffRqOutput(stdout, cage, project)).toEqual([
      { kind: "added", relpath: "src/core/newfile.ts" },
    ]);
  });

  test("DELETED: 'Only in <project>: file'", () => {
    const stdout = `Only in ${project}: trash.ts\n`;
    expect(parseDiffRqOutput(stdout, cage, project)).toEqual([
      { kind: "deleted", relpath: "trash.ts" },
    ]);
  });

  test("MODIFIED: 'Files <cage>/path and <project>/path differ'", () => {
    const stdout = `Files ${cage}/src/lib.ts and ${project}/src/lib.ts differ\n`;
    expect(parseDiffRqOutput(stdout, cage, project)).toEqual([
      { kind: "modified", relpath: "src/lib.ts" },
    ]);
  });

  test("filters cage-context files (_history.log etc.)", () => {
    const stdout =
      `Files ${cage}/_history.log and ${project}/_history.log differ\n` +
      `Only in ${cage}: _branch.log\n` +
      `Files ${cage}/src/real.ts and ${project}/src/real.ts differ\n`;
    expect(parseDiffRqOutput(stdout, cage, project)).toEqual([
      { kind: "modified", relpath: "src/real.ts" },
    ]);
  });

  test("empty output → []", () => {
    expect(parseDiffRqOutput("", cage, project)).toEqual([]);
  });

  test("ignores unrecognised lines (e.g. binary-file markers)", () => {
    const stdout = `Binary files differ\nOnly in ${cage}: real.ts\n`;
    expect(parseDiffRqOutput(stdout, cage, project)).toEqual([
      { kind: "added", relpath: "real.ts" },
    ]);
  });
});

// ---------- 5. enumerateCageDeltas (async, with spawnFn stub) ----------

describe("enumerateCageDeltas", () => {
  test("invokes sudo -u <agent> diff -rq + parses stdout", async () => {
    const cage = "/home/kimi-agent/cages/alpha-fe/work";
    const project = "/atmux/project";
    const calls: SpawnOpts[] = [];
    const spawnFn = async (opts: SpawnOpts): Promise<SpawnResult> => {
      calls.push(opts);
      return {
        cmd: "sudo",
        argv: opts.argv ?? [],
        exitCode: 1, // diff returns 1 when there ARE differences
        signalled: null,
        stdout: `Only in ${cage}: a.ts\nFiles ${cage}/b.ts and ${project}/b.ts differ\n`,
        stderr: "",
        durationMs: 5,
      };
    };
    const deltas = await enumerateCageDeltas({
      cageDir: cage,
      projectCwd: project,
      agent: "kimi-agent",
      spawnFn,
    });
    expect(deltas).toEqual([
      { kind: "added", relpath: "a.ts" },
      { kind: "modified", relpath: "b.ts" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("sudo");
    expect(calls[0]!.argv).toEqual(["-u", "kimi-agent", "diff", "-rq", cage, project]);
  });

  test("rc>=2 throws (real diff failure, e.g. cageDir missing)", async () => {
    const spawnFn = async (): Promise<SpawnResult> => ({
      cmd: "sudo",
      argv: [],
      exitCode: 2,
      signalled: null,
      stdout: "",
      stderr: "diff: /x: No such file or directory",
      durationMs: 1,
    });
    await expect(
      enumerateCageDeltas({
        cageDir: "/missing",
        projectCwd: "/atmux/project",
        agent: "kimi-agent",
        spawnFn,
      }),
    ).rejects.toThrow(/diff -rq failed/);
  });
});

// ---------- 6. buildLaneSummary (Tier 2 vs Tier 3) ----------

describe("buildLaneSummary", () => {
  test("Tier 2: extracts SHAs from latest cycle, no spawnFn calls", async () => {
    const handle = mkHandle({ tier: 2, agent: "operator", workDir: "/atmux/project" });
    const log =
      "=== cycle 1700000000 ===\nold work\n" +
      "=== cycle 1700002000 ===\ncommit a1b2c3d landed\nfollowed by deadbee2\n";
    let spawnCalls = 0;
    const summary = await buildLaneSummary(handle, {
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      readFn: async (path) => {
        expect(path).toBe("/atmux/tier2-handoff/fe.log");
        return log;
      },
      spawnFn: async () => {
        spawnCalls += 1;
        throw new Error("Tier 2 should not invoke spawnFn");
      },
    });
    expect(summary.handle).toBe(handle);
    expect(summary.lastCycleEpochSec).toBe(1_700_002_000);
    expect(summary.tier2Shas).toEqual(["a1b2c3d", "deadbee2"]);
    expect(summary.tier3Deltas).toEqual([]);
    expect(summary.reconcileStatus).toBe("n/a");
    expect(summary.cageOutput).toContain("commit a1b2c3d landed");
    expect(spawnCalls).toBe(0);
  });

  test("Tier 3: enumerates deltas via spawnFn + flags status pending", async () => {
    const handle = mkHandle({ tier: 3 });
    const summary = await buildLaneSummary(handle, {
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      readFn: async () => "=== cycle 1700000500 ===\ndid stuff",
      spawnFn: async () => ({
        cmd: "sudo",
        argv: [],
        exitCode: 1,
        signalled: null,
        stdout: `Only in ${handle.workDir}: greenfield.ts\n`,
        stderr: "",
        durationMs: 3,
      }),
    });
    expect(summary.tier2Shas).toEqual([]);
    expect(summary.tier3Deltas).toEqual([
      { kind: "added", relpath: "greenfield.ts" },
    ]);
    expect(summary.reconcileStatus).toBe("pending");
  });

  test("Tier 3 with no deltas: status = reconciled", async () => {
    const handle = mkHandle({ tier: 3 });
    const summary = await buildLaneSummary(handle, {
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      readFn: async () => null, // no log file
      spawnFn: async () => ({
        cmd: "sudo",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
    });
    expect(summary.tier3Deltas).toEqual([]);
    expect(summary.reconcileStatus).toBe("reconciled");
    expect(summary.lastCycleEpochSec).toBeNull();
    expect(summary.cageOutput).toBe("");
  });
});

// ---------- 7. composeContinuityBrief (pure) ----------

describe("composeContinuityBrief", () => {
  function tier2Summary(overrides: Partial<LaneSummary> = {}): LaneSummary {
    return {
      handle: mkHandle({ tier: 2, agent: "operator", workDir: "/atmux/project" }),
      lastCycleEpochSec: 1_700_000_000,
      cageOutput: "did stuff",
      tier2Shas: ["a1b2c3d", "deadbee2"],
      tier3Deltas: [],
      reconcileStatus: "n/a",
      ...overrides,
    } as LaneSummary;
  }

  function tier3Summary(overrides: Partial<LaneSummary> = {}): LaneSummary {
    return {
      handle: mkHandle({ tier: 3 }),
      lastCycleEpochSec: 1_700_000_000,
      cageOutput: "agent did things",
      tier2Shas: [],
      tier3Deltas: [
        { kind: "added", relpath: "greenfield.ts" },
        { kind: "modified", relpath: "src/lib.ts" },
      ],
      reconcileStatus: "pending",
      ...overrides,
    } as LaneSummary;
  }

  test("Tier 2: surfaces SHAs + 'no manual reconcile needed'", () => {
    const brief = composeContinuityBrief(tier2Summary());
    expect(brief).toContain("Tier 2 result");
    expect(brief).toContain("`a1b2c3d`");
    expect(brief).toContain("`deadbee2`");
    expect(brief).toContain("no manual reconcile needed");
    expect(brief).toContain("git log --oneline a1b2c3d^..HEAD");
  });

  test("Tier 2 with no SHAs: emits `no commit SHAs detected`", () => {
    const brief = composeContinuityBrief(tier2Summary({ tier2Shas: [] }));
    expect(brief).toContain("No commit SHAs detected");
  });

  test("Tier 3: lists deltas + reconcile script pointer", () => {
    const brief = composeContinuityBrief(tier3Summary());
    expect(brief).toContain("Tier 3 result");
    expect(brief).toContain("[ADDED] `greenfield.ts`");
    expect(brief).toContain("[MODIFIED] `src/lib.ts`");
    expect(brief).toContain("scripts/fallback-reconcile.sh alpha fe");
    expect(brief).toContain("status: `pending`");
  });

  test("Tier 3 with empty deltas: 'No file-level deltas detected'", () => {
    const brief = composeContinuityBrief(
      tier3Summary({ tier3Deltas: [], reconcileStatus: "reconciled" }),
    );
    expect(brief).toContain("No file-level deltas detected");
    expect(brief).toContain("status: `reconciled`");
  });

  test("truncates oversized cage output to ~2KB", () => {
    const huge = "x".repeat(5_000);
    const brief = composeContinuityBrief(tier3Summary({ cageOutput: huge }));
    expect(brief).toContain("[truncated; full log at the path below]");
    // Brief should NOT contain the entire 5KB body.
    expect(brief.length).toBeLessThan(huge.length);
  });
});

describe("composeMultiLaneBrief", () => {
  test("empty handles → empty string", () => {
    expect(composeMultiLaneBrief([])).toBe("");
  });

  test("multiple lanes joined with separators + header", () => {
    const a: LaneSummary = {
      handle: mkHandle({ lane: "fe" }),
      lastCycleEpochSec: 1,
      cageOutput: "",
      tier2Shas: [],
      tier3Deltas: [],
      reconcileStatus: "reconciled",
    } as LaneSummary;
    const b: LaneSummary = {
      handle: mkHandle({ lane: "be" }),
      lastCycleEpochSec: 2,
      cageOutput: "",
      tier2Shas: [],
      tier3Deltas: [{ kind: "added", relpath: "x.ts" }],
      reconcileStatus: "pending",
    } as LaneSummary;
    const brief = composeMultiLaneBrief([a, b]);
    expect(brief).toContain("Budget pause resumed");
    expect(brief).toContain("`fe`");
    expect(brief).toContain("`be`");
    expect(brief).toContain("---"); // separator
  });
});

// ---------- 8. resumeFromBudgetPause orchestration ----------

describe("resumeFromBudgetPause", () => {
  test("happy path: each handle yields summary + send + destroy", async () => {
    const handles = [mkHandle({ lane: "fe" }), mkHandle({ lane: "be" })];
    const sentBriefs: { member: string; brief: string }[] = [];
    const destroyed: CageHandle[] = [];

    const result = await resumeFromBudgetPause({
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      handles,
      readFn: async () => "=== cycle 1 ===\nbody",
      spawnFn: async () => ({
        cmd: "sudo",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
      sendFn: async (member, brief) => {
        sentBriefs.push({ member, brief });
      },
      destroyFn: async (handle) => {
        destroyed.push(handle);
      },
    });

    expect(result.summaries).toHaveLength(2);
    expect(result.sent).toBe(2);
    expect(result.destroyed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(sentBriefs.map((s) => s.member)).toEqual(["fe", "be"]);
    expect(sentBriefs[0]!.brief).toContain("Tier 3 result");
    expect(destroyed).toHaveLength(2);
  });

  test("custom resolveMember maps lanes → operator member names", async () => {
    const handles = [mkHandle({ lane: "fe" })];
    const sent: { member: string }[] = [];
    await resumeFromBudgetPause({
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      handles,
      readFn: async () => null,
      spawnFn: async () => ({
        cmd: "",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      resolveMember: (lane) => `member-for-${lane}`,
      sendFn: async (member) => {
        sent.push({ member });
      },
      destroyFn: async () => {
        /* no-op */
      },
    });
    expect(sent).toEqual([{ member: "member-for-fe" }]);
  });

  test("send failure is recorded, destroy still runs, other lanes still process", async () => {
    const handles = [mkHandle({ lane: "fe" }), mkHandle({ lane: "be" })];
    let destroyedCount = 0;
    const result = await resumeFromBudgetPause({
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      handles,
      readFn: async () => null,
      spawnFn: async () => ({
        cmd: "",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      sendFn: async (member) => {
        if (member === "fe") throw new Error("pane closed");
      },
      destroyFn: async () => {
        destroyedCount += 1;
      },
    });
    expect(result.summaries).toHaveLength(2);
    expect(result.sent).toBe(1);
    expect(result.destroyed).toBe(2);
    expect(destroyedCount).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.lane).toBe("fe");
    expect(result.errors[0]!.phase).toBe("send");
    expect(result.errors[0]!.message).toContain("pane closed");
  });

  test("summary failure skips send for that lane but still attempts destroy", async () => {
    const handles = [mkHandle({ lane: "fe" })];
    const sent: string[] = [];
    let destroyed = 0;
    const result = await resumeFromBudgetPause({
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      handles,
      readFn: async () => {
        throw new Error("ENOENT (mock)");
      },
      spawnFn: async () => ({
        cmd: "",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      sendFn: async (member) => {
        sent.push(member);
      },
      destroyFn: async () => {
        destroyed += 1;
      },
    });
    expect(result.summaries).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(destroyed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.phase).toBe("summary");
  });

  test("destroy failure recorded but does not abort the loop", async () => {
    const handles = [mkHandle({ lane: "fe" }), mkHandle({ lane: "be" })];
    const sent: string[] = [];
    const result = await resumeFromBudgetPause({
      atmuxDir: "/atmux",
      projectCwd: "/atmux/project",
      handles,
      readFn: async () => null,
      spawnFn: async () => ({
        cmd: "",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      sendFn: async (member) => {
        sent.push(member);
      },
      destroyFn: async (handle) => {
        if (handle.lane === "fe") throw new Error("session already gone");
      },
    });
    expect(sent).toEqual(["fe", "be"]); // both lanes got the brief
    expect(result.destroyed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.phase).toBe("destroy");
    expect(result.errors[0]!.lane).toBe("fe");
  });
});
