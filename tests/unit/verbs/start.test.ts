// Unit tests for src/verbs/start.ts (Phase 2 lifecycle MVP).
//
// Strategy mirrors `tests/unit/core/send.test.ts` + `tests/unit/abstractions/
// tmux.test.ts` (Task #1 socket-injection): spin a real tmux server on a
// per-test absolute socketPath, exercise the verb against a real `.atmux/`
// dir, assert observable side-effects (tmux session created, expected
// windows present, `state/session-start.txt` written, log lines sunk).
//
// Test isolation (memory `feedback_tmux_test_isolation.md`):
// `createTmux({ socketPath, configFile: "/dev/null" })` is the load-bearing
// guarantee — `-S <socketPath>` baked into every tmux invocation makes it
// physically impossible for a spawned subprocess to reach the operator's
// daily-driver tmux server. The `delete process.env.TMUX` belt-and-braces
// in beforeEach is layered on top.
//
// 100% narrowed coverage (ADR-009 §2): every branch of `parseStartArgs`,
// `resolveTmuxConfig`, `defaultSocketPath`, and the `start` verb body is
// exercised — happy path, every flag, every error branch, single-session
// refusal, doctor-mode notice, live-lead guard (warn + force-kill paths),
// incremental restart (skip-existing), placeholder-cleanup, and the
// session-start timestamp write.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  defaultSocketPath,
  parseStartArgs,
  resolveTmuxConfig,
  start,
} from "../../../src/verbs/start.ts";

// ---------- Test fixture helpers ----------

interface TestEnv {
  /** Per-test `.atmux/` dir (passed via `ATMUX_DIR`). */
  atmuxDir: string;
  /** Per-test absolute socket path (passed via `--socket-path`). */
  socketPath: string;
  /** Per-test `tmux` namespace pinned to the same socket — used to
   *  observe the side-effects of `start` without re-construction. */
  tmux: TmuxNamespace;
  /** A randomized session/window prefix to keep concurrent tests apart. */
  team: string;
  /** Captured logger output (one entry per call). */
  logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[];
  logger: Logger;
}

let env: TestEnv;
let socketDir: string;
let priorTmux: string | undefined;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-start-sock-"));
  const socketPath = join(socketDir, "sock");
  const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-start-dir-"));
  // ATMUX_DIR points the verb at the `.atmux/` we're about to seed.
  // `getAtmuxDir` reads that env var first (per the resolution chain in
  // src/core/common.ts:51) — no need for cwd-walk wiring in tests.
  const team = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(atmuxDir, { recursive: true });
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  // Use `/dev/null` config so tmux behaviour is reproducible regardless
  // of the operator's ~/.tmux.conf (base-index, key-bindings, etc.).
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
  // Tear down the per-test server. Routes through the abstraction so
  // the `-S <socketPath>` flag is mandatory — by construction, kill-server
  // here cannot reach the operator's daily-driver tmux.
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
  members: ReadonlyArray<{ name: string; role?: string; emoji?: string; cwd?: string }>;
  singleSession?: boolean;
}): Promise<void> {
  const body = {
    name: env.team,
    members: opts.members,
    ...(opts.singleSession !== undefined ? { singleSession: opts.singleSession } : {}),
  };
  await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/** Inject the per-test factory + env+cwd into a `start` call.
 *  Tests pass args + the team-specific socket-path flag automatically. */
async function runStart(args: ReadonlyArray<string>): Promise<number> {
  return await start([...args, "--socket-path", env.socketPath], {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir },
    cwd: env.atmuxDir,
    logger: env.logger,
  });
}

// ---------- parseStartArgs ----------

