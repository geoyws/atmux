// Unit tests for src/verbs/status.ts.
// Bash spec: lib/status.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { addTask, assignTask, moveTask } from "../../../src/core/kanban.ts";
import { UsageError } from "../../../src/errors.ts";
import { writeHeartbeat } from "../../../src/core/heartbeat.ts";
import {
  defaultRoleEmoji,
  formatContextColumn,
  formatHeartbeatColumn,
  gatherStatus,
  type MemberStatus,
  parseStatusArgs,
  readMemberContextSignal,
  resolveHeartbeatStaleSec,
  status,
} from "../../../src/verbs/status.ts";

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
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
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
  test("session down: text mode shows 🔴 + 'down' state for panes (t-74273200)", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("🔴");
    expect(out).toContain("[down]");
    // Per t-74273200: text mode replaced the paneCommand column with
    // the unified cage state. Session-down → every member's cageState
    // is "down" (string in the state column, no parens).
    expect(out).toContain("state");
    expect(out).toMatch(/claude\s+down\s/);
    expect(out).toContain("📋 kanban");
  });

  test("session up: text mode shows 🟢 + cage state (claude TUI in cat pane → 'down')", async () => {
    await stageTeam([{ name: "alpha" }], true);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("🟢");
    expect(out).toContain("[up]");
    expect(out).toContain("alpha");
    // Pane runs `cat` — there's no `claude` in its child tree, so the
    // cage-state probe correctly reports 'down' (per t-74273200's
    // root-cause fix: pane_current_command was the misleading proxy;
    // child-PID claude-exec check is the canonical signal).
    expect(out).toMatch(/claude\s+down\s/);
  });

  test("--json emits expected shape — includes cageState field (t-74273200)", async () => {
    await stageTeam([{ name: "alpha", role: "reviewer", tui: "claude" }], false);
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.team).toMatch(/-team$/);
    expect(parsed.session).toMatch(/^atmux-/);
    expect(parsed.sessionState).toBe("down");
    expect(parsed.members).toHaveLength(1);
    // ADR-148 T2: members[].cadence is the new commit-cadence column.
    // The test worktree has no .git dir, so the git log probe returns
    // [] → classifier emits verdict='idle' with null lastCommit fields.
    // toMatchObject lets us assert the legacy contract (cageState
    // backcompat) while leaving the deterministic cadence shape's
    // verdict assertable independently.
    expect(parsed.members[0]).toMatchObject({
      name: "alpha",
      role: "reviewer",
      tui: "claude",
      paneCommand: "(down)",
      cageState: "down",
      pendingCount: 0,
      inProgressCount: 0,
    });
    expect(parsed.members[0].cadence).toEqual({
      windowSec: 1800,
      commitsInWindow: 0,
      lastCommitAt: null,
      lastCommitSha: null,
      ageOfLastCommitSec: null,
      verdict: "idle",
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
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await addTask(atmuxDir, { subject: "p1", assignee: "alpha" });
    await addTask(atmuxDir, { subject: "p2", assignee: "alpha" });
    const ipId = await addTask(atmuxDir, { subject: "ip1", assignee: "alpha" });
    await moveTask(atmuxDir, ipId, "in-progress");
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
    expect(out).toContain("📋 medic"); // ADR-133: superdoctor → medic rename
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
    expect(out).toContain("📋 medic"); // ADR-133: superdoctor → medic rename
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
    await writeFile(join(adrDir, "200-foo.md"), "# Foo\n\n**Status**: proposed\n");
    await writeFile(join(adrDir, "201-bar.md"), "# Bar\n\n**Status**: proposed\n");

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
    await writeFile(join(adrDir, "300-x.md"), "# X title\n\n**Status**: proposed\n");

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

// ---------- Per-task t-d98b2bd6: member context-pressure surfacing ----------

describe("formatContextColumn — pure formatter", () => {
  test("undefined contextPct → '—' (no signal)", () => {
    const m: MemberStatus = {
      name: "alpha",
      role: "member",
      tui: "claude",
      paneCommand: "claude",
      pendingCount: 0,
      inProgressCount: 0,
      cageState: null,
      heartbeat_age_s: null,
    };
    expect(formatContextColumn(m)).toBe("—");
  });

  test("fresh signal renders 'X.X%' with one decimal", () => {
    const m: MemberStatus = {
      name: "alpha",
      role: "member",
      tui: "claude",
      paneCommand: "claude",
      pendingCount: 0,
      inProgressCount: 0,
      cageState: null,
      contextPct: 8.4,
      contextTs: 1_715_000_000,
      contextStale: false,
      heartbeat_age_s: null,
    };
    expect(formatContextColumn(m)).toBe("8.4%");
  });

  test("threshold-tripped 75% renders 75.0%", () => {
    const m: MemberStatus = {
      name: "alpha",
      role: "member",
      tui: "claude",
      paneCommand: "claude",
      pendingCount: 0,
      inProgressCount: 0,
      cageState: null,
      contextPct: 75,
      contextTs: 1_715_000_000,
      contextStale: false,
      heartbeat_age_s: null,
    };
    expect(formatContextColumn(m)).toBe("75.0%");
  });

  test("stale signal → '(stale)' even when contextPct is present", () => {
    const m: MemberStatus = {
      name: "alpha",
      role: "member",
      tui: "claude",
      paneCommand: "claude",
      pendingCount: 0,
      inProgressCount: 0,
      cageState: null,
      contextPct: 42.5,
      contextTs: 1_715_000_000,
      contextStale: true,
      heartbeat_age_s: null,
    };
    expect(formatContextColumn(m)).toBe("(stale)");
  });
});

describe("readMemberContextSignal — JSON read with home injection", () => {
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-ctx-home-"));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("returns null when JSON file is absent", async () => {
    const got = await readMemberContextSignal(homeDir, "test-team", "alpha");
    expect(got).toBeNull();
  });

  test("reads a valid JSON file", async () => {
    const dir = join(homeDir, ".claude", "teams", "test-team", "member-context");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "alpha.json"),
      JSON.stringify({
        member: "alpha",
        ts: 1_715_000_000,
        input_kt: 12.3,
        output_kt: 4.5,
        context_pct: 8.4,
        window_kt: 200,
        in_flight_task: null,
      }),
    );
    const got = await readMemberContextSignal(homeDir, "test-team", "alpha");
    expect(got).not.toBeNull();
    expect(got?.member).toBe("alpha");
    expect(got?.ts).toBe(1_715_000_000);
    expect(got?.context_pct).toBe(8.4);
  });

  test("returns null on corrupt JSON (silent recovery)", async () => {
    const dir = join(homeDir, ".claude", "teams", "test-team", "member-context");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "alpha.json"), "{not-json");
    const got = await readMemberContextSignal(homeDir, "test-team", "alpha");
    expect(got).toBeNull();
  });

  test("returns null on missing required field (typed reject)", async () => {
    const dir = join(homeDir, ".claude", "teams", "test-team", "member-context");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "alpha.json"),
      JSON.stringify({ member: "alpha", ts: 1000 /* no context_pct */ }),
    );
    const got = await readMemberContextSignal(homeDir, "test-team", "alpha");
    expect(got).toBeNull();
  });
});

