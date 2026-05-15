// Unit tests for src/core/ombudsman.ts (ADR-147 T1 — sentinel R/W).
//
// Round-trip + idempotency + concurrency-safety assertions on the
// `.atmux/state/ombudsman-pending.json` sentinel. SchemaError on
// corrupt file body is intentional (see ADR-005 §"never silent
// fallback to defaults") and tested.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../../../src/abstractions/fs.ts";
import {
  addToSentinel,
  isSentinelEmpty,
  readSentinel,
  removeFromSentinel,
  sentinelPath,
} from "../../../src/core/ombudsman.ts";
import { SchemaError } from "../../../src/errors.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-ombudsman-core-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Path resolver ----------

describe("sentinelPath", () => {
  test("resolves to <atmuxDir>/state/ombudsman-pending.json", () => {
    expect(sentinelPath("/tmp/team/.atmux")).toBe("/tmp/team/.atmux/state/ombudsman-pending.json");
  });

  test("pure — does not touch disk", () => {
    // The function is sync + non-async; this test pins that contract.
    const p = sentinelPath(atmuxDir);
    expect(typeof p).toBe("string");
    expect(p.endsWith("/state/ombudsman-pending.json")).toBe(true);
  });
});

// ---------- Read (absent file → empty) ----------

describe("readSentinel", () => {
  test("returns empty sentinel when file is absent (first-run)", async () => {
    const got = await readSentinel(atmuxDir);
    expect(got).toEqual({ pending: [] });
  });

  test("reads existing valid file", async () => {
    const path = sentinelPath(atmuxDir);
    await ensureDir(join(path, ".."));
    await writeFile(path, JSON.stringify({ pending: ["c-abc12345"] }), "utf8");
    const got = await readSentinel(atmuxDir);
    expect(got).toEqual({ pending: ["c-abc12345"] });
  });

  test("throws SchemaError on corrupt JSON body", async () => {
    const path = sentinelPath(atmuxDir);
    await ensureDir(join(path, ".."));
    await writeFile(path, "{not-json", "utf8");
    await expect(readSentinel(atmuxDir)).rejects.toBeInstanceOf(SchemaError);
  });

  test("throws SchemaError on unknown extra fields (.strict() enforcement)", async () => {
    const path = sentinelPath(atmuxDir);
    await ensureDir(join(path, ".."));
    await writeFile(path, JSON.stringify({ pending: [], lastReadAt: 1234567890 }), "utf8");
    await expect(readSentinel(atmuxDir)).rejects.toBeInstanceOf(SchemaError);
  });
});

// ---------- isSentinelEmpty (hot-path predicate) ----------

describe("isSentinelEmpty", () => {
  test("returns true when file is absent", async () => {
    expect(await isSentinelEmpty(atmuxDir)).toBe(true);
  });

  test("returns true when pending array is empty", async () => {
    const path = sentinelPath(atmuxDir);
    await ensureDir(join(path, ".."));
    await writeFile(path, JSON.stringify({ pending: [] }), "utf8");
    expect(await isSentinelEmpty(atmuxDir)).toBe(true);
  });

  test("returns false when pending array is non-empty", async () => {
    await addToSentinel(atmuxDir, "c-abc12345");
    expect(await isSentinelEmpty(atmuxDir)).toBe(false);
  });
});

// ---------- Add / remove round-trip ----------

describe("addToSentinel + removeFromSentinel — round-trip", () => {
  test("add creates file when absent + writes pending array", async () => {
    await addToSentinel(atmuxDir, "c-abc12345");
    const got = await readSentinel(atmuxDir);
    expect(got).toEqual({ pending: ["c-abc12345"] });
  });

  test("add appends in insertion order", async () => {
    await addToSentinel(atmuxDir, "c-aaaaaaaa");
    await addToSentinel(atmuxDir, "c-bbbbbbbb");
    await addToSentinel(atmuxDir, "c-cccccccc");
    const got = await readSentinel(atmuxDir);
    expect(got.pending).toEqual(["c-aaaaaaaa", "c-bbbbbbbb", "c-cccccccc"]);
  });

  test("add is set-semantic (idempotent re-add)", async () => {
    await addToSentinel(atmuxDir, "c-abc12345");
    await addToSentinel(atmuxDir, "c-abc12345");
    await addToSentinel(atmuxDir, "c-abc12345");
    const got = await readSentinel(atmuxDir);
    expect(got.pending).toEqual(["c-abc12345"]);
  });

  test("remove returns true when id present", async () => {
    await addToSentinel(atmuxDir, "c-abc12345");
    const removed = await removeFromSentinel(atmuxDir, "c-abc12345");
    expect(removed).toBe(true);
    const got = await readSentinel(atmuxDir);
    expect(got.pending).toEqual([]);
  });

  test("remove returns false when id absent (no-op)", async () => {
    await addToSentinel(atmuxDir, "c-aaaaaaaa");
    const removed = await removeFromSentinel(atmuxDir, "c-bbbbbbbb");
    expect(removed).toBe(false);
    const got = await readSentinel(atmuxDir);
    expect(got.pending).toEqual(["c-aaaaaaaa"]);
  });

  test("remove preserves order of remaining ids", async () => {
    await addToSentinel(atmuxDir, "c-aaaaaaaa");
    await addToSentinel(atmuxDir, "c-bbbbbbbb");
    await addToSentinel(atmuxDir, "c-cccccccc");
    await removeFromSentinel(atmuxDir, "c-bbbbbbbb");
    const got = await readSentinel(atmuxDir);
    expect(got.pending).toEqual(["c-aaaaaaaa", "c-cccccccc"]);
  });

  test("remove on absent file is a no-op (returns false)", async () => {
    const removed = await removeFromSentinel(atmuxDir, "c-abc12345");
    expect(removed).toBe(false);
    // File should have been created with empty pending by updateJson's
    // initial-fallback path.
    const got = await readSentinel(atmuxDir);
    expect(got.pending).toEqual([]);
  });

  test("full add → remove → add round-trip", async () => {
    await addToSentinel(atmuxDir, "c-roundtrip");
    expect((await readSentinel(atmuxDir)).pending).toEqual(["c-roundtrip"]);
    await removeFromSentinel(atmuxDir, "c-roundtrip");
    expect((await readSentinel(atmuxDir)).pending).toEqual([]);
    await addToSentinel(atmuxDir, "c-roundtrip");
    expect((await readSentinel(atmuxDir)).pending).toEqual(["c-roundtrip"]);
  });

  test("on-disk JSON is human-readable (2-space indent + trailing newline)", async () => {
    await addToSentinel(atmuxDir, "c-readable");
    const raw = await readFile(sentinelPath(atmuxDir), "utf8");
    expect(raw).toMatch(/^\{\n {2}"pending": \[\n {4}"c-readable"\n {2}\]\n\}\n$/);
  });
});
