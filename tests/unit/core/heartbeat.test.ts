// Unit tests for src/core/heartbeat.ts (ADR-057 §D6a R57-T6).
//
// Heartbeat write/read primitives + staleness detection.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEARTBEAT_STALE_SEC,
  heartbeatPath,
  heartbeatsDir,
  HEARTBEATS_DIRNAME,
  isHeartbeatStale,
  readHeartbeat,
  readHeartbeatAges,
  writeHeartbeat,
} from "../../../src/core/heartbeat.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-heartbeat-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Constants + paths ----------

describe("constants + paths", () => {
  test("HEARTBEATS_DIRNAME is 'heartbeats'", () => {
    expect(HEARTBEATS_DIRNAME).toBe("heartbeats");
  });

  test("DEFAULT_HEARTBEAT_STALE_SEC is 300 (5min)", () => {
    expect(DEFAULT_HEARTBEAT_STALE_SEC).toBe(300);
  });

  test("heartbeatsDir appends heartbeats/ to atmuxDir", () => {
    expect(heartbeatsDir("/tmp/foo")).toBe("/tmp/foo/heartbeats");
  });

  test("heartbeatPath appends heartbeats/<member>.epoch", () => {
    expect(heartbeatPath("/tmp/foo", "alice")).toBe("/tmp/foo/heartbeats/alice.epoch");
  });
});

// ---------- writeHeartbeat ----------

describe("writeHeartbeat", () => {
  test("creates the heartbeats dir + writes <epoch>\\n", async () => {
    await writeHeartbeat(atmuxDir, "alice", 1700000000);
    const text = await readFile(heartbeatPath(atmuxDir, "alice"), "utf8");
    expect(text).toBe("1700000000\n");
  });

  test("default epochSec uses real clock (within 2s of now)", async () => {
    const before = Math.floor(Date.now() / 1000);
    await writeHeartbeat(atmuxDir, "alice");
    const after = Math.floor(Date.now() / 1000);
    const epoch = await readHeartbeat(atmuxDir, "alice");
    expect(epoch).not.toBeNull();
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(after);
  });

  test("re-writing overwrites the previous heartbeat", async () => {
    await writeHeartbeat(atmuxDir, "alice", 100);
    await writeHeartbeat(atmuxDir, "alice", 999);
    expect(await readHeartbeat(atmuxDir, "alice")).toBe(999);
  });

  test("multi-member heartbeats live in separate files", async () => {
    await writeHeartbeat(atmuxDir, "alice", 100);
    await writeHeartbeat(atmuxDir, "bob", 200);
    expect(await readHeartbeat(atmuxDir, "alice")).toBe(100);
    expect(await readHeartbeat(atmuxDir, "bob")).toBe(200);
  });
});

// ---------- readHeartbeat ----------

describe("readHeartbeat", () => {
  test("returns null when heartbeat file is absent", async () => {
    expect(await readHeartbeat(atmuxDir, "ghost")).toBeNull();
  });

  test("returns null on empty file", async () => {
    await mkdir(heartbeatsDir(atmuxDir), { recursive: true });
    await writeFile(heartbeatPath(atmuxDir, "alice"), "");
    expect(await readHeartbeat(atmuxDir, "alice")).toBeNull();
  });

  test("returns null on whitespace-only content", async () => {
    await mkdir(heartbeatsDir(atmuxDir), { recursive: true });
    await writeFile(heartbeatPath(atmuxDir, "alice"), "   \n");
    expect(await readHeartbeat(atmuxDir, "alice")).toBeNull();
  });

  test("returns null on unparseable content", async () => {
    await mkdir(heartbeatsDir(atmuxDir), { recursive: true });
    await writeFile(heartbeatPath(atmuxDir, "alice"), "not-a-number\n");
    expect(await readHeartbeat(atmuxDir, "alice")).toBeNull();
  });

  test("returns null on negative epoch (defensive)", async () => {
    await mkdir(heartbeatsDir(atmuxDir), { recursive: true });
    await writeFile(heartbeatPath(atmuxDir, "alice"), "-500\n");
    expect(await readHeartbeat(atmuxDir, "alice")).toBeNull();
  });

  test("trims trailing whitespace + parses cleanly", async () => {
    await mkdir(heartbeatsDir(atmuxDir), { recursive: true });
    await writeFile(heartbeatPath(atmuxDir, "alice"), "1700000000\n\n");
    expect(await readHeartbeat(atmuxDir, "alice")).toBe(1700000000);
  });
});

// ---------- isHeartbeatStale ----------

describe("isHeartbeatStale", () => {
  test("true when heartbeat is absent (no signal = stale)", async () => {
    expect(await isHeartbeatStale(atmuxDir, "ghost", 1700000000)).toBe(true);
  });

  test("false when heartbeat is fresh (within threshold)", async () => {
    await writeHeartbeat(atmuxDir, "alice", 1700000000);
    expect(await isHeartbeatStale(atmuxDir, "alice", 1700000010)).toBe(false);
  });

  test("false at the boundary (age == threshold)", async () => {
    await writeHeartbeat(atmuxDir, "alice", 1700000000);
    expect(await isHeartbeatStale(atmuxDir, "alice", 1700000000 + 300, 300)).toBe(false);
  });

  test("true when age > threshold", async () => {
    await writeHeartbeat(atmuxDir, "alice", 1700000000);
    expect(await isHeartbeatStale(atmuxDir, "alice", 1700000000 + 301, 300)).toBe(true);
  });

  test("custom staleSec override is honored", async () => {
    await writeHeartbeat(atmuxDir, "alice", 1700000000);
    expect(await isHeartbeatStale(atmuxDir, "alice", 1700000060, 30)).toBe(true);
    expect(await isHeartbeatStale(atmuxDir, "alice", 1700000060, 120)).toBe(false);
  });
});

// ---------- readHeartbeatAges ----------

describe("readHeartbeatAges", () => {
  test("returns ageSec=null for members with no heartbeat", async () => {
    const ages = await readHeartbeatAges(atmuxDir, ["ghost"], 1700000000);
    expect(ages).toEqual([{ member: "ghost", ageSec: null }]);
  });

  test("computes age relative to nowSec for present heartbeats", async () => {
    await writeHeartbeat(atmuxDir, "alice", 1700000000);
    const ages = await readHeartbeatAges(atmuxDir, ["alice"], 1700000060);
    expect(ages).toEqual([{ member: "alice", ageSec: 60 }]);
  });

  test("returns one entry per requested member, in input order", async () => {
    await writeHeartbeat(atmuxDir, "alice", 100);
    await writeHeartbeat(atmuxDir, "charlie", 200);
    const ages = await readHeartbeatAges(atmuxDir, ["alice", "bob", "charlie"], 1000);
    expect(ages.map((a) => a.member)).toEqual(["alice", "bob", "charlie"]);
    expect(ages[0]?.ageSec).toBe(900);
    expect(ages[1]?.ageSec).toBeNull();
    expect(ages[2]?.ageSec).toBe(800);
  });

  test("empty member list → empty result", async () => {
    expect(await readHeartbeatAges(atmuxDir, [], 1000)).toEqual([]);
  });

  test("corrupt heartbeat file → ageSec=null (defensive)", async () => {
    await mkdir(heartbeatsDir(atmuxDir), { recursive: true });
    await writeFile(heartbeatPath(atmuxDir, "alice"), "garbage\n");
    const ages = await readHeartbeatAges(atmuxDir, ["alice"], 1000);
    expect(ages[0]?.ageSec).toBeNull();
  });
});
