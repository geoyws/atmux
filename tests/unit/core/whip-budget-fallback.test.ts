// Unit tests for src/core/whip-budget-fallback.ts (ADR-058 §D6).
//
// Mocks every external dependency: createFallbackCage, destroyFallbackCage,
// sendBrief, sendContinuity. No real spawn / tmux / sudo calls.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CageHandle,
  type FallbackTier,
  FallbackUserMissingError,
} from "../../../src/abstractions/fallback-cage.ts";
import {
  dispatchFallbackOnPause,
  type FallbackCagesFile,
  fallbackCagesPath,
  walkFallbackOnResume,
} from "../../../src/core/whip-budget-fallback.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

// ---------- Sandbox per test ----------

let atmuxDir: string;
let projectCwd: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-wbf-"));
  atmuxDir = join(tmp, ".atmux");
  projectCwd = tmp;
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

// ---------- Helpers ----------

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t-test01",
    subject: "test task",
    body: "body",
    status: "in-progress",
    owner: "fe",
    lane: "fe",
    ...overrides,
  };
}

function fakeHandle(opts: {
  tier: FallbackTier;
  taskId: string;
  team: string;
  lane: string;
  createdAt?: number;
}): CageHandle {
  const agent = opts.tier === 2 ? "operator" : opts.tier === 3 ? "kimi-agent" : "minimax-agent";
  return {
    tier: opts.tier,
    team: opts.team,
    lane: opts.lane,
    taskId: opts.taskId,
    agent,
    tmuxTmpdir: `/tmp/atmux_fallback_${opts.team}_${opts.lane}/`,
    tmuxSocket: `fallback_${opts.team}_${opts.lane}`,
    workDir: `/work/${opts.team}-${opts.lane}`,
    sessionName: `fallback-${opts.team}-${opts.lane}`,
    windowName: `tier${opts.tier}-${opts.lane}`,
    createdAt: opts.createdAt ?? 1_700_000_000,
  };
}

// ---------- dispatchFallbackOnPause ----------

describe("dispatchFallbackOnPause — empty in-flight", () => {
  test("no tasks → no cages, no handles file", async () => {
    let createCalls = 0;
    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_000,
      inFlightTasks: [],
      sendBrief: async () => {},
      createCage: async () => {
        createCalls += 1;
        throw new Error("should not be called");
      },
    });
    expect(cages).toEqual([]);
    expect(createCalls).toBe(0);
    const path = fallbackCagesPath(atmuxDir, 1_700_000_000);
    await expect(stat(path)).rejects.toThrow();
  });
});

