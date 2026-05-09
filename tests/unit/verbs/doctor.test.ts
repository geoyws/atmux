// Unit tests for src/verbs/doctor.ts (ADR-010 + ADR-019).
// Bash spec ref: lib/doctor.sh @ worktree-frozen — IN-SCOPE SUBSET.
//
// Coverage strategy
// -----------------
// Pure helpers (parseDoctorArgs, buildReport, firstBin, installHint,
// resolveMemberBin, renderHuman, renderJson) tested directly. Per-check
// fns (checkDeps/Team/Tuis/StateDir/Webhook/PhantomInboxes/OrphanSessions)
// driven against fixture .atmux/ + injected `which`/`probe`/`hasSession`.
// Public verb driven against fixture team.json with both runChecks
// override (focused) and the default chain (integration smoke).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../../src/errors.ts";
import type { Team, TeamMember } from "../../../src/schema/team.ts";
import {
  buildReport,
  checkCronIntervalDivisors,
  checkDeps,
  checkInboxMarks,
  checkOrphanSessions,
  checkPhantomInboxes,
  checkStateDir,
  checkSubmoduleIntegrity,
  checkTeam,
  checkTuis,
  checkWebhook,
  checkWhipConfigDrift,
  type DoctorRow,
  doctor,
  findInboxTaskMarks,
  findPhantomInboxes,
  firstBin,
  installHint,
  parseDoctorArgs,
  parseSubmoduleStatus,
  renderHuman,
  renderJson,
  resolveMemberBin,
  runAllChecks,
} from "../../../src/verbs/doctor.ts";

// ---------- parseDoctorArgs ----------

describe("parseDoctorArgs", () => {
  test("default — quiet/fix/json all false", () => {
    expect(parseDoctorArgs([])).toEqual({ quiet: false, fix: false, json: false });
  });

  test("--quiet and -q flip quiet", () => {
    expect(parseDoctorArgs(["--quiet"]).quiet).toBe(true);
    expect(parseDoctorArgs(["-q"]).quiet).toBe(true);
  });

  test("--fix flips fix", () => {
    expect(parseDoctorArgs(["--fix"]).fix).toBe(true);
  });

  test("--json flips json", () => {
    expect(parseDoctorArgs(["--json"]).json).toBe(true);
  });

  test("--team-dir captured", () => {
    expect(parseDoctorArgs(["--team-dir", "/x"])).toEqual({
      quiet: false,
      fix: false,
      json: false,
      teamDir: "/x",
    });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseDoctorArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseDoctorArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- buildReport ----------

describe("buildReport", () => {
  test("empty rows → 0/0", () => {
    const r = buildReport([]);
    expect(r).toEqual({ rows: [], redCount: 0, yellowCount: 0 });
  });

  test("counts red + yellow", () => {
    const rows: DoctorRow[] = [
      { status: "green", label: "a" },
      { status: "yellow", label: "b" },
      { status: "red", label: "c" },
      { status: "red", label: "d" },
    ];
    const r = buildReport(rows);
    expect(r.redCount).toBe(2);
    expect(r.yellowCount).toBe(1);
    expect(r.rows.length).toBe(4);
  });
});

// ---------- firstBin / installHint ----------

describe("firstBin", () => {
  test("plain bin returns as-is", () => {
    expect(firstBin("claude")).toBe("claude");
  });

  test("KEY=VAL prefixes are skipped", () => {
    expect(firstBin("ANTHROPIC_API_KEY=secret claude")).toBe("claude");
  });

  test("no non-KEY=VAL token → empty string", () => {
    expect(firstBin("FOO=bar BAZ=qux")).toBe("");
  });
});

describe("installHint", () => {
  test("known TUI binaries return URLs", () => {
    expect(installHint("claude")).toBe("https://docs.anthropic.com/en/docs/claude-code");
    expect(installHint("opencode")).toBe("https://opencode.ai");
    expect(installHint("kimi")).toBe("https://platform.moonshot.ai");
    expect(installHint("cursor-agent")).toBe("https://cursor.com/cli");
  });

  test("darwin → brew install", () => {
    expect(installHint("tmux", "darwin")).toBe("brew install tmux");
  });

  test("linux → apt install", () => {
    expect(installHint("jq", "linux")).toContain("apt install jq");
  });

  test("other platforms → fallback hint", () => {
    expect(installHint("git", "win32")).toBe("see the project's install docs");
  });
});

// ---------- checkDeps ----------

describe("checkDeps", () => {
  test("all required deps found → green rows", () => {
    const which = (cmd: string) => `/usr/bin/${cmd}`;
    const rows = checkDeps({ which, platform: "linux" });
    const reqRows = rows.filter((r) => /^dep:(tmux|jq|git)$/.test(r.label));
    expect(reqRows.every((r) => r.status === "green")).toBe(true);
  });

  test("required dep missing → red row with install hint", () => {
    const which = (cmd: string) => (cmd === "jq" ? null : `/usr/bin/${cmd}`);
    const rows = checkDeps({ which, platform: "linux" });
    const jqRow = rows.find((r) => r.label === "dep:jq");
    expect(jqRow?.status).toBe("red");
    expect(jqRow?.hint).toContain("apt install jq");
  });

  test("optional dep missing → yellow with reason", () => {
    const which = (cmd: string) => (cmd === "curl" ? null : `/usr/bin/${cmd}`);
    const rows = checkDeps({ which, platform: "linux" });
    const curlRow = rows.find((r) => r.label === "dep:curl");
    expect(curlRow?.status).toBe("yellow");
    expect(curlRow?.hint).toContain("discord webhook");
  });

  test("optional dep present → green with (optional) marker", () => {
    const which = (_cmd: string) => "/usr/bin/x";
    const rows = checkDeps({ which });
    const curlRow = rows.find((r) => r.label === "dep:curl");
    expect(curlRow?.status).toBe("green");
    expect(curlRow?.detail).toContain("(optional)");
  });

  test("uses defaults when opts omitted", () => {
    // Just make sure it runs against the real env without throwing.
    const rows = checkDeps();
    expect(rows.length).toBe(6);
  });
});

// ---------- checkTeam ----------

describe("checkTeam", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-team-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("missing team.json → red", async () => {
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("missing");
  });

  test("invalid JSON → red 'invalid JSON'", async () => {
    await writeFile(join(atmuxDir, "team.json"), "{not-json");
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("invalid JSON");
  });

  test("empty members → red 'no members defined'", async () => {
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "x", members: [] }));
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("no members");
  });

  test("member missing name/role/tui → red list of bad names", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "x",
        members: [
          { name: "alpha", role: "lead", tui: "claude" },
          { name: "bravo" }, // missing role/tui
        ],
      }),
    );
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("bravo");
  });

  test("valid team → green", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [{ name: "alpha", role: "lead", tui: "claude" }],
      }),
    );
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toContain("demo");
    expect(rows[0]?.detail).toContain("1 members");
  });
});

