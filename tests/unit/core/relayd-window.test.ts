// Unit tests for src/core/relayd-window.ts (ADR-202 §Amendment 2026-05-22 II).
//
// Coverage:
//   - Gate failures: autoMerge.enabled !== true, no committer/gitter,
//     ATMUX_HONKER=off all return false without spawning.
//   - Idempotency: window already present → skip spawn.
//   - Success path: spawns window + sends supervisor wrapper command.
//   - Failure isolation: tmux.window.newWindow throws → logged + returns
//     false, never propagates.
//   - listWindows throws → fall through to spawn (degrade gracefully).
//
// Audit checklist invariants pinned:
//   - SIGTERM trap present in supervisor command.
//   - Circuit breaker (5 crashes in 60s) present.
//   - Clean exit (rc=0) doesn't restart.
//   - Logging tee to .atmux/logs/relayd.log.

import { describe, expect, test } from "bun:test";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { maybeSpawnRelaydWindow, RELAYD_WINDOW } from "../../../src/core/relayd-window.ts";
import type { Team } from "../../../src/schema/team.ts";

// Minimal Team fixture per the schema shape.
function team(overrides: Partial<Team> = {}): Team {
  return {
    name: "demo",
    members: [
      { name: "be-1", role: "member", lane: "be" },
      { name: "committer", role: "committer", lane: "misc" },
    ],
    autoMerge: { enabled: true },
    ...overrides,
  } as Team;
}

// Mock tmux namespace with recording hooks. Every unused namespace
// member throws so accidental coupling surfaces loud.
function mockTmux(opts: {
  listWindowsResult?: Array<{ index: number; id: string; name: string; active: boolean }>;
  listWindowsThrows?: boolean;
  newWindowThrows?: boolean;
}): {
  tmux: TmuxNamespace;
  newWindowCalls: Array<{ sessionName: string; name: string; cwd?: string }>;
  sendKeysCalls: Array<{ keys: string; enter: boolean }>;
} {
  const newWindowCalls: Array<{ sessionName: string; name: string; cwd?: string }> = [];
  const sendKeysCalls: Array<{ keys: string; enter: boolean }> = [];
  const notImpl = (path: string) => () => {
    throw new Error(`mockTmux: ${path} not implemented`);
  };
  const tmux = {
    session: {
      newSession: notImpl("session.newSession"),
      hasSession: notImpl("session.hasSession"),
      killSession: notImpl("session.killSession"),
      killServer: notImpl("session.killServer"),
      hasServer: notImpl("session.hasServer"),
      listSessions: notImpl("session.listSessions"),
      renameSession: notImpl("session.renameSession"),
      setEnvironment: notImpl("session.setEnvironment"),
    },
    server: {
      killServer: notImpl("server.killServer"),
      hasServer: notImpl("server.hasServer"),
    },
    window: {
      newWindow: async (params: { sessionName: string; name: string; cwd?: string }) => {
        if (opts.newWindowThrows) {
          throw new Error("mock newWindow failure");
        }
        const cwd = params.cwd;
        newWindowCalls.push(cwd === undefined ? { sessionName: params.sessionName, name: params.name } : { sessionName: params.sessionName, name: params.name, cwd });
        return { windowIndex: 99, sessionName: params.sessionName, id: "@99" };
      },
      killWindow: notImpl("window.killWindow"),
      listWindows: async (_session: string) => {
        if (opts.listWindowsThrows) throw new Error("mock listWindows failure");
        return opts.listWindowsResult ?? [];
      },
      renameWindow: notImpl("window.renameWindow"),
      selectWindow: notImpl("window.selectWindow"),
      moveWindow: notImpl("window.moveWindow"),
      swapWindow: notImpl("window.swapWindow"),
    },
    pane: {
      sendKeys: async (opts: { keys: string; enter: boolean }) => {
        sendKeysCalls.push({ keys: opts.keys, enter: opts.enter });
      },
      capturePane: notImpl("pane.capturePane"),
      listPanes: notImpl("pane.listPanes"),
      displayMessage: notImpl("pane.displayMessage"),
      killPane: notImpl("pane.killPane"),
      splitWindow: notImpl("pane.splitWindow"),
    },
    buffer: {
      loadBuffer: notImpl("buffer.loadBuffer"),
      pasteBuffer: notImpl("buffer.pasteBuffer"),
      deleteBuffer: notImpl("buffer.deleteBuffer"),
      listBuffers: notImpl("buffer.listBuffers"),
    },
    info: { showOptions: notImpl("info.showOptions") },
  } as unknown as TmuxNamespace;
  return { tmux, newWindowCalls, sendKeysCalls };
}

function makeLogger(): { logger: { log: (s: string) => void; ok: (s: string) => void; warn: (s: string) => void; err: (s: string) => void; }; logs: string[] } {
  const logs: string[] = [];
  return {
    logger: {
      log: (s: string) => logs.push(`LOG ${s}`),
      ok: (s: string) => logs.push(`OK ${s}`),
      warn: (s: string) => logs.push(`WARN ${s}`),
      err: (s: string) => logs.push(`ERR ${s}`),
    },
    logs,
  };
}

