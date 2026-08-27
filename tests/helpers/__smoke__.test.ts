// ADR-231 — Smoke tests for S3.1 unit-test scaffolding harness
// (t-16-27fdc08b AC: "each helper works in isolation").
//
// ADR-280 stage 4 removed the `spawn-epic-subprocess-stub.ts` section:
// the helper stubbed `atmux team spawn-epic`, a verb stage 2/3 removed,
// so it could no longer stand in for anything real. The remaining three
// helpers are unaffected — Honker dispatch, kanban rows and `atmux flag
// add` all survive the epic-team retirement.
//
// One describe block per helper file. Smoke-level only — exhaustive
// behavioural coverage lives in the Phase 2 handler tests that consume
// these helpers (T-S2.5 / T-S2.6 / T-S3.2). Goal here is to fail loudly
// if a helper's contract drifts (e.g. seedEpic stops parsing through
// the real Zod schema, HonkerMock loses at-least-once semantics).

import { describe, expect, test } from "bun:test";
import {
  createFlagSpy,
  type FlagAddArgs,
} from "./atmux-flag-spy.ts";
import {
  buildPayload,
  createHonkerMock,
} from "./honker-mock.ts";
import { seedEpic, seedTask } from "./kanban-fixtures.ts";

// ---------- honker-mock.ts ----------

describe("honker-mock — registry + dispatch", () => {
  test("publish + drain calls each subscriber's handler exactly once", async () => {
    const mock = createHonkerMock();
    const calls: string[] = [];

    mock.register({
      topic: "epic.ready",
      consumerId: "atmux:orchd:spawn:on-ready",
      handler: async (event) => {
        calls.push(`spawn:${(event as { epicId?: string }).epicId ?? "?"}`);
      },
    });

    const payload = buildPayload({
      topic: "epic.ready",
      epicId: "e-aaaaaaaa",
      transitionedAt: 1779540000,
    });
    mock.publish(payload as Parameters<typeof mock.publish>[0]);

    const results = await mock.drain();
    expect(results).toHaveLength(1);
    const [first] = results;
    expect(first!.delivered).toBe(1);
    expect(first!.failed).toBe(0);
    expect(calls).toEqual(["spawn:e-aaaaaaaa"]);
  });

  test("at-least-once: handler throw leaves offset put → next drain re-delivers", async () => {
    const mock = createHonkerMock();
    let attempt = 0;

    mock.register({
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker",
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
      },
    });

    const payload = buildPayload({
      topic: "task.done",
      taskId: "t-aaaaaaaa",
      member: "worker-0",
      team: "test",
      doneAtSec: 1779540000,
    });
    mock.publish(payload as Parameters<typeof mock.publish>[0]);

    // First drain: handler throws → offset stays at 0, error recorded.
    const first = await mock.drain();
    expect(first[0]!.delivered).toBe(0);
    expect(first[0]!.failed).toBe(1);
    expect(mock.getOffset("atmux:orchd:dissolve-worker")).toBe(0);

    // Second drain: re-delivers the same event → handler succeeds, offset advances.
    const second = await mock.drain();
    expect(second[0]!.delivered).toBe(1);
    expect(mock.getOffset("atmux:orchd:dissolve-worker")).toBeGreaterThan(0);
    expect(attempt).toBe(2);
  });

  test("per-consumer offsets isolate subscribers on the same topic", async () => {
    const mock = createHonkerMock();
    const seenA: string[] = [];
    const seenB: string[] = [];

    mock.register({
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker",
      handler: async (e) => {
        seenA.push((e as { taskId?: string }).taskId ?? "?");
      },
    });
    mock.register({
      topic: "task.done",
      consumerId: "atmux:orchd:auto-merge",
      handler: async (e) => {
        seenB.push((e as { taskId?: string }).taskId ?? "?");
      },
    });

    mock.publish(buildPayload({
      topic: "task.done",
      taskId: "t-1",
      member: "m",
      team: "t",
      doneAtSec: 1,
    }) as Parameters<typeof mock.publish>[0]);

    await mock.drain();
    expect(seenA).toEqual(["t-1"]);
    expect(seenB).toEqual(["t-1"]);
  });

  test("idempotent register — same consumerId twice = no-op + false", () => {
    const mock = createHonkerMock();
    const sub = {
      topic: "epic.ready",
      consumerId: "x",
      handler: async () => {},
    };
    expect(mock.register(sub)).toBe(true);
    expect(mock.register(sub)).toBe(false);
    expect(mock.getSubscribers()).toHaveLength(1);
  });
});

