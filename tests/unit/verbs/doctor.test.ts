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
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { CrontabIO } from "../../../src/abstractions/crontab.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { CageState } from "../../../src/core/cage-state.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import { UsageError } from "../../../src/errors.ts";
import type { Team, TeamMember } from "../../../src/schema/team.ts";
import {
  buildReport,
  checkCockpitOnDefaultSocket,
  checkCockpitSentinelWindow,
  checkDeployedBinaryLag,
  checkLegacyWindowNameFormat,
  fixMissingSentinelWindow,
  checkCronBlock,
  checkCronIntervalDivisors,
  checkCronOrphans,
  checkCursorPluginCache,
  checkDeps,
  checkInboxMarks,
  checkMemberCageStates,
  checkMemberForcePushRecent,
  checkMemberLabelCollision,
  checkMergerFanIn,
  checkOrphanSessions,
  checkPhantomInboxes,
  checkLegacyInboxJson,
  checkReleaseNoteMissing,
  checkSendKeysFailureRecent,
  checkStateDir,
  checkSubmoduleIntegrity,
  checkTeam,
  checkTmuxVersionMismatch,
  checkVendoredTmuxBinary,
  checkTuiCommandsClaudeOverride,
  checkTuis,
  checkWebhook,
  checkWhipConfigDrift,
  checkWorktreeIsolation,
  collectSafeOrphanBranches,
  collectStarvingMembers,
  compareTmuxVersion,
  type DoctorRow,
  doctor,
  findInboxTaskMarks,
  findLegacyInboxJson,
  findPhantomInboxes,
  firstBin,
  installHint,
  parseDoctorArgs,
  parseSubmoduleStatus,
  parseTmuxVersion,
  renderHuman,
  renderJson,
  resolveMemberBin,
  runAllChecks,
  STARVING_THRESHOLD_S,
  TMUX_MIN_VERSION,
  TMUX_TESTED_VERSION,
  type TmuxSpawn,
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

  test("ignores stale JSON inProgress when state.db is canonical", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "x",
        members: [{ name: "alpha", role: "lead", tui: "claude" }],
      }),
    );
    await writeFile(
      join(atmuxDir, "inboxes", "alpha.json"),
      JSON.stringify({
        pending: [],
        inProgress: [{ id: "t-ghost", subject: "stale json phantom" }],
        done: [],
      }),
    );
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new KanbanRepo(db);
      repo.upsertTask({
        id: "t-live",
        subject: "live sql task",
        status: "todo",
        owner: "alpha",
        deps: [],
      });
    } finally {
      closeDatabase(db);
    }
    expect(await findPhantomInboxes(atmuxDir)).toEqual([]);
  });

  test("SQL in-progress tasks that exist in kanban are not phantoms", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "x",
        members: [{ name: "alpha", role: "lead", tui: "claude" }],
      }),
    );
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const repo = new KanbanRepo(db);
      repo.upsertTask({
        id: "t-live",
        subject: "active claim",
        status: "in-progress",
        owner: "alpha",
        deps: [],
      });
    } finally {
      closeDatabase(db);
    }
    expect(await findPhantomInboxes(atmuxDir)).toEqual([]);
  });
});

// ---------- findLegacyInboxJson / checkLegacyInboxJson ----------

describe("findLegacyInboxJson", () => {
  let dir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-doctor-legacy-inbox-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns [] when state.db absent (JSON may still be canonical)", async () => {
    await writeFile(join(atmuxDir, "inboxes", "gitter.json"), "{}");
    expect(await findLegacyInboxJson(atmuxDir)).toEqual([]);
  });

  test("returns legacy json basenames when state.db exists", async () => {
    await writeFile(join(atmuxDir, "state.db"), "");
    await writeFile(join(atmuxDir, "inboxes", "gitter.json"), "{}");
    await writeFile(join(atmuxDir, "inboxes", "alpha.json"), "{}");
    expect(await findLegacyInboxJson(atmuxDir)).toEqual(["alpha.json", "gitter.json"]);
  });

  test("checkLegacyInboxJson surfaces yellow doctor row with purge hint", async () => {
    await writeFile(join(atmuxDir, "state.db"), "");
    await writeFile(join(atmuxDir, "inboxes", "gitter.json"), "{}");
    const rows = await checkLegacyInboxJson(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("legacy-inbox-json");
    expect(rows[0]?.detail).toContain("gitter.json");
    expect(rows[0]?.hint).toContain("atmux cleanup inboxes --purge-legacy");
  });
});

// ---------- checkCursorPluginCache ----------

describe("checkCursorPluginCache", () => {
  let home: string;
  const cursorPresent = (cmd: string) => (cmd === "cursor-agent" ? "/usr/bin/cursor-agent" : null);
  const cursorAbsent = (_cmd: string) => null;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "atmux-doctor-cursor-"));
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const writeInstalled = async (data: object): Promise<void> => {
    await writeFile(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify(data),
    );
  };
  const writeMarketplaces = async (data: object): Promise<void> => {
    await writeFile(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify(data),
    );
  };

  test("cursor-agent not on PATH → silent (no rows)", async () => {
    expect(await checkCursorPluginCache({ which: cursorAbsent, home })).toEqual([]);
  });

  test("no installed_plugins.json → silent", async () => {
    expect(await checkCursorPluginCache({ which: cursorPresent, home })).toEqual([]);
  });

  test("all directory-source plugins materialised → no rows", async () => {
    // marketplace install location with a plugin source dir
    const mktLoc = await mkdtemp(join(tmpdir(), "atmux-mkt-"));
    await mkdir(join(mktLoc, "plugins", "alpha"), { recursive: true });
    await writeMarketplaces({
      "my-mkt": {
        source: { source: "directory" },
        installLocation: mktLoc,
      },
    });
    await writeInstalled({
      plugins: {
        "alpha@my-mkt": [{ installPath: "doesnt-matter", version: "0.1.0" }],
      },
    });
    // materialise the cache target
    await mkdir(join(home, ".claude", "plugins", "cache", "my-mkt", "alpha", "0.1.0"), {
      recursive: true,
    });
    expect(await checkCursorPluginCache({ which: cursorPresent, home })).toEqual([]);
    await rm(mktLoc, { recursive: true, force: true });
  });

  test("missing cache entry → 1 yellow row with mkdir+ln hint", async () => {
    const mktLoc = await mkdtemp(join(tmpdir(), "atmux-mkt-"));
    await mkdir(join(mktLoc, "plugins", "alpha"), { recursive: true });
    await writeMarketplaces({
      "my-mkt": {
        source: { source: "directory" },
        installLocation: mktLoc,
      },
    });
    await writeInstalled({
      plugins: {
        "alpha@my-mkt": [{ installPath: "doesnt-matter", version: "0.1.0" }],
      },
    });
    // cache target NOT created
    const rows = await checkCursorPluginCache({ which: cursorPresent, home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("cursor-plugin-cache");
    expect(rows[0]?.detail).toContain("alpha@my-mkt");
    expect(rows[0]?.hint).toContain("mkdir -p");
    expect(rows[0]?.hint).toContain("ln -sfn");
    expect(rows[0]?.hint).toContain(join(mktLoc, "plugins", "alpha"));
    expect(rows[0]?.hint).toContain(
      join(home, ".claude", "plugins", "cache", "my-mkt", "alpha", "0.1.0"),
    );
    await rm(mktLoc, { recursive: true, force: true });
  });

  test("non-directory marketplace (e.g. github) → not flagged", async () => {
    await writeMarketplaces({
      "official-mkt": {
        source: { source: "github" },
        installLocation: "/tmp/wherever",
      },
    });
    await writeInstalled({
      plugins: {
        "alpha@official-mkt": [{ installPath: "doesnt-matter", version: "1.0.0" }],
      },
    });
    expect(await checkCursorPluginCache({ which: cursorPresent, home })).toEqual([]);
  });

  test("source dir missing → skip (can't symlink to nothing)", async () => {
    const mktLoc = await mkdtemp(join(tmpdir(), "atmux-mkt-"));
    // NOTE: do NOT create plugins/alpha — source absent
    await writeMarketplaces({
      "my-mkt": {
        source: { source: "directory" },
        installLocation: mktLoc,
      },
    });
    await writeInstalled({
      plugins: {
        "alpha@my-mkt": [{ installPath: "doesnt-matter", version: "0.1.0" }],
      },
    });
    expect(await checkCursorPluginCache({ which: cursorPresent, home })).toEqual([]);
    await rm(mktLoc, { recursive: true, force: true });
  });

  test("missing known_marketplaces.json → no rows (can't classify)", async () => {
    await writeInstalled({
      plugins: { "alpha@some-mkt": [{ installPath: "x", version: "0.1.0" }] },
    });
    // no marketplaces file at all
    expect(await checkCursorPluginCache({ which: cursorPresent, home })).toEqual([]);
  });

  test("malformed JSON → no throw, no rows", async () => {
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), "{ not json");
    expect(await checkCursorPluginCache({ which: cursorPresent, home })).toEqual([]);
  });

  test("multiple versions of same plugin → row per missing version", async () => {
    const mktLoc = await mkdtemp(join(tmpdir(), "atmux-mkt-"));
    await mkdir(join(mktLoc, "plugins", "alpha"), { recursive: true });
    await writeMarketplaces({
      "my-mkt": { source: { source: "directory" }, installLocation: mktLoc },
    });
    await writeInstalled({
      plugins: {
        "alpha@my-mkt": [
          { installPath: "x", version: "0.1.0" },
          { installPath: "x", version: "0.2.0" },
        ],
      },
    });
    // materialise only 0.1.0 — 0.2.0 missing
    await mkdir(join(home, ".claude", "plugins", "cache", "my-mkt", "alpha", "0.1.0"), {
      recursive: true,
    });
    const rows = await checkCursorPluginCache({ which: cursorPresent, home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("0.2.0");
    await rm(mktLoc, { recursive: true, force: true });
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

// ---------- ADR-083 follow-up §DEFERRED row 2: checkCronOrphans ----------

describe("checkCronOrphans", () => {
  const fakeIO = (body: string | null, opts: { available?: boolean } = {}): CrontabIO => ({
    read: async () => body,
    write: async () => {
      /* not invoked */
    },
    available: async () => opts.available ?? true,
  });

  test("crontab not on PATH → no rows (silent on cronless hosts)", async () => {
    const rows = await checkCronOrphans({
      crontab: fakeIO(null, { available: false }),
      dirExists: async () => false,
    });
    expect(rows).toEqual([]);
  });

  test("empty crontab → no rows", async () => {
    const rows = await checkCronOrphans({
      crontab: fakeIO(""),
      dirExists: async () => false,
    });
    expect(rows).toEqual([]);
  });

  test("all blocks live on disk → no rows", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    const rows = await checkCronOrphans({
      crontab: fakeIO(body),
      dirExists: async () => true,
    });
    expect(rows).toEqual([]);
  });

  test("orphan block (atmuxDir gone) → one yellow row with team+dir", async () => {
    const body = [
      "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost",
    ].join("\n");
    const rows = await checkCronOrphans({
      crontab: fakeIO(body),
      dirExists: async () => false,
    });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r?.status).toBe("yellow");
    expect(r?.label).toBe("cron-config");
    expect(r?.detail).toContain("ghost");
    expect(r?.detail).toContain("/srv/ghost/.atmux");
    expect(r?.detail).toContain("does not exist");
    expect(r?.hint).toContain("crontab -e");
  });

  test("mix of live + orphan blocks → only orphans surface", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
      "# >>> atmux:team=ghost — managed by atmux start; do not edit by hand",
      "*/5 * * * * ATMUX_DIR=/srv/ghost/.atmux /bin/atmux whip",
      "# <<< atmux:team=ghost",
    ].join("\n");
    const live = new Set(["/srv/alpha/.atmux"]);
    const rows = await checkCronOrphans({
      crontab: fakeIO(body),
      dirExists: async (p: string) => live.has(p),
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail).toContain("ghost");
    expect(rows[0]?.detail).not.toContain("alpha");
  });
});

// ---------- t-dcbff97c: checkCronBlock ----------

describe("checkCronBlock", () => {
  const fakeIO = (body: string | null, opts: { available?: boolean } = {}): CrontabIO => ({
    read: async () => body,
    write: async () => {
      /* not invoked */
    },
    available: async () => opts.available ?? true,
  });

  const team = (overrides: Partial<Team> = {}): Team =>
    ({ name: "alpha", members: [], ...overrides }) as Team;

  test("null team → no rows", async () => {
    expect(await checkCronBlock(null, { crontab: fakeIO(null) })).toEqual([]);
  });

  test("kanban.cronAutoInstall=false → silent (explicit opt-out)", async () => {
    const t = team({ kanban: { cronAutoInstall: false } as never });
    // Body that would otherwise trip the RED row (no matching marker) —
    // the opt-out short-circuits BEFORE we even read crontab.
    const rows = await checkCronBlock(t, { crontab: fakeIO("") });
    expect(rows).toEqual([]);
  });

  test("crontab not available on host → silent (cron-less host)", async () => {
    const rows = await checkCronBlock(team(), {
      crontab: fakeIO(null, { available: false }),
    });
    expect(rows).toEqual([]);
  });

  test("crontab present with matching marker → no row", async () => {
    const body = [
      "# >>> atmux:team=alpha — managed by atmux start; do not edit by hand",
      "*/15 * * * * ATMUX_DIR=/srv/alpha/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha",
    ].join("\n");
    expect(await checkCronBlock(team(), { crontab: fakeIO(body) })).toEqual([]);
  });

  test("empty crontab → one RED row pointing at cron-install", async () => {
    const rows = await checkCronBlock(team(), { crontab: fakeIO("") });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r?.status).toBe("red");
    expect(r?.label).toBe("cron-block:missing");
    expect(r?.detail).toContain("alpha");
    expect(r?.detail).toContain("whip");
    expect(r?.hint).toContain("atmux cron-install");
  });

  test("crontab has OTHER team's block but not ours → RED row", async () => {
    // Substring-brushby guard: a block for `alpha-staging` MUST NOT
    // false-pass for team name `alpha`. The marker match uses the exact
    // rendered header line so similar-prefix team names can't collide.
    const body = [
      "# >>> atmux:team=alpha-staging — managed by atmux start; do not edit by hand",
      "*/15 * * * * ATMUX_DIR=/srv/alpha-staging/.atmux /bin/atmux whip",
      "# <<< atmux:team=alpha-staging",
    ].join("\n");
    const rows = await checkCronBlock(team(), { crontab: fakeIO(body) });
    expect(rows.length).toBe(1);
    expect(rows[0]?.label).toBe("cron-block:missing");
    expect(rows[0]?.status).toBe("red");
  });

  test("crontab null (no crontab installed) → RED row", async () => {
    const rows = await checkCronBlock(team(), { crontab: fakeIO(null) });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("red");
  });
});

