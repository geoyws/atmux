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
type LoadCockpitFn = NonNullable<StartOpts["loadCockpitFn"]>;
type CockpitReconcileFn = NonNullable<StartOpts["cockpitReconcileFn"]>;

async function runStart(
  args: ReadonlyArray<string>,
  opts: {
    gitSpawn?: import("../../../src/abstractions/worktree.ts").GitSpawn;
    /** ADR-081 §C: brief-paste knobs — defaulted to fast/no-op for unit tests. */
    briefsDir?: string;
    spawnWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** ADR-063 ergonomic fix (t-ab8df0b4): cockpit reconcile injection. */
    loadCockpitFn?: LoadCockpitFn;
    cockpitReconcileFn?: CockpitReconcileFn;
    /** ADR-089 §D (t-7e7031dc): extra env keys merged on top of the
     *  default test env. Used to exercise ATMUX_NESTING_LEVEL / cockpit
     *  override / ATMUX_NO_CRON paths without polluting `process.env`. */
    extraEnv?: Record<string, string>;
  } = {},
): Promise<number> {
  const startOpts: StartOpts = {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir, ...(opts.extraEnv ?? {}) },
    cwd: env.atmuxDir,
    logger: env.logger,
    // ADR-063 default for the test harness: skip the cockpit reconcile
    // path UNLESS the test explicitly opts in. Without this, every
    // existing test would try to load `~/.atmux/cockpit.json` on the
    // dev host (varies per machine) and possibly succeed-with-noise.
    // Opt-in tests override `loadCockpitFn` to inject a fake roster.
    loadCockpitFn: async () => null,
  };
  if (opts.gitSpawn !== undefined) startOpts.gitSpawn = opts.gitSpawn;
  if (opts.briefsDir !== undefined) startOpts.briefsDir = opts.briefsDir;
  if (opts.spawnWaitMs !== undefined) startOpts.spawnWaitMs = opts.spawnWaitMs;
  if (opts.sleep !== undefined) startOpts.sleep = opts.sleep;
  if (opts.loadCockpitFn !== undefined) startOpts.loadCockpitFn = opts.loadCockpitFn;
  if (opts.cockpitReconcileFn !== undefined) startOpts.cockpitReconcileFn = opts.cockpitReconcileFn;
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

  test("applies the level-resolved cage prefix globally on the tmux server (ADR-089 §C)", async () => {
    // 2026-05-09 bisection — standalone `atmux start <team>` was NOT
    // applying the cage prefix that nested-tmux topology requires;
    // only `atmux cockpit rebuild` Phase 3 was. unum cages started
    // outside cockpit landed on default C-b. Fix: lift the helper from
    // cockpit.ts and call it after session creation in start.ts.
    //
    // Post-ADR-089 §C (t-7e7031dc): prefix is level-driven, not hard-
    // coded `C-\`. Without `ATMUX_NESTING_LEVEL` in env, the default
    // shifted 1→2 on 2026-05-24 (operator directive — "Fix code to
    // match ADR §C table"). Standalone start = top-level team cage =
    // L2 → resolvePrefix(2) === "F2" via DEFAULT_PREFIX_CHAIN.
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    const opts = await env.tmux.option.showOptions({ global: true });
    expect(opts.prefix).toBe("F2");
  });

  test("cage prefix is applied on incremental-restart path too (idempotent) (ADR-089 §C)", async () => {
    // The prefix-set is server-level; re-running start against an
    // existing session must not regress the prefix. Belt-and-braces
    // assertion that the helper runs in the warn-keep branch (no
    // --force, session already exists).
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    // Manually clobber the prefix to verify the second start re-applies.
    await env.tmux.option.setOption({ name: "prefix", value: "C-b", global: true });
    expect((await env.tmux.option.showOptions({ global: true })).prefix).toBe("C-b");
    await runStart([], { extraEnv: { ATMUX_NO_CRON: "1" } });
    // Default env (no ATMUX_NESTING_LEVEL) → L2 → F2 (see test above).
    expect((await env.tmux.option.showOptions({ global: true })).prefix).toBe("F2");
  });

  test("cage prefix honours ATMUX_NESTING_LEVEL env (level=2 → F2)", async () => {
    // ADR-089 §D: env-driven level selection. Child cages spawned by
    // a future spawn-epic verb will export ATMUX_NESTING_LEVEL=2 (via
    // childNestingEnv from src/core/cockpit.ts); start.ts must pick up
    // F2 from the default chain when that var is set.
    await writeTeamJson({ members: [{ name: "alice", role: "member" }] });
    await runStart([], {
      extraEnv: { ATMUX_NO_CRON: "1", ATMUX_NESTING_LEVEL: "2" },
    });
    expect((await env.tmux.option.showOptions({ global: true })).prefix).toBe("F2");
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

// ---------- start verb — ADR-044 driverSession topology ----------
//
// Bash parity: tests/unit/start_driver_session.bats covers the same
// matrix in the bash port. The bun port consumes `team.driverSession`
// to spawn `driver` as window 1 in place of the `__home` placeholder;
// members append as windows 2..N+1 via the existing loop.

describe("start — ADR-044 driverSession topology", () => {
  test("configured: driver is window 1 in declarative order, no __home placeholder", async () => {
    await writeTeamJson({
      members: [
        { name: "alpha", role: "team-lead", tui: "shell" },
        { name: "bee", role: "member", tui: "shell" },
      ],
      driverSession: { tui: "shell" },
    });

    const exit = await runStart([]);
    expect(exit).toBe(0);

    const session = `atmux-${env.team}`;
    const wins = await env.tmux.window.listWindows(session);
    // Sort by index to assert positional order — listWindows returns
    // the natural tmux order but tests are clearer with explicit sort.
    const ordered = [...wins].sort((a, b) => a.index - b.index);
    expect(ordered[0]?.name).toBe("driver");
    // Members emoji-prefixed by role: team-lead → 🧭, member → 🐝.
    expect(ordered[1]?.name).toBe("🧭_alpha");
    expect(ordered[2]?.name).toBe("🐝-bee");
    // No __home placeholder ever created.
    expect(wins.some((w) => w.name === `__${env.team}__home`)).toBe(false);

    // Logger surfaces the driver-at-window-1 marker for parity with bash
    // `lib/start.sh:203` ("driver at window 1, <tui>").
    expect(
      env.logs.some(
        (l) => l.kind === "ok" && l.msg.includes("driver at window 1") && l.msg.includes("shell"),
      ),
    ).toBe(true);
  });

  test("configured: tui falls back to driverTui when driverSession.tui is null", async () => {
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      // driverSession is configured (truthy) but its tui is null —
      // resolution drops to driverTui (legacy field).
      driverSession: { tui: null },
      driverTui: "shell",
    });

    const exit = await runStart([]);
    expect(exit).toBe(0);

    expect(
      env.logs.some(
        (l) => l.kind === "ok" && l.msg.includes("driver at window 1") && l.msg.includes("shell"),
      ),
    ).toBe(true);
  });

  test("explicitly disabled: driverSession=null falls through to legacy __home", async () => {
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      // Matches the wizard's "explicitly disabled" output. The field is
      // present but null — must NOT trigger the driver-initial path.
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
    // still leave the __home placeholder, matching the pre-ADR-044
    // "happy path: zero-member team" assertion.
    await writeTeamJson({ members: [] });
    const exit = await runStart([]);
    expect(exit).toBe(0);
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.map((w) => w.name)).toEqual([`__${env.team}__home`]);
  });

  test("unknown tui: driver window still created, warn surfaces, pane lands in shell", async () => {
    // ADR-239 §A1 (amended 2026-05-26) behavior change vs original
    // ADR-044: when resolveTuiCommand throws on an unknown tui, the
    // driver window IS still created (cwd + name), but with NO
    // shellCommand — the pane lands in the default $SHELL. Operator
    // can launch the TUI manually. This is the same fall-through as
    // shell-kind TUIs (no command, just a shell pane).
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      driverSession: { tui: "this-tui-does-not-exist-anywhere" },
    });

    const exit = await runStart([]);
    expect(exit).toBe(0);

    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    // Driver window IS present — the resolve-failure does NOT block
    // session creation under ADR-239 §A1.
    expect(wins.some((w) => w.name === "driver")).toBe(true);
    // No __home placeholder either — driver creates the session.
    expect(wins.some((w) => w.name === `__${env.team}__home`)).toBe(false);
    // Warn line surfaces the resolve-failure reason for operator
    // observability.
    expect(
      env.logs.some(
        (l) =>
          l.kind === "warn" &&
          l.msg.includes("driver") &&
          l.msg.includes("could not resolve command"),
      ),
    ).toBe(true);
  });

  test("incremental: existing session without driver is left alone (ADR-044 D3)", async () => {
    // ADR-044 D3 explicitly forbids retroactively inserting a driver into
    // an existing session — that would shift member window indices and
    // disrupt operator state on attached sessions.
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
    // Closes the pre-ADR-044 coverage gap on the member spawn loop's
    // send-keys branch (start.ts:466,471-480). Uses team.tuiCommands to
    // register a benign no-op so resolveTuiCommand returns a valid
    // command for a non-built-in tui kind.
    const body = {
      name: env.team,
      members: [{ name: "alpha", role: "team-lead", tui: "fake-member-tui" }],
      tuiCommands: { "fake-member-tui": "true" },
    };
    await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");

    // ADR-081 §C: default briefsDir resolves to the repo's
    // templates/briefs/lead.md which exists — without the no-op sleep
    // override, every existing non-shell-tui test would now block 6s
    // on the brief paste settle. The send-keys assertion below doesn't
    // care about brief paste; opt out via spawnWaitMs:0 + no-op sleep.
    const exit = await runStart([], {
      spawnWaitMs: 0,
      sleep: async () => {},
    });
    expect(exit).toBe(0);

    // Member window present — the send-keys path didn't throw.
    const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
    expect(wins.map((w) => w.name)).toContain("🧭_alpha");
  });

  test("non-shell tui: shellCommand-mode launch keeps the pane alive after TUI exits (ADR-239 §A5 wrap)", async () => {
    // Under ADR-239 §A5 the legacy send-keys-after-newSession path is
    // GONE — replaced with shellCommand-mode launch on `tmux new-session`.
    // For non-shell TUIs the resolved cmd is wrapped via
    // `sh -c '<cmd>; exec $SHELL -i'` so the pane drops to an
    // interactive shell when the TUI exits (otherwise the pane would
    // die when `true` returns, killing the session before members can
    // attach).
    const body = {
      name: env.team,
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      driverSession: { tui: "fake-driver" },
      tuiCommands: { "fake-driver": "true" },
    };
    await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");

    const exit = await runStart([]);
    expect(exit).toBe(0);

    const session = `atmux-${env.team}`;
    const wins = await env.tmux.window.listWindows(session);
    const ordered = [...wins].sort((a, b) => a.index - b.index);
    expect(ordered[0]?.name).toBe("driver");
    // The driver-at-window-1 marker still surfaces with the fake tui.
    expect(
      env.logs.some(
        (l) =>
          l.kind === "ok" && l.msg.includes("driver at window 1") && l.msg.includes("fake-driver"),
      ),
    ).toBe(true);
    // Member window also survived — proves the driver pane didn't die
    // and take the session with it (the wrap kept the shell alive).
    expect(wins.map((w) => w.name)).toContain("🧭_alpha");
  });

  test("--force with driverSession: driver-initial path runs after kill", async () => {
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
    });
    // First start without driverSession — legacy __home path.
    expect(await runStart([])).toBe(0);

    // Add driverSession then --force restart — kill + recreate hits the
    // driver-initial branch.
    await writeTeamJson({
      members: [{ name: "alpha", role: "team-lead", tui: "shell" }],
      driverSession: { tui: "shell" },
    });
    env.logs.length = 0;
    expect(await runStart(["--force"])).toBe(0);

    const session = `atmux-${env.team}`;
    const wins = await env.tmux.window.listWindows(session);
    const ordered = [...wins].sort((a, b) => a.index - b.index);
    expect(ordered[0]?.name).toBe("driver");
    expect(ordered[1]?.name).toBe("🧭_alpha");
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