describe("gatherStatus — member ctx fields populated from JSON", () => {
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-ctx-gather-"));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("absent JSON → row omits ctx fields", async () => {
    const { teamName, sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      home: homeDir,
      now: () => 1_715_000_500_000,
      whipCadenceSec: 270,
    });
    expect(snap.team).toBe(teamName);
    expect(snap.members[0]?.contextPct).toBeUndefined();
    expect(snap.members[0]?.contextTs).toBeUndefined();
    expect(snap.members[0]?.contextStale).toBeUndefined();
  });

  test("fresh JSON → row populates ctx fields + contextStale=false", async () => {
    const { sessionName, teamName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    // Seed fresh signal (ts within 2× cadence of `now`).
    const dir = join(homeDir, ".claude", "teams", teamName, "member-context");
    await mkdir(dir, { recursive: true });
    const tsSec = 1_715_000_400;
    await writeFile(
      join(dir, "alpha.json"),
      JSON.stringify({
        member: "alpha",
        ts: tsSec,
        input_kt: 50,
        output_kt: 10,
        context_pct: 30,
        window_kt: 200,
        in_flight_task: null,
      }),
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      home: homeDir,
      // 1715000500000 ms - 1715000400000 ms = 100s — well under 2*270=540s stale window
      now: () => 1_715_000_500_000,
      whipCadenceSec: 270,
    });
    expect(snap.members[0]?.contextPct).toBe(30);
    expect(snap.members[0]?.contextTs).toBe(tsSec);
    expect(snap.members[0]?.contextStale).toBe(false);
  });

  test("stale JSON (ts older than 2× cadence) → contextStale=true", async () => {
    const { sessionName, teamName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const dir = join(homeDir, ".claude", "teams", teamName, "member-context");
    await mkdir(dir, { recursive: true });
    const staleTsSec = 1_715_000_000;
    await writeFile(
      join(dir, "alpha.json"),
      JSON.stringify({
        member: "alpha",
        ts: staleTsSec,
        input_kt: 50,
        output_kt: 10,
        context_pct: 30,
        window_kt: 200,
        in_flight_task: null,
      }),
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      home: homeDir,
      // 1_715_001_000_000 ms - 1_715_000_000_000 ms = 1000s > 2*270=540s stale threshold
      now: () => 1_715_001_000_000,
      whipCadenceSec: 270,
    });
    expect(snap.members[0]?.contextStale).toBe(true);
    expect(snap.members[0]?.contextPct).toBe(30);
  });

  test("JSON output surfaces contextPct/contextTs/contextStale when present", async () => {
    const { teamName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const dir = join(homeDir, ".claude", "teams", teamName, "member-context");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "alpha.json"),
      JSON.stringify({
        member: "alpha",
        ts: Math.floor(Date.now() / 1000),
        context_pct: 42.5,
      }),
    );
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const { out } = await captureStdout(() =>
        status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
      );
      const parsed = JSON.parse(out);
      const alpha = parsed.members.find((m: { name: string }) => m.name === "alpha");
      expect(alpha?.contextPct).toBe(42.5);
      expect(typeof alpha?.contextTs).toBe("number");
      expect(alpha?.contextStale).toBe(false);
    } finally {
      if (priorHome !== undefined) process.env.HOME = priorHome;
      else delete process.env.HOME;
    }
  });

  test("text mode prints ctx % column with header and per-row value", async () => {
    const { teamName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const dir = join(homeDir, ".claude", "teams", teamName, "member-context");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "alpha.json"),
      JSON.stringify({
        member: "alpha",
        ts: Math.floor(Date.now() / 1000),
        context_pct: 42.5,
      }),
    );
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const { out } = await captureStdout(() =>
        status(["--socket", socketPath, "--team-dir", teamDir]),
      );
      expect(out).toContain("ctx");
      expect(out).toContain("42.5%");
    } finally {
      if (priorHome !== undefined) process.env.HOME = priorHome;
      else delete process.env.HOME;
    }
  });

  test("text mode renders '—' for members without ctx signal", async () => {
    await stageTeam([{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }], false);
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const { out } = await captureStdout(() =>
        status(["--socket", socketPath, "--team-dir", teamDir]),
      );
      expect(out).toContain("—");
    } finally {
      if (priorHome !== undefined) process.env.HOME = priorHome;
      else delete process.env.HOME;
    }
  });
});

