// Unit tests for src/core/events-prune.ts (T2.2 / ADR-202 §XI).
//
// All 6 AC cases (per t-c3a40f38 body):
//   1. no-op when offset stale (subscriber_offsets behind cursor)
//   2. TTL-only path (events older than ttlSec deleted; newer kept)
//   3. max-rows-only path (FIFO eviction when row count > maxRows)
//   4. both-triggered path
//   5. zero-rows-deleted (empty events table)
//   6. offsets-gate skip path with non-empty .reason
//
// Plus boundary tests for the teamName-required throw + cursor
// advance on the happy path.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { prune } from "../../../src/core/events-prune.ts";

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-events-prune-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

// Deterministic UUIDv7-shaped IDs — lexicographic order matches the
// number suffix so rowid order tracks the sequence the tests insert.
function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

/** Insert N events at the given emitted_at_sec. Returns the inserted ids. */
function seedEvents(startN: number, count: number, emittedAtSec: number): string[] {
  const ids: string[] = [];
  const stmt = db.prepare(
    `INSERT INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    const id = fakeId(startN + i);
    stmt.run(id, "task.claimed", JSON.stringify({ topic: "task.claimed" }), emittedAtSec, 1);
    ids.push(id);
  }
  return ids;
}

/** Set the consumer's last_event_id offset. */
function setOffset(consumer: string, eventId: string, nowSec = 1_700_000_000): void {
  db.prepare(
    `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
     VALUES (?, ?, ?)
     ON CONFLICT(consumer_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       last_processed_at_sec = excluded.last_processed_at_sec`,
  ).run(consumer, eventId, nowSec);
}

function countEvents(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

function readPruneState(team: string): { cursor: number; last_pruned_at_sec: number } | null {
  const row = db
    .prepare("SELECT cursor, last_pruned_at_sec FROM prune_state WHERE team_name = ?")
    .get(team) as { cursor: number; last_pruned_at_sec: number } | undefined;
  return row ?? null;
}

describe("events-prune.prune — happy paths", () => {
  test("TTL-only path: deletes events older than ttlSec within offset window", () => {
    const oldTs = 1_700_000_000;
    const newTs = 1_700_000_000 + 60 * 86400; // 60 days later

    // 5 old + 5 new events
    seedEvents(0, 5, oldTs);
    const newIds = seedEvents(5, 5, newTs);

    // Consumer has processed all 10
    setOffset("team-alpha:c1", newIds[4]!);

    const now = newTs + 86400; // 1 day after the new batch
    const res = prune(db, {
      teamName: "team-alpha",
      ttlSec: 30 * 86400,
      nowSec: () => now,
    });

    // All 5 old events should be deleted; all 5 new kept.
    expect(res.deleted).toBe(5);
    expect(res.skipped).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(countEvents()).toBe(5);

    // Cursor advanced to ceiling (rowid 10).
    const state = readPruneState("team-alpha");
    expect(state?.cursor).toBe(10);
    expect(state?.last_pruned_at_sec).toBe(now);
  });

  test("max-rows-only path: FIFO-evicts oldest when row count exceeds maxRows", () => {
    const sameTs = 1_700_000_000;
    // 10 events all "young" (TTL won't fire)
    const ids = seedEvents(0, 10, sameTs);
    setOffset("team-alpha:c1", ids[9]!);

    const res = prune(db, {
      teamName: "team-alpha",
      ttlSec: 30 * 86400,
      maxRows: 3,
      nowSec: () => sameTs + 1,
    });

    // 10 → 3: 7 deleted.
    expect(res.deleted).toBe(7);
    expect(res.skipped).toBe(0);
    expect(countEvents()).toBe(3);

    // The 3 surviving rows are the newest (rowids 8-10).
    const surviving = db.prepare("SELECT rowid FROM events ORDER BY rowid ASC").all() as Array<{
      rowid: number;
    }>;
    expect(surviving.map((r) => r.rowid)).toEqual([8, 9, 10]);
  });

  test("both-triggered path: TTL prune followed by max-rows soft-cap", () => {
    const oldTs = 1_700_000_000;
    const newTs = 1_700_000_000 + 60 * 86400;

    // 4 old + 8 new
    seedEvents(0, 4, oldTs);
    const newIds = seedEvents(4, 8, newTs);
    setOffset("team-alpha:c1", newIds[7]!);

    const now = newTs + 86400;
    const res = prune(db, {
      teamName: "team-alpha",
      ttlSec: 30 * 86400,
      maxRows: 5,
      nowSec: () => now,
    });

    // TTL: 4 old gone → 8 remain. MaxRows 5: 3 more evicted → 5 remain.
    expect(res.deleted).toBe(7);
    expect(res.skipped).toBe(0);
    expect(countEvents()).toBe(5);

    // Surviving rowids are 8-12 (the 5 newest).
    const surviving = db.prepare("SELECT rowid FROM events ORDER BY rowid ASC").all() as Array<{
      rowid: number;
    }>;
    expect(surviving.map((r) => r.rowid)).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("events-prune.prune — gated paths", () => {
  test("no-op when offset stale: cursor already at the slowest consumer's offset", () => {
    const ts = 1_700_000_000;
    const ids = seedEvents(0, 5, ts);
    setOffset("team-alpha:c1", ids[2]!); // rowid 3

    // First prune: advances cursor to 3.
    const first = prune(db, { teamName: "team-alpha", nowSec: () => ts + 1 });
    expect(first.deleted).toBe(0); // no TTL/maxRows trigger (default ttlSec is 30d)
    expect(readPruneState("team-alpha")?.cursor).toBe(3);

    // Second prune: consumer hasn't advanced → ceiling = floor → skip.
    const second = prune(db, { teamName: "team-alpha", nowSec: () => ts + 2 });
    expect(second.deleted).toBe(0);
    expect(second.reason).toContain("offsets stale");
    expect(second.skipped).toBe(3); // 3 events with rowid <= floor
  });

  test("offsets-gate skip path with non-empty .reason: no consumers registered", () => {
    const ts = 1_700_000_000;
    seedEvents(0, 3, ts);
    // No setOffset calls → subscriber_offsets is empty.

    const res = prune(db, { teamName: "team-alpha", nowSec: () => ts + 1 });
    expect(res.deleted).toBe(0);
    expect(res.reason).toBeDefined();
    expect(res.reason!.length).toBeGreaterThan(0);
    // No prune_state row is written on the skip path.
    expect(readPruneState("team-alpha")).toBeNull();
  });

  test("zero-rows-deleted (empty events table): skip path with no work to do", () => {
    // No seedEvents, no setOffset.
    const res = prune(db, { teamName: "team-alpha", nowSec: () => 1_700_000_000 });
    expect(res.deleted).toBe(0);
    expect(res.skipped).toBe(0);
    // Empty offsets table → skip path fires → reason populated.
    expect(res.reason).toBeDefined();
    expect(countEvents()).toBe(0);
  });
});

describe("events-prune.prune — boundary + slowest-consumer behaviour", () => {
  test("throws when teamName missing — caller-side responsibility", () => {
    expect(() => prune(db)).toThrow(/teamName is required/);
    expect(() => prune(db, {})).toThrow(/teamName is required/);
  });

  test("default nowSec uses wall-clock — TTL evaluates against real time", () => {
    // Seed events 60 days before "now" (real wall clock).
    const nowReal = Math.floor(Date.now() / 1000);
    const oldTs = nowReal - 60 * 86400;
    const ids = seedEvents(0, 3, oldTs);
    setOffset("team-alpha:c1", ids[2]!);

    // No nowSec injected → default `() => Math.floor(Date.now() / 1000)` fires.
    const res = prune(db, { teamName: "team-alpha", ttlSec: 30 * 86400 });

    expect(res.deleted).toBe(3);
    expect(readPruneState("team-alpha")?.last_pruned_at_sec).toBeGreaterThanOrEqual(nowReal);
  });

  test("multiple consumers: slowest one defines the ceiling", () => {
    const ts = 1_700_000_000;
    const ids = seedEvents(0, 10, ts - 60 * 86400); // events 60 days old

    // c1 has read up to event 7 (rowid 8); c2 only up to event 2 (rowid 3).
    setOffset("team-alpha:c1", ids[7]!);
    setOffset("team-alpha:c2", ids[2]!);

    const res = prune(db, {
      teamName: "team-alpha",
      ttlSec: 30 * 86400,
      nowSec: () => ts,
    });

    // Ceiling = rowid of MIN(last_event_id) = ids[2] = rowid 3.
    // TTL eligible: rowids 1-3 (all old).
    expect(res.deleted).toBe(3);
    expect(countEvents()).toBe(7);
    expect(readPruneState("team-alpha")?.cursor).toBe(3);
  });

  test("cursor persists across calls: second call uses updated floor", () => {
    const oldTs = 1_700_000_000;
    const newTs = oldTs + 60 * 86400;
    seedEvents(0, 5, oldTs);
    const newIds = seedEvents(5, 5, newTs);
    setOffset("team-alpha:c1", newIds[4]!);

    // Call 1: prune old, advance cursor to 10.
    const first = prune(db, {
      teamName: "team-alpha",
      ttlSec: 30 * 86400,
      nowSec: () => newTs + 86400,
    });
    expect(first.deleted).toBe(5);
    expect(readPruneState("team-alpha")?.cursor).toBe(10);

    // Call 2: no new events, no consumer advance → skip path with floor=10.
    const second = prune(db, {
      teamName: "team-alpha",
      ttlSec: 30 * 86400,
      nowSec: () => newTs + 2 * 86400,
    });
    expect(second.deleted).toBe(0);
    expect(second.reason).toContain("offsets stale");
  });
});
