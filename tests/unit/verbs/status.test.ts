// Unit tests for src/verbs/status.ts.
// Bash spec: lib/status.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { writeHeartbeat } from "../../../src/core/heartbeat.ts";
import { appendDispatched, appendPending } from "../../../src/core/inbox.ts";
import { addTask, moveTask } from "../../../src/core/kanban.ts";
import { writeMemberStatus } from "../../../src/core/member-status.ts";
import { TEAM_FIXTURES } from "../../../src/core/vox/e2e/fixtures.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  defaultRoleEmoji,
  formatAgentEvidenceLine,
  formatAgentStateColumn,
  formatContextColumn,
  formatHeartbeatColumn,
  formatPaneStateColumn,
  formatProcessStateColumn,
  formatSelfStatusColumn,
  gatherStatus,
  type MemberStatus,
  parseStatusArgs,
  readMemberContextSignal,
  resolveHeartbeatStaleSec,
  status,
} from "../../../src/verbs/status.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let homeDir: string;
let priorTmux: string | undefined;
let priorCockpitConfig: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;
let cockpitConfigPath: string;
let restoreHome: (() => void) | null = null;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-status-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-status-team-"));
  homeDir = await mkdtemp(join(tmpdir(), "atmux-status-home-"));
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
  restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
  tmux = createCanonicalAtmuxTmux({ socketPath });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: idempotent teardown
  }
  restoreHome?.();
  restoreHome = null;
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  else delete process.env.TMUX;
  if (priorCockpitConfig !== undefined) {
    process.env.ATMUX_COCKPIT_CONFIG = priorCockpitConfig;
  } else {
    delete process.env.ATMUX_COCKPIT_CONFIG;
  }
  await rm(socketDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
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
  const sessionName = teamName; // bare per e-419553c6
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
    // ADR-273 §Supplement-6: the cell is self-labelled `process: down`
    // so it cannot be read as another column's value.
    expect(out).toContain("state");
    expect(out).toMatch(/process: down\s/);
    // …and the behavioural verdict says the same thing in the words
    // `fleet_attention` uses for a cage that is not running.
    expect(out).toContain("agent: 🛑 session is down");
    expect(out).toContain("📋 kanban board:");
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
    expect(out).toMatch(/process: down\s/);
    // ADR-273 §Supplement-6: the behavioural classifier agrees from the
    // SAME capture — a pane with no agent chrome is `unresponsive`, and
    // the two verdicts must not contradict each other.
    expect(out).toContain("agent: 🛑 no agent output at all");
  });

  test("--json emits expected shape — includes cageState field (t-74273200)", async () => {
    await stageTeam([{ name: "alpha", role: "reviewer", tui: "claude" }], false);
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.team).toMatch(/-team$/);
    // e-419553c6: the session name IS the team name (bare, no prefix).
    expect(parsed.session).toBe(parsed.team);
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
    // The stage's teamDir is a bare `mkdtemp` with no repository, so the
    // cadence probe has nothing to read and the key is omitted entirely
    // (key-presence convention). It previously asserted a full
    // `verdict: "idle"` object here — a verdict manufactured from a git
    // probe that could not look. The deterministic cadence SHAPE is
    // covered where a repo actually answers: see the sibling test that
    // injects `gitLog: async () => []`.
    expect(parsed.members[0].cadence).toBeUndefined();
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

    await writeFile(join(atmuxDir, "driver-inbox.md"), "## Open\n- [t1] **a**: m1\n");
    const { out: openOut } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(openOut).toContain("📬 driver-inbox  open=1");
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

  // ---------- ADR-077 §F5 / ADR-133: medic cockpit-state surface ----------

  test("no cockpit.json → snapshot.medic.configured=false; text omits the row", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // beforeEach pinned ATMUX_COCKPIT_CONFIG at a path that doesn't exist.
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).not.toContain("📋 medic");

    const { out: jsonOut } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(jsonOut);
    expect(parsed.medic).toEqual({
      configured: false,
      enabled: false,
      sessionAlive: false,
      windowAlive: false,
    });
    // ADR-266 §D2: the deprecated `superdoctor` JSON mirror was removed.
    expect(parsed.superdoctor).toBeUndefined();
  });

  test("cockpit.json without medic block → configured=false (silent)", async () => {
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
    expect(parsed.medic.configured).toBe(false);
  });

  test("medic block disabled → configured=true, enabled=false; text shows ⚪ disabled", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeFile(
      cockpitConfigPath,
      JSON.stringify({
        cockpitSession: "atmux_teams",
        medic: { enabled: false },
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
    expect(parsed.medic).toEqual({
      configured: true,
      enabled: false,
      sessionAlive: false,
      windowAlive: false,
    });
  });

  test("medic enabled but cockpit session down → text shows 🔴 cockpit-down", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeFile(
      cockpitConfigPath,
      JSON.stringify({
        cockpitSession: "non-existent-session-for-test",
        medic: { enabled: true },
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

  test("N+M+K=0 → the approval row says nothing is waiting, in its own words", async () => {
    await stageTeam([{ name: "alpha" }], false);
    // No ADRs / no driver-inbox stale / no blocked tasks — total=0.
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    // ADR-273 §Supplement-6: the row names its own subject. The old
    // `📝 NEEDS APPROVAL: ✅ clear`, sitting under `📋 kanban …`, was
    // relayed aloud as "the kanban is clear and needs approval" — two
    // true lines fused into one false claim.
    expect(out).toContain("📝 awaiting your approval: ✅ nothing is waiting for sign-off");
    // The non-zero shape must NOT appear when total=0.
    expect(out).not.toMatch(/awaiting your approval: \d+ proposed ADRs/);
    // And the fusable bare wording is gone for good.
    expect(out).not.toContain("NEEDS APPROVAL");
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
    expect(out).toContain(
      "📝 awaiting your approval: 2 proposed ADRs, 2 driver-inbox asks, 1 blocked kanban tasks",
    );
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
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_CADENCE_THRESHOLDS,
  type Team,
} from "../../../src/schema/team.ts";
import {
  type CadenceObservation,
  classifyCadence,
  formatCadenceColumn,
  formatDurationShort,
  resolveCadenceConfig,
} from "../../../src/verbs/status.ts";

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

// ADR-273 §Supplement-6: every cadence cell now names its own subject.
// The bare forms these replaced were true and unreadable out of column
// context — the vox drilldown transcript read this column's "idle" as a
// PANE state and told the operator the team's panes were idle. Recorded
// here rather than silently rewritten so the next reader does not
// "restore" the shorter strings.
describe("formatCadenceColumn — verdict-to-display", () => {
  test("undefined → 'commits: no signal', never a bare dash", () => {
    expect(formatCadenceColumn(undefined)).toBe("commits: no signal");
    // A dash read aloud is nothing at all; "no signal" is the claim.
    expect(formatCadenceColumn(undefined)).not.toBe("—");
  });

  test("'exempt' → 'commits: exempt'", () => {
    const obs: CadenceObservation = {
      windowSec: 1800,
      commitsInWindow: 0,
      lastCommitAt: null,
      lastCommitSha: null,
      ageOfLastCommitSec: null,
      verdict: "exempt",
    };
    expect(formatCadenceColumn(obs)).toBe("commits: exempt");
  });

  test("each non-exempt verdict carries its subject + emoji + age", () => {
    const base: Omit<CadenceObservation, "verdict"> = {
      windowSec: 1800,
      commitsInWindow: 1,
      lastCommitAt: 1000,
      lastCommitSha: "abc1234",
      ageOfLastCommitSec: 300,
    };
    expect(formatCadenceColumn({ ...base, verdict: "shipping" })).toBe(
      "commits: 🟢 shipping (5min)",
    );
    expect(formatCadenceColumn({ ...base, ageOfLastCommitSec: 3600, verdict: "idle" })).toBe(
      "commits: 🟡 idle (1h)",
    );
    expect(
      formatCadenceColumn({
        ...base,
        ageOfLastCommitSec: 15 * 3600,
        verdict: "dormant",
      }),
    ).toBe("commits: 🔴 dormant (15h)");
    expect(
      formatCadenceColumn({
        ...base,
        ageOfLastCommitSec: 3 * 3600,
        verdict: "ship-zero-window",
      }),
    ).toBe("commits: 🚨 ship-zero (3h)");
  });

  test("EVERY verdict cell is prefixed — none can be read as another column", () => {
    // The property, not four examples of it: a new verdict added without
    // a subject prefix reintroduces exactly the misread W6 recorded.
    const base: Omit<CadenceObservation, "verdict"> = {
      windowSec: 1800,
      commitsInWindow: 1,
      lastCommitAt: 1000,
      lastCommitSha: "abc1234",
      ageOfLastCommitSec: 300,
    };
    const verdicts: ReadonlyArray<CadenceObservation["verdict"]> = [
      "shipping",
      "idle",
      "dormant",
      "ship-zero-window",
      "exempt",
    ];
    for (const verdict of verdicts) {
      expect(formatCadenceColumn({ ...base, verdict })).toStartWith("commits: ");
    }
    expect(formatCadenceColumn(undefined)).toStartWith("commits: ");
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
    expect(r.thresholds.shippingMaxAgeSec).toBe(DEFAULT_CADENCE_THRESHOLDS.shippingMaxAgeSec);
  });

  test("partial thresholds → unset threshold keys fall back to defaults", () => {
    const r = resolveCadenceConfig(makeTeam({ thresholds: { dormantMaxAgeSec: 3600 } }));
    expect(r.thresholds.dormantMaxAgeSec).toBe(3600);
    expect(r.thresholds.shippingMaxAgeSec).toBe(DEFAULT_CADENCE_THRESHOLDS.shippingMaxAgeSec);
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

  test("worktreeIsolation resolves relative and absolute worktree roots for cadence probes", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member" }],
      false,
    );
    const teamRaw = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const cases = [
      {
        team: { ...teamRaw, worktreeIsolation: true },
        expected: join(teamDir, ".atmux", "worktrees", "alpha"),
      },
      {
        team: {
          ...teamRaw,
          worktreeIsolation: true,
          worktreeRoot: join(teamDir, "alt-worktrees"),
        },
        expected: join(teamDir, "alt-worktrees", "alpha"),
      },
    ];

    for (const { team, expected } of cases) {
      const seen: string[] = [];
      const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
        gitLog: async (worktreePath) => {
          seen.push(worktreePath);
          return [];
        },
      });
      expect(seen).toEqual([expected]);
      expect(snap.members[0]?.cadence?.verdict).toBe("idle");
    }
  });
});

// ---------- ADR-077 §lead-uptime-measurement (t-6d950ffd) ----------

import { writeLeadSessionStart } from "../../../src/core/lead-marker.ts";
import {
  type LeadUptimeSnapshot,
  parsePsEtime,
  probeLeadUptime,
} from "../../../src/verbs/status.ts";

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
    const snap: LeadUptimeSnapshot = await probeLeadUptime(tmux, team, sessionName, false, {
      home: homeDir,
    });
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
    const { sessionName } = await stageTeam([{ name: "lead-alpha", role: "team-lead" }], false);
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

  test("default ps probe failure degrades shell_pid_etime_s to null", async () => {
    const { sessionName, teamName } = await stageTeam(
      [{ name: "lead-alpha", role: "team-lead" }],
      true,
    );
    await writeLeadSessionStart(teamName, Math.floor(Date.now() / 1000) - 60, {
      home: homeDir,
    });
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Team;
    const originalWhich = Bun.which.bind(Bun);
    const whichSpy = spyOn(Bun, "which").mockImplementation(((cmd: string) =>
      cmd === "ps" ? null : originalWhich(cmd)) as typeof Bun.which);
    try {
      const snap = await probeLeadUptime(tmux, team, sessionName, true, {
        home: homeDir,
      });
      expect(snap.leadPanePid).toBeGreaterThan(0);
      expect(snap.lead_session_uptime_s).toBeGreaterThanOrEqual(0);
      expect(snap.shell_pid_etime_s).toBeNull();
    } finally {
      whichSpy.mockRestore();
    }
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
    const { teamName } = await stageTeam([{ name: "lead-alpha", role: "team-lead" }], false);
    await writeLeadSessionStart(teamName, Math.floor(Date.now() / 1000) - 180, { home: homeDir });
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
    const { teamName } = await stageTeam([{ name: "lead-alpha", role: "team-lead" }], false);
    await writeLeadSessionStart(teamName, Math.floor(Date.now() / 1000) - 600, { home: homeDir });
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

describe("text mode — agent-state leads, process-state and cadence follow", () => {
  test("header names all three state columns unambiguously", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    // ADR-273 §Supplement-6: the BEHAVIOURAL column leads — it is what
    // the operator asked about, and "active" read aloud means "fine" to a
    // listener even when the pane is blocked forever on a prompt.
    const header = out.split("\n").find((l) => l.startsWith("member ")) ?? "";
    expect(header).toContain("agent-state");
    // The process observable is still there, alongside, and now says so.
    // (ADR-148 §D3 named it `pane-state`; §Supplement-6 renames it to
    // `process-state` because a row now carries TWO pane states and
    // "pane-state" no longer distinguishes them.)
    expect(header).toContain("process-state");
    // The commit-cadence column is the canonical truth-signal column.
    expect(header).toContain("commit-cadence");
    // agent-state comes FIRST of the three.
    expect(header.indexOf("agent-state")).toBeLessThan(header.indexOf("process-state"));
    expect(header.indexOf("process-state")).toBeLessThan(header.indexOf("commit-cadence"));
  });

  test("text mode shows NO cadence for a tmpdir worktree (no .git)", async () => {
    // This test previously asserted the opposite — "no .git → git log
    // probe fails → empty log → verdict='idle'" — and so encoded the bug
    // as the contract. A directory with no repository supports no verdict
    // about commit cadence; `—` ("no signal") is the honest cell, and
    // `🟡 idle (never)` was a confident claim about work that was never
    // observable. It reached the operator SPOKEN through `team_status`:
    // the vox drilldown transcript reported a scratch team's panes as
    // "all idle" (ADR-273 §Supplement-5 W6).
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).not.toMatch(/idle \(never\)/);
    // The row is still rendered — the column just carries no verdict.
    expect(out).toContain("alpha");
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

// ---------- ADR-260 §D5: self-reported status ----------

describe("gatherStatus — selfStatus populated from member-status files (ADR-260 §D5)", () => {
  test("absent status file → row omits selfStatus (key-presence convention)", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => 1_715_000_500_000,
    });
    expect(snap.members[0]?.selfStatus).toBeUndefined();
  });

  test("written status file → row populates status/note/taskId + ageSec from injected clock", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    await writeMemberStatus(atmuxDir, {
      member: "alpha",
      status: "working",
      note: "wiring ADR-260",
      taskId: "t-12345678",
      updatedAtSec: 1_715_000_380, // 120s before injected now
    });
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => 1_715_000_500_000,
    });
    expect(snap.members[0]?.selfStatus).toEqual({
      status: "working",
      note: "wiring ADR-260",
      taskId: "t-12345678",
      ageSec: 120,
    });
  });

  test("future-stamped record clamps ageSec to 0 (clock skew tolerance)", async () => {
    const { sessionName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    await writeMemberStatus(atmuxDir, {
      member: "alpha",
      status: "idle",
      updatedAtSec: 1_715_000_999,
    });
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => 1_715_000_500_000,
    });
    expect(snap.members[0]?.selfStatus?.ageSec).toBe(0);
  });
});

describe("formatSelfStatusColumn — pure formatter (ADR-260 §D5)", () => {
  const base: MemberStatus = {
    name: "alpha",
    role: "member",
    tui: "claude",
    paneCommand: "claude",
    cageState: null,
    pendingCount: 0,
    inProgressCount: 0,
    heartbeat_age_s: null,
  };

  test("never self-reported → '—' (renderer omits the segment)", () => {
    expect(formatSelfStatusColumn(base)).toBe("—");
  });

  test("with taskId → '📍<status>(<taskId>, <age>)'", () => {
    const m: MemberStatus = {
      ...base,
      selfStatus: { status: "working", taskId: "t-12345678", ageSec: 120 },
    };
    expect(formatSelfStatusColumn(m)).toBe("📍working(t-12345678, 2m)");
  });

  test("without taskId → '📍<status>(<age>)'", () => {
    const m: MemberStatus = { ...base, selfStatus: { status: "idle", ageSec: 45 } };
    expect(formatSelfStatusColumn(m)).toBe("📍idle(45s)");
  });

  test("hour-scale age uses the heartbeat unit convention", () => {
    const m: MemberStatus = { ...base, selfStatus: { status: "blocked", ageSec: 7300 } };
    expect(formatSelfStatusColumn(m)).toBe("📍blocked(2h)");
  });
});

describe("status verb — selfStatus end-to-end (ADR-260 §D5)", () => {
  test("--json emits selfStatus when the member has self-reported; text mode shows 📍 segment", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await writeMemberStatus(atmuxDir, {
      member: "alpha",
      status: "working",
      taskId: "t-12345678",
      updatedAtSec: Math.floor(Date.now() / 1000) - 30,
    });
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.members[0].selfStatus).toMatchObject({
      status: "working",
      taskId: "t-12345678",
    });
    expect(parsed.members[0].selfStatus.ageSec).toBeGreaterThanOrEqual(30);

    const { out: text } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(text).toContain("📍working(t-12345678,");
  });
});

