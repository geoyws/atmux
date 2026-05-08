// Unit tests for src/verbs/discorder.ts (ADR-068 cutover Tier 1, P0).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire } from "../../../src/abstractions/lock.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  buildHeartbeatDiscordOpts,
  buildProgressDiscordOpts,
  discorder,
  parseDiscorderArgs,
} from "../../../src/verbs/discorder.ts";
import type { Team } from "../../../src/schema/team.ts";

const RUN_MS = Date.UTC(2026, 4, 8, 14, 55, 0);

interface Env {
  atmuxDir: string;
  logs: { kind: string; msg: string }[];
  logger: Logger;
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-discorder-verb-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  const logs: Env["logs"] = [];
  const logger: Logger = {
    log: (m) => logs.push({ kind: "log", msg: m }),
    ok: (m) => logs.push({ kind: "ok", msg: m }),
    warn: (m) => logs.push({ kind: "warn", msg: m }),
    err: (m) => logs.push({ kind: "err", msg: m }),
  };
  env = { atmuxDir, logs, logger };
});

afterEach(async () => {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
});

const TEAM: Team = {
  name: "smoke",
  members: [
    { name: "lead", role: "team-lead", tui: "claude" },
    { name: "alice", role: "member", tui: "claude" },
  ],
  singleSession: false,
} as Team;

function fakeTmux(): TmuxNamespace {
  return {
    session: { async hasSession() { return false; } },
  } as unknown as TmuxNamespace;
}

// ---------- parseDiscorderArgs ----------

describe("parseDiscorderArgs", () => {
  test("--help / -h sets showHelp", () => {
    expect(parseDiscorderArgs(["--help"]).showHelp).toBe(true);
    expect(parseDiscorderArgs(["-h"]).showHelp).toBe(true);
  });

  test("bare argv → showHelp=true (no error)", () => {
    expect(parseDiscorderArgs([]).showHelp).toBe(true);
  });

  test("progress / heartbeat sub", () => {
    expect(parseDiscorderArgs(["progress"]).sub).toBe("progress");
    expect(parseDiscorderArgs(["heartbeat"]).sub).toBe("heartbeat");
  });

  test("unknown subverb throws UsageError", () => {
    expect(() => parseDiscorderArgs(["bogus"])).toThrow(UsageError);
  });
});

// ---------- buildProgressDiscordOpts ----------

describe("buildProgressDiscordOpts", () => {
  test("returns null on empty delta", () => {
    const got = buildProgressDiscordOpts(
      "x",
      {
        sinceEpoch: 0,
        commits: [],
        commitsTruncated: false,
        doneTasks: [],
        doneTasksTruncated: false,
        advancedStories: [],
        advancedStoriesTruncated: false,
      },
      "30min ago",
    );
    expect(got).toBe(null);
  });

  test("renders sections for each non-empty bucket", () => {
    const got = buildProgressDiscordOpts(
      "x",
      {
        sinceEpoch: 0,
        commits: [{ sha: "aaa", subject: "s", author: "A" }],
        commitsTruncated: true,
        doneTasks: [{ id: "t-1", subject: "shipped", owner: "B" }],
        doneTasksTruncated: false,
        advancedStories: [
          { id: "s-1", epic: "E", title: "story", status: "done" },
        ],
        advancedStoriesTruncated: false,
      },
      "30min ago",
    );
    expect(got).not.toBeNull();
    expect(got?.template).toBe("whip-progress");
    expect(got?.team).toBe("x");
    expect(got?.sections).toHaveLength(3);
    const labels = got?.sections?.map((s) => s.label) ?? [];
    expect(labels[0]).toContain("Since last tick");
    expect(labels[1]).toContain("Tasks closed");
    expect(labels[2]).toContain("Stories advanced");
  });

  test("truncates bullets past 80 graphemes with ellipsis", () => {
    const got = buildProgressDiscordOpts(
      "x",
      {
        sinceEpoch: 0,
        commits: [
          {
            sha: "aaa1111",
            subject: "x".repeat(200),
            author: "Alice",
          },
        ],
        commitsTruncated: false,
        doneTasks: [],
        doneTasksTruncated: false,
        advancedStories: [],
        advancedStoriesTruncated: false,
      },
      "30min",
    );
    const bullets = got?.sections?.[0]?.bullets ?? [];
    expect(bullets[0]?.endsWith("…")).toBe(true);
    expect(bullets[0]?.length).toBeLessThanOrEqual(80);
  });
});

// ---------- buildHeartbeatDiscordOpts ----------