// ---------- ADR-148 T2: cadence column ----------

import {
  classifyCadence,
  type CadenceObservation,
  formatCadenceColumn,
  formatDurationShort,
  resolveCadenceConfig,
} from "../../../src/verbs/status.ts";
import {
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_CADENCE_THRESHOLDS,
  type Team,
} from "../../../src/schema/team.ts";

describe("classifyCadence — verdict branches (ADR-148 §D2)", () => {
  const T = DEFAULT_CADENCE_THRESHOLDS;
  const now = 10_000_000;

  test("≥1 commit in window AND age < shippingMaxAge → 'shipping'", () => {
    const lines = [`abc1234 ${now - 60}`];
    const r = classifyCadence(lines, now, 1800, T);
    expect(r.verdict).toBe("shipping");
    expect(r.commitsInWindow).toBe(1);
    expect(r.ageOfLastCommitSec).toBe(60);
    expect(r.lastCommitSha).toBe("abc1234");
  });

  test("0 commits AND age < idleMax → 'idle'", () => {
    // Commit 1h ago — outside the 30min window, but inside the 2h
    // idleMax.
    const lines = [`abc1234 ${now - 3600}`];
    const r = classifyCadence(lines, now, 1800, T);
    expect(r.verdict).toBe("idle");
    expect(r.commitsInWindow).toBe(0);
    expect(r.ageOfLastCommitSec).toBe(3600);
  });

  test("0 commits AND age >= shipZeroWindowSec AND < dormantMaxAge → 'ship-zero-window'", () => {
    // 3h since last commit — past shipZeroWindow (2h) but under
    // dormantMaxAge (6h).
    const lines = [`abc1234 ${now - 3 * 3600}`];
    const r = classifyCadence(lines, now, 1800, T);
    expect(r.verdict).toBe("ship-zero-window");
  });

  test("0 commits AND age >= dormantMaxAge → 'dormant'", () => {
    // 8h since last commit — past dormantMaxAge (6h). dormant wins
    // even though ship-zero-window also matches.
    const lines = [`abc1234 ${now - 8 * 3600}`];
    const r = classifyCadence(lines, now, 1800, T);
    expect(r.verdict).toBe("dormant");
  });

  test("no commits ever (empty log) → 'idle' (null age)", () => {
    const r = classifyCadence([], now, 1800, T);
    expect(r.verdict).toBe("idle");
    expect(r.lastCommitAt).toBeNull();
    expect(r.lastCommitSha).toBeNull();
    expect(r.ageOfLastCommitSec).toBeNull();
  });

  test("malformed lines tolerated (skip non-numeric ct)", () => {
    const lines = [
      `abc1234 ${now - 60}`,
      "garbage line", // 1 part — skipped
      "deadbeef notanumber", // ct non-numeric — skipped
    ];
    const r = classifyCadence(lines, now, 1800, T);
    expect(r.commitsInWindow).toBe(1);
    expect(r.verdict).toBe("shipping");
  });

  test("lastCommitSha is 7-char short SHA from longest log entry", () => {
    const lines = [
      `abc12340000000000000000000000000000000000 ${now - 60}`,
      `def56780000000000000000000000000000000000 ${now - 120}`,
    ];
    const r = classifyCadence(lines, now, 1800, T);
    expect(r.lastCommitSha).toBe("abc1234"); // most-recent
  });
});

