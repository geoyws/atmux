// Unit tests for src/verbs/add-member.ts (Phase 2 lifecycle MVP).
// Tracked under the ADR-009 §2 narrowed denominator (`src/verbs/**/*.ts`)
// — 100% line/function/branch coverage required.
//
// Strategy mirrors `tests/unit/verbs/start.test.ts`: spin a real tmux server
// on a per-test absolute socketPath, exercise the verb against a real `.atmux/`
// dir, assert observable side-effects (team.json mutation, inbox file shape,
// tmux window creation when session is up, log lines sunk).
//
// Test isolation (memory `feedback_tmux_test_isolation.md`):
// `createTmux({ socketPath, configFile: "/dev/null" })` — `-S <socketPath>`
// baked into every tmux invocation makes it physically impossible for a
// spawned subprocess to reach the operator's daily-driver tmux server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, SchemaError, UsageError } from "../../../src/errors.ts";
import {
  addMember,
  parseAddMemberArgs,
  pickEmoji,
  resolveAddMemberTmuxConfig,
  resolveEmojiMode,
} from "../../../src/verbs/add-member.ts";

// ---------- Test fixture helpers ----------

interface TestEnv {
  /** Per-test `.atmux/` dir (passed via `ATMUX_DIR`). */
  atmuxDir: string;
  /** Per-test absolute socket path (passed via `--socket-path`). */
  socketPath: string;
  /** Per-test `tmux` namespace pinned to the same socket — used both
   *  to set up live-session preconditions AND to observe spawn results. */
  tmux: TmuxNamespace;
  /** A randomized team name to keep concurrent tests apart. */
  team: string;
  /** Captured logger output (one entry per call). */
  logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[];
  logger: Logger;
}

let env: TestEnv;
let socketDir: string;
let priorTmux: string | undefined;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-am-sock-"));
  const socketPath = join(socketDir, "sock");
  const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-am-dir-"));
  const team = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  const tmux = createTmux({ socketPath, configFile: "/dev/null" });
  const logs: TestEnv["logs"] = [];
  const logger: Logger = {
    log: (msg) => logs.push({ kind: "log", msg }),
    ok: (msg) => logs.push({ kind: "ok", msg }),
    warn: (msg) => logs.push({ kind: "warn", msg }),
    err: (msg) => logs.push({ kind: "err", msg }),
  };
  env = { atmuxDir, socketPath, tmux, team, logs, logger };
});