// ---------- start — ADR-081 §C brief-paste ----------

describe("start — ADR-081 §C brief-paste", () => {
  /** Seed a temp briefs directory with the canonical files. Returns the path. */
  async function seedBriefsDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "atmux-briefs-"));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf8");
    }
    return dir;
  }

  /** Capture-pane helper — concatenates the visible buffer of a window. */
  async function capture(session: string, win: string): Promise<string> {
    return await env.tmux.pane.capturePane({
      target: `${session}:${win}`,
      start: -200,
    });
  }

  test("happy path: brief renders + paste-buffer + C-m submit lands in pane", async () => {
    // Use `cat` as the TUI so the brief gets echoed back into the pane —
    // that's the cheapest way to assert the paste-buffer + C-m chain
    // actually delivered bytes through tmux. Real TUIs (claude, opencode)
    // would render their own UI which is unobservable; `cat` is a
    // transparent passthrough.
    const briefsDir = await seedBriefsDir({
      "member.md": "Hello {{MEMBER}} on team {{TEAM}} (role={{ROLE}}, dir={{ATMUX_DIR}})\n",
    });
    try {
      const body = {
        name: env.team,
        members: [{ name: "alpha", role: "member", tui: "fake-tui" }],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      const exit = await runStart([], {
        briefsDir,
        spawnWaitMs: 50, // brief settle for cat to be reading stdin
        sleep: async (ms) =>
          new Promise<void>((res) => {
            setTimeout(res, ms);
          }),
      });
      expect(exit).toBe(0);

      // Allow C-m + cat's echo to make it to the pane buffer.
      await new Promise<void>((res) => setTimeout(res, 200));
      const pane = await capture(`atmux-${env.team}`, "🐝-alpha");
      expect(pane).toContain("Hello alpha on team");
      expect(pane).toContain(env.team);
      expect(pane).toContain("role=member");
      expect(pane).toContain(env.atmuxDir);

      // Logger surfaces a per-member paste line for observability.
      expect(
        env.logs.some(
          (l) => l.kind === "log" && l.msg.includes("alpha:") && l.msg.includes("brief pasted"),
        ),
      ).toBe(true);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("alias map: role=team-lead resolves to lead.md (not team-lead.md)", async () => {
    // §B BRIEF_ALIASES — role-canonical → file-canonical. Lead reads from
    // lead.md even if `team-lead.md` is missing. Reuse §B's existing
    // alias coverage so the §C port doesn't regress the alias chain.
    const briefsDir = await seedBriefsDir({
      "lead.md": "LEAD-BRIEF-FOR-{{MEMBER}}\n",
      "member.md": "MEMBER-BRIEF-FOR-{{MEMBER}}\n",
    });
    try {
      const body = {
        name: env.team,
        members: [{ name: "lead1", role: "team-lead", tui: "fake-tui" }],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      await runStart([], {
        briefsDir,
        spawnWaitMs: 50,
        sleep: async (ms) =>
          new Promise<void>((res) => {
            setTimeout(res, ms);
          }),
      });
      await new Promise<void>((res) => setTimeout(res, 200));
      const pane = await capture(`atmux-${env.team}`, "🧭_lead1");
      expect(pane).toContain("LEAD-BRIEF-FOR-lead1");
      expect(pane).not.toContain("MEMBER-BRIEF-FOR-lead1");
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("missing role brief falls back to member.md", async () => {
    // No `unblocker.md` in the briefs dir → role=unblocker reads member.md
    // (parity with rotate.getBriefPath fallback).
    const briefsDir = await seedBriefsDir({
      "member.md": "FALLBACK-FOR-{{ROLE}}\n",
    });
    try {
      const body = {
        name: env.team,
        members: [{ name: "u1", role: "unblocker", tui: "fake-tui" }],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      await runStart([], {
        briefsDir,
        spawnWaitMs: 50,
        sleep: async (ms) =>
          new Promise<void>((res) => {
            setTimeout(res, ms);
          }),
      });
      await new Promise<void>((res) => setTimeout(res, 200));
      // unblocker pool starts with 🔓 (common.ts:ROLE_EMOJI_POOLS).
      // ADR-135 §D3: hyphen separator between emoji and member name.
      const pane = await capture(`atmux-${env.team}`, "🔓-u1");
      expect(pane).toContain("FALLBACK-FOR-unblocker");
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("brief-paste skipped silently when both role + member.md are missing", async () => {
    // Empty briefs dir → getBriefPath returns <briefsDir>/member.md which
    // doesn't exist. Per parity with bash (`[[ -f "$brief" ]]` guard) we
    // skip silently — no warn, no throw. The pane should still be alive.
    const briefsDir = await seedBriefsDir({});
    try {
      const body = {
        name: env.team,
        members: [{ name: "alpha", role: "member", tui: "fake-tui" }],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      const exit = await runStart([], {
        briefsDir,
        spawnWaitMs: 0,
        sleep: async () => {},
      });
      expect(exit).toBe(0);
      // No "brief pasted" log, no warn line about paste failing.
      expect(env.logs.some((l) => l.msg.includes("brief pasted"))).toBe(false);
      expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("brief paste failed"))).toBe(
        false,
      );
      // Pane still exists — team didn't wedge from the no-op brief path.
      const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
      expect(wins.map((w) => w.name)).toContain("🐝-alpha");
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("shell-only TUI: brief is NOT pasted (bash parity for tui=shell)", async () => {
    // Bash `_atmux_spawn_member` gates the brief paste on `tui != shell`.
    // Same gate in TS — driver-shell teams never see a brief in the pane.
    const briefsDir = await seedBriefsDir({
      "member.md": "SHELL-BRIEF-FOR-{{MEMBER}}\n",
    });
    try {
      await writeTeamJson({
        members: [{ name: "alpha", role: "member", tui: "shell" }],
      });

      const exit = await runStart([], {
        briefsDir,
        spawnWaitMs: 0,
        sleep: async () => {},
      });
      expect(exit).toBe(0);
      expect(env.logs.some((l) => l.msg.includes("brief pasted"))).toBe(false);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("per-member best-effort: one member's brief failure does NOT wedge the others", async () => {
    // Failure surface: read-error inside pasteBriefForMember — simulate
    // by giving one member a tui that resolves but pointing briefsDir at
    // a path containing a brief file with restricted perms. Cheapest
    // simulation: stage a member.md that's a directory, not a file →
    // `Bun.file().text()` throws. The OTHER member should still get
    // paste + log.
    const briefsDir = await mkdtemp(join(tmpdir(), "atmux-briefs-"));
    try {
      // For alpha (role=team-lead) we want a working lead.md.
      await writeFile(join(briefsDir, "lead.md"), "LEAD-BRIEF-FOR-{{MEMBER}}\n", "utf8");
      // For bob (role=member) we point member.md at a DIRECTORY so the
      // read throws. The §C catch-and-warn must absorb it.
      await mkdir(join(briefsDir, "member.md"), { recursive: true });

      const body = {
        name: env.team,
        members: [
          { name: "alpha", role: "team-lead", tui: "fake-tui" },
          { name: "bob", role: "member", tui: "fake-tui" },
        ],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      const exit = await runStart([], {
        briefsDir,
        spawnWaitMs: 50,
        sleep: async (ms) =>
          new Promise<void>((res) => {
            setTimeout(res, ms);
          }),
      });
      expect(exit).toBe(0);

      // Lead's brief landed.
      await new Promise<void>((res) => setTimeout(res, 200));
      const leadPane = await capture(`atmux-${env.team}`, "🧭_alpha");
      expect(leadPane).toContain("LEAD-BRIEF-FOR-alpha");

      // Bob's brief failed → warn line.
      const warns = env.logs.filter((l) => l.kind === "warn");
      expect(warns.some((l) => l.msg.includes("bob") && l.msg.includes("brief paste failed"))).toBe(
        true,
      );

      // Both panes exist — team didn't half-spawn.
      const wins = await env.tmux.window.listWindows(`atmux-${env.team}`);
      const names = wins.map((w) => w.name);
      expect(names).toContain("🧭_alpha");
      expect(names).toContain("🐝-bob");
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("incremental restart: existing windows are NOT re-pasted (skip-existing)", async () => {
    // Brief paste is gated inside the `existingNames.has(win)` continue
    // branch — re-running start against a live session must not double-
    // paste briefs into already-spawned panes.
    const briefsDir = await seedBriefsDir({
      "member.md": "BRIEF-FOR-{{MEMBER}}\n",
    });
    try {
      const body = {
        name: env.team,
        members: [{ name: "alpha", role: "member", tui: "fake-tui" }],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      // First run — brief paste happens.
      const firstExit = await runStart([], {
        briefsDir,
        spawnWaitMs: 0,
        sleep: async () => {},
      });
      expect(firstExit).toBe(0);
      const firstPasted = env.logs.filter((l) => l.msg.includes("brief pasted")).length;
      expect(firstPasted).toBe(1);

      // Second run — incremental, no --force. Window exists, brief NOT
      // re-pasted.
      env.logs.length = 0;
      const secondExit = await runStart([], {
        briefsDir,
        spawnWaitMs: 0,
        sleep: async () => {},
      });
      expect(secondExit).toBe(0);
      const secondPasted = env.logs.filter((l) => l.msg.includes("brief pasted")).length;
      expect(secondPasted).toBe(0);
      expect(env.logs.some((l) => l.msg.includes("window exists, skipping"))).toBe(true);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });

  test("zero spawnWaitMs: brief paste fires immediately (test-fast path)", async () => {
    // Verifies the test injection actually skips the 6s default — important
    // because every other test in the §C suite uses 0 or 50ms. Regression
    // guard against accidentally reverting the override to "always sleep".
    const briefsDir = await seedBriefsDir({
      "member.md": "FAST-{{MEMBER}}\n",
    });
    try {
      const body = {
        name: env.team,
        members: [{ name: "alpha", role: "member", tui: "fake-tui" }],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );
      const t0 = Date.now();
      await runStart([], {
        briefsDir,
        spawnWaitMs: 0,
        sleep: async () => {},
      });
      const elapsed = Date.now() - t0;
      // Generous bound — real tmux ops + bun startup eat ~hundreds of
      // ms, but nothing close to 6s should happen here.
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
  });
});

// ---------- ADR-063 ergonomic fix: auto-reconcile cockpit (t-ab8df0b4) ----------

describe("start — ADR-063 cockpit auto-reconcile", () => {
  // Type aliases for the reconcile recorder.
  type ReconcileRecord = {
    sessionName: string;
    teamNames: string[];
    onlyTeam: string | undefined;
  };
  type Cockpit = Awaited<ReturnType<LoadCockpitFn>>;

  function makeReconcileRecorder(): {
    fn: CockpitReconcileFn;
    calls: ReconcileRecord[];
  } {
    const calls: ReconcileRecord[] = [];
    const fn: CockpitReconcileFn = async (
      _tmux,
      sessionName,
      teams,
      _logger,
      _deps,
      _superdoctor,
      _yes,
      reconcileOpts,
    ) => {
      calls.push({
        sessionName,
        teamNames: teams.map((t) => t.name),
        onlyTeam: reconcileOpts?.onlyTeam,
      });
    };
    return { fn, calls };
  }

  function fakeCockpit(opts: {
    teams: Array<{ name: string; enabled: boolean }>;
    cockpitSession?: string;
  }): Cockpit {
    // Per ADR-089 §B the canonical cockpit shape is `sessions: [...]`
    // (hierarchical, discriminated union). The real loader (`loadCockpit`)
    // runs `migrateLegacyShape` to lift legacy flat `teams[]` into
    // `sessions[]` BEFORE parsing — so post-loader cockpit objects always
    // carry `sessions[]`. The fake bypasses the loader, so it emits
    // `sessions[]` directly to match what consumers (e.g. `enabledTeams`
    // via `walkSessions`) actually iterate. The legacy duck-typed `teams`
    // field is also populated for back-compat readers that still see the
    // post-enrichment synthesised array.
    const teamEntries = opts.teams.map((t) => ({
      type: "team" as const,
      name: t.name,
      root: `/tmp/${t.name}-root`,
      enabled: t.enabled,
      sessions: [] as never[],
    }));
    return {
      cockpitSession: opts.cockpitSession ?? "atmux_teams",
      sessions: teamEntries,
      teams: teamEntries.map(({ name, root, enabled }) => ({ name, root, enabled })),
    } as unknown as Cockpit;
  }

  test("(a) rostered + enabled team → reconcile called with onlyTeam scope", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const { fn: reconcileFn, calls } = makeReconcileRecorder();
    const loadCockpitFn = async () => fakeCockpit({ teams: [{ name: env.team, enabled: true }] });

    const exit = await runStart([], { loadCockpitFn, cockpitReconcileFn: reconcileFn });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.onlyTeam).toBe(env.team);
    expect(calls[0]!.teamNames).toEqual([env.team]);
    expect(calls[0]!.sessionName).toBe("atmux_teams");
    // ✓ log line emitted on success.
    expect(env.logs.some((l) => l.msg.includes("cockpit window") && l.msg.includes(env.team))).toBe(
      true,
    );
  });

  test("(b) team NOT in roster → reconcile NOT called (silent skip)", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const { fn: reconcileFn, calls } = makeReconcileRecorder();
    // Roster has a different team name; our cwd team is un-rostered.
    const loadCockpitFn = async () =>
      fakeCockpit({ teams: [{ name: "some-other-team", enabled: true }] });

    const exit = await runStart([], { loadCockpitFn, cockpitReconcileFn: reconcileFn });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(0);
    // No WARN, no cockpit log line — silent skip.
    expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("cockpit"))).toBe(false);
  });

  test("(c) cockpit.json missing (loader returns null) → reconcile NOT called", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const { fn: reconcileFn, calls } = makeReconcileRecorder();
    const loadCockpitFn = async () => null;

    const exit = await runStart([], { loadCockpitFn, cockpitReconcileFn: reconcileFn });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(0);
    // No WARN — missing config is silent skip per the behaviour matrix.
    expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("cockpit"))).toBe(false);
  });

  test("(d) team rostered but enabled:false → reconcile NOT called (silent skip)", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const { fn: reconcileFn, calls } = makeReconcileRecorder();
    const loadCockpitFn = async () => fakeCockpit({ teams: [{ name: env.team, enabled: false }] });

    const exit = await runStart([], { loadCockpitFn, cockpitReconcileFn: reconcileFn });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("(e) cockpit loader throws (malformed) → reconcile NOT called, WARN logged", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const { fn: reconcileFn, calls } = makeReconcileRecorder();
    const loadCockpitFn = async () => {
      throw new Error("cockpit.json: unexpected token at line 5");
    };

    const exit = await runStart([], { loadCockpitFn, cockpitReconcileFn: reconcileFn });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(0);
    // WARN emitted — distinct from silent skip.
    expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("loader threw"))).toBe(true);
  });

  test("reconcile throw is non-fatal — start still returns 0 with WARN", async () => {
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const loadCockpitFn = async () => fakeCockpit({ teams: [{ name: env.team, enabled: true }] });
    const cockpitReconcileFn: CockpitReconcileFn = async () => {
      throw new Error("tmux server unreachable on default socket");
    };

    const exit = await runStart([], { loadCockpitFn, cockpitReconcileFn });
    expect(exit).toBe(0);
    expect(
      env.logs.some(
        (l) =>
          l.kind === "warn" &&
          l.msg.includes("cockpit reconcile failed") &&
          l.msg.includes(env.team),
      ),
    ).toBe(true);
  });

  test("default loadCockpitFn (production path) — no cockpit.json on dev host → silent skip", async () => {
    // The harness defaults loadCockpitFn to `async () => null` to keep
    // existing tests host-independent; this test asserts the real
    // default is host-agnostic too (no cockpit.json should mean silent
    // skip, not a thrown error).
    await writeTeamJson({
      members: [{ name: "alice", role: "team-lead" }],
    });
    const { fn: reconcileFn, calls } = makeReconcileRecorder();
    // Force ATMUX_COCKPIT_CONFIG to a non-existent path so loadCockpit
    // hits its ConfigError branch → null.
    const exit = await start(["--socket-path", env.socketPath], {
      env: {
        ...process.env,
        ATMUX_DIR: env.atmuxDir,
        ATMUX_COCKPIT_CONFIG: "/tmp/atmux-nonexistent-cockpit-config.json",
      },
      cwd: env.atmuxDir,
      logger: env.logger,
      cockpitReconcileFn: reconcileFn,
    });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(0);
    expect(env.logs.some((l) => l.kind === "warn" && l.msg.includes("cockpit"))).toBe(false);
  });
});

// ---------- t-eb0887fe: parallelized member spawn ----------

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

describe("start — t-eb0887fe parallelized member spawn", () => {
  test("lead spawns sequentially FIRST; teammates fan out in parallel", async () => {
    // Wire an instrumented sleep so we can observe parallelism. The
    // brief-paste path awaits `sleep(spawnWaitMs)` exactly once per
    // non-shell member — we hook that to record (member, ts) at the
    // sleep boundary AND track max in-flight via a counter that
    // increments on entry + decrements on exit. The lead's slot
    // must complete BEFORE any teammate's slot starts.
    const events: Array<{ member: string; kind: "enter" | "exit"; t: number }> = [];
    const t0 = Date.now();
    let inFlight = 0;
    let maxInFlight = 0;
    const SLEEP_MS = 80;

    // Pull the member name out of the `cwd` we set per-member. The
    // brief-paste path calls sleep with the spawnWaitMs constant, not
    // the member name — but the closure runs in member-spawn order
    // so we trace by call-sequence + the most recent log line.
    const nextMember = "";
    const trace = async (ms: number): Promise<void> => {
      // tag this sleep call with the current "in-flight" member by
      // peeking at the latest "spawned window <emoji>-<name>" log line.
      const latest = env.logs[env.logs.length - 1];
      // ADR-161 TR2: default-role members render `_-prefix`; user-added
      // members keep hyphen. Match either separator.
      const winLine = latest?.msg.match(/spawned window 🐝[-_](\S+)/);
      const member = winLine?.[1] ?? nextMember;
      events.push({ member, kind: "enter", t: Date.now() - t0 });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((res) => setTimeout(res, ms));
      inFlight -= 1;
      events.push({ member, kind: "exit", t: Date.now() - t0 });
    };

    const briefsDir = await mkdtemp(join(tmpdir(), "atmux-briefs-par-"));
    await writeFile(join(briefsDir, "lead.md"), "lead {{MEMBER}}\n", "utf8");
    await writeFile(join(briefsDir, "member.md"), "member {{MEMBER}}\n", "utf8");

    try {
      const body = {
        name: env.team,
        members: [
          { name: "alpha", role: "team-lead", emoji: "🐝", tui: "fake-tui" },
          { name: "beta", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "gamma", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "delta", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "epsilon", role: "member", emoji: "🐝", tui: "fake-tui" },
        ],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      const exit = await runStart([], {
        briefsDir,
        spawnWaitMs: SLEEP_MS,
        sleep: trace,
      });
      expect(exit).toBe(0);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }

    // Six sleep entries: one per non-shell member spawn-wait + one
    // per post-paste settle inside submitAfterPaste (per ADR-081 §A).
    // Just check the parallelism shape: at least 2 sleeps overlapped.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);

    // Lead's spawn-wait MUST exit before the second teammate enters
    // its spawn-wait — proves the lead-first-sequential contract.
    const leadExit = events.find((e) => e.member === "alpha" && e.kind === "exit");
    expect(leadExit).toBeDefined();
    const teammateEntries = events.filter(
      (e) => e.kind === "enter" && e.member !== "alpha" && e.member !== "",
    );
    // Every teammate's enter happens AT OR AFTER the lead's exit time.
    for (const ent of teammateEntries) {
      expect(ent.t).toBeGreaterThanOrEqual(leadExit!.t - 1); // -1ms timing slack
    }
  });

  test("opts.spawnConcurrency=1 restores legacy sequential behaviour", async () => {
    // Verify the cap-of-1 escape hatch via runWithConcurrency: when
    // tests / operators need byte-equivalent legacy ordering, cap=1
    // serializes the fan-out. We observe via the same sleep trace.
    let inFlight = 0;
    let maxInFlight = 0;
    const SLEEP_MS = 40;

    const briefsDir = await mkdtemp(join(tmpdir(), "atmux-briefs-seq-"));
    await writeFile(join(briefsDir, "lead.md"), "lead\n", "utf8");
    await writeFile(join(briefsDir, "member.md"), "member\n", "utf8");

    try {
      const body = {
        name: env.team,
        members: [
          { name: "alpha", role: "team-lead", emoji: "🐝", tui: "fake-tui" },
          { name: "beta", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "gamma", role: "member", emoji: "🐝", tui: "fake-tui" },
        ],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      // Pass spawnConcurrency=1 via StartOpts. runStart wraps args
      // but doesn't forward arbitrary opts; we mirror the wrap-path
      // by calling start() directly with the per-test socket flag.
      const exit = await start(["--socket-path", env.socketPath], {
        env: { ...process.env, ATMUX_DIR: env.atmuxDir },
        cwd: env.atmuxDir,
        logger: env.logger,
        loadCockpitFn: async () => null,
        briefsDir,
        spawnWaitMs: SLEEP_MS,
        spawnConcurrency: 1,
        sleep: async (ms) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((res) => setTimeout(res, ms));
          inFlight -= 1;
        },
      });
      expect(exit).toBe(0);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
    // Under cap=1 the teammate fan-out collapses back to one-at-a-
    // time; combined with the always-sequential lead phase, max
    // in-flight stays at 1 across the entire spawn loop.
    expect(maxInFlight).toBe(1);
  });

  test("lead-less team → all members fan out from the start", async () => {
    // No `team-lead` role anywhere — the `leadMember = ...find(...)`
    // returns undefined, the sequential prelude is skipped, and the
    // entire roster spawns through `runWithConcurrency`.
    let inFlight = 0;
    let maxInFlight = 0;
    const SLEEP_MS = 50;

    const briefsDir = await mkdtemp(join(tmpdir(), "atmux-briefs-leadless-"));
    await writeFile(join(briefsDir, "member.md"), "member\n", "utf8");

    try {
      const body = {
        name: env.team,
        members: [
          { name: "alpha", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "beta", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "gamma", role: "member", emoji: "🐝", tui: "fake-tui" },
          { name: "delta", role: "member", emoji: "🐝", tui: "fake-tui" },
        ],
        tuiCommands: { "fake-tui": "cat" },
      };
      await writeFile(
        join(env.atmuxDir, "team.json"),
        `${JSON.stringify(body, null, 2)}\n`,
        "utf8",
      );

      const exit = await runStart([], {
        briefsDir,
        spawnWaitMs: SLEEP_MS,
        sleep: async (ms) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((res) => setTimeout(res, ms));
          inFlight -= 1;
        },
      });
      expect(exit).toBe(0);
    } finally {
      await rm(briefsDir, { recursive: true, force: true });
    }
    // Default cap is 6; all 4 members fit and fan out together.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});
