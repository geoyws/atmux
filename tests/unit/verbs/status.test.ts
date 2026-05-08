// Unit tests for src/verbs/status.ts.
// Bash spec: lib/status.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { appendDispatched, appendPending } from "../../../src/core/inbox.ts";
import { addTask, moveTask } from "../../../src/core/kanban.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  defaultRoleEmoji,
  parseStatusArgs,
  status,
} from "../../../src/verbs/status.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let priorTmux: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-status-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-status-team-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  tmux = createTmux({ socketPath, configFile: "/dev/null" });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: idempotent teardown
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(socketDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

async function stageTeam(
  members: ReadonlyArray<{ name: string; role?: string; tui?: string; emoji?: string }>,
  withSession: boolean,
): Promise<{ teamName: string; sessionName: string }> {
  const teamName = `${sessionPrefix}-team`;
  const sessionName = `atmux-${teamName}`;
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: teamName, members }));
  if (withSession) {
    const first = members[0];
    if (first === undefined) throw new Error("test fail");
    const winName =
      first.emoji !== undefined && first.emoji.length > 0
        ? `${first.emoji}${first.name}`
        : first.name;
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: winName,
    });
    for (const m of members.slice(1)) {
      const wn =
        m.emoji !== undefined && m.emoji.length > 0 ? `${m.emoji}${m.name}` : m.name;
      await tmux.window.newWindow({ sessionName, name: wn, shellCommand: "cat" });
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return { teamName, sessionName };
}

// ---------- parseStatusArgs ----------

describe("parseStatusArgs", () => {
  test("empty argv → defaults", () => {
    expect(parseStatusArgs([])).toEqual({ json: false });
  });

  test("--json", () => {
    expect(parseStatusArgs(["--json"]).json).toBe(true);
  });

  test("--socket / --team-dir consumed", () => {
    const a = parseStatusArgs(["--socket", "/s", "--team-dir", "/x"]);
    expect(a.socketPath).toBe("/s");
    expect(a.teamDir).toBe("/x");
  });

  test("--socket / --team-dir without value → UsageError", () => {
    expect(() => parseStatusArgs(["--socket"])).toThrow(UsageError);
    expect(() => parseStatusArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseStatusArgs(["bogus"])).toThrow(UsageError);
  });
});

// ---------- defaultRoleEmoji ----------

describe("defaultRoleEmoji — bash status.sh:69-77 parity", () => {
  test("known roles map to bash emojis", () => {
    expect(defaultRoleEmoji("team-lead")).toBe("🧭");
    expect(defaultRoleEmoji("planner")).toBe("🗺️ ");
    expect(defaultRoleEmoji("reviewer")).toBe("🔍");
    expect(defaultRoleEmoji("gitter")).toBe("🌿");
    expect(defaultRoleEmoji("devops")).toBe("⚙️ ");
    expect(defaultRoleEmoji("dba")).toBe("🗄️ ");
  });

  test("unknown role falls back to 🐝", () => {
    expect(defaultRoleEmoji("member")).toBe("🐝");
    expect(defaultRoleEmoji("anything-else")).toBe("🐝");
  });
});

// ---------- status verb integration ----------

describe("status verb — integration", () => {
  test("session down: text mode shows 🔴 + (down) for panes", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("🔴");
    expect(out).toContain("[down]");
    expect(out).toContain("(down)");
    expect(out).toContain("📋 kanban");
  });

  test("session up: text mode shows 🟢 + pane command", async () => {
    await stageTeam([{ name: "alpha" }], true);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("🟢");
    expect(out).toContain("[up]");
    expect(out).toContain("alpha");
    // Pane command was `cat` per the staging shellCommand.
    expect(out).toContain("cat");
  });

  test("--json emits expected shape", async () => {
    await stageTeam([{ name: "alpha", role: "reviewer", tui: "claude" }], false);
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.team).toMatch(/-team$/);
    expect(parsed.session).toMatch(/^atmux-/);
    expect(parsed.sessionState).toBe("down");
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]).toEqual({
      name: "alpha",
      role: "reviewer",
      tui: "claude",
      paneCommand: "(down)",
      pendingCount: 0,
      inProgressCount: 0,
    });
    expect(parsed.kanban).toEqual({ todo: 0, inProgress: 0, done: 0, blocked: 0 });
    expect(parsed.driverInboxOpen).toBe(0);
  });

  test("kanban counts reflect tasks across all four statuses", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await addTask(atmuxDir, { subject: "todo-1" });
    await addTask(atmuxDir, { subject: "todo-2" });
    const ipId = await addTask(atmuxDir, { subject: "ip-1" });
    await moveTask(atmuxDir, ipId, "in-progress");
    const doneId = await addTask(atmuxDir, { subject: "done-1" });
    await moveTask(atmuxDir, doneId, "done");
    const blockedId = await addTask(atmuxDir, { subject: "blocked-1" });
    await moveTask(atmuxDir, blockedId, "blocked");

    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.kanban).toEqual({ todo: 2, inProgress: 1, done: 1, blocked: 1 });
  });

  test("pendingCount reflects member's inbox.pending length", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await appendPending(atmuxDir, "alpha", {
      id: "t-aaaaaaaa",
      subject: "p1",
      status: "todo",
      deps: [],
    });
    await appendPending(atmuxDir, "alpha", {
      id: "t-bbbbbbbb",
      subject: "p2",
      status: "todo",
      deps: [],
    });
    // Add to inProgress too — should NOT count toward pending.
    await appendDispatched(
      atmuxDir,
      "alpha",
      { id: "t-cccccccc", subject: "ip1", status: "in-progress", deps: [] },
      1,
    );
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.members[0].pendingCount).toBe(2);
  });

  test("driverInboxOpen reflects open entries in driver-inbox.md", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      "## Open\n- [t1] **a**: m1\n- [t2] **b**: m2\n## Archive\n- [t0] old\n",
    );
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.driverInboxOpen).toBe(2);
  });

  test("text mode prints driver-inbox line only when open > 0", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // No driver-inbox file at all → omit the line.
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).not.toContain("📬 driver-inbox");
  });

  test("default role emoji applied when member has no emoji", async () => {
    await stageTeam([{ name: "alpha", role: "reviewer" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("🔍"); // reviewer default emoji
  });

  test("explicit member emoji wins over role default", async () => {
    await stageTeam([{ name: "alpha", role: "reviewer", emoji: "🌟" }], true);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("🌟");
  });
});