describe("formatDurationShort — CLAUDE.md duration convention", () => {
  test("null → 'never'", () => {
    expect(formatDurationShort(null)).toBe("never");
  });

  test("<60s → 'Ns'", () => {
    expect(formatDurationShort(45)).toBe("45s");
  });

  test("<60min → 'Nmin'", () => {
    expect(formatDurationShort(1800)).toBe("30min");
    expect(formatDurationShort(60)).toBe("1min");
  });

  test("≥60min on the hour → 'Hh'", () => {
    expect(formatDurationShort(7200)).toBe("2h");
    expect(formatDurationShort(3600)).toBe("1h");
  });

  test("≥60min with minutes → 'HhMm'", () => {
    expect(formatDurationShort(3900)).toBe("1h5m"); // 65min
    expect(formatDurationShort(54000)).toBe("15h"); // 15h on the hour
    expect(formatDurationShort(54000 + 600)).toBe("15h10m");
  });
});

describe("formatCadenceColumn — verdict-to-display", () => {
  test("undefined → '—'", () => {
    expect(formatCadenceColumn(undefined)).toBe("—");
  });

  test("'exempt' → '(exempt)'", () => {
    const obs: CadenceObservation = {
      windowSec: 1800,
      commitsInWindow: 0,
      lastCommitAt: null,
      lastCommitSha: null,
      ageOfLastCommitSec: null,
      verdict: "exempt",
    };
    expect(formatCadenceColumn(obs)).toBe("(exempt)");
  });

  test("each non-exempt verdict carries its emoji + age", () => {
    const base: Omit<CadenceObservation, "verdict"> = {
      windowSec: 1800,
      commitsInWindow: 1,
      lastCommitAt: 1000,
      lastCommitSha: "abc1234",
      ageOfLastCommitSec: 300,
    };
    expect(formatCadenceColumn({ ...base, verdict: "shipping" })).toBe(
      "🟢 shipping (5min)",
    );
    expect(
      formatCadenceColumn({ ...base, ageOfLastCommitSec: 3600, verdict: "idle" }),
    ).toBe("🟡 idle (1h)");
    expect(
      formatCadenceColumn({
        ...base,
        ageOfLastCommitSec: 15 * 3600,
        verdict: "dormant",
      }),
    ).toBe("🔴 dormant (15h)");
    expect(
      formatCadenceColumn({
        ...base,
        ageOfLastCommitSec: 3 * 3600,
        verdict: "ship-zero-window",
      }),
    ).toBe("🚨 ship-zero (3h)");
  });
});

