// Unit tests for src/core/common.ts (ADR-003 / ADR-005 / ADR-006).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDir,
  assertValidMemberName,
  assertValidTeamName,
  buildWindowName,
  checkMemberName,
  checkTeamName,
  classifyPaneState,
  defaultEmojiForRole,
  detectRateLimit,
  driverInboxPath,
  emojiPoolForRole,
  ensureAtmuxDirs,
  getAtmuxDir,
  getSessionName,
  getTeamName,
  hasQueuedMessages,
  hasTeam,
  inboxDir,
  inboxPathFor,
  isCompacting,
  isContextCleared,
  isMemberWindowName,
  isReservedTeamName,
  kanbanJsonPath,
  laneDisplay,
  laneForName,
  leadOutboxPath,
  loadTeam,
  logsDir,
  normalizeMemberName,
  paneIsBusy,
  requireTeam,
  sessionAnchorPath,
  stateDir,
  teamJsonPath,
  tryLoadTeam,
} from "../../../src/core/common.ts";
import { ConfigError, SchemaError, UsageError } from "../../../src/errors.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-common-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- Path resolution ----------

describe("getAtmuxDir", () => {
  test("opts.dir wins over every other source", async () => {
    const got = await getAtmuxDir({
      dir: "/explicit/.atmux",
      teamDir: "/ignored",
      env: { ATMUX_DIR: "/also-ignored", ATMUX_TEAM_DIR: "/also-ignored" },
      cwd: dir,
    });
    expect(got).toBe("/explicit/.atmux");
  });

  test("env.ATMUX_DIR honored when opts.dir absent", async () => {
    const got = await getAtmuxDir({ env: { ATMUX_DIR: "/from/env/.atmux" }, cwd: dir });
    expect(got).toBe("/from/env/.atmux");
  });

  test("opts.teamDir resolves to <root>/.atmux", async () => {
    const got = await getAtmuxDir({ teamDir: "/proj", env: {}, cwd: dir });
    expect(got).toBe("/proj/.atmux");
  });

  test("env.ATMUX_TEAM_DIR resolves to <root>/.atmux", async () => {
    const got = await getAtmuxDir({ env: { ATMUX_TEAM_DIR: "/proj-env" }, cwd: dir });
    expect(got).toBe("/proj-env/.atmux");
  });

  test("trailing slash on teamDir stripped before join", async () => {
    const got = await getAtmuxDir({ teamDir: "/proj/", env: {}, cwd: dir });
    expect(got).toBe("/proj/.atmux");
  });

  test("trailing slash on env.ATMUX_TEAM_DIR stripped", async () => {
    const got = await getAtmuxDir({ env: { ATMUX_TEAM_DIR: "/proj/" }, cwd: dir });
    expect(got).toBe("/proj/.atmux");
  });

  test("walks up from cwd to find .atmux/", async () => {
    const root = join(dir, "project");
    const sub = join(root, "sub", "deep");
    await mkdir(sub, { recursive: true });
    await mkdir(join(root, ".atmux"));
    const got = await getAtmuxDir({ env: {}, cwd: sub });
    expect(got).toBe(join(root, ".atmux"));
  });

  test("falls back to cwd/.atmux when walk-up exhausted", async () => {
    const lonely = join(dir, "lonely");
    await mkdir(lonely, { recursive: true });
    const got = await getAtmuxDir({ env: {}, cwd: lonely });
    expect(got).toBe(join(lonely, ".atmux"));
  });

  test("no opts → uses process.env + process.cwd", async () => {
    // Smoke: the no-arg path is exercised. Result depends on machine state;
    // we just assert that it returns a string ending with `.atmux` (the
    // fallback step always produces that suffix).
    const got = await getAtmuxDir();
    expect(typeof got).toBe("string");
    expect(got).toMatch(/\.atmux$/);
  });

  test("empty env values fall through to next source", async () => {
    const got = await getAtmuxDir({
      env: { ATMUX_DIR: "", ATMUX_TEAM_DIR: "" },
      cwd: dir,
    });
    // No .atmux exists in tmpdir, so falls back to <dir>/.atmux
    expect(got).toBe(join(dir, ".atmux"));
  });
});