afterEach(async () => {
  try {
    await env.tmux.server.killServer();
  } catch {
    // expected: server may already be gone (idempotent teardown)
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(socketDir, { recursive: true, force: true });
  await rm(env.atmuxDir, { recursive: true, force: true });
});

/** Write a minimal `team.json` with the given members + flags. */
async function writeTeamJson(opts: {
  members?: ReadonlyArray<{ name: string; role?: string; emoji?: string }>;
  emojisMode?: "static" | "random" | "ai";
  singleSession?: boolean;
}): Promise<void> {
  const body: Record<string, unknown> = {
    name: env.team,
    members: opts.members ?? [],
  };
  if (opts.emojisMode !== undefined) body.emojis = { mode: opts.emojisMode };
  if (opts.singleSession !== undefined) body.singleSession = opts.singleSession;
  await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/** Read team.json back as parsed JSON. Tests use this to assert the
 *  appended member fields without re-implementing the schema. */
async function readTeamJson(): Promise<{
  members: ReadonlyArray<{
    name: string;
    role?: string;
    tui?: string;
    model?: string;
    cwd?: string;
    emoji?: string;
    command?: string;
  }>;
  [k: string]: unknown;
}> {
  const text = await readFile(join(env.atmuxDir, "team.json"), "utf8");
  return JSON.parse(text);
}

/** Default rng — deterministic so emoji picks are reproducible. */
const FIXED_RNG = (): number => 0;

/** Inject the per-test factory + env+cwd into an `addMember` call. */
async function runAdd(
  args: ReadonlyArray<string>,
  extra?: { env?: Record<string, string>; rng?: () => number },
): Promise<number> {
  return await addMember([...args, "--socket-path", env.socketPath], {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir, ...extra?.env },
    cwd: env.atmuxDir,
    logger: env.logger,
    rng: extra?.rng ?? FIXED_RNG,
  });
}

// ---------- parseAddMemberArgs ----------

describe("parseAddMemberArgs", () => {
  test("defaults: role=member tui=claude model=default cwd=<defaultCwd>", () => {
    const got = parseAddMemberArgs(["alice"], "/home/x");
    expect(got).toEqual({
      name: "alice",
      role: "member",
      tui: "claude",
      model: "default",
      cwd: "/home/x",
      command: "",
    });
  });

  test("each flag overrides its respective default", () => {
    const got = parseAddMemberArgs(
      [
        "bob",
        "--role",
        "reviewer",
        "--tui",
        "shell",
        "--model",
        "claude-opus-4-7",
        "--cwd",
        "/proj",
        "--command",
        "wrapper --x",
      ],
      "/home/x",
    );
    expect(got).toEqual({
      name: "bob",
      role: "reviewer",
      tui: "shell",
      model: "claude-opus-4-7",
      cwd: "/proj",
      command: "wrapper --x",
    });
  });

  test("--socket / --socket-path are exposed", () => {
    expect(parseAddMemberArgs(["a", "--socket", "alpha"], "/x")).toMatchObject({ socket: "alpha" });
    expect(parseAddMemberArgs(["a", "--socket-path", "/abs"], "/x")).toMatchObject({
      socketPath: "/abs",
    });
  });

  test("missing name throws UsageError", () => {
    expect(() => parseAddMemberArgs([], "/x")).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseAddMemberArgs(["a", "--bogus", "y"], "/x")).toThrow(UsageError);
  });

  test("two positional args throws UsageError", () => {
    expect(() => parseAddMemberArgs(["a", "b"], "/x")).toThrow(UsageError);
  });

  test.each([
    ["--role"],
    ["--tui"],
    ["--model"],
    ["--cwd"],
    ["--command"],
    ["--socket"],
    ["--socket-path"],
  ])("%s without value throws UsageError", (flag) => {
    expect(() => parseAddMemberArgs(["a", flag], "/x")).toThrow(UsageError);
    // Empty-string value is rejected too
    expect(() => parseAddMemberArgs(["a", flag, ""], "/x")).toThrow(UsageError);
  });

  test("--socket and --socket-path together throws UsageError", () => {
    expect(() => parseAddMemberArgs(["a", "--socket", "x", "--socket-path", "/y"], "/x")).toThrow(
      UsageError,
    );
  });

  test("flags can appear in any order", () => {
    const got = parseAddMemberArgs(["--role", "lead", "alice", "--tui", "kimi"], "/x");
    expect(got).toMatchObject({ name: "alice", role: "lead", tui: "kimi" });
  });
});

// ---------- resolveEmojiMode ----------

describe("resolveEmojiMode", () => {
  test("ATMUX_EMOJI_MODE wins when set + valid", () => {
    expect(resolveEmojiMode({ ATMUX_EMOJI_MODE: "static" }, "random")).toBe("static");
    expect(resolveEmojiMode({ ATMUX_EMOJI_MODE: "ai" }, undefined)).toBe("ai");
  });

  test("env empty / unrecognised → falls through to team", () => {
    expect(resolveEmojiMode({ ATMUX_EMOJI_MODE: "" }, "static")).toBe("static");
    expect(resolveEmojiMode({ ATMUX_EMOJI_MODE: "garbage" }, "static")).toBe("static");
  });

  test("team mode wins when no env override", () => {
    expect(resolveEmojiMode({}, "static")).toBe("static");
    expect(resolveEmojiMode({}, "ai")).toBe("ai");
    expect(resolveEmojiMode({}, "random")).toBe("random");
  });

  test("falls back to 'random' when neither source supplies a recognised mode", () => {
    expect(resolveEmojiMode({}, undefined)).toBe("random");
    expect(resolveEmojiMode({}, "bogus")).toBe("random");
    expect(resolveEmojiMode({ ATMUX_EMOJI_MODE: "bogus" }, "bogus")).toBe("random");
  });
});

// ---------- pickEmoji ----------