describe("resolveCadenceConfig — defaults + per-team overrides", () => {
  function makeTeam(overrides?: Partial<Team["cadence"]>): Team {
    return {
      name: "t",
      members: [],
      ...(overrides !== undefined ? { cadence: overrides } : {}),
    } as Team;
  }

  test("absent cadence block → all fields from DEFAULT_CADENCE_CONFIG", () => {
    const r = resolveCadenceConfig(makeTeam());
    expect(r.enabled).toBe(DEFAULT_CADENCE_CONFIG.enabled);
    expect(r.windowSec).toBe(DEFAULT_CADENCE_CONFIG.windowSec);
    expect(r.thresholds).toEqual(DEFAULT_CADENCE_THRESHOLDS);
    expect(r.laneStallEnabled).toBe(DEFAULT_CADENCE_CONFIG.laneStallEnabled);
    expect(r.exemptMembers).toEqual([]);
  });

  test("partial cadence block → unset fields fall back to defaults", () => {
    const r = resolveCadenceConfig(makeTeam({ windowSec: 600 }));
    expect(r.windowSec).toBe(600);
    expect(r.enabled).toBe(DEFAULT_CADENCE_CONFIG.enabled);
    expect(r.thresholds.shippingMaxAgeSec).toBe(
      DEFAULT_CADENCE_THRESHOLDS.shippingMaxAgeSec,
    );
  });

  test("partial thresholds → unset threshold keys fall back to defaults", () => {
    const r = resolveCadenceConfig(
      makeTeam({ thresholds: { dormantMaxAgeSec: 3600 } }),
    );
    expect(r.thresholds.dormantMaxAgeSec).toBe(3600);
    expect(r.thresholds.shippingMaxAgeSec).toBe(
      DEFAULT_CADENCE_THRESHOLDS.shippingMaxAgeSec,
    );
    expect(r.thresholds.idleMaxAgeSec).toBe(DEFAULT_CADENCE_THRESHOLDS.idleMaxAgeSec);
  });

  test("exemptMembers per-team override", () => {
    const r = resolveCadenceConfig(makeTeam({ exemptMembers: ["planner", "reviewer"] }));
    expect(r.exemptMembers).toEqual(["planner", "reviewer"]);
  });
});

describe("gatherStatus — cadence column integration", () => {
  test("cadence.enabled=false → row.cadence stays undefined", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const teamRaw = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const team: Team = { ...teamRaw, cadence: { enabled: false } };
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      gitLog: async () => [],
    });
    expect(snap.members[0]?.cadence).toBeUndefined();
  });

  test("exempt member → verdict='exempt', commits in log NOT consulted", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const teamRaw = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const team: Team = {
      ...teamRaw,
      cadence: { exemptMembers: ["alpha"] },
    };
    let gitCalls = 0;
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      gitLog: async () => {
        gitCalls += 1;
        return [];
      },
    });
    expect(snap.members[0]?.cadence?.verdict).toBe("exempt");
    expect(gitCalls).toBe(0);
  });

  test("gitLog injection drives verdict — fresh commit → 'shipping'", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const nowMs = 1_700_000_000_000;
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => nowMs,
      gitLog: async () => [`abcdef1234 ${Math.floor(nowMs / 1000) - 60}`],
    });
    expect(snap.members[0]?.cadence?.verdict).toBe("shipping");
    expect(snap.members[0]?.cadence?.ageOfLastCommitSec).toBe(60);
  });

  test("gitLog injection — stale commit (8h ago) → 'dormant'", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const nowMs = 1_700_000_000_000;
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => nowMs,
      gitLog: async () => [`abcdef1234 ${Math.floor(nowMs / 1000) - 8 * 3600}`],
    });
    expect(snap.members[0]?.cadence?.verdict).toBe("dormant");
  });
});

