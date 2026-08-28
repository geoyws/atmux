// Unit tests for src/verbs/member.ts (ADR-136 TR3).
//
// Six observable-behavior cases per the TR3 acceptance criteria:
//   1. happy-path — rename creates label, team.json updated, live tmux
//      rename-window invoked, confirmation printed
//   2. idempotent — same-label rename → no-op (no write, no tmux call)
//   3. member-not-found → ConfigError
//   4. invalid-label (`:` or `.`) → UsageError
//   5. team-stopped (no tmux session) → JSON write succeeds, window
//      rename is skipped with a stderr notice
//   6. lead-rename — when the renamed member's display name matches
//      `lead-window-name.txt`, both team.json AND the marker are
//      updated atomically
//
// Strategy mirrors `tests/unit/verbs/add-member.test.ts` — real tmux
// server on a per-test absolute `socketPath`, real `.atmux/` dir, real
// `~/.claude/teams/<team>/lead-window-name.txt`. The schema's Zod
// re-validate on the updateJson write path is itself a tested layer;
// the cases above prove the verb's wiring.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  dispatchMemberSubverb,
  isValidLabel,
  mapWindowsToMemberIds,
  memberMoveInternal,
  memberRenameInternal,
  memberSortInternal,
  memberSwapInternal,
  parseMemberMoveArgs,
  parseMemberRenameArgs,
  parseMemberSortArgs,
  parseMemberSwapArgs,
} from "../../../src/verbs/member.ts";

interface TestEnv {
  atmuxDir: string;
  socketPath: string;
  tmux: TmuxNamespace;
  team: string;
  /** Override $HOME so the lead-window-name.txt path is sandboxed. */
  home: string;
  stdout: string[];
  stderr: string[];
}

let env: TestEnv;
let socketDir: string;
let homeDir: string;
let priorTmux: string | undefined;
let configPath: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-mem-sock-"));
  const socketPath = join(socketDir, "sock");
  const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-mem-dir-"));
  homeDir = await mkdtemp(join(tmpdir(), "atmux-mem-home-"));
  const team = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(atmuxDir, { recursive: true });
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  // ADR-162 base-index = 1 — production tmux runs under atmux.conf which
  // sets this. Tests load a tiny config so window-index assertions match
  // operator reality (driver at W1, members at W2..N).
  configPath = join(socketDir, "tmux.conf");
  await writeFile(configPath, "set -g base-index 1\n", "utf8");
  const tmux = createTmux({ socketPath, configFile: configPath });
  env = { atmuxDir, socketPath, tmux, team, home: homeDir, stdout: [], stderr: [] };
});