describe("buildHeartbeatDiscordOpts", () => {
  test("session down banner", () => {
    const got = buildHeartbeatDiscordOpts("x", {
      sessionUp: false,
      totalMembers: 3,
      aliveCount: 0,
      drifted: [],
      inFlightTasks: 0,
      blockedTasks: 0,
      leadName: null,
      leadUptimeSec: null,
    });
    const bullets = got.sections?.[0]?.bullets ?? [];
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("session DOWN");
  });

  test("session up: alive + drift + in-flight + blocked + lead uptime", () => {
    const got = buildHeartbeatDiscordOpts("x", {
      sessionUp: true,
      totalMembers: 3,
      aliveCount: 1,
      drifted: [
        { name: "alice", role: "member", reason: "tui-not-running:bash" },
        { name: "bob", role: "member", reason: "window-missing" },
      ],
      inFlightTasks: 2,
      blockedTasks: 1,
      leadName: "lead",
      leadUptimeSec: 5400, // 1h30m
    });
    const bullets = got.sections?.[0]?.bullets ?? [];
    expect(bullets[0]).toContain("alive: 1/3");
    expect(bullets.some((b) => b.includes("alice") && b.includes("bash"))).toBe(true);
    expect(bullets.some((b) => b.includes("bob") && b.includes("window missing"))).toBe(true);
    expect(bullets.some((b) => b.includes("in-flight: 2"))).toBe(true);
    expect(bullets.some((b) => b.includes("blocked: 1"))).toBe(true);
    expect(bullets.some((b) => b.includes("lead uptime: 1h30m"))).toBe(true);
  });

  test("session up but no in-flight / blocked / lead-uptime → those bullets absent", () => {
    const got = buildHeartbeatDiscordOpts("x", {
      sessionUp: true,
      totalMembers: 1,
      aliveCount: 1,
      drifted: [],
      inFlightTasks: 0,
      blockedTasks: 0,
      leadName: null,
      leadUptimeSec: null,
    });
    const bullets = got.sections?.[0]?.bullets ?? [];
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("alive: 1/1");
  });
});

// ---------- discorder verb body ----------

describe("discorder verb", () => {
  function seedTeamJson(): Promise<void> {
    return writeFile(
      join(env.atmuxDir, "team.json"),
      JSON.stringify(TEAM),
    );
  }

  test("--help prints usage + exits 0", async () => {
    const buf: string[] = [];
    const rc = await discorder(["--help"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      stdout: (s) => buf.push(s),
    });
    expect(rc).toBe(0);
    expect(buf.join("")).toContain("atmux discorder <subverb>");
  });

  test("lock contention → return 0 with skip log", async () => {
    await seedTeamJson();
    const lockHandle = await acquire(
      join(env.atmuxDir, "state", "discorder-progress"),
    );
    try {
      const rc = await discorder(["progress"], {
        atmuxDir: env.atmuxDir,
        env: {},
        logger: env.logger,
        nowMs: RUN_MS,
        team: TEAM,
        skipDiscord: true,
      });
      expect(rc).toBe(0);
      const skip = env.logs.find((l) =>
        l.msg.includes("another instance is running"),
      );
      expect(skip).toBeDefined();
    } finally {
      await lockHandle.release();
    }
  });

  test("progress: empty delta logs silent + advances cursor", async () => {
    await seedTeamJson();
    const rc = await discorder(["progress"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
      team: TEAM,
      skipDiscord: true,
      aggregateProgressFn: async () => ({
        sinceEpoch: 0,
        commits: [],
        commitsTruncated: false,
        doneTasks: [],
        doneTasksTruncated: false,
        advancedStories: [],
        advancedStoriesTruncated: false,
      }),
    });
    expect(rc).toBe(0);
    const silent = env.logs.find((l) =>
      l.msg.includes("no deltas since cursor"),
    );
    expect(silent).toBeDefined();
  });

  test("progress: non-empty delta + skipDiscord exits 0 cleanly", async () => {
    await seedTeamJson();
    const rc = await discorder(["progress"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
      team: TEAM,
      skipDiscord: true,
      aggregateProgressFn: async () => ({
        sinceEpoch: 0,
        commits: [{ sha: "aaa", subject: "s", author: "A" }],
        commitsTruncated: false,
        doneTasks: [],
        doneTasksTruncated: false,
        advancedStories: [],
        advancedStoriesTruncated: false,
      }),
    });
    expect(rc).toBe(0);
    // No warn log (no Discord error path).
    expect(env.logs.filter((l) => l.kind === "warn")).toHaveLength(0);
  });

  test("heartbeat: skipDiscord exits 0 cleanly", async () => {
    await seedTeamJson();
    // Seed session anchor for getSessionName via team.singleSession=false
    // → builds atmux-<name>.
    const rc = await discorder(["heartbeat"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
      team: TEAM,
      tmux: fakeTmux(),
      skipDiscord: true,
    });
    expect(rc).toBe(0);
  });

  test("missing team.json → safe exit (no team) instead of crash", async () => {
    // Pin ATMUX_DIR so requireTeam resolves to env.atmuxDir (no team.json
    // there) rather than walking up to the atmux repo root which has one.
    const rc = await discorder(["progress"], {
      atmuxDir: env.atmuxDir,
      env: { ATMUX_DIR: env.atmuxDir },
      logger: env.logger,
      nowMs: RUN_MS,
      skipDiscord: true,
    });
    expect(rc).toBe(0);
    const warn = env.logs.find((l) => l.kind === "warn");
    expect(warn).toBeDefined();
  });
});
