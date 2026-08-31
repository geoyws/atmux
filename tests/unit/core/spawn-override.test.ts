// Unit tests for src/core/spawn-override.ts.
//
// Strategy: scratch $HOME via mkdtemp + injected `now` clock so the
// JSONL audit line is deterministic. Read the file back raw to verify
// exact payload shape, newline termination, and append-only behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SPAWN_OVERRIDES_LOG_REL,
  logSpawnOverride,
  type SpawnOverrideRecord,
} from "../../../src/core/spawn-override.ts";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-spawn-override-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const NOW_ONE = 1_779_999_123_456;
const NOW_TWO = 1_779_999_789_012;

function logPath(homeDir: string): string {
  return join(homeDir, DEFAULT_SPAWN_OVERRIDES_LOG_REL);
}

function expectedLine(record: SpawnOverrideRecord, nowMs: number): string {
  return `${JSON.stringify({
    ts: Math.floor(nowMs / 1000),
    iso: new Date(nowMs).toISOString(),
    epicId: record.epicId,
    team: record.team,
    blockers: record.blockers,
    callerMember: record.callerMember,
    callerScope: record.callerScope,
  })}\n`;
}

async function readLog(homeDir: string): Promise<string> {
  return await readFile(logPath(homeDir), "utf8");
}

describe("spawn-override audit log", () => {
  test("default log path constant is the fleet-level JSONL file", () => {
    expect(DEFAULT_SPAWN_OVERRIDES_LOG_REL).toBe(".atmux/state/spawn-overrides.log");
  });

  test("writes one exact JSONL record with a trailing newline", async () => {
    const record: SpawnOverrideRecord = {
      epicId: "e-abc12345",
      team: "team-alpha",
      blockers: ["draft-epic", "missing-parent"],
      callerMember: "george",
      callerScope: "driver",
    };

    await logSpawnOverride(record, { homeDir: scratch, now: () => NOW_ONE });

    const raw = await readLog(scratch);
    expect(raw).toBe(expectedLine(record, NOW_ONE));
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("two calls append two records in order without overwriting", async () => {
    const first: SpawnOverrideRecord = {
      epicId: "e-first",
      team: "team-alpha",
      blockers: ["draft-epic"],
      callerMember: "alice",
      callerScope: "driver",
    };
    const second: SpawnOverrideRecord = {
      epicId: "e-second",
      team: "team-beta",
      blockers: ["blocked-by-parent", "no-leases"],
      callerMember: "bob",
      callerScope: "driver",
    };

    await logSpawnOverride(first, { homeDir: scratch, now: () => NOW_ONE });
    expect(await readLog(scratch)).toBe(expectedLine(first, NOW_ONE));

    await logSpawnOverride(second, { homeDir: scratch, now: () => NOW_TWO });
    expect(await readLog(scratch)).toBe(
      `${expectedLine(first, NOW_ONE)}${expectedLine(second, NOW_TWO)}`,
    );
  });
});