afterEach(async () => {
  try {
    await env.tmux.server.killServer();
  } catch {
    // expected: server may already be gone
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(socketDir, { recursive: true, force: true });
  await rm(env.atmuxDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

interface MinimalMember {
  name: string;
  role?: string;
  emoji?: string;
  label?: string;
}

async function writeTeamJson(members: ReadonlyArray<MinimalMember>): Promise<void> {
  const body = { name: env.team, members };
  await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function readTeamJson(): Promise<{
  members: ReadonlyArray<MinimalMember>;
  [k: string]: unknown;
}> {
  const text = await readFile(join(env.atmuxDir, "team.json"), "utf8");
  return JSON.parse(text);
}

async function startLiveSession(opts: { windowName: string }): Promise<void> {
  await env.tmux.session.newSession({
    name: env.team,
    detached: true,
    windowName: opts.windowName,
  });
}

async function runRename(argv: ReadonlyArray<string>): ReturnType<typeof memberRenameInternal> {
  return await memberRenameInternal(argv, {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir },
    cwd: env.atmuxDir,
    home: env.home,
    stdout: (s) => env.stdout.push(s),
    stderr: (s) => env.stderr.push(s),
  });
}

// ---------- parseMemberRenameArgs ----------

describe("parseMemberRenameArgs", () => {
  test("basic shape", () => {
    expect(parseMemberRenameArgs(["lead", "--label", "Lead Coord"])).toEqual({
      memberId: "lead",
      label: "Lead Coord",
    });
  });

  test("flag order is flexible", () => {
    expect(parseMemberRenameArgs(["--label", "Hello", "alice"])).toMatchObject({
      memberId: "alice",
      label: "Hello",
    });
  });

  test("--socket-path and --team-dir are exposed", () => {
    expect(
      parseMemberRenameArgs([
        "lead",
        "--label",
        "X",
        "--socket-path",
        "/abs/sock",
        "--team-dir",
        "/tmp/x",
      ]),
    ).toEqual({
      memberId: "lead",
      label: "X",
      socketPath: "/abs/sock",
      teamDir: "/tmp/x",
    });
  });

  test("missing member-id throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["--label", "X"])).toThrow(UsageError);
  });

  test("missing --label throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["lead"])).toThrow(UsageError);
  });

  test("--label without value throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["lead", "--label"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["lead", "--bogus", "x", "--label", "y"])).toThrow(
      UsageError,
    );
  });

  test("two positional args throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["a", "b", "--label", "x"])).toThrow(UsageError);
  });

  test("--socket-path empty / missing throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["a", "--label", "x", "--socket-path"])).toThrow(UsageError);
    expect(() => parseMemberRenameArgs(["a", "--label", "x", "--socket-path", ""])).toThrow(
      UsageError,
    );
  });

  test("--team-dir empty / missing throws UsageError", () => {
    expect(() => parseMemberRenameArgs(["a", "--label", "x", "--team-dir"])).toThrow(UsageError);
    expect(() => parseMemberRenameArgs(["a", "--label", "x", "--team-dir", ""])).toThrow(
      UsageError,
    );
  });
});

// ---------- isValidLabel ----------

describe("isValidLabel", () => {
  test("accepts free-form Unicode without separators", () => {
    expect(isValidLabel("Lead Coordinator")).toBe(true);
    expect(isValidLabel("リード")).toBe(true);
    expect(isValidLabel("dash-and_underscore")).toBe(true);
    expect(isValidLabel("")).toBe(true); // empty string is technically valid; schema rejects via min(1) elsewhere
  });

  test("rejects `:` and `.`", () => {
    expect(isValidLabel("bad:label")).toBe(false);
    expect(isValidLabel("bad.label")).toBe(false);
    expect(isValidLabel("a.b:c")).toBe(false);
  });
});

// ---------- memberRename (verb body) ----------

