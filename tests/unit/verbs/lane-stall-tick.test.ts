// Unit tests for src/verbs/lane-stall-tick.ts (ADR-148 §D4 / T3).
//
// Covers:
//   - parseLaneStallTickArgs — minimal arg parser
//   - runLaneStallTick gating: cadence.enabled !== true → no-op; lane-
//     StallEnabled === false → no-op
//   - runLaneStallTick flow: stalled task + all-idle members → fires
//     send-keys + writes dedup state
//   - Pane-state-check refusal → flag file write + no dedup write
//   - Some-shipping member → no fire, no flag
//   - Dedup state pruning before decision
//
// We bypass the live tmux + git layers entirely by injecting deps —
// the tick verb is a thin orchestrator over `decideLaneStall` (already
// tested at the core layer).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists } from "../../../src/abstractions/fs.ts";
import { addTask } from "../../../src/core/kanban.ts";
import { appendDedupFire, readDedupState } from "../../../src/core/lane-stall.ts";
import type { CaptureFn, PaneClassification, PaneState } from "../../../src/core/pane-state.ts";
import { UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  type LaneStallTickDeps,
  parseLaneStallTickArgs,
  runLaneStallTick,
} from "../../../src/verbs/lane-stall-tick.ts";

let homeDir: string;
let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "atmux-lane-stall-home-"));
  teamDir = await mkdtemp(join(tmpdir(), "atmux-lane-stall-team-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- parseLaneStallTickArgs ----------

describe("parseLaneStallTickArgs", () => {
  test("empty argv parses cleanly", () => {
    expect(parseLaneStallTickArgs([])).toEqual({});
  });

  test("--team-dir threads through", () => {
    expect(parseLaneStallTickArgs(["--team-dir", "/tmp/x"])).toEqual({
      teamDir: "/tmp/x",
    });
  });

  test("--team-dir without value throws", () => {
    expect(() => parseLaneStallTickArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg throws", () => {
    expect(() => parseLaneStallTickArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- runLaneStallTick — gating ----------

function team(overrides: Partial<Team> = {}): Team {
  return {
    name: "demo",
    members: [],
    ...overrides,
  } as Team;
}

describe("runLaneStallTick — gating", () => {
  const captureFixture: CaptureFn = async () => "❯ ";
  const noopSendKeys = async (): Promise<void> => undefined;
  const baseDeps: LaneStallTickDeps = {
    capture: captureFixture,
    sendKeys: noopSendKeys,
    log: () => {},
    nowSec: () => 1_715_000_000,
  };

  test("cadence.enabled !== true → no-op (returns empty decisions, no fires)", async () => {
    const t = team(); // no cadence block
    const result = await runLaneStallTick(t, atmuxDir, baseDeps);
    expect(result.decisions).toEqual([]);
    expect(result.fired).toBe(0);
    expect(result.flagged).toBe(0);
  });

  test("cadence.laneStallEnabled === false → no-op", async () => {
    const t = team({
      cadence: { enabled: true, laneStallEnabled: false },
    } as never);
    const result = await runLaneStallTick(t, atmuxDir, baseDeps);
    expect(result.decisions).toEqual([]);
    expect(result.fired).toBe(0);
  });

  test("no todo Tasks with non-null lane → no-op", async () => {
    const t = team({
      cadence: { enabled: true, laneStallEnabled: true },
      members: [{ name: "alpha", lane: "be" }],
    } as never);
    // empty kanban
    const result = await runLaneStallTick(t, atmuxDir, baseDeps);
    expect(result.decisions).toEqual([]);
    expect(result.fired).toBe(0);
  });
});

// ---------- runLaneStallTick — fire path ----------

describe("runLaneStallTick — fire path", () => {
  test("stalled task + all-idle members → fires send-keys + writes dedup", async () => {
    const now = 1_715_000_000;
    const t = team({
      cadence: { enabled: true, laneStallEnabled: true },
      members: [{ name: "alpha", lane: "be", emoji: "🐝" }],
    } as never);
    // Seed a task 31min old.
    const taskId = await addTask(atmuxDir, { subject: "stalled", lane: "be" });
    // Hack: mutate createdAt so the age math hits. The simplest path is
    // to construct via the JSON storage layer — but addTask defaults to
    // `nowEpoch()`. Override via a direct kanban tweak.
    // Actually: `addTask` uses `nowEpoch()` which reads `now()` from
    // abstractions/time.ts. Tests can't easily set that without
    // setNow(). For this fixture we override the read-side now via
    // deps.nowSec and pin the task createdAt by re-writing the JSON
    // post-addTask.
    await tweakTaskCreatedAt(atmuxDir, taskId, now - 1900);

    const sentCalls: Array<{ target: string; keys: string }> = [];
    const result = await runLaneStallTick(t, atmuxDir, {
      capture: async () => "❯ ", // READY state
      sendKeys: async (target: string, keys: string) => {
        sentCalls.push({ target, keys });
      },
      cadenceVerdict: async () => "idle",
      log: () => {},
      nowSec: () => now,
      home: homeDir,
    });

    expect(result.fired).toBe(1);
    expect(result.flagged).toBe(0);
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0]?.keys).toBe(`atmux claim ${taskId}`);
    expect(sentCalls[0]?.target).toContain("alpha");

    // Dedup state should have the fire entry.
    const dedup = await readDedupState(homeDir);
    expect(dedup.fires).toHaveLength(1);
    expect(dedup.fires[0]?.taskId).toBe(taskId);
    expect(dedup.fires[0]?.lane).toBe("be");
  });

  test("pane non-READY → flag file written + no dedup entry", async () => {
    const now = 1_715_000_000;
    const t = team({
      cadence: { enabled: true, laneStallEnabled: true },
      members: [{ name: "alpha", lane: "be" }],
    } as never);
    const taskId = await addTask(atmuxDir, { subject: "stalled-noready", lane: "be" });
    await tweakTaskCreatedAt(atmuxDir, taskId, now - 1900);

    const sentCalls: Array<{ target: string; keys: string }> = [];
    // Capture returns text that classifies as UNKNOWN (not READY).
    const unreadyCapture: CaptureFn = async () => "$ "; // shell prompt
    const result = await runLaneStallTick(t, atmuxDir, {
      capture: unreadyCapture,
      sendKeys: async (target: string, keys: string) => {
        sentCalls.push({ target, keys });
      },
      cadenceVerdict: async () => "idle",
      log: () => {},
      nowSec: () => now,
      home: homeDir,
    });

    expect(result.fired).toBe(0);
    expect(result.flagged).toBe(1);
    expect(sentCalls).toHaveLength(0);

    // Flag file should exist with an entry.
    const flagPath = join(atmuxDir, "state", "lane-stall-flags.md");
    expect(await exists(flagPath)).toBe(true);
    const body = await readFile(flagPath, "utf8");
    expect(body).toContain(taskId);
    expect(body).toContain("be");

    // Dedup state should NOT have a fire entry (only successful sends
    // write to dedup).
    const dedup = await readDedupState(homeDir);
    expect(dedup.fires).toHaveLength(0);
  });

  test("some-shipping member → no fire", async () => {
    const now = 1_715_000_000;
    const t = team({
      cadence: { enabled: true, laneStallEnabled: true },
      members: [
        { name: "alpha", lane: "be" },
        { name: "bravo", lane: "be" },
      ],
    } as never);
    const taskId = await addTask(atmuxDir, { subject: "shipping-lane", lane: "be" });
    await tweakTaskCreatedAt(atmuxDir, taskId, now - 1900);

    const sentCalls: Array<{ target: string; keys: string }> = [];
    const result = await runLaneStallTick(t, atmuxDir, {
      capture: async () => "❯ ",
      sendKeys: async (target: string, keys: string) => {
        sentCalls.push({ target, keys });
      },
      cadenceVerdict: async (m) => (m.name === "bravo" ? "shipping" : "idle"),
      log: () => {},
      nowSec: () => now,
      home: homeDir,
    });

    expect(result.fired).toBe(0);
    expect(result.flagged).toBe(0);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.kind).toBe("skip-some-shipping");
    expect(sentCalls).toHaveLength(0);
  });
});

// ---------- runLaneStallTick — dedup pruning ----------

describe("runLaneStallTick — dedup pruning + interaction", () => {
  test("stale dedup entries pruned before decision", async () => {
    const now = 1_715_000_000;
    // Seed a stale fire entry (older than dedupWindow = 900s default).
    await appendDedupFire(homeDir, {
      taskId: "t-stale-fire",
      lane: "be",
      firedAt: now - 2000,
    });
    // Plus a fresh one (kept).
    await appendDedupFire(homeDir, {
      taskId: "t-fresh-fire",
      lane: "be",
      firedAt: now - 60,
    });

    const t = team({
      cadence: { enabled: true, laneStallEnabled: true },
      members: [{ name: "alpha", lane: "be" }],
    } as never);
    const result = await runLaneStallTick(t, atmuxDir, {
      capture: async () => "❯ ",
      sendKeys: async () => undefined,
      cadenceVerdict: async () => "idle",
      log: () => {},
      nowSec: () => now,
      home: homeDir,
    });

    expect(result.prunedDedupEntries).toBe(1);
    const dedup = await readDedupState(homeDir);
    // Only the fresh entry survives.
    expect(dedup.fires).toHaveLength(1);
    expect(dedup.fires[0]?.taskId).toBe("t-fresh-fire");
  });
});

// ---------- Helpers ----------

/** Override an existing task's `createdAt` so age math hits a stable
 *  fixture value. Reads + rewrites the SQLite or kanban.json record. */
async function tweakTaskCreatedAt(
  atmuxDir: string,
  taskId: string,
  createdAt: number,
): Promise<void> {
  const dbPath = join(atmuxDir, "state.db");
  if (await exists(dbPath)) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    db.run("UPDATE tasks SET created_at = ? WHERE id = ?", [createdAt, taskId]);
    db.close();
    return;
  }
  // JSON fallback.
  const kbPath = join(atmuxDir, "kanban.json");
  const text = await readFile(kbPath, "utf8");
  const kb = JSON.parse(text) as { tasks: Array<{ id: string; createdAt: number }> };
  for (const t of kb.tasks) {
    if (t.id === taskId) t.createdAt = createdAt;
  }
  await writeFile(kbPath, JSON.stringify(kb, null, 2));
}

// Pin unused-but-imported types so TS doesn't drop them via dead-import
// pruning. PaneClassification + PaneState surface through verb deps.
const _typePin: { c?: PaneClassification; s?: PaneState } = {};
void _typePin;
