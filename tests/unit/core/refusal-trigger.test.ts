// Unit tests for src/core/refusal-trigger.ts (ADR-139 T4 / t-a830d2ee).
//
// The trigger module sits between SCAN+RECORD (T3) and rotate-fire
// (`atmux rotate`). Every collaborator (DB, spawn, clock, fs append,
// Discord send) is dep-injected — tests construct in-memory DBs
// pre-seeded with refusal_events rows + spy on the spawn / Discord
// channels.
//
// Coverage:
//   - enabled=false → all members `disabled`, no spawn / no Discord
//   - exempt member → outcome=`exempt`, no spawn
//   - no events for member → outcome=`skip-no-events`
//   - below threshold (1 soft) → outcome=`skip-below-threshold`
//   - soft threshold crossed (3 soft) → outcome=`rotate-fired`,
//     spawnAtmux called with ['rotate', member], log row appended,
//     Discord rendered with verdict=🟡
//   - hard threshold crossed (2 hard) → outcome=`rotate-fired`,
//     triggeringClass='hard'
//   - role threshold crossed (1 role) → outcome=`rotate-fired`,
//     triggeringClass='role'
//   - cap-hit (3 rotations already today + threshold crosses) →
//     outcome=`cap-hit-escalated`, no spawn, complaint filed,
//     Discord verdict=🚨
//   - spawn returns non-zero exit → outcome=`rotate-fired` with
//     [spawn-failed] suffix in reason, Discord escalation='spawn-failed'

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import { ensureDir } from "../../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { recordRefusalEvent } from "../../../src/core/refusal-scan.ts";
import { runRefusalTriggerForTeam, type SpawnAtmuxFn } from "../../../src/core/refusal-trigger.ts";
import type { Team } from "../../../src/schema/team.ts";

interface Env {
  scratch: string;
  atmuxDir: string;
  db: Database;
}
let env: Env;

beforeEach(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "atmux-refusal-trigger-"));
  const atmuxDir = join(scratch, ".atmux");
  await ensureDir(join(atmuxDir, "state"));
  const db = openDatabase(":memory:", migrations);
  env = { scratch, atmuxDir, db };
});

afterEach(async () => {
  closeDatabase(env.db);
  await rm(env.scratch, { recursive: true, force: true });
});

function team(members: string[], overrides: Partial<Team["refusalDetection"]> = {}): Team {
  return {
    name: "demo",
    members: members.map((n) => ({ name: n })),
    refusalDetection: { ...overrides },
  } as unknown as Team;
}

function recordedSpawn(): { spawn: SpawnAtmuxFn; calls: string[][] } {
  const calls: string[][] = [];
  return {
    spawn: async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    calls,
  };
}

function failingSpawn(): SpawnAtmuxFn {
  return async () => ({ exitCode: 1, stdout: "", stderr: "rotate refused" });
}

function recordedDiscord(): {
  send: (opts: DiscordSendOpts) => Promise<void>;
  calls: DiscordSendOpts[];
} {
  const calls: DiscordSendOpts[] = [];
  return {
    send: async (opts) => {
      calls.push(opts);
    },
    calls,
  };
}

function seedSoft(member: string, count: number, baseSec: number): void {
  for (let i = 0; i < count; i += 1) {
    recordRefusalEvent(env.db, baseSec - i * 120, {
      member,
      team: "demo",
      result: {
        detected: true,
        severity: "soft",
        confidence: 0.5,
        phrases: [{ phrase: "fatigue", class: "soft" }],
      },
    });
  }
}

function seedHard(member: string, count: number, baseSec: number): void {
  // 60s spacing keeps up to 9 events within the 10min HARD_REFUSAL_WINDOW
  // when nowSec is baseSec+500. Pre-fix used 120s spacing which left the
  // 2nd-and-later events 20s past the window — silent fixture rot.
  for (let i = 0; i < count; i += 1) {
    recordRefusalEvent(env.db, baseSec - i * 60, {
      member,
      team: "demo",
      result: {
        detected: true,
        severity: "hard",
        confidence: 0.8,
        phrases: [{ phrase: "i-refuse-to-work", class: "hard" }],
      },
    });
  }
}

function seedRole(member: string, baseSec: number): void {
  recordRefusalEvent(env.db, baseSec, {
    member,
    team: "demo",
    result: {
      detected: true,
      severity: "role",
      confidence: 0.95,
      phrases: [{ phrase: "rotate-me", class: "role" }],
    },
  });
}

