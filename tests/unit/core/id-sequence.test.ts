// Unit tests for src/core/id-sequence.ts (ADR-202 §VIII compound IDs).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  assignSequenceToLegacyId,
  isAnyId,
  isCompoundId,
  isHexId,
  isSequenceId,
  matchesIdPrefix,
  nextId,
  peekId,
} from "../../../src/core/id-sequence.ts";

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-id-seq-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

describe("nextId — compound allocation", () => {
  test("first call for scope 't' returns t-1-<hash>", () => {
    const id = nextId(db, "t");
    expect(id).toMatch(/^t-1-[0-9a-f]{8}$/);
  });

  test("monotonic counters per scope with fresh hashes", () => {
    const ids = [nextId(db, "t"), nextId(db, "t"), nextId(db, "t")];
    expect(ids[0]).toMatch(/^t-1-[0-9a-f]{8}$/);
    expect(ids[1]).toMatch(/^t-2-[0-9a-f]{8}$/);
    expect(ids[2]).toMatch(/^t-3-[0-9a-f]{8}$/);
    // Distinct hashes
    expect(new Set(ids).size).toBe(3);
  });

  test("scopes are independent", () => {
    expect(nextId(db, "t")).toMatch(/^t-1-/);
    expect(nextId(db, "e")).toMatch(/^e-1-/);
    expect(nextId(db, "s")).toMatch(/^s-1-/);
    expect(nextId(db, "t")).toMatch(/^t-2-/);
    expect(nextId(db, "e")).toMatch(/^e-2-/);
  });

  test("counter survives reopen of same DB", () => {
    expect(nextId(db, "t")).toMatch(/^t-1-/);
    expect(nextId(db, "t")).toMatch(/^t-2-/);
    closeDatabase(db);
    db = openDatabase(join(scratch, "state.db"), migrations);
    expect(nextId(db, "t")).toMatch(/^t-3-/);
  });

  test("hashOverride seam for test determinism", () => {
    expect(nextId(db, "t", () => "deadbeef")).toBe("t-1-deadbeef");
    expect(nextId(db, "t", () => "12345678")).toBe("t-2-12345678");
  });
});

