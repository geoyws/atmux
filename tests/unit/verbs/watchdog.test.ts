// Unit tests for src/verbs/watchdog.ts (ADR-057 §D6b R57-T6).
//
// Coverage:
//   - parseWatchdogArgs (defaults, --no-discord, --team-dir, errors).
//   - watchdog all-fresh → no fire.
//   - watchdog stale member → fire + state recorded + audit-logged.
//   - watchdog dedup (24h re-fire window).
//   - watchdog --no-discord suppresses pings entirely.
//   - watchdog reads heartbeatStaleSec from team.json::stallPrevention.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import { writeHeartbeat } from "../../../src/core/heartbeat.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  parseWatchdogArgs,
  WATCHDOG_REFIRE_WINDOW_SEC,
  WATCHDOG_STATE_FILENAME,
  watchdog,
  watchdogLogPath,
  watchdogStatePath,
} from "../../../src/verbs/watchdog.ts";

let teamDir: string;
let atmuxDir: string;
let stdoutBuf: string;
let stderrBuf: string;
const stdout = (s: string): void => {
  stdoutBuf += s;
};
const stderr = (s: string): void => {
  stderrBuf += s;
};

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-watchdog-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  stdoutBuf = "";
  stderrBuf = "";
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function seedTeam(members: Array<{ name: string }>): Promise<void> {
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members }));
}

// ---------- parseWatchdogArgs ----------

describe("parseWatchdogArgs", () => {
  test("defaults", () => {
    expect(parseWatchdogArgs([])).toEqual({ pushDiscord: true });
  });

  test("--no-discord flips pushDiscord", () => {
    expect(parseWatchdogArgs(["--no-discord"])).toEqual({ pushDiscord: false });
  });

  test("--team-dir captured", () => {
    expect(parseWatchdogArgs(["--team-dir", "/tmp/foo"])).toEqual({
      pushDiscord: true,
      teamDir: "/tmp/foo",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseWatchdogArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseWatchdogArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- watchdog state file constants ----------

describe("watchdog constants", () => {
  test("WATCHDOG_STATE_FILENAME is watchdog-state.json", () => {
    expect(WATCHDOG_STATE_FILENAME).toBe("watchdog-state.json");
  });

  test("WATCHDOG_REFIRE_WINDOW_SEC is 24h", () => {
    expect(WATCHDOG_REFIRE_WINDOW_SEC).toBe(24 * 60 * 60);
  });

  test("watchdogStatePath / watchdogLogPath", () => {
    expect(watchdogStatePath("/tmp/foo")).toBe("/tmp/foo/state/watchdog-state.json");
    expect(watchdogLogPath("/tmp/foo")).toBe("/tmp/foo/logs/watchdog.log");
  });
});

// ---------- watchdog — happy path (all fresh) ----------

describe("watchdog all-heartbeats-fresh", () => {
  test("no stale members → no Discord ping, exit 0, stdout reports clean", async () => {
    await seedTeam([{ name: "alice" }, { name: "bob" }]);
    // Both members have fresh heartbeats.
    const nowSec = 1700000000;
    await writeHeartbeat(atmuxDir, "alice", nowSec - 10);
    await writeHeartbeat(atmuxDir, "bob", nowSec - 20);
    const sent: DiscordSendOpts[] = [];
    const exit = await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("all heartbeats fresh");
    expect(sent).toHaveLength(0);
  });
});

// ---------- watchdog — stale detection ----------

describe("watchdog stale members", () => {
  test("absent heartbeat → flagged stale + Discord fired + state recorded", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    // No heartbeat written for alice.
    const sent: DiscordSendOpts[] = [];
    const exit = await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(exit).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.template).toBe("whip-watchdog");
    // Verdict-first shape (CLAUDE.md §Discord, 2026-05-13) — headline lives in
    // `verdict`, per-member detail stays in bullets.
    expect(sent[0]?.verdict).toContain("1 member silent");
    const bullets = sent[0]?.bullets ?? [];
    expect(bullets.some((b) => b.includes("alice: never stale"))).toBe(true);

    // State recorded.
    const state = JSON.parse(await readFile(watchdogStatePath(atmuxDir), "utf8"));
    expect(state.alice).toBe(nowSec);
  });

  test("heartbeat older than threshold → flagged stale + Discord fired", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    // Heartbeat 600s old, threshold default 300s.
    await writeHeartbeat(atmuxDir, "alice", nowSec - 600);
    const sent: DiscordSendOpts[] = [];
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(1);
    const bullets = sent[0]?.bullets ?? [];
    // Age formatted via formatDuration ("10min").
    expect(bullets.some((b) => b.includes("alice:") && b.includes("min"))).toBe(true);
  });

  test("multiple stale members → single ping with all listed", async () => {
    await seedTeam([{ name: "alice" }, { name: "bob" }, { name: "charlie" }]);
    const nowSec = 1700000000;
    // alice + bob stale; charlie fresh.
    await writeHeartbeat(atmuxDir, "alice", nowSec - 600);
    await writeHeartbeat(atmuxDir, "bob", nowSec - 700);
    await writeHeartbeat(atmuxDir, "charlie", nowSec - 10);
    const sent: DiscordSendOpts[] = [];
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(1);
    // Verdict-first shape — headline lives in `verdict`.
    expect(sent[0]?.verdict).toContain("2 members silent");
    const bullets = sent[0]?.bullets ?? [];
    expect(bullets.some((b) => b.includes("alice"))).toBe(true);
    expect(bullets.some((b) => b.includes("bob"))).toBe(true);
    expect(bullets.some((b) => b.includes("charlie"))).toBe(false);
  });

  test("audit log line written per stale member regardless of dedup", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async () => {},
    });
    const log = await readFile(watchdogLogPath(atmuxDir), "utf8");
    expect(log).toContain("member=alice");
    expect(log).toContain("reason=stale-heartbeat");
  });
});

