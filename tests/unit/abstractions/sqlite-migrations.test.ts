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
  test("opening with the full ladder advances user_version to the tail (v14)", () => {
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
    expect(readUserVersion(db)).toBe(14);
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

    // Stage 2: re-open with the full ladder; v13→v14 runs.
    const full = openDatabase(path, migrations);
    expect(readUserVersion(full)).toBe(14);

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