describe("memberRename — happy path", () => {
  test("renames label, mutates team.json, fires tmux rename-window, prints confirmation", async () => {
    await writeTeamJson([{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    // ADR-161 TR2: default-role team-lead renders `_-prefix`.
    await startLiveSession({ windowName: "🧭_lead" });

    const result = await runRename([
      "lead",
      "--label",
      "Lead Coordinator",
      "--socket-path",
      env.socketPath,
    ]);

    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      renamedWindow: true,
      patchedLeadMarker: false,
    });
    const tj = await readTeamJson();
    expect(tj.members[0]).toMatchObject({ name: "lead", label: "Lead Coordinator", emoji: "🧭" });

    const windows = await env.tmux.window.listWindows(env.team);
    const names = windows.map((w) => w.name);
    expect(names).toContain("🧭_Lead Coordinator");
    expect(names).not.toContain("🧭_lead");

    const out = env.stdout.join("");
    expect(out).toContain("'lead'.label = 'Lead Coordinator'");
    expect(out).toContain("🧭_lead → 🧭_Lead Coordinator");
    expect(out).toContain("branch name `geoyws-<sanitize(lead)>`");
  });
});

describe("memberRename — idempotent", () => {
  test("renaming to the same label is a no-op (no write, no tmux call)", async () => {
    await writeTeamJson([{ name: "lead", emoji: "🧭", label: "Existing" }]);
    // No tmux session — would have errored if the verb tried to rename-window.

    const result = await runRename([
      "lead",
      "--label",
      "Existing",
      "--socket-path",
      env.socketPath,
    ]);
    expect(result).toEqual({
      exitCode: 0,
      wrote: false,
      renamedWindow: false,
      patchedLeadMarker: false,
    });
    expect(env.stdout.join("")).toContain("label already matches 'Existing' — no-op");
  });
});

describe("memberRename — member not found", () => {
  test("missing member-id throws ConfigError", async () => {
    await writeTeamJson([{ name: "lead", emoji: "🧭" }]);

    await expect(
      runRename(["ghost", "--label", "Phantom", "--socket-path", env.socketPath]),
    ).rejects.toThrow(ConfigError);
    await expect(
      runRename(["ghost", "--label", "Phantom", "--socket-path", env.socketPath]),
    ).rejects.toThrow(/member 'ghost' not found in team.json/);

    // team.json untouched.
    const tj = await readTeamJson();
    expect(tj.members).toHaveLength(1);
    expect(tj.members[0]).toMatchObject({ name: "lead" });
    expect(tj.members[0]?.label).toBeUndefined();
  });
});

describe("memberRename — invalid label", () => {
  test("label containing ':' throws UsageError (no team.json mutation)", async () => {
    await writeTeamJson([{ name: "lead", emoji: "🧭" }]);

    await expect(
      runRename(["lead", "--label", "bad:label", "--socket-path", env.socketPath]),
    ).rejects.toThrow(UsageError);

    const tj = await readTeamJson();
    expect(tj.members[0]?.label).toBeUndefined();
  });

  test("label containing '.' throws UsageError", async () => {
    await writeTeamJson([{ name: "lead", emoji: "🧭" }]);

    await expect(
      runRename(["lead", "--label", "bad.label", "--socket-path", env.socketPath]),
    ).rejects.toThrow(/cannot contain ':' or '\.'/);
  });
});

describe("memberRename — team stopped (no tmux session)", () => {
  test("JSON write succeeds; tmux rename-window skipped with stderr notice", async () => {
    await writeTeamJson([{ name: "lead", emoji: "🧭" }]);
    // No `startLiveSession` — team session does NOT exist.

    const result = await runRename(["lead", "--label", "Renamed", "--socket-path", env.socketPath]);

    expect(result.wrote).toBe(true);
    expect(result.renamedWindow).toBe(false);

    const tj = await readTeamJson();
    expect(tj.members[0]).toMatchObject({ name: "lead", label: "Renamed" });

    const err = env.stderr.join("");
    expect(err).toMatch(/not running|no live team session/);
  });

  test("singleSession w/o anchor → ConfigError caught + 'no live team session' notice", async () => {
    // singleSession=true + no .atmux/state/session.txt anchor makes
    // getSessionName throw ConfigError; the verb catches it and skips
    // step 4 with the 'no live team session' notice.
    const body = {
      name: env.team,
      singleSession: true,
      members: [{ name: "lead", emoji: "🧭" }],
    };
    await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");

    const result = await runRename(["lead", "--label", "Renamed", "--socket-path", env.socketPath]);

    expect(result.wrote).toBe(true);
    expect(result.renamedWindow).toBe(false);
    expect(env.stderr.join("")).toContain("no live team session");
  });

  test("stale tmux window target → renameWindow failure logged + non-fatal", async () => {
    // hasSession returns true but the window with the expected
    // OLD display name doesn't exist — rename-window must fail,
    // the verb catches it, logs to stderr, and returns success.
    await writeTeamJson([{ name: "lead", emoji: "🧭" }]);
    await startLiveSession({ windowName: "completely-different-window-name" });

    const result = await runRename(["lead", "--label", "Renamed", "--socket-path", env.socketPath]);

    expect(result.wrote).toBe(true);
    expect(result.renamedWindow).toBe(false);
    expect(env.stderr.join("")).toContain("may already be gone");
  });
});

describe("memberRename — lead rename patches lead-window-name.txt", () => {
  test("when lead-window-name.txt matches old display name, both files are updated", async () => {
    await writeTeamJson([{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    // ADR-161 TR2: default-role team-lead renders `_-prefix`.
    await startLiveSession({ windowName: "🧭_lead" });

    // Seed the lead marker with the OLD display name (default-role
    // underscore-prefix per ADR-161 TR2).
    const markerDir = join(env.home, ".claude", "teams", env.team);
    await mkdir(markerDir, { recursive: true });
    const markerPath = join(markerDir, "lead-window-name.txt");
    await writeFile(markerPath, "🧭_lead\n", "utf8");

    const result = await runRename([
      "lead",
      "--label",
      "Coordinator",
      "--socket-path",
      env.socketPath,
    ]);

    expect(result.wrote).toBe(true);
    expect(result.renamedWindow).toBe(true);
    expect(result.patchedLeadMarker).toBe(true);

    const after = (await readFile(markerPath, "utf8")).trim();
    expect(after).toBe("🧭_Coordinator");

    expect(env.stdout.join("")).toContain("lead-window-name.txt updated → 🧭_Coordinator");
  });

  test("when lead-window-name.txt does NOT match (different member is lead), marker is left alone", async () => {
    await writeTeamJson([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", emoji: "🛠️" },
    ]);
    await startLiveSession({ windowName: "🧭_lead" });

    // Lead marker pinned at the *real* lead — renaming a non-lead worker
    // must NOT touch it. ADR-161 TR2 underscore-prefix.
    const markerDir = join(env.home, ".claude", "teams", env.team);
    await mkdir(markerDir, { recursive: true });
    const markerPath = join(markerDir, "lead-window-name.txt");
    await writeFile(markerPath, "🧭_lead\n", "utf8");

    const result = await runRename([
      "worker",
      "--label",
      "Worker Bee",
      "--socket-path",
      env.socketPath,
    ]);

    expect(result.wrote).toBe(true);
    expect(result.patchedLeadMarker).toBe(false);

    const after = (await readFile(markerPath, "utf8")).trim();
    expect(after).toBe("🧭_lead");
  });
});

// ---------- dispatchMemberSubverb ----------

describe("dispatchMemberSubverb", () => {
  test("missing subverb throws UsageError", async () => {
    await expect(dispatchMemberSubverb([])).rejects.toThrow(UsageError);
  });

  test("unknown subverb throws UsageError", async () => {
    await expect(dispatchMemberSubverb(["frobnicate"])).rejects.toThrow(
      /unknown subverb 'frobnicate'/,
    );
  });

  test("rename routes to memberRename", async () => {
    await writeTeamJson([{ name: "lead", emoji: "🧭" }]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const rc = await dispatchMemberSubverb(
      ["rename", "lead", "--label", "X", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
      },
    );
    expect(rc).toBe(0);
    const tj = await readTeamJson();
    expect(tj.members[0]?.label).toBe("X");
  });

  test("move routes to memberMove", async () => {
    await writeTeamJson([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    await startLiveSession({ windowName: "driver" });
    await env.tmux.window.newWindow({
      sessionName: env.team,
      name: "🧭_lead",
      detached: true,
    });
    await env.tmux.window.newWindow({
      sessionName: env.team,
      name: "🛠️-worker",
      detached: true,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const rc = await dispatchMemberSubverb(
      ["move", "worker", "--to", "2", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
      },
    );
    expect(rc).toBe(0);
    expect(stdout.join("")).toContain("member move");
  });

  test("swap routes to memberSwap", async () => {
    await writeTeamJson([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    await startLiveSession({ windowName: "driver" });
    await env.tmux.window.newWindow({
      sessionName: env.team,
      name: "🧭_lead",
      detached: true,
    });
    await env.tmux.window.newWindow({
      sessionName: env.team,
      name: "🛠️-worker",
      detached: true,
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const rc = await dispatchMemberSubverb(
      ["swap", "lead", "worker", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
      },
    );
    expect(rc).toBe(0);
    expect(stdout.join("")).toContain("member swap");
  });

  test("sort routes to memberSort", async () => {
    await writeTeamJson([
      { name: "worker", role: "member", emoji: "🛠️" },
      { name: "lead", role: "team-lead", emoji: "🧭" },
    ]);
    // No live session — sort writes JSON-only on stopped teams.
    const stdout: string[] = [];
    const stderr: string[] = [];
    const rc = await dispatchMemberSubverb(["sort", "--socket-path", env.socketPath], {
      env: { ...process.env, ATMUX_DIR: env.atmuxDir },
      cwd: env.atmuxDir,
      home: env.home,
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    });
    expect(rc).toBe(0);
    expect(stdout.join("")).toContain("member sort");
    const tj = await readTeamJson();
    expect(tj.members.map((m) => m.name)).toEqual(["lead", "worker"]);
  });
});

// ============================================================
// ADR-161 TR3 — atmux member move | swap | sort
// ============================================================

// ---------- parseMemberMoveArgs ----------

describe("parseMemberMoveArgs", () => {
  test("basic shape", () => {
    expect(parseMemberMoveArgs(["lead", "--to", "3"])).toEqual({
      memberId: "lead",
      position: 3,
    });
  });

  test("threads --socket-path and --team-dir", () => {
    expect(
      parseMemberMoveArgs([
        "lead",
        "--to",
        "2",
        "--socket-path",
        "/abs/sock",
        "--team-dir",
        "/tmp/x",
      ]),
    ).toEqual({ memberId: "lead", position: 2, socketPath: "/abs/sock", teamDir: "/tmp/x" });
  });

  test("missing member-id throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["--to", "1"])).toThrow(UsageError);
  });

  test("missing --to throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["lead"])).toThrow(UsageError);
  });

  test("--to with non-integer throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["lead", "--to", "abc"])).toThrow(UsageError);
    expect(() => parseMemberMoveArgs(["lead", "--to", "1.5"])).toThrow(UsageError);
    expect(() => parseMemberMoveArgs(["lead", "--to", "0"])).toThrow(UsageError);
    expect(() => parseMemberMoveArgs(["lead", "--to", "-1"])).toThrow(UsageError);
  });

  test("two positional args throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["a", "b", "--to", "1"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["lead", "--bogus", "x", "--to", "1"])).toThrow(UsageError);
  });

  test("--to with empty / missing value throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["lead", "--to"])).toThrow(/--to requires a value/);
    expect(() => parseMemberMoveArgs(["lead", "--to", ""])).toThrow(/--to requires a value/);
  });

  test("--socket-path empty / missing throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["lead", "--to", "1", "--socket-path"])).toThrow(
      /--socket-path requires a path/,
    );
    expect(() => parseMemberMoveArgs(["lead", "--to", "1", "--socket-path", ""])).toThrow(
      /--socket-path requires a path/,
    );
  });

  test("--team-dir empty / missing throws UsageError", () => {
    expect(() => parseMemberMoveArgs(["lead", "--to", "1", "--team-dir"])).toThrow(
      /--team-dir requires a value/,
    );
    expect(() => parseMemberMoveArgs(["lead", "--to", "1", "--team-dir", ""])).toThrow(
      /--team-dir requires a value/,
    );
  });
});

// ---------- parseMemberSwapArgs ----------

describe("parseMemberSwapArgs", () => {
  test("basic shape", () => {
    expect(parseMemberSwapArgs(["alice", "bob"])).toEqual({ idA: "alice", idB: "bob" });
  });

  test("threads --socket-path / --team-dir", () => {
    expect(
      parseMemberSwapArgs(["alice", "bob", "--socket-path", "/abs/sock", "--team-dir", "/tmp/x"]),
    ).toEqual({ idA: "alice", idB: "bob", socketPath: "/abs/sock", teamDir: "/tmp/x" });
  });

  test("one positional throws UsageError", () => {
    expect(() => parseMemberSwapArgs(["alice"])).toThrow(UsageError);
  });

  test("three positionals throws UsageError", () => {
    expect(() => parseMemberSwapArgs(["a", "b", "c"])).toThrow(UsageError);
  });

  test("same id swap is rejected", () => {
    expect(() => parseMemberSwapArgs(["alice", "alice"])).toThrow(/cannot swap a member with itself/);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseMemberSwapArgs(["alice", "bob", "--bogus"])).toThrow(UsageError);
  });

  test("--socket-path empty / missing throws UsageError", () => {
    expect(() => parseMemberSwapArgs(["a", "b", "--socket-path"])).toThrow(
      /--socket-path requires a path/,
    );
    expect(() => parseMemberSwapArgs(["a", "b", "--socket-path", ""])).toThrow(
      /--socket-path requires a path/,
    );
  });

  test("--team-dir empty / missing throws UsageError", () => {
    expect(() => parseMemberSwapArgs(["a", "b", "--team-dir"])).toThrow(
      /--team-dir requires a value/,
    );
    expect(() => parseMemberSwapArgs(["a", "b", "--team-dir", ""])).toThrow(
      /--team-dir requires a value/,
    );
  });
});

// ---------- parseMemberSortArgs ----------

describe("parseMemberSortArgs", () => {
  test("default is defaultsFirst=true", () => {
    expect(parseMemberSortArgs([])).toEqual({ defaultsFirst: true });
  });

  test("--defaults-first is explicit and idempotent", () => {
    expect(parseMemberSortArgs(["--defaults-first"])).toEqual({ defaultsFirst: true });
  });

  test("threads socket-path / team-dir", () => {
    expect(
      parseMemberSortArgs(["--socket-path", "/abs/sock", "--team-dir", "/tmp/x"]),
    ).toEqual({ defaultsFirst: true, socketPath: "/abs/sock", teamDir: "/tmp/x" });
  });

  test("positional arg throws UsageError", () => {
    expect(() => parseMemberSortArgs(["bogus"])).toThrow(/sort takes no positional args/);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseMemberSortArgs(["--bogus"])).toThrow(UsageError);
  });

  test("--socket-path empty / missing throws UsageError", () => {
    expect(() => parseMemberSortArgs(["--socket-path"])).toThrow(/--socket-path requires a path/);
    expect(() => parseMemberSortArgs(["--socket-path", ""])).toThrow(
      /--socket-path requires a path/,
    );
  });

  test("--team-dir empty / missing throws UsageError", () => {
    expect(() => parseMemberSortArgs(["--team-dir"])).toThrow(/--team-dir requires a value/);
    expect(() => parseMemberSortArgs(["--team-dir", ""])).toThrow(/--team-dir requires a value/);
  });
});

// ---------- Shared helpers for verb-body tests ----------

async function bootMemberTeamWithWindows(
  members: ReadonlyArray<{ name: string; role?: string; emoji: string; label?: string }>,
): Promise<void> {
  await writeTeamJson(members);
  // W1 = driver placeholder. Each member gets its own window via newWindow.
  await startLiveSession({ windowName: "driver" });
  for (const m of members) {
    const role = m.role ?? "member";
    const isDefault = role === "team-lead" || role === "planner" || role === "reviewer" || role === "ombudsman";
    const label = m.label ?? m.name;
    const windowName = `${m.emoji}${isDefault ? "_" : "-"}${label}`;
    await env.tmux.window.newWindow({
      sessionName: env.team,
      name: windowName,
      detached: true,
    });
  }
}

async function liveWindowsByName(): Promise<{ index: number; name: string }[]> {
  return (await env.tmux.window.listWindows(env.team)).map((w) => ({
    index: w.index,
    name: w.name,
  }));
}

// ---------- memberMove ----------

describe("memberMove — happy path", () => {
  test("absolute move shifts window-index + rewrites team.json members[] in new order", async () => {
    await bootMemberTeamWithWindows([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "beta", role: "member", emoji: "📦" },
    ]);
    const before = await liveWindowsByName();
    // Order before: W1=driver, W2=🧭_lead, W3=🛠️-alpha, W4=📦-beta.
    expect(before.map((w) => w.name)).toEqual(["driver", "🧭_lead", "🛠️-alpha", "📦-beta"]);

    const r = await memberMoveInternal(
      ["beta", "--to", "2", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r).toEqual({ exitCode: 0, wrote: true, moved: true });

    const after = await liveWindowsByName();
    // beta moved into W2; lead and alpha shifted right (tmux's standard behavior on move-window).
    const afterNames = after.map((w) => w.name);
    expect(afterNames[0]).toBe("driver"); // W1 untouched
    expect(afterNames).toContain("📦-beta");
    // members[] in team.json is rewritten in window order (defaults + user-added per liveAfter).
    const tj = await readTeamJson();
    const memberOrder = tj.members.map((m) => m.name);
    // beta should now precede lead + alpha (W2 < W3,W4).
    expect(memberOrder.indexOf("beta")).toBeLessThan(memberOrder.indexOf("lead"));
    expect(memberOrder.indexOf("beta")).toBeLessThan(memberOrder.indexOf("alpha"));
  });
});

describe("memberMove — idempotent", () => {
  test("moving to current position is a no-op (no write)", async () => {
    await bootMemberTeamWithWindows([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    // worker is at W3 — move to W3 again.
    const r = await memberMoveInternal(
      ["worker", "--to", "3", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r).toEqual({ exitCode: 0, wrote: false, moved: false });
    expect(env.stdout.join("")).toContain("already at W3 — no-op");
  });
});

describe("memberMove — refusals", () => {
  test("unknown member-id throws ConfigError", async () => {
    await bootMemberTeamWithWindows([{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    await expect(
      memberMoveInternal(["ghost", "--to", "2", "--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("moving to W1 (driver slot) throws UsageError", async () => {
    await bootMemberTeamWithWindows([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    await expect(
      memberMoveInternal(["worker", "--to", "1", "--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      }),
    ).rejects.toThrow(UsageError);
  });

  test("cockpit-context team-name refuses move with UsageError", async () => {
    await writeTeamJson([{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    // Overwrite team.name to the cockpit reserved literal.
    const tjPath = join(env.atmuxDir, "team.json");
    const body = JSON.parse(await readFile(tjPath, "utf8"));
    body.name = "atmux_cockpit";
    await writeFile(tjPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await expect(
      memberMoveInternal(["lead", "--to", "2", "--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      }),
    ).rejects.toThrow(/cockpit context/);
  });

  test("team stopped → no-op with stderr notice (no UsageError)", async () => {
    await writeTeamJson([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    // No startLiveSession — team session does not exist.
    const r = await memberMoveInternal(
      ["worker", "--to", "2", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r).toEqual({ exitCode: 0, wrote: false, moved: false });
    expect(env.stderr.join("")).toContain("team session not running");
  });
});

// ---------- memberSwap ----------

describe("memberSwap — happy path", () => {
  test("swap exchanges two members' window-indices + persists new order", async () => {
    await bootMemberTeamWithWindows([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "beta", role: "member", emoji: "📦" },
    ]);
    const before = await liveWindowsByName();
    expect(before.map((w) => w.name)).toEqual(["driver", "🧭_lead", "🛠️-alpha", "📦-beta"]);

    const r = await memberSwapInternal(
      ["alpha", "beta", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r).toEqual({ exitCode: 0, wrote: true, swapped: true });

    const after = await liveWindowsByName();
    const byIdx = new Map(after.map((w) => [w.index, w.name] as const));
    // alpha was at W3, beta at W4 — after swap, beta at W3, alpha at W4.
    expect(byIdx.get(3)).toBe("📦-beta");
    expect(byIdx.get(4)).toBe("🛠️-alpha");

    const tj = await readTeamJson();
    const memberOrder = tj.members.map((m) => m.name);
    expect(memberOrder.indexOf("beta")).toBeLessThan(memberOrder.indexOf("alpha"));
  });
});

describe("memberSwap — refusals", () => {
  test("unknown id throws ConfigError", async () => {
    await bootMemberTeamWithWindows([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    await expect(
      memberSwapInternal(["lead", "ghost", "--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("team stopped → no-op with stderr notice", async () => {
    await writeTeamJson([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    const r = await memberSwapInternal(
      ["lead", "worker", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.swapped).toBe(false);
    expect(env.stderr.join("")).toContain("team session not running");
  });

  test("cockpit-context team-name refuses swap with UsageError", async () => {
    await writeTeamJson([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ]);
    const tjPath = join(env.atmuxDir, "team.json");
    const body = JSON.parse(await readFile(tjPath, "utf8"));
    body.name = "atmux_cockpit";
    await writeFile(tjPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await expect(
      memberSwapInternal(["lead", "worker", "--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      }),
    ).rejects.toThrow(/cockpit context/);
  });
});

// ---------- memberSort ----------

describe("memberSort — happy path (live session)", () => {
  test("partitions defaults from user-added, defaults follow canonical role order", async () => {
    // Intentionally scrambled order: user-added in front, defaults mixed.
    await bootMemberTeamWithWindows([
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "reviewer", role: "reviewer", emoji: "🔍" },
      { name: "beta", role: "member", emoji: "📦" },
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🗺️" },
    ]);

    const r = await memberSortInternal(
      ["--defaults-first", "--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.wrote).toBe(true);
    expect(r.moveCount).toBeGreaterThan(0);

    const tj = await readTeamJson();
    // Canonical order: team-lead, planner, reviewer (committer/ombudsman absent),
    // then user-added in original relative order (alpha, beta).
    expect(tj.members.map((m) => m.name)).toEqual([
      "lead",
      "planner",
      "reviewer",
      "alpha",
      "beta",
    ]);
  });
});

describe("memberSort — idempotent", () => {
  test("already-sorted team produces zero move-window calls and no write", async () => {
    await bootMemberTeamWithWindows([
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "planner", role: "planner", emoji: "🗺️" },
      { name: "reviewer", role: "reviewer", emoji: "🔍" },
      { name: "alpha", role: "member", emoji: "🛠️" },
    ]);
    const r = await memberSortInternal(
      ["--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r).toEqual({ exitCode: 0, wrote: false, moveCount: 0 });
    expect(env.stdout.join("")).toContain("already in canonical order");
  });
});

describe("memberSort — team stopped", () => {
  test("persists JSON-only when session not live", async () => {
    await writeTeamJson([
      { name: "alpha", role: "member", emoji: "🛠️" },
      { name: "lead", role: "team-lead", emoji: "🧭" },
    ]);
    const r = await memberSortInternal(
      ["--socket-path", env.socketPath],
      {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.wrote).toBe(true);
    expect(r.moveCount).toBe(0);

    const tj = await readTeamJson();
    expect(tj.members.map((m) => m.name)).toEqual(["lead", "alpha"]);
    expect(env.stderr.join("")).toContain("team session not running");
  });
});

describe("memberSort — cockpit refusal", () => {
  test("cockpit-context team-name refuses sort", async () => {
    await writeTeamJson([{ name: "lead", role: "team-lead", emoji: "🧭" }]);
    const tjPath = join(env.atmuxDir, "team.json");
    const body = JSON.parse(await readFile(tjPath, "utf8"));
    body.name = "atmux_cockpit";
    await writeFile(tjPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await expect(
      memberSortInternal(["--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        home: env.home,
        stdout: (s) => env.stdout.push(s),
        stderr: (s) => env.stderr.push(s),
      }),
    ).rejects.toThrow(/cockpit context/);
  });
});

// ---------- mapWindowsToMemberIds ----------

describe("mapWindowsToMemberIds", () => {
  test("drops the driver window and any unknown window names", () => {
    const live = [
      { index: 1, name: "driver" },
      { index: 2, name: "🧭_lead" },
      { index: 3, name: "🛠️-worker" },
      { index: 4, name: "__internal__placeholder" },
    ];
    const members = [
      { name: "lead", role: "team-lead", emoji: "🧭" },
      { name: "worker", role: "member", emoji: "🛠️" },
    ];
    expect(mapWindowsToMemberIds(live, members)).toEqual(["lead", "worker"]);
  });

  test("sorts windows by index before mapping", () => {
    const live = [
      { index: 5, name: "🛠️-b" },
      { index: 2, name: "🧭_a" },
    ];
    const members = [
      { name: "b", role: "member", emoji: "🛠️" },
      { name: "a", role: "team-lead", emoji: "🧭" },
    ];
    expect(mapWindowsToMemberIds(live, members)).toEqual(["a", "b"]);
  });

  test("accepts the legacy no-separator window form", () => {
    const live = [{ index: 2, name: "🧭lead" }];
    const members = [{ name: "lead", role: "team-lead", emoji: "🧭" }];
    expect(mapWindowsToMemberIds(live, members)).toEqual(["lead"]);
  });
});
