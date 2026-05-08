// Unit tests for src/verbs/cockpit.ts — ADR-063 cockpit verb.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  applyCagePrefix,
  autolaunchTeam,
  buildTeamWindowCommand,
  cageAlive,
  cockpitRebuild,
  normaliseTeamJson,
  parseCockpitArgs,
  reconcileCockpitSession,
  resolveTeamWindowMode,
  type ResolveTeamWindowDeps,
} from "../../../src/verbs/cockpit.ts";
import type { CockpitTeam } from "../../../src/schema/cockpit.ts";
import type { Team } from "../../../src/schema/team.ts";

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
      noLaunch: false,
    });
  });
  test("each flag parses individually", () => {
    expect(parseCockpitArgs(["rebuild", "--no-cycle"]).noCycle).toBe(true);
    expect(parseCockpitArgs(["rebuild", "--force-cycle"]).forceCycle).toBe(true);
    expect(parseCockpitArgs(["rebuild", "--no-launch"]).noLaunch).toBe(true);
  });
  test("--config requires a value", () => {
    expect(() => parseCockpitArgs(["rebuild", "--config"])).toThrow(UsageError);
    expect(parseCockpitArgs(["rebuild", "--config", "/p"]).configPath).toBe("/p");
  });
  test("--no-cycle and --force-cycle are mutually exclusive", () => {
    expect(() => parseCockpitArgs(["rebuild", "--no-cycle", "--force-cycle"])).toThrow(UsageError);
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
    await normaliseTeamJson(
      { name: "x", root: projRoot, enabled: true } as CockpitTeam,
      logger,
    );
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
      );
      expect(summary).toEqual({ launched: 0, skipped: 0 });
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
      );
      expect(summary.launched).toBe(1);
      expect(summary.skipped).toBe(0);
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
      expect(opts["prefix"]).toBe("C-\\");
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
      expect(names).toContain("superdriver");
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
      // Second pass — drop "b".
      await reconcileCockpitSession(
        fx.tmux,
        "s",
        [{ name: "a", root: "/a", enabled: true } as CockpitTeam],
        logger,
      );
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name);
      expect(names).toContain("superdriver");
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

  test("ADR-077: superdoctor opt-in places window 2 between superdriver and team viewers", async () => {
    const fx = await spinTmux("cockpit-sd-fresh");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [
        { name: "alpha", root: "/a", enabled: true } as CockpitTeam,
        { name: "beta", root: "/b", enabled: true } as CockpitTeam,
      ];
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, {}, { enabled: true });
      const wins = await fx.tmux.window.listWindows("s");
      const byIndex = wins.slice().sort((a, b) => a.index - b.index);
      // Window 1 = superdriver (created by newSession); window 2 = superdoctor;
      // teams 3..N. Indices may not literally be 1,2,3 if tmux is configured
      // with base-index != 1, but RELATIVE order is what we assert.
      expect(byIndex[0]?.name).toBe("superdriver");
      expect(byIndex[1]?.name).toBe("superdoctor");
      expect(byIndex.slice(2).map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    } finally {
      try { await fx.tmux.server.killServer(); } catch {}
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
      expect(names).toEqual(["alpha", "superdriver"]);
    } finally {
      try { await fx.tmux.server.killServer(); } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: superdoctor reconcile is idempotent on re-run", async () => {
    const fx = await spinTmux("cockpit-sd-idem");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam];
      const sd = { enabled: true };
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, {}, sd);
      const before = (await fx.tmux.window.listWindows("s"))
        .slice().sort((a, b) => a.index - b.index)
        .map((w) => `${w.index}:${w.name}`);
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, {}, sd);
      const after = (await fx.tmux.window.listWindows("s"))
        .slice().sort((a, b) => a.index - b.index)
        .map((w) => `${w.index}:${w.name}`);
      expect(after).toEqual(before);
    } finally {
      try { await fx.tmux.server.killServer(); } catch {}
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
        .slice().sort((a, b) => a.index - b.index)
        .map((w) => w.name);
      expect(pre[0]).toBe("superdriver");
      expect(pre.slice(1).sort()).toEqual(["alpha", "beta"]);
      // Upgrade — superdoctor enabled.
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, {}, { enabled: true });
      const post = (await fx.tmux.window.listWindows("s"))
        .slice().sort((a, b) => a.index - b.index);
      expect(post[0]?.name).toBe("superdriver");
      expect(post[1]?.name).toBe("superdoctor");
      // Both teams must still be present (one was displaced + recreated).
      expect(post.slice(2).map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    } finally {
      try { await fx.tmux.server.killServer(); } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });

  test("ADR-077: orphan-prune preserves superdoctor", async () => {
    const fx = await spinTmux("cockpit-sd-orphan-skip");
    try {
      const { logger } = makeLogger();
      const teams: CockpitTeam[] = [{ name: "alpha", root: "/a", enabled: true } as CockpitTeam];
      // First pass with superdoctor + alpha.
      await reconcileCockpitSession(fx.tmux, "s", teams, logger, {}, { enabled: true });
      // Second pass with superdoctor still enabled but alpha removed —
      // alpha must be pruned, superdoctor must survive.
      await reconcileCockpitSession(fx.tmux, "s", [], logger, {}, { enabled: true });
      const names = (await fx.tmux.window.listWindows("s")).map((w) => w.name).sort();
      expect(names).toContain("superdriver");
      expect(names).toContain("superdoctor");
      expect(names).not.toContain("alpha");
    } finally {
      try { await fx.tmux.server.killServer(); } catch {}
      await rm(fx.socketDir, { recursive: true, force: true });
    }
  });
});