describe("dispatchFallbackOnPause — tier selection", () => {
  test("Tier 2 succeeds first → no cascade", async () => {
    const tiersTried: FallbackTier[] = [];
    const handle = fakeHandle({ tier: 2, taskId: "t-1", team: "atmux", lane: "fe" });
    const sends: Array<{ handle: CageHandle; body: string }> = [];

    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_000,
      inFlightTasks: [makeTask({ id: "t-1" })],
      sendBrief: async (h, body) => {
        sends.push({ handle: h, body });
      },
      createCage: async (opts) => {
        tiersTried.push(opts.tier);
        return handle;
      },
    });

    expect(tiersTried).toEqual([2]);
    expect(cages).toEqual([handle]);
    expect(sends.length).toBe(1);
    expect(sends[0]?.handle).toEqual(handle);
    // Tier 2 brief mentions "Cursor".
    expect(sends[0]?.body).toContain("Cursor");
    expect(sends[0]?.body).toContain("t-1");
  });

  test("Tier 2 user-missing → cascade to Tier 3", async () => {
    const tiersTried: FallbackTier[] = [];
    const tier3Handle = fakeHandle({ tier: 3, taskId: "t-2", team: "atmux", lane: "be" });

    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_001,
      inFlightTasks: [makeTask({ id: "t-2", lane: "be", owner: "be" })],
      sendBrief: async () => {},
      createCage: async (opts) => {
        tiersTried.push(opts.tier);
        if (opts.tier === 2) throw new FallbackUserMissingError("operator");
        return tier3Handle;
      },
    });

    expect(tiersTried).toEqual([2, 3]);
    expect(cages).toEqual([tier3Handle]);
  });

  test("Tier 4 not available → cascade falls through; all tiers fail → no cage", async () => {
    const tiersTried: FallbackTier[] = [];

    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_002,
      inFlightTasks: [makeTask()],
      sendBrief: async () => {
        throw new Error("should not be reached");
      },
      createCage: async (opts) => {
        tiersTried.push(opts.tier);
        if (opts.tier === 2) throw new FallbackUserMissingError("operator");
        if (opts.tier === 3) throw new FallbackUserMissingError("kimi-agent");
        throw new FallbackUserMissingError("minimax-agent");
      },
    });

    expect(tiersTried).toEqual([2, 3, 4]);
    expect(cages).toEqual([]);
    // No handles file when no cages created.
    await expect(stat(fallbackCagesPath(atmuxDir, 1_700_000_002))).rejects.toThrow();
  });

  test("non-recoverable error halts cascade for that task", async () => {
    const tiersTried: FallbackTier[] = [];

    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_003,
      inFlightTasks: [makeTask()],
      sendBrief: async () => {},
      createCage: async (opts) => {
        tiersTried.push(opts.tier);
        if (opts.tier === 2) throw new Error("rsync binary missing");
        throw new Error("should not reach Tier 3 after non-recoverable Tier 2 failure");
      },
    });

    // Cascade halted at Tier 2; no Tier 3 attempt.
    expect(tiersTried).toEqual([2]);
    expect(cages).toEqual([]);
  });

  test("custom tierPreference is honored", async () => {
    const tiersTried: FallbackTier[] = [];
    const tier3Handle = fakeHandle({ tier: 3, taskId: "t-3", team: "atmux", lane: "fe" });

    await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_004,
      inFlightTasks: [makeTask({ id: "t-3" })],
      tierPreference: [3, 2],
      sendBrief: async () => {},
      createCage: async (opts) => {
        tiersTried.push(opts.tier);
        return tier3Handle;
      },
    });

    expect(tiersTried).toEqual([3]);
  });
});

describe("dispatchFallbackOnPause — handles file persistence", () => {
  test("writes fallback-cages-<epoch>.json with all created cages", async () => {
    const epoch = 1_700_000_100;
    const handles = [
      fakeHandle({ tier: 2, taskId: "t-A", team: "atmux", lane: "fe" }),
      fakeHandle({ tier: 3, taskId: "t-B", team: "atmux", lane: "be" }),
    ];
    let i = 0;

    await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: epoch,
      inFlightTasks: [
        makeTask({ id: "t-A", lane: "fe", owner: "fe" }),
        makeTask({ id: "t-B", lane: "be", owner: "be" }),
      ],
      sendBrief: async () => {},
      createCage: async (_opts) => {
        // Tier 3 cage simulated by failing tier 2 for the second task.
        const h = handles[i] as CageHandle;
        i += 1;
        return h;
      },
      tierPreference: [2],
    });

    const path = fallbackCagesPath(atmuxDir, epoch);
    const txt = await readFile(path, "utf8");
    const parsed = JSON.parse(txt) as FallbackCagesFile;
    expect(parsed.epoch).toBe(epoch);
    expect(parsed.team).toBe("atmux");
    expect(parsed.cages.length).toBe(2);
    expect(parsed.cages.map((c) => c.taskId)).toEqual(["t-A", "t-B"]);
  });

  test("send failure does NOT prevent handles persistence (cage is real, just send failed)", async () => {
    const epoch = 1_700_000_200;
    const handle = fakeHandle({ tier: 2, taskId: "t-X", team: "atmux", lane: "fe" });

    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: epoch,
      inFlightTasks: [makeTask({ id: "t-X" })],
      sendBrief: async () => {
        throw new Error("tmux server unreachable");
      },
      createCage: async () => handle,
    });

    // Cage exists even though brief send failed — resume-walk still
    // needs to destroy it.
    expect(cages).toEqual([handle]);
    const path = fallbackCagesPath(atmuxDir, epoch);
    const parsed = JSON.parse(await readFile(path, "utf8")) as FallbackCagesFile;
    expect(parsed.cages.length).toBe(1);
  });

  test("per-task failure doesn't abort siblings", async () => {
    const epoch = 1_700_000_300;
    const okHandle = fakeHandle({ tier: 2, taskId: "t-OK", team: "atmux", lane: "fe" });

    const cages = await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: epoch,
      inFlightTasks: [makeTask({ id: "t-FAIL", lane: "be" }), makeTask({ id: "t-OK", lane: "fe" })],
      sendBrief: async () => {},
      createCage: async (opts) => {
        if (opts.taskId === "t-FAIL") throw new Error("simulated cage failure");
        return okHandle;
      },
    });

    expect(cages.length).toBe(1);
    expect(cages[0]?.taskId).toBe("t-OK");
    const parsed = JSON.parse(
      await readFile(fallbackCagesPath(atmuxDir, epoch), "utf8"),
    ) as FallbackCagesFile;
    expect(parsed.cages.map((c) => c.taskId)).toEqual(["t-OK"]);
  });
});