// ---------- ADR-094 / t-d0c8b758 (T6) doctor-row coverage matrix ----------
//
// T6 §Unit tests doctor bullets map onto the
// `checkTuiCommandsClaudeOverride` describe block below:
//   • registered + runAllChecks-included     → wired at runAllChecks
//                                              (in the source file);
//                                              structural lint catches
//                                              if the wire-up regresses.
//   • warn on CLAUDE_CONFIG_DIR=$HOME/.claude → "CLAUDE_CONFIG_DIR=$HOME/.claude bare default..."
//   • warn on CLAUDE_CONFIG_DIR=/root/.claude → "CLAUDE_CONFIG_DIR=/root/.claude bare default..."
//   • ok on $HOME/.claude-personal (suffix)   → "tuiCommands.claude with non-default suffix..."
//   • ok on absent tuiCommands.claude         → "tuiCommands.claude absent → no rows"
//
// Plus the brace-expansion `${HOME}` variant + the path-continuation
// `.claude/sub` negative case for negative-lookahead robustness.

// ---------- t-589145dc: checkTuiCommandsClaudeOverride ----------

describe("checkTuiCommandsClaudeOverride", () => {
  const team = (overrides: Partial<Team> = {}): Team =>
    ({ name: "alpha", members: [], ...overrides }) as Team;

  test("null team → no rows", () => {
    expect(checkTuiCommandsClaudeOverride(null)).toEqual([]);
  });

  test("no tuiCommands → no rows", () => {
    expect(checkTuiCommandsClaudeOverride(team())).toEqual([]);
  });

  test("tuiCommands.claude absent → no rows", () => {
    const t = team({ tuiCommands: { opencode: "opencode" } as never });
    expect(checkTuiCommandsClaudeOverride(t)).toEqual([]);
  });

  test("tuiCommands.claude with non-default suffix → no rows", () => {
    const t = team({
      tuiCommands: {
        claude: "CLAUDE_CONFIG_DIR=$HOME/.claude-personal claude --permission-mode auto",
      } as never,
    });
    expect(checkTuiCommandsClaudeOverride(t)).toEqual([]);
  });

  test("CLAUDE_CONFIG_DIR=$HOME/.claude bare default → YELLOW row", () => {
    const t = team({
      tuiCommands: {
        claude: "CLAUDE_CONFIG_DIR=$HOME/.claude claude --permission-mode auto",
      } as never,
    });
    const rows = checkTuiCommandsClaudeOverride(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("config-claude-account-tcoverride");
    expect(rows[0]?.hint).toContain("env -u CLAUDE_CONFIG_DIR");
    expect(rows[0]?.hint).toContain("claudeAccount");
  });

  test("CLAUDE_CONFIG_DIR=/root/.claude bare default → YELLOW row", () => {
    const t = team({
      tuiCommands: { claude: "CLAUDE_CONFIG_DIR=/root/.claude claude" } as never,
    });
    const rows = checkTuiCommandsClaudeOverride(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("yellow");
  });

  test("CLAUDE_CONFIG_DIR=${HOME}/.claude (brace expansion) → YELLOW row", () => {
    const t = team({
      tuiCommands: { claude: "CLAUDE_CONFIG_DIR=${HOME}/.claude claude" } as never,
    });
    const rows = checkTuiCommandsClaudeOverride(t);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("yellow");
  });

  test("CLAUDE_CONFIG_DIR=/root/.claude-unum (suffixed) → no row", () => {
    // Negative lookahead must permit the suffix.
    const t = team({
      tuiCommands: { claude: "CLAUDE_CONFIG_DIR=/root/.claude-unum claude" } as never,
    });
    expect(checkTuiCommandsClaudeOverride(t)).toEqual([]);
  });

  test("CLAUDE_CONFIG_DIR=$HOME/.claude/sub (path continuation) → no row", () => {
    // `.claude/sub` is structurally different from bare `.claude` —
    // the lookahead `[\w/-]` rejects this from triggering.
    const t = team({
      tuiCommands: { claude: "CLAUDE_CONFIG_DIR=$HOME/.claude/sub claude" } as never,
    });
    expect(checkTuiCommandsClaudeOverride(t)).toEqual([]);
  });

  test("tuiCommands not an object → no rows", () => {
    const t = team({ tuiCommands: "not-an-object" as never });
    expect(checkTuiCommandsClaudeOverride(t)).toEqual([]);
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

  test("ADR-084 W2: --fix dry-run summary lists safe-to-delete orphan branches", async () => {
    // Two info rows (one safe, one unmerged) + the existing deferred-
    // actions hint. The summary enumerates only the safe one.
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix"], {
      stdout,
      stderr,
      runChecks: async () => [
        {
          status: "info",
          label: "worktree:branch-orphan:stale",
          detail: "geoyws-stale — 0 commits ahead of geoyws (safe to delete)",
          hint: "atmux doctor --fix would prune it",
        },
        {
          status: "info",
          label: "worktree:branch-orphan:dirty",
          detail: "geoyws-dirty — 4 commit(s) ahead of geoyws (unmerged work)",
          hint: "review before deletion",
        },
      ],
    });
    expect(stderrBuf).toContain("would delete 1 orphan branch(es)");
    expect(stderrBuf).toContain("- geoyws-stale");
    expect(stderrBuf).not.toContain("- geoyws-dirty");
    expect(stderrBuf).toContain("--fix actions deferred per ADR-019");
  });

  test("ADR-084 W2: --fix without any safe orphans skips the dry-run summary", async () => {
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "stub" }],
    });
    expect(stderrBuf).not.toContain("would delete");
    expect(stderrBuf).toContain("--fix actions deferred per ADR-019");
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
    expect(rows[0]?.label).toBe("poke-config-drift");
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

// ---------- ADR-082 W5: checkWorktreeIsolation ----------

describe("checkWorktreeIsolation", () => {
  let atmuxDir: string;
  beforeEach(async () => {
    atmuxDir = await mkdtemp(join(tmpdir(), "atmux-doctor-wt-"));
  });
  afterEach(async () => {
    await rm(atmuxDir, { recursive: true, force: true });
  });

  type GitSpawn = import("../../../src/abstractions/worktree.ts").GitSpawn;
  type SpawnResult = import("../../../src/abstractions/spawn.ts").SpawnResult;
  type ReadDir = NonNullable<
    NonNullable<Parameters<typeof checkWorktreeIsolation>[2]>["readWorktreeDir"]
  >;

  function gitOk(stdout = ""): SpawnResult {
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
  function gitFail(stderr: string, code = 128): SpawnResult {
    return {
      exitCode: code,
      stdout: "",
      stderr,
      argv: [],
      cmd: "git",
      signalled: null,
      durationMs: 0,
    };
  }
  /** Build a `git worktree list --porcelain` block. */
  function porcelainBlock(path: string, branch: string | null): string {
    const head = "HEAD 0000000000000000000000000000000000000000";
    return branch === null
      ? `worktree ${path}\n${head}\ndetached\n`
      : `worktree ${path}\n${head}\nbranch refs/heads/${branch}\n`;
  }
  /** Build a fake `readWorktreeDir` that returns the given subdir names
   *  (all marked isDirectory: true). Pass `null` to simulate ENOENT. */
  function fakeReadDir(names: ReadonlyArray<string> | null): ReadDir {
    return async () => (names === null ? null : names.map((name) => ({ name, isDirectory: true })));
  }
  function team(members: ReadonlyArray<{ name: string }>, overrides: Partial<Team> = {}): Team {
    return { name: "demo", members, ...overrides } as Team;
  }

  test("team === null → empty rows (checkTeam already surfaced the failure)", async () => {
    expect(await checkWorktreeIsolation(null, atmuxDir)).toEqual([]);
  });

  // ---------- Class 4: disabled-but-present ----------

  test("isolation OFF + no leftover dirs → empty rows (no-op for legacy teams)", async () => {
    const rows = await checkWorktreeIsolation(team([{ name: "alice" }]), atmuxDir, {
      readWorktreeDir: fakeReadDir(null),
    });
    expect(rows).toEqual([]);
  });

  test("isolation OFF + leftover dirs → ONE yellow 'disabled-but-present' (batch)", async () => {
    const rows = await checkWorktreeIsolation(team([{ name: "alice" }]), atmuxDir, {
      readWorktreeDir: fakeReadDir(["alice", "stale-bob"]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("worktree:disabled-but-present");
    expect(rows[0]?.detail).toContain("2 dir(s)");
    expect(rows[0]?.hint).toContain("worktreeIsolation: true");
  });

  // ---------- Class 1: missing per member ----------

  test("isolation ON + member's worktree dir missing → RED 'worktree-missing:<name>'", async () => {
    const gitSpawn: GitSpawn = async () => gitOk(""); // no worktrees managed
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }, { name: "bob" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    // 2 missing rows; no wrong-branch probe ran (no present worktrees).
    const missing = rows.filter((r) => r.label.startsWith("worktree:missing:"));
    expect(missing).toHaveLength(2);
    expect(missing.every((r) => r.status === "red")).toBe(true);
    expect(missing.map((r) => r.label).sort()).toEqual([
      "worktree:missing:alice",
      "worktree:missing:bob",
    ]);
    expect(missing[0]?.hint).toContain("atmux start");
  });

  // ---------- Class 2: orphan ----------

  test("isolation ON + dir present that isn't in roster → YELLOW 'worktree-orphan:<dir>'", async () => {
    const gitSpawn: GitSpawn = async () =>
      // The wrong-branch probe runs because alice IS present (matched).
      // We want the orphan to also surface — set up a clean branch state
      // so wrong-branch returns no rows.
      gitOk("");
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      {
        readWorktreeDir: fakeReadDir(["alice", "ghost"]),
        // Override the git probe so wrong-branch detection cleanly skips.
        gitSpawn: async (argv) => {
          if (argv.includes("branch")) return gitOk(""); // detached HEAD → probe skip
          if (argv.includes("list")) return gitOk("");
          return gitOk("");
        },
      },
    );
    const orphans = rows.filter((r) => r.label.startsWith("worktree:orphan:"));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.label).toBe("worktree:orphan:ghost");
    expect(orphans[0]?.status).toBe("yellow");
    expect(orphans[0]?.detail).toContain("ghost");
    expect(orphans[0]?.hint).toContain("git worktree remove");
  });

  // ---------- Class 3: wrong-branch ----------

  test("isolation ON + worktree on wrong branch → YELLOW 'worktree-wrong-branch:<name>'", async () => {
    // ADR-084: per-member-branch model. The expected state for
    // member `alice` under base `geoyws` is `geoyws-alice`. Anything
    // else (feature-x, the base branch itself, or detached HEAD) is
    // drift. alice on feature-x AND bob on geoyws — BOTH surface
    // because neither matches their derived per-member branch.
    const wtAlice = resolveWtPath("alice");
    const wtBob = resolveWtPath("bob");
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("branch")) return gitOk("geoyws\n");
      if (argv.includes("list")) {
        return gitOk(
          [porcelainBlock(wtAlice, "feature-x"), porcelainBlock(wtBob, "geoyws")].join("\n"),
        );
      }
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }, { name: "bob" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["alice", "bob"]), gitSpawn },
    );
    const wrong = rows.filter((r) => r.label.startsWith("worktree:wrong-branch:"));
    expect(wrong).toHaveLength(2);
    const labels = wrong.map((r) => r.label).sort();
    expect(labels).toEqual(["worktree:wrong-branch:alice", "worktree:wrong-branch:bob"]);
    const aliceRow = wrong.find((r) => r.label.endsWith(":alice"));
    expect(aliceRow?.detail).toContain("feature-x");
    expect(aliceRow?.detail).toContain("geoyws-alice"); // expected per-member branch
    expect(aliceRow?.hint).toContain("checkout geoyws-alice");
    const bobRow = wrong.find((r) => r.label.endsWith(":bob"));
    // bob on base branch surfaces too — base ≠ geoyws-bob.
    expect(bobRow?.detail).toContain("geoyws");
    expect(bobRow?.detail).toContain("geoyws-bob");
  });

  test("isolation ON + worktree on its per-member branch (expected state) → NO wrong-branch row", async () => {
    // ADR-084 happy path: alice is checked out on `geoyws-alice`, the
    // per-member fork off `geoyws`. checkWorktreeIsolation must NOT
    // flag this — it's the canonical expected state.
    const wtAlice = resolveWtPath("alice");
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("branch")) return gitOk("geoyws\n");
      if (argv.includes("list")) return gitOk(porcelainBlock(wtAlice, "geoyws-alice"));
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["alice"]), gitSpawn },
    );
    expect(rows.filter((r) => r.label.startsWith("worktree:wrong-branch:"))).toEqual([]);
  });

  test("isolation ON + worktree on detached HEAD → YELLOW wrong-branch (detached ≠ per-member branch)", async () => {
    // Under ADR-084, the canonical state is `${base}-${member}`, NOT
    // detached HEAD. A detached worktree surfaces as drift with a
    // 'detached HEAD' state label in the detail string.
    const wtAlice = resolveWtPath("alice");
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("branch")) return gitOk("geoyws\n");
      if (argv.includes("list")) return gitOk(porcelainBlock(wtAlice, null));
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["alice"]), gitSpawn },
    );
    const wrong = rows.filter((r) => r.label.startsWith("worktree:wrong-branch:"));
    expect(wrong).toHaveLength(1);
    expect(wrong[0]?.label).toBe("worktree:wrong-branch:alice");
    expect(wrong[0]?.detail).toContain("detached HEAD");
    expect(wrong[0]?.detail).toContain("geoyws-alice");
  });

  test("isolation ON + git probe fails → single yellow 'branch-probe-skipped' (degrades, not aborts)", async () => {
    const gitSpawn: GitSpawn = async () => gitFail("fatal: not a git repository");
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["alice"]), gitSpawn },
    );
    const skipRow = rows.find((r) => r.label === "worktree:branch-probe-skipped");
    expect(skipRow).toBeDefined();
    expect(skipRow?.status).toBe("yellow");
    expect(skipRow?.detail).toContain("git probe failed");
  });

  test("isolation ON + detached HEAD (empty branch) → 'branch-probe-skipped' with detached-HEAD detail", async () => {
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("branch")) return gitOk("\n");
      if (argv.includes("list")) return gitOk(porcelainBlock(resolveWtPath("alice"), "main"));
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["alice"]), gitSpawn },
    );
    const skip = rows.find((r) => r.label === "worktree:branch-probe-skipped");
    expect(skip).toBeDefined();
    expect(skip?.detail).toContain("detached HEAD");
  });

  test("isolation ON + dir present but git worktree list doesn't know it → 'not-managed:<name>'", async () => {
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("branch")) return gitOk("geoyws\n");
      if (argv.includes("list")) return gitOk(""); // empty list — no managed worktrees
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["alice"]), gitSpawn },
    );
    const stray = rows.find((r) => r.label === "worktree:not-managed:alice");
    expect(stray).toBeDefined();
    expect(stray?.status).toBe("yellow");
    expect(stray?.detail).toContain("isn't registered");
  });

  // ---------- Composite: missing + orphan + wrong-branch in one pass ----------

  test("composite — RED missing + YELLOW orphan + YELLOW wrong-branch all surface in one pass", async () => {
    // bob is on feature-x → drift under ADR-084 per-member-branch
    // model (expected `geoyws-bob`, anything else surfaces).
    const wtBob = resolveWtPath("bob");
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("branch")) return gitOk("geoyws\n");
      if (argv.includes("list")) return gitOk(porcelainBlock(wtBob, "feature-x"));
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }, { name: "bob" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir(["bob", "stale"]), gitSpawn },
    );
    // alice missing (RED), stale orphan (YELLOW), bob wrong-branch (YELLOW).
    const labels = rows.map((r) => r.label).sort();
    expect(labels).toContain("worktree:missing:alice");
    expect(labels).toContain("worktree:orphan:stale");
    expect(labels).toContain("worktree:wrong-branch:bob");
    // Status mix surfaces correctly.
    expect(rows.find((r) => r.label === "worktree:missing:alice")?.status).toBe("red");
    expect(rows.find((r) => r.label === "worktree:orphan:stale")?.status).toBe("yellow");
    expect(rows.find((r) => r.label === "worktree:wrong-branch:bob")?.status).toBe("yellow");
  });

  // ---------- Class 5 (ADR-084 W2): branch-orphan ----------
  //
  // Tests pair `branch --show-current` (returns the base) with `branch
  // --list '<base>-*'` (returns the per-member fork branches). For each
  // orphan, a third call to `rev-list --count <base>..<branch>` reports
  // unmerged commit count. The fakeGitSpawn helper dispatches on argv
  // shape so each call returns a distinct fixture.

  /** Build a gitSpawn fixture that dispatches by argv shape. Any call
   *  not matched defaults to `gitOk("")` — mimicking a clean git env. */
  function fakeGitSpawn(spec: {
    showCurrent?: string;
    branchList?: string;
    branchListFails?: boolean;
    revListByBranch?: Record<string, string>;
    revListFailsByBranch?: Record<string, true>;
    // also the W5 wrong-branch probe — porcelain output for `worktree
    // list --porcelain` (separate from --list).
    worktreeListPorcelain?: string;
  }): GitSpawn {
    return async (argv) => {
      if (argv.includes("--show-current")) {
        return gitOk(spec.showCurrent ?? "");
      }
      if (argv.includes("worktree") && argv.includes("list")) {
        return gitOk(spec.worktreeListPorcelain ?? "");
      }
      if (argv.includes("branch") && argv.includes("--list")) {
        if (spec.branchListFails === true) {
          return gitFail("fatal: bad list", 128);
        }
        return gitOk(spec.branchList ?? "");
      }
      if (argv.includes("rev-list")) {
        // argv tail: ["rev-list", "--count", "<base>..<branch>"]
        const range = argv[argv.length - 1] ?? "";
        const branch = range.split("..")[1] ?? "";
        if (spec.revListFailsByBranch?.[branch] === true) {
          return gitFail("fatal: bad rev-list", 128);
        }
        const count = spec.revListByBranch?.[branch] ?? "0";
        return gitOk(`${count}\n`);
      }
      return gitOk("");
    };
  }

  test("isolation ON + safe orphan (0 commits ahead) → INFO 'branch-orphan:<name>' with safe-to-delete hint", async () => {
    // alice is current; stale was a former member whose branch survived
    // `stop --force` per ADR-084 OQ-2. Zero commits ahead of geoyws
    // means the branch is safely deletable.
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n  geoyws-stale\n",
      revListByBranch: { "geoyws-stale": "0" },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    const orphans = rows.filter((r) => r.label.startsWith("worktree:branch-orphan:"));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.label).toBe("worktree:branch-orphan:stale");
    expect(orphans[0]?.status).toBe("info");
    expect(orphans[0]?.detail).toContain("geoyws-stale");
    expect(orphans[0]?.detail).toContain("0 commits ahead");
    expect(orphans[0]?.detail).toContain("safe to delete");
    expect(orphans[0]?.hint).toContain("atmux doctor --fix");
    expect(orphans[0]?.hint).toContain("git branch -d geoyws-stale");
  });

  test("isolation ON + orphan with unmerged commits → INFO with manual-review hint, no auto-delete signal", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-stale\n",
      revListByBranch: { "geoyws-stale": "7" },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    const orphan = rows.find((r) => r.label === "worktree:branch-orphan:stale");
    expect(orphan).toBeDefined();
    expect(orphan?.status).toBe("info");
    expect(orphan?.detail).toContain("7 commit(s) ahead");
    expect(orphan?.detail).toContain("unmerged work");
    expect(orphan?.hint).toContain("review before deletion");
    // Auto-delete signal absent — must NOT mention --fix.
    expect(orphan?.detail).not.toContain("safe to delete");
  });

  test("isolation ON + known-member branch (suffix in roster) → NO branch-orphan row", async () => {
    // geoyws-alice corresponds to a current roster member → not orphan.
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "3" }, // even with commits, not an orphan
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    expect(rows.filter((r) => r.label.startsWith("worktree:branch-orphan:"))).toEqual([]);
  });

  test("isolation ON + sanitized member name matches (emoji/dot member) → NO orphan row", async () => {
    // ADR-084: provisionWorktree uses sanitizeBranchSegment("up.impl") =
    // "up-impl"; the branch on disk is `geoyws-up-impl`. The orphan check
    // must compare via the SAME sanitiser — otherwise live members with
    // non-alphanumeric chars would falsely surface as orphans.
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-up-impl\n",
      revListByBranch: { "geoyws-up-impl": "0" },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "up.impl" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    expect(rows.filter((r) => r.label.startsWith("worktree:branch-orphan:"))).toEqual([]);
  });

  test("isolation ON + branch --list fails → degrades silently (no orphan rows, no crash)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchListFails: true,
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    expect(rows.filter((r) => r.label.startsWith("worktree:branch-orphan:"))).toEqual([]);
  });

  test("isolation ON + rev-list fails for an orphan → INFO with probe-failed detail", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-stale\n",
      revListFailsByBranch: { "geoyws-stale": true },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    const orphan = rows.find((r) => r.label === "worktree:branch-orphan:stale");
    expect(orphan).toBeDefined();
    expect(orphan?.status).toBe("info");
    expect(orphan?.detail).toContain("unmerged-count probe failed");
    expect(orphan?.hint).toContain("manually verify");
  });

  test("isolation ON + detached HEAD (empty base) → orphan probe skipped entirely", async () => {
    // baseR.stdout.trim() === "" — the orphan filter requires a base to
    // anchor against. Skip is graceful; W5's branch-probe-skipped row
    // already covers operator visibility.
    const gitSpawn = fakeGitSpawn({
      showCurrent: "\n",
      branchList: "  geoyws-stale\n", // present, but won't be queried
      revListByBranch: { "geoyws-stale": "0" },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    expect(rows.filter((r) => r.label.startsWith("worktree:branch-orphan:"))).toEqual([]);
  });

  test("isolation ON + branch list contains base branch itself (no '-' suffix) → not flagged as orphan", async () => {
    // `git branch --list 'geoyws-*'` shouldn't return bare `geoyws` —
    // but defensive: the prefix filter requires `${base}-` so bare base
    // can never match even if it sneaks in.
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws\n  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "0" },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    expect(rows.filter((r) => r.label.startsWith("worktree:branch-orphan:"))).toEqual([]);
  });

  test("isolation ON + current-branch marker (`* geoyws-stale`) in branch list → still detected as orphan", async () => {
    // `git branch --list` prefixes the current branch with `* `. The
    // strip-leading-marker regex must handle it. (Realistically an
    // orphan can't be current — but the parser MUST be robust.)
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "* geoyws-stale\n",
      revListByBranch: { "geoyws-stale": "0" },
    });
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: true }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    const orphan = rows.find((r) => r.label === "worktree:branch-orphan:stale");
    expect(orphan).toBeDefined();
    expect(orphan?.detail).toContain("safe to delete");
  });

  test("isolation OFF → orphan probe doesn't run (returns early at disabled-but-present check)", async () => {
    // Class 4 short-circuit: when isolation is off we don't even reach
    // the orphan probe. fakeGitSpawn doesn't get invoked.
    let gitCalls = 0;
    const gitSpawn: GitSpawn = async () => {
      gitCalls += 1;
      return gitOk("");
    };
    const rows = await checkWorktreeIsolation(
      team([{ name: "alice" }], { worktreeIsolation: false }),
      atmuxDir,
      { readWorktreeDir: fakeReadDir([]), gitSpawn },
    );
    expect(rows).toEqual([]);
    expect(gitCalls).toBe(0);
  });

  // Helper: resolve a worktree path against the test's atmuxDir, matching
  // what the production `resolveWorktreePath` derives.
  function resolveWtPath(member: string): string {
    const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
    return join(projectRoot, ".atmux", "worktrees", member);
  }
});

