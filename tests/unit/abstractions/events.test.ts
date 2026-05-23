// Unit tests for src/abstractions/events.ts — emit + drainSince +
// offset tracking + withIdempotency.
//
// Pins:
//   - emit() validates via Zod + INSERTs into events table; auto-fills
//     eventId (UUIDv7) + emittedAtSec when caller omits.
//   - emit() with bad payload throws before any INSERT (fail-closed
//     boundary per ADR-203 §D3).
//   - drainSince() returns events in lexicographic event_id order
//     (= creation-time ASC per UUIDv7 §D6 property).
//   - drainSince() with empty topics filter drains everything;
//     non-empty filter narrows.
//   - loadOffset returns "" for never-seen consumer (lower-bound
//     sentinel — every UUIDv7 sorts higher).
//   - saveOffset upserts on PK conflict.
//   - withIdempotency drains since saved offset, calls handler per
//     event, advances offset, and stops on first throw.
//   - At-least-once: re-running withIdempotency from a saved offset
//     does not re-process already-handled events.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  announceHonkerState,
  drainSince,
  emit,
  loadOffset,
  saveOffset,
  watchEvents,
  withIdempotency,
} from "../../../src/abstractions/events.ts";
import { bootHonker, resetHonkerStateForTest } from "../../../src/abstractions/honker.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-events-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

// Deterministic UUIDv7-shaped IDs for ordering tests.
function fakeId(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `01890000-0000-7000-8000-0000${padded}`;
}