describe("dispatchFallbackOnPause — lane resolution", () => {
  test("uses task.lane when set", async () => {
    let observedLane = "";
    await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_400,
      inFlightTasks: [makeTask({ id: "t-1", lane: "ops", owner: "different" })],
      sendBrief: async () => {},
      createCage: async (opts) => {
        observedLane = opts.lane;
        return fakeHandle({ tier: 2, taskId: opts.taskId, team: opts.team, lane: opts.lane });
      },
    });
    expect(observedLane).toBe("ops");
  });

  test("falls back to task.owner when lane is null", async () => {
    let observedLane = "";
    await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_401,
      inFlightTasks: [makeTask({ id: "t-1", lane: null, owner: "fe-worker" })],
      sendBrief: async () => {},
      createCage: async (opts) => {
        observedLane = opts.lane;
        return fakeHandle({ tier: 2, taskId: opts.taskId, team: opts.team, lane: opts.lane });
      },
    });
    expect(observedLane).toBe("fe-worker");
  });

  test("falls back to task.id when both lane and owner missing", async () => {
    let observedLane = "";
    await dispatchFallbackOnPause({
      team: "atmux",
      atmuxDir,
      projectCwd,
      pausedAtSec: 1_700_000_402,
      inFlightTasks: [makeTask({ id: "t-XYZ", lane: null, owner: null })],
      sendBrief: async () => {},
      createCage: async (opts) => {
        observedLane = opts.lane;
        return fakeHandle({ tier: 2, taskId: opts.taskId, team: opts.team, lane: opts.lane });
      },
    });
    expect(observedLane).toBe("t-XYZ");
  });
});

// ---------- walkFallbackOnResume ----------

describe("walkFallbackOnResume — handles file present", () => {
  test("walks every cage: continuity send + destroy + delete file", async () => {
    const epoch = 1_700_001_000;
    const handles = [
      fakeHandle({ tier: 2, taskId: "t-A", team: "atmux", lane: "fe" }),
      fakeHandle({ tier: 3, taskId: "t-B", team: "atmux", lane: "be" }),
    ];
    const file: FallbackCagesFile = {
      epoch,
      team: "atmux",
      cages: handles,
    };
    await writeFile(fallbackCagesPath(atmuxDir, epoch), JSON.stringify(file));

    const continuity: Array<{ member: string; body: string }> = [];
    const destroyed: CageHandle[] = [];

    await walkFallbackOnResume({
      team: "atmux",
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async (member, body) => {
        continuity.push({ member, body });
      },
      destroyCage: async (handle) => {
        destroyed.push(handle);
      },
    });

    expect(continuity.length).toBe(2);
    expect(continuity.map((c) => c.member)).toEqual(["fe", "be"]);
    // Tier 2's continuity points to git log; Tier 3's points to reconcile.sh
    expect(continuity[0]?.body).toContain("git log");
    expect(continuity[1]?.body).toContain("scripts/fallback-reconcile.sh");

    expect(destroyed.length).toBe(2);
    // Handles file removed after walk.
    await expect(stat(fallbackCagesPath(atmuxDir, epoch))).rejects.toThrow();
  });
});