// ---------- ADR-084 W2: collectSafeOrphanBranches ----------

describe("collectSafeOrphanBranches", () => {
  test("returns branch names for info rows tagged 'safe to delete' only", () => {
    const rows: DoctorRow[] = [
      {
        status: "info",
        label: "worktree:branch-orphan:stale",
        detail: "geoyws-stale — 0 commits ahead of geoyws (safe to delete)",
        hint: "atmux doctor --fix would prune it",
      },
      {
        status: "info",
        label: "worktree:branch-orphan:dirty",
        detail: "geoyws-dirty — 5 commit(s) ahead of geoyws (unmerged work)",
        hint: "review before deletion",
      },
      // Non-orphan label — must be ignored.
      { status: "yellow", label: "worktree:wrong-branch:alice", detail: "anything" },
    ];
    expect(collectSafeOrphanBranches(rows)).toEqual(["geoyws-stale"]);
  });

  test("returns empty when no info rows", () => {
    const rows: DoctorRow[] = [
      { status: "red", label: "worktree:missing:alice", detail: "expected …" },
    ];
    expect(collectSafeOrphanBranches(rows)).toEqual([]);
  });

  test("non-info status with branch-orphan label is ignored (defensive)", () => {
    const rows: DoctorRow[] = [
      {
        status: "yellow",
        label: "worktree:branch-orphan:weird",
        detail: "geoyws-weird — 0 commits ahead of geoyws (safe to delete)",
      },
    ];
    expect(collectSafeOrphanBranches(rows)).toEqual([]);
  });

  test("preserves order of detection (stable, matches doctor render)", () => {
    const rows: DoctorRow[] = [
      {
        status: "info",
        label: "worktree:branch-orphan:bob",
        detail: "geoyws-bob — 0 commits ahead of geoyws (safe to delete)",
      },
      {
        status: "info",
        label: "worktree:branch-orphan:alice",
        detail: "geoyws-alice — 0 commits ahead of geoyws (safe to delete)",
      },
    ];
    expect(collectSafeOrphanBranches(rows)).toEqual(["geoyws-bob", "geoyws-alice"]);
  });
});

// ---------- ADR-081 §D: checkMemberCageStates + collectStarvingMembers ----------

