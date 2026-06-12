// Unit tests for src/core/orchd-housekeep.ts (e-12-640853f3 §S4 / ADR-254
// backfill — finding `test-orchd-housekeep-untested-destructive`).
//
// `housekeep` fires AUTOMATICALLY from Rust orchd's 24h ticker and runs
// FOUR DELETEs + a filesystem unlinkSync. Pre-ADR-254 it had 0% test
// coverage despite being daily-firing destructive code. These tests seed
// rows on BOTH sides of every cutoff (and the MIN-offset safety floor)
// and assert exact deleted-row counts, so a regression that prunes too
// much (or too little) is caught.
//
// Bottom-up check: if `housekeep` were a no-op (or deleted everything),
// every count assertion below would flip — so the answer to "would these
// pass if the feature were broken?" is NO.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EVENTS_RETENTION_SEC,
  DEFAULT_MERGER_TERMINAL_RETENTION_SEC,
  DEFAULT_OFFSETS_STALENESS_SEC,
  DEFAULT_ROTATED_LOGS_MAX_AGE_SEC,
  housekeep,
} from "../../../src/core/orchd-housekeep.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";

let scratch: string;
let db: Database;

// A fixed "now" so every cutoff math line below is exact.
const NOW = 1_800_000_000;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-housekeep-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

// ---------- seeding helpers ----------

