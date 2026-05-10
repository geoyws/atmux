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
