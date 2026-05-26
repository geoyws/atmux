// Unit tests for src/core/spawn-queue.ts — ADR-228 Phase 5b
// (driver P0 step 4/5, 2026-05-23): refuse→enqueue + drain.
//
// Pins (mirrors Story s-4 §AC #5 test matrix):
//   - enqueue-under-cap: admission + insert + epic.spawn-queued emit
//   - refuse-at-cap: admission refusal with reason
//   - duplicate-refuse: idempotency surface
//   - drain-under-pressure-noop: pressure still high → no-op
//   - drain-load-drop-success: pressure ok + queue non-empty → 1 drain
//   - drain-failure-retry: failed spawn → attempts++ row stays queued
//   - drain-attempt-cap-abandon: attempts >= cap → flip to abandoned
//   - handler-idempotency-on-re-emit: re-emit doesn't double-drain
//   - resolveSpawnQueueLimits env override matrix
//   - generateSpawnQueueId pattern conformance

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSince } from "../../../src/abstractions/events.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { HostPressureVerdict } from "../../../src/core/host-pressure.ts";
import { SpawnQueueRepo } from "../../../src/core/repositories/spawn-queue-repo.ts";
import {
  admit,
  enqueueIfPressured,
  generateSpawnQueueId,
  pressureMonitorTick,
  resolveSpawnQueueLimits,
  SPAWN_QUEUE_DEFAULT_MAX_ATTEMPTS,
  SPAWN_QUEUE_DEFAULT_MAX_DEPTH,
  SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC,
} from "../../../src/core/spawn-queue.ts";

let scratch: string;
let db: Database;

const OK_VERDICT: HostPressureVerdict = {
  ok: true,
  reasons: [],
  probe: null,
  thresholds: null,
  skipped: false,
};
const PRESSURED_VERDICT: HostPressureVerdict = {
  ok: false,
  reasons: ["load 15min 9.20 > 6.00"],
  probe: null,
  thresholds: null,
  skipped: false,
};
const SKIPPED_VERDICT: HostPressureVerdict = {
  ok: true,
  reasons: [],
  probe: null,
  thresholds: null,
  skipped: true,
};

const LIMITS = {
  maxDepth: SPAWN_QUEUE_DEFAULT_MAX_DEPTH,
  maxAttempts: SPAWN_QUEUE_DEFAULT_MAX_ATTEMPTS,
  pressureCheckIntervalSec: SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC,
};

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-spawn-queue-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("resolveSpawnQueueLimits", () => {
  test("returns ADR-228 §D6 defaults when env is empty", () => {
    const limits = resolveSpawnQueueLimits({});
    expect(limits.maxDepth).toBe(SPAWN_QUEUE_DEFAULT_MAX_DEPTH);
    expect(limits.maxAttempts).toBe(SPAWN_QUEUE_DEFAULT_MAX_ATTEMPTS);
    expect(limits.pressureCheckIntervalSec).toBe(SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC);
  });

  test("env overrides accepted when valid", () => {
    const limits = resolveSpawnQueueLimits({
      ATMUX_SPAWN_QUEUE_MAX_DEPTH: "16",
      ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS: "3",
      ATMUX_SPAWN_QUEUE_TICK_SEC: "10",
    });
    expect(limits).toEqual({ maxDepth: 16, maxAttempts: 3, pressureCheckIntervalSec: 10 });
  });

  test("invalid env falls back to defaults silently", () => {
    const limits = resolveSpawnQueueLimits({
      ATMUX_SPAWN_QUEUE_MAX_DEPTH: "abc",
      ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS: "-1",
      ATMUX_SPAWN_QUEUE_TICK_SEC: "0",
    });
    expect(limits).toEqual({
      maxDepth: SPAWN_QUEUE_DEFAULT_MAX_DEPTH,
      maxAttempts: SPAWN_QUEUE_DEFAULT_MAX_ATTEMPTS,
      pressureCheckIntervalSec: SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC,
    });
  });

  test("ATMUX_SPAWN_QUEUE_MAX_DEPTH=0 → maxDepth=0 (queueing disabled escape hatch)", () => {
    const limits = resolveSpawnQueueLimits({ ATMUX_SPAWN_QUEUE_MAX_DEPTH: "0" });
    expect(limits.maxDepth).toBe(0);
  });
});

describe("generateSpawnQueueId", () => {
  test("matches SPAWN_QUEUE_ID_PATTERN — `q-<8 lowercase hex>`", () => {
    const id = generateSpawnQueueId();
    expect(id).toMatch(/^q-[0-9a-f]{8}$/);
  });

  test("uniqueness across consecutive calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSpawnQueueId()));
    expect(ids.size).toBe(50);
  });
});