describe("pickEmoji", () => {
  test("static returns the role's canonical emoji", () => {
    expect(pickEmoji("team-lead", "static", new Set(), FIXED_RNG)).toBe("🧭");
    expect(pickEmoji("reviewer", "static", new Set(), FIXED_RNG)).toBe("🔍");
    // Unknown role falls back to the member pool head
    expect(pickEmoji("unknown-role", "static", new Set(), FIXED_RNG)).toBe("🐝");
  });

  test("random with rng=0 picks the first not-seen pool entry", () => {
    expect(pickEmoji("team-lead", "random", new Set(), () => 0)).toBe("🧭");
  });

  test("random skips already-seen emojis", () => {
    // team-lead pool head (🧭) is in `seen` → next candidate (🪄) wins
    const got = pickEmoji("team-lead", "random", new Set(["🧭"]), () => 0);
    expect(got).toBe("🪄");
  });

  test("random falls back to full pool when every emoji is seen", () => {
    const fullPool = new Set(["🧭", "🪄", "🎼", "👷", "🗺️"]);
    const got = pickEmoji("team-lead", "random", fullPool, () => 0);
    // First of the full pool wins under rng=0
    expect(got).toBe("🧭");
  });

  test("ai mode delegates to random selection (Phase 2 follow-up for shellout)", () => {
    expect(pickEmoji("team-lead", "ai", new Set(), () => 0)).toBe("🧭");
  });

  test("rng default is Math.random — call form parses + returns from pool", () => {
    const out = pickEmoji("team-lead", "random", new Set());
    expect(["🧭", "🪄", "🎼", "👷", "🗺️"]).toContain(out);
  });

  test("rng near-1.0 picks the last pool entry", () => {
    // rng() returns ~0.999 → idx = floor(0.999 * 5) = 4 (the last entry)
    expect(pickEmoji("team-lead", "random", new Set(), () => 0.999)).toBe("🗺️");
  });
});

// ---------- resolveAddMemberTmuxConfig ----------

describe("resolveAddMemberTmuxConfig", () => {
  test("explicit socketPath wins (overrides tmuxTmpdir)", () => {
    const cfg = resolveAddMemberTmuxConfig(
      { name: "t", tmuxTmpdir: "/proj/.atmux/tmux" },
      {
        name: "a",
        role: "member",
        tui: "claude",
        model: "default",
        cwd: "/x",
        command: "",
        socketPath: "/explicit",
      },
    );
    expect(cfg).toEqual({ socketPath: "/explicit" });
  });

  test("explicit socket wins (overrides tmuxTmpdir, when no socketPath)", () => {
    const cfg = resolveAddMemberTmuxConfig(
      { name: "t", tmuxTmpdir: "/proj/.atmux/tmux" },
      {
        name: "a",
        role: "member",
        tui: "claude",
        model: "default",
        cwd: "/x",
        command: "",
        socket: "named",
      },
    );
    expect(cfg).toEqual({ socket: "named" });
  });

  test("falls back to default socket path when tmuxTmpdir unset", () => {
    const cfg = resolveAddMemberTmuxConfig(
      { name: "alpha" },
      {
        name: "a",
        role: "member",
        tui: "claude",
        model: "default",
        cwd: "/x",
        command: "",
      },
    );
    expect(cfg).toEqual({ socketPath: "/tmp/atmux-alpha/sock" });
  });

  test("t-d0229be5: honours team.tmuxTmpdir on the write side", () => {
    const cfg = resolveAddMemberTmuxConfig(
      { name: "t", tmuxTmpdir: "/proj/.atmux/tmux" },
      {
        name: "a",
        role: "member",
        tui: "claude",
        model: "default",
        cwd: "/x",
        command: "",
      },
    );
    expect("socketPath" in cfg).toBe(true);
    if ("socketPath" in cfg) {
      const uid = process.getuid?.() ?? 0;
      expect(cfg.socketPath).toBe(`/proj/.atmux/tmux/tmux-${uid}/default`);
    }
  });

  test("t-d0229be5: empty-string tmuxTmpdir falls back to canonical socket", () => {
    const cfg = resolveAddMemberTmuxConfig(
      { name: "t", tmuxTmpdir: "" },
      {
        name: "a",
        role: "member",
        tui: "claude",
        model: "default",
        cwd: "/x",
        command: "",
      },
    );
    expect(cfg).toEqual({ socketPath: "/tmp/atmux-t/sock" });
  });
});

// ---------- addMember verb — happy path ----------

