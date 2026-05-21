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
  drainSince,
  emit,
  loadOffset,
  saveOffset,
  withIdempotency,
} from "../../../src/abstractions/events.ts";
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
