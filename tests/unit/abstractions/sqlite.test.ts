// Unit tests for src/abstractions/sqlite.ts.
//
// Pins the migration ladder semantics, with the multi-entry progression
// case explicit — that's the regression covered by 3d24f17, where the
// loop captured `current = readUserVersion(db)` once before iterating
// instead of re-reading after each apply, so a v0→v1→v2 ladder threw
// "migration gap: db at user_version=0, next migration starts at from=1"
// on the second iteration. The bug was latent until ADR-077 §F2 added
// the v1→v2 entry; a property-style test on a synthetic ladder catches
// the same shape regardless of what the live ladder looks like.
//
// The legacy-DB rescue regression test (ADR-147 T9, 2026-05-15) covers
// the renumber-discovered failure: when migration v4→v5 is non-idempotent
// against a DB that already has the target table from a pre-renumber
// v3→v4 run, the open throws "table X already exists". With CREATE
// TABLE IF NOT EXISTS the same ladder walks cleanly across legacy DBs.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  type Migration,
  openDatabase,
  readUserVersion,
} from "../../../src/abstractions/sqlite.ts";
import { migrations as liveMigrations } from "../../../src/abstractions/sqlite-migrations.ts";

interface Env {
  dir: string;
  dbPath: string;
}

let env: Env;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "atmux-sqlite-"));
  env = { dir, dbPath: join(dir, "state.db") };
});

afterEach(async () => {
  await rm(env.dir, { recursive: true, force: true });
});

/** Build a ladder of N synthetic migrations that each create a marker
 *  table `tN` and append `N` to a shared call-log. Lets tests assert
 *  both `user_version` final state AND that each `up` ran exactly once
 *  in order. */
function makeLadder(n: number, calls: number[]): Migration[] {
  return Array.from({ length: n }, (_, i) => ({
    from: i,
    to: i + 1,
    up: (db) => {
      db.exec(`CREATE TABLE t${i + 1} (id INTEGER PRIMARY KEY) STRICT`);
      calls.push(i + 1);
    },
  }));
}