describe("walkFallbackOnResume — handles file absent / corrupt", () => {
  test("absent file → no-op (idempotent)", async () => {
    let destroyCalls = 0;
    let sendCalls = 0;
    await walkFallbackOnResume({
      team: "atmux",
      atmuxDir,
      pausedAtSec: 9_999_999_999,
      sendContinuity: async () => {
        sendCalls += 1;
      },
      destroyCage: async () => {
        destroyCalls += 1;
      },
    });
    expect(destroyCalls).toBe(0);
    expect(sendCalls).toBe(0);
  });

  test("corrupt JSON → file removed, no walk", async () => {
    const epoch = 1_700_002_000;
    await writeFile(fallbackCagesPath(atmuxDir, epoch), "{not valid json");
    let destroyCalls = 0;
    await walkFallbackOnResume({
      team: "atmux",
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async () => {},
      destroyCage: async () => {
        destroyCalls += 1;
      },
    });
    expect(destroyCalls).toBe(0);
    await expect(stat(fallbackCagesPath(atmuxDir, epoch))).rejects.toThrow();
  });

  test("malformed (cages not an array) → file removed", async () => {
    const epoch = 1_700_003_000;
    await writeFile(
      fallbackCagesPath(atmuxDir, epoch),
      JSON.stringify({ epoch, team: "atmux", cages: null }),
    );
    let destroyCalls = 0;
    await walkFallbackOnResume({
      team: "atmux",
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async () => {},
      destroyCage: async () => {
        destroyCalls += 1;
      },
    });
    expect(destroyCalls).toBe(0);
    await expect(stat(fallbackCagesPath(atmuxDir, epoch))).rejects.toThrow();
  });
});

describe("walkFallbackOnResume — best-effort failures", () => {
  test("destroy failure on one cage doesn't abort siblings", async () => {
    const epoch = 1_700_004_000;
    const handles = [
      fakeHandle({ tier: 2, taskId: "t-A", team: "atmux", lane: "fe" }),
      fakeHandle({ tier: 2, taskId: "t-B", team: "atmux", lane: "be" }),
    ];
    await writeFile(
      fallbackCagesPath(atmuxDir, epoch),
      JSON.stringify({ epoch, team: "atmux", cages: handles }),
    );
    const destroyed: string[] = [];
    await walkFallbackOnResume({
      team: "atmux",
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async () => {},
      destroyCage: async (h) => {
        if (h.taskId === "t-A") throw new Error("simulated destroy failure");
        destroyed.push(h.taskId);
      },
    });
    // t-B still destroyed.
    expect(destroyed).toEqual(["t-B"]);
    // File still removed at end.
    await expect(stat(fallbackCagesPath(atmuxDir, epoch))).rejects.toThrow();
  });

  test("continuity send failure doesn't block destroy", async () => {
    const epoch = 1_700_005_000;
    const handle = fakeHandle({ tier: 2, taskId: "t-A", team: "atmux", lane: "fe" });
    await writeFile(
      fallbackCagesPath(atmuxDir, epoch),
      JSON.stringify({ epoch, team: "atmux", cages: [handle] }),
    );
    let destroyed = false;
    await walkFallbackOnResume({
      team: "atmux",
      atmuxDir,
      pausedAtSec: epoch,
      sendContinuity: async () => {
        throw new Error("tmux server unreachable");
      },
      destroyCage: async () => {
        destroyed = true;
      },
    });
    expect(destroyed).toBe(true);
  });
});

// ============================================================
// ADR-050 v1 wrappers — spawnFallbackCage / teardownFallbackCage /
// shouldDispatchFallback
// ============================================================

import {
  cageKeyV1,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_FALLBACK_SUSTAIN_MIN,
  type FallbackCagesFileV1,
  fallbackCagesPathV1,
  MIN_FALLBACK_SUSTAIN_MIN,
  readCagesFileV1,
  SUPPORTED_FALLBACK_TIER,
  shouldDispatchFallback,
  spawnFallbackCage,
  Tier3PlusNotSupportedError,
  teardownFallbackCage,
} from "../../../src/core/whip-budget-fallback.ts";
import type { Team } from "../../../src/schema/team.ts";

