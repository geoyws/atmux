// Unit tests for src/verbs/cockpit.ts — ADR-063 cockpit verb.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { CockpitTeam } from "../../../src/schema/cockpit.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  applyCagePrefix,
  autolaunchTeam,
  buildMigrationBreadcrumb,
  buildTeamWindowCommand,
  type CapturedCockpitWindow,
  cageAlive,
  cockpitAttach,
  cockpitMigrateSocket,
  cockpitRebuild,
  LEGACY_COCKPIT_SESSION_NAMES,
  normaliseTeamJson,
  type ParsedCockpitArgs,
  parseCockpitArgs,
  type ResolveTeamWindowDeps,
  reconcileCockpitSession,
  resolveTeamWindowMode,
} from "../../../src/verbs/cockpit.ts";

// ---------- parseCockpitArgs ----------

describe("parseCockpitArgs", () => {
  test("rejects empty argv with hint", () => {
    expect(() => parseCockpitArgs([])).toThrow(UsageError);
  });
  test("rejects unknown sub-verb", () => {
    expect(() => parseCockpitArgs(["frobnicate"])).toThrow(UsageError);
  });
  test("bare rebuild parses with all-false flags", () => {
    const p = parseCockpitArgs(["rebuild"]);
    expect(p).toEqual({
      subverb: "rebuild",
      noCycle: false,
      forceCycle: false,
      ackDangerous: false,
      noLaunch: false,
      yes: false,
      dryRun: false,
      keepLegacy: false,
    });
  });
  test("each flag parses individually", () => {
    expect(parseCockpitArgs(["rebuild", "--no-cycle"]).noCycle).toBe(true);
    expect(
      parseCockpitArgs([
        "rebuild",
        "--force-cycle",
        "--acknowledge-dangerous-bau-interruption",
        "--yes",
      ]).forceCycle,
    ).toBe(true);
    expect(parseCockpitArgs(["rebuild", "--no-launch"]).noLaunch).toBe(true);
  });
  test("--config requires a value", () => {
    expect(() => parseCockpitArgs(["rebuild", "--config"])).toThrow(UsageError);
    expect(parseCockpitArgs(["rebuild", "--config", "/p"]).configPath).toBe("/p");
  });
  test("--no-cycle and --force-cycle are mutually exclusive", () => {
    expect(() =>
      parseCockpitArgs([
        "rebuild",
        "--no-cycle",
        "--force-cycle",
        "--acknowledge-dangerous-bau-interruption",
        "--yes",
      ]),
    ).toThrow(UsageError);
  });
  // 2026-05-12 incident: --force-cycle was used to refresh viewer attach
  // paths and inadvertently nuked ~30 members' claude TUI contexts across
  // atmux + sopx. The ack-flag is the safety gate.
  test("--force-cycle without ack flag throws (operator must acknowledge)", () => {
    expect(() => parseCockpitArgs(["rebuild", "--force-cycle"])).toThrow(UsageError);
  });
  test("--force-cycle with ack flag parses + both fields set", () => {
    const p = parseCockpitArgs([
      "rebuild",
      "--force-cycle",
      "--acknowledge-dangerous-bau-interruption",
      "--yes",
    ]);
    expect(p.forceCycle).toBe(true);
    expect(p.ackDangerous).toBe(true);
  });
  test("--acknowledge-dangerous-bau-interruption alone (without --force-cycle) is harmless", () => {
    const p = parseCockpitArgs(["rebuild", "--acknowledge-dangerous-bau-interruption"]);
    expect(p.forceCycle).toBe(false);
    expect(p.ackDangerous).toBe(true);
  });
  // ADR-077 §D6 follow-on: reload alias.
  test("reload alias parses with noCycle + noLaunch implicit", () => {
    const p = parseCockpitArgs(["reload"]);
    expect(p).toEqual({
      subverb: "reload",
      noCycle: true,
      forceCycle: false,
      ackDangerous: false,
      noLaunch: true,
      yes: false,
      dryRun: false,
      keepLegacy: false,
    });
  });

  test("reload + --no-cycle redundant flag rejected", () => {
    expect(() => parseCockpitArgs(["reload", "--no-cycle"])).toThrow(UsageError);
  });

  test("reload + --no-launch redundant flag rejected", () => {
    expect(() => parseCockpitArgs(["reload", "--no-launch"])).toThrow(UsageError);
  });

  test("reload + --force-cycle incompatible — rejected", () => {
    expect(() => parseCockpitArgs(["reload", "--force-cycle"])).toThrow(UsageError);
  });

  test("reload + --config <path> still accepted", () => {
    const p = parseCockpitArgs(["reload", "--config", "/p"]);
    expect(p.subverb).toBe("reload");
    expect(p.configPath).toBe("/p");
  });

  test("rejects unknown flag", () => {
    expect(() => parseCockpitArgs(["rebuild", "--bogus"])).toThrow(UsageError);
  });
});

// ---------- Logger fixture ----------

function makeLogger(): { logger: Logger; logs: string[] } {
  const logs: string[] = [];
  return {
    logger: {
      log: (m) => logs.push(`log: ${m}`),
      ok: (m) => logs.push(`ok: ${m}`),
      warn: (m) => logs.push(`warn: ${m}`),
      err: (m) => logs.push(`err: ${m}`),
    },
    logs,
  };
}

// ---------- normaliseTeamJson ----------

describe("normaliseTeamJson", () => {
  let projRoot: string;
  beforeEach(async () => {
    projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-norm-"));
    await mkdir(join(projRoot, ".atmux"), { recursive: true });
  });
  afterEach(async () => {
    await rm(projRoot, { recursive: true, force: true });
  });

  async function writeTeamJson(body: unknown): Promise<void> {
    await writeFile(join(projRoot, ".atmux", "team.json"), JSON.stringify(body, null, 2), "utf8");
  }

  test("sets bareWindowNames=true on a vanilla team.json", async () => {
    await writeTeamJson({ name: "x", members: [{ name: "lead", role: "team-lead" }] });
    const { logger } = makeLogger();
    await normaliseTeamJson({ name: "x", root: projRoot, enabled: true } as CockpitTeam, logger);
    const after = JSON.parse(await readFile(join(projRoot, ".atmux", "team.json"), "utf8"));
    expect(after.bareWindowNames).toBe(true);
    // No claudeAccount in cockpit entry → tuiCommands left untouched.
    expect(after.tuiCommands).toBeUndefined();
  });

  test("writes tuiCommands.claude when claudeAccount present", async () => {
    await writeTeamJson({ name: "x", members: [{ name: "lead", role: "team-lead" }] });
    const { logger } = makeLogger();
    await normaliseTeamJson(
      {
        name: "x",
        root: projRoot,
        enabled: true,
        claudeAccount: { configDir: "/root/.claude-ifca", label: "ifca" },
      } as CockpitTeam,
      logger,
    );
    const after = JSON.parse(await readFile(join(projRoot, ".atmux", "team.json"), "utf8"));
    expect(after.tuiCommands.claude).toContain("CLAUDE_CONFIG_DIR=/root/.claude-ifca");
    expect(after.tuiCommands.claude).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
    expect(after.tuiCommands.claude).toContain("--permission-mode auto");
  });

  test("honors tuiOverrides", async () => {
    await writeTeamJson({ name: "x", members: [{ name: "lead", role: "team-lead" }] });
    const { logger } = makeLogger();
    await normaliseTeamJson(
      {
        name: "x",
        root: projRoot,
        enabled: true,
        claudeAccount: { configDir: "/root/.claude-x" },
        tuiOverrides: {
          effortLevel: "high",
          permissionMode: "dontAsk",
          pluginDir: "/p/plugins",
        },
      } as CockpitTeam,
      logger,
    );
    const after = JSON.parse(await readFile(join(projRoot, ".atmux", "team.json"), "utf8"));
    expect(after.tuiCommands.claude).toContain("CLAUDE_CODE_EFFORT_LEVEL=high");
    expect(after.tuiCommands.claude).toContain("--permission-mode dontAsk");
    expect(after.tuiCommands.claude).toContain("--plugin-dir=/p/plugins");
  });

  test("preserves other tuiCommands entries when overwriting claude", async () => {
    await writeTeamJson({
      name: "x",
      members: [{ name: "lead", role: "team-lead" }],
      tuiCommands: { opencode: "opencode --model y", _comment: "preserved" },
    });
    const { logger } = makeLogger();
    await normaliseTeamJson(
      {
        name: "x",
        root: projRoot,
        enabled: true,
        claudeAccount: { configDir: "/root/.claude-x" },
      } as CockpitTeam,
      logger,
    );
    const after = JSON.parse(await readFile(join(projRoot, ".atmux", "team.json"), "utf8"));
    expect(after.tuiCommands.claude).toContain("CLAUDE_CONFIG_DIR=/root/.claude-x");
    expect(after.tuiCommands.opencode).toBe("opencode --model y");
    expect(after.tuiCommands._comment).toBe("preserved");
  });

  test("idempotent — re-running produces same content", async () => {
    await writeTeamJson({ name: "x", members: [{ name: "lead", role: "team-lead" }] });
    const { logger } = makeLogger();
    const team = {
      name: "x",
      root: projRoot,
      enabled: true,
      claudeAccount: { configDir: "/root/.claude-x" },
    } as CockpitTeam;
    await normaliseTeamJson(team, logger);
    const first = await readFile(join(projRoot, ".atmux", "team.json"), "utf8");
    await normaliseTeamJson(team, logger);
    const second = await readFile(join(projRoot, ".atmux", "team.json"), "utf8");
    expect(second).toBe(first);
  });
});

// ---------- Tmux integration tests ----------

interface TmuxFixture {
  tmux: TmuxNamespace;
  socketPath: string;
  socketDir: string;
}

// c-4698c603 defense — fixture-survivor registry. Every spinTmux'd
// socket + dir is tracked here; `tearDownFixtureSurvivors` is wired into
// `process.on('exit')` (once, lazily) plus `afterAll` at end-of-file so
// kill-server + dir-rm fire even when an individual test's try/finally
// is bypassed by a thrown error / unhandled rejection. The per-test
// finally blocks remain authoritative for happy-path cleanup;
// kill-server + rmSync are idempotent, so re-running on already-cleaned
// state is a no-op. SIGKILL on the bun-test process is unrecoverable
// (userland exit handlers don't fire) — CLAUDE.md's `bun test --timeout`
// + BashTool `timeout` discipline is the operator-side mitigation.
const activeFixtureSockets = new Set<string>();
const activeFixtureDirs = new Set<string>();
let fixtureExitHookRegistered = false;

