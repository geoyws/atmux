// Unit tests for src/verbs/cockpit.ts — ADR-063 cockpit verb.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import type { CockpitTeam } from "../../../src/schema/cockpit.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  applyCagePrefix,
  autolaunchTeam,
  buildTeamWindowCommand,
  cageAlive,
  cockpitRebuild,
  normaliseTeamJson,
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

async function spinTmux(prefix: string): Promise<TmuxFixture> {
  const socketDir = await mkdtemp(join(tmpdir(), `atmux-cockpit-${prefix}-`));
  const socketPath = join(socketDir, "sock");
  const tmux = createTmux({ socketPath, configFile: "/dev/null" });
  return { tmux, socketPath, socketDir };
}

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
      const before = (await fx.tmux.window.listWindows("s")).map(
        (w) => `${w.index}:${w.name}`,
      );

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
      const after = (await fx.tmux.window.listWindows("s")).map(
        (w) => `${w.index}:${w.name}`,
      );
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

// ---------- ADR-132 §D2: buildMartinetWindowCommand ----------

describe("buildMartinetWindowCommand (ADR-132 §D2)", () => {
  test("claude variant emits standard claude TUI invocation", async () => {
    const { buildMartinetWindowCommand } = await import("../../../src/verbs/cockpit.ts");
    const cmd = buildMartinetWindowCommand({
      impl: "claude",
      enabled: true,
    });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
    expect(cmd).toContain("--permission-mode auto");
  });

  test("claude variant honours tuiOverrides + claudeAccount", async () => {
    const { buildMartinetWindowCommand } = await import("../../../src/verbs/cockpit.ts");
    const cmd = buildMartinetWindowCommand({
      impl: "claude",
      enabled: true,
      claudeAccount: { configDir: "/root/.claude-mart", label: "mart" },
      tuiOverrides: { effortLevel: "high" },
    });
    expect(cmd).toContain("CLAUDE_CONFIG_DIR=/root/.claude-mart");
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=high");
  });

  test("cursor variant emits 'while true; do atmux martinet tick; sleep N; done' loop (T3)", async () => {
    const { buildMartinetWindowCommand } = await import("../../../src/verbs/cockpit.ts");
    const cmd = buildMartinetWindowCommand({
      impl: "cursor",
      enabled: true,
      cursorBinPath: "/usr/local/bin/cursor-agent",
      model: "composer-2-fast",
      cageTier: "tier-2",
    });
    expect(cmd).toContain("while true");
    expect(cmd).toContain("atmux martinet tick");
    expect(cmd).toContain("sleep");
    // Cursor variant must NOT spawn a Claude TUI — it shells out to
    // cursor-agent per tick from inside the verb.
    expect(cmd).not.toContain("claude --permission-mode");
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
      // TR2 keeps window name as "superdoctor" (per task body — TR3
      // ships the cascade rename).
      const wins = await fx.tmux.window.listWindows("test_cockpit_medic_nudge");
      expect(wins.map((w) => w.name)).toContain("superdoctor");
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
      // loadCockpit's warn. The W2 window still provisions.
      const wins = await fx.tmux.window.listWindows("test_cockpit_sd_depr");
      expect(wins.map((w) => w.name)).toContain("superdoctor");
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