describe("path helpers", () => {
  test("teamJsonPath / kanbanJsonPath / inboxDir", () => {
    expect(teamJsonPath("/x/.atmux")).toBe("/x/.atmux/team.json");
    expect(kanbanJsonPath("/x/.atmux")).toBe("/x/.atmux/kanban.json");
    expect(inboxDir("/x/.atmux")).toBe("/x/.atmux/inboxes");
  });

  test("inboxPathFor / logsDir / stateDir / archiveDir", () => {
    expect(inboxPathFor("/x/.atmux", "alice")).toBe("/x/.atmux/inboxes/alice.json");
    expect(logsDir("/x/.atmux")).toBe("/x/.atmux/logs");
    expect(stateDir("/x/.atmux")).toBe("/x/.atmux/state");
    expect(archiveDir("/x/.atmux")).toBe("/x/.atmux/archive");
  });

  test("driverInboxPath / leadOutboxPath / sessionAnchorPath", () => {
    expect(driverInboxPath("/x/.atmux")).toBe("/x/.atmux/driver-inbox.md");
    expect(leadOutboxPath("/x/.atmux")).toBe("/x/.atmux/lead-outbox.md");
    expect(sessionAnchorPath("/x/.atmux")).toBe("/x/.atmux/state/session.txt");
  });
});

describe("ensureAtmuxDirs", () => {
  test("mkdir -p of all standard subdirs", async () => {
    const atmuxDir = join(dir, ".atmux");
    await ensureAtmuxDirs(atmuxDir);
    const { stat } = await import("node:fs/promises");
    expect((await stat(atmuxDir)).isDirectory()).toBe(true);
    expect((await stat(inboxDir(atmuxDir))).isDirectory()).toBe(true);
    expect((await stat(logsDir(atmuxDir))).isDirectory()).toBe(true);
    expect((await stat(stateDir(atmuxDir))).isDirectory()).toBe(true);
    expect((await stat(archiveDir(atmuxDir))).isDirectory()).toBe(true);
  });

  test("idempotent — safe to call twice", async () => {
    const atmuxDir = join(dir, ".atmux");
    await ensureAtmuxDirs(atmuxDir);
    await ensureAtmuxDirs(atmuxDir); // no throw
  });
});

// ---------- Team load ----------

async function seedTeam(atmuxDir: string, team: unknown): Promise<void> {
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(teamJsonPath(atmuxDir), JSON.stringify(team));
}

describe("hasTeam / loadTeam / tryLoadTeam / requireTeam / getTeamName", () => {
  test("hasTeam: false on missing team.json", async () => {
    expect(await hasTeam({ dir: join(dir, ".atmux"), env: {} })).toBe(false);
  });

  test("hasTeam: true once team.json present", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    expect(await hasTeam({ dir: atmuxDir, env: {} })).toBe(true);
  });

  test("loadTeam: parses + returns team", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [{ name: "alice" }] });
    const t = await loadTeam({ dir: atmuxDir, env: {} });
    expect(t.name).toBe("t");
    expect(t.members[0]?.name).toBe("alice");
  });

  test("loadTeam: throws ConfigError on missing file", async () => {
    await expect(loadTeam({ dir: join(dir, ".atmux"), env: {} })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("loadTeam: throws SchemaError on malformed file", async () => {
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(teamJsonPath(atmuxDir), "{not json");
    await expect(loadTeam({ dir: atmuxDir, env: {} })).rejects.toBeInstanceOf(SchemaError);
  });

  test("tryLoadTeam: returns null on missing", async () => {
    const got = await tryLoadTeam({ dir: join(dir, ".atmux"), env: {} });
    expect(got).toBeNull();
  });

  test("tryLoadTeam: returns parsed team when present", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    const got = await tryLoadTeam({ dir: atmuxDir, env: {} });
    expect(got?.name).toBe("t");
  });

  test("requireTeam: returns the parsed team", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "abc", members: [] });
    const t = await requireTeam({ dir: atmuxDir, env: {} });
    expect(t.name).toBe("abc");
  });

  test("getTeamName: convenience accessor", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "concise", members: [] });
    expect(await getTeamName({ dir: atmuxDir, env: {} })).toBe("concise");
  });
});