describe("addMember — happy path", () => {
  test("appends a new member with the given fields + creates inbox", async () => {
    await writeTeamJson({ emojisMode: "static" });

    const exit = await runAdd(["alpha", "--role", "member", "--tui", "shell", "--cwd", "/tmp"]);
    expect(exit).toBe(0);

    const team = await readTeamJson();
    expect(team.members).toHaveLength(1);
    const m = team.members[0];
    expect(m).toBeDefined();
    expect(m).toMatchObject({
      name: "alpha",
      role: "member",
      tui: "shell",
      cwd: "/tmp",
      model: "default",
      // static mode + member role → first of MEMBER_POOL ("🐝")
      emoji: "🐝",
    });
    expect(m?.command).toBeUndefined();

    // Inbox file primed with bash-shared shape
    const ibText = await readFile(join(env.atmuxDir, "inboxes", "alpha.json"), "utf8");
    expect(ibText).toBe('{"pending":[],"inProgress":[],"done":[]}\n');

    // ok-line about the add was sunk
    expect(env.logs.some((l) => l.kind === "ok" && l.msg.includes("added member"))).toBe(true);
    // Without a live session the start-pointer log line fires
    expect(env.logs.some((l) => l.msg.includes("run 'atmux start'"))).toBe(true);
  });

  test("--command override is persisted on the member entry", async () => {
    await writeTeamJson({ emojisMode: "static" });
    expect(
      await runAdd(["gamma", "--role", "member", "--tui", "claude", "--command", "my-wrapper"]),
    ).toBe(0);
    const team = await readTeamJson();
    expect(team.members[0]?.command).toBe("my-wrapper");
  });

  test("default cwd is the verb's `cwd` opt (parity with bash $PWD)", async () => {
    await writeTeamJson({ emojisMode: "static" });
    expect(await runAdd(["delta"])).toBe(0);
    const team = await readTeamJson();
    expect(team.members[0]?.cwd).toBe(env.atmuxDir);
  });

  test("emoji mode defaults to 'random'; rng=0 picks first not-seen", async () => {
    // Seed with one member already wearing the team-lead canonical emoji
    // so the random pick has to skip the head and choose the second entry.
    await writeTeamJson({
      members: [{ name: "lead", role: "team-lead", emoji: "🧭" }],
    });
    expect(await runAdd(["alpha", "--role", "team-lead"], { rng: () => 0 })).toBe(0);
    const team = await readTeamJson();
    expect(team.members.find((m) => m.name === "alpha")?.emoji).toBe("🪄");
  });

  test("static mode is honoured when ATMUX_EMOJI_MODE=static is set", async () => {
    await writeTeamJson({});
    expect(
      await runAdd(["alpha", "--role", "team-lead"], { env: { ATMUX_EMOJI_MODE: "static" } }),
    ).toBe(0);
    const team = await readTeamJson();
    expect(team.members[0]?.emoji).toBe("🧭");
  });

  test("members with empty / undefined emoji aren't counted in the seen set", async () => {
    await writeTeamJson({
      // Existing members with NO emoji should not block the canonical
      // pick — they're filtered out in step 3 of the verb body.
      members: [{ name: "x", role: "member" }],
      emojisMode: "static",
    });
    expect(await runAdd(["alpha", "--role", "team-lead"])).toBe(0);
    const team = await readTeamJson();
    expect(team.members.find((m) => m.name === "alpha")?.emoji).toBe("🧭");
  });
});

// ---------- addMember verb — refusals ----------

describe("addMember — refusals", () => {
  test("duplicate name throws ConfigError + leaves team.json unchanged", async () => {
    await writeTeamJson({
      members: [{ name: "beta", role: "member", emoji: "🐝" }],
    });
    await expect(runAdd(["beta", "--role", "member", "--tui", "shell"])).rejects.toThrow(
      ConfigError,
    );

    // Team.json untouched
    const team = await readTeamJson();
    expect(team.members).toHaveLength(1);
  });

  test("missing team.json throws ConfigError (loadTeam refusal)", async () => {
    // No writeTeamJson — atmuxDir is empty
    await expect(runAdd(["alpha"])).rejects.toThrow(ConfigError);
  });

  test("malformed team.json throws SchemaError", async () => {
    await writeFile(join(env.atmuxDir, "team.json"), "{not valid json", "utf8");
    await expect(runAdd(["alpha"])).rejects.toThrow(SchemaError);
  });

  test("arg-parse failures bubble through (no team.json read)", async () => {
    await writeTeamJson({});
    await expect(runAdd(["--bogus"])).rejects.toThrow(UsageError);
  });
});