// ---------- ADR-273 D3 trap 1 ----------

describe("gatherStatus — the cage probe gets the RESOLVED session name", () => {
  test("the probe is handed the same session name gatherStatus was given", async () => {
    // `status()` resolves the name through `getSessionName` (anchor-aware),
    // then hands it to `gatherStatus`. Before this fix the probe threw
    // that away and rebuilt `atmux-<team>`, which names no session at all
    // for an anchored team — so every member of a live `unum`
    // (`atmux_unum`) or `atmux` (bare `atmux`) reported as `down`.
    const anchored = `${sessionPrefix}_anchored`;
    const { teamName } = await stageTeam(
      [{ name: "alpha", emoji: "🐝", role: "member", tui: "claude" }],
      false,
    );
    await tmux.session.newSession({ name: anchored, shellCommand: "cat", windowName: "🐝alpha" });
    await new Promise((r) => setTimeout(r, 80));
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const seen: Array<string | undefined> = [];
    const snap = await gatherStatus(tmux, team, anchored, atmuxDir, {
      probeCage: async (_t, m, _dir, opts) => {
        seen.push(opts?.sessionName);
        return {
          member: m.name,
          windowName: "🐝alpha",
          state: "active",
          paneUptimeSec: 10,
          evidence: "",
          heartbeatAgeSec: null,
        };
      },
    });
    expect(snap.team).toBe(teamName);
    expect(seen).toEqual([anchored]);
    // …and it must NOT be the rebuilt legacy form.
    expect(seen).not.toContain(`atmux-${teamName}`);
    expect(snap.members[0]?.cageState).toBe("active");
  });
});