// ---------- Session / window naming ----------

describe("getSessionName", () => {
  test("env.ATMUX_SESSION wins outright", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    const got = await getSessionName({
      dir: atmuxDir,
      env: { ATMUX_SESSION: "custom-sess" },
    });
    expect(got).toBe("custom-sess");
  });

  test("falls through past empty ATMUX_SESSION env value", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    const got = await getSessionName({ dir: atmuxDir, env: { ATMUX_SESSION: "" } });
    expect(got).toBe("atmux-t");
  });

  test("reads stored session anchor file when present", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    await mkdir(stateDir(atmuxDir), { recursive: true });
    await writeFile(sessionAnchorPath(atmuxDir), "stored-session\n");
    const got = await getSessionName({ dir: atmuxDir, env: {} });
    expect(got).toBe("stored-session");
  });

  test("blank anchor file falls through to default", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    await mkdir(stateDir(atmuxDir), { recursive: true });
    await writeFile(sessionAnchorPath(atmuxDir), "   \n");
    const got = await getSessionName({ dir: atmuxDir, env: {} });
    expect(got).toBe("atmux-t");
  });

  test("composes atmux-<team> default", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "foo", members: [] });
    const got = await getSessionName({ dir: atmuxDir, env: {} });
    expect(got).toBe("atmux-foo");
  });

  test("singleSession: true with no anchor → ConfigError", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [], singleSession: true });
    await expect(getSessionName({ dir: atmuxDir, env: {} })).rejects.toBeInstanceOf(ConfigError);
  });

  test("ATMUX_DRIVER_SESSION set with no anchor → ConfigError", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "t", members: [] });
    await expect(
      getSessionName({ dir: atmuxDir, env: { ATMUX_DRIVER_SESSION: "1" } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("pre-loaded team option skips re-read", async () => {
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    // No team.json on disk — but pre-loaded team supplies the name.
    const got = await getSessionName({
      dir: atmuxDir,
      env: {},
      team: { name: "preloaded", members: [] },
    });
    expect(got).toBe("atmux-preloaded");
  });
});

describe("buildWindowName / isMemberWindowName", () => {
  // ADR-017 / operator decision 2026-05-05: drop the `__<team>__` prefix.
  // New form: `<emoji><member>` when emoji is set, `<member>` when not.

  test("with emoji: <emoji><member>", () => {
    expect(buildWindowName("alice", "🦊")).toBe("🦊alice");
  });

  test("without emoji: <member>", () => {
    expect(buildWindowName("alice")).toBe("alice");
  });

  test("empty emoji string treated as absent", () => {
    expect(buildWindowName("alice", "")).toBe("alice");
  });

  test("multi-byte emoji characters preserved (e.g. compound 🗺️)", () => {
    expect(buildWindowName("lead", "🗺️")).toBe("🗺️lead");
  });

  test("isMemberWindowName: roster match (with emoji)", () => {
    const members = [{ name: "alice", emoji: "🦊" }];
    expect(isMemberWindowName("🦊alice", members)).toBe(true);
  });

  test("isMemberWindowName: roster match (no emoji)", () => {
    const members = [{ name: "lead" }];
    expect(isMemberWindowName("lead", members)).toBe(true);
  });

  test("isMemberWindowName: not in roster → false", () => {
    const members = [{ name: "alice", emoji: "🦊" }];
    expect(isMemberWindowName("bob", members)).toBe(false);
    expect(isMemberWindowName("🦊bob", members)).toBe(false);
    expect(isMemberWindowName("🐝alice", members)).toBe(false); // wrong emoji
  });

  test("isMemberWindowName: pre-amend `__<team>__…` artifacts rejected", () => {
    const members = [{ name: "alice", emoji: "🦊" }];
    expect(isMemberWindowName("__atmux-bun__🦊alice", members)).toBe(false);
    expect(isMemberWindowName("__t__lead", members)).toBe(false);
    // `__<team>__home` placeholder stays out of member-window territory
    expect(isMemberWindowName("__atmux__home", members)).toBe(false);
  });

  test("isMemberWindowName: empty roster → always false", () => {
    expect(isMemberWindowName("anything", [])).toBe(false);
  });
});

// ---------- Name validation ----------

describe("checkTeamName / assertValidTeamName / isReservedTeamName", () => {
  test("valid names pass", () => {
    expect(checkTeamName("atmux-bun")).toBeNull();
    expect(checkTeamName("Unum")).toBeNull();
    expect(checkTeamName("T0")).toBeNull();
    expect(checkTeamName("a")).toBeNull();
  });

  test("empty string is rejected", () => {
    expect(checkTeamName("")).toContain("non-empty");
  });

  test("regex violations rejected", () => {
    expect(checkTeamName("-leading-hyphen")).toMatch(/must match/);
    expect(checkTeamName("has spaces")).toMatch(/must match/);
    expect(checkTeamName("has:colon")).toMatch(/must match/);
    expect(checkTeamName("has.dot")).toMatch(/must match/);
    expect(checkTeamName("a".repeat(64))).toMatch(/must match/);
  });

  test("reserved names rejected case-insensitively", () => {
    expect(isReservedTeamName("default")).toBe(true);
    expect(isReservedTeamName("DEFAULT")).toBe(true);
    expect(isReservedTeamName("system")).toBe(true);
    expect(isReservedTeamName("atmux")).toBe(true);
    expect(isReservedTeamName("tmux")).toBe(true);
    expect(isReservedTeamName("registry")).toBe(true);
    expect(isReservedTeamName("not-reserved")).toBe(false);
    expect(checkTeamName("default")).toMatch(/reserved/);
  });

  test("assertValidTeamName: silent on valid", () => {
    expect(() => assertValidTeamName("ok")).not.toThrow();
  });

  test("assertValidTeamName: throws UsageError on invalid", () => {
    expect(() => assertValidTeamName("")).toThrow(UsageError);
    expect(() => assertValidTeamName("default")).toThrow(UsageError);
  });
});

describe("checkMemberName / assertValidMemberName", () => {
  test("valid names pass", () => {
    expect(checkMemberName("lead")).toBeNull();
    expect(checkMemberName("be-auth")).toBeNull();
    expect(checkMemberName("a")).toBeNull();
    expect(checkMemberName("a_b-c0")).toBeNull();
  });

  test("empty rejected", () => {
    expect(checkMemberName("")).toContain("non-empty");
  });

  test("uppercase rejected (tmux window-name case-collision rule)", () => {
    expect(checkMemberName("Lead")).toMatch(/must match/);
  });

  test("digit-leading rejected", () => {
    expect(checkMemberName("1lead")).toMatch(/must match/);
  });

  test("over-length rejected", () => {
    expect(checkMemberName("a".repeat(32))).toMatch(/must match/);
  });

  test("assertValidMemberName: throws UsageError on invalid", () => {
    expect(() => assertValidMemberName("")).toThrow(UsageError);
  });

  test("assertValidMemberName: silent on valid", () => {
    expect(() => assertValidMemberName("ok")).not.toThrow();
  });
});

describe("normalizeMemberName", () => {
  test("lowercases", () => {
    expect(normalizeMemberName("Lead")).toBe("lead");
  });

  test("collapses whitespace + path separators to hyphen", () => {
    expect(normalizeMemberName("Be Auth")).toBe("be-auth");
    expect(normalizeMemberName("a/b\\c:d.e")).toBe("a-b-c-d-e");
  });

  test("strips disallowed chars", () => {
    expect(normalizeMemberName("alice!@#$%^bob")).toBe("alicebob");
  });

  test("trims leading non-alpha", () => {
    expect(normalizeMemberName("123-lead")).toBe("lead");
    expect(normalizeMemberName("---bob")).toBe("bob");
  });

  test("trims trailing -/_", () => {
    expect(normalizeMemberName("alice-")).toBe("alice");
    expect(normalizeMemberName("alice___")).toBe("alice");
  });

  test("truncates to 31 chars", () => {
    const long = "a".repeat(64);
    expect(normalizeMemberName(long).length).toBeLessThanOrEqual(31);
  });

  test("post-truncate trailing punctuation re-trimmed", () => {
    // Engineered so the 31st char is a hyphen → trailing trim must fire.
    const input = `${"a".repeat(30)}-extra`;
    const got = normalizeMemberName(input);
    expect(got).not.toMatch(/[-_]$/);
  });

  test("empty / unrecoverable input returns empty string", () => {
    expect(normalizeMemberName("")).toBe("");
    expect(normalizeMemberName("!!!")).toBe("");
    expect(normalizeMemberName("123")).toBe("");
  });
});

// ---------- Role / emoji / lane mapping ----------

describe("emojiPoolForRole / defaultEmojiForRole", () => {
  test("known roles return their pool", () => {
    expect(emojiPoolForRole("team-lead").length).toBeGreaterThan(0);
    expect(emojiPoolForRole("reviewer")[0]).toBe("🔍");
  });

  test("unknown role falls back to member pool", () => {
    expect(emojiPoolForRole("nonsense")).toBe(emojiPoolForRole("member"));
  });

  test("defaultEmojiForRole picks first of pool", () => {
    expect(defaultEmojiForRole("team-lead")).toBe("🧭");
    expect(defaultEmojiForRole("reviewer")).toBe("🔍");
    expect(defaultEmojiForRole("planner")).toBe("🗺️");
    expect(defaultEmojiForRole("driver")).toBe("🎮");
    expect(defaultEmojiForRole("gitter")).toBe("🌿");
    expect(defaultEmojiForRole("devops")).toBe("⚙️");
    expect(defaultEmojiForRole("dba")).toBe("🗄️");
    expect(defaultEmojiForRole("unblocker")).toBe("🔓");
    expect(defaultEmojiForRole("member")).toBe("🐝");
  });
});

describe("laneForName", () => {
  test("name prefix wins", () => {
    expect(laneForName("fe-kanban")).toBe("fe");
    expect(laneForName("be-auth")).toBe("be");
    expect(laneForName("db-migrate")).toBe("db");
    expect(laneForName("ops-deploy")).toBe("ops");
    expect(laneForName("test-e2e")).toBe("test");
    expect(laneForName("review-x")).toBe("review");
    expect(laneForName("misc-other")).toBe("misc");
  });

  test("role mapping fallback when name has no lane prefix", () => {
    expect(laneForName("alice", "reviewer")).toBe("review");
    expect(laneForName("alice", "devops")).toBe("ops");
    expect(laneForName("alice", "dba")).toBe("db");
  });

  test("misc as catch-all", () => {
    expect(laneForName("alice")).toBe("misc");
    expect(laneForName("alice", "team-lead")).toBe("misc");
    expect(laneForName("alice", "planner")).toBe("misc");
    expect(laneForName("alice", "unknown")).toBe("misc");
  });

  test("name without hyphen + unmapped role → misc", () => {
    expect(laneForName("ferocious")).toBe("misc"); // no hyphen, "ferocious" not a lane
  });
});

describe("laneDisplay", () => {
  test("uppercases lane code", () => {
    expect(laneDisplay("fe")).toBe("FE");
    expect(laneDisplay("review")).toBe("REVIEW");
  });

  test("undefined / null / empty / 'null' → MISC", () => {
    expect(laneDisplay(undefined)).toBe("MISC");
    expect(laneDisplay(null)).toBe("MISC");
    expect(laneDisplay("")).toBe("MISC");
    expect(laneDisplay("null")).toBe("MISC");
  });
});

// ---------- Pane state detection ----------

describe("paneIsBusy", () => {
  test("matches Esc to interrupt", () => {
    expect(paneIsBusy("...press Esc to interrupt")).toBe(true);
  });

  test("matches token counter", () => {
    expect(paneIsBusy("1234 tokens · esc to interrupt")).toBe(true);
  });

  test("matches thinking with", () => {
    expect(paneIsBusy("✻ thinking with extended thought")).toBe(true);
  });

  test("returns false on idle pane", () => {
    expect(paneIsBusy("$ ")).toBe(false);
    expect(paneIsBusy("")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(paneIsBusy("ESC TO INTERRUPT")).toBe(true);
  });
});

describe("detectRateLimit", () => {
  test("hard wins over soft when both match", () => {
    expect(detectRateLimit("hit your limit · 80% of limit used")).toBe("hard");
  });

  test("hard alone", () => {
    expect(detectRateLimit("you hit your limit")).toBe("hard");
  });

  test("soft via approaching usage limit", () => {
    expect(detectRateLimit("approaching usage limit")).toBe("soft");
  });

  test("soft via percentage indicator (limit)", () => {
    expect(detectRateLimit("65% of limit used")).toBe("soft");
  });

  test("soft via percentage indicator (window)", () => {
    expect(detectRateLimit("90% of window used")).toBe("soft");
  });

  test("none when no signal", () => {
    expect(detectRateLimit("normal pane content")).toBe("none");
    expect(detectRateLimit("")).toBe("none");
  });
});

describe("isCompacting / isContextCleared / hasQueuedMessages", () => {
  test("isCompacting: matches banner", () => {
    expect(isCompacting("Compacting conversation...")).toBe(true);
    expect(isCompacting("nothing here")).toBe(false);
  });

  test("isContextCleared: matches banner", () => {
    expect(isContextCleared("● Context cleared. Ready for your next instruction.")).toBe(true);
    expect(isContextCleared("Context cleared.   Ready for x")).toBe(true);
    expect(isContextCleared("nothing here")).toBe(false);
  });

  test("hasQueuedMessages: matches banner", () => {
    expect(hasQueuedMessages("Press up to edit queued messages")).toBe(true);
    expect(hasQueuedMessages("nothing here")).toBe(false);
  });
});

describe("classifyPaneState", () => {
  test("composite snapshot all-fields populated", () => {
    const state =
      "Compacting conversation\n" +
      "Context cleared. Ready for new\n" +
      "Press up to edit queued messages\n" +
      "approaching usage limit\n" +
      "Esc to interrupt";
    const got = classifyPaneState(state);
    expect(got).toEqual({
      busy: true,
      rateLimit: "soft",
      compacting: true,
      contextCleared: true,
      queuedMessages: true,
    });
  });

  test("all-false snapshot for an idle pane", () => {
    const got = classifyPaneState("normal-shell-prompt");
    expect(got).toEqual({
      busy: false,
      rateLimit: "none",
      compacting: false,
      contextCleared: false,
      queuedMessages: false,
    });
  });

  test("hard rate-limit + busy combination", () => {
    const got = classifyPaneState("you hit your limit; Esc to interrupt");
    expect(got.rateLimit).toBe("hard");
    expect(got.busy).toBe(true);
  });
});
