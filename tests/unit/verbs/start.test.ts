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
  resolveSpawnWaitMs,
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
let priorNoCron: string | undefined;

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
  // t-e1247699: start() auto-installs cron via cronInstall (start.ts §11).
  // Pin ATMUX_NO_CRON=1 so the verb's internal gate short-circuits before
  // it can reach the host crontab — without this, every test in this file
  // leaks an `atmux:team=<random>` block pointing at the mkdtemp dir,
  // which `afterEach`'s rm-rf cannot recover (cron edits live in the
  // host crontab, not ATMUX_TEST_TMP). Mirrors stop.test.ts:35-36 +
  // tests/helpers/setup.bash:47 (bash sandbox parity).
  priorNoCron = process.env.ATMUX_NO_CRON;
  process.env.ATMUX_NO_CRON = "1";
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
  if (priorNoCron !== undefined) process.env.ATMUX_NO_CRON = priorNoCron;
  else delete process.env.ATMUX_NO_CRON;
  await rm(socketDir, { recursive: true, force: true });
  await rm(env.atmuxDir, { recursive: true, force: true });
});

/** Write a minimal `team.json` with the given members + flags. */
async function writeTeamJson(opts: {
  members: ReadonlyArray<{
    name: string;
    role?: string;
    emoji?: string;
    cwd?: string;
    tui?: string;
  }>;
  singleSession?: boolean;
  driverSession?: { tui?: string | null } | null;
  driverTui?: string | null;
  /** ADR-082 W3: opt-in to per-member worktree isolation. Default
   *  omitted → legacy shared-tree behaviour (matches existing tests). */
  worktreeIsolation?: boolean;
  /** ADR-082 W3: relative root for the worktree tree (default
   *  `.atmux/worktrees` via the W2 schema default). */
  worktreeRoot?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {
    name: env.team,
    members: opts.members,
    ...(opts.singleSession !== undefined ? { singleSession: opts.singleSession } : {}),
    ...(opts.worktreeIsolation !== undefined ? { worktreeIsolation: opts.worktreeIsolation } : {}),
    ...(opts.worktreeRoot !== undefined ? { worktreeRoot: opts.worktreeRoot } : {}),
  };
  // driverSession is included even when null — the tests for the
  // "explicitly disabled" path rely on the field being present-but-null
  // rather than absent.
  if ("driverSession" in opts) {
    body.driverSession = opts.driverSession;
  }
  if (opts.driverTui !== undefined) {
    body.driverTui = opts.driverTui;
  }
  await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

/** Inject the per-test factory + env+cwd into a `start` call.
 *  Tests pass args + the team-specific socket-path flag automatically.
 *  Optional `opts` lets ADR-082 W3 tests inject a `gitSpawn` mock so
 *  the worktree-provisioning path never shells out to the live repo. */
type StartOpts = NonNullable<Parameters<typeof start>[1]>;

async function runStart(
  args: ReadonlyArray<string>,
  opts: {
    gitSpawn?: import("../../../src/abstractions/worktree.ts").GitSpawn;
    /** t-eb0887fe: cap on concurrent member spawns. */
    spawnConcurrency?: number;
    /** ADR-089 §D (t-7e7031dc): extra env keys merged on top of the
     *  default test env. Used to exercise ATMUX_NESTING_LEVEL /
     *  ATMUX_NO_CRON paths without polluting `process.env`. */
    extraEnv?: Record<string, string>;
  } = {},
): Promise<number> {
  const startOpts: StartOpts = {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir, ...(opts.extraEnv ?? {}) },
    cwd: env.atmuxDir,
    logger: env.logger,
  };
  if (opts.gitSpawn !== undefined) startOpts.gitSpawn = opts.gitSpawn;
  if (opts.spawnConcurrency !== undefined) startOpts.spawnConcurrency = opts.spawnConcurrency;
  return await start([...args, "--socket-path", env.socketPath], startOpts);
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
  test("explicit socketPath wins (overrides tmuxTmpdir)", () => {
    const cfg = resolveTmuxConfig(
      { name: "t", tmuxTmpdir: "/proj/.atmux/tmux" },
      {
        force: false,
        doctorMode: "preflight",
        socketPath: "/explicit",
      },
    );
    expect(cfg).toEqual({ socketPath: "/explicit" });
  });

  test("explicit socket wins (overrides tmuxTmpdir, when no socketPath)", () => {
    const cfg = resolveTmuxConfig(
      { name: "t", tmuxTmpdir: "/proj/.atmux/tmux" },
      {
        force: false,
        doctorMode: "preflight",
        socket: "named",
      },
    );
    expect(cfg).toEqual({ socket: "named" });
  });

  test("falls back to default socket path when tmuxTmpdir unset", () => {
    const cfg = resolveTmuxConfig({ name: "t" }, { force: false, doctorMode: "preflight" });
    expect(cfg).toEqual({ socketPath: "/tmp/atmux-t/sock" });
  });

  test("t-b37c8f4f: honours team.tmuxTmpdir on the write side", () => {
    // Mirrors resolveTeamSocket shape: <tmuxTmpdir>/tmux-<uid>/default
    // (process.getuid() seeded from the real process — match-by-prefix
    // so the test is uid-portable).
    const cfg = resolveTmuxConfig(
      { name: "t", tmuxTmpdir: "/proj/.atmux/tmux" },
      { force: false, doctorMode: "preflight" },
    );
    expect("socketPath" in cfg).toBe(true);
    if ("socketPath" in cfg) {
      const uid = process.getuid?.() ?? 0;
      expect(cfg.socketPath).toBe(`/proj/.atmux/tmux/tmux-${uid}/default`);
    }
  });

  test("t-b37c8f4f: empty-string tmuxTmpdir falls back to canonical socket", () => {
    const cfg = resolveTmuxConfig(
      { name: "t", tmuxTmpdir: "" },
      { force: false, doctorMode: "preflight" },
    );
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
    // buildWindowName(member, emoji, label, role) → ADR-161 TR2:
    // default roles render `_-prefix`. emojis from defaultEmojiForRole:
    // team-lead → 🧭, reviewer → 🔍. Sort order: 🔍_bob < 🧭_alice.
    expect(names).toEqual(["🔍_bob", "🧭_alice"]);
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
    expect(windows.map((w) => w.name)).toContain("🦄-carol");
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
      expect(wins.map((w) => w.name)).toContain("🐝-dave");
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

  test("applies the fixed cage prefix (C-\\) globally on the tmux server (ADR-263 §D1)", async () => {
    // 2026-05-09 bisection — standalone `atmux start <team>` was NOT
    // applying the cage prefix that nested-tmux topology requires.
    // ADR-263 §D1 slimmed the cockpit-derived prefix-chain ladder down
    // to the historical hardcoded `C-\`; the level-resolved chain
    // (F1/F2/...) is gone with the cockpit. Standalone start must still
    // override the default C-b so the nested cage prefix never collides
    // with the operator's outer-tmux prefix.
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    const opts = await env.tmux.option.showOptions({ global: true });
    expect(opts.prefix).toBe("C-\\");
  });

  test("cage prefix is applied on incremental-restart path too (idempotent) (ADR-263 §D1)", async () => {
    // The prefix-set is server-level; re-running start against an
    // existing session must not regress the prefix. Belt-and-braces
    // assertion that the prefix override runs in the warn-keep branch
    // (no --force, session already exists).
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    // Manually clobber the prefix to verify the second start re-applies.
    await env.tmux.option.setOption({ name: "prefix", value: "C-b", global: true });
    expect((await env.tmux.option.showOptions({ global: true })).prefix).toBe("C-b");
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    expect((await env.tmux.option.showOptions({ global: true })).prefix).toBe("C-\\");
  });

  test("bug t-4d2936ac — start scrubs ANTHROPIC_API_KEY / AUTH_TOKEN / CLAUDE_CONFIG_DIR from the session env", async () => {
    // Regression: operator-shell ANTHROPIC_API_KEY inheriting through
    // the cage tmux session triggered the "Do you want to use this API
    // key?" dialog on OAuth-account claude TUIs (2026-05-14 incident).
    // start.ts now fires `tmux set-environment -u <var>` for each
    // scrub-target var AFTER session creation; defense-in-depth for
    // non-claude TUIs + member.command overrides that bypass tuiClaude.
    //
    // Empirical tmux behaviour (verified manually): `set-environment -u
    // VAR` on a session WHERE the var was previously set drops the var
    // from `show-environment` output. We seed the three scrub-target
    // vars on the session post-start, run an INCREMENTAL start (which
    // re-fires the scrub loop), and verify the seeded vars are gone.
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    const session = `atmux-${env.team}`;
    // Seed the three target vars on the session.
    for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) {
      await env.tmux.session.setEnvironment({ target: session, name: v, value: "seeded" });
    }
    // Sanity check: seed landed.
    {
      const proc = Bun.spawnSync({
        cmd: ["tmux", "-S", env.socketPath, "show-environment", "-t", session],
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(proc.stdout);
      expect(out).toContain("ANTHROPIC_API_KEY=seeded");
      expect(out).toContain("ANTHROPIC_AUTH_TOKEN=seeded");
      expect(out).toContain("CLAUDE_CONFIG_DIR=seeded");
    }
    // Incremental re-run — the post-newSession scrub loop fires
    // regardless of sessionExisted (idempotent + cheap).
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    // Seeded vars must now be gone.
    const proc = Bun.spawnSync({
      cmd: ["tmux", "-S", env.socketPath, "show-environment", "-t", session],
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(proc.stdout);
    expect(out).not.toContain("ANTHROPIC_API_KEY=seeded");
    expect(out).not.toContain("ANTHROPIC_AUTH_TOKEN=seeded");
    expect(out).not.toContain("CLAUDE_CONFIG_DIR=seeded");
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
    expect(names).toContain("🧭_alice");
    expect(names).toContain("🔍_bob");
    // Skip-existing log line for alice fired
    expect(env.logs.some((l) => l.msg.includes("alice: window exists"))).toBe(true);
  });
});

// ---------- start verb — ADR-263 §D1 flat-pane model (driverSession ignored) ----------
//
// The ADR-044 driver-fan-out topology is GONE per ADR-263 §D1: `atmux
// start` always seeds the `__<team>__home` placeholder and populates one
// window per `team.members[]` entry — there is no driver-at-window-1
// path, no role-based ordering. The `driverSession` field still parses in
// the team schema but `start` ignores it. These tests assert that the
// flat-pane behaviour holds regardless of `driverSession`.

describe("start — ADR-263 §D1 flat-pane model (driverSession ignored)", () => {
  test("driverSession configured → NO driver window; flat member panes only", async () => {
    await writeTeamJson({
      members: [
        { name: "alpha", role: "team-lead", tui: "shell" },
        { name: "bee", role: "member", tui: "shell" },
      ],
      // ADR-263 §D1: driverSession is IGNORED — no driver window spawns.
      driverSession: { tui: "shell" },
    });

    const exit = await runStart([]);
    expect(exit).toBe(0);

    const session = `atmux-${env.team}`;
    const wins = await env.tmux.window.listWindows(session);
    // No driver window — the fan-out is gone.
    expect(wins.some((w) => w.name === "driver")).toBe(false);
    // Members emoji-prefixed by role: team-lead → 🧭, member → 🐝.
    const names = wins.map((w) => w.name).sort();
    expect(names).toContain("🧭_alpha");
    expect(names).toContain("🐝-bee");
    // __home placeholder cleaned up once members spawn.
    expect(wins.some((w) => w.name === `__${env.team}__home`)).toBe(false);
    // No driver-at-window-1 log line — the path is gone.
    expect(env.logs.some((l) => l.msg.includes("driver at window 1"))).toBe(false);
  });

  test("driverSession=null falls through to legacy __home", async () => {
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      // Matches the wizard's "explicitly disabled" output. The field is
      // present but null — flat-pane model unaffected.
      driverSession: null,
    });

    const exit = await runStart([]);
    expect(exit).toBe(0);

    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.some((w) => w.name === "driver")).toBe(false);
    // __home was created then cleaned up by step 9 (member spawned).
    expect(wins.some((w) => w.name === `__${env.team}__home`)).toBe(false);
    // No driver-at-window-1 log line when the path was skipped.
    expect(env.logs.some((l) => l.msg.includes("driver at window 1"))).toBe(false);
  });

  test("absent: legacy __home placeholder path is unchanged", async () => {
    // Regression guard: zero-member team.json without driverSession must
    // still leave the __home placeholder.
    await writeTeamJson({ members: [] });
    const exit = await runStart([]);
    expect(exit).toBe(0);
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.map((w) => w.name)).toEqual([`__${env.team}__home`]);
  });

  test("incremental: adding driverSession to a live session never inserts a driver window", async () => {
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
    });
    expect(await runStart([])).toBe(0);

    // Now add driverSession AFTER the session is up. Re-run start
    // (incremental, no --force) — must NOT add a driver window.
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      driverSession: { tui: "shell" },
    });
    env.logs.length = 0;
    expect(await runStart([])).toBe(0);

    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.some((w) => w.name === "driver")).toBe(false);
    // No driver-at-window-1 log line either (path didn't run).
    expect(env.logs.some((l) => l.msg.includes("driver at window 1"))).toBe(false);
  });

  test("member with non-shell tui: send-keys fires after newWindow", async () => {
    // Exercises the member spawn loop's send-keys branch. Uses
    // team.tuiCommands to register a benign no-op so resolveTuiCommand
    // returns a valid command for a non-built-in tui kind.
    const body = {
      name: env.team,
      members: [{ name: "alpha", role: "team-lead", tui: "fake-member-tui" }],
      tuiCommands: { "fake-member-tui": "true" },
    };
    await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");

    // ADR-263 §D4: brief paste is gone from the start path — the spawn
    // loop just send-keys the resolved TUI command. The assertion below
    // only checks the member window was created.
    const exit = await runStart([]);
    expect(exit).toBe(0);

    // Member window present — the send-keys path didn't throw.
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.map((w) => w.name)).toContain("🧭_alpha");
  });
});