// ---------- resolveMemberBin / checkTuis ----------

const baseTeam: Team = {
  name: "demo",
  members: [],
};

describe("resolveMemberBin", () => {
  test("member.command override wins, firstBin extracted", () => {
    const r = resolveMemberBin({ name: "a", command: "FOO=bar custom-bin --flag" }, baseTeam, {});
    expect(r).toEqual({ bin: "custom-bin" });
  });

  test("team.tuiCommands[tui] used when no member.command", () => {
    const r = resolveMemberBin(
      { name: "a", tui: "fancy" },
      { ...baseTeam, tuiCommands: { fancy: "fancy-bin --x" } },
      {},
    );
    expect(r).toEqual({ bin: "fancy-bin" });
  });

  test("ATMUX_CLAUDE_BIN env override applied to claude tui", () => {
    const r = resolveMemberBin({ name: "a", tui: "claude" }, baseTeam, {
      ATMUX_CLAUDE_BIN: "claude-canary",
    });
    expect(r).toEqual({ bin: "claude-canary" });
  });

  test("built-in claude → 'claude'", () => {
    expect(resolveMemberBin({ name: "a", tui: "claude" }, baseTeam, {})).toEqual({
      bin: "claude",
    });
  });

  test("cursor → 'cursor-agent' (bash mapping preserved)", () => {
    expect(resolveMemberBin({ name: "a", tui: "cursor" }, baseTeam, {})).toEqual({
      bin: "cursor-agent",
    });
  });

  test("shell/bash/zsh → skip", () => {
    expect(resolveMemberBin({ name: "a", tui: "shell" }, baseTeam, {})).toEqual({ skip: true });
    expect(resolveMemberBin({ name: "a", tui: "bash" }, baseTeam, {})).toEqual({ skip: true });
    expect(resolveMemberBin({ name: "a", tui: "zsh" }, baseTeam, {})).toEqual({ skip: true });
  });

  test("unknown tui without override → unknown", () => {
    expect(resolveMemberBin({ name: "a", tui: "wat" }, baseTeam, {})).toEqual({ unknown: "wat" });
  });

  test("missing member.tui treated as unknown ''", () => {
    expect(resolveMemberBin({ name: "a" }, baseTeam, {})).toEqual({ unknown: "" });
  });

  test("tuiCommands non-object skipped silently", () => {
    expect(
      resolveMemberBin({ name: "a", tui: "claude" }, { ...baseTeam, tuiCommands: "garbage" }, {}),
    ).toEqual({ bin: "claude" });
  });

  test("empty member.command falls through to next resolution", () => {
    expect(resolveMemberBin({ name: "a", tui: "claude", command: "" }, baseTeam, {})).toEqual({
      bin: "claude",
    });
  });

  test("empty tuiCommands prefix falls through to built-in", () => {
    expect(
      resolveMemberBin(
        { name: "a", tui: "claude" },
        { ...baseTeam, tuiCommands: { claude: "" } },
        {},
      ),
    ).toEqual({ bin: "claude" });
  });
});

