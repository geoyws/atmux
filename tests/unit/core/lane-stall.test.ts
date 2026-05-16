// Unit tests for src/core/lane-stall.ts (ADR-148 §D4 / T3).
//
// Covers:
//   - STALL_VERDICTS set membership
//   - decideLaneStall: age threshold gate, lane-affinity gate,
//     all-non-shipping gate, dedup gate, target-member selection
//   - Dedup state R/W round-trip + pruneDedupState

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../../../src/abstractions/fs.ts";
import {
  appendDedupFire,
  type CadenceVerdict,
  decideLaneStall,
  dedupStatePath,
  type LaneStallDedupEntry,
  type LaneStallMemberInput,
  type LaneStallTaskInput,
  pruneDedupState,
  readDedupState,
  STALL_VERDICTS,
} from "../../../src/core/lane-stall.ts";
import { SchemaError } from "../../../src/errors.ts";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "atmux-lane-stall-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

// ---------- STALL_VERDICTS ----------

describe("STALL_VERDICTS", () => {
  test("contains idle / dormant / ship-zero-window per ADR-148 §D4", () => {
    expect(STALL_VERDICTS.has("idle")).toBe(true);
    expect(STALL_VERDICTS.has("dormant")).toBe(true);
    expect(STALL_VERDICTS.has("ship-zero-window")).toBe(true);
  });

  test("excludes shipping (gate condition is non-shipping)", () => {
    expect(STALL_VERDICTS.has("shipping")).toBe(false);
  });
});

// ---------- Decision-rule helpers ----------

const NOW = 1_715_000_000;
const HALF_HOUR = 1800;

function task(id: string, lane: string, ageSec: number): LaneStallTaskInput {
  return { id, lane, createdAt: NOW - ageSec };
}

function member(
  name: string,
  lane: string,
  verdict: CadenceVerdict,
  lastActivityAt?: number,
): LaneStallMemberInput {
  const m: LaneStallMemberInput = { name, lane, verdict };
  if (lastActivityAt !== undefined) m.lastActivityAt = lastActivityAt;
  return m;
}

// ---------- decideLaneStall — gate-by-gate ----------

describe("decideLaneStall — age threshold gate", () => {
  test("task age below threshold → skip-age-below-threshold", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-young", "be", HALF_HOUR - 60)],
      members: [member("alpha", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("skip-age-below-threshold");
    expect(decisions[0]?.taskId).toBe("t-young");
  });

  test("task age exactly at threshold → still below (strict >)", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-edge", "be", HALF_HOUR)],
      members: [member("alpha", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("skip-age-below-threshold");
  });

  test("task age above threshold + all members idle → fire", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-old", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("fire");
    expect(decisions[0]?.taskId).toBe("t-old");
    expect(decisions[0]?.targetMember).toBe("alpha");
  });
});

describe("decideLaneStall — lane-affinity gate", () => {
  test("no member has lane affinity → skip-no-lane-members", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-orphan", "fe", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle"), member("bravo", "ops", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("skip-no-lane-members");
  });

  test("task with lane='' (empty) → skipped silently (defensive)", () => {
    const decisions = decideLaneStall({
      tasks: [{ id: "t-empty", lane: "", createdAt: NOW - HALF_HOUR - 60 }],
      members: [member("alpha", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions).toHaveLength(0);
  });
});

describe("decideLaneStall — all-non-shipping gate", () => {
  test("any member shipping → skip-some-shipping", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-shipping", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "shipping"), member("bravo", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("skip-some-shipping");
    expect(decisions[0]?.reason).toContain("alpha");
  });

  test("all non-shipping (mixed idle/dormant/ship-zero-window) → fire", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-fire", "be", HALF_HOUR + 60)],
      members: [
        member("alpha", "be", "idle"),
        member("bravo", "be", "dormant"),
        member("charlie", "be", "ship-zero-window"),
      ],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("fire");
  });
});

describe("decideLaneStall — dedup gate", () => {
  test("recent fire (within dedupWindow = minAge/2) → skip-dedup", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-recent", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle")],
      dedup: [
        { taskId: "t-recent", lane: "be", firedAt: NOW - 60 }, // 60s ago, < 900s window
      ],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("skip-dedup");
    expect(decisions[0]?.reason).toContain("recent fire");
  });

  test("old fire (outside dedupWindow) → fires again", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-old-fire", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle")],
      dedup: [
        { taskId: "t-old-fire", lane: "be", firedAt: NOW - HALF_HOUR }, // 1800s ago, > 900s window
      ],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("fire");
  });

  test("dedup entry on different (taskId, lane) does NOT block fire", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-target", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle")],
      dedup: [{ taskId: "t-other", lane: "be", firedAt: NOW - 60 }],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.kind).toBe("fire");
  });
});