describe("runRefusalTriggerForTeam — outer gates", () => {
  test("enabled=false short-circuits every member to `disabled`", async () => {
    const { spawn, calls } = recordedSpawn();
    const dc = recordedDiscord();
    seedSoft("alice", 5, 10000); // would otherwise fire
    const r = await runRefusalTriggerForTeam(team(["alice", "bob"], { enabled: false }), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      sendDiscord: dc.send,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.rotated).toBe(0);
    expect(r.skipped).toBe(2);
    expect(calls).toHaveLength(0);
    expect(dc.calls).toHaveLength(0);
    expect(r.perMember.map((p) => p.outcome)).toEqual(["disabled", "disabled"]);
  });

  test("exempt members are skipped before threshold check", async () => {
    const { spawn, calls } = recordedSpawn();
    const dc = recordedDiscord();
    seedSoft("alice", 5, 10000);
    const r = await runRefusalTriggerForTeam(team(["alice"], { exemptMembers: ["alice"] }), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      sendDiscord: dc.send,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.exempt).toBe(1);
    expect(r.rotated).toBe(0);
    expect(calls).toHaveLength(0);
    expect(r.perMember[0]?.outcome).toBe("exempt");
  });

  test("no events for member → skip-no-events", async () => {
    const { spawn, calls } = recordedSpawn();
    const r = await runRefusalTriggerForTeam(team(["alice"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      nowSec: () => 10000,
      log: () => {},
    });
    expect(r.skipped).toBe(1);
    expect(calls).toHaveLength(0);
    expect(r.perMember[0]?.outcome).toBe("skip-no-events");
  });

  test("below threshold (1 soft) → skip-below-threshold", async () => {
    const { spawn, calls } = recordedSpawn();
    seedSoft("alice", 1, 10000);
    const r = await runRefusalTriggerForTeam(team(["alice"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.rotated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(calls).toHaveLength(0);
    expect(r.perMember[0]?.outcome).toBe("skip-below-threshold");
  });
});

describe("runRefusalTriggerForTeam — threshold-crossing paths", () => {
  test("3 soft events crosses default threshold → rotate-fired", async () => {
    const { spawn, calls } = recordedSpawn();
    const dc = recordedDiscord();
    seedSoft("alice", 3, 10000);
    const r = await runRefusalTriggerForTeam(team(["alice"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      sendDiscord: dc.send,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.rotated).toBe(1);
    expect(calls).toEqual([["rotate", "alice"]]);
    expect(r.perMember[0]?.outcome).toBe("rotate-fired");
    expect(r.perMember[0]?.triggeringClass).toBe("soft");
    expect(r.perMember[0]?.rotationsToday).toBe(1);
    expect(dc.calls).toHaveLength(1);
    expect(dc.calls[0]?.template).toBe("member-refusal-rotate");
    expect(dc.calls[0]?.verdict).toContain("🟡");
  });

  test("2 hard events crosses hard threshold → rotate-fired (class=hard)", async () => {
    const { spawn, calls } = recordedSpawn();
    seedHard("bob", 2, 10000);
    const r = await runRefusalTriggerForTeam(team(["bob"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.rotated).toBe(1);
    expect(calls).toEqual([["rotate", "bob"]]);
    expect(r.perMember[0]?.triggeringClass).toBe("hard");
  });

  test("1 role event → rotate-fired (class=role, instant)", async () => {
    const { spawn, calls } = recordedSpawn();
    seedRole("carol", 10000);
    const r = await runRefusalTriggerForTeam(team(["carol"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.rotated).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.perMember[0]?.triggeringClass).toBe("role");
  });
});

describe("runRefusalTriggerForTeam — cap-hit + failure paths", () => {
  test("cap-hit emits HARD escalation without spawning rotate", async () => {
    const { spawn, calls: spawnCalls } = recordedSpawn();
    const dc = recordedDiscord();
    seedSoft("alice", 3, 10000);

    // Pre-seed the rotations log with 3 fires (today's UTC day).
    const utcDay = new Date(10500 * 1000).toISOString().slice(0, 10);
    const iso = new Date(10500 * 1000).toISOString();
    const logPath = join(env.atmuxDir, "state", "refusal-rotations.log");
    const Bunfs = Bun.file(logPath);
    await Bun.write(
      Bunfs,
      `${iso}\t${utcDay}\tdemo\talice\tsoft\tcap-seed-1\n` +
        `${iso}\t${utcDay}\tdemo\talice\tsoft\tcap-seed-2\n` +
        `${iso}\t${utcDay}\tdemo\talice\tsoft\tcap-seed-3\n`,
    );

    const r = await runRefusalTriggerForTeam(team(["alice"], { maxRotationsPerDay: 3 }), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      sendDiscord: dc.send,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.capHit).toBe(1);
    expect(r.rotated).toBe(0);
    expect(spawnCalls).toHaveLength(0);
    expect(r.perMember[0]?.outcome).toBe("cap-hit-escalated");
    expect(r.perMember[0]?.rotationsToday).toBe(3);
    expect(dc.calls).toHaveLength(1);
    expect(dc.calls[0]?.verdict).toContain("🚨");
    // Complaint should have landed in the in-memory state.db.
    const complaintRows = env.db.prepare("SELECT * FROM complaints").all();
    expect(complaintRows.length).toBeGreaterThan(0);
  });

  test("spawn failure marks rotate-fired but Discord escalation=spawn-failed", async () => {
    const dc = recordedDiscord();
    seedSoft("alice", 3, 10000);
    const r = await runRefusalTriggerForTeam(team(["alice"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: failingSpawn(),
      sendDiscord: dc.send,
      nowSec: () => 10500,
      log: () => {},
    });
    expect(r.rotated).toBe(1);
    expect(r.perMember[0]?.outcome).toBe("rotate-fired");
    expect(r.perMember[0]?.reason).toContain("[spawn-failed");
    expect(dc.calls).toHaveLength(1);
    // verdict carries the 🚨 marker on spawn-failed path
    expect(dc.calls[0]?.verdict).toContain("🚨");
  });
});

describe("runRefusalTriggerForTeam — log file format", () => {
  test("rotation log row uses tab-separated columns with UTC day-key", async () => {
    const { spawn } = recordedSpawn();
    seedSoft("alice", 3, 10000);
    await runRefusalTriggerForTeam(team(["alice"]), {
      db: env.db,
      atmuxDir: env.atmuxDir,
      spawnAtmux: spawn,
      nowSec: () => 10500,
      log: () => {},
    });
    const logPath = join(env.atmuxDir, "state", "refusal-rotations.log");
    const body = await Bun.file(logPath).text();
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const cols = lines[0]?.split("\t") ?? [];
    expect(cols).toHaveLength(6);
    expect(cols[2]).toBe("demo");
    expect(cols[3]).toBe("alice");
    expect(cols[4]).toBe("soft");
    // UTC day-key is "YYYY-MM-DD" — exact text doesn't matter, but
    // shape must match.
    expect(cols[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
