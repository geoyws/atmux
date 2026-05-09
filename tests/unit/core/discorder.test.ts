// Unit tests for src/core/discorder.ts (ADR-068 cutover Tier 1, P0).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  aggregateHeartbeat,
  aggregateProgress,
  progressCursorPath,
  readProgressCursor,
  writeProgressCursor,
} from "../../../src/core/discorder.ts";
import type { Team } from "../../../src/schema/team.ts";

const RUN_MS = Date.UTC(2026, 4, 8, 14, 55, 0);

interface Env {
  atmuxDir: string;
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-discorder-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  env = { atmuxDir };
});

afterEach(async () => {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
});

// ---------- progress cursor ----------

describe("progress cursor", () => {
  test("returns null when file absent", async () => {
    expect(await readProgressCursor(env.atmuxDir)).toBe(null);
  });

  test("returns null on malformed JSON", async () => {
    await writeFile(progressCursorPath(env.atmuxDir), "{ not json");
    expect(await readProgressCursor(env.atmuxDir)).toBe(null);
  });

  test("returns null on missing .epoch field", async () => {
    await writeFile(progressCursorPath(env.atmuxDir), '{"hello":1}');
    expect(await readProgressCursor(env.atmuxDir)).toBe(null);
  });

  test("write+read roundtrip", async () => {
    await writeProgressCursor(env.atmuxDir, 1700000000);
    expect(await readProgressCursor(env.atmuxDir)).toBe(1700000000);
  });

  test("read returns null for negative values (schema rejects)", async () => {
    await writeFile(progressCursorPath(env.atmuxDir), '{"epoch":-1}');
    expect(await readProgressCursor(env.atmuxDir)).toBe(null);
  });
});

// ---------- aggregateProgress ----------

describe("aggregateProgress", () => {
  test("empty when neither git nor kanban available", async () => {
    const got = await aggregateProgress(env.atmuxDir, "/no-such-dir", 0, {
      spawnGit: async () => "",
    });
    expect(got.commits).toEqual([]);
    expect(got.doneTasks).toEqual([]);
    expect(got.advancedStories).toEqual([]);
  });

  test("parses git log output (TSV: sha\\tsubject\\tauthor)", async () => {
    const got = await aggregateProgress(env.atmuxDir, "/dummy", 0, {
      spawnGit: async () => ["aaa1111\tfix bug\tAlice", "bbb2222\tadd feature\tBob"].join("\n"),
    });
    expect(got.commits).toEqual([
      { sha: "aaa1111", subject: "fix bug", author: "Alice" },
      { sha: "bbb2222", subject: "add feature", author: "Bob" },
    ]);
    expect(got.commitsTruncated).toBe(false);
  });

  test("truncates commits past cap", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(`s${i}\tsub ${i}\tA`);
    const got = await aggregateProgress(env.atmuxDir, "/d", 0, {
      cap: 5,
      spawnGit: async () => lines.join("\n"),
    });
    expect(got.commits).toHaveLength(5);
    expect(got.commitsTruncated).toBe(true);
  });

  test("kanban done-tasks past cursor", async () => {
    const cursor = Math.floor(RUN_MS / 1000) - 60 * 60;
    const completedRecent = Math.floor(RUN_MS / 1000) - 5 * 60;
    const completedOld = cursor - 1;
    await writeFile(
      join(env.atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-recent",
            subject: "shipped",
            owner: "alice",
            status: "done",
            completedAt: completedRecent,
          },
          {
            id: "t-old",
            subject: "earlier",
            owner: "bob",
            status: "done",
            completedAt: completedOld,
          },
        ],
        epics: [],
        stories: [],
      }),
    );
    const got = await aggregateProgress(env.atmuxDir, "/d", cursor, {
      spawnGit: async () => "",
    });
    expect(got.doneTasks).toEqual([{ id: "t-recent", subject: "shipped", owner: "alice" }]);
  });

  test("advanced stories past cursor", async () => {
    const cursor = Math.floor(RUN_MS / 1000) - 60 * 60;
    await writeFile(
      join(env.atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [],
        epics: [],
        stories: [
          {
            id: "s-yes",
            epic: "E1",
            title: "story A",
            status: "in-progress",
            advancedAt: cursor + 100,
          },
          {
            id: "s-no",
            epic: "E1",
            title: "story B",
            status: "todo",
            advancedAt: cursor - 100,
          },
        ],
      }),
    );
    const got = await aggregateProgress(env.atmuxDir, "/d", cursor, {
      spawnGit: async () => "",
    });
    expect(got.advancedStories).toEqual([
      { id: "s-yes", epic: "E1", title: "story A", status: "in-progress" },
    ]);
  });
});