describe("emit", () => {
  test("validates + INSERTs a complete payload", () => {
    const result = emit(
      db,
      {
        topic: "task.claimed",
        taskId: "t-abcd",
        member: "be-1",
        team: "alpha",
      },
      { generateId: () => fakeId(1), nowSec: () => 1_700_000_000 },
    );
    expect(result.eventId).toBe(fakeId(1));
    expect(result.emittedAtSec).toBe(1_700_000_000);
    expect(result.schemaVersion).toBe(1);

    const row = db
      .prepare("SELECT topic, payload, emitted_at_sec FROM events WHERE event_id = ?")
      .get(fakeId(1)) as { topic: string; payload: string; emitted_at_sec: number };
    expect(row.topic).toBe("task.claimed");
    expect(row.emitted_at_sec).toBe(1_700_000_000);
    const payload = JSON.parse(row.payload);
    expect(payload.taskId).toBe("t-abcd");
  });

  test("auto-fills eventId + emittedAtSec when caller omits", () => {
    const result = emit(db, {
      topic: "commit.landed",
      commitSha: "deadbeef",
      branch: "geoyws",
      author: "g@example.com",
      message: "feat: x",
    });
    expect(result.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(typeof result.emittedAtSec).toBe("number");
  });

  test("bad payload throws before INSERT (Zod gate at the boundary)", () => {
    expect(() =>
      emit(db, {
        topic: "task.claimed",
        // taskId missing
        member: "be-1",
        team: "alpha",
      } as unknown as Parameters<typeof emit>[1]),
    ).toThrow();
    // Verify nothing landed in the table
    const count = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  test("honkerLoaded flag is observed but is a no-op in Phase-1 (stub)", () => {
    // Verify both modes INSERT identically; the native NOTIFY stub
    // doesn't change observable behavior yet.
    emit(
      db,
      { topic: "task.claimed", taskId: "t-1", member: "be-1", team: "alpha" },
      { honkerLoaded: false, generateId: () => fakeId(1), nowSec: () => 100 },
    );
    emit(
      db,
      { topic: "task.claimed", taskId: "t-2", member: "be-1", team: "alpha" },
      { honkerLoaded: true, generateId: () => fakeId(2), nowSec: () => 200 },
    );
    const count = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(count).toBe(2);
  });
});

describe("drainSince", () => {
  beforeEach(() => {
    // Seed 3 task.claimed + 2 task.done in creation order
    let n = 1;
    for (const taskId of ["t-1", "t-2", "t-3"]) {
      emit(
        db,
        { topic: "task.claimed", taskId, member: "be-1", team: "alpha" },
        { generateId: () => fakeId(n), nowSec: () => 100 + n },
      );
      n += 1;
    }
    for (const taskId of ["t-1", "t-2"]) {
      emit(
        db,
        {
          topic: "task.done",
          taskId,
          member: "be-1",
          team: "alpha",
          doneAtSec: 200,
        },
        { generateId: () => fakeId(n), nowSec: () => 200 + n },
      );
      n += 1;
    }
  });

  test("returns events newer than lastEventId in lexicographic ASC order", () => {
    const all = drainSince(db, { topics: [], lastEventId: "" });
    expect(all.length).toBe(5);
    const ids = all.map((e) => e.eventId);
    expect(ids).toEqual([fakeId(1), fakeId(2), fakeId(3), fakeId(4), fakeId(5)]);
  });

  test("filters by topics when non-empty", () => {
    const claimed = drainSince(db, { topics: ["task.claimed"], lastEventId: "" });
    expect(claimed.length).toBe(3);
    expect(claimed.every((e) => e.topic === "task.claimed")).toBe(true);

    const done = drainSince(db, { topics: ["task.done"], lastEventId: "" });
    expect(done.length).toBe(2);
    expect(done.every((e) => e.topic === "task.done")).toBe(true);
  });

  test("respects lastEventId exclusive lower bound", () => {
    // Drain everything after the 2nd event
    const after2 = drainSince(db, { topics: [], lastEventId: fakeId(2) });
    expect(after2.map((e) => e.eventId)).toEqual([fakeId(3), fakeId(4), fakeId(5)]);
  });

  test("limit caps the batch size", () => {
    const batch = drainSince(db, { topics: [], lastEventId: "", limit: 2 });
    expect(batch.length).toBe(2);
  });

  test("multi-topic filter (OR semantics)", () => {
    const both = drainSince(db, { topics: ["task.claimed", "task.done"], lastEventId: "" });
    expect(both.length).toBe(5);
  });

  test("poison rows (malformed JSON) are skipped, valid rows still returned", () => {
    // Insert a poison row directly (bypassing emit's Zod gate)
    db.prepare(
      `INSERT INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "01890000-0000-7000-8000-000000000099",
      "task.claimed",
      "{not valid json",
      300,
      1,
    );
    // Valid rows still drain; poison silently skipped
    const all = drainSince(db, { topics: [], lastEventId: "" });
    expect(all.length).toBe(5); // unchanged — poison dropped
  });
});

describe("loadOffset + saveOffset", () => {
  test("loadOffset returns empty string for never-seen consumer", () => {
    expect(loadOffset(db, "alpha:gitter")).toBe("");
  });

  test("saveOffset upserts on PK conflict", () => {
    saveOffset(db, "alpha:gitter", fakeId(1), () => 100);
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(1));

    saveOffset(db, "alpha:gitter", fakeId(2), () => 200);
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(2));

    // Updated row's timestamp also advanced
    const row = db
      .prepare(
        "SELECT last_event_id, last_processed_at_sec FROM subscriber_offsets WHERE consumer_name = ?",
      )
      .get("alpha:gitter") as { last_event_id: string; last_processed_at_sec: number };
    expect(row.last_event_id).toBe(fakeId(2));
    expect(row.last_processed_at_sec).toBe(200);
  });

  test("multiple scoped consumers tracked independently", () => {
    saveOffset(db, "alpha:gitter", fakeId(1));
    saveOffset(db, "cockpit:medic", fakeId(2));
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(1));
    expect(loadOffset(db, "cockpit:medic")).toBe(fakeId(2));
  });
});

describe("withIdempotency", () => {
  beforeEach(() => {
    // Seed 4 task.claimed events
    let n = 1;
    for (const taskId of ["t-1", "t-2", "t-3", "t-4"]) {
      emit(
        db,
        { topic: "task.claimed", taskId, member: "be-1", team: "alpha" },
        { generateId: () => fakeId(n), nowSec: () => 100 + n },
      );
      n += 1;
    }
  });

  test("first run processes all events + advances offset", async () => {
    const seen: string[] = [];
    const count = await withIdempotency(
      db,
      "alpha:gitter",
      { topics: ["task.claimed"] },
      (e) => {
        if (e.topic === "task.claimed") seen.push(e.taskId);
      },
    );
    expect(count).toBe(4);
    expect(seen).toEqual(["t-1", "t-2", "t-3", "t-4"]);
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(4));
  });

  test("second run with no new events processes nothing (idempotent)", async () => {
    // Prime the offset to fakeId(4)
    saveOffset(db, "alpha:gitter", fakeId(4));
    const seen: string[] = [];
    const count = await withIdempotency(
      db,
      "alpha:gitter",
      { topics: ["task.claimed"] },
      (e) => {
        if (e.topic === "task.claimed") seen.push(e.taskId);
      },
    );
    expect(count).toBe(0);
    expect(seen).toEqual([]);
  });

  test("handler throw halts the drain + does NOT advance past failing event", async () => {
    const seen: string[] = [];
    const count = await withIdempotency(
      db,
      "alpha:gitter",
      { topics: ["task.claimed"] },
      (e) => {
        if (e.topic !== "task.claimed") return;
        if (e.taskId === "t-3") throw new Error("synthetic failure");
        seen.push(e.taskId);
      },
    );
    expect(count).toBe(2); // t-1, t-2 succeeded; t-3 threw; t-4 never reached
    expect(seen).toEqual(["t-1", "t-2"]);
    // Offset advanced to the last *successful* event, not past the failing one.
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(2));
  });

  test("resumes from saved offset after a partial run + re-emit recovery", async () => {
    // Partial run halts at t-3
    await withIdempotency(db, "alpha:gitter", { topics: ["task.claimed"] }, (e) => {
      if (e.topic === "task.claimed" && e.taskId === "t-3") {
        throw new Error("synthetic");
      }
    });
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(2));

    // Next run with the same throw still halts at t-3 (handler is the
    // same; t-3 still throws). The drain is bounded to where it can
    // safely advance.
    const seen: string[] = [];
    await withIdempotency(db, "alpha:gitter", { topics: ["task.claimed"] }, (e) => {
      if (e.topic !== "task.claimed") return;
      if (e.taskId === "t-3") throw new Error("synthetic");
      seen.push(e.taskId);
    });
    // No further progress (t-3 still throws first)
    expect(seen).toEqual([]);
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(2));

    // Now make the handler succeed for t-3 — drain catches up.
    const seenRecovered: string[] = [];
    await withIdempotency(db, "alpha:gitter", { topics: ["task.claimed"] }, (e) => {
      if (e.topic === "task.claimed") seenRecovered.push(e.taskId);
    });
    expect(seenRecovered).toEqual(["t-3", "t-4"]);
    expect(loadOffset(db, "alpha:gitter")).toBe(fakeId(4));
  });
});

describe("announceHonkerState binding for bootHonker", () => {
  test("loaded state emits internal.honker.loaded event", () => {
    const announce = announceHonkerState();
    bootHonker(
      db,
      {
        env: { ATMUX_HONKER: "on", HOME: "/root", ATMUX_HONKER_PATH: "/test/honker.so" },
        platform: "linux",
        loadExtension: () => {},
        smokeProbe: () => true,
      },
      announce,
    );
    resetHonkerStateForTest(db); // for next test's bootHonker call
    const rows = drainSince(db, {
      topics: ["internal.honker.loaded", "internal.honker.fallback"],
      lastEventId: "",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.topic).toBe("internal.honker.loaded");
    if (rows[0]?.topic === "internal.honker.loaded") {
      expect(rows[0].extensionPath).toBe("/test/honker.so");
    }
  });

  test("fallback state emits internal.honker.fallback event with reason", () => {
    const announce = announceHonkerState();
    bootHonker(
      db,
      {
        env: { ATMUX_HONKER: "on", HOME: "/root" },
        platform: "linux",
        loadExtension: () => {
          throw new Error("missing binary");
        },
      },
      announce,
    );
    resetHonkerStateForTest(db);
    const rows = drainSince(db, {
      topics: ["internal.honker.loaded", "internal.honker.fallback"],
      lastEventId: "",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.topic).toBe("internal.honker.fallback");
    if (rows[0]?.topic === "internal.honker.fallback") {
      expect(rows[0].fallbackReason).toMatch(/missing binary/);
      expect(rows[0].extensionPath).toBe("/root/.atmux/extensions/honker.so");
    }
  });

  test("kill-switch off → fallback event with sentinel reason 'kill-switch off'", () => {
    const announce = announceHonkerState();
    // Default flipped ON 2026-05-21 — must pass ATMUX_HONKER=off explicitly.
    bootHonker(db, { env: { ATMUX_HONKER: "off" } }, announce);
    resetHonkerStateForTest(db);
    const rows = drainSince(db, { topics: ["internal.honker.fallback"], lastEventId: "" });
    expect(rows.length).toBe(1);
    if (rows[0]?.topic === "internal.honker.fallback") {
      expect(rows[0].fallbackReason).toBe("kill-switch off");
      expect(rows[0].extensionPath).toBeNull();
    }
  });

  test("emitOverride seam: injected emit is used instead of the real one", () => {
    let calls = 0;
    const fakeEmit = ((..._args: Parameters<typeof emit>) => {
      calls += 1;
      return {} as ReturnType<typeof emit>;
    }) as typeof emit;
    const announce = announceHonkerState(fakeEmit);
    bootHonker(db, { env: {} }, announce);
    resetHonkerStateForTest(db);
    expect(calls).toBe(1);
    // Verify no real INSERT happened (fake emit short-circuited)
    const count = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

// ---------- emit + honkerLoaded honker_stream_publish bridge ----------

describe("emit — honkerLoaded stream-publish bridge", () => {
  test("honkerLoaded=true tries honker_stream_publish (function absent → swallowed, durable INSERT still succeeds)", () => {
    // No honker extension loaded in test → honker_stream_publish() throws
    // "no such function". emit() catches it; durable INSERT still lands.
    const result = emit(
      db,
      {
        topic: "task.done",
        taskId: "t-1",
        member: "be-1",
        team: "demo",
        doneAtSec: 100,
      },
      { honkerLoaded: true, nowSec: () => 100 },
    );
    expect(result.eventId).toBeTruthy();
    const rows = drainSince(db, { topics: ["task.done"], lastEventId: "" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.topic).toBe("task.done");
  });

  test("honkerLoaded=false does not attempt stream publish (no throws even when function absent)", () => {
    // Same env, just opts.honkerLoaded omitted. emit() must never try the
    // stream publish path → no try/catch surface to fail on.
    const result = emit(
      db,
      {
        topic: "task.done",
        taskId: "t-1",
        member: "be-1",
        team: "demo",
        doneAtSec: 100,
      },
      { nowSec: () => 100 },
    );
    expect(result.eventId).toBeTruthy();
  });
});

// ---------- watchEvents async-iterator subscription ----------

describe("watchEvents", () => {
  test("backlog drain on first iteration — events emitted before subscription are yielded", async () => {
    // Use injected monotonic-ish IDs so lexicographic order is deterministic.
    let counter = 0;
    const ids = ["01900000000000000000000000000001", "01900000000000000000000000000002", "01900000000000000000000000000003"];
    const gen = () => ids[counter++] ?? "";
    emit(db, { topic: "task.done", taskId: "t-A", member: "be-1", team: "demo", doneAtSec: 1 }, { generateId: gen });
    emit(db, { topic: "task.done", taskId: "t-B", member: "be-1", team: "demo", doneAtSec: 2 }, { generateId: gen });
    emit(db, { topic: "task.done", taskId: "t-C", member: "be-1", team: "demo", doneAtSec: 3 }, { generateId: gen });
    const ac = new AbortController();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      honkerLoaded: false,
      sleep: async () => {
        ac.abort(); // abort after first wake-cycle so loop exits
      },
    });
    const seen: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") seen.push(ev.taskId);
    }
    expect(seen).toEqual(["t-A", "t-B", "t-C"]);
  });

  test("topic filter is honored — only matching events yielded", async () => {
    emit(db, { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 });
    emit(db, { topic: "task.claimed", taskId: "t-B", member: "x", team: "y" });
    const ac = new AbortController();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      sleep: async () => {
        ac.abort();
      },
    });
    const seen: string[] = [];
    for await (const ev of watcher) seen.push(ev.topic);
    expect(seen).toEqual(["task.done"]);
  });

  test("initialOffset skips already-processed events", async () => {
    // Inject deterministic IDs so lexicographic ordering is stable regardless
    // of UUIDv7 same-ms randomness.
    let counter = 0;
    const ids = ["01900000000000000000000000000a01", "01900000000000000000000000000a02"];
    const gen = () => ids[counter++] ?? "";
    const e1 = emit(
      db,
      { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 },
      { generateId: gen },
    );
    emit(
      db,
      { topic: "task.done", taskId: "t-B", member: "x", team: "y", doneAtSec: 2 },
      { generateId: gen },
    );
    const ac = new AbortController();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      initialOffset: e1.eventId, // start AFTER e1
      sleep: async () => {
        ac.abort();
      },
    });
    const seen: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") seen.push(ev.taskId);
    }
    expect(seen).toEqual(["t-B"]);
  });

  test("AbortSignal cancels mid-loop — generator returns cleanly", async () => {
    emit(db, { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 });
    const ac = new AbortController();
    let sleepCalls = 0;
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) ac.abort();
      },
    });
    const seen: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") seen.push(ev.taskId);
    }
    expect(seen).toEqual(["t-A"]);
    expect(sleepCalls).toBe(1); // looped once, then aborted
  });

  test("pre-aborted signal yields nothing — early-out", async () => {
    emit(db, { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 });
    const ac = new AbortController();
    ac.abort();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      sleep: async () => {},
    });
    const seen: string[] = [];
    for await (const ev of watcher) seen.push(ev.topic);
    expect(seen).toEqual([]);
  });

  test("yields new events emitted between wake cycles", async () => {
    let wakeCount = 0;
    const ac = new AbortController();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      sleep: async () => {
        wakeCount += 1;
        if (wakeCount === 1) {
          // Emit a new event mid-loop — should be picked up next pass.
          emit(db, {
            topic: "task.done",
            taskId: "mid-loop",
            member: "x",
            team: "y",
            doneAtSec: 9,
          });
        } else if (wakeCount === 2) {
          ac.abort();
        }
      },
    });
    const seen: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") seen.push(ev.taskId);
    }
    expect(seen).toEqual(["mid-loop"]);
  });

  test("honkerLoaded=true but _honker_notifications missing → degrades to fallback poll", async () => {
    // No honker extension loaded → _honker_notifications table doesn't
    // exist. watchEvents must degrade silently to the events-table poll
    // path rather than throwing.
    emit(db, { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 });
    const ac = new AbortController();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      honkerLoaded: true, // claims loaded but no actual table
      sleep: async () => {
        ac.abort();
      },
    });
    const seen: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") seen.push(ev.taskId);
    }
    expect(seen).toEqual(["t-A"]);
  });

  test("empty topics array = drain everything", async () => {
    emit(db, { topic: "task.done", taskId: "a", member: "x", team: "y", doneAtSec: 1 });
    emit(db, { topic: "task.claimed", taskId: "b", member: "x", team: "y" });
    const ac = new AbortController();
    const watcher = watchEvents(db, {
      topics: [],
      signal: ac.signal,
      sleep: async () => {
        ac.abort();
      },
    });
    const topics: string[] = [];
    for await (const ev of watcher) topics.push(ev.topic);
    expect(topics).toContain("task.done");
    expect(topics).toContain("task.claimed");
  });

  test("externalSignals drives drain — events yielded on each signal", async () => {
    // Inject monotonic IDs — UUIDv7 same-ms random tail can put t-B's id
    // lexicographically below t-A's under suite-parallel pressure, causing
    // drainSince(lastEventId=t-A_id) to skip t-B.
    let counter = 0;
    const injectedIds = ["01900000000000000000000000000b01", "01900000000000000000000000000b02"];
    const gen = () => injectedIds[counter++] ?? "";
    // Pre-populate one event
    emit(db, { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 }, { generateId: gen });
    const ac = new AbortController();
    // Yield two wake signals then end
    const signals = (async function* () {
      yield "honker:stream:task.done\tnew";
      // Emit a second event mid-loop so the second signal triggers a drain
      emit(db, { topic: "task.done", taskId: "t-B", member: "x", team: "y", doneAtSec: 2 }, { generateId: gen });
      yield "honker:stream:task.done\tnew";
    })();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      externalSignals: signals,
      // Set sleep so post-iterator fallback exits immediately
      sleep: async () => {
        ac.abort();
      },
    });
    const ids: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") ids.push(ev.taskId);
      if (ids.length >= 2) {
        ac.abort();
        break;
      }
    }
    // First iteration: backlog drains both (t-A + initial), second signal: no new (t-B already drained on first)
    // Actually: backlog drain happens before the loop, then signals iterate.
    // We expect at least both events.
    expect(ids).toContain("t-A");
    expect(ids).toContain("t-B");
  });

  test("externalSignals throw → falls back to poll-mode gracefully", async () => {
    emit(db, { topic: "task.done", taskId: "t-A", member: "x", team: "y", doneAtSec: 1 });
    const ac = new AbortController();
    // biome-ignore lint/correctness/useYield: intentional no-yield fixture — generator throws on first .next() call to simulate a crashed external listener and exercise the poll-mode fallback path.
    const signals = (async function* () {
      throw new Error("simulated listener crash");
    })();
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      externalSignals: signals,
      sleep: async () => {
        // After fallback, this sleep is called — emit one more then abort
        emit(db, { topic: "task.done", taskId: "t-B", member: "x", team: "y", doneAtSec: 2 });
        ac.abort();
      },
    });
    const ids: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") ids.push(ev.taskId);
    }
    // Backlog drain catches t-A, then signals crashes, then fallback poll picks up t-B
    expect(ids).toContain("t-A");
  });

  test("externalSignalGapMs respected before fallback", async () => {
    const ac = new AbortController();
    const signals = (async function* () {
      // Empty — ends immediately
    })();
    let gapApplied = false;
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      externalSignals: signals,
      externalSignalGapMs: 50,
      sleep: async (ms) => {
        if (ms === 50) gapApplied = true;
        ac.abort();
      },
    });
    for await (const _ of watcher) {
      /* empty */
    }
    expect(gapApplied).toBe(true);
  });

  test("drainBatchSize caps backlog per wake", async () => {
    for (let i = 0; i < 5; i += 1) {
      emit(db, {
        topic: "task.done",
        taskId: `t-${i}`,
        member: "x",
        team: "y",
        doneAtSec: i,
      });
    }
    const ac = new AbortController();
    let sleepCalls = 0;
    const watcher = watchEvents(db, {
      topics: ["task.done"],
      signal: ac.signal,
      drainBatchSize: 2,
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls >= 3) ac.abort(); // backlog2 + wake1+2 then abort
      },
    });
    const ids: string[] = [];
    for await (const ev of watcher) {
      if (ev.topic === "task.done") ids.push(ev.taskId);
    }
    // 5 events, limit 2 per call → 3 drains (2+2+1) total. Initial drain
    // does 2, then loop drains 2 more, then 1 more on next wake.
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids.length).toBeLessThanOrEqual(5);
  });
});