describe("admit", () => {
  test("admits when queue empty + maxDepth > 0", () => {
    const v = admit(db, LIMITS, "e-aaaa1111");
    expect(v).toEqual({ admitted: true, reason: null });
  });

  test("refuses when maxDepth = 0 (queueing disabled)", () => {
    const v = admit(db, { ...LIMITS, maxDepth: 0 }, "e-aaaa1111");
    expect(v.admitted).toBe(false);
    expect(v.reason).toMatch(/queueing disabled/);
  });

  test("refuses at-cap (depth ≥ maxDepth)", () => {
    const tightLimits = { ...LIMITS, maxDepth: 2 };
    // Fill to cap.
    expect(
      enqueueIfPressured("e-aaaa0001", ["spawn-epic", "e-aaaa0001"], {
        db,
        limits: tightLimits,
        queuedBy: "driver",
      }).enqueued,
    ).toBe(true);
    expect(
      enqueueIfPressured("e-aaaa0002", ["spawn-epic", "e-aaaa0002"], {
        db,
        limits: tightLimits,
        queuedBy: "driver",
      }).enqueued,
    ).toBe(true);
    const v = admit(db, tightLimits, "e-aaaa0003");
    expect(v.admitted).toBe(false);
    expect(v.reason).toMatch(/queue full: depth 2 ≥ maxDepth 2/);
  });

  test("refuses duplicate (same epicId already queued)", () => {
    expect(
      enqueueIfPressured("e-aaaa9999", ["spawn-epic", "e-aaaa9999"], {
        db,
        limits: LIMITS,
        queuedBy: "driver",
      }).enqueued,
    ).toBe(true);
    const v = admit(db, LIMITS, "e-aaaa9999");
    expect(v.admitted).toBe(false);
    expect(v.reason).toMatch(/epic already queued: q-[0-9a-f]{8}/);
  });
});

describe("enqueueIfPressured", () => {
  test("inserts row + emits epic.spawn-queued on admission", () => {
    const r = enqueueIfPressured("e-cafe0001", ["spawn-epic", "e-cafe0001", "--from", "atmux"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
      nowSec: () => 1_700_000_500,
    });
    expect(r.enqueued).toBe(true);
    expect(r.depth).toBe(1);
    expect(r.queueId).toMatch(/^q-[0-9a-f]{8}$/);

    // Row landed
    const repo = new SpawnQueueRepo(db);
    const rows = repo.listAllSorted();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.epicId).toBe("e-cafe0001");
    expect(rows[0]?.spawnArgs).toBe(
      JSON.stringify(["spawn-epic", "e-cafe0001", "--from", "atmux"]),
    );

    // Event landed in events table — drainSince from t=0 returns it
    const events = Array.from(drainSince(db, { topics: ["epic.spawn-queued"], lastEventId: "" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: "epic.spawn-queued",
      epicId: "e-cafe0001",
      depth: 1,
    });
  });

  test("returns enqueued=false + reason on cap refusal", () => {
    const tightLimits = { ...LIMITS, maxDepth: 1 };
    enqueueIfPressured("e-cafe1001", ["spawn-epic", "e-cafe1001"], {
      db,
      limits: tightLimits,
      queuedBy: "driver",
    });
    const r = enqueueIfPressured("e-cafe1002", ["spawn-epic", "e-cafe1002"], {
      db,
      limits: tightLimits,
      queuedBy: "driver",
    });
    expect(r.enqueued).toBe(false);
    expect(r.reason).toMatch(/queue full/);
  });
});