function makeTeam(over: Partial<Team> = {}): Team {
  return {
    name: "atmux",
    members: [],
    ...over,
  } as Team;
}

function teamWithFallback(
  fb: Partial<{
    enabled: boolean;
    sustainMins: number;
    tier: number;
    cursorModel: string;
  }>,
): Team {
  return {
    name: "atmux",
    members: [],
    whip: {
      fallback: {
        enabled: false,
        sustainMins: DEFAULT_FALLBACK_SUSTAIN_MIN,
        tier: SUPPORTED_FALLBACK_TIER,
        cursorModel: DEFAULT_CURSOR_MODEL,
        ...fb,
      },
    },
  } as unknown as Team;
}

// ---------- shouldDispatchFallback ----------

describe("shouldDispatchFallback — ADR-050 §Trigger semantics", () => {
  test("all 3 conditions met → dispatch=true", () => {
    const team = teamWithFallback({ enabled: true });
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 30,
      inProgressTaskCount: 1,
    });
    expect(got).toEqual({ dispatch: true });
  });

  test("fallback disabled → dispatch=false (reason fallback-disabled)", () => {
    const team = teamWithFallback({ enabled: false });
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 60,
      inProgressTaskCount: 3,
    });
    expect(got.dispatch).toBe(false);
    expect(got.reason).toBe("fallback-disabled");
  });

  test("sustain not reached → dispatch=false (reason sustain-not-reached)", () => {
    const team = teamWithFallback({ enabled: true, sustainMins: 30 });
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 15,
      inProgressTaskCount: 2,
    });
    expect(got.dispatch).toBe(false);
    expect(got.reason).toBe("sustain-not-reached");
  });

  test("sustain exact equality → dispatch=true (>=, not strict >)", () => {
    const team = teamWithFallback({ enabled: true, sustainMins: 30 });
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 30,
      inProgressTaskCount: 1,
    });
    expect(got.dispatch).toBe(true);
  });

  test("zero in-progress tasks → dispatch=false (reason no-in-progress-tasks)", () => {
    const team = teamWithFallback({ enabled: true });
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 30,
      inProgressTaskCount: 0,
    });
    expect(got.dispatch).toBe(false);
    expect(got.reason).toBe("no-in-progress-tasks");
  });

  test("tier !== 2 → dispatch=false (reason tier-not-supported, evaluated FIRST)", () => {
    // Bypass schema (force a non-2 tier via cast).
    const team = {
      name: "atmux",
      members: [],
      whip: {
        fallback: { enabled: true, sustainMins: 30, tier: 3, cursorModel: "x" },
      },
    } as unknown as Team;
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 60,
      inProgressTaskCount: 1,
    });
    expect(got.dispatch).toBe(false);
    expect(got.reason).toBe("tier-not-supported");
  });

  test("undefined whip.fallback → dispatch=false (default enabled=false → fallback-disabled)", () => {
    const team = makeTeam();
    const got = shouldDispatchFallback({
      team,
      pauseSustainedMin: 999,
      inProgressTaskCount: 5,
    });
    expect(got.dispatch).toBe(false);
    expect(got.reason).toBe("fallback-disabled");
  });
});

// ---------- spawnFallbackCage ----------