function tearDownFixtureSurvivors(): void {
  for (const sock of activeFixtureSockets) {
    try {
      Bun.spawnSync(["tmux", "-S", sock, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {}
  }
  for (const dir of activeFixtureDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  activeFixtureSockets.clear();
  activeFixtureDirs.clear();
}

function registerFixtureExitHook(): void {
  if (fixtureExitHookRegistered) return;
  fixtureExitHookRegistered = true;
  process.on("exit", tearDownFixtureSurvivors);
}

async function spinTmux(prefix: string): Promise<TmuxFixture> {
  registerFixtureExitHook();
  const socketDir = await mkdtemp(join(tmpdir(), `atmux-cockpit-${prefix}-`));
  const socketPath = join(socketDir, "sock");
  const tmux = createTmux({ socketPath, configFile: "/dev/null" });
  activeFixtureSockets.add(socketPath);
  activeFixtureDirs.add(socketDir);
  return { tmux, socketPath, socketDir };
}

// c-4698c603 defense — final-sweep hook. Fires after every test in this
// file completes; idempotent w.r.t. the per-test try/finally + the
// process-exit hook above.
afterAll(() => {
  tearDownFixtureSurvivors();
});

let priorTmux: string | undefined;
beforeEach(() => {
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
});
afterEach(() => {
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
});

describe("autolaunchTeam", () => {
  test("returns zero counts when cage session doesn't exist", async () => {
    const fx = await spinTmux("autolaunch-no-session");
    let projRoot: string | undefined;
    try {
      projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-au-noses-"));
      await mkdir(join(projRoot, ".atmux"), { recursive: true });
      await writeFile(
        join(projRoot, ".atmux", "team.json"),
        JSON.stringify({ name: "x", members: [{ name: "lead" }] }),
        "utf8",
      );
      const { logger } = makeLogger();
      const summary = await autolaunchTeam(
        { name: "x", root: projRoot, enabled: true } as CockpitTeam,
        fx.tmux,
        {},
        logger,
        { skipReadinessProbe: true },
      );
      expect(summary).toEqual({ launched: 0, skipped: 0, unbootstrapped: [] });
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
      if (projRoot) await rm(projRoot, { recursive: true, force: true });
    }
  });

  test("sends launch command into bare-shell pane matching a member name", async () => {
    const fx = await spinTmux("autolaunch-real");
    let projRoot: string | undefined;
    try {
      projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-au-real-"));
      await mkdir(join(projRoot, ".atmux"), { recursive: true });
      await writeFile(
        join(projRoot, ".atmux", "team.json"),
        JSON.stringify({
          name: "demo",
          members: [{ name: "lead", role: "team-lead", tui: "shell" }],
        }),
        "utf8",
      );
      // Create the cage session with a window named after the member.
      // Cage session name for "demo" is "atmux_demo" per cageSessionName().
      await fx.tmux.session.newSession({
        name: "atmux_demo",
        detached: true,
        windowName: "lead",
      });
      const { logger } = makeLogger();
      const summary = await autolaunchTeam(
        { name: "demo", root: projRoot, enabled: true } as CockpitTeam,
        fx.tmux,
        {},
        logger,
        { skipReadinessProbe: true },
      );
      expect(summary.launched).toBe(1);
      expect(summary.skipped).toBe(0);
      expect(summary.unbootstrapped).toEqual([]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
      if (projRoot) await rm(projRoot, { recursive: true, force: true });
    }
  });

  // ---------- Readiness probe integration (t-47f4425f Stage A) ----------

  test("readiness probe fires once per launched member; ready results leave unbootstrapped empty", async () => {
    const fx = await spinTmux("autolaunch-probe-ready");
    let projRoot: string | undefined;
    try {
      projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-au-probe-ok-"));
      await mkdir(join(projRoot, ".atmux"), { recursive: true });
      await writeFile(
        join(projRoot, ".atmux", "team.json"),
        JSON.stringify({
          name: "px",
          members: [{ name: "lead", role: "team-lead", tui: "shell" }],
        }),
        "utf8",
      );
      await fx.tmux.session.newSession({
        name: "atmux_px",
        detached: true,
        windowName: "lead",
      });
      const probeCalls: string[] = [];
      const { logger, logs } = makeLogger();
      const summary = await autolaunchTeam(
        { name: "px", root: projRoot, enabled: true } as CockpitTeam,
        fx.tmux,
        {},
        logger,
        {
          readinessProbe: async (target, member) => {
            probeCalls.push(`${member}@${target}`);
            return {
              state: "ready",
              paneClassification: { state: "READY", evidence: "❯", capturedAt: 0 },
              evidence: "❯",
              elapsedMs: 12,
              attempts: 1,
            };
          },
        },
      );
      expect(summary.launched).toBe(1);
      expect(summary.unbootstrapped).toEqual([]);
      expect(probeCalls).toEqual(["lead@atmux_px:0"]);
      // No warning lines emitted on the happy path.
      expect(logs.filter((l) => l.startsWith("warn:"))).toEqual([]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
      if (projRoot) await rm(projRoot, { recursive: true, force: true });
    }
  });

  test("non-ready probe populates unbootstrapped + emits structured warning", async () => {
    const fx = await spinTmux("autolaunch-probe-starving");
    let projRoot: string | undefined;
    try {
      projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-au-probe-starve-"));
      await mkdir(join(projRoot, ".atmux"), { recursive: true });
      await writeFile(
        join(projRoot, ".atmux", "team.json"),
        JSON.stringify({
          name: "py",
          members: [{ name: "alpha", role: "member", tui: "shell" }],
        }),
        "utf8",
      );
      await fx.tmux.session.newSession({
        name: "atmux_py",
        detached: true,
        windowName: "alpha",
      });
      const { logger, logs } = makeLogger();
      const summary = await autolaunchTeam(
        { name: "py", root: projRoot, enabled: true } as CockpitTeam,
        fx.tmux,
        {},
        logger,
        {
          readinessProbe: async () => ({
            state: "starving",
            paneClassification: { state: "READY", evidence: "❯", capturedAt: 0 },
            evidence: "Welcome to Claude Code\n❯",
            elapsedMs: 1_500,
            attempts: 3,
          }),
        },
      );
      expect(summary.launched).toBe(1);
      expect(summary.unbootstrapped).toHaveLength(1);
      expect(summary.unbootstrapped[0]?.member).toBe("alpha");
      expect(summary.unbootstrapped[0]?.result.state).toBe("starving");
      const warnings = logs.filter((l) => l.startsWith("warn:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("alpha");
      expect(warnings[0]).toContain("starving");
      expect(warnings[0]).toContain("Welcome to Claude Code");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
      if (projRoot) await rm(projRoot, { recursive: true, force: true });
    }
  });

  test("probe-throw is caught + logged as a warning, loop continues", async () => {
    const fx = await spinTmux("autolaunch-probe-throw");
    let projRoot: string | undefined;
    try {
      projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-au-probe-throw-"));
      await mkdir(join(projRoot, ".atmux"), { recursive: true });
      await writeFile(
        join(projRoot, ".atmux", "team.json"),
        JSON.stringify({
          name: "pz",
          members: [
            { name: "alpha", role: "member", tui: "shell" },
            { name: "beta", role: "member", tui: "shell" },
          ],
        }),
        "utf8",
      );
      await fx.tmux.session.newSession({
        name: "atmux_pz",
        detached: true,
        windowName: "alpha",
      });
      await fx.tmux.window.newWindow({
        sessionName: "atmux_pz",
        name: "beta",
      });
      let calls = 0;
      const { logger, logs } = makeLogger();
      const summary = await autolaunchTeam(
        { name: "pz", root: projRoot, enabled: true } as CockpitTeam,
        fx.tmux,
        {},
        logger,
        {
          readinessProbe: async (_target, member) => {
            calls += 1;
            if (member === "alpha") {
              throw new Error("simulated capture failure");
            }
            return {
              state: "ready",
              paneClassification: { state: "READY", evidence: "❯", capturedAt: 0 },
              evidence: "❯",
              elapsedMs: 12,
              attempts: 1,
            };
          },
        },
      );
      // Both members launched + probed; alpha threw, beta succeeded.
      expect(summary.launched).toBe(2);
      expect(calls).toBe(2);
      // The throw was swallowed; alpha is NOT in unbootstrapped (probe
      // never produced a result) — the structured warning is the surface.
      expect(summary.unbootstrapped).toEqual([]);
      const warnings = logs.filter((l) => l.startsWith("warn:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("alpha");
      expect(warnings[0]).toContain("probe error");
      expect(warnings[0]).toContain("simulated capture failure");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
      if (projRoot) await rm(projRoot, { recursive: true, force: true });
    }
  });
});

describe("cageAlive", () => {
  test("returns false for a server that has never started", async () => {
    const fx = await spinTmux("cage-dead");
    try {
      expect(await cageAlive(fx.tmux)).toBe(false);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("returns false for a live server with no claude panes", async () => {
    const fx = await spinTmux("cage-shell");
    try {
      await fx.tmux.session.newSession({ name: "s", detached: true, windowName: "w" });
      // pane runs default shell — not claude
      expect(await cageAlive(fx.tmux)).toBe(false);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });
});

describe("applyCagePrefix", () => {
  test("sets prefix to C-\\ on the cage", async () => {
    const fx = await spinTmux("prefix");
    try {
      await fx.tmux.session.newSession({ name: "s", detached: true, windowName: "w" });
      await applyCagePrefix(fx.tmux);
      const opts = await fx.tmux.option.showOptions({ global: true });
      expect(opts.prefix).toBe("C-\\");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // t-3fb7bc54: rebuild Phase 5b applies `resolvePrefix(1, prefixChain)`
  // to the cockpit session itself. The cockpit lives on a separate tmux
  // socket from cage tmuxes (per ADR-162 §Decision-anchor #1), so the
  // F1-binding on the cockpit doesn't collide with the same F1 on the
  // L1 cage — different tmux servers own different keybinding
  // namespaces. This test exercises the Phase 5b shape directly on a
  // cockpit-shaped fixture: apply the chain's first entry + verify it
  // lands on global options.
  test("applies F1 (chain[0]) on a cockpit-shaped session", async () => {
    const fx = await spinTmux("cockpit-prefix");
    try {
      await fx.tmux.session.newSession({
        name: "atmux_test_cockpit",
        detached: true,
        windowName: "_superdriver",
      });
      await applyCagePrefix(fx.tmux, "F1");
      const opts = await fx.tmux.option.showOptions({ global: true });
      expect(opts.prefix).toBe("F1");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });
});

describe("reconcileCockpitSession", () => {
  test("creates session + viewer windows for enabled teams", async () => {
    const fx = await spinTmux("cockpit-recon");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [
        { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
        { name: "beta", root: "/b", enabled: true } as CockpitTeam,
      ];
      await reconcileCockpitSession(fx.tmux, "atmux_test", teams, logger);
      const wins = await fx.tmux.window.listWindows("atmux_test");
      const names = wins.map((w) => w.name);
      expect(names).toContain("_superdriver");
      expect(names).toContain("alpha");
      expect(names).toContain("beta");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("idempotent — re-run leaves windows unchanged", async () => {
    const fx = await spinTmux("cockpit-idem");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "a", root: "/a", enabled: true } as CockpitTeam];
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      const before = (await fx.tmux.window.listWindows("s")).map((w) => `${w.index}:${w.name}`);
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      const after = (await fx.tmux.window.listWindows("s")).map((w) => `${w.index}:${w.name}`);
      expect(after).toEqual(before);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("removes orphan viewer windows when team disappears", async () => {
    const fx = await spinTmux("cockpit-orphan");
    try {
      const { logger } = makeLogger();
      // First pass — both teams enabled.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [
          { name: "a", root: "/a", enabled: true } as CockpitTeam,
          { name: "b", root: "/b", enabled: true } as CockpitTeam,
        ],
        logger,
      );
      // Second pass — drop "b". Passing yes=true so the t-8b0e077e
      // safety gate doesn't refuse the planned orphan-prune.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "a", root: "/a", enabled: true } as CockpitTeam],
        logger,
        {},
        undefined,
        true,
      );
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(names).toContain("_superdriver");
      expect(names).toContain("a");
      expect(names).not.toContain("b");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ---------- ADR-077: superdoctor cockpit window ----------

  // Test-only deps that keep the superdoctor window alive on CI runners
  // where `claude` isn't installed (otherwise newWindow's spawned process
  // exits immediately + tmux destroys the window).
  const sdDeps: ResolveTeamWindowDeps = { buildSuperdoctorCommand: () => "sleep infinity" };

  // t-22453c1e: existing tests opt out of auto-start since the
  // `sleep infinity` pane has no Claude markers — the auto-start
  // poll would either burn 30s timing out OR (with mock-sleep)
  // tight-loop until the wall-clock deadline expires. Dedicated
  // auto-start tests below cover the path explicitly.
  const sdNoAutoStart = { enabled: true, autoStart: false };

  test("ADR-077: superdoctor opt-in places window 2 between superdriver and team viewers", async () => {
    const fx = await spinTmux("cockpit-sd-fresh");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [
        { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
        { name: "beta", root: "/b", enabled: true } as CockpitTeam,
      ];
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, sdDeps, sdNoAutoStart);
      const wins = await fx.tmux.window.listWindows("s");
      const byIndex = wins.slice().sort((a, b) => a.index - b.index);
      // Window 1 = superdriver (created by newSession); window 2 = superdoctor;
      // teams 3..N. Indices may not literally be 1,2,3 if tmux is configured
      // with base-index != 1, but RELATIVE order is what we assert.
      expect(byIndex[0]?.name).toBe("_superdriver");
      // ADR-133: window renamed superdoctor → medic. Legacy alias kept
      //          in buildSuperdoctorCommand dep for back-compat; window
      //          name is canonical "medic".
      expect(byIndex[1]?.name).toBe("_medic");
      expect(
        byIndex
          .slice(2)
          .map((w) => w.name)
          .sort(),
      ).toEqual(["alpha", "beta"]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: superdoctor disabled or unset → cockpit shape unchanged", async () => {
    const fx = await spinTmux("cockpit-sd-off");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam];
      // Both forms (omit + explicit disabled) are no-ops.
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, {}, { enabled: false });
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name).sort();
      // ADR-135 §D2: `_superdriver` sorts before `alpha` (`_` < lowercase ASCII).
      expect(names).toEqual(["_superdriver", "alpha"]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: superdoctor reconcile is idempotent on re-run", async () => {
    const fx = await spinTmux("cockpit-sd-idem");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam];
      const sd = sdNoAutoStart;
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, sdDeps, sd);
      const before = (await fx.tmux.window.listWindows("s"))
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((w) => `${w.index}:${w.name}`);
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, sdDeps, sd);
      const after = (await fx.tmux.window.listWindows("s"))
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((w) => `${w.index}:${w.name}`);
      expect(after).toEqual(before);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: enabling superdoctor on an existing cockpit displaces team at index 2", async () => {
    // Simulates upgrading from a pre-ADR-077 cockpit. The team viewer that
    // happened to occupy index 2 is killed when superdoctor moves in, then
    // re-created in the same reconcile pass at the next free index.
    const fx = await spinTmux("cockpit-sd-upgrade");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [
        { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
        { name: "beta", root: "/b", enabled: true } as CockpitTeam,
      ];
      // Pre-ADR-077 cockpit shape (no superdoctor).
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      const pre = (await fx.tmux.window.listWindows("s"))
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((w) => w.name);
      expect(pre[0]).toBe("_superdriver");
      expect(pre.slice(1).sort()).toEqual(["alpha", "beta"]);
      // Upgrade — superdoctor enabled. The move-with-kill on the
      // displaced team viewer is a destructive op; t-8b0e077e requires
      // --yes to apply, so we thread `yes=true` here.
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, sdDeps, sdNoAutoStart, true);
      const post = (await fx.tmux.window.listWindows("s"))
        .slice()
        .sort((a, b) => a.index - b.index);
      expect(post[0]?.name).toBe("_superdriver");
      // ADR-133: W2 named "medic" canonically.
      expect(post[1]?.name).toBe("_medic");
      // Both teams must still be present (one was displaced + recreated).
      expect(
        post
          .slice(2)
          .map((w) => w.name)
          .sort(),
      ).toEqual(["alpha", "beta"]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: orphan-prune preserves superdoctor", async () => {
    const fx = await spinTmux("cockpit-sd-orphan-skip");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam];
      // First pass with superdoctor + alpha (non-destructive — fresh adds).
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, sdDeps, sdNoAutoStart);
      // Second pass with superdoctor still enabled but alpha removed —
      // alpha must be pruned, superdoctor must survive. The prune is
      // a destructive op (t-8b0e077e) → thread `yes=true`.
      await reconcileCockpitSession(fx.tmux, "s", [], logger, sdDeps, sdNoAutoStart, true);
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name).sort();
      expect(names).toContain("_superdriver");
      // ADR-133: W2 canonically named "medic". Legacy "superdoctor" window is preserved by orphan-prune for back-compat, but fresh creations use "medic".
      expect(names).toContain("_medic");
      expect(names).not.toContain("alpha");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ---------- t-22453c1e: superdoctor auto-start ----------

  test("t-22453c1e: autoStart fires `/loop /superdoctor` when pane settles to idle prompt", async () => {
    const fx = await spinTmux("cockpit-sd-autostart");
    try {
      const { logger, logs } = makeLogger();
      const teams: CockpitTeam[] = [];
      // Capture-pane stub: first call returns not-ready (welcome still
      // rendering), second returns the ready marker → auto-start
      // proceeds. Third (post-send verification) returns the loop-loaded
      // marker so we hit the ✓ branch.
      let captureCalls = 0;
      const captureSequence = [
        "Welcome to Claude Code\nLoading...",
        "❯ Try something\nauto mode on · tok 0/0",
        "Skill(coordination:superdoctor) ⎿ Successfully loaded skill",
      ];
      const captures: { sessionName: string; windowIndex: number }[] = [];
      const sentKeys: string[] = [];
      // Wrap the real tmux's sendKeys so the assertion captures the
      // literal keystroke — we can't easily mock the inner tmux pane
      // namespace via deps, so we register a real call recorder via the
      // capturePane injection (which IS in deps).
      const deps: ResolveTeamWindowDeps = {
        buildSuperdoctorCommand: () => "sleep infinity",
        autoStartSleep: async () => {},
        autoStartCapturePane: async (sessionName, windowIndex) => {
          captures.push({ sessionName, windowIndex });
          const out = captureSequence[Math.min(captureCalls, captureSequence.length - 1)] ?? "";
          captureCalls += 1;
          return out;
        },
      };
      // Patch tmux.pane.sendKeys so we can assert what got sent. The
      // namespace is plain methods; wrapping is direct.
      const realSendKeys = fx.tmux.pane.sendKeys.bind(fx.tmux.pane);
      // biome-ignore lint/suspicious/noExplicitAny: needed for test-time monkey-patch
      (fx.tmux.pane as any).sendKeys = async (opts: Parameters<typeof realSendKeys>[0]) => {
        sentKeys.push(opts.keys);
        return await realSendKeys(opts);
      };
      try {
        await reconcileCockpitSession(fx.tmux, "s", teams, logger, deps, { enabled: true });
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (fx.tmux.pane as any).sendKeys = realSendKeys;
      }
      expect(sentKeys).toContain("/loop /superdoctor");
      expect(captures.length).toBeGreaterThanOrEqual(2);
      expect(logs.some((l) => l.includes("superdoctor auto-started"))).toBe(true);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("t-22453c1e: autoStart=false → no send-keys (operator manual)", async () => {
    const fx = await spinTmux("cockpit-sd-autostart-off");
    try {
      const { logger, logs } = makeLogger();
      let captureCalls = 0;
      const sentKeys: string[] = [];
      const deps: ResolveTeamWindowDeps = {
        buildSuperdoctorCommand: () => "sleep infinity",
        autoStartSleep: async () => {},
        autoStartCapturePane: async () => {
          captureCalls += 1;
          return "❯ Try\nauto mode on · tok 0/0";
        },
      };
      const realSendKeys = fx.tmux.pane.sendKeys.bind(fx.tmux.pane);
      // biome-ignore lint/suspicious/noExplicitAny: monkey-patch
      (fx.tmux.pane as any).sendKeys = async (opts: Parameters<typeof realSendKeys>[0]) => {
        sentKeys.push(opts.keys);
        return await realSendKeys(opts);
      };
      try {
        await reconcileCockpitSession(fx.tmux, "s", [], logger, deps, {
          enabled: true,
          autoStart: false,
        });
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (fx.tmux.pane as any).sendKeys = realSendKeys;
      }
      // autoStart=false → no capture poll, no send-keys.
      expect(captureCalls).toBe(0);
      expect(sentKeys).not.toContain("/loop /superdoctor");
      expect(logs.some((l) => l.includes("superdoctor auto-started"))).toBe(false);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("t-22453c1e: timeout when pane never settles → warn + no send-keys", async () => {
    const fx = await spinTmux("cockpit-sd-autostart-timeout");
    try {
      const { logger, logs } = makeLogger();
      const sentKeys: string[] = [];
      const deps: ResolveTeamWindowDeps = {
        buildSuperdoctorCommand: () => "sleep infinity",
        autoStartSleep: async () => {},
        autoStartCapturePane: async () => "Loading...\n", // never settles
      };
      const realSendKeys = fx.tmux.pane.sendKeys.bind(fx.tmux.pane);
      // biome-ignore lint/suspicious/noExplicitAny: monkey-patch
      (fx.tmux.pane as any).sendKeys = async (opts: Parameters<typeof realSendKeys>[0]) => {
        sentKeys.push(opts.keys);
        return await realSendKeys(opts);
      };
      try {
        await reconcileCockpitSession(fx.tmux, "s", [], logger, deps, {
          enabled: true,
          autoStart: true,
          autoStartTimeoutSec: 1, // 1s deadline — busy-loops 2 iterations
        });
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (fx.tmux.pane as any).sendKeys = realSendKeys;
      }
      expect(sentKeys).not.toContain("/loop /superdoctor");
      expect(logs.some((l) => l.includes("not ready after"))).toBe(true);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("t-22453c1e: re-run (idempotent) does NOT re-fire send-keys on pre-existing window", async () => {
    const fx = await spinTmux("cockpit-sd-autostart-idem");
    try {
      const { logger, logs: _logs } = makeLogger();
      const sentKeys: string[] = [];
      const deps: ResolveTeamWindowDeps = {
        buildSuperdoctorCommand: () => "sleep infinity",
        autoStartSleep: async () => {},
        autoStartCapturePane: async () => "❯ Try\nauto mode on · tok 0/0",
      };
      const realSendKeys = fx.tmux.pane.sendKeys.bind(fx.tmux.pane);
      // biome-ignore lint/suspicious/noExplicitAny: monkey-patch
      (fx.tmux.pane as any).sendKeys = async (opts: Parameters<typeof realSendKeys>[0]) => {
        sentKeys.push(opts.keys);
        return await realSendKeys(opts);
      };
      try {
        await reconcileCockpitSession(fx.tmux, "s", [], logger, deps, {
          enabled: true,
          autoStart: true,
          autoStartTimeoutSec: 5,
        });
        const after1 = sentKeys.filter((k) => k === "/loop /superdoctor").length;
        // Second run — window already exists, sdJustCreated=false → no
        // additional send-keys.
        await reconcileCockpitSession(fx.tmux, "s", [], logger, deps, {
          enabled: true,
          autoStart: true,
          autoStartTimeoutSec: 5,
        });
        const after2 = sentKeys.filter((k) => k === "/loop /superdoctor").length;
        expect(after1).toBe(1);
        expect(after2).toBe(1); // unchanged — no re-fire
      } finally {
        // biome-ignore lint/suspicious/noExplicitAny: restore
        (fx.tmux.pane as any).sendKeys = realSendKeys;
      }
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ---------- t-8b0e077e: cockpit safety gate ----------

  test("t-8b0e077e: orphan-prune without --yes refuses with UsageError", async () => {
    const fx = await spinTmux("cockpit-safety-orphan-refuse");
    try {
      const { logger, logs } = makeLogger();
      // Seed: superdriver + alpha + beta (no superdoctor for this case).
      const teams: CockpitTeam[] = [
        { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
        { name: "beta", root: "/b", enabled: true } as CockpitTeam,
      ];
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      // Drop beta from the roster → second pass should plan a destructive
      // orphan-prune; no --yes → refuse.
      await expect(
        reconcileCockpitSession(
          fx.tmux,
          "s",
          [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam],
          logger,
        ),
      ).rejects.toThrow(UsageError);
      // The warn line names the orphan + the prune action.
      expect(logs.some((l) => l.includes("destructive: prune-orphan 'beta'"))).toBe(true);
      // Beta must STILL be alive — the refuse fired before any kill.
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name).sort();
      expect(names).toContain("beta");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("t-8b0e077e: orphan-prune WITH --yes applies the prune", async () => {
    const fx = await spinTmux("cockpit-safety-orphan-yes");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [
        { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
        { name: "beta", root: "/b", enabled: true } as CockpitTeam,
      ];
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam],
        logger,
        {},
        undefined,
        true, // --yes
      );
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name).sort();
      expect(names).not.toContain("beta");
      expect(names).toContain("alpha");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("t-8b0e077e: idempotent reload (no diff) needs no --yes", async () => {
    const fx = await spinTmux("cockpit-safety-idempotent");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam];
      // First pass — additive (`newSession` + `newWindow`); not destructive.
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      // Second pass with identical config — zero destructive ops, no --yes
      // required.
      await reconcileCockpitSession(fx.tmux, "s", teams, logger);
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name).sort();
      // ADR-135 §D2: `_superdriver` sorts before `alpha` (`_` < lowercase ASCII).
      expect(names).toEqual(["_superdriver", "alpha"]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("t-8b0e077e: --force-cycle requires --yes (parse-time gate)", () => {
    // Already gated by --acknowledge-dangerous-bau-interruption for claude-
    // TUI loss; --yes layers the cockpit-reconcile destructive-op gate.
    expect(() =>
      parseCockpitArgs([
        "rebuild",
        "--force-cycle",
        "--acknowledge-dangerous-bau-interruption",
        // intentionally missing --yes
      ]),
    ).toThrow(UsageError);
    // With --yes added, the parse succeeds.
    const p = parseCockpitArgs([
      "rebuild",
      "--force-cycle",
      "--acknowledge-dangerous-bau-interruption",
      "--yes",
    ]);
    expect(p.forceCycle).toBe(true);
    expect(p.ackDangerous).toBe(true);
    expect(p.yes).toBe(true);
  });

  test("t-8b0e077e: --yes / -y both parse", () => {
    expect(parseCockpitArgs(["rebuild", "--yes"]).yes).toBe(true);
    expect(parseCockpitArgs(["rebuild", "-y"]).yes).toBe(true);
    expect(parseCockpitArgs(["reload", "--yes"]).yes).toBe(true);
  });
});

// ---------- ADR-063 ergonomic fix: onlyTeam scope (t-ab8df0b4) ----------

describe("reconcileCockpitSession — onlyTeam scope (ADR-063 ergonomic fix)", () => {
  test("onlyTeam adds named window when missing, leaves siblings untouched", async () => {
    const fx = await spinTmux("cockpit-onlyteam-add");
    try {
      const { logger } = makeLogger();
      // Seed: fleet-wide with sibling 'alpha' already present.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam],
        logger,
      );
      const before = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(before).toContain("alpha");
      expect(before).not.toContain("unum");

      // Per-team add of 'unum' — siblings preserved.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "unum", root: "/u", enabled: true } as CockpitTeam],
        logger,
        {},
        undefined,
        false,
        { onlyTeam: "unum" },
      );
      const after = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(after).toContain("alpha"); // sibling preserved
      expect(after).toContain("unum"); // target added
      expect(after).toContain("_superdriver");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("onlyTeam idempotent — window already present is no-op", async () => {
    const fx = await spinTmux("cockpit-onlyteam-idem");
    try {
      const { logger } = makeLogger();
      // Seed.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "unum", root: "/u", enabled: true } as CockpitTeam],
        logger,
      );
      const before = (await fx.tmux.window.listWindows("s")).map((w) => `${w.index}:${w.name}`);

      // Re-run with onlyTeam — no-op.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "unum", root: "/u", enabled: true } as CockpitTeam],
        logger,
        {},
        undefined,
        false,
        { onlyTeam: "unum" },
      );
      const after = (await fx.tmux.window.listWindows("s")).map((w) => `${w.index}:${w.name}`);
      expect(after).toEqual(before);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("onlyTeam does NOT remove orphan sibling windows (additive only)", async () => {
    const fx = await spinTmux("cockpit-onlyteam-no-orphan");
    try {
      const { logger } = makeLogger();
      // Seed two team windows fleet-wide.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [
          { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
          { name: "beta", root: "/b", enabled: true } as CockpitTeam,
        ],
        logger,
      );
      // Per-team reconcile with ONLY 'alpha' — fleet-wide mode would
      // delete 'beta' as an orphan, but onlyTeam mode must preserve it.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam],
        logger,
        {},
        undefined,
        false,
        { onlyTeam: "alpha" },
      );
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(names).toContain("alpha");
      expect(names).toContain("beta"); // NOT removed — onlyTeam is additive
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("onlyTeam filters teams[] arg defensively (mismatched name ignored)", async () => {
    const fx = await spinTmux("cockpit-onlyteam-filter");
    try {
      const { logger } = makeLogger();
      // Caller passes both teams but onlyTeam pins to 'unum' only.
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [
          { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
          { name: "unum", root: "/u", enabled: true } as CockpitTeam,
        ],
        logger,
        {},
        undefined,
        false,
        { onlyTeam: "unum" },
      );
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(names).toContain("unum"); // pinned by onlyTeam
      expect(names).not.toContain("alpha"); // filtered out
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });
});

// ---------- ADR-077: buildSuperdoctorWindowCommand ----------

describe("buildSuperdoctorWindowCommand (ADR-077)", () => {
  test("emits bare claude invocation when claudeAccount is unset", async () => {
    const { buildSuperdoctorWindowCommand } = await import("../../../src/verbs/cockpit.ts");
    const cmd = buildSuperdoctorWindowCommand({ enabled: true });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
    expect(cmd).toContain("--permission-mode auto");
    expect(cmd).not.toContain("CLAUDE_CONFIG_DIR=");
  });

  test("emits CLAUDE_CONFIG_DIR prefix when claudeAccount is set", async () => {
    const { buildSuperdoctorWindowCommand } = await import("../../../src/verbs/cockpit.ts");
    const cmd = buildSuperdoctorWindowCommand({
      enabled: true,
      claudeAccount: { configDir: "/root/.claude-personal", label: "personal" },
    });
    expect(cmd).toContain("CLAUDE_CONFIG_DIR=/root/.claude-personal");
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
    expect(cmd).toContain("--permission-mode auto");
  });

  test("honours tuiOverrides", async () => {
    const { buildSuperdoctorWindowCommand } = await import("../../../src/verbs/cockpit.ts");
    const cmd = buildSuperdoctorWindowCommand({
      enabled: true,
      tuiOverrides: { effortLevel: "high", permissionMode: "dontAsk", pluginDir: "/p/dir" },
    });
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=high");
    expect(cmd).toContain("--permission-mode dontAsk");
    expect(cmd).toContain("--plugin-dir=/p/dir");
  });
});

// ---------- ADR-064 §3: resolveTeamWindowMode + buildTeamWindowCommand ----------

function fakeTeam(driverSession: { tui?: string | null } | null | undefined): Team {
  const t: Record<string, unknown> = {
    name: "demo",
    members: [{ name: "alpha" }],
  };
  if (driverSession !== undefined) t.driverSession = driverSession;
  return t as unknown as Team;
}

function fakeCageTmux(opts: {
  hasSession?: boolean;
  windows?: ReadonlyArray<{ index: number; name: string }>;
  throwOnHasSession?: boolean;
  throwOnListWindows?: boolean;
}): TmuxNamespace {
  return {
    session: {
      async hasSession(_name: string) {
        if (opts.throwOnHasSession === true) throw new Error("simulated");
        return opts.hasSession ?? false;
      },
    },
    window: {
      async listWindows(_name: string) {
        if (opts.throwOnListWindows === true) throw new Error("simulated");
        return [...(opts.windows ?? [])];
      },
    },
  } as unknown as TmuxNamespace;
}

describe("resolveTeamWindowMode", () => {
  const team = { name: "demo", root: "/d", enabled: true } as CockpitTeam;

  test("driverSession=null → 'no-driver-config'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam(null),
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("no-driver-config");
  });

  test("driverSession key absent → 'no-driver-config'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam(undefined),
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("no-driver-config");
  });

  test("loadTeam throws (missing team.json) → 'no-driver-config'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => {
        throw new Error("ENOENT team.json");
      },
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("no-driver-config");
  });

  test("driverSession={tui:'claude'} + live cage with driver window → 'attach'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      createCageTmux: () =>
        fakeCageTmux({
          hasSession: true,
          windows: [
            { index: 1, name: "driver" },
            { index: 2, name: "🐝alpha" },
          ],
        }),
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("attach");
  });

  test("driverSession set + cage missing session → 'session-down'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      createCageTmux: () => fakeCageTmux({ hasSession: false }),
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("session-down");
  });

  test("driverSession set + cage live but no 'driver' window → 'session-down'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      createCageTmux: () =>
        fakeCageTmux({
          hasSession: true,
          windows: [{ index: 1, name: "__home" }],
        }),
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("session-down");
  });

  test("cage tmux throws → 'session-down'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      createCageTmux: () => fakeCageTmux({ throwOnHasSession: true }),
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("session-down");
  });

  test("createCageTmux factory throws → 'session-down'", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      createCageTmux: () => {
        throw new Error("simulated factory failure");
      },
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("session-down");
  });

  // ADR-063 follow-up: socket resolver wired through deps so cockpit
  // can detect cages running on the per-team `team.tmuxTmpdir`
  // convention, not just the legacy `/tmp/atmux-<team>/sock` path.
  test("resolveCageSocket=per-team + cage alive → 'attach' (regression for driver-inbox 2026-05-14 bug)", async () => {
    let factorySocket: string | undefined;
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      resolveCageSocket: async (_name, root) => `${root}/.atmux/tmux/tmux-0/default`,
      createCageTmux: (sock) => {
        factorySocket = sock;
        return fakeCageTmux({
          hasSession: true,
          windows: [{ index: 1, name: "driver" }],
        });
      },
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("attach");
    // Compat verify: the resolved per-team socket was the one the
    // factory was called with — proves the threading works end-to-end.
    expect(factorySocket).toBe("/d/.atmux/tmux/tmux-0/default");
  });

  test("resolveCageSocket=legacy + cage alive → 'attach' (compat regression)", async () => {
    let factorySocket: string | undefined;
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      resolveCageSocket: async (name) => `/tmp/atmux-${name}/sock`,
      createCageTmux: (sock) => {
        factorySocket = sock;
        return fakeCageTmux({
          hasSession: true,
          windows: [{ index: 1, name: "driver" }],
        });
      },
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("attach");
    expect(factorySocket).toBe("/tmp/atmux-demo/sock");
  });

  test("resolveCageSocket throws → 'session-down' (resolver failure is non-fatal)", async () => {
    const deps: ResolveTeamWindowDeps = {
      loadTeam: async () => fakeTeam({ tui: "claude" }),
      resolveCageSocket: async () => {
        throw new Error("simulated resolver failure");
      },
    };
    expect(await resolveTeamWindowMode(team, deps)).toBe("session-down");
  });
});

describe("buildTeamWindowCommand", () => {
  const team = { name: "demo", root: "/d", enabled: true } as CockpitTeam;
  const uid = process.getuid?.() ?? 0;

  test("attach mode targets <session>:driver via the dual-socket retry loop", () => {
    const cmd = buildTeamWindowCommand(team, "attach");
    expect(cmd).toContain("attach -t");
    expect(cmd).toContain(":driver");
    expect(cmd).toContain("while true");
    expect(cmd).toContain("sleep 1");
    // ADR-063 follow-up (t-31bef86e): both socket conventions inside
    // one iteration. Supersedes the t-b5864443 single-socketPath param —
    // the dual-socket retry loop derives both paths internally from
    // the team's name + root so cockpit viewers self-heal across cage
    // socket-convention flips without requiring a pre-resolved socket.
    expect(cmd).toContain("/tmp/atmux-demo/sock");
    expect(cmd).toContain(`/d/.atmux/tmux/tmux-${uid}/default`);
    expect(cmd).toContain("||");
  });

  test("no-driver-config emits the 'set team.json::driverSession' guidance", () => {
    const cmd = buildTeamWindowCommand(team, "no-driver-config");
    expect(cmd).toContain("no driver configured for demo");
    expect(cmd).toContain("team.json::driverSession");
    expect(cmd).toContain("sleep infinity");
  });

  test("session-down emits the 'atmux start' guidance + self-healing retry-loop", () => {
    const cmd = buildTeamWindowCommand(team, "session-down");
    expect(cmd).toContain("session not running");
    expect(cmd).toContain("atmux start demo");
    // ADR-063 follow-up: replaced `sleep infinity` with a retry-loop so
    // the window re-attaches when the cage comes back up — see
    // driver-inbox 2026-05-14 bug report.
    expect(cmd).not.toContain("sleep infinity");
    expect(cmd).toContain("while true");
    expect(cmd).toContain("sleep 1");
    expect(cmd).toContain("/tmp/atmux-demo/sock");
    expect(cmd).toContain(`/d/.atmux/tmux/tmux-${uid}/default`);
  });

  test("placeholder shell-quoting survives team names with apostrophes", () => {
    const apostropheTeam = { name: "ali's-team", root: "/x", enabled: true } as CockpitTeam;
    const cmd = buildTeamWindowCommand(apostropheTeam, "no-driver-config");
    // Resulting shell string is single-quoted; the apostrophe in the
    // team name must be escaped via the POSIX `'\''` idiom so the
    // surrounding `printf` quoting doesn't break.
    expect(cmd).toContain("'\\''");
  });

  test("session-down printf message is shell-safe for team names with apostrophes", () => {
    const apostropheTeam = { name: "ali's-team", root: "/x", enabled: true } as CockpitTeam;
    const cmd = buildTeamWindowCommand(apostropheTeam, "session-down");
    // The printf prelude single-quotes its message; the apostrophe in
    // "ali's-team" must be POSIX-escaped or the rest of the command
    // string breaks the shell parse.
    expect(cmd).toContain("'\\''");
    expect(cmd).toContain("while true");
  });
});

// ---------- reconcile integration with the resolver ----------

describe("reconcileCockpitSession — driverSession-aware per-team windows", () => {
  test("creates placeholder window when team has driverSession=null", async () => {
    const fx = await spinTmux("cockpit-driverless");
    try {
      const { logger, logs } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "off", root: "/off", enabled: true } as CockpitTeam];
      const deps: ResolveTeamWindowDeps = {
        loadTeam: async () => fakeTeam(null),
      };
      await reconcileCockpitSession(fx.tmux, "atmux_test", teams, logger, deps);
      const wins = await fx.tmux.window.listWindows("atmux_test");
      expect(wins.map((w) => w.name)).toContain("off");
      expect(logs.some((l) => l.includes("no-driver-config"))).toBe(true);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("creates attach window when driverSession set + cage alive with driver window", async () => {
    const fx = await spinTmux("cockpit-attach");
    try {
      const { logger, logs } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "live", root: "/live", enabled: true } as CockpitTeam];
      const deps: ResolveTeamWindowDeps = {
        loadTeam: async () => fakeTeam({ tui: "claude" }),
        createCageTmux: () =>
          fakeCageTmux({
            hasSession: true,
            windows: [{ index: 1, name: "driver" }],
          }),
      };
      await reconcileCockpitSession(fx.tmux, "atmux_test", teams, logger, deps);
      const wins = await fx.tmux.window.listWindows("atmux_test");
      expect(wins.map((w) => w.name)).toContain("live");
      expect(logs.some((l) => l.includes("(attach)"))).toBe(true);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("creates 'session-down' placeholder when driverSession set but cage dead", async () => {
    const fx = await spinTmux("cockpit-down");
    try {
      const { logger, logs } = makeLogger();
      const teams: CockpitTeam[] = [
        { name: "asleep", root: "/asleep", enabled: true } as CockpitTeam,
      ];
      const deps: ResolveTeamWindowDeps = {
        loadTeam: async () => fakeTeam({ tui: "claude" }),
        createCageTmux: () => fakeCageTmux({ hasSession: false }),
      };
      await reconcileCockpitSession(fx.tmux, "atmux_test", teams, logger, deps);
      const wins = await fx.tmux.window.listWindows("atmux_test");
      expect(wins.map((w) => w.name)).toContain("asleep");
      expect(logs.some((l) => l.includes("(session-down)"))).toBe(true);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("idempotent — re-run with same teams leaves window count unchanged", async () => {
    const fx = await spinTmux("cockpit-idem-driverless");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "off", root: "/off", enabled: true } as CockpitTeam];
      const deps: ResolveTeamWindowDeps = {
        loadTeam: async () => fakeTeam(null),
      };
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, deps);
      const before = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, deps);
      const after = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(after).toEqual(before);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });
});

describe("cockpitRebuild", () => {
  let homeDir: string;
  let projRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-cockpit-reb-home-"));
    await mkdir(join(homeDir, ".atmux"), { recursive: true });
    projRoot = await mkdtemp(join(tmpdir(), "atmux-cockpit-reb-proj-"));
    await mkdir(join(projRoot, ".atmux"), { recursive: true });
    await writeFile(
      join(projRoot, ".atmux", "team.json"),
      JSON.stringify({
        name: "demo",
        members: [{ name: "lead", role: "team-lead", tui: "claude" }],
      }),
      "utf8",
    );
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projRoot, { recursive: true, force: true });
  });

  test("--no-cycle + --no-launch only normalises team.json + reconciles cockpit", async () => {
    // Seed cockpit.json
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit",
        teams: [
          {
            name: "demo",
            root: projRoot,
            enabled: true,
            claudeAccount: { configDir: "/root/.claude-ifca" },
          },
        ],
      }),
      "utf8",
    );
    // Use a per-test cockpit tmux server (default socket would clobber operator's).
    const fx = await spinTmux("cockpit-reb-default");
    let startCalls = 0;
    try {
      const { logger } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: (cfg) => {
            // Route both cage and cockpit calls to the per-test socket so we
            // never touch the operator's default server.
            void cfg;
            return fx.tmux;
          },
          logger,
          startFn: async () => {
            startCalls += 1;
            return 0;
          },
        },
      );
      expect(code).toBe(0);
      expect(startCalls).toBe(0); // --no-cycle skipped start
      // team.json normalised
      const tj = JSON.parse(await readFile(join(projRoot, ".atmux", "team.json"), "utf8"));
      expect(tj.bareWindowNames).toBe(true);
      expect(tj.tuiCommands.claude).toContain("CLAUDE_CONFIG_DIR=/root/.claude-ifca");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("cycle path calls startFn per enabled team with --no-doctor", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "ts",
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-cycle");
    let startArgs: ReadonlyArray<string> | undefined;
    let startCwd: string | undefined;
    try {
      const { logger } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: false,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async (args, opts) => {
            startArgs = args;
            startCwd = opts?.cwd;
            return 0;
          },
        },
      );
      expect(code).toBe(0);
      expect(startArgs).toEqual(["--no-doctor"]);
      expect(startCwd).toBe(projRoot);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("--force-cycle adds --force to start args", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({ teams: [{ name: "demo", root: projRoot, enabled: true }] }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-force");
    let startArgs: ReadonlyArray<string> | undefined;
    try {
      const { logger } = makeLogger();
      await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: false,
          forceCycle: true,
          ackDangerous: true,
          noLaunch: true,
          yes: true,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async (args) => {
            startArgs = args;
            return 0;
          },
        },
      );
      expect(startArgs).toEqual(["--force", "--no-doctor"]);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("returns 0 + warns when cockpit has no enabled teams", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({ teams: [{ name: "x", root: "/x", enabled: false }] }),
      "utf8",
    );
    const { logger, logs } = makeLogger();
    const code = await cockpitRebuild(
      {
        subverb: "rebuild",
        noCycle: true,
        forceCycle: false,
        ackDangerous: false,
        noLaunch: true,
        yes: false,
      },
      { env: { HOME: homeDir, ATMUX_NO_CRON: "1" }, logger },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("no enabled teams"))).toBe(true);
  });

  // ADR-077: rebuild emits a manual-start nudge when superdoctor is
  // enabled. Auto-firing /loop /superdoctor would re-fire on every
  // idempotent rebuild — keep rebuild topological, nudge the operator.
  test("ADR-077: superdoctor enabled → success message includes /loop /superdoctor nudge", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit_sd_nudge",
        // autoStart: false keeps this test scoped to the manual-nudge
        // contract (t-22453c1e's auto-start path has its own coverage;
        // mixing them here would deadline-hang on the live capture-pane
        // poll since the CI tmux pane never reaches a Claude prompt).
        superdoctor: { enabled: true, autoStart: false },
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-sd-nudge");
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
        },
      );
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toContain("/loop /superdoctor");
      expect(joined).toContain("superdoctor");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ADR-133 TR2: top-level `medic` block resolves the same way as the
  // deprecated `superdoctor` block. Window name stays "superdoctor"
  // until TR3 ships the verb / window / skill renames.
  test("ADR-133 TR2: top-level `medic` block enables the W2 medic window + nudge", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "test_cockpit_medic_nudge",
        medic: { enabled: true },
        sessions: [{ type: "team", name: "demo", root: projRoot }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-medic-nudge");
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
        },
      );
      expect(code).toBe(0);
      const joined = logs.join("\n");
      // Nudge fires from the new canonical `cockpit.medic` read.
      expect(joined).toContain("/loop /superdoctor");
      expect(joined).toContain("medic");
      // ADR-133 TR2 ships canonical "medic" window name; ADR-135 §D2
      // adds the `_` prefix on cockpit-role windows. The post-rename
      // canonical is `_medic`. (Pre-TR2 / pre-ADR-135 form was bare
      // `"superdoctor"`.)
      const wins = await fx.tmux.window.listWindows("test_cockpit_medic_nudge");
      expect(wins.map((w) => w.name)).toContain("_medic");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ADR-133 TR2: top-level `superdoctor` block (recursive sessions[]
  // shape, NOT legacy flat) — shim lifts to medic + warns.
  test("ADR-133 TR2: top-level `superdoctor` on new-shape config → medic resolves + deprecation warn fires", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "test_cockpit_sd_depr",
        superdoctor: { enabled: true },
        sessions: [{ type: "team", name: "demo", root: projRoot }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-sd-depr");
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
        },
      );
      expect(code).toBe(0);
      const joined = logs.join("\n");
      // Nudge fires (medic resolved post-shim).
      expect(joined).toContain("/loop /superdoctor");
      // Deprecation warning surfaces via stderr (default warn sink) —
      // not captured by `logs[]` since logger isn't passed to
      // loadCockpit's warn. The W2 window still provisions, named
      // canonically as `_medic` post-ADR-133 + ADR-135 §D2 `_` prefix.
      const wins = await fx.tmux.window.listWindows("test_cockpit_sd_depr");
      expect(wins.map((w) => w.name)).toContain("_medic");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ADR-133 TR2: BOTH `medic` and `superdoctor` set — medic wins.
  test("ADR-133 TR2: both `medic` and `superdoctor` set → medic wins; superdoctor stripped pre-parse", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "test_cockpit_both",
        medic: { enabled: true, autoStart: false },
        superdoctor: { enabled: false, autoStart: true },
        sessions: [{ type: "team", name: "demo", root: projRoot }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-both");
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
        },
      );
      expect(code).toBe(0);
      const joined = logs.join("\n");
      // medic.enabled=true wins; nudge fires. superdoctor.enabled=false
      // would have suppressed the nudge if it had won.
      expect(joined).toContain("/loop /superdoctor");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  // ADR-133 TR2: neither key set — no nudge.
  test("ADR-133 TR2: neither `medic` nor `superdoctor` set → no nudge in output", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "test_cockpit_neither",
        sessions: [{ type: "team", name: "demo", root: projRoot }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-neither");
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
        },
      );
      expect(code).toBe(0);
      const joined = logs.join("\n");
      // No medic / superdoctor configured → no /loop nudge surfaces.
      expect(joined).not.toContain("/loop /superdoctor");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-086: rebuild installs the cockpit cron block (atmux pulse)", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit_cron_install",
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-cron-install");
    let crontabBody = "";
    const fakeCrontab = {
      available: async () => true,
      read: async () => crontabBody,
      write: async (body: string) => {
        crontabBody = body;
      },
    };
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
          crontab: fakeCrontab,
          resolveAtmuxBin: () => "/usr/local/bin/atmux",
        },
      );
      expect(code).toBe(0);
      expect(crontabBody).toContain("# >>> atmux:cockpit");
      expect(crontabBody).toContain("atmux pulse");
      expect(crontabBody).toContain(join(homeDir, ".atmux", "cockpit.json"));
      // Second rebuild is idempotent — same body.
      const before = crontabBody;
      const code2 = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
          crontab: fakeCrontab,
          resolveAtmuxBin: () => "/usr/local/bin/atmux",
        },
      );
      expect(code2).toBe(0);
      expect(crontabBody).toBe(before);
      // Second run should log "up to date".
      expect(logs.some((l) => l.includes("up to date"))).toBe(true);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-086: ATMUX_NO_CRON skips cron install entirely", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit_no_cron",
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-no-cron");
    let wrote = false;
    const fakeCrontab = {
      available: async () => true,
      read: async () => "",
      write: async () => {
        wrote = true;
      },
    };
    try {
      const { logger } = makeLogger();
      await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
          crontab: fakeCrontab,
          resolveAtmuxBin: () => "/usr/local/bin/atmux",
        },
      );
      expect(wrote).toBe(false);
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-086: crontab unavailable → warn + continue (rebuild still succeeds)", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit_cron_unavail",
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-cron-unavail");
    const fakeCrontab = {
      available: async () => false,
      read: async () => "",
      write: async () => {
        throw new Error("should not be called");
      },
    };
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
          crontab: fakeCrontab,
          resolveAtmuxBin: () => "/usr/local/bin/atmux",
        },
      );
      expect(code).toBe(0);
      expect(logs.some((l) => l.startsWith("warn:") && l.includes("crontab not on PATH"))).toBe(
        true,
      );
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: superdoctor unset → no /loop nudge in success message", async () => {
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit_sd_off",
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
    const fx = await spinTmux("cockpit-reb-sd-off");
    try {
      const { logger, logs } = makeLogger();
      const code = await cockpitRebuild(
        {
          subverb: "rebuild",
          noCycle: true,
          forceCycle: false,
          ackDangerous: false,
          noLaunch: true,
          yes: false,
        },
        {
          env: { HOME: homeDir, ATMUX_NO_CRON: "1" },
          tmuxFactory: () => fx.tmux,
          logger,
          startFn: async () => 0,
        },
      );
      expect(code).toBe(0);
      expect(logs.join("\n")).not.toContain("/loop /superdoctor");
    } finally {
      try {
        await fx.tmux.server.killServer();
      } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });
});

// ---------- ADR-162 TR3: parseCockpitArgs migrate-socket arms ----------

describe("parseCockpitArgs — migrate-socket subverb (ADR-162 TR3)", () => {
  test("bare migrate-socket parses with dryRun + keepLegacy false", () => {
    const p = parseCockpitArgs(["migrate-socket"]);
    expect(p.subverb).toBe("migrate-socket");
    expect(p.dryRun).toBe(false);
    expect(p.keepLegacy).toBe(false);
  });

  test("--dry-run parses true on migrate-socket", () => {
    const p = parseCockpitArgs(["migrate-socket", "--dry-run"]);
    expect(p.dryRun).toBe(true);
  });

  test("--keep-legacy parses true on migrate-socket", () => {
    const p = parseCockpitArgs(["migrate-socket", "--keep-legacy"]);
    expect(p.keepLegacy).toBe(true);
  });

  test("--dry-run + --keep-legacy compose", () => {
    const p = parseCockpitArgs(["migrate-socket", "--dry-run", "--keep-legacy"]);
    expect(p.dryRun).toBe(true);
    expect(p.keepLegacy).toBe(true);
  });

  test("--dry-run rejected on rebuild (subverb-scoped flag)", () => {
    expect(() => parseCockpitArgs(["rebuild", "--dry-run"])).toThrow(UsageError);
  });

  test("--keep-legacy rejected on reload (subverb-scoped flag)", () => {
    expect(() => parseCockpitArgs(["reload", "--keep-legacy"])).toThrow(UsageError);
  });

  test("unknown sub-verb error names the valid set including migrate-socket", () => {
    try {
      parseCockpitArgs(["unknown-verb"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect(String(e)).toContain("migrate-socket");
    }
  });
});

// ---------- ADR-162 TR3: buildMigrationBreadcrumb ----------

describe("buildMigrationBreadcrumb (ADR-162 TR3 — Phase 5)", () => {
  test("returns header + per-window separators with scrollback inline", () => {
    const captured: CapturedCockpitWindow[] = [
      {
        sessionName: "atmux_cockpit",
        index: 1,
        name: "_superdriver",
        scrollback: "line A\nline B",
      },
      { sessionName: "atmux_cockpit", index: 2, name: "_medic", scrollback: "medic tail" },
    ];
    const out = buildMigrationBreadcrumb(captured, "atmux_cockpit", "atmux-cockpit");
    expect(out).toContain("atmux cockpit migrate-socket breadcrumb");
    expect(out).toContain("tmux -L atmux-cockpit attach -t atmux_cockpit");
    expect(out).toContain("## atmux_cockpit:1 '_superdriver'");
    expect(out).toContain("line A\nline B");
    expect(out).toContain("## atmux_cockpit:2 '_medic'");
    expect(out).toContain("medic tail");
    expect(out).toContain("re-invoke any in-pane Claude/script process");
  });

  test("empty scrollback surfaces placeholder line, not blank", () => {
    const captured: CapturedCockpitWindow[] = [
      { sessionName: "atmux_teams", index: 1, name: "_superdriver", scrollback: "" },
    ];
    const out = buildMigrationBreadcrumb(captured, "atmux_cockpit", "atmux-cockpit");
    expect(out).toContain("(scrollback empty or capture failed)");
  });

  test("empty captured list still emits header (zero-window edge)", () => {
    const out = buildMigrationBreadcrumb([], "atmux_cockpit", "atmux-cockpit");
    expect(out).toContain("Captured 0 window(s)");
  });
});

// ---------- ADR-162 TR3: cockpitMigrateSocket — mock-driven flow ----------

interface MockTmuxState {
  /** Sessions on this socket. */
  sessions: Map<string, { windows: { index: number; name: string }[]; createdAt: number }>;
  /** Pane-capture seed keyed by `<session>:<index>`. */
  scrollback: Map<string, string>;
  /** Operations log — every call appended in order for assertion. */
  ops: string[];
}

/** Build a TmuxNamespace stub backed by `MockTmuxState`. Tags every op
 *  with `<socketTag>:` so a multi-socket flow can be asserted with a
 *  single shared ops array per state. */
function makeMockTmux(socketTag: string, state: MockTmuxState): TmuxNamespace {
  const ns: Partial<TmuxNamespace> = {
    session: {
      async listSessions() {
        state.ops.push(`${socketTag}:listSessions`);
        return Array.from(state.sessions.entries()).map(([name, s]) => ({
          name,
          windows: s.windows.length,
          created: s.createdAt,
        }));
      },
      async hasSession(name) {
        state.ops.push(`${socketTag}:hasSession(${name})`);
        return state.sessions.has(name);
      },
      async newSession(opts) {
        state.ops.push(`${socketTag}:newSession(${opts.name},${opts.windowName ?? ""})`);
        state.sessions.set(opts.name, {
          windows: [{ index: 1, name: opts.windowName ?? "shell" }],
          createdAt: Date.now(),
        });
      },
      async killSession(name) {
        state.ops.push(`${socketTag}:killSession(${name})`);
        state.sessions.delete(name);
      },
      async renameSession() {
        throw new Error("not used by migrate-socket");
      },
      async setEnvironment() {
        throw new Error("not used by migrate-socket");
      },
    },
    window: {
      async listWindows(sessionName) {
        state.ops.push(`${socketTag}:listWindows(${sessionName})`);
        const sess = state.sessions.get(sessionName);
        return (sess?.windows ?? []).map((w) => ({
          index: w.index,
          id: `@${w.index}`,
          name: w.name,
          active: w.index === 1,
        }));
      },
      async newWindow(opts) {
        state.ops.push(`${socketTag}:newWindow(${opts.sessionName},${opts.name ?? ""})`);
        const sess = state.sessions.get(opts.sessionName);
        let nextIdx = 1;
        if (sess !== undefined) {
          nextIdx = (sess.windows.at(-1)?.index ?? 0) + 1;
          sess.windows.push({ index: nextIdx, name: opts.name ?? `window-${nextIdx}` });
        }
        return { sessionName: opts.sessionName, windowIndex: nextIdx };
      },
      async killWindow() {
        throw new Error("not used by migrate-socket");
      },
      async renameWindow() {
        throw new Error("not used by migrate-socket");
      },
      async selectWindow() {
        throw new Error("not used by migrate-socket");
      },
      async moveWindow() {
        throw new Error("not used by migrate-socket");
      },
      async swapWindow() {
        throw new Error("not used by migrate-socket");
      },
    },
    pane: {
      async capturePane(opts) {
        state.ops.push(`${socketTag}:capturePane(${opts.target})`);
        return state.scrollback.get(String(opts.target)) ?? "";
      },
    } as TmuxNamespace["pane"],
  };
  return ns as TmuxNamespace;
}

function migrateOpts(overrides: Partial<ParsedCockpitArgs> = {}): ParsedCockpitArgs {
  return {
    subverb: "migrate-socket",
    noCycle: false,
    forceCycle: false,
    ackDangerous: false,
    noLaunch: false,
    yes: false,
    dryRun: false,
    keepLegacy: false,
    ...overrides,
  };
}

describe("cockpitMigrateSocket (ADR-162 TR3) — mock-driven flow", () => {
  test("LEGACY_COCKPIT_SESSION_NAMES covers both ADR-135 canonical + pre-135 legacy", () => {
    expect(LEGACY_COCKPIT_SESSION_NAMES).toEqual(["atmux_cockpit", "atmux_teams"]);
  });

  test("Phase 1 short-circuit — no tmux server on default socket returns 0", async () => {
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts(), {
      env: {},
      logger,
      tmuxFactory: () =>
        ({
          session: {
            listSessions: async () => {
              throw new Error("no server running");
            },
          },
        }) as unknown as TmuxNamespace,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("no tmux server on default socket");
  });

  test("Phase 1 — no legacy cockpit sessions on default socket returns 0", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        ["operator_personal", { windows: [{ index: 1, name: "shell" }], createdAt: 0 }],
      ]),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts(), {
      env: {},
      logger,
      tmuxFactory: () => makeMockTmux("default", defaultState),
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("already migrated");
  });

  test("Phase 1 — ATMUX_COCKPIT_SOCKET=default refuses (legacy = target)", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        ["atmux_cockpit", { windows: [{ index: 1, name: "_superdriver" }], createdAt: 0 }],
      ]),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts(), {
      env: { ATMUX_COCKPIT_SOCKET: "default" },
      logger,
      tmuxFactory: () => makeMockTmux("default", defaultState),
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("ATMUX_COCKPIT_SOCKET=default in effect");
  });

  test("Happy path — migrates atmux_cockpit + atmux_teams sessions, kills legacy", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        [
          "atmux_cockpit",
          {
            windows: [
              { index: 1, name: "_superdriver" },
              { index: 2, name: "_medic" },
            ],
            createdAt: 0,
          },
        ],
        ["atmux_teams", { windows: [{ index: 1, name: "viewer-x" }], createdAt: 0 }],
      ]),
      scrollback: new Map([
        ["atmux_cockpit:1", "superdriver tail"],
        ["atmux_cockpit:2", "medic tail"],
        ["atmux_teams:1", "viewer tail"],
      ]),
      ops: [],
    };
    const cockpitState: MockTmuxState = {
      sessions: new Map(),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts(), {
      env: {},
      logger,
      tmuxFactory: (cfg) => {
        if ("socket" in cfg && cfg.socket === "default") {
          return makeMockTmux("default", defaultState);
        }
        return makeMockTmux("cockpit", cockpitState);
      },
    });
    expect(code).toBe(0);
    // Phase 6 — both legacy sessions killed
    expect(defaultState.ops).toContain("default:killSession(atmux_cockpit)");
    expect(defaultState.ops).toContain("default:killSession(atmux_teams)");
    // Phase 3 — target session created on cockpit socket
    expect(cockpitState.sessions.has("atmux_cockpit")).toBe(true);
    // Phase 4 — windows recreated by name (relative order preserved)
    const newWins = cockpitState.sessions.get("atmux_cockpit")?.windows ?? [];
    const names = newWins.map((w) => w.name);
    expect(names).toContain("_superdriver");
    expect(names).toContain("_medic");
    expect(names).toContain("viewer-x");
    // Phase 5 — breadcrumb logged
    expect(logs.join("\n")).toContain("scrollback breadcrumb → /tmp/atmux-cockpit-migrate-");
  });

  test("--dry-run — no mutations on either socket", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        ["atmux_cockpit", { windows: [{ index: 1, name: "_superdriver" }], createdAt: 0 }],
      ]),
      scrollback: new Map([["atmux_cockpit:1", "tail"]]),
      ops: [],
    };
    const cockpitState: MockTmuxState = {
      sessions: new Map(),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts({ dryRun: true }), {
      env: {},
      logger,
      tmuxFactory: (cfg) =>
        "socket" in cfg && cfg.socket === "default"
          ? makeMockTmux("default", defaultState)
          : makeMockTmux("cockpit", cockpitState),
    });
    expect(code).toBe(0);
    // Legacy session preserved
    expect(defaultState.sessions.has("atmux_cockpit")).toBe(true);
    expect(defaultState.ops).not.toContain("default:killSession(atmux_cockpit)");
    // Cockpit socket never touched
    expect(cockpitState.sessions.size).toBe(0);
    expect(cockpitState.ops).toEqual([]);
    // Logger surfaces the preview
    expect(logs.join("\n")).toContain("[dry-run] would migrate window");
    expect(logs.join("\n")).toContain("no mutations applied");
  });

  test("--keep-legacy — Phase 6 cleanup skipped; recreate still runs", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        ["atmux_cockpit", { windows: [{ index: 1, name: "_superdriver" }], createdAt: 0 }],
      ]),
      scrollback: new Map([["atmux_cockpit:1", "tail"]]),
      ops: [],
    };
    const cockpitState: MockTmuxState = {
      sessions: new Map(),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts({ keepLegacy: true }), {
      env: {},
      logger,
      tmuxFactory: (cfg) =>
        "socket" in cfg && cfg.socket === "default"
          ? makeMockTmux("default", defaultState)
          : makeMockTmux("cockpit", cockpitState),
    });
    expect(code).toBe(0);
    expect(defaultState.sessions.has("atmux_cockpit")).toBe(true); // legacy preserved
    expect(defaultState.ops).not.toContain("default:killSession(atmux_cockpit)");
    expect(cockpitState.sessions.has("atmux_cockpit")).toBe(true); // new still created
    expect(logs.join("\n")).toContain("--keep-legacy set");
  });

  test("Idempotent — additive merge when target session already exists", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        [
          "atmux_cockpit",
          {
            windows: [
              { index: 1, name: "_superdriver" },
              { index: 2, name: "_medic" },
            ],
            createdAt: 0,
          },
        ],
      ]),
      scrollback: new Map(),
      ops: [],
    };
    // Pre-existing target session has _superdriver but not _medic
    const cockpitState: MockTmuxState = {
      sessions: new Map([
        ["atmux_cockpit", { windows: [{ index: 1, name: "_superdriver" }], createdAt: 0 }],
      ]),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts({ keepLegacy: true }), {
      env: {},
      logger,
      tmuxFactory: (cfg) =>
        "socket" in cfg && cfg.socket === "default"
          ? makeMockTmux("default", defaultState)
          : makeMockTmux("cockpit", cockpitState),
    });
    expect(code).toBe(0);
    const names = cockpitState.sessions.get("atmux_cockpit")?.windows.map((w) => w.name) ?? [];
    // _superdriver kept (already there), _medic added
    expect(names).toContain("_superdriver");
    expect(names).toContain("_medic");
    expect(logs.join("\n")).toContain("already present on target");
    expect(logs.join("\n")).toContain("1 window(s) created, 1 skipped");
  });

  test("Phase 6 kill-session failure warns + continues, doesn't throw", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        ["atmux_cockpit", { windows: [{ index: 1, name: "_superdriver" }], createdAt: 0 }],
      ]),
      scrollback: new Map(),
      ops: [],
    };
    const cockpitState: MockTmuxState = {
      sessions: new Map(),
      scrollback: new Map(),
      ops: [],
    };
    const { logger, logs } = makeLogger();
    // Override killSession on the default mock to throw
    const code = await cockpitMigrateSocket(migrateOpts(), {
      env: {},
      logger,
      tmuxFactory: (cfg) => {
        if ("socket" in cfg && cfg.socket === "default") {
          const base = makeMockTmux("default", defaultState);
          return {
            ...base,
            session: {
              ...base.session,
              killSession: async (name: string) => {
                defaultState.ops.push(`default:killSession-THROW(${name})`);
                throw new Error("simulated tmux failure");
              },
            },
          };
        }
        return makeMockTmux("cockpit", cockpitState);
      },
    });
    expect(code).toBe(0);
    expect(defaultState.ops).toContain("default:killSession-THROW(atmux_cockpit)");
    expect(logs.join("\n")).toContain("kill-session 'atmux_cockpit' on default socket failed");
    expect(logs.join("\n")).toContain("manually clean up with: tmux kill-session");
  });

  test("Phase 2 capturePane failure surfaces warn but continues to Phase 3+", async () => {
    const defaultState: MockTmuxState = {
      sessions: new Map([
        ["atmux_cockpit", { windows: [{ index: 1, name: "_superdriver" }], createdAt: 0 }],
      ]),
      scrollback: new Map(), // No seed → capturePane returns "" via stub
      ops: [],
    };
    const cockpitState: MockTmuxState = {
      sessions: new Map(),
      scrollback: new Map(),
      ops: [],
    };
    const { logger } = makeLogger();
    const code = await cockpitMigrateSocket(migrateOpts(), {
      env: {},
      logger,
      tmuxFactory: (cfg) => {
        if ("socket" in cfg && cfg.socket === "default") {
          const base = makeMockTmux("default", defaultState);
          return {
            ...base,
            pane: {
              ...base.pane,
              capturePane: async () => {
                throw new Error("pane gone");
              },
            },
          };
        }
        return makeMockTmux("cockpit", cockpitState);
      },
    });
    // Migration completes despite capture failure
    expect(code).toBe(0);
    expect(cockpitState.sessions.has("atmux_cockpit")).toBe(true);
  });
});