// ---------- start — ADR-082 W3 per-member worktree provisioning ----------

describe("start — ADR-082 W3 worktree-isolation", () => {
  type GitSpawn = import("../../../src/abstractions/worktree.ts").GitSpawn;
  type SpawnResult = import("../../../src/abstractions/spawn.ts").SpawnResult;

  function ok(stdout = ""): SpawnResult {
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
  function fail(stderr: string, code = 128): SpawnResult {
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

  test("legacy team (no worktreeIsolation field) makes ZERO git invocations", async () => {
    await writeTeamJson({
      members: [
        { name: "alice", role: "team-lead" },
        { name: "bob", role: "reviewer" },
      ],
    });
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    const exit = await runStart([], { gitSpawn });
    expect(exit).toBe(0);
    // The legacy short-circuit MUST gate at `team.worktreeIsolation === true`
    // — any git invocation here is a regression that resurrects the
    // shared-tree-only path's behaviour for opt-in teams.
    expect(calls).toEqual([]);
  });

  test("worktreeIsolation=true happy path: each member gets a per-member-branch worktree provisioned + cwd overridden", async () => {
    await writeTeamJson({
      members: [
        { name: "alice", role: "team-lead" },
        { name: "bob", role: "reviewer" },
      ],
      worktreeIsolation: true,
    });
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      // rev-parse --show-toplevel → fake repo path.
      // branch --show-current  → operator branch name.
      // worktree list          → empty (no managed worktrees yet).
      // rev-parse --verify     → exit 1 (wtBranch absent → use `-b`).
      // worktree add           → success.
      //
      // Both `rev-parse` invocations must be discriminated by argv
      // shape — `--show-toplevel` vs `--verify` — because plain
      // `argv.includes("rev-parse")` matches both.
      if (argv.includes("--show-toplevel")) return ok("/srv/fake-repo\n");
      if (argv.includes("--verify")) return fail("", 1); // wtBranch absent
      if (argv.includes("branch")) return ok("geoyws\n");
      if (argv.includes("list")) return ok("");
      return ok(""); // worktree add
    };
    const exit = await runStart([], { gitSpawn });
    expect(exit).toBe(0);
    // Per ADR-084: 1× rev-parse --show-toplevel, 1× branch
    // --show-current, then per member 3 calls (list, rev-parse
    // --verify refs/heads/<wtBranch>, worktree add -b <wtBranch>).
    // Total: 2 + 2*3 = 8.
    expect(calls).toHaveLength(8);
    expect(calls[0]).toEqual([
      "-C",
      env.atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/",
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(calls[1]).toEqual([
      "-C",
      env.atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/",
      "branch",
      "--show-current",
    ]);
    // Per-member-branch path: `worktree add -b <baseBranch>-<member>
    // <wtPath> <baseBranch>`. Verify both members get a `-b` add with
    // the right derived branch name.
    const addCalls = calls.filter((c) => c.includes("add"));
    expect(addCalls).toHaveLength(2);
    for (const c of addCalls) {
      expect(c).toContain("-b");
      // baseBranch checkout target is the last positional arg.
      expect(c[c.length - 1]).toBe("geoyws");
    }
    expect(addCalls.some((c) => c.includes("geoyws-alice"))).toBe(true);
    expect(addCalls.some((c) => c.includes("geoyws-bob"))).toBe(true);
    // rev-parse --verify call targets the derived branch ref.
    const verifyCalls = calls.filter((c) => c.includes("--verify"));
    expect(verifyCalls).toHaveLength(2);
    expect(verifyCalls.some((c) => c.includes("refs/heads/geoyws-alice"))).toBe(true);
    expect(verifyCalls.some((c) => c.includes("refs/heads/geoyws-bob"))).toBe(true);
    // Operator-visible log lines surface each provision with branch.
    expect(env.logs.some((l) => l.msg.includes("worktree created: alice"))).toBe(true);
    expect(env.logs.some((l) => l.msg.includes("worktree created: bob"))).toBe(true);
    expect(env.logs.some((l) => l.msg.includes("[geoyws-alice]"))).toBe(true);
    expect(env.logs.some((l) => l.msg.includes("[geoyws-bob]"))).toBe(true);
  });

  test("partial-fail: one member's provisionWorktree throws → others still spawn, failed one falls back", async () => {
    await writeTeamJson({
      members: [
        { name: "alice", role: "team-lead" },
        { name: "bob", role: "reviewer" },
        { name: "carol", role: "member" },
      ],
      worktreeIsolation: true,
    });
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("rev-parse")) return ok("/srv/fake-repo\n");
      if (argv.includes("branch")) return ok("geoyws\n");
      if (argv.includes("list")) return ok(""); // no managed worktrees yet
      if (argv.includes("add")) {
        // Fail ONLY bob's add; alice + carol succeed.
        if (argv.some((a) => a.endsWith("/bob"))) {
          return fail("fatal: invalid reference: geoyws");
        }
        return ok("");
      }
      return ok("");
    };
    const exit = await runStart([], { gitSpawn });
    expect(exit).toBe(0);
    // Team still spawned all 3 members despite bob's provision failure.
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    const names = wins.map((w) => w.name).sort();
    expect(names).toContain("🧭_alice");
    expect(names).toContain("🔍_bob");
    expect(names).toContain("🐝-carol");
    // Operator-visible warning names the failing member specifically.
    const warns = env.logs.filter((l) => l.kind === "warn");
    expect(warns.some((l) => l.msg.includes("bob") && l.msg.includes("provision failed"))).toBe(
      true,
    );
    // alice + carol got worktree-created log lines.
    expect(env.logs.some((l) => l.msg.includes("worktree created: alice"))).toBe(true);
    expect(env.logs.some((l) => l.msg.includes("worktree created: carol"))).toBe(true);
  });

  test("git rev-parse failure → all members fall back to shared cwd with a single warning", async () => {
    await writeTeamJson({
      members: [
        { name: "alice", role: "team-lead" },
        { name: "bob", role: "reviewer" },
      ],
      worktreeIsolation: true,
    });
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return fail("fatal: not a git repository");
      return ok("");
    };
    const exit = await runStart([], { gitSpawn });
    expect(exit).toBe(0);
    // rev-parse + branch are the only calls — branch is exec'd before
    // the rev-parse-failure gate kicks in (the impl reads both up-front).
    // No `worktree add` invocations.
    expect(calls.filter((c) => c.includes("add"))).toHaveLength(0);
    // Warning surfaces the repo-root detection failure.
    const warns = env.logs.filter((l) => l.kind === "warn");
    expect(warns.some((l) => l.msg.includes("cannot detect repo root"))).toBe(true);
    // Members still spawn — pane creation is unaffected.
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.map((w) => w.name).sort()).toEqual(["🔍_bob", "🧭_alice"]);
  });

  test("detached HEAD (empty branch) → all fall back with 'detached HEAD' warning, no provisioning", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
      worktreeIsolation: true,
    });
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return ok("/srv/fake-repo\n");
      // branch --show-current emits empty string when HEAD is detached.
      if (argv.includes("branch")) return ok("\n");
      return ok("");
    };
    const exit = await runStart([], { gitSpawn });
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.includes("add"))).toHaveLength(0);
    const warns = env.logs.filter((l) => l.kind === "warn");
    expect(warns.some((l) => l.msg.includes("detached HEAD"))).toBe(true);
  });
});