describe("parseStartArgs", () => {
  test("defaults: force=false, doctor=preflight, no socket", () => {
    const got = parseStartArgs([], {});
    expect(got).toEqual({ force: false, doctorMode: "preflight" });
  });

  test("--force / -f sets force=true", () => {
    expect(parseStartArgs(["--force"], {}).force).toBe(true);
    expect(parseStartArgs(["-f"], {}).force).toBe(true);
  });

  test("--doctor sets verbose; --no-doctor sets skip", () => {
    expect(parseStartArgs(["--doctor"], {}).doctorMode).toBe("verbose");
    expect(parseStartArgs(["--no-doctor"], {}).doctorMode).toBe("skip");
  });

  test("ATMUX_DOCTOR_ON_START env upgrades default to verbose", () => {
    expect(parseStartArgs([], { ATMUX_DOCTOR_ON_START: "1" }).doctorMode).toBe("verbose");
  });

  test("ATMUX_DOCTOR_ON_START empty string keeps preflight default", () => {
    expect(parseStartArgs([], { ATMUX_DOCTOR_ON_START: "" }).doctorMode).toBe("preflight");
  });

  test("--socket sets socket; --socket-path sets socketPath", () => {
    expect(parseStartArgs(["--socket", "alpha"], {})).toMatchObject({ socket: "alpha" });
    expect(parseStartArgs(["--socket-path", "/tmp/foo"], {})).toMatchObject({
      socketPath: "/tmp/foo",
    });
  });

  test("--socket without value throws UsageError", () => {
    expect(() => parseStartArgs(["--socket"], {})).toThrow(UsageError);
  });

  test("--socket with empty-string value throws UsageError", () => {
    expect(() => parseStartArgs(["--socket", ""], {})).toThrow(UsageError);
  });

  test("--socket-path without value throws UsageError", () => {
    expect(() => parseStartArgs(["--socket-path"], {})).toThrow(UsageError);
  });

  test("--socket-path with empty-string value throws UsageError", () => {
    expect(() => parseStartArgs(["--socket-path", ""], {})).toThrow(UsageError);
  });

  test("--socket and --socket-path together throws UsageError", () => {
    expect(() => parseStartArgs(["--socket", "a", "--socket-path", "/b"], {})).toThrow(UsageError);
  });

  test("unknown arg throws UsageError", () => {
    expect(() => parseStartArgs(["--unknown"], {})).toThrow(UsageError);
  });

  test("flag combinations parse left-to-right", () => {
    const got = parseStartArgs(["--force", "--no-doctor", "--socket", "s1"], {});
    expect(got).toEqual({ force: true, doctorMode: "skip", socket: "s1" });
  });
});

// ---------- defaultSocketPath / resolveTmuxConfig ----------

describe("defaultSocketPath", () => {
  test("default shape matches `/tmp/atmux-<team>/sock`", () => {
    expect(defaultSocketPath("alpha")).toBe("/tmp/atmux-alpha/sock");
  });
});

describe("resolveTmuxConfig", () => {
  test("explicit socketPath wins", () => {
    const cfg = resolveTmuxConfig("t", {
      force: false,
      doctorMode: "preflight",
      socketPath: "/explicit",
    });
    expect(cfg).toEqual({ socketPath: "/explicit" });
  });

  test("explicit socket wins (when no socketPath)", () => {
    const cfg = resolveTmuxConfig("t", {
      force: false,
      doctorMode: "preflight",
      socket: "named",
    });
    expect(cfg).toEqual({ socket: "named" });
  });

  test("falls back to default socket path", () => {
    const cfg = resolveTmuxConfig("t", { force: false, doctorMode: "preflight" });
    expect(cfg).toEqual({ socketPath: "/tmp/atmux-t/sock" });
  });
});

// ---------- start verb — happy path ----------

describe("start — happy path", () => {
  test("creates session + one window per member + records timestamp", async () => {
    await writeTeamJson({
      members: [
        { name: "alice", role: "team-lead" },
        { name: "bob", role: "reviewer" },
      ],
    });

    const exit = await runStart([]);
    expect(exit).toBe(0);

    // Session present at the per-test socket
    const session = `atmux-${env.team}`;
    expect(await env.tmux.session.hasSession(session)).toBe(true);

    // Two member windows, no `__<team>__home` placeholder remaining.
    // (Placeholder still uses the `__<team>__home` form — only member
    // windows dropped the prefix per ADR-017.)
    const windows = await env.tmux.window.listWindows(session);
    const names = windows.map((w) => w.name).sort();
    // buildWindowName(member, emoji) → `<emoji><member>` (ADR-017).
    // emojis come from defaultEmojiForRole: team-lead → 🧭, reviewer → 🔍.
    // Sort order: 🔍bob < 🧭alice (codepoint compare).
    expect(names).toEqual(["🔍bob", "🧭alice"]);
    expect(names).not.toContain(`__${env.team}__home`);

    // Timestamp written as integer seconds
    const ts = await readFile(join(env.atmuxDir, "state", "session-start.txt"), "utf8");
    expect(ts).toMatch(/^\d+\n$/);

    // ok-line about team being up was sunk
    expect(env.logs.some((l) => l.kind === "ok" && l.msg.includes("is up"))).toBe(true);
  });

  test("uses member.emoji override when present", async () => {
    await writeTeamJson({
      members: [{ name: "carol", role: "member", emoji: "🦄" }],
    });

    await runStart([]);
    const windows = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(windows.map((w) => w.name)).toContain("🦄carol");
  });

  test("uses member.cwd override when present", async () => {
    const memberCwd = await mkdtemp(join(tmpdir(), "atmux-start-mcwd-"));
    try {
      await writeTeamJson({
        members: [{ name: "dave", role: "member", cwd: memberCwd }],
      });
      const exit = await runStart([]);
      expect(exit).toBe(0);
      // Indirect observation: window was created without throwing — the
      // cwd path is exercised. Direct cwd readback is impractical without
      // running a shell-command in the pane (which would defeat the
      // empty-pane MVP).
      const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
      expect(wins.map((w) => w.name)).toContain("🐝dave");
    } finally {
      await rm(memberCwd, { recursive: true, force: true });
    }
  });

  test("doctor flag emits a deferred-port notice; --no-doctor stays silent", async () => {
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });

    await runStart(["--doctor"]);
    expect(env.logs.some((l) => l.kind === "log" && l.msg.includes("doctor mode 'verbose'"))).toBe(
      true,
    );

    // Reset + run again with --no-doctor — no doctor notice should appear
    await env.tmux.session.killSession(`atmux-${env.team}`);
    env.logs.length = 0;
    await runStart(["--no-doctor"]);
    expect(env.logs.some((l) => l.msg.includes("doctor mode"))).toBe(false);
  });

  test("default doctor mode (preflight) emits the deferred-port notice", async () => {
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([]);
    expect(
      env.logs.some((l) => l.kind === "log" && l.msg.includes("doctor mode 'preflight'")),
    ).toBe(true);
  });

  test("zero-member team creates session + leaves __home in place", async () => {
    await writeTeamJson({ members: [] });
    const exit = await runStart([]);
    expect(exit).toBe(0);
    const session = `atmux-${env.team}`;
    const wins = await env.tmux.window.listWindows(session);
    expect(wins.map((w) => w.name)).toEqual([`__${env.team}__home`]);
  });
});