// ---------- addMember verb — spawn path ----------

describe("addMember — spawn path", () => {
  test("with live session: creates the new window and logs spawn", async () => {
    await writeTeamJson({ emojisMode: "static" });
    const session = env.team;
    // Bring a fresh session up at the test socket so add-member can detect it
    await env.tmux.session.newSession({
      name: session,
      windowName: `__${env.team}__home`,
      cwd: env.atmuxDir,
    });
    expect(await runAdd(["alpha", "--role", "team-lead"])).toBe(0);

    // The new window exists under buildWindowName(team, name, emoji)
    const wins = await env.tmux.window.listWindows(session);
    // ADR-017: `<emoji><member>` (no `__<team>__` prefix).
    expect(wins.map((w) => w.name)).toContain("🧭-alpha");

    // log + ok lines fired
    expect(env.logs.some((l) => l.msg.includes("session is up"))).toBe(true);
    expect(
      env.logs.some((l) => l.kind === "ok" && l.msg.startsWith(`spawned alpha in ${session}:`)),
    ).toBe(true);
  });

  test("without live session: logs the start-pointer (skips spawn)", async () => {
    await writeTeamJson({ emojisMode: "static" });
    expect(await runAdd(["alpha"])).toBe(0);
    expect(env.logs.some((l) => l.msg.includes("run 'atmux start'"))).toBe(true);
    // No tmux session created as a side-effect of the verb
    expect(await env.tmux.session.hasSession(env.team)).toBe(false);
  });

  test("hasSession failure on the spawn probe is treated as no-session", async () => {
    await writeTeamJson({ emojisMode: "static" });
    // Inject a factory that returns a tmux whose hasSession throws —
    // simulates a tmux server that responds but errors on the probe.
    const exit = await addMember(["zeta", "--socket-path", env.socketPath], {
      env: { ...process.env, ATMUX_DIR: env.atmuxDir },
      cwd: env.atmuxDir,
      logger: env.logger,
      rng: FIXED_RNG,
      tmuxFactory: () =>
        ({
          ...env.tmux,
          session: {
            ...env.tmux.session,
            hasSession: async () => {
              throw new Error("simulated tmux error");
            },
          },
        }) as TmuxNamespace,
    });
    expect(exit).toBe(0);
    // Verb degraded to the start-pointer branch
    expect(env.logs.some((l) => l.msg.includes("run 'atmux start'"))).toBe(true);
  });

  test("getSessionName failure (single-session w/o anchor) → start-pointer branch", async () => {
    // singleSession=true with no .atmux/state/session.txt → getSessionName
    // throws ConfigError. add-member treats this as "no live session".
    await writeTeamJson({ emojisMode: "static", singleSession: true });
    expect(await runAdd(["alpha"])).toBe(0);
    expect(env.logs.some((l) => l.msg.includes("run 'atmux start'"))).toBe(true);
  });
});

// ---------- addMember verb — defaults / opts ----------

describe("addMember — opts defaults", () => {
  test("env / cwd / logger / rng all default when not supplied", async () => {
    // Drive the bare-`opts` path: process.env, process.cwd(), createLogger
    // (stderr-bound), Math.random. We can't easily assert against
    // process.env mutation, so we validate behaviour by setting up the
    // sandbox env via the actual env vars + cwd, and checking the verb
    // runs cleanly (no throws). The logger output goes to stderr.
    await writeTeamJson({ emojisMode: "static" });
    const priorAtmuxDir = process.env.ATMUX_DIR;
    process.env.ATMUX_DIR = env.atmuxDir;
    const priorCwd = process.cwd();
    process.chdir(env.atmuxDir);
    try {
      // Bare `addMember` call — no opts at all. Coverage hits the `??`
      // defaults for env/cwd/logger/factory/rng.
      const exit = await addMember(["alpha", "--socket-path", env.socketPath]);
      expect(exit).toBe(0);
    } finally {
      process.chdir(priorCwd);
      if (priorAtmuxDir === undefined) delete process.env.ATMUX_DIR;
      else process.env.ATMUX_DIR = priorAtmuxDir;
    }
  });
});
