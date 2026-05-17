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
  test("opening with the full ladder advances user_version to the tail (v8)", () => {
    // Bump this when a new migration lands. Failing here is the
    // intentional reminder to confirm the new migration's tests cover
    // the new table.
    expect(readUserVersion(db)).toBe(8);
  });
});

describe("v7 → v8: refusal_events", () => {
  test("table exists with the expected column set + types", () => {
    const cols = db
      .prepare("PRAGMA table_info(refusal_events)")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
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
    const indexes = db
      .prepare("PRAGMA index_list(refusal_events)")
      .all() as Array<{ name: string; unique: number; origin: string }>;
    const uniqueIdx = indexes.find((i) => i.unique === 1 && i.origin === "u");
    expect(uniqueIdx).toBeDefined();
    const cols = db
      .prepare(`PRAGMA index_info(${uniqueIdx?.name ?? ""})`)
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual([
      "member",
      "minute_bucket",
      "severity",
    ]);
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
    const indexes = db
      .prepare("PRAGMA index_list(refusal_events)")
      .all() as Array<{ name: string; unique: number; origin: string }>;
    const names = new Set(indexes.map((i) => i.name));
    expect(names.has("idx_refusal_events_member_detected")).toBe(true);
    expect(names.has("idx_refusal_events_severity")).toBe(true);
  });
});
