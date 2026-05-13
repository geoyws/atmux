// Unit tests for src/verbs/pulse.ts (ADR-086 Phase 1).
//
// Coverage:
//   - parsePulseArgs branches.
//   - entryHasTriageMarker + countBluePendingDecisions.
//   - gatherTeamInputs: commit count from git, kanban counts, driver-inbox
//     stale split, pending decisions, doctor red.
//   - pulse verb: 3-team fixture (one 🟢, one 🔴, one 🚨); assert exactly
//     2-3 Discord sends + state-file written.
//
// Discord I/O mocked via discordSend recorder. Determinism via injected
// now() + gitSpawn shim.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import type {
  GitSpawn,
} from "../../../src/abstractions/worktree.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  countBluePendingDecisions,
  entryHasTriageMarker,
  parsePulseArgs,
  pulse,
} from "../../../src/verbs/pulse.ts";

let home: string;
let cockpitPath: string;
let teamA: string;
let teamB: string;
let teamC: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atmux-pulse-test-"));
  teamA = await mkdtemp(join(tmpdir(), "atmux-pulse-team-a-"));
  teamB = await mkdtemp(join(tmpdir(), "atmux-pulse-team-b-"));
  teamC = await mkdtemp(join(tmpdir(), "atmux-pulse-team-c-"));
  cockpitPath = join(home, ".atmux", "cockpit.json");
  await mkdir(join(home, ".atmux"), { recursive: true });
  await mkdir(join(teamA, ".atmux"), { recursive: true });
  await mkdir(join(teamB, ".atmux"), { recursive: true });
  await mkdir(join(teamC, ".atmux"), { recursive: true });
  await writeFile(
    join(teamA, ".atmux", "team.json"),
    JSON.stringify({ name: "alpha", members: [] }),
  );
  await writeFile(
    join(teamB, ".atmux", "team.json"),
    JSON.stringify({ name: "beta", members: [] }),
  );
  await writeFile(
    join(teamC, ".atmux", "team.json"),
    JSON.stringify({ name: "gamma", members: [] }),
  );
  await writeFile(
    cockpitPath,
    JSON.stringify({
      cockpitSession: "atmux_teams",
      teams: [
        { name: "alpha", root: teamA, enabled: true },
        { name: "beta", root: teamB, enabled: true },
        { name: "gamma", root: teamC, enabled: true },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(teamA, { recursive: true, force: true });
  await rm(teamB, { recursive: true, force: true });
  await rm(teamC, { recursive: true, force: true });
});

// ---------- parsePulseArgs ----------

describe("parsePulseArgs", () => {
  test("defaults", () => {
    expect(parsePulseArgs([])).toEqual({ json: false, ping: false });
  });
  test("--json", () => {
    expect(parsePulseArgs(["--json"])).toEqual({ json: true, ping: false });
  });
  test("--ping", () => {
    expect(parsePulseArgs(["--ping"])).toEqual({ json: false, ping: true });
  });
  test("--config takes a path", () => {
    expect(parsePulseArgs(["--config", "/tmp/c.json"])).toEqual({
      json: false,
      ping: false,
      configPath: "/tmp/c.json",
    });
  });
  test("--config without value throws UsageError", () => {
    expect(() => parsePulseArgs(["--config"])).toThrow(UsageError);
  });
  test("unknown flag throws UsageError", () => {
    expect(() => parsePulseArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- entryHasTriageMarker ----------

describe("entryHasTriageMarker", () => {
  test("✅ counts as triaged", () => {
    expect(entryHasTriageMarker("done ✅ ok")).toBe(true);
  });
  test("📤 counts as triaged", () => {
    expect(entryHasTriageMarker("📤 sent")).toBe(true);
  });
  test("⏳ counts as triaged", () => {
    expect(entryHasTriageMarker("⏳ waiting")).toBe(true);
  });
  test("❌ counts as triaged", () => {
    expect(entryHasTriageMarker("❌ rejected")).toBe(true);
  });
  test("plain text is NOT triaged", () => {
    expect(entryHasTriageMarker("just text body")).toBe(false);
  });
  test("🚨 is category not triage", () => {
    expect(entryHasTriageMarker("🚨 urgent ask")).toBe(false);
  });
});

// ---------- countBluePendingDecisions ----------

describe("countBluePendingDecisions", () => {
  test("counts lines starting with 🔵", () => {
    const body = [
      "## 🟡 Auto-mode resolutions",
      "- foo bar",
      "## 🔵 Decisions Needed",
      "🔵 First open decision",
      "🔵 Second open decision",
      "Some prose",
    ].join("\n");
    expect(countBluePendingDecisions(body)).toBe(2);
  });
  test("no 🔵 → 0", () => {
    expect(countBluePendingDecisions("just text\n## Other")).toBe(0);
  });
  test("indented 🔵 still counts", () => {
    expect(countBluePendingDecisions("  🔵 indented")).toBe(1);
  });
});

// ---------- Helpers for verb tests ----------

function ok(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

/** Map team root → stdout for `git -C <root> log ...`. Anything else → ok(""). */
function gitMockFor(commitsPerRoot: Record<string, number>): GitSpawn {
  return async (argv) => {
    const rootIdx = argv.indexOf("-C");
    const root = rootIdx >= 0 ? argv[rootIdx + 1] ?? "" : "";
    const n = commitsPerRoot[root] ?? 0;
    const lines = new Array(n).fill("abcd123 chore: x").join("\n");
    return ok(lines + (n > 0 ? "\n" : ""));
  };
}

// ---------- pulse — 3-team fixture ----------

describe("pulse — 3-team fixture (shipping / stalled / need-you)", () => {
  test("first observation fires for every team", async () => {
    // beta has stalled-symptom — in-progress kanban + 0 commits.
    await writeFile(
      join(teamB, ".atmux", "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-0001",
            subject: "wip task",
            status: "in-progress",
            owner: "alice",
            createdAt: 1700000000,
          },
        ],
        epics: [],
        stories: [],
      }),
    );
    // gamma has a stale driver-inbox ask (no triage marker, 1h old).
    // The driver-inbox parser needs an "HH:MM MYT YYYY-MM-DD" header
    // that maps to an epoch ~1h before nowSec.
    const nowSec = 1715568000;
    // 1h earlier in MYT.
    const earlierSec = nowSec - 3600;
    const d = new Date((earlierSec + 8 * 3600) * 1000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const dib = `## ${hh}:${mm} MYT ${yyyy}-${mo}-${dd} — please look at X\n\nplain body text, no triage marker\n`;
    await writeFile(join(teamC, ".atmux", "driver-inbox.md"), dib);

    const sent: DiscordSendOpts[] = [];
    const exit = await pulse(["--config", cockpitPath, "--json"], {
      now: () => nowSec * 1000,
      env: {
        HOME: home,
        ATMUX_DISCORD_RECORDER: "", // forces discord skip unless --ping
      },
      gitSpawn: gitMockFor({ [teamA]: 3, [teamB]: 0, [teamC]: 0 }),
      runDoctor: async () => [],
      discordSend: async (o) => {
        sent.push(o);
      },
      stdout: () => {},
      stderr: () => {},
      statePathOpts: { home },
    });
    expect(exit).toBe(0);

    // Without --ping AND no env webhook/recorder set → no Discord sends.
    expect(sent).toHaveLength(0);

    // State file should still be written — fires were determined; ping
    // was just suppressed.
    const statePath = join(home, ".atmux", "state", "pulse-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(Object.keys(state.teams).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(state.teams.alpha.verdict).toBe("🟢 Shipping");
    expect(state.teams.beta.verdict).toBe("🔴 Stalled");
    expect(state.teams.gamma.verdict).toBe("🚨 Need you");
  });

  test("--ping fires Discord per team on first observation", async () => {
    const sent: DiscordSendOpts[] = [];
    const exit = await pulse(["--config", cockpitPath, "--ping"], {
      now: () => 1715568000_000,
      env: { HOME: home },
      gitSpawn: gitMockFor({ [teamA]: 2, [teamB]: 0, [teamC]: 0 }),
      runDoctor: async () => [],
      discordSend: async (o) => {
        sent.push(o);
      },
      stdout: () => {},
      stderr: () => {},
      statePathOpts: { home },
    });
    expect(exit).toBe(0);
    expect(sent).toHaveLength(3);
    expect(sent.map((s) => s.template).every((t) => t === "pulse-verdict")).toBe(true);
    expect(sent.map((s) => s.team).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("steady-state 🟢 Shipping does NOT re-fire on second tick", async () => {
    const sent: DiscordSendOpts[] = [];
    const sharedOpts = {
      env: { HOME: home },
      gitSpawn: gitMockFor({ [teamA]: 2, [teamB]: 2, [teamC]: 2 }),
      runDoctor: async () => [],
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
      stdout: () => {},
      stderr: () => {},
      statePathOpts: { home },
    };
    // First tick: 3 fires.
    await pulse(["--config", cockpitPath, "--ping"], {
      ...sharedOpts,
      now: () => 1715568000_000,
    });
    expect(sent).toHaveLength(3);
    sent.length = 0;
    // Second tick, same verdict everywhere — deduped.
    await pulse(["--config", cockpitPath, "--ping"], {
      ...sharedOpts,
      now: () => (1715568000 + 60) * 1000,
    });
    expect(sent).toHaveLength(0);
  });

  test("sustained 🔴 Stalled past dedup window → re-fires", async () => {
    await writeFile(
      join(teamA, ".atmux", "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-0001",
            subject: "wip",
            status: "in-progress",
            owner: "alice",
            createdAt: 1700000000,
          },
        ],
        epics: [],
        stories: [],
      }),
    );
    // Cockpit with only alpha enabled, alpha will be Stalled.
    await writeFile(
      cockpitPath,
      JSON.stringify({
        cockpitSession: "atmux_teams",
        pulse: { dedupMins: 30 },
        teams: [{ name: "alpha", root: teamA, enabled: true }],
      }),
    );

    const sent: DiscordSendOpts[] = [];
    let dbg = "";
    const sharedOpts = {
      env: { HOME: home },
      gitSpawn: gitMockFor({ [teamA]: 0 }),
      runDoctor: async () => [],
      discordSend: async (o: DiscordSendOpts) => {
        sent.push(o);
      },
      stdout: (s: string) => {
        dbg += s;
      },
      stderr: () => {},
      statePathOpts: { home },
    };
    // First fire — initial observation.
    const t0 = 1715568000;
    await pulse(["--config", cockpitPath, "--ping", "--json"], {
      ...sharedOpts,
      now: () => t0 * 1000,
    });
    void dbg;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.verdict).toContain("🔴 **Stalled**");
    sent.length = 0;

    // 15 min later — still stalled, but within dedup window → no fire.
    await pulse(["--config", cockpitPath, "--ping"], {
      ...sharedOpts,
      now: () => (t0 + 15 * 60) * 1000,
    });
    expect(sent).toHaveLength(0);

    // 31 min later — past dedup → re-fire.
    await pulse(["--config", cockpitPath, "--ping"], {
      ...sharedOpts,
      now: () => (t0 + 31 * 60) * 1000,
    });
    expect(sent).toHaveLength(1);
  });
});

// ---------- pulse — JSON output shape ----------

describe("pulse --json", () => {
  test("emits an array of tick results, one per team", async () => {
    let out = "";
    const exit = await pulse(["--config", cockpitPath, "--json"], {
      now: () => 1715568000_000,
      env: { HOME: home },
      gitSpawn: gitMockFor({ [teamA]: 1, [teamB]: 0, [teamC]: 0 }),
      runDoctor: async () => [],
      discordSend: async () => {},
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
      statePathOpts: { home },
    });
    expect(exit).toBe(0);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    const teams = parsed.map((p: { team: string }) => p.team).sort();
    expect(teams).toEqual(["alpha", "beta", "gamma"]);
    // Every entry has the documented shape.
    for (const p of parsed) {
      expect(p).toHaveProperty("verdict");
      expect(p).toHaveProperty("commitCount");
      expect(p).toHaveProperty("doctorRed");
      expect(p).toHaveProperty("inProgressCount");
      expect(p).toHaveProperty("todoCount");
      expect(p).toHaveProperty("driverInboxOpen");
      expect(p).toHaveProperty("didFire");
      expect(p).toHaveProperty("fireReason");
    }
  });
});

// ---------- pulse — disabled teams skipped ----------

describe("pulse skips disabled teams", () => {
  test("disabled-team entry never lands in tickResults / state", async () => {
    await writeFile(
      cockpitPath,
      JSON.stringify({
        cockpitSession: "atmux_teams",
        teams: [
          { name: "alpha", root: teamA, enabled: true },
          { name: "beta", root: teamB, enabled: false }, // disabled
        ],
      }),
    );
    let out = "";
    await pulse(["--config", cockpitPath, "--json"], {
      now: () => 1715568000_000,
      env: { HOME: home },
      gitSpawn: gitMockFor({ [teamA]: 1, [teamB]: 99 }),
      runDoctor: async () => [],
      discordSend: async () => {},
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
      statePathOpts: { home },
    });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].team).toBe("alpha");
  });
});

// ---------- pulse — human (default) output ----------

describe("pulse human output", () => {
  test("default (no --json) writes one line per team to stdout", async () => {
    let out = "";
    await pulse(["--config", cockpitPath], {
      now: () => 1715568000_000,
      env: { HOME: home },
      gitSpawn: gitMockFor({ [teamA]: 2, [teamB]: 0, [teamC]: 0 }),
      runDoctor: async () => [],
      discordSend: async () => {},
      stdout: (s: string) => {
        out += s;
      },
      stderr: () => {},
      statePathOpts: { home },
    });
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes("alpha") && l.includes("commits=2"))).toBe(true);
  });
});