// ---------- Member panes are ENUMERATED, not guessed ----------
//
// `atmux status` printed a team's session as `[up]` and, on the very next
// lines, every one of its panes as `down`. The two halves disagreed
// because status SYNTHESIZED each member's window name — the cage probe
// substituted a role-default emoji the roster never carried, producing
// `🐝-be-1` for a window plainly named `be-1` — while `atmux fleet`,
// reading the SAME socket, enumerated the window list and classified the
// same panes correctly.
//
// `team_status` is a voice tool, so those `down` rows were spoken to the
// operator as fact about healthy panes: the "cries wolf" class ADR-273 D3
// is written against.

describe("gatherStatus — panes resolve against the LIVE window list", () => {
  test("each member is read from its OWN window, not the session's current one", async () => {
    // The windows here carry the pre-ADR-135 `<emoji><name>` form while
    // the synthesized target is the ADR-135 `<emoji>-<name>` one, so every
    // synthesized target misses. tmux does not error on a missed
    // `display-message` target — it answers about the session's CURRENT
    // window — so pre-fix BOTH members reported that one window's command.
    //
    // The two panes therefore run DIFFERENT commands: `cat` and `sleep`.
    // A test where both ran `cat` would pass on the wrong answer.
    const teamName = `${sessionPrefix}-team`;
    const sessionName = teamName; // bare per e-419553c6
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: teamName,
        members: [
          { name: "alpha", emoji: "🐝", tui: "cursor" },
          { name: "beta", emoji: "🐝", tui: "cursor" },
        ],
      }),
    );
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: "🐝alpha",
    });
    await tmux.window.newWindow({
      sessionName,
      name: "🐝beta",
      shellCommand: "sleep 100",
    });
    await new Promise((r) => setTimeout(r, 120));

    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.sessionState).toBe("up");
    const alpha = parsed.members.find((m: { name: string }) => m.name === "alpha");
    const beta = parsed.members.find((m: { name: string }) => m.name === "beta");
    expect(alpha.paneCommand).toBe("cat");
    expect(beta.paneCommand).toBe("sleep");
    // Neither is `(down)`, and neither has borrowed the other's command.
    expect(alpha.paneCommand).not.toBe(beta.paneCommand);
  });

  test("a member with no window at all reads (down), not a SIBLING pane's command", async () => {
    // The complement, and a bug in its own right. `display-message -t
    // <session>:<missing-window>` does not fail — tmux resolves it to the
    // session's CURRENT window and exits 0. So a member with no pane used
    // to be reported with whatever `alpha` happened to be running.
    const { teamName } = await stageTeam([{ name: "alpha", emoji: "🐝", tui: "cursor" }], true);
    // `ghost` joins the roster AFTER staging, so it has no window at all.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: teamName,
        members: [
          { name: "alpha", emoji: "🐝", tui: "cursor" },
          { name: "ghost", emoji: "🐝", tui: "cursor" },
        ],
      }),
    );
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    const alpha = parsed.members.find((m: { name: string }) => m.name === "alpha");
    const ghost = parsed.members.find((m: { name: string }) => m.name === "ghost");
    expect(alpha.paneCommand).toBe("cat");
    expect(ghost.paneCommand).toBe("(down)");
    // The precise lie this closes: ghost must not inherit alpha's command.
    expect(ghost.paneCommand).not.toBe("cat");
  });

  test("the cage probe is handed the REAL window names, read once for the whole roster", async () => {
    // Two properties in one: (1) the names the probe gets are the ones
    // tmux reports — an empty or synthesized list is what produced the
    // false `down`s; (2) they are read ONCE, not once per member.
    await stageTeam(
      [
        { name: "alpha", emoji: "🐝" },
        { name: "beta", emoji: "🐝" },
      ],
      true,
    );
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    let listWindowsCalls = 0;
    const counting = {
      ...tmux,
      window: {
        ...tmux.window,
        async listWindows(s: string) {
          listWindowsCalls += 1;
          return await tmux.window.listWindows(s);
        },
      },
    } as unknown as TmuxNamespace;
    const handed: Array<ReadonlyArray<string>> = [];
    await gatherStatus(counting, team, team.name, atmuxDir, {
      probeCage: async (_t, m, _dir, opts) => {
        handed.push(await (opts?.listWindowNames?.(team.name) ?? Promise.resolve([])));
        return {
          member: m.name,
          windowName: m.name,
          state: "active",
          paneUptimeSec: 1,
          evidence: "",
          heartbeatAgeSec: null,
        };
      },
    });
    expect(handed).toHaveLength(2);
    for (const names of handed) {
      expect([...names].sort()).toEqual(["🐝alpha", "🐝beta"]);
    }
    // One list-windows for the whole roster — plus the one readPaneCommand
    // shares. Never one per member.
    expect(listWindowsCalls).toBe(1);
  });

  test("session down → no window list is read and every pane reads (down)", async () => {
    await stageTeam([{ name: "alpha", emoji: "🐝" }], false);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    let listWindowsCalls = 0;
    const counting = {
      ...tmux,
      window: {
        ...tmux.window,
        async listWindows(s: string) {
          listWindowsCalls += 1;
          return await tmux.window.listWindows(s);
        },
      },
    } as unknown as TmuxNamespace;
    const snap = await gatherStatus(counting, team, team.name, atmuxDir);
    expect(snap.sessionState).toBe("down");
    expect(snap.members[0]?.paneCommand).toBe("(down)");
    expect(listWindowsCalls).toBe(0);
  });

  test("a worktree that is not a git repo reports NO cadence, not 'idle (never)'", async () => {
    // `atmux status` rendered `🟡 idle (never)` for a member whose
    // worktree has no repository at all — a verdict about work that was
    // never observable. `team_status` then spoke it: the vox drilldown
    // transcript said a scratch team's panes were "all idle".
    await stageTeam([{ name: "alpha", emoji: "🐝" }], false);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, team.name, atmuxDir, {
      // null = "could not read a repository here", what the real probe
      // now returns for a non-repo path.
      gitLog: async () => null,
    });
    expect(snap.members[0]?.cadence).toBeUndefined();
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).not.toContain("idle (never)");
  });

  test("a real repo with no matching commits still reports idle — the complement", async () => {
    // The distinction must not collapse the other way: `[]` is evidence
    // (a repo that has no commits by this author), and `idle` is the
    // correct verdict for it.
    await stageTeam([{ name: "alpha", emoji: "🐝" }], false);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, team.name, atmuxDir, {
      gitLog: async () => [],
    });
    expect(snap.members[0]?.cadence?.verdict).toBe("idle");
  });

  test("an unreadable window list degrades to the pre-existing guess, never worse", async () => {
    // A tmux hiccup is evidence of nothing, so it must not be read as
    // "this member has no window". Resolution falls back to the name the
    // old code synthesized and the column behaves exactly as it did
    // before the seam existed — no new false `down`s.
    await stageTeam([{ name: "alpha", emoji: "🐝", tui: "cursor" }], true);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const broken = {
      ...tmux,
      window: {
        ...tmux.window,
        async listWindows() {
          throw new Error("tmux server gone");
        },
      },
    } as unknown as TmuxNamespace;
    const snap = await gatherStatus(broken, team, team.name, atmuxDir);
    expect(snap.sessionState).toBe("up");
    // Pre-seam behaviour verbatim: the synthesized target is asked, and
    // tmux answers about the current window rather than erroring.
    expect(snap.members[0]?.paneCommand).toBe("cat");
  });
});