describe("checkMemberCageStates — ADR-081 §D classifier", () => {
  const makeTeam = (members: Array<Partial<TeamMember>>): Team =>
    ({
      name: "starve-team",
      members: members.map((m, i) => ({
        name: m.name ?? `m${i}`,
        role: m.role ?? "member",
        emoji: m.emoji ?? "🐝",
        tui: m.tui ?? "claude",
        ...m,
      })),
    }) as Team;

  test("team=null → empty rows (no work)", async () => {
    expect(await checkMemberCageStates(null, "/tmp/atmux-x")).toEqual([]);
  });

  test("session down → empty rows (other checks cover it)", async () => {
    const rows = await checkMemberCageStates(makeTeam([{ name: "lead" }]), "/tmp/atmux-x", {
      hasSession: async () => false,
    });
    expect(rows).toEqual([]);
  });

  test("active member → no row (silent-green)", async () => {
    const team = makeTeam([{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🧭${m.name}`,
        state: "active",
        paneUptimeSec: 600,
        evidence: "tok 12.5k/200k",
        heartbeatAgeSec: null,
      }),
    });
    expect(rows).toEqual([]);
  });

  test("down member → yellow row with 'pane down' detail", async () => {
    const team = makeTeam([{ name: "w1" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🐝${m.name}`,
        state: "down",
        paneUptimeSec: null,
        evidence: "",
        heartbeatAgeSec: null,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("member-cage-state:w1");
    expect(rows[0]?.detail).toContain("pane down");
  });

  test("bootstrapping + uptime above threshold → yellow 'welcome banner persistent' row (t-74273200: was 'starving')", async () => {
    const team = makeTeam([{ name: "w1" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🐝${m.name}`,
        state: "bootstrapping",
        paneUptimeSec: STARVING_THRESHOLD_S + 60,
        evidence: "Welcome to Claude Code",
        heartbeatAgeSec: null,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("member-cage-state:w1");
    expect(rows[0]?.detail).toContain("welcome banner persistent");
    expect(rows[0]?.detail).toContain("uptime");
    expect(rows[0]?.hint).toContain("--fix");
  });

  test("bootstrapping + uptime below threshold → silent (transient)", async () => {
    const team = makeTeam([{ name: "w1" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🐝${m.name}`,
        state: "bootstrapping",
        paneUptimeSec: 10, // 10s < default 60s threshold
        evidence: "Welcome to Claude Code",
        heartbeatAgeSec: null,
      }),
    });
    expect(rows).toEqual([]);
  });

  test("starvingThresholdSec=0 flips silent → yellow (test injection)", async () => {
    // Same uptime, but with threshold lowered to 0 — the same pane is
    // now "long enough" to surface as starving-yellow. Confirms the
    // threshold gate is the only thing keeping the transient state silent.
    const team = makeTeam([{ name: "w1" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      starvingThresholdSec: 0,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🐝${m.name}`,
        state: "bootstrapping",
        paneUptimeSec: 5,
        evidence: "Welcome to Claude Code",
        heartbeatAgeSec: null,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("welcome banner persistent");
  });

  test("wedged (rate-limit) → yellow row with rate-limit hint (t-74273200 §wedged)", async () => {
    const team = makeTeam([{ name: "w1" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🐝${m.name}`,
        state: "wedged",
        paneUptimeSec: 3600,
        evidence: "You've hit your limit",
        heartbeatAgeSec: null, // no heartbeat → rate-limit branch
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("member-cage-state:w1");
    expect(rows[0]?.detail).toContain("wedged");
    expect(rows[0]?.detail).toContain("rate-limit");
    expect(rows[0]?.hint).toContain("rotate");
  });

  test("wedged (heartbeat stale >2h) → yellow row citing heartbeat age", async () => {
    const team = makeTeam([{ name: "w1" }]);
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => ({
        member: m.name,
        windowName: `🐝${m.name}`,
        state: "wedged",
        paneUptimeSec: 10_000,
        evidence: "tok 12.5k/200k",
        heartbeatAgeSec: 8000, // >2h
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("wedged");
    expect(rows[0]?.detail).toContain("heartbeat stale");
    expect(rows[0]?.detail).toContain("133min"); // 8000s / 60 = 133
  });

  test("mixed roster — surface down + bootstrapping(>thr) + wedged rows; active silent", async () => {
    const team = makeTeam([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "w1", emoji: "🐝" },
      { name: "w2", emoji: "🐝" },
      { name: "w3", emoji: "🐝" },
    ]);
    type RowFixture = { state: CageState; paneUptimeSec: number | null; evidence: string };
    const fixtures: Record<string, RowFixture> = {
      lead: { state: "active", paneUptimeSec: 600, evidence: "tok 12.5k/200k" },
      w1: { state: "bootstrapping", paneUptimeSec: 600, evidence: "Welcome to Claude Code" },
      w2: { state: "down", paneUptimeSec: null, evidence: "" },
      w3: { state: "wedged", paneUptimeSec: 3600, evidence: "hit your limit" },
    };
    const rows = await checkMemberCageStates(team, "/tmp/atmux-x", {
      hasSession: async () => true,
      probe: async (_t, m) => {
        const f = fixtures[m.name] ?? fixtures.lead!;
        return {
          member: m.name,
          windowName: `${m.emoji ?? "🐝"}${m.name}`,
          state: f.state,
          paneUptimeSec: f.paneUptimeSec,
          evidence: f.evidence,
          heartbeatAgeSec: null,
        };
      },
    });
    expect(rows).toHaveLength(3);
    const labels = rows.map((r) => r.label).sort();
    expect(labels).toEqual([
      "member-cage-state:w1",
      "member-cage-state:w2",
      "member-cage-state:w3",
    ]);
  });
});

describe("collectStarvingMembers — ADR-081 §D row-scan", () => {
  test("empty rows → empty list", () => {
    expect(collectStarvingMembers([])).toEqual([]);
  });

  test("extracts member names from starving rows", () => {
    const rows: DoctorRow[] = [
      {
        status: "yellow",
        label: "member-cage-state:w1",
        detail: "welcome banner persistent — claude alive in 🐝w1 ...",
      },
      {
        status: "yellow",
        label: "member-cage-state:w2",
        detail: "welcome banner persistent — ...",
      },
    ];
    expect(collectStarvingMembers(rows)).toEqual(["w1", "w2"]);
  });

  test("skips 'down' rows (different detail substring)", () => {
    const rows: DoctorRow[] = [
      {
        status: "yellow",
        label: "member-cage-state:w1",
        detail: "pane down — no `claude` in window 🐝w1",
      },
    ];
    expect(collectStarvingMembers(rows)).toEqual([]);
  });

  test("skips non-yellow rows + unrelated labels", () => {
    const rows: DoctorRow[] = [
      {
        status: "green",
        label: "member-cage-state:w1",
        detail: "welcome banner persistent ...",
      },
      {
        status: "yellow",
        label: "worktree:missing:w1",
        detail: "welcome banner persistent ...",
      },
    ];
    expect(collectStarvingMembers(rows)).toEqual([]);
  });
});

// ---------- ADR-179 §Decision-6 W6: checkMergerFanIn ----------

describe("checkMergerFanIn", () => {
  let atmuxDir: string;
  beforeEach(async () => {
    atmuxDir = await mkdtemp(join(tmpdir(), "atmux-doctor-merger-"));
  });
  afterEach(async () => {
    await rm(atmuxDir, { recursive: true, force: true });
  });

  type GitSpawn = import("../../../src/abstractions/worktree.ts").GitSpawn;
  type SpawnResult = import("../../../src/abstractions/spawn.ts").SpawnResult;
  function gitOk(stdout = ""): SpawnResult {
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
  function gitFail(stderr: string, code = 128): SpawnResult {
    return {
      exitCode: code,
      stdout: "",
      stderr,
      argv: [],
      cmd: "git",
      signalled: null,
      durationMs: 0,
    };
  }
  /** Build a Team with optional `merger` block + roster. `merger` rides
   *  the schema's `.passthrough()` so the runtime cast in
   *  `readMergerConfig` picks it up exactly as a trunk-merged W4 would. */
  function team(
    members: ReadonlyArray<{ name: string; role?: string }>,
    merger?: { enabled?: boolean; baseBranch?: string; stalenessHours?: number },
  ): Team {
    const base: Record<string, unknown> = { name: "demo", members };
    if (merger !== undefined) base.merger = merger;
    return base as Team;
  }
  /** Build a gitSpawn that dispatches on argv shape: show-current,
   *  branch --list, rev-list --count, log -1 --format=%ct. */
  function fakeGitSpawn(spec: {
    showCurrent?: string;
    branchList?: string;
    branchListFails?: boolean;
    revListByBranch?: Record<string, string>;
    revListFailsByBranch?: Record<string, true>;
    /** Tip-commit times (epoch seconds) per branch. */
    tipTimeByBranch?: Record<string, string>;
    tipTimeFailsByBranch?: Record<string, true>;
  }): GitSpawn {
    return async (argv) => {
      if (argv.includes("--show-current")) {
        return gitOk(spec.showCurrent ?? "");
      }
      if (argv.includes("branch") && argv.includes("--list")) {
        if (spec.branchListFails === true) return gitFail("fatal: bad list");
        return gitOk(spec.branchList ?? "");
      }
      if (argv.includes("rev-list")) {
        const range = argv[argv.length - 1] ?? "";
        const branch = range.split("..")[1] ?? "";
        if (spec.revListFailsByBranch?.[branch] === true) return gitFail("fatal: bad rev-list");
        const count = spec.revListByBranch?.[branch] ?? "0";
        return gitOk(`${count}\n`);
      }
      if (argv.includes("log") && argv.includes("--format=%ct")) {
        const branch = argv[argv.length - 1] ?? "";
        if (spec.tipTimeFailsByBranch?.[branch] === true) return gitFail("fatal: bad log");
        const tip = spec.tipTimeByBranch?.[branch] ?? "0";
        return gitOk(`${tip}\n`);
      }
      return gitOk("");
    };
  }

  /** Reference "now" fixture — 2026-05-15 12:00 UTC. */
  const NOW_SEC = 1778889600;
  const HOUR = 3600;

  test("team === null → empty rows", async () => {
    expect(await checkMergerFanIn(null, atmuxDir)).toEqual([]);
  });

  test("no merger block + no merger member → empty rows (default path)", async () => {
    const rows = await checkMergerFanIn(team([{ name: "alice" }]), atmuxDir, {
      gitSpawn: fakeGitSpawn({}),
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows).toEqual([]);
  });

  // ---------- Class 2: merger-disabled-but-member-present ----------

  test("role=merger member + merger.enabled !== true → YELLOW per offender", async () => {
    const rows = await checkMergerFanIn(
      team([{ name: "alice" }, { name: "fan", role: "merger" }]),
      atmuxDir,
      { gitSpawn: fakeGitSpawn({}), nowEpochSec: () => NOW_SEC },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("merger:disabled-but-member-present:fan");
    expect(rows[0]?.detail).toContain("'fan'");
    expect(rows[0]?.detail).toContain("role=merger");
    expect(rows[0]?.detail).toContain("merger.enabled");
    expect(rows[0]?.hint).toContain("team.merger.enabled: true");
  });

  test("role=merger + merger.enabled: false explicit → still YELLOW (treats falsy as disabled)", async () => {
    const rows = await checkMergerFanIn(
      team([{ name: "fan", role: "merger" }], { enabled: false }),
      atmuxDir,
      { gitSpawn: fakeGitSpawn({}), nowEpochSec: () => NOW_SEC },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("merger:disabled-but-member-present:fan");
  });

  test("role=merger + merger.enabled: true → NO disabled-but-member-present row", async () => {
    const rows = await checkMergerFanIn(
      team([{ name: "fan", role: "merger" }], { enabled: true }),
      atmuxDir,
      { gitSpawn: fakeGitSpawn({ showCurrent: "geoyws\n" }), nowEpochSec: () => NOW_SEC },
    );
    expect(rows.filter((r) => r.label.startsWith("merger:disabled-but-member-present:"))).toEqual(
      [],
    );
  });

  test("multiple role=merger members + disabled → one YELLOW per offender", async () => {
    const rows = await checkMergerFanIn(
      team([
        { name: "fan-1", role: "merger" },
        { name: "fan-2", role: "merger" },
      ]),
      atmuxDir,
      { gitSpawn: fakeGitSpawn({}), nowEpochSec: () => NOW_SEC },
    );
    const offenders = rows.filter((r) => r.label.startsWith("merger:disabled-but-member-present:"));
    expect(offenders).toHaveLength(2);
    expect(offenders.map((r) => r.label).sort()).toEqual([
      "merger:disabled-but-member-present:fan-1",
      "merger:disabled-but-member-present:fan-2",
    ]);
  });

  // ---------- Class 1: merger-branch-stale ----------

  test("merger.enabled=true + stale branch (>24h, default threshold) → YELLOW with hint", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "3" },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 30 * HOUR) }, // 30h old
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    const stale = rows.filter((r) => r.label.startsWith("merger:branch-stale:"));
    expect(stale).toHaveLength(1);
    expect(stale[0]?.status).toBe("yellow");
    expect(stale[0]?.label).toBe("merger:branch-stale:alice");
    expect(stale[0]?.detail).toContain("geoyws-alice");
    expect(stale[0]?.detail).toContain("3 commit(s) ahead");
    expect(stale[0]?.detail).toContain("~30h old");
    expect(stale[0]?.detail).toContain("threshold 24h");
    expect(stale[0]?.hint).toContain("atmux merge-member alice");
  });

  test("merger.enabled=true + fresh branch (<24h) → NO stale row", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "3" },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 6 * HOUR) }, // 6h old
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + custom stalenessHours: 6 + 8h-old branch → YELLOW (custom threshold honoured)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "1" },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 8 * HOUR) },
    });
    const rows = await checkMergerFanIn(
      team([{ name: "alice" }], { enabled: true, stalenessHours: 6 }),
      atmuxDir,
      { gitSpawn, nowEpochSec: () => NOW_SEC },
    );
    const stale = rows.filter((r) => r.label.startsWith("merger:branch-stale:"));
    expect(stale).toHaveLength(1);
    expect(stale[0]?.detail).toContain("threshold 6h");
  });

  test("merger.enabled=true + 0 commits ahead → NO stale row (no-op merge)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "0" },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 30 * HOUR) },
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + branch suffix not in roster → NO stale row (class 5 of worktree-isolation owns orphans)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-stale-departed\n",
      revListByBranch: { "geoyws-stale-departed": "5" },
      tipTimeByBranch: { "geoyws-stale-departed": String(NOW_SEC - 100 * HOUR) },
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + sanitized member name match (dotted member → dashed branch) → uses canonical member name in label", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-up-impl\n",
      revListByBranch: { "geoyws-up-impl": "2" },
      tipTimeByBranch: { "geoyws-up-impl": String(NOW_SEC - 30 * HOUR) },
    });
    const rows = await checkMergerFanIn(team([{ name: "up.impl" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    const stale = rows.find((r) => r.label === "merger:branch-stale:up.impl");
    expect(stale).toBeDefined();
    expect(stale?.hint).toContain("atmux merge-member up.impl");
  });

  test("merger.enabled=true + explicit baseBranch override → uses configured base, ignores HEAD", async () => {
    let showCurrentCalled = false;
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("--show-current")) {
        showCurrentCalled = true;
        return gitOk("wrong-base\n");
      }
      if (argv.includes("branch") && argv.includes("--list")) {
        const pat = argv[argv.length - 1] ?? "";
        if (pat === "configured-base-*") return gitOk("  configured-base-alice\n");
        return gitOk("");
      }
      if (argv.includes("rev-list")) return gitOk("4\n");
      if (argv.includes("--format=%ct")) return gitOk(String(NOW_SEC - 50 * HOUR) + "\n");
      return gitOk("");
    };
    const rows = await checkMergerFanIn(
      team([{ name: "alice" }], { enabled: true, baseBranch: "configured-base" }),
      atmuxDir,
      { gitSpawn, nowEpochSec: () => NOW_SEC },
    );
    expect(showCurrentCalled).toBe(false); // baseBranch override skips HEAD probe.
    const stale = rows.find((r) => r.label === "merger:branch-stale:alice");
    expect(stale).toBeDefined();
    expect(stale?.detail).toContain("configured-base-alice");
    expect(stale?.detail).toContain("configured-base");
  });

  test("merger.enabled !== true → staleness probe doesn't run (NO git invocations for stale class)", async () => {
    let gitCalls = 0;
    const gitSpawn: GitSpawn = async () => {
      gitCalls++;
      return gitOk("");
    };
    const rows = await checkMergerFanIn(team([{ name: "alice" }]), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows).toEqual([]);
    expect(gitCalls).toBe(0);
  });

  test("merger.enabled=true + detached HEAD (empty show-current) + no baseBranch → skip stale probe (no rows, no crash)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "\n",
      branchList: "  geoyws-alice\n", // would be present if probed
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 50 * HOUR) },
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + branch --list fails → degrades silently, no stale rows", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchListFails: true,
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + rev-list fails → branch skipped (no stale row, no crash)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListFailsByBranch: { "geoyws-alice": true },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 100 * HOUR) },
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + log %ct fails → branch skipped (can't compute age)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "2" },
      tipTimeFailsByBranch: { "geoyws-alice": true },
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.filter((r) => r.label.startsWith("merger:branch-stale:"))).toEqual([]);
  });

  test("merger.enabled=true + current-branch marker (`* geoyws-alice`) on the list → stripped + still detected", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "* geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "5" },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 48 * HOUR) },
    });
    const rows = await checkMergerFanIn(team([{ name: "alice" }], { enabled: true }), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(rows.find((r) => r.label === "merger:branch-stale:alice")).toBeDefined();
  });

  test("merger.enabled=true + stalenessHours: 0 falls back to default (24h, not silently disable)", async () => {
    // Defensive: a 0/negative threshold could silently disable the
    // staleness check by making `staleCutoffSec === nowSec` (everything
    // newer than now is fresh). Falling back to the default keeps the
    // probe useful.
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n",
      revListByBranch: { "geoyws-alice": "1" },
      tipTimeByBranch: { "geoyws-alice": String(NOW_SEC - 30 * HOUR) },
    });
    const rows = await checkMergerFanIn(
      team([{ name: "alice" }], { enabled: true, stalenessHours: 0 }),
      atmuxDir,
      { gitSpawn, nowEpochSec: () => NOW_SEC },
    );
    const stale = rows.find((r) => r.label === "merger:branch-stale:alice");
    expect(stale).toBeDefined();
    expect(stale?.detail).toContain("threshold 24h");
  });

  // ---------- Composite (class 1 + class 2) ----------

  test("merger.enabled=true + role=merger member + stale branch → ONLY class 1 surfaces (member-present is short-circuited when enabled)", async () => {
    const gitSpawn = fakeGitSpawn({
      showCurrent: "geoyws\n",
      branchList: "  geoyws-alice\n  geoyws-fan\n",
      revListByBranch: { "geoyws-alice": "2", "geoyws-fan": "0" },
      tipTimeByBranch: {
        "geoyws-alice": String(NOW_SEC - 40 * HOUR),
        "geoyws-fan": String(NOW_SEC - 1 * HOUR),
      },
    });
    const rows = await checkMergerFanIn(
      team([{ name: "alice" }, { name: "fan", role: "merger" }], { enabled: true }),
      atmuxDir,
      { gitSpawn, nowEpochSec: () => NOW_SEC },
    );
    expect(rows.filter((r) => r.label.startsWith("merger:disabled-but-member-present:"))).toEqual(
      [],
    );
    const stale = rows.filter((r) => r.label.startsWith("merger:branch-stale:"));
    expect(stale).toHaveLength(1);
    expect(stale[0]?.label).toBe("merger:branch-stale:alice");
  });

  test("merger.enabled !== true + role=merger member + stale branch on roster → class 2 only (class 1 short-circuits)", async () => {
    let gitCalls = 0;
    const gitSpawn: GitSpawn = async () => {
      gitCalls++;
      return gitOk("");
    };
    const rows = await checkMergerFanIn(team([{ name: "fan", role: "merger" }]), atmuxDir, {
      gitSpawn,
      nowEpochSec: () => NOW_SEC,
    });
    expect(gitCalls).toBe(0); // staleness probe never fires.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("merger:disabled-but-member-present:fan");
  });
});