// ---------- watchdog — dedup ----------

describe("watchdog dedup (24h re-fire window)", () => {
  test("second tick within 24h on same stale member → no second ping", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    const sent: DiscordSendOpts[] = [];
    const opts = {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    };
    await watchdog(["--team-dir", teamDir], opts);
    await watchdog(["--team-dir", teamDir], opts); // same nowSec
    expect(sent).toHaveLength(1); // dedup'd
    expect(stderrBuf).toContain("dedup window");
  });

  test("re-fire after 24h elapse", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec1 = 1700000000;
    const sent: DiscordSendOpts[] = [];
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec1 * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(1);
    // 24h+1s later — re-fire allowed.
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => (nowSec1 + WATCHDOG_REFIRE_WINDOW_SEC + 1) * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(2);
  });

  test("different members independently dedup'd", async () => {
    await seedTeam([{ name: "alice" }, { name: "bob" }]);
    const nowSec1 = 1700000000;
    const sent: DiscordSendOpts[] = [];
    // First tick: only alice stale (bob fresh).
    await writeHeartbeat(atmuxDir, "bob", nowSec1 - 10);
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec1 * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(1);
    // Second tick: bob also stale now.
    const nowSec2 = nowSec1 + 600;
    sent.length = 0;
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec2 * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(1);
    // The second ping should reference bob (alice still in dedup window).
    // Verdict-first shape — headline lives in `verdict`.
    expect(sent[0]?.verdict).toContain("1 member silent");
    const bullets = sent[0]?.bullets ?? [];
    expect(bullets.some((b) => b.includes("bob"))).toBe(true);
  });
});

// ---------- watchdog — opts ----------

describe("watchdog opts", () => {
  test("--no-discord suppresses Discord but still records state", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    const sent: DiscordSendOpts[] = [];
    await watchdog(["--no-discord", "--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(0);
    // State still recorded so subsequent ticks dedup.
    const state = JSON.parse(await readFile(watchdogStatePath(atmuxDir), "utf8"));
    expect(state.alice).toBe(nowSec);
  });

  test("staleSec opt override is honored (low threshold catches younger heartbeats)", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    await writeHeartbeat(atmuxDir, "alice", nowSec - 60); // 60s old
    const sent: DiscordSendOpts[] = [];
    await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      staleSec: 30, // tighter threshold
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
    });
    expect(sent).toHaveLength(1);
  });

  // Note: ADR-054 made TeamWhip strict, so `team.json::whip.
  // stallPrevention.heartbeatStaleSec` cannot land on the typed shape
  // without a schema bump. The verb's `readStaleSecFromTeam` reader is
  // kept defensively for a future TeamWhip extension; a `staleSec` opt
  // override is the supported test injection point today.

  test("Discord send failure is non-fatal (state still recorded)", async () => {
    await seedTeam([{ name: "alice" }]);
    const nowSec = 1700000000;
    const exit = await watchdog(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowSec * 1000,
      discordSend: async () => {
        throw new Error("network down");
      },
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("Discord send failed");
    // State still recorded.
    const state = JSON.parse(await readFile(watchdogStatePath(atmuxDir), "utf8"));
    expect(state.alice).toBe(nowSec);
  });
});