// ---------- The pane-state column can say "I could not tell" ----------
//
// ADR-273 §Supplement-5 / the coordinator's second finding: the tool
// returned ok=true and reported pane states as fact with no way to signal
// that it had inferred rather than measured them, and the model then
// confabulated on top of a confident wrong answer. A voice tool that
// cannot say "I don't know" is one an operator cannot trust.

describe("formatPaneStateColumn — inferred states are marked, measured ones are not", () => {
  const base: MemberStatus = {
    name: "alpha",
    role: "member",
    tui: "claude",
    paneCommand: "claude",
    cageState: "active",
    pendingCount: 0,
    inProgressCount: 0,
    heartbeat_age_s: null,
  };

  test("a measured state renders bare — no marker means the process was identified", () => {
    expect(formatPaneStateColumn({ ...base, cageInferredFromRender: false })).toBe("active");
  });

  test("a state read off the pane's render carries a trailing ?", () => {
    expect(formatPaneStateColumn({ ...base, cageInferredFromRender: true })).toBe("active?");
  });

  test("no claim at all renders bare (non-claude TUI, session down, stubbed probe)", () => {
    expect(formatPaneStateColumn(base)).toBe("active");
  });

  test("a down row never carries the marker — two agreeing signals are not a hedge", () => {
    expect(formatPaneStateColumn({ ...base, cageState: "down" })).toBe("down");
  });

  test("non-claude TUIs still fall back to paneCommand", () => {
    expect(formatPaneStateColumn({ ...base, cageState: null, paneCommand: "cat" })).toBe("cat");
  });
});

