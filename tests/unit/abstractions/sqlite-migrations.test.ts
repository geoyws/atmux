// Unit tests for the live `migrations` ladder in
// src/abstractions/sqlite-migrations.ts. Most migration assertions live
// in the consuming-module tests (`complaints.test.ts`, etc.), but the
// v7→v8 `refusal_events` ladder is tested here directly so future
// edits to that table's shape have a single failing test surface.
// (Renumbered from v6→v7 at merge time — see migration body for context.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  type Database,
  openDatabase,
  readUserVersion,
} from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-migrations-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

describe("sqlite-migrations live ladder", () => {
  test("opening with the full ladder advances user_version to the tail (v17)", () => {
    // Bump this when a new migration lands. Failing here is the
    // intentional reminder to confirm the new migration's tests cover
    // the new table or column.
    //   - v8→v9  added merger_state.test_outcome (ADR-144 T2, t-49bd4fe1)
    //   - v9→v10 added stories.merge_mode (ADR-175 GAP 2, t-aacb8664)
    //   - v10→v11 added events + subscriber_offsets tables (ADR-202
    //             §D1 Honker substrate + ADR-203 §D7 idempotency)
    //   - v11→v12 added id_sequences for running-number IDs (ADR-202
    //             §VIII compound `<scope>-<N>-<hash>` shape)
    //   - v12→v13 added prune_state for events-prune cursor bookkeeping
    //             (ADR-202 §XI queued via T2.2, t-0d79d5bd)
    //   - v13→v14 added epics.depends_on + epics.is_ready (ADR-225,
    //             master task t-802c468b, EPIC e-cf8a6195)
    //   - v14→v15 added spawn_queue for orchd refuse-then-queue path
    //             (ADR-228 §D2, t-095190f8) — renumbered from v13→v14
    //             at fan-in 2026-05-23 per ADR-091 §pre-flag #4
    //   - v15→v16 added epics.spawned_at for orchd auto-spawn dedup gate
    //             (ADR-231 §D2, t-6-8db78adf) — renumbered from v14→v15
    //             at impl time since v14→v15 was claimed by ADR-228
    //   - v16→v17 added issue_sync + issue_sync_cursor for the ADR-261
    //             §D4 ledger (issue-sync external tracker ingestion);
    //             shape tests live in
    //             tests/unit/core/repositories/issue-sync-repo.test.ts
    expect(readUserVersion(db)).toBe(17);
  });
});

