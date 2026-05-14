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
import { defaultRoleEmoji, parseStatusArgs, status } from "../../../src/verbs/status.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let priorTmux: string | undefined;
let priorCockpitConfig: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;
let cockpitConfigPath: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-status-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-status-team-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  // ADR-077 §F5: pin ATMUX_COCKPIT_CONFIG at a per-test path so the
  // superdoctor probe doesn't accidentally read the operator's live
  // ~/.atmux/cockpit.json. Tests opt-in by writing a fixture at this
  // path; tests that don't see all-false (configured=false).
  priorCockpitConfig = process.env.ATMUX_COCKPIT_CONFIG;
  cockpitConfigPath = join(teamDir, "cockpit-fixture.json");
  process.env.ATMUX_COCKPIT_CONFIG = cockpitConfigPath;
  tmux = createTmux({ socketPath, configFile: "/dev/null" });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: idempotent teardown
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  if (priorCockpitConfig !== undefined) {
    process.env.ATMUX_COCKPIT_CONFIG = priorCockpitConfig;
  } else {
    delete process.env.ATMUX_COCKPIT_CONFIG;
  }
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
      const wn = m.emoji !== undefined && m.emoji.length > 0 ? `${m.emoji}${m.name}` : m.name;
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

  // ---------- ADR-077 §F5: superdoctor cockpit-state surface ----------

  test("no cockpit.json → snapshot.superdoctor.configured=false; text omits the row", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // beforeEach pinned ATMUX_COCKPIT_CONFIG at a path that doesn't exist.
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).not.toContain("📋 superdoctor");

    const { out: jsonOut } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(jsonOut);
    expect(parsed.superdoctor).toEqual({
      configured: false,
      enabled: false,
      sessionAlive: false,
      windowAlive: false,
    });
  });

  test("cockpit.json without superdoctor block → configured=false (silent)", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeFile(
      cockpitConfigPath,
      JSON.stringify({
        cockpitSession: "atmux_teams",
        teams: [{ name: "alpha", root: "/a", enabled: true }],
      }),
    );
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.superdoctor.configured).toBe(false);
  });

  test("superdoctor block disabled → configured=true, enabled=false; text shows ⚪ disabled", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeFile(
      cockpitConfigPath,
      JSON.stringify({
        cockpitSession: "atmux_teams",
        superdoctor: { enabled: false },
        teams: [{ name: "alpha", root: "/a", enabled: true }],
      }),
    );
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📋 superdoctor");
    expect(out).toContain("⚪ disabled");

    const { out: jsonOut } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(jsonOut);
    expect(parsed.superdoctor).toEqual({
      configured: true,
      enabled: false,
      sessionAlive: false,
      windowAlive: false,
    });
  });

  test("superdoctor enabled but cockpit session down → text shows 🔴 cockpit-down", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeFile(
      cockpitConfigPath,
      JSON.stringify({
        cockpitSession: "non-existent-session-for-test",
        superdoctor: { enabled: true },
        teams: [{ name: "alpha", root: "/a", enabled: true }],
      }),
    );
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📋 superdoctor");
    // Probe runs against operator's default tmux socket — the named
    // session above won't exist, so we expect cockpit-down (or a
    // graceful collapse if the default socket is unreachable).
    expect(out).toMatch(/(🔴 cockpit-down|🔴 window-missing)/);
  });
});

// ---------- ADR-085 §Three surfaces #1: NEEDS APPROVAL row (t-3516d73a) ----------
//
// scanNeedsApproval reads `<projectRoot>/docs/adr/*.md`,
// `<projectRoot>/.atmux/driver-inbox.md`, and the kanban DB.
// `projectRoot` resolves to the parent of the `.atmux` dir from
// `getAtmuxDir()`, which honors `ATMUX_DIR` env first. Pinning that
// env to the test sandbox makes the live scan deterministic.
//
// Tests pin `ATMUX_DIR=<atmuxDir>` so scanNeedsApproval lands on our
// per-test sandbox (NOT the real atmux repo it's running inside).