// ---------- resolveSpawnWaitMs ----------

describe("resolveSpawnWaitMs", () => {
  test("explicit override wins over env", () => {
    expect(resolveSpawnWaitMs(0, { ATMUX_SPAWN_WAIT: "10" })).toBe(0);
    expect(resolveSpawnWaitMs(250, {})).toBe(250);
  });

  test("ATMUX_SPAWN_WAIT seconds → milliseconds", () => {
    expect(resolveSpawnWaitMs(undefined, { ATMUX_SPAWN_WAIT: "3" })).toBe(3000);
    expect(resolveSpawnWaitMs(undefined, { ATMUX_SPAWN_WAIT: "0" })).toBe(0);
  });

  test("default 6000ms when neither set", () => {
    expect(resolveSpawnWaitMs(undefined, {})).toBe(6000);
  });

  test("non-numeric / negative env falls through to default", () => {
    expect(resolveSpawnWaitMs(undefined, { ATMUX_SPAWN_WAIT: "abc" })).toBe(6000);
    expect(resolveSpawnWaitMs(undefined, { ATMUX_SPAWN_WAIT: "-1" })).toBe(6000);
    expect(resolveSpawnWaitMs(undefined, { ATMUX_SPAWN_WAIT: "" })).toBe(6000);
  });

  test("negative override falls through to env / default", () => {
    expect(resolveSpawnWaitMs(-5, { ATMUX_SPAWN_WAIT: "2" })).toBe(2000);
    expect(resolveSpawnWaitMs(-5, {})).toBe(6000);
  });
});