// ---------- ADR-077: buildSuperdoctorWindowCommand ----------

describe("buildSuperdoctorWindowCommand (ADR-077)", () => {
  test("emits bare claude invocation when claudeAccount is unset", async () => {
    const { buildSuperdoctorWindowCommand } = await import(
      "../../../src/verbs/cockpit.ts"
    );
    const cmd = buildSuperdoctorWindowCommand({ enabled: true });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
    expect(cmd).toContain("--permission-mode auto");
    expect(cmd).not.toContain("CLAUDE_CONFIG_DIR=");
  });

  test("emits CLAUDE_CONFIG_DIR prefix when claudeAccount is set", async () => {
    const { buildSuperdoctorWindowCommand } = await import(
      "../../../src/verbs/cockpit.ts"
    );
    const cmd = buildSuperdoctorWindowCommand({
      enabled: true,
      claudeAccount: { configDir: "/root/.claude-personal", label: "personal" },
    });
    expect(cmd).toContain("CLAUDE_CONFIG_DIR=/root/.claude-personal");
    expect(cmd).toContain("CLAUDE_CODE_EFFORT_LEVEL=xhigh");
    expect(cmd).toContain("--permission-mode auto");
  });

  test("honours tuiOverrides", async () => {
    const { buildSuperdoctorWindowCommand } = await import(
      "../../../src/verbs/cockpit.ts"
    );
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
});

describe("buildTeamWindowCommand", () => {
  const team = { name: "demo", root: "/d", enabled: true } as CockpitTeam;

  test("attach mode targets <session>:driver via the retry loop", () => {
    const cmd = buildTeamWindowCommand(team, "attach");
    expect(cmd).toContain("attach -t");
    expect(cmd).toContain(":driver");
    expect(cmd).toContain("while true");
    expect(cmd).toContain("sleep 1");
  });

  test("no-driver-config emits the 'set team.json::driverSession' guidance", () => {
    const cmd = buildTeamWindowCommand(team, "no-driver-config");
    expect(cmd).toContain("no driver configured for demo");
    expect(cmd).toContain("team.json::driverSession");
    expect(cmd).toContain("sleep infinity");
  });

  test("session-down emits the 'atmux start' guidance", () => {
    const cmd = buildTeamWindowCommand(team, "session-down");
    expect(cmd).toContain("session not running");
    expect(cmd).toContain("atmux start demo");
    expect(cmd).toContain("sleep infinity");
  });

  test("placeholder shell-quoting survives team names with apostrophes", () => {
    const apostropheTeam = { name: "ali's-team", root: "/x", enabled: true } as CockpitTeam;
    const cmd = buildTeamWindowCommand(apostropheTeam, "no-driver-config");
    // Resulting shell string is single-quoted; the apostrophe in the
    // team name must be escaped via the POSIX `'\''` idiom so the
    // surrounding `printf` quoting doesn't break.
    expect(cmd).toContain("'\\''");
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
        { subverb: "rebuild", noCycle: true, forceCycle: false, noLaunch: true },
        {
          env: { HOME: homeDir },
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
        { subverb: "rebuild", noCycle: false, forceCycle: false, noLaunch: true },
        {
          env: { HOME: homeDir },
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
        { subverb: "rebuild", noCycle: false, forceCycle: true, noLaunch: true },
        {
          env: { HOME: homeDir },
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
      { subverb: "rebuild", noCycle: true, forceCycle: false, noLaunch: true },
      { env: { HOME: homeDir }, logger },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("no enabled teams"))).toBe(true);
  });
});