// ---------- ADR-077 §lead-uptime-measurement (t-6d950ffd) ----------

import {
  parsePsEtime,
  probeLeadUptime,
  type LeadUptimeSnapshot,
} from "../../../src/verbs/status.ts";
import { writeLeadSessionStart } from "../../../src/core/lead-marker.ts";

describe("parsePsEtime — '[[DD-]HH:]MM:SS' parsing", () => {
  test("MM:SS form", () => {
    expect(parsePsEtime("12:34")).toBe(12 * 60 + 34);
    expect(parsePsEtime("00:05")).toBe(5);
  });

  test("HH:MM:SS form", () => {
    expect(parsePsEtime("02:30:45")).toBe(2 * 3600 + 30 * 60 + 45);
  });

  test("DD-HH:MM:SS form (multi-day uptime)", () => {
    // 1 day + 12h + 30min + 45s = 86400 + 43200 + 1800 + 45
    expect(parsePsEtime("1-12:30:45")).toBe(86400 + 43200 + 1800 + 45);
    expect(parsePsEtime("7-00:00:00")).toBe(7 * 86400);
  });

  test("whitespace tolerated (ps pads with leading space)", () => {
    expect(parsePsEtime("  12:34  ")).toBe(754);
  });

  test("empty / unparseable → null (defensive)", () => {
    expect(parsePsEtime("")).toBeNull();
    expect(parsePsEtime("garbage")).toBeNull();
    expect(parsePsEtime("12:34:56:78")).toBeNull();
  });
});

describe("probeLeadUptime — ADR-077 §lead-uptime-measurement", () => {
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-lead-uptime-home-"));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("no team-lead role configured → configured: false, all fields null", async () => {
    const { sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const snap: LeadUptimeSnapshot = await probeLeadUptime(
      tmux,
      team,
      sessionName,
      false,
      { home: homeDir },
    );
    expect(snap.configured).toBe(false);
    expect(snap.leadMember).toBeNull();
    expect(snap.lead_session_uptime_s).toBeNull();
    expect(snap.shell_pid_etime_s).toBeNull();
  });

  test("team-lead role + lead-session-start.txt present → lead_session_uptime_s = now - marker", async () => {
    const { sessionName, teamName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      false,
    );
    const nowMs = 1_700_000_000_000;
    const startedAt = Math.floor(nowMs / 1000) - 300; // 5min ago
    await writeLeadSessionStart(teamName, startedAt, { home: homeDir });
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const snap = await probeLeadUptime(tmux, team, sessionName, false, {
      home: homeDir,
      now: () => nowMs,
    });
    expect(snap.configured).toBe(true);
    expect(snap.leadMember).toBe("lead-alpha");
    expect(snap.leadSessionStartedAt).toBe(startedAt);
    expect(snap.lead_session_uptime_s).toBe(300);
    // Session down → PID/etime null.
    expect(snap.leadPanePid).toBeNull();
    expect(snap.shell_pid_etime_s).toBeNull();
  });

  test("marker absent → lead_session_uptime_s null even with team-lead role", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      false,
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const snap = await probeLeadUptime(tmux, team, sessionName, false, {
      home: homeDir,
    });
    expect(snap.configured).toBe(true);
    expect(snap.leadSessionStartedAt).toBeNull();
    expect(snap.lead_session_uptime_s).toBeNull();
  });

  test("session up + lead window present → leadPanePid populated, psEtime injected", async () => {
    const { sessionName, teamName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      true,
    );
    await writeLeadSessionStart(teamName, Math.floor(Date.now() / 1000) - 60, {
      home: homeDir,
    });
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const psCalls: number[] = [];
    const snap = await probeLeadUptime(tmux, team, sessionName, true, {
      home: homeDir,
      psEtime: async (pid) => {
        psCalls.push(pid);
        return 99999; // arbitrary fixture value
      },
    });
    expect(snap.leadPanePid).toBeGreaterThan(0);
    expect(psCalls).toEqual([snap.leadPanePid!]);
    expect(snap.shell_pid_etime_s).toBe(99999);
  });

  test("explicit-naming: lead_session_uptime_s ≠ shell_pid_etime_s under same probe", async () => {
    // The whole point of the field-naming: rotation gate reads
    // lead_session_uptime_s (marker-derived, recent /clear-resettable)
    // while shell_pid_etime_s is the diagnostic-only shell etime
    // (long-lived). Wire both up and assert they're independent.
    const { sessionName, teamName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      true,
    );
    const nowMs = 1_700_000_000_000;
    const startedAt = Math.floor(nowMs / 1000) - 90; // marker: 90s ago
    await writeLeadSessionStart(teamName, startedAt, { home: homeDir });
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const snap = await probeLeadUptime(tmux, team, sessionName, true, {
      home: homeDir,
      now: () => nowMs,
      psEtime: async () => 22 * 3600, // shell: 22h
    });
    expect(snap.lead_session_uptime_s).toBe(90);
    expect(snap.shell_pid_etime_s).toBe(22 * 3600);
    // The whole point: these MUST be independent values.
    expect(snap.shell_pid_etime_s).not.toBe(snap.lead_session_uptime_s);
  });
});