// UUIDv7-shaped, lexicographically ordered by the numeric suffix.
function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function seedEvent(id: string, emittedAtSec: number): void {
  db.prepare(
    `INSERT INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, "task.claimed", JSON.stringify({ topic: "task.claimed" }), emittedAtSec, 1);
}

function setOffset(consumer: string, eventId: string, lastProcessedAtSec: number): void {
  db.prepare(
    `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
     VALUES (?, ?, ?)
     ON CONFLICT(consumer_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       last_processed_at_sec = excluded.last_processed_at_sec`,
  ).run(consumer, eventId, lastProcessedAtSec);
}

function seedMerger(branch: string, state: string, transitionedAt: number): void {
  db.prepare(
    `INSERT INTO merger_state (member_branch, state, transitioned_at)
     VALUES (?, ?, ?)`,
  ).run(branch, state, transitionedAt);
}

function countEvents(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}
function countOffsets(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM subscriber_offsets").get() as { n: number }).n;
}
function countMerger(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM merger_state").get() as { n: number }).n;
}

// ---------- 1. events prune ----------

describe("housekeep — events prune (DELETE 1)", () => {
  test("prunes events older than retention AND below MIN(offset); keeps the rest", async () => {
    const oldTs = NOW - DEFAULT_EVENTS_RETENTION_SEC - 1; // just past cutoff
    const youngTs = NOW - 10; // well within retention

    // Two old events (ids 1,2) + two young events (ids 9,10).
    seedEvent(fakeId(1), oldTs);
    seedEvent(fakeId(2), oldTs);
    seedEvent(fakeId(9), youngTs);
    seedEvent(fakeId(10), youngTs);

    // Slowest consumer has processed up to id 5 → MIN offset = fakeId(5).
    // Only events with event_id < fakeId(5) are prune-eligible (ids 1,2).
    setOffset("team:c1", fakeId(5), NOW);

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: ["team:c1"],
      nowSec: () => NOW,
    });

    expect(res.errors).toEqual([]);
    expect(res.eventsPruned).toBe(2); // exactly the two old, below-floor rows
    expect(countEvents()).toBe(2); // the two young rows survive
  });

  test("MIN(offset) safety floor: an OLD event AT or ABOVE the floor is NOT pruned", async () => {
    const oldTs = NOW - DEFAULT_EVENTS_RETENTION_SEC - 1;

    // id 7 is OLD (past retention) but it sits at the MIN-offset floor —
    // a consumer hasn't passed it yet, so it must survive even though old.
    seedEvent(fakeId(3), oldTs); // old + below floor → pruned
    seedEvent(fakeId(7), oldTs); // old but == floor → NOT pruned (event_id < floor is exclusive)
    seedEvent(fakeId(8), oldTs); // old but > floor → NOT pruned

    setOffset("team:c1", fakeId(7), NOW); // floor = fakeId(7)

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: ["team:c1"],
      nowSec: () => NOW,
    });

    expect(res.eventsPruned).toBe(1); // only id 3
    const survivors = db
      .prepare("SELECT event_id FROM events ORDER BY event_id ASC")
      .all() as Array<{ event_id: string }>;
    expect(survivors.map((r) => r.event_id)).toEqual([fakeId(7), fakeId(8)]);
  });

  test("no subscriber_offsets rows → events prune is skipped (no floor known)", async () => {
    const oldTs = NOW - DEFAULT_EVENTS_RETENTION_SEC - 1;
    seedEvent(fakeId(1), oldTs);
    seedEvent(fakeId(2), oldTs);
    // No setOffset → MIN(last_event_id) is NULL → DELETE 1 must NOT fire
    // (deleting "everything old" with no consumer floor risks dropping
    // events an offline consumer still needs).

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.eventsPruned).toBe(0);
    expect(countEvents()).toBe(2);
  });
});

// ---------- 2. subscriber_offsets prune ----------

describe("housekeep — subscriber_offsets prune (DELETE 2)", () => {
  test("drops stale rows whose consumer is NOT active AND is past the staleness window", async () => {
    const stale = NOW - DEFAULT_OFFSETS_STALENESS_SEC - 1; // past cutoff
    const recent = NOW - 10; // within window

    // Retired consumer, stale → DELETE.
    setOffset("team:atmux:ombudsman", fakeId(1), stale);
    // Retired consumer, but recently written → KEEP (not stale enough).
    setOffset("team:legacy-recent", fakeId(2), recent);
    // Active consumer, even if stale → KEEP (in active set).
    setOffset("team:c1", fakeId(3), stale);

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: ["team:c1"],
      nowSec: () => NOW,
    });

    expect(res.errors).toEqual([]);
    expect(res.offsetsPruned).toBe(1); // only the retired+stale row
    const survivors = db
      .prepare("SELECT consumer_name FROM subscriber_offsets ORDER BY consumer_name ASC")
      .all() as Array<{ consumer_name: string }>;
    expect(survivors.map((r) => r.consumer_name)).toEqual(["team:c1", "team:legacy-recent"]);
  });

  test("empty activeConsumerIds → prune ALL stale rows regardless of consumer name", async () => {
    const stale = NOW - DEFAULT_OFFSETS_STALENESS_SEC - 1;
    const recent = NOW - 10;

    // With NO active set, the WHERE collapses to staleness-only: every
    // row past the window is pruned (no NOT IN guard).
    setOffset("team:a", fakeId(1), stale);
    setOffset("team:b", fakeId(2), stale);
    setOffset("team:c", fakeId(3), recent); // recent → survives

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.offsetsPruned).toBe(2);
    expect(countOffsets()).toBe(1);
    const survivor = db
      .prepare("SELECT consumer_name FROM subscriber_offsets")
      .get() as { consumer_name: string };
    expect(survivor.consumer_name).toBe("team:c");
  });
});

// ---------- 3. rotated logs prune ----------

describe("housekeep — rotated logs prune (DELETE 3, unlinkSync)", () => {
  test("unlinks rotated .log.N files older than the age cutoff; leaves active + young", async () => {
    const logsDir = join(scratch, "logs");
    await mkdir(logsDir, { recursive: true });

    const oldFile = join(logsDir, "orchd.log.1"); // rotated + old → unlinked
    const youngFile = join(logsDir, "orchd.log.2"); // rotated + young → kept
    const activeFile = join(logsDir, "orchd.log"); // active (no .N) → never touched

    writeFileSync(oldFile, "old\n");
    writeFileSync(youngFile, "young\n");
    writeFileSync(activeFile, "active\n");

    // Backdate oldFile's mtime past the cutoff; youngFile stays recent.
    const oldMtimeSec = NOW - DEFAULT_ROTATED_LOGS_MAX_AGE_SEC - 100;
    const youngMtimeSec = NOW - 100;
    utimesSync(oldFile, oldMtimeSec, oldMtimeSec);
    utimesSync(youngFile, youngMtimeSec, youngMtimeSec);

    const logged: string[] = [];
    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
      log: (m) => logged.push(m),
    });

    expect(res.errors).toEqual([]);
    expect(res.rotatedLogsPruned).toBe(1);
    expect(existsSync(oldFile)).toBe(false); // pruned
    expect(existsSync(youngFile)).toBe(true); // too young
    expect(existsSync(activeFile)).toBe(true); // active file never matched
    // The prune was logged with the path.
    expect(logged.some((l) => l.includes("orchd.log.1"))).toBe(true);
  });

  test("absent logs/ dir → no-op, no error", async () => {
    // scratch has no logs/ subdir.
    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });
    expect(res.rotatedLogsPruned).toBe(0);
    expect(res.errors).toEqual([]);
  });
});

// ---------- 4. merger_state terminal prune ----------

describe("housekeep — merger_state terminal prune (DELETE 4)", () => {
  test("prunes only terminal ('merged'/'abandoned') rows older than retention", async () => {
    const old = NOW - DEFAULT_MERGER_TERMINAL_RETENTION_SEC - 1; // past cutoff
    const recent = NOW - 10;

    seedMerger("base-alice", "merged", old); // terminal + old → DELETE
    seedMerger("base-bob", "abandoned", old); // terminal + old → DELETE
    seedMerger("base-carol", "merged", recent); // terminal but recent → KEEP
    seedMerger("base-dave", "merging", old); // non-terminal (active) → KEEP even if old

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.errors).toEqual([]);
    expect(res.mergerTerminalPruned).toBe(2);
    const survivors = db
      .prepare("SELECT member_branch FROM merger_state ORDER BY member_branch ASC")
      .all() as Array<{ member_branch: string }>;
    expect(survivors.map((r) => r.member_branch)).toEqual(["base-carol", "base-dave"]);
  });
});

// ---------- defaults + overrides + aggregate ----------

describe("housekeep — defaults, overrides, and aggregate run", () => {
  test("default retention constants match the documented windows", () => {
    expect(DEFAULT_EVENTS_RETENTION_SEC).toBe(7 * 24 * 3600);
    expect(DEFAULT_OFFSETS_STALENESS_SEC).toBe(30 * 24 * 3600);
    expect(DEFAULT_ROTATED_LOGS_MAX_AGE_SEC).toBe(30 * 24 * 3600);
    expect(DEFAULT_MERGER_TERMINAL_RETENTION_SEC).toBe(30 * 24 * 3600);
  });

  test("per-window overrides are honored (tight events retention prunes a young event)", async () => {
    const ts = NOW - 100; // only 100s old
    seedEvent(fakeId(1), ts);
    setOffset("team:c1", fakeId(9), NOW); // floor above the event id

    // Override events retention to 50s → the 100s-old event is now stale.
    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: ["team:c1"],
      nowSec: () => NOW,
      eventsRetentionSec: 50,
    });

    expect(res.eventsPruned).toBe(1);
    expect(countEvents()).toBe(0);
  });

  test("a single run prunes across all four targets and reports each count", async () => {
    const oldEvt = NOW - DEFAULT_EVENTS_RETENTION_SEC - 1;
    const oldOff = NOW - DEFAULT_OFFSETS_STALENESS_SEC - 1;
    const oldMerge = NOW - DEFAULT_MERGER_TERMINAL_RETENTION_SEC - 1;

    // events: one old+below-floor (pruned), one young (kept).
    seedEvent(fakeId(1), oldEvt);
    seedEvent(fakeId(9), NOW - 10);
    setOffset("team:c1", fakeId(5), NOW); // active consumer, floor = id 5

    // offsets: a retired+stale row (pruned). team:c1 (active) survives.
    setOffset("team:retired", fakeId(2), oldOff);

    // logs: one old rotated file (pruned).
    const logsDir = join(scratch, "logs");
    await mkdir(logsDir, { recursive: true });
    const oldLog = join(logsDir, "orchd.log.5");
    writeFileSync(oldLog, "x\n");
    const oldLogMtime = NOW - DEFAULT_ROTATED_LOGS_MAX_AGE_SEC - 100;
    utimesSync(oldLog, oldLogMtime, oldLogMtime);

    // merger_state: one old terminal row (pruned).
    seedMerger("base-x", "merged", oldMerge);

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: ["team:c1"],
      nowSec: () => NOW,
    });

    expect(res.errors).toEqual([]);
    expect(res.eventsPruned).toBe(1);
    expect(res.offsetsPruned).toBe(1);
    expect(res.rotatedLogsPruned).toBe(1);
    expect(res.mergerTerminalPruned).toBe(1);

    // Post-run survivors confirm nothing over-pruned.
    expect(countEvents()).toBe(1);
    expect(countOffsets()).toBe(1); // team:c1 only
    expect(countMerger()).toBe(0);
    expect(existsSync(oldLog)).toBe(false);
  });

  test("default nowSec (wall clock) does not throw and reports clean errors", async () => {
    // No injected nowSec — exercises the `Math.floor(Date.now()/1000)`
    // default branch. Seed nothing destructive; just assert the run is
    // clean + zero-count (no rows to prune).
    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
    });
    expect(res.errors).toEqual([]);
    expect(res.eventsPruned).toBe(0);
    expect(res.offsetsPruned).toBe(0);
    expect(res.mergerTerminalPruned).toBe(0);
  });
});

// ---------- error containment (each prune is wrapped; one failure does
//            not abort the others, and the message is captured) ----------

describe("housekeep — error containment per target", () => {
  test("events-prune DELETE failure is caught + reported; later prunes still run", async () => {
    // A non-null MIN(offset) so DELETE 1 attempts the events DELETE, then
    // drop the events table so the DELETE throws → caught at the events
    // catch. The merger prune (DELETE 4) must still execute.
    setOffset("team:c1", fakeId(5), NOW);
    seedMerger("base-x", "merged", NOW - DEFAULT_MERGER_TERMINAL_RETENTION_SEC - 1);
    db.exec("DROP TABLE events");

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: ["team:c1"],
      nowSec: () => NOW,
    });

    expect(res.eventsPruned).toBe(0);
    expect(res.errors.some((e) => e.startsWith("events prune:"))).toBe(true);
    // Downstream prune ran despite the events failure.
    expect(res.mergerTerminalPruned).toBe(1);
  });

  test("offsets-prune failure is caught + reported", async () => {
    // Dropping subscriber_offsets makes both the events MIN-select and
    // the offsets DELETE throw; assert the offsets-prune error is
    // captured (the events one is too, which is acceptable — containment
    // means every wrapped block records its own failure independently).
    db.exec("DROP TABLE subscriber_offsets");

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.offsetsPruned).toBe(0);
    expect(res.errors.some((e) => e.startsWith("offsets prune:"))).toBe(true);
  });

  test("per-file log unlink failure is caught + reported (rotated entry is a directory)", async () => {
    const logsDir = join(scratch, "logs");
    await mkdir(logsDir, { recursive: true });
    // A DIRECTORY named like a rotated log: statSync succeeds (so the
    // age gate passes), but unlinkSync on a directory throws → the
    // per-file catch records the error.
    const dirLog = join(logsDir, "orchd.log.9");
    mkdirSync(dirLog);
    const oldMtime = NOW - DEFAULT_ROTATED_LOGS_MAX_AGE_SEC - 100;
    utimesSync(dirLog, oldMtime, oldMtime);

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.rotatedLogsPruned).toBe(0);
    expect(res.errors.some((e) => e.startsWith("log prune orchd.log.9:"))).toBe(true);
    // The directory was NOT removed.
    expect(existsSync(dirLog)).toBe(true);
  });

  test("logs-scan failure is caught + reported (logs path is a file, not a dir)", async () => {
    // existsSync(logsDir) is true (it's a file), but readdir on a file
    // throws ENOTDIR → the outer logs-scan catch records it.
    const logsPath = join(scratch, "logs");
    writeFileSync(logsPath, "not a directory\n");

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.rotatedLogsPruned).toBe(0);
    expect(res.errors.some((e) => e.startsWith("logs scan:"))).toBe(true);
  });

  test("merger-prune failure is caught + reported", async () => {
    db.exec("DROP TABLE merger_state");

    const res = await housekeep({
      db,
      atmuxDir: scratch,
      activeConsumerIds: [],
      nowSec: () => NOW,
    });

    expect(res.mergerTerminalPruned).toBe(0);
    expect(res.errors.some((e) => e.startsWith("merger_state prune:"))).toBe(true);
  });
});