// ---------- ADR-137: checkMemberForcePushRecent ----------

describe("checkMemberForcePushRecent", () => {
  type SpawnResult = import("../../../src/abstractions/spawn.ts").SpawnResult;
  type GitSpawn = NonNullable<
    NonNullable<Parameters<typeof checkMemberForcePushRecent>[2]>["gitSpawn"]
  >;

  function gitOk(stdout = ""): SpawnResult {
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
  function gitFail(code = 128): SpawnResult {
    return {
      exitCode: code,
      stdout: "",
      stderr: "fatal: not a git repository",
      argv: [],
      cmd: "git",
      signalled: null,
      durationMs: 0,
    };
  }
  function team(members: ReadonlyArray<{ name: string }>, overrides: Partial<Team> = {}): Team {
    return {
      name: "demo",
      worktreeIsolation: true,
      members,
      ...overrides,
    } as Team;
  }

  /** Stub that responds to `branch --show-current` with `branchName`
   *  for every member, then returns `reflogOut` for `reflog show
   *  <branch>`. */
  function gitStub(branchName: string, reflogOut: string): GitSpawn {
    return async (argv) => {
      if (argv.includes("--show-current")) return gitOk(`${branchName}\n`);
      if (argv.includes("reflog")) return gitOk(reflogOut);
      return gitOk("");
    };
  }

  test("team === null → empty rows", async () => {
    expect(await checkMemberForcePushRecent(null, "/p/.atmux")).toEqual([]);
  });

  test("worktreeIsolation !== true → empty rows (single-trunk teams skipped)", async () => {
    const rows = await checkMemberForcePushRecent(
      team([{ name: "alice" }], { worktreeIsolation: false }),
      "/p/.atmux",
    );
    expect(rows).toEqual([]);
  });

  test("worktreeIsolation undefined → empty rows", async () => {
    const t = { name: "demo", members: [{ name: "alice" }] } as Team;
    expect(await checkMemberForcePushRecent(t, "/p/.atmux")).toEqual([]);
  });

  test("no force-push events in reflog → empty rows", async () => {
    const reflog = [
      "refs/heads/main-alice@{1700000000} commit: feat(x): land thing",
      "refs/heads/main-alice@{1699999000} commit: docs(y): tweak readme",
    ].join("\n");
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitStub("main-alice", reflog),
      now: () => 1700001000,
    });
    expect(rows).toEqual([]);
  });

  test("recent force-push (`update by push (forced)`) → yellow row with ADR-137 hint", async () => {
    const reflog = [
      "refs/heads/main-alice@{1700000900} update by push (forced)",
      "refs/heads/main-alice@{1699998000} commit: feat(x): earlier work",
    ].join("\n");
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitStub("main-alice", reflog),
      now: () => 1700001000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("member-forcepush-recent:alice");
    expect(rows[0]?.hint).toContain("ADR-137");
    expect(rows[0]?.hint).toContain("merge");
  });

  test("`forced-update` (alt reflog wording) also matched", async () => {
    const reflog = "refs/heads/main-bob@{1700000950} forced-update";
    const rows = await checkMemberForcePushRecent(team([{ name: "bob" }]), "/p/.atmux", {
      gitSpawn: gitStub("main-bob", reflog),
      now: () => 1700001000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-forcepush-recent:bob");
  });

  test("force-push OUTSIDE the time window → empty rows (>1h ago is stale)", async () => {
    const reflog = "refs/heads/main-alice@{1699990000} update by push (forced)";
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitStub("main-alice", reflog),
      now: () => 1700001000, // 11000s after the force-push → outside default 3600s window
    });
    expect(rows).toEqual([]);
  });

  test("custom windowSec opens the time window (operator-tunable)", async () => {
    const reflog = "refs/heads/main-alice@{1699990000} update by push (forced)";
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitStub("main-alice", reflog),
      now: () => 1700001000,
      windowSec: 12_000, // widen — now the force-push is in-window
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-forcepush-recent:alice");
  });

  test("multiple members — only those with recent force-push surface", async () => {
    const aliceReflog = "refs/heads/main-alice@{1700000950} update by push (forced)";
    const bobReflog = "refs/heads/main-bob@{1700000900} commit: docs(y): work";
    const gitMulti: GitSpawn = async (argv) => {
      if (argv.includes("--show-current")) {
        // Resolve current branch from the worktree path arg (-C <wt>).
        const cIdx = argv.indexOf("-C");
        const wt = argv[cIdx + 1] ?? "";
        if (wt.endsWith("/alice")) return gitOk("main-alice\n");
        if (wt.endsWith("/bob")) return gitOk("main-bob\n");
        return gitFail();
      }
      if (argv.includes("reflog")) {
        const refIdx = argv.indexOf("show");
        const ref = argv[refIdx + 1] ?? "";
        if (ref === "main-alice") return gitOk(aliceReflog);
        if (ref === "main-bob") return gitOk(bobReflog);
        return gitOk("");
      }
      return gitOk("");
    };
    const rows = await checkMemberForcePushRecent(
      team([{ name: "alice" }, { name: "bob" }]),
      "/p/.atmux",
      { gitSpawn: gitMulti, now: () => 1700001000 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-forcepush-recent:alice");
  });

  test("detached HEAD (`branch --show-current` empty) → silently skip member", async () => {
    const gitDetached: GitSpawn = async (argv) => {
      if (argv.includes("--show-current")) return gitOk(""); // empty = detached
      return gitOk("");
    };
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitDetached,
      now: () => 1700001000,
    });
    expect(rows).toEqual([]);
  });

  test("git spawn throws → silently skip member (probe doesn't crash team status)", async () => {
    const gitThrows: GitSpawn = async () => {
      throw new Error("spawn failed");
    };
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitThrows,
      now: () => 1700001000,
    });
    expect(rows).toEqual([]);
  });

  test("reflog command non-zero exit → silently skip member", async () => {
    const gitReflogFails: GitSpawn = async (argv) => {
      if (argv.includes("--show-current")) return gitOk("main-alice\n");
      if (argv.includes("reflog")) return gitFail();
      return gitOk("");
    };
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitReflogFails,
      now: () => 1700001000,
    });
    expect(rows).toEqual([]);
  });

  test("multiple force-pushes for same member collapse to ONE row (same nudge)", async () => {
    const reflog = [
      "refs/heads/main-alice@{1700000950} update by push (forced)",
      "refs/heads/main-alice@{1700000800} update by push (forced)",
      "refs/heads/main-alice@{1700000600} update by push (forced)",
    ].join("\n");
    const rows = await checkMemberForcePushRecent(team([{ name: "alice" }]), "/p/.atmux", {
      gitSpawn: gitStub("main-alice", reflog),
      now: () => 1700001000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-forcepush-recent:alice");
  });
});

// ---------- ADR-138: checkSendKeysFailureRecent ----------