describe("status — an inferred pane state is marked in BOTH text and JSON", () => {
  /** A live window whose pane text is an unmistakable Claude Code modal
   *  but which holds no `claude` process — the vox e2e cage's exact
   *  shape, and the case where the probe must hedge rather than assert. */
  async function stageAgentLookingPane(): Promise<void> {
    const teamName = `${sessionPrefix}-team`;
    const sessionName = teamName; // bare per e-419553c6
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: teamName, members: [{ name: "alpha", tui: "claude" }] }),
    );
    const textPath = join(teamDir, "pane.txt");
    await writeFile(textPath, "● Read 240 lines\n\n│ Do you want to make this edit?\n│ ❯ 1. Yes\n");
    await tmux.session.newSession({
      name: sessionName,
      windowName: "alpha",
      shellCommand: `cat ${textPath}; exec sleep 60`,
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  test("JSON carries cageInferredFromRender and text carries the trailing ?", async () => {
    await stageAgentLookingPane();
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    const alpha = parsed.members[0];
    // Not `down` — the pane is plainly an agent TUI…
    expect(alpha.cageState).not.toBe("down");
    // …but nothing identified the process, and the row says so.
    expect(alpha.cageInferredFromRender).toBe(true);

    const { out: text } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(text).toMatch(new RegExp(`${alpha.cageState}\\?`));
  });
});