// ---------- kanban-fixtures.ts ----------

describe("kanban-fixtures — seedEpic + seedTask", () => {
  test("seedEpic defaults: ready, no deps, never-spawned, valid Zod parse", () => {
    const epic = seedEpic();
    expect(epic.id).toMatch(/^e-[0-9a-f]{8}$/);
    expect(epic.isReady).toBe(true);
    expect(epic.dependsOn).toEqual([]);
    expect((epic as { spawnedAt?: number | null }).spawnedAt).toBeUndefined();
  });

  test("seedEpic propagates autoSpawn under extra (ADR-231 §D3)", () => {
    const epic = seedEpic({
      autoSpawn: { enabled: true, roster: "solo", forceSpawn: false },
    });
    const extra = (epic as { extra?: { autoSpawn?: { enabled?: boolean; roster?: string } } }).extra;
    expect(extra?.autoSpawn?.enabled).toBe(true);
    expect(extra?.autoSpawn?.roster).toBe("solo");
  });

  test("seedEpic propagates spawnedAt at top level (ADR-231 §D2 dedup col)", () => {
    const epic = seedEpic({ spawnedAt: 1779540000 });
    expect((epic as { spawnedAt?: number | null }).spawnedAt).toBe(1779540000);
  });

  test("seedEpic respects explicit id + dependsOn + isReady=false", () => {
    const epic = seedEpic({
      id: "e-deadbeef",
      dependsOn: ["e-aaaaaaaa", "e-bbbbbbbb"],
      isReady: false,
    });
    expect(epic.id).toBe("e-deadbeef");
    expect(epic.dependsOn).toEqual(["e-aaaaaaaa", "e-bbbbbbbb"]);
    expect(epic.isReady).toBe(false);
  });

  test("seedTask defaults: todo + unclaimed + valid Zod parse", () => {
    const task = seedTask();
    expect(task.id).toMatch(/^t-[0-9a-f]{8}$/);
    expect(task.status).toBe("todo");
    expect(task.owner).toBeNull();
    expect(task.deps).toEqual([]);
  });

  test("seedTask respects done + owner + completedAt overrides", () => {
    const task = seedTask({
      status: "done",
      owner: "worker-0",
      completedAt: 1779540000,
    });
    expect(task.status).toBe("done");
    expect(task.owner).toBe("worker-0");
    expect(task.completedAt).toBe(1779540000);
  });
});

// ---------- atmux-flag-spy.ts ----------

describe("atmux-flag-spy — capture + assert", () => {
  test("records calls with full arg shape", async () => {
    const spy = createFlagSpy();
    const args: FlagAddArgs = {
      message: "orchd: spawn failed for epic e-x: bad roster",
      severity: "p1",
      needs: "unblock",
      taskId: "t-x",
    };
    await spy.add(args);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({
      message: args.message,
      severity: "p1",
      needs: "unblock",
      taskId: "t-x",
      sequence: 1,
    });
  });

  test("findByMessage — string substring + RegExp filters", async () => {
    const spy = createFlagSpy();
    await spy.add({ message: "orchd: spawn failed for e-x" });
    await spy.add({ message: "orchd: host-pressure-deferred for e-y" });
    await spy.add({ message: "unrelated flag" });

    expect(spy.findByMessage("spawn failed")).toHaveLength(1);
    expect(spy.findByMessage(/host-pressure/)).toHaveLength(1);
    expect(spy.findByMessage("nope")).toHaveLength(0);
  });

  test("reset() clears recorded calls", async () => {
    const spy = createFlagSpy();
    await spy.add({ message: "first" });
    spy.reset();
    expect(spy.calls).toHaveLength(0);
    await spy.add({ message: "second" });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.sequence).toBe(1);
  });
});