describe("v7 → v8: refusal_events", () => {
  test("table exists with the expected column set + types", () => {
    const cols = db.prepare("PRAGMA table_info(refusal_events)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    // Every column from the migration body is present.
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["id", "TEXT"],
      ["member", "TEXT"],
      ["team", "TEXT"],
      ["phrases", "TEXT"],
      ["severity", "TEXT"],
      ["confidence", "REAL"],
      ["detected_at", "INTEGER"],
      ["minute_bucket", "INTEGER"],
    ];
    for (const [name, type] of expected) {
      const c = byName.get(name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
    }
    expect(cols).toHaveLength(expected.length);

    // `id` is PK; every other column NOT NULL per the schema body.
    expect(byName.get("id")?.pk).toBe(1);
    for (const name of [
      "member",
      "team",
      "phrases",
      "severity",
      "confidence",
      "detected_at",
      "minute_bucket",
    ]) {
      expect(byName.get(name)?.notnull).toBe(1);
    }
  });

  test("UNIQUE(member, minute_bucket, severity) constraint is in place", () => {
    const indexes = db.prepare("PRAGMA index_list(refusal_events)").all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    const uniqueIdx = indexes.find((i) => i.unique === 1 && i.origin === "u");
    expect(uniqueIdx).toBeDefined();
    const cols = db.prepare(`PRAGMA index_info(${uniqueIdx?.name ?? ""})`).all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name).sort()).toEqual(["member", "minute_bucket", "severity"]);
  });

  test("phrases column rejects non-JSON values via the CHECK constraint", () => {
    // Inserting a literal string (not valid JSON) must fail the
    // `CHECK(json_valid(phrases))` clause. SQLite reports the error as
    // a constraint failure, not a type error.
    expect(() => {
      db.prepare(
        `INSERT INTO refusal_events
           (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("r-1", "alice", "demo", "not-json", "soft", 0.5, 1000, 16);
    }).toThrow();
  });

  test("valid JSON phrases value inserts cleanly + round-trips", () => {
    const phrases = JSON.stringify([
      { phrase: "fatigue", class: "soft" },
      { phrase: "rotate-me", class: "role" },
    ]);
    db.prepare(
      `INSERT INTO refusal_events
         (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("r-2", "alice", "demo", phrases, "role", 0.95, 2000, 33);
    const row = db
      .prepare("SELECT phrases, severity, confidence FROM refusal_events WHERE id = ?")
      .get("r-2") as { phrases: string; severity: string; confidence: number };
    expect(row.severity).toBe("role");
    expect(row.confidence).toBeCloseTo(0.95, 5);
    const parsed = JSON.parse(row.phrases) as Array<{ phrase: string; class: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ phrase: "fatigue", class: "soft" });
  });

  test("INSERT OR IGNORE on duplicate (member, minute_bucket, severity) leaves one row", () => {
    const phrasesA = JSON.stringify([{ phrase: "fatigue", class: "soft" }]);
    const phrasesB = JSON.stringify([{ phrase: "tired-of", class: "soft" }]);
    // First insert lands.
    const r1 = db
      .prepare(
        `INSERT OR IGNORE INTO refusal_events
           (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("r-3", "bob", "demo", phrasesA, "soft", 0.5, 3000, 50);
    expect(r1.changes).toBe(1);
    // Second insert at the same (member, minute_bucket, severity) is
    // silently dropped — `changes === 0`.
    const r2 = db
      .prepare(
        `INSERT OR IGNORE INTO refusal_events
           (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("r-4", "bob", "demo", phrasesB, "soft", 0.6, 3010, 50);
    expect(r2.changes).toBe(0);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM refusal_events WHERE member = ?")
      .get("bob") as { n: number };
    expect(count.n).toBe(1);
  });

  test("different severities at the same minute_bucket land as separate rows", () => {
    const ph = JSON.stringify([{ phrase: "x", class: "soft" }]);
    db.prepare(
      `INSERT INTO refusal_events
         (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("r-5", "carol", "demo", ph, "soft", 0.5, 4000, 66);
    db.prepare(
      `INSERT INTO refusal_events
         (id, member, team, phrases, severity, confidence, detected_at, minute_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("r-6", "carol", "demo", ph, "hard", 0.8, 4000, 66);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM refusal_events WHERE member = ?")
      .get("carol") as { n: number };
    expect(count.n).toBe(2);
  });

  test("indexes for the threshold-window + severity scan are present", () => {
    const indexes = db.prepare("PRAGMA index_list(refusal_events)").all() as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_refusal_events_member_detected")).toBe(true);
    expect(names.has("idx_refusal_events_severity")).toBe(true);
  });
});

describe("v10 → v11: events + subscriber_offsets (Honker substrate)", () => {
  test("events table exists with the expected column set + types", () => {
    const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    const expected: ReadonlyArray<readonly [string, string]> = [
      ["event_id", "TEXT"],
      ["topic", "TEXT"],
      ["payload", "TEXT"],
      ["emitted_at_sec", "INTEGER"],
      ["schema_version", "INTEGER"],
    ];
    for (const [name, type] of expected) {
      const c = byName.get(name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
    }
    expect(cols).toHaveLength(expected.length);

    // `event_id` is PK; topic/payload/emitted_at_sec NOT NULL per ADR-203 §D3
    // (the discriminator + payload + windowing-clock are all required).
    expect(byName.get("event_id")?.pk).toBe(1);
    expect(byName.get("topic")?.notnull).toBe(1);
    expect(byName.get("payload")?.notnull).toBe(1);
    expect(byName.get("emitted_at_sec")?.notnull).toBe(1);
    expect(byName.get("schema_version")?.notnull).toBe(1);
  });

  test("events table accepts a row with a UUIDv7 event_id + JSON payload", () => {
    // Use a fixed UUIDv7-shaped id — `1` version-nibble, `8` variant-nibble.
    db.prepare(
      `INSERT INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "01890000-0000-7000-8000-000000000001",
      "task.claimed",
      JSON.stringify({ topic: "task.claimed", taskId: "t-abcd1234", member: "be-1" }),
      1_700_000_000,
      1,
    );
    const row = db
      .prepare("SELECT topic, schema_version FROM events WHERE event_id = ?")
      .get("01890000-0000-7000-8000-000000000001") as
      | { topic: string; schema_version: number }
      | undefined;
    expect(row?.topic).toBe("task.claimed");
    expect(row?.schema_version).toBe(1);
  });

  test("events_topic_id index supports topic-filtered streaming queries", () => {
    const indexes = db.prepare("PRAGMA index_list(events)").all() as Array<{
      name: string;
      origin: string;
    }>;
    const idx = indexes.find((i) => i.name === "events_topic_id");
    expect(idx).toBeDefined();
    expect(idx?.origin).toBe("c"); // created by CREATE INDEX (not autoindex)

    const cols = db.prepare("PRAGMA index_info(events_topic_id)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toEqual(["topic", "event_id"]);
  });

  test("subscriber_offsets table exists with the expected shape", () => {
    const cols = db.prepare("PRAGMA table_info(subscriber_offsets)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    const expected: ReadonlyArray<readonly [string, string]> = [
      ["consumer_name", "TEXT"],
      ["last_event_id", "TEXT"],
      ["last_processed_at_sec", "INTEGER"],
    ];
    for (const [name, type] of expected) {
      const c = byName.get(name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
    }
    expect(cols).toHaveLength(expected.length);

    expect(byName.get("consumer_name")?.pk).toBe(1);
    expect(byName.get("last_event_id")?.notnull).toBe(1);
    expect(byName.get("last_processed_at_sec")?.notnull).toBe(1);
  });

  test("subscriber_offsets supports the scope-qualified consumer-name pattern (ADR-203 §D7)", () => {
    // Per ADR-203 §D7: `<team>:<consumer>` for team scope,
    // `cockpit:<consumer>` for cockpit scope. TEXT column accepts both.
    db.prepare(
      `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
       VALUES (?, ?, ?)`,
    ).run("team-alpha:gitter", "01890000-0000-7000-8000-000000000001", 1_700_000_000);
    db.prepare(
      `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
       VALUES (?, ?, ?)`,
    ).run("cockpit:medic", "01890000-0000-7000-8000-000000000002", 1_700_000_001);

    const rows = db
      .prepare("SELECT consumer_name FROM subscriber_offsets ORDER BY consumer_name")
      .all() as Array<{ consumer_name: string }>;
    expect(rows.map((r) => r.consumer_name)).toEqual(["cockpit:medic", "team-alpha:gitter"]);
  });

  test("subscriber_offsets enforces uniqueness on consumer_name (PK)", () => {
    db.prepare(
      `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
       VALUES (?, ?, ?)`,
    ).run("team-alpha:gitter", "01890000-0000-7000-8000-000000000003", 1_700_000_002);

    expect(() =>
      db
        .prepare(
          `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
           VALUES (?, ?, ?)`,
        )
        .run("team-alpha:gitter", "01890000-0000-7000-8000-000000000004", 1_700_000_003),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });
});

describe("v13 → v14: epics.depends_on + epics.is_ready (ADR-225)", () => {
  test("both columns exist on the epics table with the expected types + defaults", () => {
    const cols = db.prepare("PRAGMA table_info(epics)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    const dep = byName.get("depends_on");
    expect(dep).toBeDefined();
    expect(dep?.type).toBe("TEXT");
    expect(dep?.notnull).toBe(1);
    // SQLite stores the literal default with the source-text quoting.
    expect(dep?.dflt_value).toBe("'[]'");

    const ready = byName.get("is_ready");
    expect(ready).toBeDefined();
    expect(ready?.type).toBe("INTEGER");
    expect(ready?.notnull).toBe(1);
    expect(ready?.dflt_value).toBe("0");
  });

  test("new epic rows inherit the column defaults (depends_on='[]', is_ready=0)", () => {
    db.prepare(
      `INSERT INTO epics (id, title, body, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("e-fresh", "fresh epic", "body", "planning", 1_700_000_000);
    const row = db
      .prepare("SELECT depends_on, is_ready FROM epics WHERE id = ?")
      .get("e-fresh") as { depends_on: string; is_ready: number };
    expect(row.depends_on).toBe("[]");
    expect(row.is_ready).toBe(0);
  });

  test("depends_on round-trips a JSON-array of epic ids", () => {
    db.prepare(
      `INSERT INTO epics (id, title, status, depends_on, is_ready, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "e-chain",
      "downstream",
      "planning",
      JSON.stringify(["e-up1", "e-up2"]),
      0,
      1_700_000_001,
    );
    const row = db.prepare("SELECT depends_on FROM epics WHERE id = ?").get("e-chain") as {
      depends_on: string;
    };
    expect(JSON.parse(row.depends_on)).toEqual(["e-up1", "e-up2"]);
  });
});

describe("v13 → v14: backfill semantics on a pre-existing v13 DB", () => {
  // Pre-existing v13 DBs (already on trunk after Epic B's prune_state
  // migration) must have their epics rows correctly backfilled when
  // they walk through v13→v14: in-flight + done epics flip to
  // is_ready=1; draft (planning / ready) rows stay at 0. depends_on
  // backfills to '[]' for every row via the column default.
  //
  // We synthesize the pre-v14 shape by opening a DB with the ladder
  // truncated at v13, seeding rows in mixed statuses, closing, then
  // re-opening with the full ladder so v13→v14 fires on top.
  test("backfill: in-flight + done flip to is_ready=1; drafts stay at 0; all get depends_on='[]'", async () => {
    const pre14 = migrations.filter((m) => m.to <= 13);
    const path = join(scratch, "backfill.db");

    // Stage 1: walk to v13 and seed mixed-status rows.
    const staging = openDatabase(path, pre14);
    expect(readUserVersion(staging)).toBe(13);
    const rowsByStatus: ReadonlyArray<readonly [string, string]> = [
      ["e-plan", "planning"],
      ["e-ready", "ready"],
      ["e-flight", "in-progress"],
      ["e-rev", "review"],
      ["e-done", "done"],
    ];
    for (const [id, status] of rowsByStatus) {
      staging
        .prepare(`INSERT INTO epics (id, title, status, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, `${id} title`, status, 1_700_000_000);
    }
    closeDatabase(staging);

    // Stage 2: re-open with the full ladder; v13→v14 runs (along with
    // every later step — the ladder is forward-only). user_version
    // settles at the tail; v13→v14 backfill semantics still apply to
    // the rows seeded above since the column-set is additive.
    const full = openDatabase(path, migrations);
    expect(readUserVersion(full)).toBe(17);

    const seen = full
      .prepare("SELECT id, status, depends_on, is_ready FROM epics ORDER BY id")
      .all() as Array<{
      id: string;
      status: string;
      depends_on: string;
      is_ready: number;
    }>;
    const byId = new Map(seen.map((r) => [r.id, r]));

    // Drafts stay at 0.
    expect(byId.get("e-plan")?.is_ready).toBe(0);
    expect(byId.get("e-ready")?.is_ready).toBe(0);
    // In-flight + review + done flip to 1.
    expect(byId.get("e-flight")?.is_ready).toBe(1);
    expect(byId.get("e-rev")?.is_ready).toBe(1);
    expect(byId.get("e-done")?.is_ready).toBe(1);
    // depends_on backfills to '[]' for every row via the column default.
    for (const r of seen) {
      expect(r.depends_on).toBe("[]");
    }

    closeDatabase(full);
  });
});

describe("v12 → v13: prune_state (events-prune cursor bookkeeping)", () => {
  test("prune_state table exists with the expected column set + types", () => {
    const cols = db.prepare("PRAGMA table_info(prune_state)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));

    const expected: ReadonlyArray<readonly [string, string]> = [
      ["team_name", "TEXT"],
      ["cursor", "INTEGER"],
      ["last_pruned_at_sec", "INTEGER"],
    ];
    for (const [name, type] of expected) {
      const c = byName.get(name);
      expect(c).toBeDefined();
      expect(c?.type).toBe(type);
    }
    expect(cols).toHaveLength(expected.length);

    // `team_name` is PK; cursor + last_pruned_at_sec are NOT NULL with
    // DEFAULT 0 per ADR-202 §XI (queued via T2.2).
    expect(byName.get("team_name")?.pk).toBe(1);
    expect(byName.get("cursor")?.notnull).toBe(1);
    expect(byName.get("cursor")?.dflt_value).toBe("0");
    expect(byName.get("last_pruned_at_sec")?.notnull).toBe(1);
    expect(byName.get("last_pruned_at_sec")?.dflt_value).toBe("0");
  });

  test("prune_state starts empty on a fresh ladder", () => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM prune_state").get() as { n: number };
    expect(n).toBe(0);
  });

  test("prune_state accepts a row with the defaults applied", () => {
    db.prepare("INSERT INTO prune_state (team_name) VALUES (?)").run("team-alpha");
    const row = db
      .prepare("SELECT team_name, cursor, last_pruned_at_sec FROM prune_state WHERE team_name = ?")
      .get("team-alpha") as
      | { team_name: string; cursor: number; last_pruned_at_sec: number }
      | undefined;
    expect(row?.team_name).toBe("team-alpha");
    expect(row?.cursor).toBe(0);
    expect(row?.last_pruned_at_sec).toBe(0);
  });

  test("prune_state enforces uniqueness on team_name (PK)", () => {
    db.prepare(
      `INSERT INTO prune_state (team_name, cursor, last_pruned_at_sec) VALUES (?, ?, ?)`,
    ).run("team-beta", 42, 1_700_000_000);

    expect(() =>
      db
        .prepare(`INSERT INTO prune_state (team_name, cursor, last_pruned_at_sec) VALUES (?, ?, ?)`)
        .run("team-beta", 99, 1_700_000_001),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });
});

// ---------- v14 → v15 — spawn_queue (ADR-228 §D2) ----------
// Renumbered from v13→v14 at fan-in 2026-05-23 per ADR-091 §pre-flag
// #4 — sibling EPIC e-cf8a6195 (ADR-225 epic-deps) landed v13→v14
// first.

describe("v14 → v15: spawn_queue (ADR-228 §D2, t-095190f8)", () => {
  test("spawn_queue table exists with the expected column set + types", () => {
    const cols = db.prepare("PRAGMA table_info(spawn_queue)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("queue_id")?.type).toBe("TEXT");
    expect(byName.get("queue_id")?.pk).toBe(1);
    expect(byName.get("queue_id")?.notnull).toBe(1);
    expect(byName.get("epic_id")?.type).toBe("TEXT");
    expect(byName.get("epic_id")?.notnull).toBe(1);
    expect(byName.get("spawn_args")?.type).toBe("TEXT");
    expect(byName.get("spawn_args")?.notnull).toBe(1);
    expect(byName.get("queued_at_sec")?.type).toBe("INTEGER");
    expect(byName.get("queued_at_sec")?.notnull).toBe(1);
    expect(byName.get("queued_by")?.type).toBe("TEXT");
    expect(byName.get("queued_by")?.notnull).toBe(1);
    expect(byName.get("priority")?.type).toBe("INTEGER");
    expect(byName.get("priority")?.dflt_value).toBe("5");
    expect(byName.get("attempts")?.type).toBe("INTEGER");
    expect(byName.get("attempts")?.dflt_value).toBe("0");
    expect(byName.get("last_attempt_at_sec")?.type).toBe("INTEGER");
    expect(byName.get("last_attempt_at_sec")?.notnull).toBe(0); // nullable
    expect(byName.get("last_failure_reason")?.type).toBe("TEXT");
    expect(byName.get("last_failure_reason")?.notnull).toBe(0); // nullable
    expect(byName.get("state")?.type).toBe("TEXT");
    expect(byName.get("state")?.dflt_value).toBe("'queued'");
  });

  test("idx_spawn_queue_priority_queued index covers (state, priority, queued_at_sec)", () => {
    const indexes = db.prepare("PRAGMA index_list(spawn_queue)").all() as Array<{
      name: string;
    }>;
    expect(indexes.some((i) => i.name === "idx_spawn_queue_priority_queued")).toBe(true);

    const indexCols = db
      .prepare("PRAGMA index_info(idx_spawn_queue_priority_queued)")
      .all() as Array<{ seqno: number; cid: number; name: string }>;
    const colNames = indexCols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
    expect(colNames).toEqual(["state", "priority", "queued_at_sec"]);
  });

  test("spawn_queue accepts a row with defaults applied", () => {
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "q-abc12345",
      "e-deadbeef",
      '["spawn-epic","e-deadbeef","--from","atmux"]',
      1_700_000_000,
      "be-1",
    );

    const row = db.prepare("SELECT * FROM spawn_queue WHERE queue_id = ?").get("q-abc12345") as {
      queue_id: string;
      epic_id: string;
      spawn_args: string;
      queued_at_sec: number;
      queued_by: string;
      priority: number;
      attempts: number;
      last_attempt_at_sec: number | null;
      last_failure_reason: string | null;
      state: string;
    };
    expect(row.queue_id).toBe("q-abc12345");
    expect(row.epic_id).toBe("e-deadbeef");
    expect(row.priority).toBe(5); // default
    expect(row.attempts).toBe(0); // default
    expect(row.last_attempt_at_sec).toBeNull();
    expect(row.last_failure_reason).toBeNull();
    expect(row.state).toBe("queued"); // default
  });

  test("spawn_queue.state CHECK constraint rejects unknown values", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, state)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("q-bogus", "e-x", "[]", 0, "be-1", "DRAINING"),
    ).toThrow(/CHECK constraint failed/);
  });

  test("spawn_queue.state accepts each valid state literal", () => {
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q-q", "e-1", "[]", 1, "be-1", "queued");
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q-s", "e-1", "[]", 1, "be-1", "spawning");
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q-a", "e-1", "[]", 1, "be-1", "abandoned");

    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM spawn_queue WHERE state IN ('queued','spawning','abandoned')",
      )
      .get() as { n: number };
    expect(count.n).toBe(3);
  });

  test("queue_id is the primary key (rejects duplicate)", () => {
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by) VALUES (?, ?, ?, ?, ?)`,
    ).run("q-dup", "e-1", "[]", 1, "be-1");

    expect(() =>
      db
        .prepare(
          `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("q-dup", "e-2", "[]", 2, "be-1"),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  test("spawn_queue accepts overrides for priority + attempts", () => {
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, priority, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("q-high", "e-urgent", "[]", 0, "driver", 1, 3);

    const row = db
      .prepare("SELECT priority, attempts FROM spawn_queue WHERE queue_id = ?")
      .get("q-high") as {
      priority: number;
      attempts: number;
    };
    expect(row.priority).toBe(1);
    expect(row.attempts).toBe(3);
  });

  test("admit-tick query `WHERE state='queued' ORDER BY priority, queued_at_sec` uses the composite index", () => {
    // Seed two queued rows + one spawning row at different priorities.
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, priority) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q-a", "e-a", "[]", 100, "be-1", 5);
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, priority) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q-b", "e-b", "[]", 50, "be-1", 1);
    db.prepare(
      `INSERT INTO spawn_queue (queue_id, epic_id, spawn_args, queued_at_sec, queued_by, priority, state) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("q-spawning", "e-x", "[]", 0, "be-1", 1, "spawning");

    const rows = db
      .prepare(
        `SELECT queue_id, priority FROM spawn_queue
         WHERE state = 'queued' ORDER BY priority, queued_at_sec`,
      )
      .all() as Array<{ queue_id: string; priority: number }>;
    // q-b (priority 1) before q-a (priority 5); spawning row excluded.
    expect(rows.map((r) => r.queue_id)).toEqual(["q-b", "q-a"]);
  });
});

// ---------- v15 → v16 — epics.spawned_at (ADR-231 §D2) ----------
// Renumbered from v14→v15 at impl time (t-6-8db78adf) per ADR-126
// §single-ladder append-only invariant — sibling EPIC e-a946af69's
// ADR-228 spawn_queue migration claimed v14→v15 at fan-in 8d75360.

describe("v15 → v16: epics.spawned_at (ADR-231 §D2, t-6-8db78adf)", () => {
  test("epics.spawned_at column exists with INTEGER type, nullable, no default", () => {
    const cols = db.prepare("PRAGMA table_info(epics)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    const col = byName.get("spawned_at");
    expect(col).toBeDefined();
    expect(col?.type).toBe("INTEGER");
    // Nullable — orchd dedup-gate uses `IS NOT NULL` predicate, so the
    // column must accept NULL as the "not yet spawned" state.
    expect(col?.notnull).toBe(0);
    // No DEFAULT — existing rows get NULL post-migration, matching
    // the historical reality that orchd hadn't spawned any of them.
    expect(col?.dflt_value).toBeNull();
  });

  test("epics row inserted without spawned_at defaults to NULL", () => {
    db.prepare(
      `INSERT INTO epics (id, title, status, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run("e-fresh", "fresh epic", "todo", 1_700_000_000);
    const row = db.prepare("SELECT spawned_at FROM epics WHERE id = ?").get("e-fresh") as {
      spawned_at: number | null;
    };
    expect(row.spawned_at).toBeNull();
  });

  test("epics.spawned_at accepts a Unix-epoch INTEGER value (operator backfill path)", () => {
    db.prepare(
      `INSERT INTO epics (id, title, status, created_at, spawned_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("e-spawned", "live epic", "in-progress", 1_700_000_000, 1_700_001_234);
    const row = db.prepare("SELECT spawned_at FROM epics WHERE id = ?").get("e-spawned") as {
      spawned_at: number | null;
    };
    expect(row.spawned_at).toBe(1_700_001_234);
  });

  test("dedup-gate predicate `spawned_at IS NOT NULL` partitions correctly", () => {
    db.prepare(`INSERT INTO epics (id, status, created_at) VALUES (?, ?, ?)`).run(
      "e-pending",
      "todo",
      1,
    );
    db.prepare(`INSERT INTO epics (id, status, created_at, spawned_at) VALUES (?, ?, ?, ?)`).run(
      "e-live",
      "in-progress",
      1,
      1_700_000_500,
    );
    const skipped = db.prepare(`SELECT id FROM epics WHERE spawned_at IS NOT NULL`).all() as Array<{
      id: string;
    }>;
    const eligible = db.prepare(`SELECT id FROM epics WHERE spawned_at IS NULL`).all() as Array<{
      id: string;
    }>;
    expect(skipped.map((r) => r.id)).toEqual(["e-live"]);
    expect(eligible.map((r) => r.id)).toEqual(["e-pending"]);
  });
});