// ---------- start verb — live-lead guard ----------

describe("start — live-lead guard", () => {
  test("incremental: session already exists → warn, keep existing windows", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });

    // First start
    expect(await runStart([])).toBe(0);
    // Reset captured logs for the second invocation
    env.logs.length = 0;

    // Second start — must warn-keep, not refuse
    expect(await runStart([])).toBe(0);
    expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("already exists"))).toBe(true);
    // alice's window is still present and was NOT recreated (skip log fired)
    expect(env.logs.some((l) => l.kind === "log" && l.msg.includes("alice: window exists"))).toBe(
      true,
    );
  });

  test("--force: kills + recreates session", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    expect(await runStart([])).toBe(0);
    env.logs.length = 0;
    expect(await runStart(["--force"])).toBe(0);
    expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("force: killing"))).toBe(true);
    // After --force the session was recreated; alice spawned fresh (no
    // skip-existing log line)
    expect(env.logs.some((l) => l.kind === "log" && l.msg.includes("spawned window"))).toBe(true);
  });

  test("--force when session is absent still creates fresh", async () => {
    // No prior start — session doesn't exist; --force should be a no-op
    // on the kill side and proceed to the create side.
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    expect(await runStart(["--force"])).toBe(0);
    expect(await env.tmux.session.hasSession(`atmux-${env.team}`)).toBe(true);
  });
});

// ---------- start verb — single-session refusal ----------

describe("start — single-session refusal (deferred port)", () => {
  test("team.singleSession=true → ConfigError", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
      singleSession: true,
    });
    await expect(runStart([])).rejects.toThrow(ConfigError);
  });

  test("ATMUX_DRIVER_SESSION env → ConfigError even when team.singleSession=false", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    await expect(
      start(["--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir, ATMUX_DRIVER_SESSION: "1" },
        cwd: env.atmuxDir,
        logger: env.logger,
      }),
    ).rejects.toThrow(ConfigError);
  });
});

// ---------- start verb — arg-parse failures ----------

describe("start — arg-parse failures bubble through", () => {
  test("unknown arg → UsageError before any tmux call", async () => {
    await writeTeamJson({ members: [] });
    await expect(runStart(["--bogus"])).rejects.toThrow(UsageError);
    // Session was NOT created
    expect(await env.tmux.session.hasSession(`atmux-${env.team}`)).toBe(false);
  });
});

// ---------- start verb — placeholder cleanup ----------

describe("start — __home placeholder cleanup", () => {
  test("placeholder is killed when members spawn", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    await runStart([]);
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.map((w) => w.name)).not.toContain(`__${env.team}__home`);
  });
});

// ---------- start verb — incremental skip-existing ----------

describe("start — incremental restart skips existing windows", () => {
  test("re-run with one new member adds only the new window", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    expect(await runStart([])).toBe(0);

    // Add a second member to team.json then re-start
    await writeTeamJson({
      members: [
        { name: "alice", role: "team-lead" },
        { name: "bob", role: "reviewer" },
      ],
    });
    env.logs.length = 0;
    expect(await runStart([])).toBe(0);

    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    const names = wins.map((w) => w.name).sort();
    expect(names).toContain("🧭alice");
    expect(names).toContain("🔍bob");
    // Skip-existing log line for alice fired
    expect(env.logs.some((l) => l.msg.includes("alice: window exists"))).toBe(true);
  });
});