// ---------- The approval row describes THIS team, not the caller ----------
//
// `📝 NEEDS APPROVAL: 19 ADRs / 1157 inbox / 2 kanban` was reported for a
// `mkdtemp` team that could not possibly have any: `scanNeedsApproval` was
// called with no arguments, so it walked up from `process.cwd()` and
// scanned whatever repo the CALLER was standing in. Under the voice
// bridge (`team_status` → `atmux status --team-dir <root>`) that is the
// server's own repo, spoken as a fact about someone else's team.
//
// These tests deliberately do NOT pin `ATMUX_DIR` / `ATMUX_TEAM_DIR` — the
// escape hatch the older approval tests use. The scoping has to come from
// `--team-dir` alone, because that is all the voice bridge passes.

describe("status — NEEDS APPROVAL is scoped to the team, not the ambient repo", () => {
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;

  beforeEach(() => {
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
  });

  afterEach(() => {
    if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
  });

  test("a scratch team with an empty root reports zeros, not the surrounding repo's debt", async () => {
    // cwd during this run is the atmux repo, which carries a real backlog
    // of proposed ADRs and driver-inbox asks. None of them belong to this
    // team, so none of them may appear.
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📝 awaiting your approval: ✅ nothing is waiting for sign-off");
    expect(out).not.toMatch(/awaiting your approval: \d+ proposed ADRs/);
  });

  test("it counts the TEAM's own paperwork — one proposed ADR under the team root reads as 1", async () => {
    // The load-bearing half: this cannot pass vacuously. If the scan were
    // still walking up from cwd it would report the repo's double-digit
    // ADR backlog here, not 1.
    await stageTeam([{ name: "alpha" }], false);
    const adrDir = join(teamDir, "docs", "adr");
    await mkdir(adrDir, { recursive: true });
    await writeFile(join(adrDir, "900-scoped.md"), "# Scoped\n\n**Status**: proposed\n");

    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.needsApproval.adr).toHaveLength(1);
    expect(parsed.needsApproval.adr[0].id).toBe("900-scoped");
    expect(parsed.needsApproval.adr[0].path).toContain(teamDir);
    expect(parsed.needsApproval.inbox).toHaveLength(0);
    expect(parsed.needsApproval.total).toBe(1);
  });
});

// ---------------------------------------------------------------------
// ADR-273 §Supplement-6 — the behavioural verdict, alongside the process
// ---------------------------------------------------------------------
//
// W6 left `team_status` and `fleet_attention` speaking different
// vocabularies about the same pane: "active" versus "waiting on a
// permission prompt". Both true, jointly useless — and on a SPOKEN
// surface "active" is heard as "fine". These pin the decision that closed
// it: `team_status` surfaces the fleet classifier's per-pane verdict
// ALONGSIDE the cage state, with the behavioural one leading.

const AGENT_BASE: MemberStatus = {
  name: "alpha",
  role: "member",
  tui: "claude",
  paneCommand: "claude",
  cageState: "active",
  pendingCount: 0,
  inProgressCount: 0,
  heartbeat_age_s: null,
};

describe("formatAgentStateColumn — the behavioural cell", () => {
  test("an attention verdict renders the SAME clause fleet_attention speaks", () => {
    expect(
      formatAgentStateColumn({
        ...AGENT_BASE,
        agentState: { bucket: "attention", kind: "permission-prompt", marker: "Do you want to" },
      }),
    ).toBe("agent: 🛑 waiting on a permission prompt");
  });

  test("a chronic attention verdict is amber, not red", () => {
    expect(
      formatAgentStateColumn({
        ...AGENT_BASE,
        agentState: { bucket: "attention", kind: "dormant", marker: "no output for 3h" },
      }),
    ).toBe("agent: 🟡 parked with nothing queued");
  });

  test("a quiet verdict renders green with its quiet label", () => {
    expect(
      formatAgentStateColumn({ ...AGENT_BASE, agentState: { bucket: "quiet", kind: "working" } }),
    ).toBe("agent: 🟢 working");
  });

  test("no verdict says 'no reading' — never anything that could be heard as fine", () => {
    // Absent means no probe ran (non-claude TUI, or a probe that threw).
    // A tool with no way to say "I could not tell" is one an operator
    // stops trusting — the same rule the `?` marker exists for.
    const cell = formatAgentStateColumn(AGENT_BASE);
    expect(cell).toBe("agent: ❔ no reading");
    expect(cell).not.toContain("working");
    expect(cell).not.toContain("🟢");
  });
});

describe("formatProcessStateColumn — the process cell, self-labelled", () => {
  test("carries the pane-state value verbatim, prefixed with its subject", () => {
    expect(formatProcessStateColumn(AGENT_BASE)).toBe("process: active");
    expect(formatProcessStateColumn({ ...AGENT_BASE, cageState: "down" })).toBe("process: down");
  });

  test("the inferred-from-render marker survives the prefix", () => {
    // The `?` is the probe's own hedge (§Supplement-5 W5). Losing it here
    // would launder an uncertain read into a confident one.
    expect(formatProcessStateColumn({ ...AGENT_BASE, cageInferredFromRender: true })).toBe(
      "process: active?",
    );
  });

  test("a row read out of column context still names what the value is about", () => {
    // The literal W6 residue: a bare `active` in a row of bare cells is
    // what a model turns into "all panes are active".
    expect(formatProcessStateColumn(AGENT_BASE)).toStartWith("process: ");
  });
});