describe("checkTuis", () => {
  test("groups members by bin + reports green when on PATH", () => {
    const team: Team = {
      name: "demo",
      members: [
        { name: "alpha", tui: "claude" },
        { name: "bravo", tui: "claude" },
        { name: "shellguy", tui: "shell" }, // skipped
      ],
    };
    const which = (cmd: string) => (cmd === "claude" ? "/usr/local/bin/claude" : null);
    const rows = checkTuis(team, { which, env: {}, platform: "linux" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toContain("alpha bravo");
  });

  test("missing bin → red with install hint", () => {
    const team: Team = {
      name: "demo",
      members: [{ name: "alpha", tui: "opencode" }],
    };
    const rows = checkTuis(team, { which: () => null, env: {}, platform: "linux" });
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.hint).toContain("opencode.ai");
  });

  test("unknown tui → red row per member", () => {
    const team: Team = {
      name: "demo",
      members: [{ name: "alpha", tui: "wat" }],
    };
    const rows = checkTuis(team, { which: () => "/x", env: {} });
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("tui:wat");
  });

  test("uses defaults when opts omitted", () => {
    const team: Team = {
      name: "demo",
      members: [{ name: "alpha", tui: "shell" }],
    };
    expect(checkTuis(team)).toEqual([]);
  });
});

// ---------- checkStateDir ----------

describe("checkStateDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-statedir-"));
  });
  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => {}); // restore in case a test chmod'd
    await rm(dir, { recursive: true, force: true });
  });

  test("missing .atmux but parent writable → yellow 'not yet created'", async () => {
    const ad = join(dir, ".atmux");
    const rows = await checkStateDir(ad);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("not yet created");
  });

  test("missing .atmux with missing parent → red", async () => {
    const ad = join(dir, "ghost", "ghost", ".atmux");
    const rows = await checkStateDir(ad);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("does not exist");
  });

  test("existing .atmux writable → green", async () => {
    const ad = join(dir, ".atmux");
    await mkdir(ad, { recursive: true });
    const rows = await checkStateDir(ad);
    expect(rows[0]?.status).toBe("green");
  });

  test("existing .atmux read-only → red", async () => {
    // Skip when running as root — root bypasses POSIX ACLs and the
    // write-probe always succeeds, masking the red branch. The branch
    // is exercised in CI where tests run as non-root, and the fallback
    // path is straight-line (probe throw → red row), so the dynamic
    // skip doesn't dilute the gate semantics meaningfully.
    if (process.getuid?.() === 0) return;
    const ad = join(dir, ".atmux");
    await mkdir(ad, { recursive: true });
    await chmod(ad, 0o500); // r-x only — write probe fails
    const rows = await checkStateDir(ad);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("not writable");
    await chmod(ad, 0o700); // restore for cleanup
  });
});

// ---------- checkWebhook ----------

describe("checkWebhook", () => {
  test("no webhook resolved → yellow 'no webhook configured'", async () => {
    const rows = await checkWebhook(null, { env: {} });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toBe("no webhook configured");
  });

  test("HTTP 200 → green reachable", async () => {
    const rows = await checkWebhook(null, {
      env: { ATMUX_DISCORD_WEBHOOK: "https://x" },
      probe: async () => 200,
    });
    expect(rows[0]?.status).toBe("green");
  });

  test("HTTP 405 (Discord-on-GET) → green reachable", async () => {
    const rows = await checkWebhook(null, {
      env: { ATMUX_DISCORD_WEBHOOK: "https://x" },
      probe: async () => 405,
    });
    expect(rows[0]?.status).toBe("green");
  });

  test("HTTP 0 (network failure) → red unreachable", async () => {
    const rows = await checkWebhook(null, {
      env: { ATMUX_DISCORD_WEBHOOK: "https://x" },
      probe: async () => 0,
    });
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("unreachable");
  });

  test("HTTP 401/403/404 → red rejected", async () => {
    for (const code of [401, 403, 404]) {
      const rows = await checkWebhook(null, {
        env: { ATMUX_DISCORD_WEBHOOK: "https://x" },
        probe: async () => code,
      });
      expect(rows[0]?.status).toBe("red");
      expect(rows[0]?.detail).toContain(`HTTP ${code}`);
    }
  });

  test("unexpected status → yellow 'reachable but odd'", async () => {
    const rows = await checkWebhook(null, {
      env: { ATMUX_DISCORD_WEBHOOK: "https://x" },
      probe: async () => 418,
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("418");
  });

  test("team.discord.webhook resolved when env unset", async () => {
    const team: Team = {
      name: "x",
      members: [],
      discord: { webhook: "https://from-team" },
    };
    let probedUrl = "";
    await checkWebhook(team, {
      env: {},
      probe: async (u) => {
        probedUrl = u;
        return 200;
      },
    });
    expect(probedUrl).toBe("https://from-team");
  });
});

// ---------- findPhantomInboxes / checkPhantomInboxes ----------

describe("findPhantomInboxes", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-phantom-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] when kanban absent", async () => {
    expect(await findPhantomInboxes(atmuxDir)).toEqual([]);
  });

  test("returns [] when team absent (kanban present)", async () => {
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ tasks: [], epics: [], stories: [] }),
    );
    expect(await findPhantomInboxes(atmuxDir)).toEqual([]);
  });

  test("returns [] when no member inbox files exist", async () => {
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ tasks: [{ id: "t-1", subject: "x" }], epics: [], stories: [] }),
    );
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "x", members: [{ name: "alpha", role: "lead", tui: "claude" }] }),
    );
    expect(await findPhantomInboxes(atmuxDir)).toEqual([]);
  });

  test("returns phantom entries when inProgress IDs missing from kanban", async () => {
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [{ id: "t-live", subject: "live one" }],
        epics: [],
        stories: [],
      }),
    );
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "x",
        members: [
          { name: "alpha", role: "lead", tui: "claude" },
          { name: "bravo", role: "member", tui: "claude" },
        ],
      }),
    );
    await writeFile(
      join(atmuxDir, "inboxes", "alpha.json"),
      JSON.stringify({
        pending: [],
        inProgress: [
          { id: "t-live", subject: "still here" },
          { id: "t-ghost", subject: "phantom" },
        ],
        done: [],
      }),
    );
    await writeFile(
      join(atmuxDir, "inboxes", "bravo.json"),
      JSON.stringify({
        pending: [],
        inProgress: [{ id: "t-also-ghost", subject: "another phantom" }],
        done: [],
      }),
    );
    const phantoms = await findPhantomInboxes(atmuxDir);
    expect(phantoms).toHaveLength(2);
    expect(phantoms.map((p) => p.id).sort()).toEqual(["t-also-ghost", "t-ghost"]);
  });

  test("checkPhantomInboxes wraps phantoms as yellow rows", async () => {
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ tasks: [], epics: [], stories: [] }),
    );
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: "x", members: [{ name: "alpha", role: "lead", tui: "claude" }] }),
    );
    await writeFile(
      join(atmuxDir, "inboxes", "alpha.json"),
      JSON.stringify({
        pending: [],
        inProgress: [{ id: "t-ghost" }],
        done: [],
      }),
    );
    const rows = await checkPhantomInboxes(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("phantom-inbox");
    expect(rows[0]?.detail).toContain("t-ghost");
  });
});

