// Unit tests for src/core/pause.ts (ADR-003) + src/schema/paused.ts (ADR-005).
//
// Each test uses a fresh tmpdir as the synthetic `atmuxDir`. The schema
// is exercised through the core lib's IO paths (loadPausedMap +
// pauseMember + resumeMember) plus a couple of explicit shape-rejection
// tests to keep parse-error coverage honest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PAUSE_REASON,
  getPauseInfo,
  isPaused,
  listPaused,
  loadPausedMap,
  pausedJsonPath,
  pauseMember,
  resumeMember,
} from "../../../src/core/pause.ts";
import { SchemaError } from "../../../src/errors.ts";
import { PausedMapSchema, PauseEntrySchema } from "../../../src/schema/paused.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-pause-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

describe("pausedJsonPath", () => {
  test("appends state/paused.json to atmuxDir", () => {
    expect(pausedJsonPath("/tmp/foo")).toBe("/tmp/foo/state/paused.json");
  });

  test("idempotent on path with trailing slash absent", () => {
    expect(pausedJsonPath("/x")).toBe("/x/state/paused.json");
  });
});

describe("schema — PauseEntrySchema", () => {
  test("accepts a well-formed entry", () => {
    const ok = PauseEntrySchema.parse({ at: 1700000000, reason: "manual" });
    expect(ok).toEqual({ at: 1700000000, reason: "manual" });
  });

  test("rejects negative `at`", () => {
    expect(() => PauseEntrySchema.parse({ at: -1, reason: "x" })).toThrow();
  });

  test("rejects non-integer `at`", () => {
    expect(() => PauseEntrySchema.parse({ at: 1.5, reason: "x" })).toThrow();
  });

  test("strict mode rejects unknown keys", () => {
    expect(() => PauseEntrySchema.parse({ at: 0, reason: "x", surplus: true })).toThrow();
  });
});

describe("schema — PausedMapSchema", () => {
  test("accepts empty map", () => {
    expect(PausedMapSchema.parse({})).toEqual({});
  });

  test("accepts populated map", () => {
    const got = PausedMapSchema.parse({
      alice: { at: 1, reason: "manual" },
      bob: { at: 2, reason: "investigating" },
    });
    expect(Object.keys(got).sort()).toEqual(["alice", "bob"]);
  });

  test("rejects malformed entry value", () => {
    expect(() => PausedMapSchema.parse({ alice: { at: "not-a-num", reason: "x" } })).toThrow();
  });
});

describe("loadPausedMap", () => {
  test("returns {} when paused.json is absent", async () => {
    expect(await loadPausedMap(atmuxDir)).toEqual({});
  });

  test("returns {} when paused.json is the empty object (bash first-run shape)", async () => {
    await writeFile(pausedJsonPath(atmuxDir), "{}\n");
    expect(await loadPausedMap(atmuxDir)).toEqual({});
  });

  test("returns parsed map for populated file", async () => {
    await writeFile(
      pausedJsonPath(atmuxDir),
      JSON.stringify({ alice: { at: 5, reason: "manual" } }),
    );
    expect(await loadPausedMap(atmuxDir)).toEqual({
      alice: { at: 5, reason: "manual" },
    });
  });

  test("throws SchemaError on malformed existing file (no silent fallback)", async () => {
    await writeFile(pausedJsonPath(atmuxDir), "{not even valid json");
    await expect(loadPausedMap(atmuxDir)).rejects.toBeInstanceOf(SchemaError);
  });

  test("throws SchemaError on shape mismatch (bash-incompatible value)", async () => {
    await writeFile(
      pausedJsonPath(atmuxDir),
      JSON.stringify({ alice: { at: -1, reason: "manual" } }),
    );
    await expect(loadPausedMap(atmuxDir)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("pauseMember", () => {
  test("creates paused.json on first pause with default reason + real clock", async () => {
    const before = Math.floor(Date.now() / 1000);
    await pauseMember(atmuxDir, "alice");
    const after = Math.floor(Date.now() / 1000);
    const map = await loadPausedMap(atmuxDir);
    expect(map.alice?.reason).toBe(DEFAULT_PAUSE_REASON);
    // `at` was sourced from the real clock (time.ts::now()) — assert it's
    // bracketed by the call-site real-time window. Proves the
    // default-clock branch (no `nowEpochSec` override) hit time.ts::now.
    expect(map.alice?.at).toBeGreaterThanOrEqual(before);
    expect(map.alice?.at).toBeLessThanOrEqual(after);
  });

  test("default reason is `manual` (matches bash $ATMUX_PAUSE_REASON default)", async () => {
    expect(DEFAULT_PAUSE_REASON).toBe("manual");
    await pauseMember(atmuxDir, "alice");
    const info = await getPauseInfo(atmuxDir, "alice");
    expect(info?.reason).toBe("manual");
  });

  test("custom reason override propagates to disk", async () => {
    await pauseMember(atmuxDir, "alice", { reason: "investigating-flake" });
    const info = await getPauseInfo(atmuxDir, "alice");
    expect(info?.reason).toBe("investigating-flake");
  });

  test("nowEpochSec override pins the timestamp", async () => {
    await pauseMember(atmuxDir, "bob", { nowEpochSec: 42, reason: "test" });
    const info = await getPauseInfo(atmuxDir, "bob");
    expect(info).toEqual({ at: 42, reason: "test" });
  });

  test("re-pausing overwrites prior entry (bash unconditional assign)", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 10, reason: "first" });
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 20, reason: "second" });
    const info = await getPauseInfo(atmuxDir, "alice");
    expect(info).toEqual({ at: 20, reason: "second" });
  });

  test("multiple pauses preserve other members", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1, reason: "x" });
    await pauseMember(atmuxDir, "bob", { nowEpochSec: 2, reason: "y" });
    const map = await loadPausedMap(atmuxDir);
    expect(Object.keys(map).sort()).toEqual(["alice", "bob"]);
  });

  test("written file is readable as JSON with the bash-faithful shape", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 99, reason: "manual" });
    const text = await readFile(pausedJsonPath(atmuxDir), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ alice: { at: 99, reason: "manual" } });
    // No schemaVersion field — parity with bash.
    expect(Object.hasOwn(parsed, "schemaVersion")).toBe(false);
  });
});