describe("gatherStatus / status verb — lead block surfaces in JSON", () => {
  let homeDir: string;
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-lead-json-home-"));
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("--json output includes 'lead' top-level block", async () => {
    const { teamName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      false,
    );
    await writeLeadSessionStart(
      teamName,
      Math.floor(Date.now() / 1000) - 180,
      { home: homeDir },
    );
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const { out } = await captureStdout(() =>
        status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
      );
      const parsed = JSON.parse(out);
      expect(parsed.lead).toBeDefined();
      expect(parsed.lead.configured).toBe(true);
      expect(parsed.lead.leadMember).toBe("lead-alpha");
      // Both explicit field names present per ADR-077 §lead-uptime-measurement.
      expect(parsed.lead).toHaveProperty("lead_session_uptime_s");
      expect(parsed.lead).toHaveProperty("shell_pid_etime_s");
      expect(typeof parsed.lead.lead_session_uptime_s).toBe("number");
    } finally {
      if (priorHome !== undefined) process.env.HOME = priorHome;
      else delete process.env.HOME;
    }
  });

  test("text mode emits '🧭 lead' row with session_uptime label", async () => {
    const { teamName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      false,
    );
    await writeLeadSessionStart(
      teamName,
      Math.floor(Date.now() / 1000) - 600,
      { home: homeDir },
    );
    const priorHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const { out } = await captureStdout(() =>
        status(["--socket", socketPath, "--team-dir", teamDir]),
      );
      // Explicit labels — operator reading the text view can't conflate
      // the two values.
      expect(out).toMatch(/🧭 lead lead-alpha/);
      expect(out).toContain("session_uptime=");
      expect(out).toContain("shell_etime=");
    } finally {
      if (priorHome !== undefined) process.env.HOME = priorHome;
      else delete process.env.HOME;
    }
  });

  test("team without team-lead role → no '🧭 lead' row in text output", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).not.toContain("🧭 lead");
  });
});

describe("text mode — pane-state column rename + cadence column", () => {
  test("header row uses 'pane-state' (not 'alive' or bare 'state')", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("pane-state");
    // 'cadence' header column is the canonical truth-signal column.
    expect(out).toContain("cadence");
  });

  test("text mode shows 'idle' cadence for tmpdir worktree (no .git)", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    // No .git in the stage's teamDir → git log probe fails → empty
    // log → verdict='idle' with null age. formatCadenceColumn renders
    // "🟡 idle (never)".
    expect(out).toMatch(/🟡 idle \(never\)/);
  });
});

// ---------- ADR-057 §D6c: heartbeat surface ----------

describe("formatHeartbeatColumn — pure formatter", () => {
  const base: Omit<MemberStatus, "heartbeat_age_s"> = {
    name: "alpha",
    role: "member",
    tui: "claude",
    paneCommand: "claude",
    cageState: "active",
    pendingCount: 0,
    inProgressCount: 0,
  };

  test("absent heartbeat → '—'", () => {
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: null }, 300)).toBe("—");
  });

  test("fresh seconds-old heartbeat → '❤️Ns'", () => {
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 42 }, 300)).toBe("❤️42s");
  });

  test("fresh minutes-old heartbeat → '❤️Nm'", () => {
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 240 }, 300)).toBe("❤️4m");
  });

  test("boundary (age == staleSec) is fresh, not stale", () => {
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 300 }, 300)).toBe("❤️5m");
  });

  test("stale heartbeat (age > staleSec) → '💔Nm'", () => {
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 420 }, 300)).toBe("💔7m");
  });

  test("stale-hours heartbeat → '💔Nh'", () => {
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 7200 }, 300)).toBe("💔2h");
  });

  test("custom staleSec override is honored", () => {
    // 100s old, threshold 60s → stale.
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 100 }, 60)).toBe("💔1m");
    // Same age with threshold 300s → fresh.
    expect(formatHeartbeatColumn({ ...base, heartbeat_age_s: 100 }, 300)).toBe("❤️1m");
  });
});