// ---------- checkOrphanSessions ----------

describe("checkOrphanSessions", () => {
  test("null team → no rows", async () => {
    expect(await checkOrphanSessions(null)).toEqual([]);
  });

  test("singleSession=false (or unset) → no rows", async () => {
    expect(await checkOrphanSessions({ name: "x", members: [] })).toEqual([]);
    expect(await checkOrphanSessions({ name: "x", members: [], singleSession: false })).toEqual([]);
  });

  test("singleSession=true with no orphan session → 1 yellow (single-session-discouraged)", async () => {
    const rows = await checkOrphanSessions(
      { name: "x", members: [], singleSession: true },
      { hasSession: async () => false },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("single-session-discouraged");
  });

  test("singleSession=true with orphan session → 2 yellows", async () => {
    const rows = await checkOrphanSessions(
      { name: "x", members: [], singleSession: true },
      { hasSession: async () => true },
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.label).toBe("orphan-session");
    expect(rows[1]?.detail).toContain("atmux-x");
  });

  test("default hasSession factory engaged when opt omitted (real tmux probe)", async () => {
    // Calls into createTmux + tmux.session.hasSession against a session
    // name that won't exist (`atmux-doctor-fixture-<random>`). The probe
    // either returns false (tmux says "no such session") or throws if
    // tmux itself is missing — both paths make the orphan-session row
    // absent, leaving just the discouraged-yellow row.
    const fakeName = `doctor-fixture-${Math.random().toString(36).slice(2, 10)}`;
    let rows: DoctorRow[];
    try {
      rows = await checkOrphanSessions({
        name: fakeName,
        members: [],
        singleSession: true,
      });
    } catch {
      // tmux missing on the test runner — skip silently. The factory
      // closure was still constructed (covering the def-site lines).
      return;
    }
    expect(rows[0]?.label).toBe("single-session-discouraged");
    // Either 1 row (no orphan) or 2 (a real `atmux-doctor-fixture-…`
    // session exists, which is impossibly unlikely).
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- ADR-079 §A: checkCronIntervalDivisors ----------

describe("checkCronIntervalDivisors", () => {
  const team = (overrides: Partial<Team> = {}): Team =>
    ({ name: "demo", members: [], ...overrides }) as Team;

  test("null team → no rows", () => {
    expect(checkCronIntervalDivisors(null)).toEqual([]);
  });

  test("all defaults (no fields set) → no rows", () => {
    expect(checkCronIntervalDivisors(team())).toEqual([]);
  });

  test("valid divisors of 60/24 → no rows", () => {
    const t = team({
      whip: { intervalMins: 5 } as never,
      report: { intervalMins: 30, heartbeatHours: 2 } as never,
      decisions: { intervalHours: 4 } as never,
      groom: { atHour: 4 } as never,
      unblocker: { intervalMins: 2 } as never,
    });
    expect(checkCronIntervalDivisors(t)).toEqual([]);
  });

  test("intervalMins=60 (boundary) → no rows", () => {
    const t = team({ whip: { intervalMins: 60 } as never });
    expect(checkCronIntervalDivisors(t)).toEqual([]);
  });

  test("intervalHours=24 (boundary) → no rows", () => {
    const t = team({ decisions: { intervalHours: 24 } as never });
    expect(checkCronIntervalDivisors(t)).toEqual([]);
  });

  test("non-divisor whip.intervalMins=7 → 1 yellow row with hint", () => {
    const t = team({ whip: { intervalMins: 7 } as never });
    const rows = checkCronIntervalDivisors(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("cron-interval-divisor");
    expect(rows[0]?.detail).toContain("whip.intervalMins=7");
    expect(rows[0]?.detail).toContain("not a divisor of 60");
    expect(rows[0]?.hint).toContain("1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60");
  });

  test("out-of-range whip.intervalMins=120 → yellow row with 'out of range'", () => {
    const t = team({ whip: { intervalMins: 120 } as never });
    const rows = checkCronIntervalDivisors(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("out of range");
  });

  test("zero / negative whip.intervalMins → yellow row out of range", () => {
    const t1 = team({ whip: { intervalMins: 0 } as never });
    const t2 = team({ whip: { intervalMins: -5 } as never });
    expect(checkCronIntervalDivisors(t1)[0]?.detail).toContain("out of range");
    expect(checkCronIntervalDivisors(t2)[0]?.detail).toContain("out of range");
  });

  test("non-divisor report.heartbeatHours=5 → yellow row with divisor-of-24 hint", () => {
    const t = team({ report: { heartbeatHours: 5 } as never });
    const rows = checkCronIntervalDivisors(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail).toContain("report.heartbeatHours=5");
    expect(rows[0]?.detail).toContain("not a divisor of 24");
    expect(rows[0]?.hint).toContain("1, 2, 3, 4, 6, 8, 12, 24");
  });

  test("out-of-range decisions.intervalHours=25 → yellow row out of range", () => {
    const t = team({ decisions: { intervalHours: 25 } as never });
    const rows = checkCronIntervalDivisors(t);
    expect(rows[0]?.detail).toContain("out of range");
  });

  test("groom.atHour=24 (out of 0–23) → yellow row out of range", () => {
    const t = team({ groom: { atHour: 24 } as never });
    const rows = checkCronIntervalDivisors(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail).toContain("groom.atHour=24");
    expect(rows[0]?.detail).toContain("out of range");
  });

  test("groom.atHour=-1 → yellow row out of range", () => {
    const t = team({ groom: { atHour: -1 } as never });
    expect(checkCronIntervalDivisors(t)[0]?.detail).toContain("out of range");
  });

  test("non-divisor unblocker.intervalMins=11 → yellow row", () => {
    const t = team({ unblocker: { intervalMins: 11 } as never });
    const rows = checkCronIntervalDivisors(t);
    expect(rows[0]?.detail).toContain("unblocker.intervalMins=11");
    expect(rows[0]?.detail).toContain("not a divisor of 60");
  });

  test("multiple offenders → one row per field", () => {
    const t = team({
      whip: { intervalMins: 7 } as never,
      report: { intervalMins: 11, heartbeatHours: 5 } as never,
      decisions: { intervalHours: 7 } as never,
      groom: { atHour: 30 } as never,
      unblocker: { intervalMins: 13 } as never,
    });
    const rows = checkCronIntervalDivisors(t);
    expect(rows.length).toBe(6);
    for (const r of rows) {
      expect(r.status).toBe("yellow");
      expect(r.label).toBe("cron-interval-divisor");
    }
    const labels = rows.map((r) => r.detail ?? "").join("|");
    expect(labels).toContain("whip.intervalMins=7");
    expect(labels).toContain("report.intervalMins=11");
    expect(labels).toContain("report.heartbeatHours=5");
    expect(labels).toContain("decisions.intervalHours=7");
    expect(labels).toContain("groom.atHour=30");
    expect(labels).toContain("unblocker.intervalMins=13");
  });

  test("non-integer values flagged as out of range", () => {
    const t = team({ whip: { intervalMins: 3.5 } as never });
    expect(checkCronIntervalDivisors(t)[0]?.detail).toContain("out of range");
  });

  test("intervalHours=1 (boundary, schema-default) → no rows", () => {
    const t = team({ report: { heartbeatHours: 1 } as never });
    expect(checkCronIntervalDivisors(t)).toEqual([]);
  });

  test("groom.atHour=0 (midnight, boundary) → no rows", () => {
    const t = team({ groom: { atHour: 0 } as never });
    expect(checkCronIntervalDivisors(t)).toEqual([]);
  });

  test("groom.atHour=23 (boundary) → no rows", () => {
    const t = team({ groom: { atHour: 23 } as never });
    expect(checkCronIntervalDivisors(t)).toEqual([]);
  });
});

// ---------- renderHuman / renderJson ----------

describe("renderHuman", () => {
  test("all-green renders 'all green' footer", () => {
    const out = renderHuman(buildReport([{ status: "green", label: "x", detail: "ok" }]));
    expect(out).toContain("🩺 atmux doctor");
    expect(out).toContain("✅");
    expect(out).toContain("all green");
  });

  test("yellow-only renders 'warning(s), no blockers' footer + hint", () => {
    const out = renderHuman(
      buildReport([{ status: "yellow", label: "y", detail: "warn", hint: "fix it" }]),
    );
    expect(out).toContain("⚠️");
    expect(out).toContain("1 warning(s)");
    expect(out).toContain("→ fix it");
  });

  test("red renders '--fix to remediate' footer", () => {
    const out = renderHuman(buildReport([{ status: "red", label: "r", detail: "bad" }]));
    expect(out).toContain("❌");
    expect(out).toContain("1 issue(s)");
    expect(out).toContain("--fix to remediate");
  });

  test("green rows do not show hint even if set", () => {
    const out = renderHuman(
      buildReport([{ status: "green", label: "x", detail: "ok", hint: "ignored" }]),
    );
    expect(out).not.toContain("→ ignored");
  });
});

describe("renderJson", () => {
  test("emits {red, yellow, checks[]} envelope", () => {
    const out = renderJson(
      buildReport([
        { status: "green", label: "g", detail: "d" },
        { status: "red", label: "r" },
      ]),
    );
    const parsed = JSON.parse(out) as { red: number; yellow: number; checks: unknown[] };
    expect(parsed.red).toBe(1);
    expect(parsed.yellow).toBe(0);
    expect(parsed.checks).toHaveLength(2);
  });

  test("empty hint/detail rendered as empty strings", () => {
    const out = renderJson(buildReport([{ status: "green", label: "x" }]));
    const parsed = JSON.parse(out) as {
      checks: Array<{ detail: string; hint: string }>;
    };
    expect(parsed.checks[0]?.detail).toBe("");
    expect(parsed.checks[0]?.hint).toBe("");
  });
});

// ---------- runAllChecks ----------

describe("runAllChecks", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-runall-"));
    atmuxDir = join(dir, ".atmux");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("smoke — rows include deps + team + state-dir even when team is null", async () => {
    const rows = await runAllChecks(atmuxDir, null);
    expect(rows.some((r) => r.label.startsWith("dep:"))).toBe(true);
    expect(rows.some((r) => r.label === "team.json")).toBe(true);
    expect(rows.some((r) => r.label === "state-dir")).toBe(true);
  });

  test("smoke — when team is present, tuis check runs", async () => {
    await mkdir(atmuxDir, { recursive: true });
    const team: Team = {
      name: "demo",
      members: [{ name: "alpha", role: "lead", tui: "shell" }], // shell skipped → no tui row
    };
    const rows = await runAllChecks(atmuxDir, team);
    // No tui:* rows because the only member uses shell (skipped).
    expect(rows.some((r) => r.label.startsWith("tui:"))).toBe(false);
    // But state-dir is green.
    const sd = rows.find((r) => r.label === "state-dir");
    expect(sd?.status).toBe("green");
  });
});

// ---------- doctor() — public verb ----------

describe("doctor() — public verb", () => {
  let dir: string;
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
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-verb-"));
    atmuxDir = join(dir, ".atmux");
    stdoutBuf = "";
    stderrBuf = "";
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const seedTeam = async (members: TeamMember[] = []): Promise<void> => {
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "demo", members }));
  };

  test("UsageError on bad arg propagates", async () => {
    await expect(doctor(["--bogus"])).rejects.toBeInstanceOf(UsageError);
  });

  test("all-green report → exit 0, human render to stderr", async () => {
    await seedTeam([{ name: "alpha", role: "lead", tui: "claude" }]);
    const exit = await doctor(["--team-dir", dir], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "stub", detail: "ok" }],
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("🩺 atmux doctor");
    expect(stderrBuf).toContain("all green");
  });

  test("--quiet suppresses output but exit-code still meaningful", async () => {
    await seedTeam();
    const exit = await doctor(["--team-dir", dir, "--quiet"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "red", label: "fail" }],
    });
    expect(exit).toBe(1);
    expect(stderrBuf).toBe("");
    expect(stdoutBuf).toBe("");
  });

  test("--json emits JSON to stdout (no human render)", async () => {
    await seedTeam();
    const exit = await doctor(["--team-dir", dir, "--json"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "stub" }],
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toBe("");
    const parsed = JSON.parse(stdoutBuf) as { red: number };
    expect(parsed.red).toBe(0);
  });

  test("--fix surfaces the deferred-actions hint on stderr", async () => {
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "red", label: "fail" }],
    });
    expect(stderrBuf).toContain("--fix actions deferred per ADR-019");
  });

  test("--fix without --quiet runs human render too", async () => {
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "ok" }],
    });
    expect(stderrBuf).toContain("atmux doctor");
    expect(stderrBuf).toContain("--fix actions deferred");
  });

  test("--fix + --quiet skips both render and hint", async () => {
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix", "--quiet"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "ok" }],
    });
    expect(stderrBuf).toBe("");
  });

  test("malformed team.json doesn't crash; checkTeam emits red", async () => {
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), "{not-json");
    const exit = await doctor(["--team-dir", dir, "--json"], { stdout, stderr });
    // The default chain runs; team is null; checkTeam emits red →
    // exit 1.
    expect(exit).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as { red: number };
    expect(parsed.red).toBeGreaterThanOrEqual(1);
  });

  test("default stdout sink (no opts) engaged on --json path", async () => {
    await seedTeam();
    let captured = "";
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      await doctor(["--team-dir", dir, "--json"], {
        runChecks: async () => [{ status: "green", label: "ok" }],
      });
    } finally {
      process.stdout.write = origStdout;
    }
    expect(captured).toContain('"red"');
  });

  test("default stderr sink (no opts) engaged on human path", async () => {
    await seedTeam();
    let captured = "";
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      await doctor(["--team-dir", dir], {
        runChecks: async () => [{ status: "green", label: "ok" }],
      });
    } finally {
      process.stderr.write = origStderr;
    }
    expect(captured).toContain("atmux doctor");
  });
});