describe("decideLaneStall — target-member selection", () => {
  test("single member → that member", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-pick", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.targetMember).toBe("alpha");
  });

  test("multi-member: most-recently-active wins", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-pick", "be", HALF_HOUR + 60)],
      members: [
        member("alpha", "be", "idle", NOW - 600),
        member("bravo", "be", "idle", NOW - 60), // most recent
        member("charlie", "be", "idle", NOW - 300),
      ],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.targetMember).toBe("bravo");
  });

  test("multi-member no lastActivityAt → roster-order tiebreak", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-tie", "be", HALF_HOUR + 60)],
      members: [member("alpha", "be", "idle"), member("bravo", "be", "idle")],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.targetMember).toBe("alpha");
  });

  test("mixed has/missing lastActivityAt: explicit ts wins over absent", () => {
    const decisions = decideLaneStall({
      tasks: [task("t-mix", "be", HALF_HOUR + 60)],
      members: [
        member("alpha", "be", "idle"), // no activity
        member("bravo", "be", "idle", NOW - 60), // explicit recent
      ],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions[0]?.targetMember).toBe("bravo");
  });
});

describe("decideLaneStall — multi-task / multi-lane", () => {
  test("per-task independent decisions; one fires, others skip", () => {
    const decisions = decideLaneStall({
      tasks: [
        task("t-fe-fire", "fe", HALF_HOUR + 60),
        task("t-be-shipping", "be", HALF_HOUR + 60),
        task("t-ops-young", "ops", HALF_HOUR - 60),
      ],
      members: [
        member("fe1", "fe", "idle"),
        member("be1", "be", "shipping"),
        member("ops1", "ops", "idle"),
      ],
      dedup: [],
      nowSec: NOW,
      laneStallMinAgeSec: HALF_HOUR,
    });
    expect(decisions).toHaveLength(3);
    const byTask = new Map(decisions.map((d) => [d.taskId, d.kind] as const));
    expect(byTask.get("t-fe-fire")).toBe("fire");
    expect(byTask.get("t-be-shipping")).toBe("skip-some-shipping");
    expect(byTask.get("t-ops-young")).toBe("skip-age-below-threshold");
  });
});

// ---------- Dedup state R/W ----------

describe("dedupStatePath", () => {
  test("resolves to <home>/.atmux/state/lane-stall-fires.json", () => {
    expect(dedupStatePath("/home/op")).toBe("/home/op/.atmux/state/lane-stall-fires.json");
  });
});