describe("formatAgentEvidenceLine — every attention claim carries its evidence", () => {
  test("an attention verdict yields an indented evidence line naming the member", () => {
    const line = formatAgentEvidenceLine({
      ...AGENT_BASE,
      agentState: {
        bucket: "attention",
        kind: "permission-prompt",
        marker: "Do you want to make this edit?",
      },
    });
    expect(line).toContain("evidence for alpha:");
    expect(line).toContain("Do you want to make this edit?");
    expect(line?.startsWith(" ")).toBe(true);
  });

  test("a quiet verdict yields no line — the budget belongs to the findings", () => {
    expect(
      formatAgentEvidenceLine({ ...AGENT_BASE, agentState: { bucket: "quiet", kind: "working" } }),
    ).toBeNull();
  });

  test("no verdict at all yields no line", () => {
    expect(formatAgentEvidenceLine(AGENT_BASE)).toBeNull();
  });

  test("an empty marker yields no line rather than a dangling arrow", () => {
    expect(
      formatAgentEvidenceLine({
        ...AGENT_BASE,
        agentState: { bucket: "attention", kind: "unreadable", marker: "   " },
      }),
    ).toBeNull();
  });

  test("a long marker is truncated with an ellipsis, not wrapped", () => {
    const line = formatAgentEvidenceLine({
      ...AGENT_BASE,
      agentState: { bucket: "attention", kind: "idle-residue", marker: "x".repeat(400) },
    });
    expect(line).not.toBeNull();
    expect(line?.includes("\n")).toBe(false);
    expect(line).toContain("…");
    expect((line ?? "").length).toBeLessThan(160);
  });

  test("the label follows the member's display label, not its id", () => {
    // ADR-136 TR4 — the operator-facing string is the label when set.
    const line = formatAgentEvidenceLine({
      ...AGENT_BASE,
      label: "backend",
      agentState: { bucket: "attention", kind: "crashed", marker: "no agent TUI" },
    });
    expect(line).toContain("evidence for backend:");
  });
});

// ---------------------------------------------------------------------
// The cross-surface pin: the SAME panes the voice judge grades
// ---------------------------------------------------------------------

describe("status — team_status agrees with fleet_attention about the same panes", () => {
  /**
   * Paint the voice e2e fixture panes into a real tmux session.
   *
   * These are the exact strings `tests/unit/core/vox/e2e/fixtures.test.ts`
   * runs through `classifyPaneObservation`, and the exact strings the vox
   * judge grades against. Asserting `atmux status` reaches each fixture's
   * DECLARED verdict is therefore a direct pin on the two surfaces
   * agreeing — the drift W6 recorded fails here first.
   */
  async function stageFixtureCage(): Promise<{ teamName: string; sessionName: string }> {
    const alpha = TEAM_FIXTURES.find((t) => t.kind === "live");
    if (alpha === undefined) throw new Error("test fixture: no live team");
    const teamName = `${sessionPrefix}-team`;
    const sessionName = teamName; // bare per e-419553c6
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: teamName,
        members: alpha.panes.map((p) => ({ name: p.member, role: "member" })),
      }),
    );
    const [first, ...rest] = alpha.panes;
    if (first === undefined) throw new Error("test fixture: no panes");
    const paint = async (member: string, text: string): Promise<string> => {
      const path = join(teamDir, `${member}.txt`);
      await writeFile(path, text);
      // `exec` replaces the shell so pane_current_command is not a shell —
      // the classifier reads a bare shell as evidence the TUI is gone.
      return `cat ${path}; exec sleep 120`;
    };
    await tmux.session.newSession({
      name: sessionName,
      windowName: first.member,
      shellCommand: await paint(first.member, first.text),
    });
    for (const pane of rest) {
      await tmux.window.newWindow({
        sessionName,
        name: pane.member,
        shellCommand: await paint(pane.member, pane.text),
      });
    }
    await new Promise((r) => setTimeout(r, 250));
    return { teamName, sessionName };
  }

  /**
   * The real tmux namespace with ONE signal overridden: the window
   * activity clock reads 200s old.
   *
   * Not a convenience — it is the only way to exercise the residue
   * fixture, whose declared verdict requires a window nothing has touched
   * for over a minute (`minStaleSec: 70`). 200s is deliberately between
   * RESIDUE_FRESH_SEC (60) and FROZEN_ACTIVITY_SEC (300), so it ages the
   * wedge WITHOUT turning the working pane into a frozen one. Everything
   * else — the capture, the window list, the pane list, `ps` — is real.
   */
  function agedTmux(nowSec: number): TmuxNamespace {
    return {
      ...tmux,
      pane: {
        ...tmux.pane,
        async displayMessage(opts: { target: string; format: string; print?: boolean }) {
          const real = await tmux.pane.displayMessage(opts);
          const parts = real.split("\t");
          if (parts.length < 3) return real;
          return [String(nowSec - 200), parts[1], parts[2]].join("\t");
        },
      },
    } as unknown as TmuxNamespace;
  }

  test("every fixture pane reaches the verdict the voice judge is told is true", async () => {
    const { teamName, sessionName } = await stageFixtureCage();
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    expect(team.name).toBe(teamName);
    const nowSec = Math.floor(Date.now() / 1000);
    const snap = await gatherStatus(agedTmux(nowSec), team, sessionName, atmuxDir);
    const alpha = TEAM_FIXTURES.find((t) => t.kind === "live");
    expect(alpha?.panes.length).toBeGreaterThan(0);
    for (const pane of alpha?.panes ?? []) {
      const row = snap.members.find((m) => m.name === pane.member);
      expect(row).toBeDefined();
      // The whole point: the row's behavioural verdict is the fixture's
      // declared one — which is what `classifyPaneObservation` produces
      // and what the judge's ground truth says.
      expect(row?.agentState?.bucket).toBe(pane.expect.bucket);
      expect(row?.agentState?.kind).toBe(pane.expect.kind);
    }
    // …and the process column still answers its own, different question:
    // every pane's process is up. That is exactly the pair of claims the
    // decision preserves — behaviour leading, process alongside.
    for (const row of snap.members) expect(row.cageState).not.toBe("down");
  });

  test("text mode leads with the behavioural verdict and prints its evidence", async () => {
    const { sessionName } = await stageFixtureCage();
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const snap = await gatherStatus(agedTmux(nowSec), team, sessionName, atmuxDir);
    const blocked = snap.members.find((m) => m.agentState?.kind === "permission-prompt");
    expect(blocked).toBeDefined();
    expect(formatAgentStateColumn(blocked as MemberStatus)).toBe(
      "agent: 🛑 waiting on a permission prompt",
    );
    const evidence = formatAgentEvidenceLine(blocked as MemberStatus);
    expect(evidence).toContain("Do you want to make this edit?");
  });

  test("--json carries bucket, kind, the spoken reason, and the evidence marker", async () => {
    await stageFixtureCage();
    const { out } = await captureStdout(() =>
      status(["--json", "--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    const blocked = parsed.members.find(
      (m: { agentState?: { kind: string } }) => m.agentState?.kind === "permission-prompt",
    );
    expect(blocked).toBeDefined();
    expect(blocked.agentState.bucket).toBe("attention");
    expect(blocked.agentState.reason).toBe("waiting on a permission prompt");
    expect(blocked.agentState.marker).toContain("Do you want to make this edit?");
    // The process state is still there, alongside.
    expect(blocked.cageState).not.toBe("down");
    // A quiet row carries no marker — there is no finding to evidence.
    const working = parsed.members.find(
      (m: { agentState?: { kind: string } }) => m.agentState?.kind === "working",
    );
    expect(working).toBeDefined();
    expect(working.agentState.bucket).toBe("quiet");
    expect(working.agentState.marker).toBeUndefined();
  });
});