describe("spawnFallbackCage — ADR-050 v1 wrapper", () => {
  test("happy path: creates cage + persists handle to v1 file", async () => {
    const team = teamWithFallback({ enabled: true });
    let createCalls = 0;
    const handle = await spawnFallbackCage(
      {
        team,
        atmuxDir,
        projectCwd,
        member: "fe",
        taskId: "t-spawn1",
      },
      {
        createCage: async (opts) => {
          createCalls += 1;
          expect(opts.tier).toBe(2);
          expect(opts.team).toBe("atmux");
          expect(opts.lane).toBe("fe");
          expect(opts.taskId).toBe("t-spawn1");
          return fakeHandle({ tier: 2, taskId: "t-spawn1", team: "atmux", lane: "fe" });
        },
      },
    );
    expect(createCalls).toBe(1);
    expect(handle.tier).toBe(2);

    // Persisted to v1 file.
    const fileContent = await readFile(fallbackCagesPathV1(atmuxDir), "utf8");
    const parsed = JSON.parse(fileContent) as FallbackCagesFileV1;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.cages[cageKeyV1("atmux", "fe")]).toBeDefined();
  });

  test("idempotence: second call returns existing handle without re-spawning", async () => {
    const team = teamWithFallback({ enabled: true });
    let createCalls = 0;
    const sharedDeps = {
      createCage: async () => {
        createCalls += 1;
        return fakeHandle({ tier: 2, taskId: "t-idem1", team: "atmux", lane: "fe" });
      },
    };
    const h1 = await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "fe", taskId: "t-idem1" },
      sharedDeps,
    );
    const h2 = await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "fe", taskId: "t-idem1" },
      sharedDeps,
    );
    expect(createCalls).toBe(1);
    expect(h2).toEqual(h1);
  });

  test("refuses tier !== 2 at call-site (defense-in-depth)", async () => {
    const team = {
      name: "atmux",
      members: [],
      whip: {
        fallback: { enabled: true, sustainMins: 30, tier: 3, cursorModel: "x" },
      },
    } as unknown as Team;
    await expect(
      spawnFallbackCage({
        team,
        atmuxDir,
        projectCwd,
        member: "fe",
        taskId: "t-tier3",
      }),
    ).rejects.toThrow(Tier3PlusNotSupportedError);
  });

  test("optional brief: sendBrief dep invoked when both brief + dep supplied", async () => {
    const team = teamWithFallback({ enabled: true });
    const sendCalls: Array<{ handle: CageHandle; body: string }> = [];
    await spawnFallbackCage(
      {
        team,
        atmuxDir,
        projectCwd,
        member: "fe",
        taskId: "t-brief1",
        brief: "hello world",
      },
      {
        createCage: async () =>
          fakeHandle({ tier: 2, taskId: "t-brief1", team: "atmux", lane: "fe" }),
        sendBrief: async (handle, body) => {
          sendCalls.push({ handle, body });
        },
      },
    );
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.body).toBe("hello world");
  });

  test("brief supplied + sendBrief absent → no throw, no send (logged + deferred)", async () => {
    const team = teamWithFallback({ enabled: true });
    const handle = await spawnFallbackCage(
      {
        team,
        atmuxDir,
        projectCwd,
        member: "fe",
        taskId: "t-deferred",
        brief: "deferred brief body",
      },
      {
        createCage: async () =>
          fakeHandle({ tier: 2, taskId: "t-deferred", team: "atmux", lane: "fe" }),
      },
    );
    expect(handle.tier).toBe(2);
  });

  test("sendBrief throw is best-effort (cage still created + persisted)", async () => {
    const team = teamWithFallback({ enabled: true });
    const handle = await spawnFallbackCage(
      {
        team,
        atmuxDir,
        projectCwd,
        member: "fe",
        taskId: "t-throw",
        brief: "x",
      },
      {
        createCage: async () =>
          fakeHandle({ tier: 2, taskId: "t-throw", team: "atmux", lane: "fe" }),
        sendBrief: async () => {
          throw new Error("tmux unreachable");
        },
      },
    );
    expect(handle.tier).toBe(2);
    const parsed = JSON.parse(await readFile(fallbackCagesPathV1(atmuxDir), "utf8"));
    expect(parsed.cages[cageKeyV1("atmux", "fe")]).toBeDefined();
  });

  test("distinct members create distinct v1 cage entries", async () => {
    const team = teamWithFallback({ enabled: true });
    await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "fe", taskId: "t-A" },
      {
        createCage: async () => fakeHandle({ tier: 2, taskId: "t-A", team: "atmux", lane: "fe" }),
      },
    );
    await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "be", taskId: "t-B" },
      {
        createCage: async () => fakeHandle({ tier: 2, taskId: "t-B", team: "atmux", lane: "be" }),
      },
    );
    const file = await readCagesFileV1(atmuxDir);
    expect(Object.keys(file.cages)).toHaveLength(2);
    expect(file.cages[cageKeyV1("atmux", "fe")]).toBeDefined();
    expect(file.cages[cageKeyV1("atmux", "be")]).toBeDefined();
  });
});