describe("readDedupState", () => {
  test("returns empty when file absent (first-run)", async () => {
    const state = await readDedupState(homeDir);
    expect(state).toEqual({ fires: [] });
  });

  test("reads existing valid file", async () => {
    const dir = join(homeDir, ".atmux", "state");
    await ensureDir(dir);
    await writeFile(
      join(dir, "lane-stall-fires.json"),
      JSON.stringify({
        fires: [{ taskId: "t-abc12345", lane: "be", firedAt: 1_715_000_000 }],
      }),
    );
    const state = await readDedupState(homeDir);
    expect(state.fires).toHaveLength(1);
    expect(state.fires[0]?.taskId).toBe("t-abc12345");
  });

  test("malformed JSON throws SchemaError", async () => {
    const dir = join(homeDir, ".atmux", "state");
    await ensureDir(dir);
    await writeFile(join(dir, "lane-stall-fires.json"), "{not-json");
    await expect(readDedupState(homeDir)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("appendDedupFire", () => {
  test("creates the file on first write", async () => {
    await appendDedupFire(homeDir, {
      taskId: "t-fresh",
      lane: "be",
      firedAt: 1_715_000_000,
    });
    const state = await readDedupState(homeDir);
    expect(state.fires).toEqual([{ taskId: "t-fresh", lane: "be", firedAt: 1_715_000_000 }]);
  });

  test("appends new entries", async () => {
    await appendDedupFire(homeDir, { taskId: "t-a", lane: "be", firedAt: 100 });
    await appendDedupFire(homeDir, { taskId: "t-b", lane: "fe", firedAt: 200 });
    const state = await readDedupState(homeDir);
    expect(state.fires).toHaveLength(2);
    expect(state.fires[0]?.taskId).toBe("t-a");
    expect(state.fires[1]?.taskId).toBe("t-b");
  });

  test("idempotent on (taskId, lane): bumps firedAt instead of duplicating", async () => {
    await appendDedupFire(homeDir, { taskId: "t-bump", lane: "be", firedAt: 100 });
    await appendDedupFire(homeDir, { taskId: "t-bump", lane: "be", firedAt: 200 });
    const state = await readDedupState(homeDir);
    expect(state.fires).toHaveLength(1);
    expect(state.fires[0]?.firedAt).toBe(200);
  });

  test("same taskId different lane → distinct entry", async () => {
    await appendDedupFire(homeDir, { taskId: "t-multi", lane: "be", firedAt: 100 });
    await appendDedupFire(homeDir, { taskId: "t-multi", lane: "fe", firedAt: 200 });
    const state = await readDedupState(homeDir);
    expect(state.fires).toHaveLength(2);
  });
});

describe("pruneDedupState", () => {
  test("no-op on absent file (returns 0)", async () => {
    const pruned = await pruneDedupState(homeDir, NOW, HALF_HOUR);
    expect(pruned).toBe(0);
  });

  test("drops entries older than dedupWindow (= minAge / 2)", async () => {
    await appendDedupFire(homeDir, { taskId: "t-old1", lane: "be", firedAt: NOW - 1000 });
    await appendDedupFire(homeDir, { taskId: "t-old2", lane: "be", firedAt: NOW - 2000 });
    await appendDedupFire(homeDir, { taskId: "t-fresh", lane: "be", firedAt: NOW - 60 });
    // dedupWindow = HALF_HOUR/2 = 900s; old1 + old2 > 900s, fresh <
    const pruned = await pruneDedupState(homeDir, NOW, HALF_HOUR);
    expect(pruned).toBe(2);
    const state = await readDedupState(homeDir);
    expect(state.fires).toHaveLength(1);
    expect(state.fires[0]?.taskId).toBe("t-fresh");
  });

  test("no-op when all entries are fresh", async () => {
    await appendDedupFire(homeDir, { taskId: "t-fresh1", lane: "be", firedAt: NOW - 60 });
    await appendDedupFire(homeDir, { taskId: "t-fresh2", lane: "be", firedAt: NOW - 120 });
    const pruned = await pruneDedupState(homeDir, NOW, HALF_HOUR);
    expect(pruned).toBe(0);
  });
});

// Defensive: confirm the dedup state file is set-semantic + atomic.
describe("Dedup state — concurrent appends", () => {
  test("two parallel appends both land via the lock", async () => {
    await Promise.all([
      appendDedupFire(homeDir, { taskId: "t-a", lane: "be", firedAt: 100 }),
      appendDedupFire(homeDir, { taskId: "t-b", lane: "fe", firedAt: 200 }),
    ]);
    const state = await readDedupState(homeDir);
    expect(state.fires).toHaveLength(2);
    const ids = new Set(state.fires.map((f) => f.taskId));
    expect(ids.has("t-a")).toBe(true);
    expect(ids.has("t-b")).toBe(true);
  });
});

// Used at the verb layer; pin the unused-import-prevention shape so future
// refactors don't accidentally drop it.
describe("LaneStallDedupEntry shape pin", () => {
  test("entry has taskId / lane / firedAt", () => {
    const entry: LaneStallDedupEntry = {
      taskId: "t-pin",
      lane: "be",
      firedAt: 1234,
    };
    expect(entry.taskId).toBe("t-pin");
    expect(entry.lane).toBe("be");
    expect(entry.firedAt).toBe(1234);
  });
});