// ---------- ADR-054 §D4 — checkWhipConfigDrift ----------

describe("checkWhipConfigDrift", () => {
  let workDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "atmux-doctor-drift-"));
    atmuxDir = join(workDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("absent team.json → no rows (checkTeam owns the absent-file finding)", async () => {
    expect(await checkWhipConfigDrift(atmuxDir)).toEqual([]);
  });

  test("valid team.json → no rows", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [],
        whip: { staleMin: 60 },
      }),
    );
    expect(await checkWhipConfigDrift(atmuxDir)).toEqual([]);
  });

  test("strict-mode rejection → yellow row referencing the issue path + code", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [],
        whip: { unknownTypoKey: 1 },
      }),
    );
    const rows = await checkWhipConfigDrift(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("whip-config-drift");
    expect(rows[0]?.detail).toContain("validation failed");
    expect(rows[0]?.hint).toContain("edit team.json");
  });

  test("type mismatch → yellow row", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [],
        whip: { budgetPauseThreshold: "ninety" },
      }),
    );
    const rows = await checkWhipConfigDrift(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("budgetPauseThreshold");
  });

  test("malformed JSON → yellow row with malformed/full-defaults wording", async () => {
    await writeFile(join(atmuxDir, "team.json"), "{not valid json");
    const rows = await checkWhipConfigDrift(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("malformed");
    expect(rows[0]?.detail).toContain("full safe defaults");
  });
});