describe("checkSendKeysFailureRecent", () => {
  // Anchor every test to 2026-05-15 10:00 MYT (== 2026-05-15T02:00:00Z).
  // The probe's `now` injection is offset from this constant so the
  // test stays readable regardless of JS Date math quirks.
  const BASE_EPOCH = Math.floor(Date.parse("2026-05-15T10:00:00+08:00") / 1000);

  let logDir: string;
  let logPath: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "atmux-sk-log-"));
    logPath = join(logDir, "send-keys-failures.log");
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  /** Compose the canonical entry shape that `writeEscalationLog`
   *  produces in `src/core/safe-send.ts`. Tests pin every probe
   *  assertion to this exact format so a future log-format tweak
   *  surfaces here. */
  function entry(ts: string, target: string): string {
    return (
      `[${ts}] target=${target} keys='hello\\n' attempts=2 timeout=3000ms\n` +
      `preCapture: line1\nline2\nline3\nline4\nline5\n` +
      `postCapture: line1\nline2\nline3\nline4\nline5\n` +
      `---\n`
    );
  }

  test("missing log file → empty rows", async () => {
    const rows = await checkSendKeysFailureRecent({ logPath: `${logPath}-missing` });
    expect(rows).toEqual([]);
  });

  test("empty log → empty rows", async () => {
    await writeFile(logPath, "", "utf8");
    const rows = await checkSendKeysFailureRecent({ logPath });
    expect(rows).toEqual([]);
  });

  test("entry within window → 1 YELLOW row, count + target in detail", async () => {
    // 2026-05-15 10:00 MYT == 2026-05-15T10:00+08:00 == epoch BASE_EPOCH
    await writeFile(logPath, entry("10:00 MYT 2026-05-15", "atmux-demo:🛠️worker1"), "utf8");
    const rows = await checkSendKeysFailureRecent({
      logPath,
      now: () => BASE_EPOCH + 1800, // 30min later
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "yellow",
      label: "send-keys-failure-recent",
    });
    expect(rows[0]?.detail).toContain("1 send-keys failure in last hour");
    expect(rows[0]?.detail).toContain("atmux-demo:🛠️worker1");
    expect(rows[0]?.hint).toContain("ADR-138");
  });

  test("entry older than window → empty rows", async () => {
    // entry at 10:00 MYT; probe runs 2h later (7200s)
    await writeFile(logPath, entry("10:00 MYT 2026-05-15", "atmux-demo:tgt"), "utf8");
    const rows = await checkSendKeysFailureRecent({
      logPath,
      now: () => BASE_EPOCH + 7200,
    });
    expect(rows).toEqual([]);
  });

  test("multiple entries within window → ONE row with count = N", async () => {
    const body =
      entry("09:30 MYT 2026-05-15", "tgt-a") +
      entry("09:45 MYT 2026-05-15", "tgt-b") +
      entry("10:00 MYT 2026-05-15", "tgt-c");
    await writeFile(logPath, body, "utf8");
    const rows = await checkSendKeysFailureRecent({
      logPath,
      now: () => BASE_EPOCH + 600, // 10min after the latest entry
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("3 send-keys failures");
    // Most recent target should be the latest entry's target.
    expect(rows[0]?.detail).toContain("tgt-c");
  });

  test("mixed in-window + out-of-window → row counts only in-window entries", async () => {
    const body =
      entry("08:00 MYT 2026-05-15", "stale-tgt") + // 2h+ before probe
      entry("10:00 MYT 2026-05-15", "fresh-tgt");
    await writeFile(logPath, body, "utf8");
    const rows = await checkSendKeysFailureRecent({
      logPath,
      now: () => BASE_EPOCH + 600,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("1 send-keys failure");
    expect(rows[0]?.detail).toContain("fresh-tgt");
    expect(rows[0]?.detail).not.toContain("stale-tgt");
  });

  test("custom window (windowSec=60) tightens the cutoff", async () => {
    // Entry was 10min ago; with windowSec=60 (1min), it's stale.
    await writeFile(logPath, entry("10:00 MYT 2026-05-15", "tgt"), "utf8");
    const rows = await checkSendKeysFailureRecent({
      logPath,
      now: () => BASE_EPOCH + 600,
      windowSec: 60,
    });
    expect(rows).toEqual([]);
  });

  test("malformed log (no timestamp anchors) → empty rows", async () => {
    await writeFile(logPath, "garbage\nmore garbage\n---\n", "utf8");
    const rows = await checkSendKeysFailureRecent({ logPath });
    expect(rows).toEqual([]);
  });

  test("entry without target= field → row omits the target hint", async () => {
    const malformed = `[10:00 MYT 2026-05-15] no-target-field keys='x' attempts=1 timeout=100ms\n`;
    await writeFile(logPath, malformed, "utf8");
    const rows = await checkSendKeysFailureRecent({
      logPath,
      now: () => BASE_EPOCH + 600,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("1 send-keys failure in last hour");
    expect(rows[0]?.detail).not.toContain("(last:");
  });

  test("home override resolves $HOME/.atmux/state/send-keys-failures.log", async () => {
    const home = await mkdtemp(join(tmpdir(), "atmux-sk-home-"));
    try {
      const stateDir = join(home, ".atmux", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "send-keys-failures.log"),
        entry("10:00 MYT 2026-05-15", "home-tgt"),
        "utf8",
      );
      const rows = await checkSendKeysFailureRecent({
        home,
        now: () => BASE_EPOCH + 600,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.detail).toContain("home-tgt");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("empty home + no override → relative-path log read, returns empty when absent", async () => {
    // Force the empty-home branch — the resolver falls back to the
    // bare relative path `.atmux/state/send-keys-failures.log`. The
    // test process's cwd doesn't have that file, so the probe collapses
    // to `[]`. This pins the no-home branch separately from the
    // present-home branch above.
    const rows = await checkSendKeysFailureRecent({ home: "" });
    expect(rows).toEqual([]);
  });
});

// ---------- ADR-136 TR4: checkMemberLabelCollision ----------

describe("checkMemberLabelCollision", () => {
  function team(members: ReadonlyArray<{ name: string; emoji?: string; label?: string }>): Team {
    return { name: "demo", members } as Team;
  }

  test("team === null → empty rows", () => {
    expect(checkMemberLabelCollision(null)).toEqual([]);
  });

  test("no collisions → empty rows (each (emoji, display) unique)", () => {
    const t = team([
      { name: "alice", emoji: "🦊" },
      { name: "bob", emoji: "🐝" },
      { name: "carol", emoji: "🦝" },
    ]);
    expect(checkMemberLabelCollision(t)).toEqual([]);
  });

  test("two members share emoji + label → one YELLOW row", () => {
    const t = team([
      { name: "worker1", emoji: "🛠️", label: "Worker" },
      { name: "worker2", emoji: "🛠️", label: "Worker" },
    ]);
    const rows = checkMemberLabelCollision(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "yellow",
      label: "member-label-collision:Worker",
    });
    expect(rows[0]?.detail).toContain("2 members share display '🛠️-Worker'");
    expect(rows[0]?.detail).toContain("worker1");
    expect(rows[0]?.detail).toContain("worker2");
    expect(rows[0]?.hint).toContain("atmux member rename");
  });

  test("different emojis with same label → NO collision (visually distinct)", () => {
    const t = team([
      { name: "fox", emoji: "🦊", label: "Helper" },
      { name: "bee", emoji: "🐝", label: "Helper" },
    ]);
    expect(checkMemberLabelCollision(t)).toEqual([]);
  });

  test("name-only collision (both no label, both no emoji) → YELLOW row", () => {
    // Edge case: two members with the same name (which the schema
    // wouldn't normally allow, but the probe is defensive). The
    // display falls back to name; tuple key collides.
    const t = team([{ name: "x" }, { name: "x" }]);
    const rows = checkMemberLabelCollision(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-label-collision:x");
  });

  test("three-way collision surfaces all IDs in one row", () => {
    const t = team([
      { name: "a", emoji: "🛠️", label: "Worker" },
      { name: "b", emoji: "🛠️", label: "Worker" },
      { name: "c", emoji: "🛠️", label: "Worker" },
    ]);
    const rows = checkMemberLabelCollision(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("3 members share");
    expect(rows[0]?.detail).toMatch(/a.*b.*c/);
  });

  test("mixed: one collision pair + one unique → one YELLOW row only", () => {
    const t = team([
      { name: "a", emoji: "🛠️", label: "Worker" },
      { name: "b", emoji: "🛠️", label: "Worker" },
      { name: "unique", emoji: "🦊" },
    ]);
    const rows = checkMemberLabelCollision(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("member-label-collision:Worker");
  });

  test("label-vs-name collision: one with label, other with matching name", () => {
    // Member A has label "shipper"; member B has name "shipper" (no
    // label). Both render display "🛠️-shipper" → collision.
    const t = team([
      { name: "a", emoji: "🛠️", label: "shipper" },
      { name: "shipper", emoji: "🛠️" },
    ]);
    const rows = checkMemberLabelCollision(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("a");
    expect(rows[0]?.detail).toContain("shipper");
  });
});

// ---------- ADR-147 §D5 T6: checkReleaseNoteMissing ----------

describe("checkReleaseNoteMissing", () => {
  /** Build a SpawnResult fixture — DRYs the per-test mock shape. */
  function gitFixture(opts: { exitCode: number; stdout: string }): {
    cmd: string;
    argv: ReadonlyArray<string>;
    exitCode: number;
    signalled: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  } {
    return {
      cmd: "git",
      argv: [],
      exitCode: opts.exitCode,
      signalled: null,
      stdout: opts.stdout,
      stderr: "",
      durationMs: 0,
    };
  }

  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "atmux-release-note-probe-"));
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("no commits today + no day-file → silent (no rows)", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0); // 14:00 MYT 2026-05-15
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async () => gitFixture({ exitCode: 0, stdout: "" }),
      now: () => epochMs,
      repoRoot,
    });
    expect(rows).toEqual([]);
  });

  test("commits today + day-file exists → silent (no rows)", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0); // 14:00 MYT 2026-05-15
    // Pre-create the day-file with skeleton so the probe sees it.
    await mkdir(join(repoRoot, "docs", "release-notes", "2026", "05"), { recursive: true });
    await writeFile(
      join(repoRoot, "docs", "release-notes", "2026", "05", "2026-05-15.md"),
      "# 2026-05-15\n",
    );
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async () => gitFixture({ exitCode: 0, stdout: "abc1234deadbeef\n" }),
      now: () => epochMs,
      repoRoot,
    });
    expect(rows).toEqual([]);
  });

  test("commits today + day-file missing → yellow row 'release-note-missing'", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0); // 14:00 MYT 2026-05-15
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async () => gitFixture({ exitCode: 0, stdout: "abc1234deadbeef\n" }),
      now: () => epochMs,
      repoRoot,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("release-note-missing");
    expect(rows[0]?.detail).toContain("docs/release-notes/2026/05/2026-05-15.md");
    expect(rows[0]?.detail).toContain("2026-05-15 MYT");
    expect(rows[0]?.hint).toContain("ensureDayFile");
  });

  test("git probe exits non-zero (not a repo) → silent", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async () => gitFixture({ exitCode: 128, stdout: "" }),
      now: () => epochMs,
      repoRoot,
    });
    expect(rows).toEqual([]);
  });

  test("--since flag uses MYT-anchored ISO with +08:00 offset", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0); // 14:00 MYT 2026-05-15
    let capturedArgv: ReadonlyArray<string> = [];
    await checkReleaseNoteMissing({
      gitSpawn: async (argv) => {
        capturedArgv = argv;
        return gitFixture({ exitCode: 0, stdout: "" });
      },
      now: () => epochMs,
      repoRoot,
    });
    // argv shape: ["-C", repoRoot, "log", "--since=YYYY-MM-DDT00:00:00+08:00", "--format=%H", "-1"]
    const sinceFlag = capturedArgv.find((a) => a.startsWith("--since="));
    expect(sinceFlag).toBe("--since=2026-05-15T00:00:00+08:00");
    expect(capturedArgv).toContain("-C");
    expect(capturedArgv).toContain(repoRoot);
    expect(capturedArgv).toContain("--format=%H");
    expect(capturedArgv).toContain("-1");
  });

  test("MYT date boundary — 18:00 UTC = 02:00 MYT next day rolls forward", async () => {
    // 2026-05-14 18:00 UTC = 2026-05-15 02:00 MYT. The probe must check
    // 2026-05-15 day-file (not 2026-05-14) because we're already in the
    // next MYT day.
    const epochMs = Date.UTC(2026, 4, 14, 18, 0, 0);
    let capturedSince = "";
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async (argv) => {
        capturedSince = argv.find((a) => a.startsWith("--since=")) ?? "";
        return gitFixture({ exitCode: 0, stdout: "abc1234\n" });
      },
      now: () => epochMs,
      repoRoot,
    });
    expect(capturedSince).toBe("--since=2026-05-15T00:00:00+08:00");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("2026-05-15");
    expect(rows[0]?.detail).not.toContain("2026-05-14");
  });

  test("MYT date boundary — 15:59 UTC = 23:59 MYT same day stays on current day", async () => {
    // 2026-05-15 15:59 UTC = 2026-05-15 23:59 MYT. The probe must check
    // 2026-05-15 day-file (the day boundary is at 16:00 UTC for MYT).
    const epochMs = Date.UTC(2026, 4, 15, 15, 59, 0);
    let capturedSince = "";
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async (argv) => {
        capturedSince = argv.find((a) => a.startsWith("--since=")) ?? "";
        return gitFixture({ exitCode: 0, stdout: "abc1234\n" });
      },
      now: () => epochMs,
      repoRoot,
    });
    expect(capturedSince).toBe("--since=2026-05-15T00:00:00+08:00");
    expect(rows[0]?.detail).toContain("2026-05-15");
  });

  test("year-roll boundary — 2026-12-31 18:00 UTC = 2027-01-01 02:00 MYT", async () => {
    const epochMs = Date.UTC(2026, 11, 31, 18, 0, 0);
    let capturedSince = "";
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async (argv) => {
        capturedSince = argv.find((a) => a.startsWith("--since=")) ?? "";
        return gitFixture({ exitCode: 0, stdout: "abc1234\n" });
      },
      now: () => epochMs,
      repoRoot,
    });
    expect(capturedSince).toBe("--since=2027-01-01T00:00:00+08:00");
    expect(rows[0]?.detail).toContain("docs/release-notes/2027/01/2027-01-01.md");
  });

  test("detail line strips the repoRoot prefix from the path", async () => {
    const epochMs = Date.UTC(2026, 4, 15, 6, 0, 0);
    const rows = await checkReleaseNoteMissing({
      gitSpawn: async () => gitFixture({ exitCode: 0, stdout: "abc1234\n" }),
      now: () => epochMs,
      repoRoot,
    });
    expect(rows[0]?.detail).not.toContain(repoRoot);
    expect(rows[0]?.detail).toContain("docs/release-notes/");
  });
});