describe("status — a session that is down reports the agent dead, in the shared words", () => {
  test("gatherStatus routes session-down through the SHARED classifier", async () => {
    // Not a hand-written literal: the clause must be the one
    // `fleet_attention` speaks for a cage that is not running, or the two
    // tools describe the same fleet differently again.
    await stageTeam([{ name: "alpha" }], false);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, team.name, atmuxDir);
    expect(snap.members[0]?.agentState).toEqual({
      bucket: "attention",
      kind: "dead",
      marker: "tmux session absent",
    });
    expect(snap.members[0]?.cageState).toBe("down");
  });

  test("a non-claude TUI gets NO behavioural reading rather than a guessed one", async () => {
    // The cage probe is claude-specific, so nothing observed this pane
    // behaviourally. The honest cell is "no reading" — inventing a quiet
    // verdict here would be the same lie in the other direction.
    await stageTeam([{ name: "alpha", tui: "cursor" }], true);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, team.name, atmuxDir);
    expect(snap.members[0]?.agentState).toBeUndefined();
    expect(formatAgentStateColumn(snap.members[0] as MemberStatus)).toBe("agent: ❔ no reading");
  });
});

describe("status — the kanban and approval lines cannot be fused when read aloud", () => {
  test("each line names its own subject in full", async () => {
    // W6's second residue: `📋 kanban  📌 todo=0 …` followed by
    // `📝 NEEDS APPROVAL: ✅ clear` was relayed as "the kanban is clear
    // and needs approval". Every line printed was true.
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📋 kanban board:");
    expect(out).toContain("📝 awaiting your approval:");
    // The fusable pair is gone: no bare "kanban" line and no bare
    // "NEEDS APPROVAL" clause that could attach to it.
    expect(out).not.toMatch(/📋 kanban {2}📌/);
    expect(out).not.toContain("NEEDS APPROVAL");
  });

  test("an EMPTY board says so in a sentence, spending no pane vocabulary", async () => {
    // "in-progress" and "blocked" are ALSO pane words. A model relaying
    // "no tasks are in progress or blocked" about a team that HAS a
    // blocked pane produces a sentence that reads as a contradiction —
    // the vox judge scored exactly that. With nothing on the board, the
    // shorter sentence is both true and unmistakable.
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📋 kanban board: no tasks on it at all");
    expect(out).not.toContain("in-progress");
    expect(out).not.toMatch(/kanban board:.*blocked/);
  });

  test("a NON-empty board keeps the noun attached to every number", async () => {
    await stageTeam([{ name: "alpha" }], false);
    await addTask(atmuxDir, { subject: "one" });
    const blockedId = await addTask(atmuxDir, { subject: "two" });
    await moveTask(atmuxDir, blockedId, "blocked");
    const { out } = await captureStdout(() =>
      status(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(out).toContain("📌 1 tasks todo");
    expect(out).toContain("🟡 0 tasks in-progress");
    expect(out).toContain("✅ 0 tasks done");
    expect(out).toContain("🛑 1 tasks blocked");
    // The subject leads the line, so no count can be read as a pane fact.
    expect(out).toContain("📋 kanban board:");
  });
});

// ---------------------------------------------------------------------
// The fail-soft seams around the shared read (ADR-273 §Supplement-6)
// ---------------------------------------------------------------------
//
// Both of these are paths where the probe LOST its evidence. Neither may
// invent a verdict to fill the hole — a spoken surface has no way to show
// the operator that a confident-sounding answer came from a failure.

describe("status — a failed window read degrades, it does not fabricate", () => {
  test("display-message throwing leaves the pane (down) with no window signals", async () => {
    await stageTeam([{ name: "alpha", tui: "cursor" }], true);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const broken = {
      ...tmux,
      pane: {
        ...tmux.pane,
        async displayMessage() {
          throw new Error("tmux server went away");
        },
      },
    } as unknown as TmuxNamespace;
    const snap = await gatherStatus(broken, team, team.name, atmuxDir);
    // The legacy column falls back exactly as it always did…
    expect(snap.members[0]?.paneCommand).toBe("(down)");
    // …and nothing manufactured a behavioural verdict out of the failure.
    expect(snap.members[0]?.agentState).toBeUndefined();
  });

  test("a cage probe that THROWS yields no state and no agent verdict", async () => {
    // Not `down`, not `working` — the probe returned nothing, so the row
    // claims nothing. `formatAgentStateColumn` renders "no reading".
    await stageTeam([{ name: "alpha" }], true);
    const team = JSON.parse(await Bun.file(join(atmuxDir, "team.json")).text()) as Parameters<
      typeof gatherStatus
    >[1];
    const snap = await gatherStatus(tmux, team, team.name, atmuxDir, {
      probeCage: async () => {
        throw new Error("probe exploded");
      },
    });
    expect(snap.members[0]?.cageState).toBeNull();
    expect(snap.members[0]?.agentState).toBeUndefined();
    expect(formatAgentStateColumn(snap.members[0] as MemberStatus)).toBe("agent: ❔ no reading");
  });
});