// ---------- teardownFallbackCage ----------

describe("teardownFallbackCage — ADR-050 v1 wrapper", () => {
  test("idempotence: teardown when no handle in file → no-op (no throw)", async () => {
    const team = teamWithFallback({ enabled: true });
    let destroyCalls = 0;
    await teardownFallbackCage(
      { team, atmuxDir, member: "fe" },
      {
        destroyCage: async () => {
          destroyCalls += 1;
        },
      },
    );
    expect(destroyCalls).toBe(0);
  });

  test("happy path: spawn → teardown → file cleaned up", async () => {
    const team = teamWithFallback({ enabled: true });
    await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "fe", taskId: "t-X" },
      {
        createCage: async () => fakeHandle({ tier: 2, taskId: "t-X", team: "atmux", lane: "fe" }),
      },
    );
    let destroyCalls = 0;
    await teardownFallbackCage(
      { team, atmuxDir, member: "fe" },
      {
        destroyCage: async () => {
          destroyCalls += 1;
        },
      },
    );
    expect(destroyCalls).toBe(1);
    await expect(stat(fallbackCagesPathV1(atmuxDir))).rejects.toThrow();
  });

  test("teardown one of two cages preserves the other", async () => {
    const team = teamWithFallback({ enabled: true });
    await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "fe", taskId: "t-A" },
      {
        createCage: async () => fakeHandle({ tier: 2, taskId: "t-A", team: "atmux", lane: "fe" }),
      },
    );
    await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "be", taskId: "t-B" },
      {
        createCage: async () => fakeHandle({ tier: 2, taskId: "t-B", team: "atmux", lane: "be" }),
      },
    );
    await teardownFallbackCage({ team, atmuxDir, member: "fe" }, { destroyCage: async () => {} });
    const file = await readCagesFileV1(atmuxDir);
    expect(Object.keys(file.cages)).toEqual([cageKeyV1("atmux", "be")]);
  });

  test("destroyCage throw still removes the stale entry from the file", async () => {
    const team = teamWithFallback({ enabled: true });
    await spawnFallbackCage(
      { team, atmuxDir, projectCwd, member: "fe", taskId: "t-X" },
      {
        createCage: async () => fakeHandle({ tier: 2, taskId: "t-X", team: "atmux", lane: "fe" }),
      },
    );
    await teardownFallbackCage(
      { team, atmuxDir, member: "fe" },
      {
        destroyCage: async () => {
          throw new Error("kill-server unreachable");
        },
      },
    );
    // File should be cleaned up — stale entries don't block the next
    // teardown attempt.
    await expect(stat(fallbackCagesPathV1(atmuxDir))).rejects.toThrow();
  });

  test("refuses tier !== 2 handle on teardown (defense-in-depth)", async () => {
    const team = teamWithFallback({ enabled: true });
    // Manually seed a Tier 3 handle (bypass spawn's tier check).
    const file: FallbackCagesFileV1 = {
      schemaVersion: 1,
      cages: {
        [cageKeyV1("atmux", "fe")]: fakeHandle({
          tier: 3,
          taskId: "t-T3",
          team: "atmux",
          lane: "fe",
        }),
      },
    };
    await writeFile(fallbackCagesPathV1(atmuxDir), JSON.stringify(file));
    await expect(teardownFallbackCage({ team, atmuxDir, member: "fe" })).rejects.toThrow(
      Tier3PlusNotSupportedError,
    );
  });
});

// ---------- v1 cages-file IO + path helpers ----------