// ---------- ADR-057 §D5a: parseSubmoduleStatus + checkSubmoduleIntegrity ----------

describe("parseSubmoduleStatus", () => {
  test("empty stdout → no entries", () => {
    expect(parseSubmoduleStatus("")).toEqual([]);
  });

  test("clean entries (space-prefix) parsed", () => {
    const out = parseSubmoduleStatus(
      " 1234567890123456789012345678901234567890 vendor/clean (v1.0)\n",
    );
    expect(out).toEqual([
      {
        state: " ",
        recordedSha: "1234567890123456789012345678901234567890",
        path: "vendor/clean",
      },
    ]);
  });

  test("mixed prefixes (+/-/U) classified", () => {
    const stdout = [
      "+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa vendor/mismatch (v2.0)",
      "-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb vendor/uninit",
      "Ucccccccccccccccccccccccccccccccccccccccc vendor/conflict",
      " dddddddddddddddddddddddddddddddddddddddd vendor/clean",
    ].join("\n");
    const out = parseSubmoduleStatus(stdout);
    expect(out.map((s) => s.state)).toEqual(["+", "-", "U", " "]);
    expect(out.map((s) => s.path)).toEqual([
      "vendor/mismatch",
      "vendor/uninit",
      "vendor/conflict",
      "vendor/clean",
    ]);
  });

  test("malformed lines (no SHA / wrong prefix) skipped", () => {
    const stdout = [
      "?xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx not-a-real-prefix",
      " short-sha vendor/x",
      "+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa vendor/ok",
    ].join("\n");
    const out = parseSubmoduleStatus(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("vendor/ok");
  });
});

describe("checkSubmoduleIntegrity", () => {
  test("no submodules (empty stdout) → no rows", async () => {
    const rows = await checkSubmoduleIntegrity({
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
    });
    expect(rows).toEqual([]);
  });

  test("non-zero exit (not a repo) → no rows", async () => {
    const rows = await checkSubmoduleIntegrity({
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 128,
        signalled: null,
        stdout: "",
        stderr: "fatal: not a git repository",
        durationMs: 0,
      }),
    });
    expect(rows).toEqual([]);
  });

  test("'+' prefix → yellow P2 with checkout hint", async () => {
    const rows = await checkSubmoduleIntegrity({
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa vendor/x (v2.0)\n",
        stderr: "",
        durationMs: 0,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("submodule-integrity");
    expect(rows[0]?.detail).toContain("vendor/x");
    expect(rows[0]?.hint).toContain("git checkout");
  });

  test("'-' prefix → yellow with init hint", async () => {
    const rows = await checkSubmoduleIntegrity({
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb vendor/y\n",
        stderr: "",
        durationMs: 0,
      }),
    });
    expect(rows[0]?.detail).toContain("not initialized");
    expect(rows[0]?.hint).toContain("git submodule update --init");
  });

  test("'U' prefix → yellow with conflict hint", async () => {
    const rows = await checkSubmoduleIntegrity({
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout: "Ucccccccccccccccccccccccccccccccccccccccc vendor/z\n",
        stderr: "",
        durationMs: 0,
      }),
    });
    expect(rows[0]?.detail).toContain("merge conflict");
    expect(rows[0]?.hint).toContain("resolve");
  });

  test("clean entries are filtered out", async () => {
    const rows = await checkSubmoduleIntegrity({
      git: async () => ({
        cmd: "git",
        argv: [],
        exitCode: 0,
        signalled: null,
        stdout:
          " dddddddddddddddddddddddddddddddddddddddd vendor/ok\n+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa vendor/dirty\n",
        stderr: "",
        durationMs: 0,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("vendor/dirty");
  });
});

// ---------- ADR-057 §D5c: findInboxTaskMarks + checkInboxMarks ----------

describe("findInboxTaskMarks", () => {
  const NOW = 1_780_000_000;

  test("empty body → no marks", () => {
    expect(findInboxTaskMarks("", NOW)).toEqual([]);
  });

  test("simple Open marker", () => {
    const body = `## Open\n\n- [10:00 MYT] 📤 task t-abc12345 — done\n`;
    const marks = findInboxTaskMarks(body, NOW);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).toBe("t-abc12345");
  });

  test("multiple markers in different entries", () => {
    const body = [
      "## Open",
      "",
      "- [10:00 MYT] 📤 task t-aaa11111",
      "- [10:05 MYT] 📤 task t-bbb22222",
      "- [10:10 MYT] no marker here",
    ].join("\n");
    const marks = findInboxTaskMarks(body, NOW);
    expect(marks.map((m) => m.id)).toEqual(["t-aaa11111", "t-bbb22222"]);
  });

  test("Archive section marks are skipped", () => {
    const body = [
      "## Open",
      "",
      "- [10:00 MYT] 📤 task t-open111",
      "",
      "## Archive",
      "",
      "- [09:00 MYT] 📤 task t-arch222",
    ].join("\n");
    const marks = findInboxTaskMarks(body, NOW);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).toBe("t-open111");
  });

  test("entry before Open marker is skipped", () => {
    const body = [
      "- [09:00 MYT] 📤 task t-pre000",
      "",
      "## Open",
      "",
      "- [10:00 MYT] 📤 task t-after",
    ].join("\n");
    const marks = findInboxTaskMarks(body, NOW);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).toBe("t-after");
  });

  test("section-style entry with multi-line marker body", () => {
    const body = [
      "## Open",
      "",
      "## 11:00 MYT — request",
      "Multi line.",
      "📤 task t-multi321",
      "more text",
    ].join("\n");
    const marks = findInboxTaskMarks(body, NOW);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).toBe("t-multi321");
  });
});