import { resolveSpawnConcurrency, runWithConcurrency } from "../../../src/verbs/start.ts";

describe("resolveSpawnConcurrency", () => {
  test("override wins when valid", () => {
    expect(resolveSpawnConcurrency(3, {})).toBe(3);
    expect(resolveSpawnConcurrency(1, {})).toBe(1);
    expect(resolveSpawnConcurrency(20, {})).toBe(20);
  });

  test("override <1 falls through to env / default", () => {
    expect(resolveSpawnConcurrency(0, {})).toBe(6);
    expect(resolveSpawnConcurrency(-5, {})).toBe(6);
    expect(resolveSpawnConcurrency(Number.NaN, {})).toBe(6);
  });

  test("env override applies when no opts override", () => {
    expect(resolveSpawnConcurrency(undefined, { ATMUX_SPAWN_CONCURRENCY: "8" })).toBe(8);
    expect(resolveSpawnConcurrency(undefined, { ATMUX_SPAWN_CONCURRENCY: "1" })).toBe(1);
  });

  test("env override <1 / non-numeric falls through to default", () => {
    expect(resolveSpawnConcurrency(undefined, { ATMUX_SPAWN_CONCURRENCY: "0" })).toBe(6);
    expect(resolveSpawnConcurrency(undefined, { ATMUX_SPAWN_CONCURRENCY: "abc" })).toBe(6);
    expect(resolveSpawnConcurrency(undefined, { ATMUX_SPAWN_CONCURRENCY: "" })).toBe(6);
  });

  test("opts override wins over env", () => {
    expect(resolveSpawnConcurrency(2, { ATMUX_SPAWN_CONCURRENCY: "9" })).toBe(2);
  });

  test("default is 6 (operating-point in the t-eb0887fe brief)", () => {
    expect(resolveSpawnConcurrency(undefined, {})).toBe(6);
  });
});