describe("pressureMonitorTick", () => {
  test("noop when pressure still high (verdict.ok=false)", async () => {
    enqueueIfPressured("e-deeef001", ["spawn-epic", "e-deeef001"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
    });
    const spawnCalls: ReadonlyArray<string>[] = [];
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => PRESSURED_VERDICT,
      spawnEpic: async (argv) => {
        spawnCalls.push(argv);
        return { success: true };
      },
      limits: LIMITS,
    });
    expect(result.drained).toBe(0);
    expect(result.remaining).toBe(1);
    expect(spawnCalls).toHaveLength(0);
  });

  test("drains one when pressure ok + queue non-empty", async () => {
    enqueueIfPressured("e-deeef002", ["spawn-epic", "e-deeef002"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
    });
    const spawnCalls: ReadonlyArray<string>[] = [];
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => OK_VERDICT,
      spawnEpic: async (argv) => {
        spawnCalls.push(argv);
        return { success: true };
      },
      limits: LIMITS,
      nowSec: () => 1_700_001_000,
    });
    expect(result.drained).toBe(1);
    expect(result.remaining).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(["spawn-epic", "e-deeef002"]);

    // Row deleted on success
    const rows = new SpawnQueueRepo(db).listAllSorted();
    expect(rows).toHaveLength(0);

    // epic.added emitted (Phase 2 auto-spawn consumer hook)
    const added = Array.from(drainSince(db, { topics: ["epic.added"], lastEventId: "" }));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ topic: "epic.added", epicId: "e-deeef002" });
  });

  test("treats verdict.skipped=true as ok (non-Linux platforms drain)", async () => {
    enqueueIfPressured("e-deeef003", ["spawn-epic", "e-deeef003"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
    });
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => SKIPPED_VERDICT,
      spawnEpic: async () => ({ success: true }),
      limits: LIMITS,
    });
    expect(result.drained).toBe(1);
  });

  test("empty queue → fast no-op, no spawnEpic invocation", async () => {
    let spawnCalled = false;
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => OK_VERDICT,
      spawnEpic: async () => {
        spawnCalled = true;
        return { success: true };
      },
      limits: LIMITS,
    });
    expect(result.drained).toBe(0);
    expect(result.remaining).toBe(0);
    expect(spawnCalled).toBe(false);
  });

  test("failed spawn → attempts++ + row stays queued (under cap)", async () => {
    enqueueIfPressured("e-deeef004", ["spawn-epic", "e-deeef004"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
    });
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => OK_VERDICT,
      spawnEpic: async () => ({ success: false, reason: "transient: worktree contended" }),
      limits: LIMITS,
      nowSec: () => 1_700_002_000,
    });
    expect(result.drained).toBe(0);
    expect(result.failureReason).toMatch(/transient/);
    const rows = new SpawnQueueRepo(db).listAllSorted();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastFailureReason).toMatch(/transient/);
    expect(rows[0]?.state).toBe("queued");
  });

  test("attempts >= maxAttempts → flip to abandoned + epic.spawn-abandoned emit", async () => {
    enqueueIfPressured("e-deeef005", ["spawn-epic", "e-deeef005"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
    });
    const tightLimits = { ...LIMITS, maxAttempts: 2 };
    // First failure → attempts goes 0→1, stays queued
    await pressureMonitorTick({
      db,
      probeHostPressure: async () => OK_VERDICT,
      spawnEpic: async () => ({ success: false, reason: "fail-1" }),
      limits: tightLimits,
    });
    // Second failure → attempts goes 1→2 = cap, flips to abandoned
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => OK_VERDICT,
      spawnEpic: async () => ({ success: false, reason: "fail-2" }),
      limits: tightLimits,
    });
    expect(result.drained).toBe(0);
    expect(result.abandonedQueueId).toBeDefined();
    expect(result.failureReason).toBe("fail-2");

    // Row flipped to abandoned (NOT deleted — operator audit)
    const all = db.prepare("SELECT * FROM spawn_queue").all() as Array<{
      state: string;
      last_failure_reason: string | null;
    }>;
    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe("abandoned");

    // epic.spawn-abandoned emitted
    const abandonedEvents = Array.from(
      drainSince(db, { topics: ["epic.spawn-abandoned"], lastEventId: "" }),
    );
    expect(abandonedEvents).toHaveLength(1);
  });

  test("dispatcher throw is caught, mapped to failure path (row stays queued, attempts++)", async () => {
    enqueueIfPressured("e-deeef006", ["spawn-epic", "e-deeef006"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
    });
    const result = await pressureMonitorTick({
      db,
      probeHostPressure: async () => OK_VERDICT,
      spawnEpic: async () => {
        throw new Error("disk-full mid-spawn");
      },
      limits: LIMITS,
    });
    expect(result.drained).toBe(0);
    expect(result.failureReason).toMatch(/dispatcher threw.*disk-full/);
    const rows = new SpawnQueueRepo(db).listAllSorted();
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.state).toBe("queued");
  });

  test("FIFO ordering under same priority — earliest queued_at_sec drains first", async () => {
    const drained: string[] = [];
    enqueueIfPressured("e-deeef101", ["spawn-epic", "e-deeef101"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
      nowSec: () => 1_700_010_000,
    });
    enqueueIfPressured("e-deeef102", ["spawn-epic", "e-deeef102"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
      nowSec: () => 1_700_010_005,
    });
    enqueueIfPressured("e-deeef103", ["spawn-epic", "e-deeef103"], {
      db,
      limits: LIMITS,
      queuedBy: "driver",
      nowSec: () => 1_700_010_010,
    });
    for (let i = 0; i < 3; i += 1) {
      await pressureMonitorTick({
        db,
        probeHostPressure: async () => OK_VERDICT,
        spawnEpic: async (argv) => {
          drained.push(argv[1] ?? "?");
          return { success: true };
        },
        limits: LIMITS,
      });
    }
    expect(drained).toEqual(["e-deeef101", "e-deeef102", "e-deeef103"]);
  });
});
