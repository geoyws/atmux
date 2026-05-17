// Unit tests for src/verbs/heartbeat.ts (ADR-057 §D6a R57-T6 producer).
//
// Coverage:
//   - parseHeartbeatArgs: missing sub / unknown sub / missing member /
//     unknown flag / --team-dir wired through / positional member.
//   - heartbeat verb: writes per-member epoch file via writeHeartbeat;
//     honors --team-dir; honors clock injection (opts.now); idempotent
//     (re-runs overwrite); default clock approximates real time.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatPath, readHeartbeat } from "../../../src/core/heartbeat.ts";
import { UsageError } from "../../../src/errors.ts";
import { heartbeat, parseHeartbeatArgs } from "../../../src/verbs/heartbeat.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-heartbeat-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- parseHeartbeatArgs ----------

describe("parseHeartbeatArgs", () => {
  test("missing subverb → UsageError", () => {
    expect(() => parseHeartbeatArgs([])).toThrow(UsageError);
  });

  test("empty subverb → UsageError", () => {
    expect(() => parseHeartbeatArgs([""])).toThrow(UsageError);
  });

  test("unknown subverb → UsageError naming the input", () => {
    let caught: unknown = null;
    try {
      parseHeartbeatArgs(["read", "alice"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const ctx = (caught as UsageError).context as { what: string };
    expect(ctx.what).toContain("read");
  });

  test("write with no member → UsageError", () => {
    expect(() => parseHeartbeatArgs(["write"])).toThrow(UsageError);
  });

  test("write with positional member parses", () => {
    expect(parseHeartbeatArgs(["write", "alice"])).toEqual({
      sub: "write",
      member: "alice",
    });
  });

  test("write with --team-dir captures override", () => {
    expect(parseHeartbeatArgs(["write", "alice", "--team-dir", "/tmp/x"])).toEqual({
      sub: "write",
      member: "alice",
      teamDir: "/tmp/x",
    });
  });

  test("--team-dir before member also works", () => {
    expect(parseHeartbeatArgs(["write", "--team-dir", "/tmp/x", "alice"])).toEqual({
      sub: "write",
      member: "alice",
      teamDir: "/tmp/x",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseHeartbeatArgs(["write", "alice", "--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseHeartbeatArgs(["write", "alice", "--bogus"])).toThrow(UsageError);
  });

  test("duplicate positional → UsageError (only one member arg)", () => {
    expect(() => parseHeartbeatArgs(["write", "alice", "bob"])).toThrow(UsageError);
  });
});

// ---------- heartbeat verb ----------

describe("heartbeat write verb", () => {
  test("writes <atmuxDir>/heartbeats/<member>.epoch with clock injection", async () => {
    const code = await heartbeat(["write", "alice", "--team-dir", teamDir], {
      now: () => 1_700_000_000_000,
    });
    expect(code).toBe(0);
    const text = await readFile(heartbeatPath(atmuxDir, "alice"), "utf8");
    expect(text).toBe("1700000000\n");
  });

  test("returns 0 on success", async () => {
    const code = await heartbeat(["write", "bob", "--team-dir", teamDir], {
      now: () => 1_700_000_000_000,
    });
    expect(code).toBe(0);
  });

  test("default clock uses real time (within 2s of now)", async () => {
    const before = Math.floor(Date.now() / 1000);
    await heartbeat(["write", "alice", "--team-dir", teamDir]);
    const after = Math.floor(Date.now() / 1000);
    const epoch = await readHeartbeat(atmuxDir, "alice");
    expect(epoch).not.toBeNull();
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(after);
  });

  test("idempotent — re-run overwrites previous epoch", async () => {
    await heartbeat(["write", "alice", "--team-dir", teamDir], { now: () => 100_000 });
    await heartbeat(["write", "alice", "--team-dir", teamDir], { now: () => 999_000 });
    expect(await readHeartbeat(atmuxDir, "alice")).toBe(999);
  });

  test("multi-member writes are isolated to per-member files", async () => {
    await heartbeat(["write", "alice", "--team-dir", teamDir], { now: () => 100_000 });
    await heartbeat(["write", "bob", "--team-dir", teamDir], { now: () => 200_000 });
    expect(await readHeartbeat(atmuxDir, "alice")).toBe(100);
    expect(await readHeartbeat(atmuxDir, "bob")).toBe(200);
  });

  test("creates the heartbeats/ dir on first write (no pre-init required)", async () => {
    // teamDir is fresh in beforeEach with only .atmux/ present — no
    // .atmux/heartbeats/ yet. Verifies writeHeartbeat's directory
    // bootstrap fires through the verb layer.
    await heartbeat(["write", "alice", "--team-dir", teamDir], { now: () => 5_000_000 });
    const epoch = await readHeartbeat(atmuxDir, "alice");
    expect(epoch).toBe(5_000);
  });

  test("propagates parse errors (missing member surfaces UsageError)", async () => {
    let caught: unknown = null;
    try {
      await heartbeat(["write"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UsageError);
  });
});