describe("openDatabase — migration ladder", () => {
  test("empty ladder leaves user_version=0 on a fresh DB", () => {
    const db = openDatabase(env.dbPath, []);
    try {
      expect(readUserVersion(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("single migration advances user_version 0→1 and runs up() once", () => {
    const calls: number[] = [];
    const db = openDatabase(env.dbPath, makeLadder(1, calls));
    try {
      expect(readUserVersion(db)).toBe(1);
      expect(calls).toEqual([1]);
    } finally {
      closeDatabase(db);
    }
  });

  test("multi-entry ladder advances user_version across every step (regression: 3d24f17)", () => {
    // The exact shape of the bug fixed in 3d24f17: with `const current`
    // captured once, the second iteration's `m.from === 1` mismatched
    // the still-zero local and threw. With `let current = m.to` after
    // each apply, the loop walks the full ladder.
    const calls: number[] = [];
    const db = openDatabase(env.dbPath, makeLadder(4, calls));
    try {
      expect(readUserVersion(db)).toBe(4);
      expect(calls).toEqual([1, 2, 3, 4]);
    } finally {
      closeDatabase(db);
    }
  });

  test("re-opening with the same ladder is idempotent — no up() re-runs", () => {
    const calls: number[] = [];
    const ladder = makeLadder(3, calls);

    const db1 = openDatabase(env.dbPath, ladder);
    closeDatabase(db1);
    expect(calls).toEqual([1, 2, 3]);

    const db2 = openDatabase(env.dbPath, ladder);
    try {
      expect(readUserVersion(db2)).toBe(3);
      // No additional entries — ladder didn't re-run on the warm DB.
      expect(calls).toEqual([1, 2, 3]);
    } finally {
      closeDatabase(db2);
    }
  });

  test("appending a new migration to a warm DB runs only the new entry", () => {
    const calls: number[] = [];
    const v1 = makeLadder(1, calls);

    const db1 = openDatabase(env.dbPath, v1);
    closeDatabase(db1);
    expect(calls).toEqual([1]);

    const v2 = [...v1, ...makeLadder(2, calls).slice(1)];
    const db2 = openDatabase(env.dbPath, v2);
    try {
      expect(readUserVersion(db2)).toBe(2);
      // Only the new v1→v2 step ran; v0→v1 was skipped (already at 1).
      expect(calls).toEqual([1, 2]);
    } finally {
      closeDatabase(db2);
    }
  });

  test("gap in ladder throws with the current + next-from in the message", () => {
    // Skip from v1 directly to v3 — `openDatabase` should refuse.
    const ladder: Migration[] = [
      {
        from: 0,
        to: 1,
        up: (db) => {
          db.exec("CREATE TABLE t1 (id INTEGER PRIMARY KEY) STRICT");
        },
      },
      {
        from: 2,
        to: 3,
        up: (db) => {
          db.exec("CREATE TABLE t3 (id INTEGER PRIMARY KEY) STRICT");
        },
      },
    ];
    expect(() => openDatabase(env.dbPath, ladder)).toThrow(
      /migration gap: db at user_version=1, next migration starts at from=2/,
    );
  });
});

describe("live migration ladder — legacy DB rescue (ADR-147 T9 dogfood)", () => {
  // Simulates the pre-renumber state observed 2026-05-15 on
  // /root/work/src/atmux/.atmux/state.db: a DB sitting at user_version=4
  // because it ran the OLD v3→v4 (which was superdoctor_hygiene) but the
  // ladder was renumbered so the new v3→v4 (superdoctor_attempts) never
  // ran. The new ladder loop sees user_version=4 and fires v4→v5
  // (hygiene), which without IF NOT EXISTS crashes on the already-present
  // table.

  test("seeded legacy state (user_version=4 + hygiene present, attempts missing) walks the live ladder to completion", () => {
    // Seed: create only the hygiene table by hand, set user_version=4.
    // Mimics a DB that ran the pre-renumber v3→v4.
    const seed = new Database(env.dbPath, { create: true });
    seed.exec(`
      CREATE TABLE superdoctor_hygiene (
        task_id TEXT NOT NULL,
        fingerprint_class TEXT NOT NULL,
        severity INTEGER NOT NULL,
        confidence TEXT NOT NULL,
        diagnosis TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        attempted_fix TEXT,
        fix_applied_at INTEGER,
        fix_successful INTEGER,
        PRIMARY KEY (task_id, fingerprint_class)
      ) STRICT
    `);
    seed.exec(
      "CREATE INDEX idx_hygiene_unfixed ON superdoctor_hygiene(severity ASC, detected_at ASC) WHERE fix_applied_at IS NULL",
    );
    seed.exec("PRAGMA user_version = 4");
    seed.close();

    // Open with the live ladder — must not throw and must end at the
    // highest live version.
    const db = openDatabase(env.dbPath, liveMigrations);
    try {
      const highest = liveMigrations[liveMigrations.length - 1]!.to;
      expect(readUserVersion(db)).toBe(highest);

      // Both tables present after rescue: hygiene survived from seed,
      // attempts created by the v6→v7 backfill.
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));
      expect(names.has("superdoctor_hygiene")).toBe(true);
      expect(names.has("superdoctor_attempts")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("fresh DB walks the live ladder from v0 to highest with both tables present", () => {
    const db = openDatabase(env.dbPath, liveMigrations);
    try {
      const highest = liveMigrations[liveMigrations.length - 1]!.to;
      expect(readUserVersion(db)).toBe(highest);

      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));
      expect(names.has("superdoctor_hygiene")).toBe(true);
      expect(names.has("superdoctor_attempts")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("re-opening the live ladder on an already-fully-migrated DB is a no-op", () => {
    const db1 = openDatabase(env.dbPath, liveMigrations);
    closeDatabase(db1);

    const db2 = openDatabase(env.dbPath, liveMigrations);
    try {
      const highest = liveMigrations[liveMigrations.length - 1]!.to;
      expect(readUserVersion(db2)).toBe(highest);
    } finally {
      closeDatabase(db2);
    }
  });
});