describe("resumeMember", () => {
  test("removes a paused entry", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1 });
    await resumeMember(atmuxDir, "alice");
    expect(await isPaused(atmuxDir, "alice")).toBe(false);
  });

  test("idempotent on never-paused member (matches bash `del()`)", async () => {
    await resumeMember(atmuxDir, "ghost"); // file doesn't even exist
    expect(await loadPausedMap(atmuxDir)).toEqual({});
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1 });
    await resumeMember(atmuxDir, "ghost"); // present file, missing key
    const map = await loadPausedMap(atmuxDir);
    expect(map.alice).toBeDefined();
    expect(map.ghost).toBeUndefined();
  });

  test("preserves other paused members", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1 });
    await pauseMember(atmuxDir, "bob", { nowEpochSec: 2 });
    await resumeMember(atmuxDir, "alice");
    const map = await loadPausedMap(atmuxDir);
    expect(map.alice).toBeUndefined();
    expect(map.bob).toEqual({ at: 2, reason: "manual" });
  });
});

describe("isPaused", () => {
  test("false when paused.json is absent", async () => {
    expect(await isPaused(atmuxDir, "alice")).toBe(false);
  });

  test("false on never-paused member with populated file", async () => {
    await pauseMember(atmuxDir, "bob", { nowEpochSec: 1 });
    expect(await isPaused(atmuxDir, "alice")).toBe(false);
  });

  test("true on currently-paused member", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1 });
    expect(await isPaused(atmuxDir, "alice")).toBe(true);
  });

  test("false after resume", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1 });
    await resumeMember(atmuxDir, "alice");
    expect(await isPaused(atmuxDir, "alice")).toBe(false);
  });
});

describe("getPauseInfo", () => {
  test("null when not paused", async () => {
    expect(await getPauseInfo(atmuxDir, "alice")).toBeNull();
  });

  test("returns full entry when paused", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 7, reason: "specific" });
    expect(await getPauseInfo(atmuxDir, "alice")).toEqual({
      at: 7,
      reason: "specific",
    });
  });
});

describe("listPaused", () => {
  test("empty map when nothing paused", async () => {
    expect(await listPaused(atmuxDir)).toEqual({});
  });

  test("returns full snapshot of paused members", async () => {
    await pauseMember(atmuxDir, "alice", { nowEpochSec: 1, reason: "a" });
    await pauseMember(atmuxDir, "bob", { nowEpochSec: 2, reason: "b" });
    expect(await listPaused(atmuxDir)).toEqual({
      alice: { at: 1, reason: "a" },
      bob: { at: 2, reason: "b" },
    });
  });
});
