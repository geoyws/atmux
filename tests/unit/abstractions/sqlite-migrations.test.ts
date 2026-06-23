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
  test("opening with the full ladder advances user_version to the tail (v18)", () => {
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
    //   - v16→v17 added tasks.source_kind + tasks.source_id + the
    //             partial-unique idx_tasks_source_id for the git task
    //             source (ADR-263 §D3, P3)
    //   - v17→v18 dropped the epics / stories tables + tasks.epic /
    //             tasks.story columns + their indexes (ADR-264 — Task is
    //             the sole work unit)
    expect(readUserVersion(db)).toBe(18);
  });
});

describe("v17 → v18: drop the Epic / Story tiers (ADR-264)", () => {
  test("the epics + stories tables are gone at the ladder tail", () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).not.toContain("epics");
    expect(names).not.toContain("stories");
  });

  test("the tasks.epic + tasks.story columns are gone", () => {
    const cols = (
      db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).not.toContain("epic");
    expect(cols).not.toContain("story");
    // The git-source columns from v17 survive the drop.
    expect(cols).toContain("source_id");
  });

  test("the idx_tasks_epic + idx_tasks_story indexes are gone", () => {
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).not.toContain("idx_tasks_epic");
    expect(indexes).not.toContain("idx_tasks_story");
  });
});

describe("v16 → v17: tasks git-source provenance (ADR-263 §D3)", () => {
  test("source_kind + source_id columns exist on tasks", () => {
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
      type: string;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c.type]));
    expect(byName.get("source_kind")).toBe("TEXT");
    expect(byName.get("source_id")).toBe("TEXT");
  });

  test("a partial-unique index keys dedup on non-null source_id only", () => {
    const idx = db.prepare("PRAGMA index_list(tasks)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const dedup = idx.find((i) => i.name === "idx_tasks_source_id");
    expect(dedup).toBeDefined();
    expect(dedup?.unique).toBe(1);
    // The partial predicate is recorded in sqlite_master's CREATE INDEX SQL.
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_tasks_source_id'")
      .get() as { sql: string } | null;
    expect(ddl?.sql).toContain("WHERE source_id IS NOT NULL");
  });

  test("two non-null duplicate source_ids are rejected; many nulls allowed", () => {
    db.prepare("INSERT INTO tasks (id, source_id) VALUES ('t-1', 'github:o/r#1')").run();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, source_id) VALUES ('t-2', 'github:o/r#1')").run(),
    ).toThrow();
    // NULL source_id rows are unconstrained.
    db.prepare("INSERT INTO tasks (id) VALUES ('t-n1')").run();
    db.prepare("INSERT INTO tasks (id) VALUES ('t-n2')").run();
    const n = db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number };
    expect(n.c).toBe(3);
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