// ---------- aggregateHeartbeat ----------

describe("aggregateHeartbeat", () => {
  function fakeTmux(opts: {
    sessionUp?: boolean;
    paneCmd?: (target: string) => string | null;
  }): TmuxNamespace {
    return {
      session: {
        async hasSession() {
          return opts.sessionUp ?? true;
        },
      },
      pane: {
        async displayMessage({ target }: { target: string }) {
          const cmd = opts.paneCmd ? opts.paneCmd(target) : null;
          if (cmd === null) throw new Error("no window");
          return `${cmd}\n`;
        },
      },
    } as unknown as TmuxNamespace;
  }

  const team: Team = {
    name: "smoke",
    members: [
      { name: "lead", role: "team-lead", tui: "claude" },
      { name: "alice", role: "member", tui: "claude" },
      { name: "bob", role: "member", tui: "kimi" },
    ],
    singleSession: false,
  } as Team;

  test("session down → empty alive count + zero kanban", async () => {
    const tmux = fakeTmux({ sessionUp: false });
    const snap = await aggregateHeartbeat(team, env.atmuxDir, "atmux-x", tmux);
    expect(snap.sessionUp).toBe(false);
    expect(snap.aliveCount).toBe(0);
    expect(snap.totalMembers).toBe(3);
  });

  test("alive when pane runs the declared TUI", async () => {
    const tmux = fakeTmux({
      sessionUp: true,
      paneCmd: (target) => {
        if (target.endsWith(":lead")) return "claude";
        if (target.endsWith(":alice")) return "claude";
        if (target.endsWith(":bob")) return "kimi";
        return null;
      },
    });
    const snap = await aggregateHeartbeat(team, env.atmuxDir, "atmux-x", tmux);
    expect(snap.sessionUp).toBe(true);
    expect(snap.aliveCount).toBe(3);
    expect(snap.drifted).toEqual([]);
  });

  test("drift: window missing + tui not running", async () => {
    const tmux = fakeTmux({
      sessionUp: true,
      paneCmd: (target) => {
        if (target.endsWith(":lead")) return null; // window missing
        if (target.endsWith(":alice")) return "bash"; // wrong TUI
        if (target.endsWith(":bob")) return "kimi";
        return null;
      },
    });
    const snap = await aggregateHeartbeat(team, env.atmuxDir, "atmux-x", tmux);
    expect(snap.aliveCount).toBe(1); // bob only
    expect(snap.drifted).toHaveLength(2);
    expect(snap.drifted.find((d) => d.name === "lead")?.reason).toBe("window-missing");
    expect(snap.drifted.find((d) => d.name === "alice")?.reason).toBe("tui-not-running:bash");
  });

  test("kanban counts in-progress + blocked", async () => {
    const tmux = fakeTmux({ sessionUp: false });
    await writeFile(
      join(env.atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          { id: "t-1", status: "in-progress" },
          { id: "t-2", status: "in-progress" },
          { id: "t-3", status: "blocked" },
          { id: "t-4", status: "todo" },
          { id: "t-5", status: "done" },
        ],
        epics: [],
        stories: [],
      }),
    );
    const snap = await aggregateHeartbeat(team, env.atmuxDir, "atmux-x", tmux);
    expect(snap.inFlightTasks).toBe(2);
    expect(snap.blockedTasks).toBe(1);
  });

  test("lead uptime computed from rotated.epoch / session-start.txt", async () => {
    const tmux = fakeTmux({ sessionUp: false });
    const anchorSec = Math.floor(RUN_MS / 1000) - 90 * 60; // 90min ago
    await writeFile(join(env.atmuxDir, "state", "lead-rotated.epoch"), `${anchorSec}\n`);
    const snap = await aggregateHeartbeat(team, env.atmuxDir, "atmux-x", tmux, {
      nowMs: RUN_MS,
    });
    expect(snap.leadName).toBe("lead");
    expect(snap.leadUptimeSec).toBe(90 * 60);
  });

  test("no anchor → leadUptimeSec=null", async () => {
    const tmux = fakeTmux({ sessionUp: false });
    const snap = await aggregateHeartbeat(team, env.atmuxDir, "atmux-x", tmux);
    expect(snap.leadUptimeSec).toBe(null);
  });
});
