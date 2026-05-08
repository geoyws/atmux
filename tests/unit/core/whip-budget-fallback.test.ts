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
  FallbackUserMissingError,
  type FallbackTier,
  Tier4NotAvailableError,
} from "../../../src/abstractions/fallback-cage.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";
import {
  dispatchFallbackOnPause,
  fallbackCagesPath,
  type FallbackCagesFile,
  walkFallbackOnResume,
} from "../../../src/core/whip-budget-fallback.ts";

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
  const agent =
    opts.tier === 2 ? "operator" : opts.tier === 3 ? "kimi-agent" : "minimax-agent";
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
        throw new Tier4NotAvailableError();
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
      inFlightTasks: [
        makeTask({ id: "t-FAIL", lane: "be" }),
        makeTask({ id: "t-OK", lane: "fe" }),
      ],
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