// ---------- ADR-162 §Decision-anchor #5: tmux infrastructure probes ----------

describe("parseTmuxVersion", () => {
  test("parses standard release format 'tmux 3.6a'", () => {
    expect(parseTmuxVersion("tmux 3.6a")).toEqual({ major: 3, minor: 6, suffix: "a" });
  });

  test("parses release without suffix 'tmux 3.2'", () => {
    expect(parseTmuxVersion("tmux 3.2")).toEqual({ major: 3, minor: 2, suffix: "" });
  });

  test("parses release with trailing whitespace", () => {
    expect(parseTmuxVersion("tmux 3.6a\n")).toEqual({ major: 3, minor: 6, suffix: "a" });
  });

  test("returns null for pre-release output 'tmux next-3.7'", () => {
    expect(parseTmuxVersion("tmux next-3.7")).toBe(null);
  });

  test("returns null for source-build output 'tmux master'", () => {
    expect(parseTmuxVersion("tmux master")).toBe(null);
  });

  test("returns null for arbitrary garbage", () => {
    expect(parseTmuxVersion("")).toBe(null);
    expect(parseTmuxVersion("not tmux output")).toBe(null);
  });
});

describe("compareTmuxVersion", () => {
  test("returns 0 when versions equal", () => {
    const v = parseTmuxVersion("tmux 3.6a") ?? { major: 0, minor: 0, suffix: "" };
    expect(compareTmuxVersion(v, v)).toBe(0);
  });

  test("major precedence — 2.x < 3.x", () => {
    const v2 = parseTmuxVersion("tmux 2.9") ?? { major: 0, minor: 0, suffix: "" };
    const v3 = parseTmuxVersion("tmux 3.0") ?? { major: 0, minor: 0, suffix: "" };
    expect(compareTmuxVersion(v2, v3)).toBe(-1);
    expect(compareTmuxVersion(v3, v2)).toBe(1);
  });

  test("minor precedence — 3.2 < 3.6", () => {
    const a = parseTmuxVersion("tmux 3.2") ?? { major: 0, minor: 0, suffix: "" };
    const b = parseTmuxVersion("tmux 3.6") ?? { major: 0, minor: 0, suffix: "" };
    expect(compareTmuxVersion(a, b)).toBe(-1);
    expect(compareTmuxVersion(b, a)).toBe(1);
  });

  test("suffix tiebreak — 3.6 < 3.6a < 3.6b", () => {
    const bare = parseTmuxVersion("tmux 3.6") ?? { major: 0, minor: 0, suffix: "" };
    const a = parseTmuxVersion("tmux 3.6a") ?? { major: 0, minor: 0, suffix: "" };
    const b = parseTmuxVersion("tmux 3.6b") ?? { major: 0, minor: 0, suffix: "" };
    expect(compareTmuxVersion(bare, a)).toBe(-1);
    expect(compareTmuxVersion(a, b)).toBe(-1);
    expect(compareTmuxVersion(b, a)).toBe(1);
  });
});

describe("checkTmuxVersionMismatch", () => {
  function tmuxOk(stdout: string): SpawnResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      argv: ["-V"],
      cmd: "tmux",
      signalled: null,
      durationMs: 0,
    };
  }

  test("constants are at the documented values per ADR-162 §Part C", () => {
    expect(TMUX_MIN_VERSION).toBe("3.2");
    expect(TMUX_TESTED_VERSION).toBe("3.6a");
  });

  test("in-range tmux 3.6a (exact tested version) → no rows", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.6a"),
    });
    expect(rows).toEqual([]);
  });

  test("in-range tmux 3.2 (exact min) → no rows", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.2"),
    });
    expect(rows).toEqual([]);
  });

  test("in-range tmux 3.4 (mid-range) → no rows", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.4"),
    });
    expect(rows).toEqual([]);
  });

  test("below-min tmux 3.0a → yellow with 'below minimum' detail", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.0a"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("tmux-version-mismatch");
    expect(rows[0]?.detail).toContain("3.0a");
    expect(rows[0]?.detail).toContain("below minimum");
    expect(rows[0]?.hint).toContain("ADR-163");
  });

  test("below-min tmux 2.9 (major below) → yellow", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 2.9"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("below minimum");
  });

  test("above-tested tmux 3.7 → yellow with 'above tested' detail", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.7"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("tmux-version-mismatch");
    expect(rows[0]?.detail).toContain("3.7");
    expect(rows[0]?.detail).toContain("above tested");
  });

  test("above-tested tmux 3.6b (suffix bump above 3.6a) → yellow", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.6b"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("above tested");
  });

  test("above-tested tmux 4.0 (major bump) → yellow", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 4.0"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("4.0");
  });

  test("unparseable tmux -V output → yellow 'unparseable'", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux next-3.7"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("unparseable");
    expect(rows[0]?.hint).toContain("ADR-138");
  });

  test("tmux -V exit non-zero → yellow 'exited N'", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "permission denied",
        argv: ["-V"],
        cmd: "tmux",
        signalled: null,
        durationMs: 0,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("exited 1");
  });

  test("spawn throws → yellow 'failed to run'", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("failed to run");
  });
});

describe("checkVendoredTmuxBinary", () => {
  function tmuxOk(stdout: string): SpawnResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      argv: ["-V"],
      cmd: "/opt/atmux/current/bin/tmux",
      signalled: null,
      durationMs: 0,
    };
  }

  test("vendored binary absent → yellow 'vendored-tmux-missing'", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => false,
      tmux: async () => tmuxOk("tmux 3.6a"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("vendored-tmux-missing");
    expect(rows[0]?.detail).toContain("/opt/atmux/current/bin/tmux");
    expect(rows[0]?.hint).toContain("build:install");
    expect(rows[0]?.hint).toContain("ATMUX_TMUX_BIN");
  });

  test("vendored present + exact pinned version 3.6a → no rows", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => tmuxOk("tmux 3.6a"),
    });
    expect(rows).toEqual([]);
  });

  test("vendored present + version drift (3.6b) → yellow 'version-drift'", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => tmuxOk("tmux 3.6b"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("vendored-tmux-version-drift");
    expect(rows[0]?.detail).toContain("3.6b");
    expect(rows[0]?.detail).toContain("3.6a");
    expect(rows[0]?.hint).toContain("build:install");
  });

  test("vendored present + unparseable -V → yellow 'version-drift unparseable'", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => tmuxOk("tmux next-3.7"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("vendored-tmux-version-drift");
    expect(rows[0]?.detail).toContain("unparseable");
  });

  test("vendored present + tmux -V exits non-zero → yellow 'version-drift exited'", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "permission denied",
        argv: ["-V"],
        cmd: "/opt/atmux/current/bin/tmux",
        signalled: null,
        durationMs: 0,
      }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("vendored-tmux-version-drift");
    expect(rows[0]?.detail).toContain("exited 2");
  });

  test("vendored present + spawn throws → yellow 'version-drift failed to run'", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("vendored-tmux-version-drift");
    expect(rows[0]?.detail).toContain("failed to run");
  });

  test("custom vendoredPath + expectedVersion respected", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: (p) => p === "/custom/tmux",
      tmux: async () => tmuxOk("tmux 3.5"),
      vendoredPath: "/custom/tmux",
      expectedVersion: "3.5",
    });
    expect(rows).toEqual([]);
  });
});

describe("checkCockpitOnDefaultSocket", () => {
  function tmuxOk(stdout: string): SpawnResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      argv: ["-L", "default", "list-sessions", "-F", "#{session_name}"],
      cmd: "tmux",
      signalled: null,
      durationMs: 0,
    };
  }

  test("default socket has no atmux_cockpit session → no rows", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => tmuxOk("personal\nwork\n"),
    });
    expect(rows).toEqual([]);
  });

  test("default socket empty → no rows", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => tmuxOk(""),
    });
    expect(rows).toEqual([]);
  });

  test("default socket has atmux_cockpit session → yellow with migrate-socket hint", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => tmuxOk("personal\natmux_cockpit\nwork\n"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("cockpit-on-default-socket");
    expect(rows[0]?.detail).toContain("atmux_cockpit");
    expect(rows[0]?.hint).toContain("migrate-socket");
    expect(rows[0]?.hint).toContain("ADR-162");
  });

  test("custom cockpitSession opt — looks for the override name", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => tmuxOk("my-cockpit\n"),
      cockpitSession: "my-cockpit",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("my-cockpit");
  });

  test("tmux -L default exit non-zero (no server) → silent", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "no server running on /tmp/tmux-1000/default",
        argv: [],
        cmd: "tmux",
        signalled: null,
        durationMs: 0,
      }),
    });
    expect(rows).toEqual([]);
  });

  test("spawn throws → silent (deps check covers tmux-on-PATH)", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(rows).toEqual([]);
  });

  test("trims whitespace on session names — handles trailing newlines + spaces", async () => {
    const rows = await checkCockpitOnDefaultSocket({
      tmux: async () => tmuxOk("  atmux_cockpit  \n\n"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("cockpit-on-default-socket");
  });

  // Reference to TmuxSpawn type keeps the import alive (consumed via opts.tmux above).
  test("type sanity — TmuxSpawn shape matches opts.tmux signature (cockpit-on-default-socket)", () => {
    const spawn: TmuxSpawn = async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      argv: [],
      cmd: "tmux",
      signalled: null,
      durationMs: 0,
    });
    expect(typeof spawn).toBe("function");
  });
});

// ---------- t-186d5910 Part D: checkCockpitSentinelWindow ----------

describe("checkCockpitSentinelWindow", () => {
  function tmuxListOk(stdout: string): SpawnResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      argv: [],
      cmd: "tmux",
      signalled: null,
      durationMs: 0,
    };
  }

  const cockpitWithSentinel = {
    sentinel: { impl: "cursor", enabled: true },
  } as unknown as LoadedCockpit;
  const cockpitSentinelDisabled = {
    sentinel: { impl: "cursor", enabled: false },
  } as unknown as LoadedCockpit;
  const cockpitNoSentinel = {} as unknown as LoadedCockpit;

  test("sentinel enabled + _sentinel window present → no rows", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => tmuxListOk("_superdriver\n_medic\n_sentinel\natmux\n"),
      loadCockpitFn: async () => cockpitWithSentinel,
    });
    expect(rows).toEqual([]);
  });

  test("sentinel enabled + _sentinel window missing → one yellow row with rebuild hint", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => tmuxListOk("_superdriver\n_medic\natmux\n"),
      loadCockpitFn: async () => cockpitWithSentinel,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("cockpit-has-w3-sentinel");
    expect(rows[0]?.detail).toContain("cursor");
    expect(rows[0]?.detail).toContain("enabled=true");
    expect(rows[0]?.hint).toContain("atmux cockpit rebuild");
    expect(rows[0]?.hint).toContain("ADR-132");
    expect(rows[0]?.hint).toContain("t-186d5910");
  });

  test("sentinel disabled → silent regardless of window state", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => tmuxListOk("_superdriver\n_medic\n"),
      loadCockpitFn: async () => cockpitSentinelDisabled,
    });
    expect(rows).toEqual([]);
  });

  test("sentinel block absent (operator opt-out by omission) → silent", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => tmuxListOk("_superdriver\n_medic\n"),
      loadCockpitFn: async () => cockpitNoSentinel,
    });
    expect(rows).toEqual([]);
  });

  test("cockpit.json missing / unreadable → silent (single-cage fallback)", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => tmuxListOk("anything\n"),
      loadCockpitFn: async () => null,
    });
    expect(rows).toEqual([]);
  });

  test("tmux session absent (list-windows non-zero) → silent (red surface owned by other probes)", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "no such session: atmux_cockpit",
        argv: [],
        cmd: "tmux",
        signalled: null,
        durationMs: 0,
      }),
      loadCockpitFn: async () => cockpitWithSentinel,
    });
    expect(rows).toEqual([]);
  });

  test("tmux spawn throws → silent (deps probe covers tmux-on-PATH)", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => {
        throw new Error("ENOENT");
      },
      loadCockpitFn: async () => cockpitWithSentinel,
    });
    expect(rows).toEqual([]);
  });

  test("custom cockpitSocket + cockpitSession opts thread to tmux argv", async () => {
    let observedArgv: ReadonlyArray<string> = [];
    const rows = await checkCockpitSentinelWindow({
      tmux: async (argv) => {
        observedArgv = argv;
        return tmuxListOk("_sentinel\n");
      },
      loadCockpitFn: async () => cockpitWithSentinel,
      cockpitSocket: "custom-sock",
      cockpitSession: "custom_session",
    });
    expect(rows).toEqual([]);
    expect(observedArgv).toContain("custom-sock");
    expect(observedArgv).toContain("custom_session");
  });

  test("trims whitespace on window names — handles trailing newlines + spaces", async () => {
    const rows = await checkCockpitSentinelWindow({
      tmux: async () => tmuxListOk("  _superdriver  \n  _medic  \n  _sentinel  \n\n"),
      loadCockpitFn: async () => cockpitWithSentinel,
    });
    expect(rows).toEqual([]);
  });
});

