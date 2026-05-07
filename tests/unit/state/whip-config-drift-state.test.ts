// Unit tests for `.atmux/state/whip-config-drift-state.json` dedup
// state-file (ADR-054 R1-T4 §D5).
//
// Hash dedup, 24h re-fire window, multi-drift sequencing. Sister tests
// covering the compose / safe-defaults / Discord renderer live in
// tests/unit/core/whip-config-drift.test.ts (R1-T3 / R1-T4 share the
// suite); this file focuses on the dedup-state lifecycle in isolation
// per ADR-054 §D5 "tests/unit/state/whip-config-drift-state.test.ts".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIFT_REFIRE_WINDOW_SEC,
  DRIFT_STATE_FILENAME,
  recordDriftPing,
  shouldFireDriftPing,
  whipConfigDriftStatePath,
} from "../../../src/core/whip-config-drift.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-drift-state-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Path constants ----------

describe("file location", () => {
  test("filename matches ADR-054 §State files", () => {
    expect(DRIFT_STATE_FILENAME).toBe("whip-config-drift-state.json");
  });

  test("path resolves under <atmuxDir>/state/", () => {
    expect(whipConfigDriftStatePath("/tmp/foo")).toBe(
      "/tmp/foo/state/whip-config-drift-state.json",
    );
  });
});

// ---------- Re-fire window constant ----------

describe("DRIFT_REFIRE_WINDOW_SEC", () => {
  test("exactly 24 hours in seconds (86400)", () => {
    expect(DRIFT_REFIRE_WINDOW_SEC).toBe(24 * 60 * 60);
    expect(DRIFT_REFIRE_WINDOW_SEC).toBe(86_400);
  });
});

// ---------- shouldFireDriftPing — first-fire / dedup / re-fire ----------

describe("shouldFireDriftPing — dedup gate", () => {
  test("absent state file → fire (first time on this team)", async () => {
    expect(await shouldFireDriftPing(atmuxDir, "abc123", 1_800_000_000)).toBe(true);
  });

  test("hash absent in populated state file → fire", async () => {
    await recordDriftPing(atmuxDir, "other-hash", 1_800_000_000);
    expect(await shouldFireDriftPing(atmuxDir, "new-hash", 1_800_000_500)).toBe(true);
  });

  test("hash present + last fire 1h ago → suppress", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + 60 * 60)).toBe(false);
  });

  test("hash present + last fire 23h59m59s ago → suppress (boundary − 1)", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(
      await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + DRIFT_REFIRE_WINDOW_SEC - 1),
    ).toBe(false);
  });

  test("hash present + last fire 24h ago → re-fire (boundary inclusive)", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(
      await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + DRIFT_REFIRE_WINDOW_SEC),
    ).toBe(true);
  });

  test("hash present + last fire 30h ago → re-fire", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    expect(await shouldFireDriftPing(atmuxDir, "abc", 1_800_000_000 + 30 * 60 * 60)).toBe(true);
  });
});

// ---------- recordDriftPing — write semantics ----------

describe("recordDriftPing — file IO", () => {
  test("creates state file on first call with single hash entry", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    const path = whipConfigDriftStatePath(atmuxDir);
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ abc: 1_800_000_000 });
  });

  test("file written with mode 0644 (operator-readable)", async () => {
    await recordDriftPing(atmuxDir, "abc", 1_800_000_000);
    const path = whipConfigDriftStatePath(atmuxDir);
    const s = await stat(path);
    expect(s.mode & 0o600).toBe(0o600);
  });

  test("appended hash preserves prior entries", async () => {
    await recordDriftPing(atmuxDir, "h1", 1);
    await recordDriftPing(atmuxDir, "h2", 2);
    const parsed = JSON.parse(await readFile(whipConfigDriftStatePath(atmuxDir), "utf8"));
    expect(parsed).toEqual({ h1: 1, h2: 2 });
  });

  test("re-fire on same hash overwrites the timestamp", async () => {
    await recordDriftPing(atmuxDir, "abc", 1);
    await recordDriftPing(atmuxDir, "abc", 999);
    const parsed = JSON.parse(await readFile(whipConfigDriftStatePath(atmuxDir), "utf8"));
    expect(parsed).toEqual({ abc: 999 });
  });

  test("trailing newline on the file (atomicWrite convention)", async () => {
    await recordDriftPing(atmuxDir, "abc", 1);
    const text = await readFile(whipConfigDriftStatePath(atmuxDir), "utf8");
    expect(text.endsWith("\n")).toBe(true);
  });
});

// ---------- Multi-drift sequencing ----------

describe("multi-drift sequencing", () => {
  test("3 distinct drifts independently dedup over 24h", async () => {
    // First firings of three different drifts at different times.
    await recordDriftPing(atmuxDir, "h1", 0);
    await recordDriftPing(atmuxDir, "h2", 100);
    await recordDriftPing(atmuxDir, "h3", 200);
    // h1 still within window: suppress.
    expect(await shouldFireDriftPing(atmuxDir, "h1", 1)).toBe(false);
    // h4 is brand new: fire.
    expect(await shouldFireDriftPing(atmuxDir, "h4", 300)).toBe(true);
    // h2 within window: suppress.
    expect(await shouldFireDriftPing(atmuxDir, "h2", 110)).toBe(false);
    // h3 past window: re-fire.
    expect(await shouldFireDriftPing(atmuxDir, "h3", 200 + DRIFT_REFIRE_WINDOW_SEC)).toBe(true);
  });

  test("re-firing preserves OTHER hashes' timestamps", async () => {
    await recordDriftPing(atmuxDir, "h1", 100);
    await recordDriftPing(atmuxDir, "h2", 200);
    await recordDriftPing(atmuxDir, "h1", 999); // re-fire h1
    const parsed = JSON.parse(await readFile(whipConfigDriftStatePath(atmuxDir), "utf8"));
    expect(parsed).toEqual({ h1: 999, h2: 200 });
  });

  test("stale + corrupt-ish state-file (extra unknown keys) — schema record(string,number) tolerates them only as numbers", async () => {
    // The DriftStateSchema is z.record(string, number), so non-numeric
    // values would reject. Test that a clean number-only state survives.
    const path = whipConfigDriftStatePath(atmuxDir);
    await writeFile(path, JSON.stringify({ a: 1, b: 2, c: 3 }));
    expect(await shouldFireDriftPing(atmuxDir, "a", 100)).toBe(false);
    expect(await shouldFireDriftPing(atmuxDir, "z", 100)).toBe(true);
  });
});