describe("checkInboxMarks", () => {
  let dir: string;
  let atmuxDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-mark-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("absent driver-inbox → no rows", async () => {
    expect(await checkInboxMarks(atmuxDir)).toEqual([]);
  });

  test("absent kanban → no rows (precondition)", async () => {
    await writeFile(join(atmuxDir, "driver-inbox.md"), "## Open\n- [10:00 MYT] 📤 task t-x12345\n");
    expect(await checkInboxMarks(atmuxDir)).toEqual([]);
  });

  test("known id → no orphan rows", async () => {
    await writeFile(join(atmuxDir, "driver-inbox.md"), "## Open\n- [10:00 MYT] 📤 task t-known1\n");
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        version: 1,
        epics: [],
        stories: [],
        tasks: [
          {
            id: "t-known1",
            subject: "x",
            body: "",
            status: "done",
            owner: null,
            deps: [],
            priority: 1,
            epic: null,
            story: null,
            lane: null,
            deliverable: null,
            staleMin: null,
            driverOnly: false,
            createdAt: 0,
            claimedAt: null,
            completedAt: null,
          },
        ],
      }),
    );
    expect(await checkInboxMarks(atmuxDir)).toEqual([]);
  });

  test("orphan id → yellow P3 row", async () => {
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      "## Open\n- [10:00 MYT] 📤 task t-bogus0 — purged\n",
    );
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ version: 1, epics: [], stories: [], tasks: [] }),
    );
    const rows = await checkInboxMarks(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("inbox-mark-orphan");
    expect(rows[0]?.detail).toContain("t-bogus0");
  });

  test("duplicate orphan id → single row (deduped)", async () => {
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      [
        "## Open",
        "",
        "- [10:00 MYT] 📤 task t-dup999",
        "- [11:00 MYT] 📤 task t-dup999 — mentioned twice",
      ].join("\n"),
    );
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ version: 1, epics: [], stories: [], tasks: [] }),
    );
    const rows = await checkInboxMarks(atmuxDir);
    expect(rows).toHaveLength(1);
  });

  test("orphan in Archive is NOT flagged", async () => {
    await writeFile(
      join(atmuxDir, "driver-inbox.md"),
      [
        "## Open",
        "",
        "- [10:00 MYT] no marker here",
        "",
        "## Archive",
        "",
        "- [09:00 MYT] 📤 task t-archived",
      ].join("\n"),
    );
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ version: 1, epics: [], stories: [], tasks: [] }),
    );
    expect(await checkInboxMarks(atmuxDir)).toEqual([]);
  });
});