// ---------- `cockpit attach` subverb ----------
//
// ADR-162 §Decision-anchor #1 surfaces the convenience verb that closes
// the "where's my cockpit?" gap after the socket moved off the operator's
// default tmux server. Tests below are fully isolated: stubbed
// TmuxNamespace (no shelling to real tmux), temp-dir cockpit.json (no
// touching ~/.atmux/), and TMUX env save/restore so `attachWithTmux`'s
// in-call delete doesn't leak to sibling tests.

describe("parseCockpitArgs — attach subverb", () => {
  test("bare attach parses with default-false flags", () => {
    const p = parseCockpitArgs(["attach"]);
    expect(p.subverb).toBe("attach");
    expect(p.noCycle).toBe(false);
    expect(p.forceCycle).toBe(false);
    expect(p.noLaunch).toBe(false);
    expect(p.dryRun).toBe(false);
    expect(p.keepLegacy).toBe(false);
    expect(p.configPath).toBeUndefined();
  });

  test("attach accepts --config <path>", () => {
    const p = parseCockpitArgs(["attach", "--config", "/tmp/cockpit.json"]);
    expect(p.subverb).toBe("attach");
    expect(p.configPath).toBe("/tmp/cockpit.json");
  });

  test("attach accepts --human (ADR-180)", () => {
    const p = parseCockpitArgs(["attach", "--human"]);
    expect(p.subverb).toBe("attach");
    expect(p.human).toBe(true);
  });

  test("attach without --human defaults human=false (agent path)", () => {
    const p = parseCockpitArgs(["attach"]);
    expect(p.human).toBe(false);
  });

  test("attach accepts --human + --config together", () => {
    const p = parseCockpitArgs(["attach", "--human", "--config", "/tmp/c.json"]);
    expect(p.human).toBe(true);
    expect(p.configPath).toBe("/tmp/c.json");
  });

  test("rebuild rejects --human (attach-only flag)", () => {
    expect(() => parseCockpitArgs(["rebuild", "--human"])).toThrow(UsageError);
  });

  test("reload rejects --human (attach-only flag)", () => {
    expect(() => parseCockpitArgs(["reload", "--human"])).toThrow(UsageError);
  });

  test("migrate-socket rejects --human (attach-only flag)", () => {
    expect(() => parseCockpitArgs(["migrate-socket", "--human"])).toThrow(UsageError);
  });

  test("attach rejects --no-cycle (rebuild-only flag)", () => {
    expect(() => parseCockpitArgs(["attach", "--no-cycle"])).toThrow(UsageError);
  });

  test("attach rejects --force-cycle + ack (rebuild-only flag)", () => {
    expect(() =>
      parseCockpitArgs([
        "attach",
        "--force-cycle",
        "--acknowledge-dangerous-bau-interruption",
        "--yes",
      ]),
    ).toThrow(UsageError);
  });

  test("attach rejects --no-launch (rebuild-only flag)", () => {
    expect(() => parseCockpitArgs(["attach", "--no-launch"])).toThrow(UsageError);
  });

  test("attach rejects --dry-run (migrate-socket-only flag)", () => {
    expect(() => parseCockpitArgs(["attach", "--dry-run"])).toThrow(UsageError);
  });

  test("attach rejects --keep-legacy (migrate-socket-only flag)", () => {
    expect(() => parseCockpitArgs(["attach", "--keep-legacy"])).toThrow(UsageError);
  });

  test("unknown-sub-verb error names the valid set including attach", () => {
    try {
      parseCockpitArgs(["bogus"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect(String(e)).toContain("attach");
    }
  });
});

describe("cockpitAttach — isolated (stubbed tmux + temp cockpit.json)", () => {
  let workDir: string;
  let cockpitJson: string;
  let priorTmux: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "atmux-cockpit-attach-"));
    cockpitJson = join(workDir, "cockpit.json");
    // Snapshot + clear TMUX so the attach env-unset/restore dance is
    // observable + so a stale parent TMUX doesn't leak into the test.
    priorTmux = process.env.TMUX;
  });

  afterEach(async () => {
    if (priorTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = priorTmux;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  function attachOpts(overrides: Partial<ParsedCockpitArgs> = {}): ParsedCockpitArgs {
    return {
      subverb: "attach",
      noCycle: false,
      forceCycle: false,
      ackDangerous: false,
      noLaunch: false,
      yes: false,
      dryRun: false,
      keepLegacy: false,
      human: false,
      configPath: cockpitJson,
      ...overrides,
    };
  }

  function stubTmux(opts: {
    sessionExists: boolean;
    captureSocket?: (socket: string) => void;
    captureAttachTarget?: (target: string) => void;
    captureAttachPath?: (path: "piped" | "inherit") => void;
  }): TmuxNamespace {
    return {
      session: {
        async hasSession(name: string) {
          opts.captureAttachTarget?.(name);
          return opts.sessionExists;
        },
      },
      client: {
        async attachSession(_name: string) {
          opts.captureAttachPath?.("piped");
          // No-op: real attach would block on tty.
        },
        async attachSessionInheritStdio(_name: string) {
          opts.captureAttachPath?.("inherit");
          // No-op: real attach would block on tty (with parent stdio).
        },
      },
    } as unknown as TmuxNamespace;
  }

  test("resolves canonical socket (atmux-cockpit) when env override absent", async () => {
    await writeFile(
      cockpitJson,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [],
      }),
    );
    let capturedSocket: string | undefined;
    let capturedTarget: string | undefined;
    const exit = await cockpitAttach(attachOpts(), {
      env: {},
      tmuxFactory: (cfg) => {
        if ("socket" in cfg) capturedSocket = cfg.socket;
        return stubTmux({
          sessionExists: true,
          captureAttachTarget: (t) => {
            capturedTarget = t;
          },
        });
      },
    });
    expect(exit).toBe(0);
    expect(capturedSocket).toBe("atmux-cockpit");
    // attachWithTmux uses exactSessionTarget(=<name>) for the hasSession probe.
    expect(capturedTarget).toBe("=atmux_cockpit");
  });

  test("honours ATMUX_COCKPIT_SOCKET escape hatch (ADR-162 legacy operators)", async () => {
    await writeFile(
      cockpitJson,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [],
      }),
    );
    let capturedSocket: string | undefined;
    const exit = await cockpitAttach(attachOpts(), {
      env: { ATMUX_COCKPIT_SOCKET: "default" },
      tmuxFactory: (cfg) => {
        if ("socket" in cfg) capturedSocket = cfg.socket;
        return stubTmux({ sessionExists: true });
      },
    });
    expect(exit).toBe(0);
    expect(capturedSocket).toBe("default");
  });

  test("uses cockpitSession from cockpit.json (ADR-135 canonical field)", async () => {
    await writeFile(
      cockpitJson,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit_alt",
        sessions: [],
      }),
    );
    let capturedTarget: string | undefined;
    await cockpitAttach(attachOpts(), {
      env: {},
      tmuxFactory: () =>
        stubTmux({
          sessionExists: true,
          captureAttachTarget: (t) => {
            capturedTarget = t;
          },
        }),
    });
    expect(capturedTarget).toBe("=atmux_cockpit_alt");
  });

  test("ADR-180: human=false routes through piped-stdio attachSession", async () => {
    await writeFile(
      cockpitJson,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [],
      }),
    );
    let capturedPath: "piped" | "inherit" | undefined;
    await cockpitAttach(attachOpts({ human: false }), {
      env: {},
      tmuxFactory: () =>
        stubTmux({
          sessionExists: true,
          captureAttachPath: (p) => {
            capturedPath = p;
          },
        }),
    });
    expect(capturedPath).toBe("piped");
  });

  test("ADR-180: human=true routes through inherit-stdio attachSessionInheritStdio", async () => {
    await writeFile(
      cockpitJson,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [],
      }),
    );
    let capturedPath: "piped" | "inherit" | undefined;
    await cockpitAttach(attachOpts({ human: true }), {
      env: {},
      tmuxFactory: () =>
        stubTmux({
          sessionExists: true,
          captureAttachPath: (p) => {
            capturedPath = p;
          },
        }),
    });
    expect(capturedPath).toBe("inherit");
  });

  test("missing-session surfaces ConfigError (run 'atmux cockpit rebuild' hint)", async () => {
    await writeFile(
      cockpitJson,
      JSON.stringify({
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [],
      }),
    );
    await expect(
      cockpitAttach(attachOpts(), {
        env: {},
        tmuxFactory: () => stubTmux({ sessionExists: false }),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