describe("runWithConcurrency", () => {
  test("empty items → no-op", async () => {
    let calls = 0;
    await runWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("cap=1 → strictly sequential (max in-flight === 1)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5];
    await runWithConcurrency(items, 1, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to event loop so concurrent calls would overlap.
      await new Promise<void>((res) => setTimeout(res, 5));
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(1);
  });

  test("cap=3 over 6 items → max in-flight bounded by cap, parallelism observed", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [0, 1, 2, 3, 4, 5];
    await runWithConcurrency(items, 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((res) => setTimeout(res, 10));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // parallelism proven
  });

  test("cap > items.length → effectively Promise.all, all items in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [0, 1, 2, 3];
    await runWithConcurrency(items, 999, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((res) => setTimeout(res, 10));
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(items.length);
  });

  test("every item processed exactly once + indices honoured", async () => {
    const seen: Array<{ item: number; index: number }> = [];
    const items = [10, 20, 30, 40, 50, 60];
    await runWithConcurrency(items, 2, async (item, index) => {
      seen.push({ item, index });
    });
    // Order may interleave under parallelism — sort by index for the equality check.
    seen.sort((a, b) => a.index - b.index);
    expect(seen).toEqual(items.map((item, index) => ({ item, index })));
  });

  test("errors propagate — Promise.all rejects on first failure", async () => {
    const items = [1, 2, 3];
    await expect(
      runWithConcurrency(items, 2, async (item) => {
        if (item === 2) throw new Error("boom on 2");
      }),
    ).rejects.toThrow(/boom on 2/);
  });
});
