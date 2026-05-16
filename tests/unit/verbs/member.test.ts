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
  memberRenameInternal,
  parseMemberRenameArgs,
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

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-mem-sock-"));
  const socketPath = join(socketDir, "sock");
  const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-mem-dir-"));
  homeDir = await mkdtemp(join(tmpdir(), "atmux-mem-home-"));
  const team = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(atmuxDir, { recursive: true });
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  const tmux = createTmux({ socketPath, configFile: "/dev/null" });
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
    name: `atmux-${env.team}`,
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

    const result = await runRename(["lead", "--label", "Lead Coordinator", "--socket-path", env.socketPath]);

    expect(result).toEqual({
      exitCode: 0,
      wrote: true,
      renamedWindow: true,
      patchedLeadMarker: false,
    });
    const tj = await readTeamJson();
    expect(tj.members[0]).toMatchObject({ name: "lead", label: "Lead Coordinator", emoji: "🧭" });

    const windows = await env.tmux.window.listWindows(`atmux-${env.team}`);
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

    const result = await runRename(["lead", "--label", "Existing", "--socket-path", env.socketPath]);
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
    await expect(dispatchMemberSubverb(["frobnicate"])).rejects.toThrow(/unknown subverb 'frobnicate'/);
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
});