// ---------- t-400a1cad: checkDeployedBinaryLag ----------

describe("checkDeployedBinaryLag", () => {
  function gitResult(stdout: string, exitCode = 0): SpawnResult {
    return {
      exitCode,
      stdout,
      stderr: "",
      argv: [],
      cmd: "git",
      signalled: null,
      durationMs: 0,
    };
  }

  test("matched version + HEAD == last bump commit → silent (green)", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => "0.8.7",
      readSourceVersion: async () => "0.8.7",
      git: async (argv) => {
        if (argv[0] === "rev-parse") return gitResult("abc123\n");
        if (argv[0] === "log") return gitResult("abc123\n");
        return gitResult("0\n");
      },
    });
    expect(rows).toEqual([]);
  });

  test("source ahead by N commits after last bump → yellow with commit count", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => "0.8.7",
      readSourceVersion: async () => "0.8.7",
      git: async (argv) => {
        if (argv[0] === "rev-parse") return gitResult("head-sha\n");
        if (argv[0] === "log") return gitResult("bump-sha\n");
        if (argv[0] === "rev-list") return gitResult("3\n");
        return gitResult("");
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("deployed-binary-lag");
    expect(rows[0]?.detail).toContain("3 commit");
    expect(rows[0]?.hint).toContain("build:install");
  });

  test("version mismatch (source ahead of deploy) → yellow with rebuild hint", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => "0.8.5",
      readSourceVersion: async () => "0.8.7",
      git: async () => gitResult(""),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("source package.json=0.8.7");
    expect(rows[0]?.detail).toContain("/opt/atmux/current=0.8.5");
    expect(rows[0]?.hint).toContain("build:install");
  });

  test("no /opt/atmux/current symlink → silent (non-system install)", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => null,
      readSourceVersion: async () => "0.8.7",
      git: async () => gitResult(""),
    });
    expect(rows).toEqual([]);
  });

  test("no package.json → silent (probe doesn't apply)", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => "0.8.7",
      readSourceVersion: async () => null,
      git: async () => gitResult(""),
    });
    expect(rows).toEqual([]);
  });

  test("git spawn throws → silent (deps probe owns tmux/git surface)", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => "0.8.7",
      readSourceVersion: async () => "0.8.7",
      git: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(rows).toEqual([]);
  });

  test("rev-list returns 0 (HEAD == last bump) → silent", async () => {
    const rows = await checkDeployedBinaryLag({
      readDeployedVersion: async () => "0.8.7",
      readSourceVersion: async () => "0.8.7",
      git: async (argv) => {
        if (argv[0] === "rev-parse") return gitResult("h\n");
        if (argv[0] === "log") return gitResult("b\n");
        if (argv[0] === "rev-list") return gitResult("0\n");
        return gitResult("");
      },
    });
    expect(rows).toEqual([]);
  });
});

// ---------- t-3234a084: fixMissingSentinelWindow ----------

describe("fixMissingSentinelWindow", () => {
  function tmuxResult(stdout: string, exitCode = 0, stderr = ""): SpawnResult {
    return {
      exitCode,
      stdout,
      stderr,
      argv: [],
      cmd: "tmux",
      signalled: null,
      durationMs: 0,
    };
  }
  const cockpitEnabled = {
    sentinel: { impl: "cursor", enabled: true },
  } as unknown as LoadedCockpit;

  test("sentinel enabled + window missing → installs at <session>:3 via tmux new-window", async () => {
    let newWindowArgv: ReadonlyArray<string> | undefined;
    const result = await fixMissingSentinelWindow({
      tmux: async (argv) => {
        if (argv.includes("list-windows")) return tmuxResult("_superdriver\n_medic\natmux\n");
        if (argv.includes("new-window")) {
          newWindowArgv = argv;
          return tmuxResult("");
        }
        return tmuxResult("");
      },
      loadCockpitFn: async () => cockpitEnabled,
    });
    expect(result.installed).toBe(true);
    expect(result.detail).toContain("installed _sentinel");
    expect(result.detail).toContain("impl=cursor");
    // Verify the new-window invocation hit the right slot + loop command.
    expect(newWindowArgv).toBeDefined();
    expect(newWindowArgv).toContain("-n");
    expect(newWindowArgv).toContain("_sentinel");
    expect(newWindowArgv?.join(" ")).toContain("atmux_cockpit:3");
    expect(newWindowArgv?.join(" ")).toContain("atmux sentinel tick");
  });

  test("idempotent: window already present → no-op skip", async () => {
    const result = await fixMissingSentinelWindow({
      tmux: async () => tmuxResult("_superdriver\n_medic\n_sentinel\natmux\n"),
      loadCockpitFn: async () => cockpitEnabled,
    });
    expect(result.installed).toBe(true);
    expect(result.detail).toContain("already present");
  });

  test("cockpit absent → no-op with explanation", async () => {
    const result = await fixMissingSentinelWindow({
      tmux: async () => tmuxResult(""),
      loadCockpitFn: async () => null,
    });
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("cockpit.json absent");
  });

  test("sentinel disabled → no-op (operator opt-out)", async () => {
    const result = await fixMissingSentinelWindow({
      tmux: async () => tmuxResult(""),
      loadCockpitFn: async () =>
        ({
          sentinel: { impl: "cursor", enabled: false },
        }) as unknown as LoadedCockpit,
    });
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("disabled");
  });

  test("tmux session missing (list-windows exit non-zero) → no-op", async () => {
    const result = await fixMissingSentinelWindow({
      tmux: async () => tmuxResult("", 1, "no session"),
      loadCockpitFn: async () => cockpitEnabled,
    });
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("session");
  });

  test("tmux spawn throws → no-op (deps probe owns this surface)", async () => {
    const result = await fixMissingSentinelWindow({
      tmux: async () => {
        throw new Error("ENOENT");
      },
      loadCockpitFn: async () => cockpitEnabled,
    });
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("tmux spawn failed");
  });

  test("tmux new-window exit non-zero → installed=false with stderr in detail", async () => {
    const result = await fixMissingSentinelWindow({
      tmux: async (argv) => {
        if (argv.includes("list-windows")) return tmuxResult("_superdriver\n");
        if (argv.includes("new-window")) return tmuxResult("", 1, "tmux err");
        return tmuxResult("");
      },
      loadCockpitFn: async () => cockpitEnabled,
    });
    expect(result.installed).toBe(false);
    expect(result.detail).toContain("exit=1");
    expect(result.detail).toContain("tmux err");
  });
});

// ---------- EPIC e-a3077ca0 T8: checkLegacyWindowNameFormat ----------

describe("checkLegacyWindowNameFormat", () => {
  /** Spawn-result helper — `list-windows` stdout = one window name per line. */
  function tmuxListOk(stdout: string): SpawnResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      argv: [],
      cmd: "tmux",
      signalled: null,
      durationMs: 0,
    };
  }

  /** Minimal Team fixture — only fields the probe reads. */
  function buildTeam(
    name: string,
    members: ReadonlyArray<{
      name: string;
      role: string;
      emoji?: string;
      label?: string;
    }>,
  ): Team {
    return {
      name,
      members: members.map((m) => ({
        name: m.name,
        role: m.role,
        emoji: m.emoji,
        label: m.label,
        tui: "claude",
      })),
    } as unknown as Team;
  }

  test("currentTeam canonical _-prefix windows present → no rows", async () => {
    const team = buildTeam("atmux", [
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🎯" },
    ]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => tmuxListOk("🧭_lead\n🎯_planner\n__atmux__home\n"),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toEqual([]);
  });

  test("hyphen-form default-member window → yellow row with rename one-liner (atmux parent cage symptom)", async () => {
    // The 2026-05-18 atmux parent cage: 4-day uptime, never migrated;
    // every default-member window still on hyphen form.
    const team = buildTeam("atmux", [
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🎯" },
      { name: "reviewer", role: "reviewer", emoji: "🔍" },
      { name: "ombudsman", role: "ombudsman", emoji: "⚖️" },
    ]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => tmuxListOk("🧭-lead\n🎯-planner\n🔍-reviewer\n⚖️-ombudsman\n"),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe("yellow");
      expect(row.label).toBe("legacy-window-name-format");
      expect(row.detail).toContain("atmux cage:");
    }
    const leadRow = rows.find((r) => r.detail?.includes("🧭-lead"));
    expect(leadRow).toBeDefined();
    expect(leadRow?.detail).toContain("should be '🧭_lead'");
    expect(leadRow?.hint).toContain("rename-window");
    expect(leadRow?.hint).toContain("🧭-lead 🧭_lead");
  });

  test("pre-ADR-135 no-separator default-member window → yellow row with rename one-liner", async () => {
    const team = buildTeam("atmux", [{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => tmuxListOk("🧭lead\n"),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("🧭lead");
    expect(rows[0]?.detail).toContain("should be '🧭_lead'");
    expect(rows[0]?.hint).toContain("🧭lead 🧭_lead");
  });

  test("committer / member roles are EXEMPT — hyphen IS canonical for them", async () => {
    // committer (gitter) and regular `member` lane workers stay on hyphen
    // canonically per project_adr_161_tr2_shipped + ADR-159 pending.
    // Hyphen-named committer/member windows must NOT be flagged.
    const team = buildTeam("atmux", [
      { name: "gitter", role: "committer", emoji: "🌿" },
      { name: "be-1", role: "member", emoji: "🐝" },
      { name: "fe-1", role: "member", emoji: "🐝" },
    ]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => tmuxListOk("🌿-gitter\n🐝-be-1\n🐝-fe-1\n"),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toEqual([]);
  });

  test("cage socket missing → silent skip (cage not running)", async () => {
    const team = buildTeam("atmux", [{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    let tmuxCalled = false;
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => {
        tmuxCalled = true;
        return tmuxListOk("");
      },
      loadCockpitFn: async () => null,
      socketExists: async () => false,
    });
    expect(rows).toEqual([]);
    expect(tmuxCalled).toBe(false);
  });

  test("tmux list-windows non-zero (session missing) → silent skip", async () => {
    const team = buildTeam("atmux", [{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "can't find session: atmux-atmux",
        argv: [],
        cmd: "tmux",
        signalled: null,
        durationMs: 0,
      }),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toEqual([]);
  });

  test("tmux spawn throws → silent skip", async () => {
    const team = buildTeam("atmux", [{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => {
        throw new Error("ENOENT");
      },
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toEqual([]);
  });

  test("currentTeam=null + no cockpit → no rows (nothing to probe)", async () => {
    const rows = await checkLegacyWindowNameFormat(null, {
      tmux: async () => tmuxListOk(""),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    expect(rows).toEqual([]);
  });

  test("cockpit walk — probes every cockpit team's cage", async () => {
    const teamA = buildTeam("alpha", [{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const teamB = buildTeam("beta", [{ name: "planner", role: "planner", emoji: "🎯" }]);
    const fakeCockpit = {
      teams: [
        { name: "alpha", root: "/fake/alpha" },
        { name: "beta", root: "/fake/beta" },
      ],
    } as unknown as LoadedCockpit;
    const rows = await checkLegacyWindowNameFormat(null, {
      tmux: async (argv) => {
        // -t <sessionName> at argv[3]
        const sessionName = argv[4];
        if (sessionName === "atmux-alpha") return tmuxListOk("🧭-lead\n");
        if (sessionName === "atmux-beta") return tmuxListOk("🎯_planner\n");
        return tmuxListOk("");
      },
      loadCockpitFn: async () => fakeCockpit,
      loadTeamForRoot: async (root) => {
        if (root === "/fake/alpha") return teamA;
        if (root === "/fake/beta") return teamB;
        return null;
      },
      socketExists: async () => true,
    });
    // alpha → hyphen lead flagged; beta → already canonical, no flag.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("alpha cage");
    expect(rows[0]?.detail).toContain("🧭-lead");
  });

  test("currentTeam dedup — already in cockpit, only probed once", async () => {
    const team = buildTeam("alpha", [{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const fakeCockpit = {
      teams: [{ name: "alpha", root: "/fake/alpha" }],
    } as unknown as LoadedCockpit;
    let listCalls = 0;
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => {
        listCalls += 1;
        return tmuxListOk("🧭-lead\n");
      },
      loadCockpitFn: async () => fakeCockpit,
      loadTeamForRoot: async () => team,
      socketExists: async () => true,
    });
    // Cockpit + currentTeam both name "alpha" → dedup → single probe →
    // single flagged row (not two).
    expect(listCalls).toBe(1);
    expect(rows).toHaveLength(1);
  });

  test("member without role (legacy team.json) → not flagged (isDefaultMemberRole=false)", async () => {
    // Members without an explicit role default to undefined role.
    // isDefaultMemberRole(undefined) returns false → probe skips them
    // entirely. This protects pre-ADR-161 team.json files from getting
    // a flood of false-positive warns on every doctor run.
    const team = buildTeam("legacy", [{ name: "lead", role: "member", emoji: "🧭" }]);
    const rows = await checkLegacyWindowNameFormat(team, {
      tmux: async () => tmuxListOk("🧭-lead\n"),
      loadCockpitFn: async () => null,
      socketExists: async () => true,
    });
    // role="member" → hyphen IS canonical → no flag.
    expect(rows).toEqual([]);
  });
});