describe("status — ADR-085 NEEDS APPROVAL row (t-3516d73a)", () => {
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;

  beforeEach(() => {
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    // Pin both — scanNeedsApproval walks via getAtmuxDir which checks
    // ATMUX_DIR first, then ATMUX_TEAM_DIR. Without these, scan walks
    // cwd up to /, lands on the operator's real .atmux, and pollutes
    // the test signal with whatever ADRs / inbox happen to be there.
    process.env.ATMUX_DIR = atmuxDir;
    process.env.ATMUX_TEAM_DIR = teamDir;
  });

  afterEach(() => {
    if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
    else delete process.env.ATMUX_DIR;
    if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
    else delete process.env.ATMUX_TEAM_DIR;
  });

  test("N+M+K=0 → '📝 NEEDS APPROVAL: ✅ clear' row in text mode", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // No ADRs / no driver-inbox stale / no blocked tasks — total=0.
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📝 NEEDS APPROVAL: ✅ clear");
    // The non-zero shape must NOT appear when total=0.
    expect(out).not.toMatch(/NEEDS APPROVAL: \d+ ADRs/);
  });

  test("N+M+K=5 (2 ADRs / 2 inbox / 1 kanban) → row body matches ADR-085 grammar", async () => {
    await stageTeam([{ name: "alpha" }], false);

    // Bucket A: stage 2 proposed ADRs under teamDir/docs/adr/. The
    // scanner walks `<projectRoot>/docs/adr` where projectRoot is the
    // parent of atmuxDir (i.e., teamDir).
    const adrDir = join(teamDir, "docs", "adr");
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, "200-foo.md"),
      "# Foo\n\n**Status**: proposed\n",
    );
    await writeFile(
      join(adrDir, "201-bar.md"),
      "# Bar\n\n**Status**: proposed\n",
    );

    // Bucket B: 2 stale, untriaged driver-inbox headings (45 min ago,
    // past the 30-min threshold).
    const stale = (offsetMin: number): string => {
      const ts = Math.floor(Date.now() / 1000) - offsetMin * 60;
      const d = new Date((ts + 8 * 3600) * 1000); // MYT shift
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    };
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      [
        `## ${stale(45)} MYT — open question one`,
        "body one\n",
        `## ${stale(50)} MYT — open question two`,
        "body two\n",
      ].join("\n"),
    );

    // Bucket C: 1 blocked task >2h. scanBlockedTasks uses
    // `claimedAt ?? createdAt`; addTask sets createdAt to now and
    // claimedAt to null, so a fresh row reads as ageMin≈0. To age it
    // past the 120-min threshold without rebuilding the kanban API to
    // accept a clock seam, write `kanban.json` directly — the kanban
    // module falls back to JSON when state.db is absent, and listTasks
    // / scanBlockedTasks both read through that fallback. Predates the
    // SQLite cutover by design (ADR-060 §D2 leaves the JSON path live
    // for tests that need a clock-aged row).
    const aged = Math.floor(Date.now() / 1000) - 3 * 3600; // 3h ago
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-aged001",
            subject: "blocked-old",
            body: "",
            status: "blocked",
            owner: null,
            deps: [],
            priority: null,
            lane: null,
            createdAt: aged,
            claimedAt: aged,
            completedAt: null,
          },
        ],
        epics: [],
        stories: [],
      }),
    );

    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📝 NEEDS APPROVAL: 2 ADRs / 2 inbox / 1 kanban");
    expect(out).not.toContain("✅ clear");
  });

  test("--json snapshot grows additive `needsApproval` key matching ADR-085 §Scan API shape", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    // Key present — the additive contract from ADR-085 §Three surfaces #1.
    expect(parsed).toHaveProperty("needsApproval");
    const na = parsed.needsApproval;
    // Shape: { adr: [], inbox: [], kanban: [], total: 0 } per
    // NeedsApprovalReport. The empty fixture yields all-zero.
    expect(Array.isArray(na.adr)).toBe(true);
    expect(Array.isArray(na.inbox)).toBe(true);
    expect(Array.isArray(na.kanban)).toBe(true);
    expect(typeof na.total).toBe("number");
    expect(na.total).toBe(na.adr.length + na.inbox.length + na.kanban.length);
  });

  test("--json with seeded entries surfaces every bucket entry as NeedsApprovalEntry", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // One proposed ADR — minimal seed to verify the bucket-A entry shape.
    const adrDir = join(teamDir, "docs", "adr");
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, "300-x.md"),
      "# X title\n\n**Status**: proposed\n",
    );

    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.needsApproval.adr.length).toBe(1);
    const entry = parsed.needsApproval.adr[0];
    // Per ADR-085 §Scan API NeedsApprovalEntry shape.
    expect(entry).toMatchObject({
      bucket: "adr",
      id: "300-x",
      subject: "X title",
    });
    expect(typeof entry.path).toBe("string");
    expect(typeof entry.ageMin).toBe("number");
  });
});
