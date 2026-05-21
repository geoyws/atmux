// Unit tests for src/core/gitter-consumer.ts — Honker gitter consumer
// (T2 of EPIC e-4acc3562).
//
// Pins:
//   - Kill-switch off (`ATMUX_HONKER` unset/off) short-circuits to
//     {processed:0, escalated:0} without touching the events table.
//   - Happy path: 3 `task.done` events emitted → handler called 3
//     times in event_id order → returns {processed:3}.
//   - 'escalated' outcomes increment the escalated counter.
//   - Default stub handler returns 'skipped-not-mine'; processed
//     counts the stub call without escalating.
//   - Handler throws → drain stops at the failing event, offset stays
//     before the failing event, next sweep re-attempts (idempotency
//     contract per ADR-203 §D7).
//   - saveOffset advances after each non-throwing handler return
//     ('merged' / 'escalated' / 'skipped-*' all advance).
//   - Topics filter defaults to `['task.done']` — non-matching topics
//     are not drained.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit, loadOffset } from "../../../src/abstractions/events.ts";
import { gitterConsume, type HandlerOutcome } from "../../../src/core/gitter-consumer.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";

let scratch: string;
let db: Database;
const HONKER_ON: NodeJS.ProcessEnv = { ATMUX_HONKER: "on" };
const HONKER_OFF: NodeJS.ProcessEnv = { ATMUX_HONKER: "off" };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-gitter-consumer-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function emitTaskDone(n: number, member = "be-1"): void {
  emit(
    db,
    {
      topic: "task.done",
      taskId: `t-${String(n).padStart(8, "0")}`,
      member,
      team: "atmux",
      doneAtSec: 1_700_000_000 + n,
    },
    { generateId: () => fakeId(n), nowSec: () => 1_700_000_000 + n },
  );
}

describe("kill-switch behavior", () => {
  test("ATMUX_HONKER off short-circuits to zero totals without draining", async () => {
    emitTaskDone(1);
    emitTaskDone(2);

    const result = await gitterConsume({ db, env: HONKER_OFF });

    expect(result).toEqual({ processed: 0, escalated: 0 });
    // Offset must NOT have moved — the drain never ran.
    expect(loadOffset(db, "atmux:gitter")).toBe("");
  });

  test("ATMUX_HONKER unset (default) also short-circuits", async () => {
    emitTaskDone(1);
    const result = await gitterConsume({ db, env: {} });
    expect(result).toEqual({ processed: 0, escalated: 0 });
  });

  test("short-circuit logs the fallback path", async () => {
    const lines: string[] = [];
    await gitterConsume({
      db,
      env: HONKER_OFF,
      logger: {
        info: (msg) => lines.push(msg),
        warn: () => {},
        error: () => {},
      },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ATMUX_HONKER=off");
  });
});

describe("happy path", () => {
  test("drains 3 events + calls injected handler for each in event_id order", async () => {
    emitTaskDone(1);
    emitTaskDone(2);
    emitTaskDone(3);

    const seen: string[] = [];
    const handler = async (event: { taskId: string }): Promise<HandlerOutcome> => {
      seen.push(event.taskId);
      return "merged";
    };

    const result = await gitterConsume({ db, env: HONKER_ON, handler });

    expect(result).toEqual({ processed: 3, escalated: 0 });
    expect(seen).toEqual(["t-00000001", "t-00000002", "t-00000003"]);
    // Offset advanced to the last-handled event.
    expect(loadOffset(db, "atmux:gitter")).toBe(fakeId(3));
  });

  test("counts escalated outcomes separately from processed", async () => {
    emitTaskDone(1);
    emitTaskDone(2);
    emitTaskDone(3);

    const handler = async (event: { taskId: string }): Promise<HandlerOutcome> => {
      // event 2 escalates; others merge cleanly
      return event.taskId === "t-00000002" ? "escalated" : "merged";
    };

    const result = await gitterConsume({ db, env: HONKER_ON, handler });

    expect(result).toEqual({ processed: 3, escalated: 1 });
  });

  test("default stub handler returns 'skipped-not-mine' (no escalations, advances offset)", async () => {
    emitTaskDone(1);
    emitTaskDone(2);

    const result = await gitterConsume({ db, env: HONKER_ON });

    expect(result).toEqual({ processed: 2, escalated: 0 });
    expect(loadOffset(db, "atmux:gitter")).toBe(fakeId(2));
  });
});

describe("failure mode", () => {
  test("handler throws stops at failing event + offset stays before it", async () => {
    emitTaskDone(1);
    emitTaskDone(2);
    emitTaskDone(3);

    const handler = async (event: { taskId: string }): Promise<HandlerOutcome> => {
      if (event.taskId === "t-00000002") {
        throw new Error("simulated merge dispatch failure");
      }
      return "merged";
    };

    // gitterConsume itself does NOT propagate the throw — withIdempotency
    // catches + halts internally.
    const result = await gitterConsume({ db, env: HONKER_ON, handler });

    // Only event 1 made it through before the throw on event 2.
    expect(result).toEqual({ processed: 1, escalated: 0 });
    // Offset sits at event 1 — next sweep re-attempts event 2.
    expect(loadOffset(db, "atmux:gitter")).toBe(fakeId(1));
  });

  test("re-sweep after fixing the handler resumes from the held offset", async () => {
    emitTaskDone(1);
    emitTaskDone(2);

    let throwOnce = true;
    const handler = async (_event: unknown): Promise<HandlerOutcome> => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transient");
      }
      return "merged";
    };

    const first = await gitterConsume({ db, env: HONKER_ON, handler });
    expect(first.processed).toBe(0);
    expect(loadOffset(db, "atmux:gitter")).toBe("");

    // Re-sweep — handler no longer throws, both events drain.
    const second = await gitterConsume({ db, env: HONKER_ON, handler });
    expect(second.processed).toBe(2);
    expect(loadOffset(db, "atmux:gitter")).toBe(fakeId(2));
  });
});

describe("consumer + topic injection", () => {
  test("custom consumerName isolates offset rows", async () => {
    emitTaskDone(1);
    await gitterConsume({
      db,
      env: HONKER_ON,
      consumerName: "atmux:gitter-shard-A",
      handler: async () => "merged",
    });

    expect(loadOffset(db, "atmux:gitter-shard-A")).toBe(fakeId(1));
    // Default consumer offset untouched.
    expect(loadOffset(db, "atmux:gitter")).toBe("");
  });

  test("default topics is ['task.done'] — other topics are not drained", async () => {
    // Emit a commit.landed event; should be ignored by default topic filter.
    emit(
      db,
      {
        topic: "commit.landed",
        commitSha: "deadbeef",
        branch: "atmux-geoyws-foo",
        author: "g@x",
        message: "feat: thing",
      },
      { generateId: () => fakeId(1), nowSec: () => 1_700_000_001 },
    );

    const result = await gitterConsume({
      db,
      env: HONKER_ON,
      handler: async () => "merged",
    });

    expect(result).toEqual({ processed: 0, escalated: 0 });
  });
});