describe("v1 cages-file IO + path helpers", () => {
  test("fallbackCagesPathV1 returns <atmuxDir>/state/fallback-cages-v1.json", () => {
    expect(fallbackCagesPathV1("/x/.atmux")).toBe("/x/.atmux/state/fallback-cages-v1.json");
  });

  test("cageKeyV1 builds <team>:<member>", () => {
    expect(cageKeyV1("atmux", "fe")).toBe("atmux:fe");
    expect(cageKeyV1("sopx", "lane-1")).toBe("sopx:lane-1");
  });

  test("readCagesFileV1: missing file → empty file shape (no throw)", async () => {
    const file = await readCagesFileV1(atmuxDir);
    expect(file).toEqual({ schemaVersion: 1, cages: {} });
  });

  test("readCagesFileV1: malformed JSON → empty file shape (graceful degrade)", async () => {
    await writeFile(fallbackCagesPathV1(atmuxDir), "{not json");
    const file = await readCagesFileV1(atmuxDir);
    expect(file).toEqual({ schemaVersion: 1, cages: {} });
  });

  test("readCagesFileV1: array shape (legacy v0) → empty (reject)", async () => {
    // Distinct from ADR-058's epoch-suffixed file which uses array.
    // V1 only accepts object-keyed `cages`.
    await writeFile(fallbackCagesPathV1(atmuxDir), JSON.stringify({ schemaVersion: 1, cages: [] }));
    const file = await readCagesFileV1(atmuxDir);
    expect(file.cages).toEqual({});
  });

  test("default constants exposed and consistent", () => {
    expect(DEFAULT_FALLBACK_SUSTAIN_MIN).toBe(30);
    expect(MIN_FALLBACK_SUSTAIN_MIN).toBe(5);
    expect(DEFAULT_CURSOR_MODEL).toBe("composer-2");
    expect(SUPPORTED_FALLBACK_TIER).toBe(2);
    expect(MIN_FALLBACK_SUSTAIN_MIN).toBeLessThan(DEFAULT_FALLBACK_SUSTAIN_MIN);
  });
});

// ---------- ADR-050 schema-load refuse (defense-in-depth gate 1) ----------

describe("schema-load refuse on tier !== 2 (ADR-050 §Decision §Tier ordering)", () => {
  test("z.literal(2) refuses tier: 3 at parse time", async () => {
    const { Team } = await import("../../../src/schema/team.ts");
    expect(() =>
      Team.parse({
        name: "atmux",
        members: [],
        whip: {
          fallback: { enabled: true, sustainMins: 30, tier: 3, cursorModel: "x" },
        },
      }),
    ).toThrow();
  });

  test("z.literal(2) refuses tier: 1 at parse time", async () => {
    const { Team } = await import("../../../src/schema/team.ts");
    expect(() =>
      Team.parse({
        name: "atmux",
        members: [],
        whip: {
          fallback: { tier: 1 },
        },
      }),
    ).toThrow();
  });

  test("sustainMins < 5 refused (min boundary)", async () => {
    const { Team } = await import("../../../src/schema/team.ts");
    expect(() =>
      Team.parse({
        name: "atmux",
        members: [],
        whip: {
          fallback: { sustainMins: 4 },
        },
      }),
    ).toThrow();
  });

  test("sustainMins === 5 accepted (min boundary)", async () => {
    const { Team } = await import("../../../src/schema/team.ts");
    expect(() =>
      Team.parse({
        name: "atmux",
        members: [],
        whip: {
          fallback: { sustainMins: 5 },
        },
      }),
    ).not.toThrow();
  });

  test("omitting whip.fallback entirely is accepted (back-compat)", async () => {
    const { Team } = await import("../../../src/schema/team.ts");
    expect(() => Team.parse({ name: "atmux", members: [] })).not.toThrow();
  });

  test("explicit tier: 2 + defaults applied", async () => {
    const { Team } = await import("../../../src/schema/team.ts");
    const parsed = Team.parse({
      name: "atmux",
      members: [],
      whip: { fallback: { enabled: true } },
    });
    const fb = (parsed.whip as { fallback?: unknown }).fallback as Record<string, unknown>;
    expect(fb.tier).toBe(2);
    expect(fb.sustainMins).toBe(30);
    expect(fb.cursorModel).toBe("composer-2");
    expect(fb.enabled).toBe(true);
  });
});
