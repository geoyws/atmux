// Unit tests for src/abstractions/uuidv7.ts.
//
// Pins:
//   - RFC 9562 §5.7 byte layout (version nibble, variant bits, timestamp
//     position).
//   - Lexicographic order matches creation order (the load-bearing property
//     for Honker stream consumer offsets per ADR-203 §D6 — without this,
//     `WHERE eventId > last_processed` queries return wrong-ordered rows).
//   - `uuidv7Timestamp()` round-trip extracts the input ms.
//   - 36-char hyphenated format conforms to standard UUID string shape.

import { describe, expect, test } from "bun:test";
import { uuidv7, uuidv7Timestamp } from "../../../src/abstractions/uuidv7.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  test("emits a 36-char hyphenated lowercase UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_RE);
  });

  test("version nibble is 7 (RFC 9562 §5.7)", () => {
    const id = uuidv7();
    // Position 14 in the hyphenated string is the first nibble of the
    // "version" group (chars 14-17 = `7xxx`).
    expect(id.charAt(14)).toBe("7");
  });

  test("variant bits are 10xx (RFC 9562 §4)", () => {
    const id = uuidv7();
    // Position 19 is the first nibble of the "variant" group.
    // Variant 10xx in hex is 8, 9, a, or b.
    expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
  });

  test("timestamp prefix is in lexicographic order across calls", async () => {
    const a = uuidv7();
    // Force at least 2ms gap (Date.now ms-resolution + JIT slack).
    await new Promise((r) => setTimeout(r, 3));
    const b = uuidv7();
    expect(b > a).toBe(true);
  });

  test("explicit `nowMs` injection seam — same ms produces sortable-by-rand IDs", () => {
    const ms = 1_700_000_000_000;
    const r1 = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const r2 = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const a = uuidv7(ms, r1);
    const b = uuidv7(ms, r2);
    // Same timestamp; different rand_b last byte → different IDs in
    // deterministic order.
    expect(a).not.toBe(b);
    expect(b > a).toBe(true);
  });

  test("rand length validation — non-10-byte input throws", () => {
    expect(() => uuidv7(0, new Uint8Array(9))).toThrow(/10 bytes/);
    expect(() => uuidv7(0, new Uint8Array(11))).toThrow(/10 bytes/);
  });

  test("known-vector: timestamp 0, rand all-zeros → deterministic output", () => {
    const id = uuidv7(0, new Uint8Array(10));
    // ts=0 → first 12 hex chars are "000000000000".
    expect(id.startsWith("00000000-0000-7000-8000-")).toBe(true);
  });
});

describe("uuidv7Timestamp", () => {
  test("extracts the embedded ms timestamp", () => {
    const ms = 1_700_000_000_000;
    const id = uuidv7(ms);
    expect(uuidv7Timestamp(id)).toBe(ms);
  });

  test("returns null for non-v7 UUIDs (version nibble != 7)", () => {
    // Synthetic v4-style ID with version=4 at position 14
    const fakeV4 = "00000000-0000-4000-8000-000000000000";
    expect(uuidv7Timestamp(fakeV4)).toBeNull();
  });

  test("returns null for malformed input (wrong length)", () => {
    expect(uuidv7Timestamp("not-a-uuid")).toBeNull();
    expect(uuidv7Timestamp("")).toBeNull();
  });

  test("round-trips through Date.now() — embedded ms within ~5ms of input", () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const ts = uuidv7Timestamp(id);
    if (ts === null) {
      throw new Error("expected non-null timestamp from uuidv7Timestamp");
    }
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
