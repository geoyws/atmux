// Unit tests for src/core/idle-skip.ts (ADR-057 §D4b).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat } from "../../../src/core/heartbeat.ts";
import {
  DEFAULT_FRESH_HEARTBEAT_SEC,
  shouldSkipIdleIncrement,
} from "../../../src/core/idle-skip.ts";

describe("shouldSkipIdleIncrement", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-idle-skip-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "heartbeats"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("inProgressCount=0 → don't skip (genuinely idle)", async () => {
    await writeHeartbeat(atmuxDir, "alpha", 1000);
    expect(await shouldSkipIdleIncrement(atmuxDir, "alpha", 0, 1100)).toBe(false);
  });

  test("inProgressCount<0 → don't skip (defensive)", async () => {
    expect(await shouldSkipIdleIncrement(atmuxDir, "alpha", -1, 1000)).toBe(false);
  });

  test("absent heartbeat + inProgress non-empty → don't skip (treat as unknown)", async () => {
    expect(await shouldSkipIdleIncrement(atmuxDir, "alpha", 1, 1000)).toBe(false);
  });

  test("fresh heartbeat + inProgress non-empty → SKIP", async () => {
    await writeHeartbeat(atmuxDir, "alpha", 1000);
    expect(await shouldSkipIdleIncrement(atmuxDir, "alpha", 1, 1100)).toBe(true);
  });

  test("stale heartbeat (>5min) + inProgress non-empty → don't skip", async () => {
    await writeHeartbeat(atmuxDir, "alpha", 1000);
    expect(
      await shouldSkipIdleIncrement(atmuxDir, "alpha", 1, 1000 + DEFAULT_FRESH_HEARTBEAT_SEC + 1),
    ).toBe(false);
  });

  test("custom freshSec respected", async () => {
    await writeHeartbeat(atmuxDir, "alpha", 1000);
    expect(await shouldSkipIdleIncrement(atmuxDir, "alpha", 1, 1050, { freshSec: 100 })).toBe(true);
    expect(await shouldSkipIdleIncrement(atmuxDir, "alpha", 1, 1101, { freshSec: 100 })).toBe(
      false,
    );
  });

  test("boundary case: heartbeat exactly at freshSec → SKIP (≤ inclusive)", async () => {
    await writeHeartbeat(atmuxDir, "alpha", 1000);
    expect(
      await shouldSkipIdleIncrement(atmuxDir, "alpha", 1, 1000 + DEFAULT_FRESH_HEARTBEAT_SEC),
    ).toBe(true);
  });
});
