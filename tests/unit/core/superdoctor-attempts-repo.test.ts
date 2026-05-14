// Unit tests for src/core/repositories/superdoctor-attempts-repo.ts and
// the migration that materialises the `superdoctor_attempts` table
// (ADR-077 §F6). Originally v2→v3; renumbered to v3→v4 at the
// 2026-05-14 trunk-merge when complaints-provenance (t-e5e5d576)
// claimed v3 first.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { SuperdoctorAttemptsRepo } from "../../../src/core/repositories/superdoctor-attempts-repo.ts";

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-sd-attempts-"));
  dbPath = join(dir, "state.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- migration — superdoctor_attempts table ----------

describe("superdoctor-attempts migration — schema present", () => {
  test("opening a fresh state.db materialises the table at the ladder tip", () => {
    const db = openDatabase(dbPath, migrations);
    try {
      const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      // Ladder tip drifts as new migrations land. The invariant
      // superdoctor_attempts depends on is "table present after
      // migration completes", not a literal version pin. Originally
      // v2→v3; renumbered v3→v4 at trunk-merge 2026-05-14.
      expect(v).toBeGreaterThanOrEqual(3);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("superdoctor_attempts");
    } finally {
      closeDatabase(db);
    }
  });

  test("CHECK constraint rejects invalid outcome values", () => {
    const db = openDatabase(dbPath, migrations);
    try {
      expect(() =>
        db
          .prepare(
            "INSERT INTO superdoctor_attempts (complaint_id, attempt_n, outcome, attempted_at) VALUES (?, ?, ?, ?)",
          )
          .run("c-aaaaaaaa", 1, "bogus", 1700000000),
      ).toThrow();
    } finally {
      closeDatabase(db);
    }
  });
});

// ---------- SuperdoctorAttemptsRepo ----------

describe("SuperdoctorAttemptsRepo — typed CRUD", () => {
  test("insert + listForComplaint round-trip preserves all fields", () => {
    const db = openDatabase(dbPath, migrations);
    try {
      const repo = new SuperdoctorAttemptsRepo(db);
      const rowid = repo.insert({
        complaintId: "c-aaaaaaaa",
        attemptN: 1,
        outcome: "failed",
        attemptedAt: 1700000000,
        action: "rotate-lead",
        note: "lead pane never accepted the /clear paste",
        extra: { sha: "deadbeef" },
      });
      expect(rowid).toBeGreaterThan(0);
      const rows = repo.listForComplaint("c-aaaaaaaa");
      expect(rows).toHaveLength(1);
      const a = rows[0];
      expect(a).toBeDefined();
      if (!a) return;
      expect(a.complaintId).toBe("c-aaaaaaaa");
      expect(a.attemptN).toBe(1);
      expect(a.outcome).toBe("failed");
      expect(a.action).toBe("rotate-lead");
      expect(a.note).toContain("lead pane");
      expect(a.extra.sha).toBe("deadbeef");
    } finally {
      closeDatabase(db);
    }
  });

  test("countByOutcomeFor returns count per (complaintId, outcome) pair", () => {
    const db = openDatabase(dbPath, migrations);
    try {
      const repo = new SuperdoctorAttemptsRepo(db);
      for (let i = 1; i <= 3; i++) {
        repo.insert({
          complaintId: "c-bbbbbbbb",
          attemptN: i,
          outcome: "failed",
          attemptedAt: 1700000000 + i,
          action: null,
          note: null,
          extra: {},
        });
      }
      repo.insert({
        complaintId: "c-bbbbbbbb",
        attemptN: 4,
        outcome: "resolved",
        attemptedAt: 1700000004,
        action: null,
        note: null,
        extra: {},
      });
      // A separate complaint — must not leak across the GROUP boundary.
      repo.insert({
        complaintId: "c-cccccccc",
        attemptN: 1,
        outcome: "failed",
        attemptedAt: 1700000005,
        action: null,
        note: null,
        extra: {},
      });

      expect(repo.countByOutcomeFor("c-bbbbbbbb", "failed")).toBe(3);
      expect(repo.countByOutcomeFor("c-bbbbbbbb", "resolved")).toBe(1);
      expect(repo.countByOutcomeFor("c-bbbbbbbb", "partial")).toBe(0);
      expect(repo.countByOutcomeFor("c-cccccccc", "failed")).toBe(1);
      expect(repo.countByOutcomeFor("c-deadbeef", "failed")).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("latestFor returns most recent row by attemptedAt; null when none", () => {
    const db = openDatabase(dbPath, migrations);
    try {
      const repo = new SuperdoctorAttemptsRepo(db);
      expect(repo.latestFor("c-empty")).toBeNull();

      repo.insert({
        complaintId: "c-dddddddd",
        attemptN: 1,
        outcome: "partial",
        attemptedAt: 1700000100,
        action: "kill-respawn",
        note: null,
        extra: {},
      });
      repo.insert({
        complaintId: "c-dddddddd",
        attemptN: 2,
        outcome: "failed",
        attemptedAt: 1700000200,
        action: "rotate-lead",
        note: null,
        extra: {},
      });
      const latest = repo.latestFor("c-dddddddd");
      expect(latest).not.toBeNull();
      expect(latest?.attemptN).toBe(2);
      expect(latest?.action).toBe("rotate-lead");
    } finally {
      closeDatabase(db);
    }
  });

  test("listForComplaint orders newest first", () => {
    const db = openDatabase(dbPath, migrations);
    try {
      const repo = new SuperdoctorAttemptsRepo(db);
      repo.insert({
        complaintId: "c-eeeeeeee",
        attemptN: 1,
        outcome: "failed",
        attemptedAt: 1700000010,
        action: null,
        note: null,
        extra: {},
      });
      repo.insert({
        complaintId: "c-eeeeeeee",
        attemptN: 2,
        outcome: "failed",
        attemptedAt: 1700000020,
        action: null,
        note: null,
        extra: {},
      });
      const rows = repo.listForComplaint("c-eeeeeeee");
      expect(rows.map((r) => r.attemptN)).toEqual([2, 1]);
    } finally {
      closeDatabase(db);
    }
  });
});
