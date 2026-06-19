// Unit tests for src/verbs/doctor.ts — the LEAN harness preflight only.
//
// Per ADR-263 §D2 the doctor is slimmed to the tmux-harness probes: deps,
// team.json, TUI-on-PATH, state-dir writability, and tmux version. Every
// former fleet-coordination probe (orphan sessions / cron / webhook /
// merger / honker / cockpit / vendored-tmux / etc.) was deleted in the
// ADR-263 P2 refactor, so the tests that covered them were deleted too.
// This file restores focused coverage for the kept behavior only.
//
// Coverage strategy: pure helpers (parseDoctorArgs, buildReport, firstBin,
// installHint, resolveMemberBin, renderHuman, renderJson, parseTmuxVersion,
// compareTmuxVersion) are tested directly. Per-check fns
// (checkDeps/Team/Tuis/StateDir/TmuxVersionMismatch) are driven against a
// fixture .atmux/ + injected `which`/`tmux` seams. The public verb is driven
// against a fixture team.json with both a runChecks override (focused) and
// the default chain (integration smoke).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { UsageError } from "../../../src/errors.ts";
import type { Team, TeamMember } from "../../../src/schema/team.ts";
import {
  buildReport,
  checkDeps,
  checkStateDir,
  checkTeam,
  checkTmuxVersionMismatch,
  checkTuis,
  compareTmuxVersion,
  type DoctorRow,
  doctor,
  firstBin,
  installHint,
  parseDoctorArgs,
  parseTmuxVersion,
  renderHuman,
  renderJson,
  resolveMemberBin,
  runAllChecks,
  TMUX_MIN_PARSED,
  TMUX_MIN_VERSION,
  TMUX_TESTED_PARSED,
  TMUX_TESTED_VERSION,
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

const REQUIRED_PLUS_OPTIONAL = 6; // 3 required (tmux/jq/git) + 3 optional (curl/bats/shellcheck)

describe("checkDeps", () => {
  test("all required deps found → green rows", () => {
    const which = (cmd: string): string => `/usr/bin/${cmd}`;
    const rows = checkDeps({ which, platform: "linux" });
    const reqRows = rows.filter((r) => /^dep:(tmux|jq|git)$/.test(r.label));
    expect(reqRows).toHaveLength(3);
    expect(reqRows.every((r) => r.status === "green")).toBe(true);
  });

  test("required dep missing → red row with install hint", () => {
    const which = (cmd: string): string | null => (cmd === "jq" ? null : `/usr/bin/${cmd}`);
    const rows = checkDeps({ which, platform: "linux" });
    const jqRow = rows.find((r) => r.label === "dep:jq");
    expect(jqRow?.status).toBe("red");
    expect(jqRow?.detail).toBe("NOT on PATH");
    expect(jqRow?.hint).toContain("apt install jq");
  });

  test("optional dep present → green '(optional)' row", () => {
    const which = (cmd: string): string => `/usr/bin/${cmd}`;
    const rows = checkDeps({ which, platform: "linux" });
    const curlRow = rows.find((r) => r.label === "dep:curl");
    expect(curlRow?.status).toBe("green");
    expect(curlRow?.detail).toContain("(optional)");
  });

  test("optional dep missing → yellow with reason", () => {
    const which = (cmd: string): string | null => (cmd === "curl" ? null : `/usr/bin/${cmd}`);
    const rows = checkDeps({ which, platform: "linux" });
    const curlRow = rows.find((r) => r.label === "dep:curl");
    expect(curlRow?.status).toBe("yellow");
    expect(curlRow?.hint).toContain("needed for update check");
  });

  test("defaults (Bun.which + process.platform) engage when opts omitted", () => {
    // Smoke — the default `which`/`platform` branch executes without
    // throwing. tmux/jq/git presence on the test host is not asserted
    // (CI may lack them); we only assert the row shape is well-formed.
    const rows = checkDeps();
    expect(rows.length).toBe(REQUIRED_PLUS_OPTIONAL);
    expect(rows.every((r) => r.label.startsWith("dep:"))).toBe(true);
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

  test("missing team.json → red 'missing'", async () => {
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("missing");
    expect(rows[0]?.hint).toContain("atmux init");
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

  test("member missing tui → red list of bad names (flat pane list, ADR-263 §D1)", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "x",
        members: [
          { name: "alpha", tui: "claude" },
          { name: "bravo" }, // missing tui — name present, no role needed
        ],
      }),
    );
    const rows = await checkTeam(atmuxDir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("missing name/tui");
    expect(rows[0]?.detail).toContain("bravo");
  });

  test("valid team → green with name + member count", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        members: [{ name: "alpha", tui: "claude" }],
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
    const which = (cmd: string): string | null =>
      cmd === "claude" ? "/usr/local/bin/claude" : null;
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
    expect(rows[0]?.detail).toContain("NOT on PATH");
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
    expect(rows[0]?.detail).toContain("alpha");
  });

  test("only-shell team + default opts → no rows", () => {
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

  test("missing .atmux with missing parent → red 'does not exist'", async () => {
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
    expect(rows[0]?.detail).toContain("writable");
  });

  test("existing .atmux read-only (chmod) → red", async () => {
    // Skip when running as root — root bypasses POSIX ACLs and the
    // write-probe always succeeds, masking the red branch under chmod.
    // The uid-independent variant below covers the same red branch via a
    // file-where-a-dir-is-expected ENOTDIR, so the gate stays satisfied
    // regardless of who runs the suite.
    if (process.getuid?.() === 0) return;
    const ad = join(dir, ".atmux");
    await mkdir(ad, { recursive: true });
    await chmod(ad, 0o500); // r-x only — write probe fails
    const rows = await checkStateDir(ad);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("not writable");
    await chmod(ad, 0o700); // restore for cleanup
  });

  test("path exists but is a file (probe write fails) → red 'not writable'", async () => {
    // Uid-independent red-branch cover: statOrNull sees a non-null entry
    // (the file), so checkStateDir takes the write-probe path; writing
    // `<file>/.doctor-write-probe` fails with ENOTDIR even as root,
    // exercising the catch → red row.
    const notADir = join(dir, "occupied");
    await writeFile(notADir, "x");
    const rows = await checkStateDir(notADir);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.detail).toContain("not writable");
    expect(rows[0]?.hint).toContain("chown");
  });
});

// ---------- renderHuman ----------

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

// ---------- renderJson ----------

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

// ---------- parseTmuxVersion ----------

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

// ---------- compareTmuxVersion ----------

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

// ---------- checkTmuxVersionMismatch ----------

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

  test("pre-parsed bound literals match what parseTmuxVersion produces (maintainer-safety parity)", () => {
    // The version probe uses the hardcoded TMUX_MIN_PARSED / TMUX_TESTED_PARSED
    // literals instead of a never-reached runtime "constant unparseable" guard.
    // This test IS that guard: a malformed string constant or a drifted literal
    // fails here at test time rather than shipping a dead branch.
    expect(parseTmuxVersion(`tmux ${TMUX_MIN_VERSION}`)).toEqual(TMUX_MIN_PARSED);
    expect(parseTmuxVersion(`tmux ${TMUX_TESTED_VERSION}`)).toEqual(TMUX_TESTED_PARSED);
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

  test("below-min tmux 3.0a → yellow with 'below minimum' detail + ADR-138 hint", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.0a"),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("tmux-version-mismatch");
    expect(rows[0]?.detail).toContain("3.0a");
    expect(rows[0]?.detail).toContain("below minimum");
    expect(rows[0]?.hint).toContain("ADR-138");
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

  test("unparseable tmux -V output → yellow 'unparseable' + ADR-138 hint", async () => {
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
    // tuis check is skipped when team is null.
    expect(rows.some((r) => r.label.startsWith("tui:"))).toBe(false);
  });

  test("smoke — when team is present, tuis check runs (shell skipped → no tui row)", async () => {
    await mkdir(atmuxDir, { recursive: true });
    const team: Team = {
      name: "demo",
      members: [{ name: "alpha", tui: "shell" }], // shell skipped → no tui row
    };
    const rows = await runAllChecks(atmuxDir, team);
    expect(rows.some((r) => r.label.startsWith("tui:"))).toBe(false);
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
    await seedTeam([{ name: "alpha", tui: "claude" }]);
    const exit = await doctor(["--team-dir", dir], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "stub", detail: "ok" }],
    });
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("🩺 atmux doctor");
    expect(stderrBuf).toContain("all green");
  });

  test("red report → exit 1", async () => {
    await seedTeam();
    const exit = await doctor(["--team-dir", dir], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "red", label: "fail", detail: "bad" }],
    });
    expect(exit).toBe(1);
    expect(stderrBuf).toContain("1 issue(s)");
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

  test("--fix surfaces the lean-harness no-auto-fix notice (ADR-263 §D4)", async () => {
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "ok" }],
    });
    // Human render still runs (no --quiet) + the deferred notice.
    expect(stderrBuf).toContain("atmux doctor");
    expect(stderrBuf).toContain("no auto-fix actions");
    expect(stderrBuf).toContain("ADR-263 §D4");
  });

  test("--fix + --quiet skips both render and the no-auto-fix notice", async () => {
    await seedTeam();
    await doctor(["--team-dir", dir, "--fix", "--quiet"], {
      stdout,
      stderr,
      runChecks: async () => [{ status: "green", label: "ok" }],
    });
    expect(stderrBuf).toBe("");
  });

  test("malformed team.json doesn't crash; default chain emits red → exit 1", async () => {
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), "{not-json");
    const exit = await doctor(["--team-dir", dir, "--json"], { stdout, stderr });
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
