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
  CONVENTION_059_LANE_PREFIXES,
  checkIndexedMemberName,
  checkMemberName,
  checkTeamName,
  classifyPaneState,
  decisionsLogPath,
  defaultEmojiForRole,
  detectRateLimit,
  displayMemberName,
  driverInboxPath,
  emojiPoolForRole,
  ensureAtmuxDirs,
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  getTeamName,
  hasQueuedMessages,
  hasTeam,
  inboxDir,
  inboxPathFor,
  isCompacting,
  isContextCleared,
  isMedicInboxKey,
  isMemberWindowName,
  isReservedTeamName,
  kanbanJsonPath,
  laneDisplay,
  laneForName,
  leadOutboxPath,
  loadTeam,
  logsDir,
  MEDIC_INBOX_KEY,
  normalizeMemberName,
  paneIsBusy,
  requireTeam,
  resolveCallerScope,
  resolveExistingWindowName,
  resolveTeamSocket,
  resolveWindowWithRenameShim,
  SUPERDOCTOR_INBOX_KEY,
  sessionAnchorPath,
  stateDir,
  teamJsonPath,
  tryLoadTeam,
  type WindowShimOps,
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

  test("strip-back: cwd inside .atmux/worktrees/<m>/ resolves to canonical (t-62/t-63)", async () => {
    // Simulates the lead-worktree-stub bug: project root has its own
    // `.atmux/`; per-member worktrees live at `<root>/.atmux/worktrees/<m>/`
    // and may carry their own stub `.atmux/`. Verbs run from the
    // worktree subdir MUST resolve to the canonical project-root
    // `.atmux/`, not the worktree stub.
    const root = join(dir, "proj");
    const canonical = join(root, ".atmux");
    const worktreeStub = join(root, ".atmux", "worktrees", "lead", ".atmux");
    await mkdir(canonical, { recursive: true });
    await mkdir(worktreeStub, { recursive: true });
    const leadCwd = join(root, ".atmux", "worktrees", "lead");
    const got = await getAtmuxDir({ env: {}, cwd: leadCwd, stopAt: dir });
    expect(got).toBe(canonical);
  });

  test("strip-back: cwd directly inside .atmux/ also resolves to canonical", async () => {
    // The init-from-inside-.atmux/ footgun (per t-62 + adb0fa7
    // orchd-window guard). Walk MUST find the parent's `.atmux/`, not
    // try to scaffold a nested one.
    const root = join(dir, "proj");
    const canonical = join(root, ".atmux");
    await mkdir(join(canonical, "logs"), { recursive: true });
    const got = await getAtmuxDir({ env: {}, cwd: join(canonical, "logs"), stopAt: dir });
    expect(got).toBe(canonical);
  });

  test("falls back to cwd/.atmux when walk-up exhausted", async () => {
    const lonely = join(dir, "lonely");
    await mkdir(lonely, { recursive: true });
    // t-584b5f37: bound the walk-up to the per-test mkdtemp root so a
    // host-resident `/tmp/.atmux` (left by another atmux invocation on
    // the same machine) doesn't leak into the resolution. Production
    // never sets `stopAt`; the test uses it for hermetic isolation.
    const got = await getAtmuxDir({ env: {}, cwd: lonely, stopAt: dir });
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
      // t-584b5f37: same host-leak-isolation as the sibling test above.
      stopAt: dir,
    });
    // No .atmux exists under <dir>, so falls back to <dir>/.atmux
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
    expect(decisionsLogPath("/x/.atmux")).toBe("/x/.atmux/decisions.md");
    expect(sessionAnchorPath("/x/.atmux")).toBe("/x/.atmux/state/session.txt");
  });
});

describe("isMedicInboxKey", () => {
  test("accepts the canonical key, deprecated alias, and rejects other values", () => {
    expect(isMedicInboxKey(MEDIC_INBOX_KEY)).toBe(true);
    expect(isMedicInboxKey(SUPERDOCTOR_INBOX_KEY)).toBe(true);
    expect(isMedicInboxKey("not-medic")).toBe(false);
    expect(isMedicInboxKey(undefined)).toBe(false);
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
    expect(got).toBe("t");
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
    expect(got).toBe("t");
  });

  test("bare <team> default (e-419553c6 — no atmux- prefix)", async () => {
    const atmuxDir = join(dir, ".atmux");
    await seedTeam(atmuxDir, { name: "foo", members: [] });
    const got = await getSessionName({ dir: atmuxDir, env: {} });
    expect(got).toBe("foo");
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
    expect(got).toBe("preloaded");
  });
});