describe("maybeSpawnRelaydWindow — gating", () => {
  test("autoMerge.enabled !== true → returns false, no spawn", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team({ autoMerge: undefined }),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
  });

  test("no committer/gitter role → returns false, no spawn", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team({
        members: [
          { name: "be-1", role: "member", lane: "be" },
          { name: "fe-1", role: "member", lane: "fe" },
        ],
      }),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
  });

  test("legacy 'gitter' role accepted as committer-equivalent (ADR-159 grace)", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team({
        members: [
          { name: "be-1", role: "member", lane: "be" },
          { name: "gitter", role: "gitter", lane: "misc" },
        ],
      }),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(true);
    expect(newWindowCalls).toHaveLength(1);
  });

  test("ATMUX_HONKER=off → returns false, logs reason, no spawn", async () => {
    const { tmux, newWindowCalls } = mockTmux({});
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: { ATMUX_HONKER: "off" },
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
    expect(logs.some((l) => l.includes("ATMUX_HONKER=off"))).toBe(true);
  });

  test("ATMUX_HONKER=0 / false / OFF all treated as disabled", async () => {
    for (const value of ["0", "false", "OFF", "False"]) {
      const { tmux, newWindowCalls } = mockTmux({});
      const { logger } = makeLogger();
      const result = await maybeSpawnRelaydWindow({
        team: team(),
        session: "atmux::demo",
        teamRoot: "/srv/demo",
        tmux,
        logger,
        env: { ATMUX_HONKER: value },
      });
      expect(result).toBe(false);
      expect(newWindowCalls).toHaveLength(0);
    }
  });
});

describe("maybeSpawnRelaydWindow — idempotence", () => {
  test("window already exists → returns false, no spawn, log explains", async () => {
    const { tmux, newWindowCalls } = mockTmux({
      listWindowsResult: [{ index: 5, id: "@5", name: RELAYD_WINDOW, active: false }],
    });
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
    expect(logs.some((l) => l.includes("already exists"))).toBe(true);
  });

  test("listWindows throws → log warn + fall through to spawn attempt", async () => {
    const { tmux, newWindowCalls } = mockTmux({ listWindowsThrows: true });
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(true);
    expect(newWindowCalls).toHaveLength(1);
    expect(logs.some((l) => l.includes("listWindows failed"))).toBe(true);
  });
});

describe("maybeSpawnRelaydWindow — success path", () => {
  test("happy path: spawns window with correct name + cwd, sends wrapper command", async () => {
    const { tmux, newWindowCalls, sendKeysCalls } = mockTmux({});
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(true);
    expect(newWindowCalls).toHaveLength(1);
    expect(newWindowCalls[0]).toEqual({
      sessionName: "atmux::demo",
      name: RELAYD_WINDOW,
      cwd: "/srv/demo",
    });
    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0]?.enter).toBe(true);
    expect(logs.some((l) => l.includes("spawned service window"))).toBe(true);
  });

  test("supervisor command includes SIGTERM trap", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("trap");
    expect(cmd).toContain("SIGTERM");
    expect(cmd).toContain("SIGINT");
    expect(cmd).toContain("SIGHUP");
  });

  test("supervisor command includes circuit breaker (5 crashes / 60s)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("CRASH_COUNT");
    expect(cmd).toContain("-ge 5");
    expect(cmd).toContain("CIRCUIT BREAKER");
  });

  test("supervisor command exits cleanly on rc=0 (no restart)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("RC -eq 0");
    expect(cmd).toContain("not restarting");
  });

  test("supervisor command logs to .atmux/logs/relayd.log via tee", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("tee -a .atmux/logs/relayd.log");
    expect(cmd).toContain("mkdir -p .atmux/logs");
  });

  test("supervisor command invokes 'atmux relayd --start' (ADR-202 §V)", async () => {
    const { tmux, sendKeysCalls } = mockTmux({});
    const { logger } = makeLogger();
    await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    const cmd = sendKeysCalls[0]?.keys ?? "";
    expect(cmd).toContain("atmux relayd --start");
  });
});

describe("maybeSpawnRelaydWindow — failure isolation", () => {
  test("newWindow throws → log warn + return false, never propagates", async () => {
    const { tmux, newWindowCalls } = mockTmux({ newWindowThrows: true });
    const { logger, logs } = makeLogger();
    const result = await maybeSpawnRelaydWindow({
      team: team(),
      session: "atmux::demo",
      teamRoot: "/srv/demo",
      tmux,
      logger,
      env: {},
    });
    expect(result).toBe(false);
    expect(newWindowCalls).toHaveLength(0);
    expect(logs.some((l) => l.includes("spawn failed"))).toBe(true);
    expect(logs.some((l) => l.includes("cron --drain still active"))).toBe(true);
  });
});