describe("defensive allocation paths", () => {
  test("nextId throws when SQLite RETURNING yields no row", () => {
    const fakeDb = {
      prepare: () => ({
        get: () => undefined,
      }),
    } as Database;

    try {
      nextId(fakeDb, "t");
      throw new Error("expected nextId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("nextId(t): SQLite RETURNING produced no row");
    }
  });

  test("assignSequenceToLegacyId rejects non-legacy ids for scope", () => {
    try {
      assignSequenceToLegacyId(db, "t", "t-1-3b017960");
      throw new Error("expected assignSequenceToLegacyId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "assignSequenceToLegacyId: 't-1-3b017960' is not a legacy hex id for scope 't'",
      );
    }
  });

  test("assignSequenceToLegacyId throws when SQLite RETURNING yields no row", () => {
    const fakeDb = {
      prepare: () => ({
        get: () => undefined,
      }),
    } as Database;

    try {
      assignSequenceToLegacyId(fakeDb, "t", "t-3b017960");
      throw new Error("expected assignSequenceToLegacyId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "assignSequenceToLegacyId(t): SQLite RETURNING produced no row",
      );
    }
  });

  test("assignSequenceToLegacyId preserves legacy hash in compound output", () => {
    const fakeDb = {
      prepare: () => ({
        get: () => ({ last_id: 7 }),
      }),
    } as Database;

    expect(assignSequenceToLegacyId(fakeDb, "t", "t-3b017960")).toEqual({
      compoundId: "t-7-3b017960",
      sequenceN: 7,
    });
  });
});

describe("peekId — read without increment", () => {
  test("returns 0 when scope never used", () => {
    expect(peekId(db, "t")).toBe(0);
  });

  test("returns current counter without incrementing", () => {
    nextId(db, "t");
    nextId(db, "t");
    expect(peekId(db, "t")).toBe(2);
    expect(peekId(db, "t")).toBe(2); // re-peek doesn't increment
    expect(nextId(db, "t")).toMatch(/^t-3-/);
  });
});

describe("format detection", () => {
  test("isCompoundId — t-N-hash with 8 hex chars", () => {
    expect(isCompoundId("t-1-3b017960")).toBe(true);
    expect(isCompoundId("s-1203-abc12345")).toBe(true);
    expect(isCompoundId("e-120339-deadbeef")).toBe(true);
  });

  test("isCompoundId rejects malformed", () => {
    expect(isCompoundId("t-1")).toBe(false); // no hash
    expect(isCompoundId("t-3b017960")).toBe(false); // legacy hex
    expect(isCompoundId("t-0-deadbeef")).toBe(false); // leading zero
    expect(isCompoundId("t-1-deadbee")).toBe(false); // short hash
    expect(isCompoundId("x-1-deadbeef")).toBe(false); // bad prefix
  });

  test("isSequenceId — intermediate t-N format", () => {
    expect(isSequenceId("t-1")).toBe(true);
    expect(isSequenceId("e-1203")).toBe(true);
    expect(isSequenceId("t-0")).toBe(false);
    expect(isSequenceId("t-1-abc")).toBe(false);
  });

  test("isHexId — legacy t-hex format", () => {
    expect(isHexId("t-3b017960")).toBe(true);
    expect(isHexId("s-c4e91c33")).toBe(true);
    expect(isHexId("e-7a1014f9")).toBe(true);
    expect(isHexId("t-1-3b017960")).toBe(false);
  });

  test("isAnyId — accepts all three shapes", () => {
    expect(isAnyId("t-1-3b017960")).toBe(true); // compound
    expect(isAnyId("t-1")).toBe(true); // sequence
    expect(isAnyId("t-3b017960")).toBe(true); // hex
    expect(isAnyId("garbage")).toBe(false);
    expect(isAnyId("")).toBe(false);
  });
});

describe("matchesIdPrefix — partial lookup", () => {
  test("exact match against compound ID", () => {
    expect(matchesIdPrefix("t-1-3b017960", "t-1-3b017960")).toBe(true);
  });

  test("running-number prefix matches compound ID", () => {
    expect(matchesIdPrefix("t-1203-abc12345", "t-1203")).toBe(true);
    expect(matchesIdPrefix("e-1-3b017960", "e-1")).toBe(true);
  });

  test("partial hash also matches", () => {
    expect(matchesIdPrefix("t-1-3b017960", "t-1-3b01")).toBe(true);
  });

  test("two-dash candidate prefix returns true", () => {
    expect(matchesIdPrefix("t-12-abc12345", "t-12-a")).toBe(true);
  });

  test("digit-boundary check: t-1 does NOT match t-12-abc", () => {
    expect(matchesIdPrefix("t-12-abc12345", "t-1")).toBe(false);
    expect(matchesIdPrefix("t-12-abc12345", "t-12")).toBe(true);
  });

  test("empty query never matches", () => {
    expect(matchesIdPrefix("t-1-3b017960", "")).toBe(false);
  });

  test("hex-only legacy IDs require exact match", () => {
    expect(matchesIdPrefix("t-3b017960", "t-3b017960")).toBe(true);
    expect(matchesIdPrefix("t-3b017960", "t-3b01")).toBe(false);
  });

  test("scope mismatch never matches", () => {
    expect(matchesIdPrefix("t-1-3b017960", "e-1")).toBe(false);
  });
});

describe("nextId — concurrency invariants", () => {
  test("100 sequential calls produce distinct ids 1..100", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      ids.add(nextId(db, "t"));
    }
    expect(ids.size).toBe(100);
    expect(peekId(db, "t")).toBe(100);
    // Spot-check some
    const arr = Array.from(ids);
    expect(arr.some((s) => s.startsWith("t-1-"))).toBe(true);
    expect(arr.some((s) => s.startsWith("t-50-"))).toBe(true);
    expect(arr.some((s) => s.startsWith("t-100-"))).toBe(true);
  });
});