describe("buildWindowName / isMemberWindowName", () => {
  // ADR-017 / operator decision 2026-05-05: drop the `__<team>__` prefix.
  // ADR-135 §D3: add hyphen separator between emoji and member name.
  // Canonical form: `<emoji>-<member>` when emoji is set, `<member>` when not.

  test("with emoji: <emoji>-<member> (ADR-135 hyphen separator)", () => {
    expect(buildWindowName("alice", "🦊")).toBe("🦊-alice");
  });

  test("without emoji: <member>", () => {
    expect(buildWindowName("alice")).toBe("alice");
  });

  test("empty emoji string treated as absent", () => {
    expect(buildWindowName("alice", "")).toBe("alice");
  });

  test("multi-byte emoji characters preserved (e.g. compound 🗺️)", () => {
    expect(buildWindowName("lead", "🗺️")).toBe("🗺️-lead");
  });

  test("isMemberWindowName: roster match (canonical hyphenated form)", () => {
    const members = [{ name: "alice", emoji: "🦊" }];
    expect(isMemberWindowName("🦊-alice", members)).toBe(true);
  });

  test("ADR-135 deprecation window — isMemberWindowName: roster match (legacy concatenated form)", () => {
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

  // ---------- ADR-136 TR4: label-aware variants ----------

  test("buildWindowName(name, emoji, label): label overrides name for display", () => {
    expect(buildWindowName("alice", "🦊", "Alice the Fox")).toBe("🦊-Alice the Fox");
  });

  test("buildWindowName: undefined / empty label falls back to name", () => {
    expect(buildWindowName("alice", "🦊", undefined)).toBe("🦊-alice");
    expect(buildWindowName("alice", "🦊", "")).toBe("🦊-alice");
  });

  test("buildWindowName: label without emoji renders bare display string", () => {
    expect(buildWindowName("alice", undefined, "Alice")).toBe("Alice");
  });

  test("isMemberWindowName: roster match against renamed member's label", () => {
    const members = [{ name: "alice", emoji: "🦊", label: "Alice Renamed" }];
    expect(isMemberWindowName("🦊-Alice Renamed", members)).toBe(true);
    // Pre-rename ID form no longer matches (the live tmux window
    // carries the new label-derived name).
    expect(isMemberWindowName("🦊-alice", members)).toBe(false);
  });

  test("isMemberWindowName: roster member with label undefined still matches name", () => {
    const members = [{ name: "alice", emoji: "🦊", label: undefined }];
    expect(isMemberWindowName("🦊-alice", members)).toBe(true);
  });

  // ---------- ADR-161 TR2: role-aware `_-prefix` for default members ----------

  test("buildWindowName: default role 'team-lead' renders `_-prefix`", () => {
    expect(buildWindowName("lead", "🧭", undefined, "team-lead")).toBe("🧭_lead");
  });

  test("buildWindowName: default role 'planner' renders `_-prefix`", () => {
    expect(buildWindowName("planner", "🎯", undefined, "planner")).toBe("🎯_planner");
  });

  test("buildWindowName: default role 'reviewer' renders `_-prefix`", () => {
    expect(buildWindowName("reviewer", "🔍", undefined, "reviewer")).toBe("🔍_reviewer");
  });

  test("buildWindowName: default role 'ombudsman' renders `_-prefix`", () => {
    expect(buildWindowName("ombuds", "⚖️", undefined, "ombudsman")).toBe("⚖️_ombuds");
  });

  test("buildWindowName: user-added role 'member' keeps hyphen", () => {
    expect(buildWindowName("up-impl-2", "🦊", undefined, "member")).toBe("🦊-up-impl-2");
  });

  test("buildWindowName: legacy 'gitter' role keeps hyphen (pending ADR-159 rename)", () => {
    expect(buildWindowName("gitter", "🌳", undefined, "gitter")).toBe("🌳-gitter");
  });

  test("buildWindowName: default role + label renders `_-prefix` with label", () => {
    expect(buildWindowName("lead", "🧭", "Chief", "team-lead")).toBe("🧭_Chief");
  });

  test("buildWindowName: role omitted falls through to existing hyphen form (backcompat)", () => {
    expect(buildWindowName("alice", "🦊")).toBe("🦊-alice");
    expect(buildWindowName("alice", "🦊", "Alice")).toBe("🦊-Alice");
  });

  test("buildWindowName: default role without emoji renders bare display (no prefix)", () => {
    expect(buildWindowName("lead", undefined, undefined, "team-lead")).toBe("lead");
    expect(buildWindowName("lead", "", undefined, "team-lead")).toBe("lead");
  });

  test("isMemberWindowName: matches default-role `_-prefix` form", () => {
    const members = [{ name: "lead", emoji: "🧭", label: undefined, role: "team-lead" }];
    expect(isMemberWindowName("🧭_lead", members)).toBe(true);
  });

  test("isMemberWindowName: matches legacy hyphen form for default-role member (migration window)", () => {
    const members = [{ name: "lead", emoji: "🧭", label: undefined, role: "team-lead" }];
    // Pre-ADR-161 teams have default members on hyphen; the matcher
    // must accept both shapes during the deprecation window so
    // already-spawned panes route correctly until reconcile renames.
    expect(isMemberWindowName("🧭-lead", members)).toBe(true);
  });

  test("isMemberWindowName: matches user-added member with hyphen form", () => {
    const members = [{ name: "alice", emoji: "🦊", label: undefined, role: "member" }];
    expect(isMemberWindowName("🦊-alice", members)).toBe(true);
    expect(isMemberWindowName("🦊_alice", members)).toBe(false);
  });
});

// ---------- ADR-136 TR4: displayMemberName ----------

describe("displayMemberName", () => {
  test("returns label when set + non-empty", () => {
    expect(displayMemberName({ name: "alice", label: "Alice Renamed" })).toBe("Alice Renamed");
  });

  test("falls back to name when label undefined", () => {
    expect(displayMemberName({ name: "alice" })).toBe("alice");
  });

  test("falls back to name when label is empty string", () => {
    expect(displayMemberName({ name: "alice", label: "" })).toBe("alice");
  });

  test("accepts free-form Unicode in label (the schema does the validation)", () => {
    expect(displayMemberName({ name: "alice", label: "アリス" })).toBe("アリス");
    expect(displayMemberName({ name: "alice", label: "Alice the 🦊" })).toBe("Alice the 🦊");
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

describe("getDefaultSocket (R-2 lift from verbs/start.ts)", () => {
  test("returns /tmp/atmux-<team>/sock — bash cage convention", () => {
    expect(getDefaultSocket("atmux")).toBe("/tmp/atmux-atmux/sock");
    expect(getDefaultSocket("unum")).toBe("/tmp/atmux-unum/sock");
    expect(getDefaultSocket("ifca_aux")).toBe("/tmp/atmux-ifca_aux/sock");
  });
});

describe("resolveTeamSocket (t-add5976a — read-side tmuxTmpdir honour)", () => {
  test("tmuxTmpdir set → <tmuxTmpdir>/tmux-<uid>/default", () => {
    const got = resolveTeamSocket(
      { name: "atmux", tmuxTmpdir: "/tmp/atmux-tmux_atmux" },
      { uid: 1000 },
    );
    expect(got).toBe("/tmp/atmux-tmux_atmux/tmux-1000/default");
  });

  test("project-local .atmux/tmux variant — the bug-trigger path", () => {
    // Repro of the live [down] false-positive: a team started under a
    // tmpdir-honouring path with `team.tmuxTmpdir = <project>/.atmux/tmux`.
    // Pre-fix the resolver returned /tmp/atmux-<team>/sock and status
    // probed a non-existent socket → [down]. Post-fix it follows the
    // configured tmpdir.
    const got = resolveTeamSocket(
      { name: "atmux", tmuxTmpdir: "/root/work/src/atmux/.atmux/tmux" },
      { uid: 0 },
    );
    expect(got).toBe("/root/work/src/atmux/.atmux/tmux/tmux-0/default");
  });

  test("tmuxTmpdir unset → canonical /tmp/atmux-<team>/sock fallback", () => {
    expect(resolveTeamSocket({ name: "atmux" }, { uid: 0 })).toBe("/tmp/atmux-atmux/sock");
  });

  test("tmuxTmpdir empty string → canonical fallback (treats '' as unset)", () => {
    expect(resolveTeamSocket({ name: "atmux", tmuxTmpdir: "" }, { uid: 0 })).toBe(
      "/tmp/atmux-atmux/sock",
    );
  });

  test("opts.uid omitted → reads process.getuid()", () => {
    const liveUid = process.getuid?.() ?? 0;
    const got = resolveTeamSocket({ name: "team-x", tmuxTmpdir: "/tmp/foo" });
    expect(got).toBe(`/tmp/foo/tmux-${liveUid}/default`);
  });

  test("hyphen-style and underscore-style cage tmpdirs both round-trip via join()", () => {
    // The three cage variants documented in the resolver comment —
    // `atmux-tmux*` (hyphen), `atmux_tmux_*` (underscore), `.atmux/tmux*`
    // (project-local). All three are passed through join() unchanged so
    // the resolver doesn't sanitise or rewrite operator-chosen tmpdirs.
    expect(resolveTeamSocket({ name: "t", tmuxTmpdir: "/tmp/atmux-tmux_a" }, { uid: 1000 })).toBe(
      "/tmp/atmux-tmux_a/tmux-1000/default",
    );
    expect(resolveTeamSocket({ name: "t", tmuxTmpdir: "/tmp/atmux_tmux_a" }, { uid: 1000 })).toBe(
      "/tmp/atmux_tmux_a/tmux-1000/default",
    );
  });
});

describe("resolveCallerScope (ADR-033 driver-only refuse-gate)", () => {
  test("ATMUX_CALLER_SCOPE=driver → driver", () => {
    expect(resolveCallerScope({ env: { ATMUX_CALLER_SCOPE: "driver" } })).toBe("driver");
  });

  test("ATMUX_CALLER_SCOPE unset → member (fail-secure default)", () => {
    expect(resolveCallerScope({ env: {} })).toBe("member");
  });

  test("ATMUX_CALLER_SCOPE=member → member", () => {
    expect(resolveCallerScope({ env: { ATMUX_CALLER_SCOPE: "member" } })).toBe("member");
  });

  test("ATMUX_CALLER_SCOPE=garbage → member (anything not 'driver' is rejected)", () => {
    expect(resolveCallerScope({ env: { ATMUX_CALLER_SCOPE: "DRIVER" } })).toBe("member");
    expect(resolveCallerScope({ env: { ATMUX_CALLER_SCOPE: "driver " } })).toBe("member");
    expect(resolveCallerScope({ env: { ATMUX_CALLER_SCOPE: "" } })).toBe("member");
  });

  test("no opts → reads live process.env", () => {
    const prior = process.env.ATMUX_CALLER_SCOPE;
    try {
      delete process.env.ATMUX_CALLER_SCOPE;
      expect(resolveCallerScope()).toBe("member");
      process.env.ATMUX_CALLER_SCOPE = "driver";
      expect(resolveCallerScope()).toBe("driver");
    } finally {
      if (prior === undefined) {
        delete process.env.ATMUX_CALLER_SCOPE;
      } else {
        process.env.ATMUX_CALLER_SCOPE = prior;
      }
    }
  });
});

// ---------- CONVENTION-059 — checkIndexedMemberName ----------

describe("checkIndexedMemberName (CONVENTION-059)", () => {
  test("accepts every canonical lane prefix + zero-indexed integer", () => {
    for (const lane of CONVENTION_059_LANE_PREFIXES) {
      expect(checkIndexedMemberName(`${lane}0`)).toBeNull();
      expect(checkIndexedMemberName(`${lane}1`)).toBeNull();
      expect(checkIndexedMemberName(`${lane}10`)).toBeNull();
    }
  });

  test("rejects hyphenated indexed forms (`fe-1` is legacy, not CONVENTION-059)", () => {
    expect(checkIndexedMemberName("fe-1")).not.toBeNull();
    expect(checkIndexedMemberName("be-2")).not.toBeNull();
  });

  test("rejects domain-named members (`eng-mobile`, `whip-impl`)", () => {
    expect(checkIndexedMemberName("eng-mobile")).not.toBeNull();
    expect(checkIndexedMemberName("whip-impl")).not.toBeNull();
    expect(checkIndexedMemberName("parity-cron-impl")).not.toBeNull();
  });

  test("rejects named roles (`lead`, `planner`, `reviewer`, `gitter`)", () => {
    expect(checkIndexedMemberName("lead")).not.toBeNull();
    expect(checkIndexedMemberName("planner")).not.toBeNull();
    expect(checkIndexedMemberName("reviewer")).not.toBeNull();
    expect(checkIndexedMemberName("gitter")).not.toBeNull();
  });

  test("rejects unknown lane prefixes", () => {
    expect(checkIndexedMemberName("frontend0")).not.toBeNull();
    expect(checkIndexedMemberName("backend0")).not.toBeNull();
    expect(checkIndexedMemberName("dev0")).not.toBeNull();
  });

  test("rejects non-numeric index (`feA`, `feX`)", () => {
    expect(checkIndexedMemberName("feA")).not.toBeNull();
    expect(checkIndexedMemberName("feX")).not.toBeNull();
  });

  test("rejection reason mentions the regex shape so callers can echo it", () => {
    const reason = checkIndexedMemberName("fe-1");
    expect(reason).not.toBeNull();
    if (reason === null) return;
    expect(reason).toContain("fe-1");
    expect(reason).toContain("CONVENTION-059");
  });

  test("CONVENTION_059_LANE_PREFIXES is the canonical list (regression: don't silently grow)", () => {
    expect([...CONVENTION_059_LANE_PREFIXES]).toEqual([
      "fe",
      "be",
      "ops",
      "test",
      "review",
      "db",
      "misc",
    ]);
  });
});

describe("resolveWindowWithRenameShim (EPIC e-a3077ca0 T1)", () => {
  const SESSION = "atmux-test";
  const CANONICAL = "🦦_docs";
  const HYPHEN_FORM = "🦦-docs";
  const NO_SEPARATOR = "🦦docs";

  /** Helper: build a recording `WindowShimOps` with a fixed window-name list. */
  function makeOps(names: ReadonlyArray<string>): {
    ops: WindowShimOps;
    renamed: Array<{ session: string; from: string; to: string }>;
    listCalls: Array<string>;
  } {
    const renamed: Array<{ session: string; from: string; to: string }> = [];
    const listCalls: Array<string> = [];
    const ops: WindowShimOps = {
      async listWindowNames(s) {
        listCalls.push(s);
        return names;
      },
      async renameWindow(s, from, to) {
        renamed.push({ session: s, from, to });
      },
    };
    return { ops, renamed, listCalls };
  }

  // ---- T7 mandated cases ----

  test("(a) canonical exists → return canonical, no rename", async () => {
    const { ops, renamed } = makeOps([CANONICAL]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [HYPHEN_FORM, NO_SEPARATOR],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([]);
  });

  test("(b) hyphen-form exists, canonical absent → rename + return canonical", async () => {
    const { ops, renamed } = makeOps([HYPHEN_FORM]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [HYPHEN_FORM, NO_SEPARATOR],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([{ session: SESSION, from: HYPHEN_FORM, to: CANONICAL }]);
  });

  test("(c) no-separator-form exists, canonical+hyphen absent → rename + return canonical", async () => {
    const { ops, renamed } = makeOps([NO_SEPARATOR]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [HYPHEN_FORM, NO_SEPARATOR],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([{ session: SESSION, from: NO_SEPARATOR, to: CANONICAL }]);
  });

  test("(d) none exist → throws ConfigError with 'no tmux window for <canonical>'", async () => {
    const { ops, renamed } = makeOps(["🐝-fe-1", "🔍_reviewer"]);
    await expect(
      resolveWindowWithRenameShim(SESSION, CANONICAL, [HYPHEN_FORM, NO_SEPARATOR], ops),
    ).rejects.toMatchObject({
      // ConfigError from src/errors.ts: matches the canonical "no tmux window for X"
      // string that callers (rotate / tell-lead / send) grep on.
      message: expect.stringContaining(`no tmux window for ${CANONICAL}`),
    });
    expect(renamed).toEqual([]);
  });

  // ---- T7 defensive (extra-credit) case ----

  test("(e) canonical + hyphen both exist → prefer canonical, no rename", async () => {
    const { ops, renamed } = makeOps([CANONICAL, HYPHEN_FORM]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [HYPHEN_FORM, NO_SEPARATOR],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([]);
  });

  // ---- Gitter carve-out: empty legacyVariants ----

  test("gitter carve-out: empty legacyVariants + canonical present → no rename", async () => {
    const GITTER = "🌿-gitter"; // ADR-159 pending: hyphen stays canonical
    const { ops, renamed } = makeOps([GITTER]);
    const result = await resolveWindowWithRenameShim(SESSION, GITTER, [], ops);
    expect(result).toBe(GITTER);
    expect(renamed).toEqual([]);
  });

  test("gitter carve-out: empty legacyVariants + canonical missing → throws", async () => {
    const GITTER = "🌿-gitter";
    const { ops, renamed } = makeOps(["🐝-fe-1"]);
    await expect(resolveWindowWithRenameShim(SESSION, GITTER, [], ops)).rejects.toMatchObject({
      message: expect.stringContaining(`no tmux window for ${GITTER}`),
    });
    expect(renamed).toEqual([]);
  });

  // ---- legacyVariants ordering: first hit wins ----

  test("legacyVariants iteration: first matching variant wins (caller-supplied order)", async () => {
    // Both legacy forms present — caller orders [HYPHEN_FORM, NO_SEPARATOR];
    // hyphen-form is first match.
    const { ops, renamed } = makeOps([HYPHEN_FORM, NO_SEPARATOR]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [HYPHEN_FORM, NO_SEPARATOR],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([{ session: SESSION, from: HYPHEN_FORM, to: CANONICAL }]);
  });

  test("legacyVariants iteration: reversed order picks no-separator first when both present", async () => {
    const { ops, renamed } = makeOps([HYPHEN_FORM, NO_SEPARATOR]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [NO_SEPARATOR, HYPHEN_FORM],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([{ session: SESSION, from: NO_SEPARATOR, to: CANONICAL }]);
  });

  test("legacyVariants containing canonical itself is skipped, not renamed", async () => {
    // Defensive: caller passes canonical inside legacyVariants by mistake;
    // helper must not call rename-window with from === to.
    const { ops, renamed } = makeOps([CANONICAL]);
    const result = await resolveWindowWithRenameShim(
      SESSION,
      CANONICAL,
      [CANONICAL, HYPHEN_FORM],
      ops,
    );
    expect(result).toBe(CANONICAL);
    expect(renamed).toEqual([]);
  });
});

describe("resolveExistingWindowName", () => {
  const SESSION = "atmux-test";
  const CANONICAL = "🧭_lead";
  const HYPHEN_FORM = "🧭-lead";
  const LEGACY_FORM = "🧭lead";

  function makeListWindowNames(names: ReadonlyArray<string>): {
    listWindowNames: (sessionName: string) => Promise<ReadonlyArray<string>>;
    calls: Array<string>;
  } {
    const calls: Array<string> = [];
    return {
      calls,
      async listWindowNames(sessionName) {
        calls.push(sessionName);
        return names;
      },
    };
  }

  test("canonical hit returns canonical and passes through the session name", async () => {
    const { calls, listWindowNames } = makeListWindowNames([CANONICAL]);
    const got = await resolveExistingWindowName(
      SESSION,
      "lead",
      "🧭",
      undefined,
      listWindowNames,
      "team-lead",
    );
    expect(got).toBe(CANONICAL);
    expect(calls).toEqual([SESSION]);
  });

  test("ADR-135 hyphen hit returns hyphen form when canonical is absent", async () => {
    const { calls, listWindowNames } = makeListWindowNames([HYPHEN_FORM]);
    const got = await resolveExistingWindowName(
      SESSION,
      "lead",
      "🧭",
      undefined,
      listWindowNames,
      "team-lead",
    );
    expect(got).toBe(HYPHEN_FORM);
    expect(calls).toEqual([SESSION]);
  });

  test("legacy hit returns legacy form when canonical and hyphen are absent", async () => {
    const { calls, listWindowNames } = makeListWindowNames([LEGACY_FORM]);
    const got = await resolveExistingWindowName(
      SESSION,
      "lead",
      "🧭",
      undefined,
      listWindowNames,
      "team-lead",
    );
    expect(got).toBe(LEGACY_FORM);
    expect(calls).toEqual([SESSION]);
  });

  test("no hit returns canonical by default and still lists once", async () => {
    const { calls, listWindowNames } = makeListWindowNames(["🐝-alice"]);
    const got = await resolveExistingWindowName(
      SESSION,
      "lead",
      "🧭",
      undefined,
      listWindowNames,
      "team-lead",
    );
    expect(got).toBe(CANONICAL);
    expect(calls).toEqual([SESSION]);
  });

  test("injected rejection falls back to canonical without surfacing the failure", async () => {
    const calls: Array<string> = [];
    const listWindowNames = async (sessionName: string): Promise<ReadonlyArray<string>> => {
      calls.push(sessionName);
      throw new Error("tmux unavailable");
    };
    const got = await resolveExistingWindowName(
      SESSION,
      "lead",
      "🧭",
      undefined,
      listWindowNames,
      "team-lead",
    );
    expect(got).toBe(CANONICAL);
    expect(calls).toEqual([SESSION]);
  });
});