describe("resolveHeartbeatStaleSec — typed Zod read (post-promotion t-fbfb02f8)", () => {
  // Schema rejection of non-numeric / non-positive values is exercised by
  // tests/unit/schema/team.test.ts::TeamWhip — stallPrevention shape.
  // The consumer-side reader simplifies to a typed read + null-coalesce.
  test("absent whip → default 300s", () => {
    expect(resolveHeartbeatStaleSec({ name: "t", members: [] } as never)).toBe(300);
  });

  test("whip without stallPrevention → default 300s", () => {
    expect(
      resolveHeartbeatStaleSec({
        name: "t",
        members: [],
        whip: {},
      } as never),
    ).toBe(300);
  });

  test("explicit heartbeatStaleSec override honored", () => {
    expect(
      resolveHeartbeatStaleSec({
        name: "t",
        members: [],
        whip: { stallPrevention: { heartbeatStaleSec: 120 } },
      } as never),
    ).toBe(120);
  });
});

describe("gatherStatus — heartbeat surface", () => {
  test("absent heartbeat file → row.heartbeat_age_s === null, text omits marker", async () => {
    const { sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => 1_715_000_000_000,
    });
    expect(snap.members[0]?.heartbeat_age_s).toBeNull();
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    // Renderer suppresses the "—" marker entirely so absent-heartbeat
    // rows don't get a noisy trailing dash on every line.
    expect(out).not.toContain("❤️");
    expect(out).not.toContain("💔");
  });

  test("fresh heartbeat → row.heartbeat_age_s = N, text shows ❤️", async () => {
    const { sessionName } = await stageTeam([{ name: "alpha" }], false);
    // Stamp at wall-clock - 30s so the public `status` verb (which can't
    // be time-injected via argv) sees the same fresh window the explicit
    // gatherStatus call below does.
    const nowSec = Math.floor(Date.now() / 1000);
    await writeHeartbeat(atmuxDir, "alpha", nowSec - 30);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir);
    const age = snap.members[0]?.heartbeat_age_s;
    expect(age).not.toBeNull();
    // Allow ±2s for test wall-clock drift between writeHeartbeat call
    // above and gatherStatus's internal Date.now read.
    expect(age ?? -1).toBeGreaterThanOrEqual(30);
    expect(age ?? -1).toBeLessThanOrEqual(32);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("❤️");
  });

  test("stale heartbeat → row.heartbeat_age_s = N, text shows 💔", async () => {
    const { sessionName } = await stageTeam([{ name: "alpha" }], false);
    // Stamp a heartbeat 1h in the past — exceeds default 300s threshold.
    const nowSec = Math.floor(Date.now() / 1000);
    await writeHeartbeat(atmuxDir, "alpha", nowSec - 3600);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir);
    const age = snap.members[0]?.heartbeat_age_s;
    expect(age).not.toBeNull();
    expect(age ?? 0).toBeGreaterThanOrEqual(3600);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("💔");
  });

  test("JSON output always includes heartbeat_age_s (null or integer)", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // First: absent → null.
    const { out: out1 } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed1 = JSON.parse(out1);
    expect(parsed1.members[0]).toHaveProperty("heartbeat_age_s", null);

    // Then stamp a heartbeat + re-read.
    const nowSec = Math.floor(Date.now() / 1000);
    await writeHeartbeat(atmuxDir, "alpha", nowSec - 5);
    const { out: out2 } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed2 = JSON.parse(out2);
    expect(typeof parsed2.members[0].heartbeat_age_s).toBe("number");
    expect(parsed2.members[0].heartbeat_age_s).toBeGreaterThanOrEqual(5);
  });
});

