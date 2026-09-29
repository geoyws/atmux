// Unit tests for src/verbs/shutdown.ts (ADR-242).
// All seams faked — real tmux, cockpit.json and shutdown.log never touched.

import { describe, expect, test } from "bun:test";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  defaultShutdownStdout,
  defaultStopTeamFn,
  formatShutdownDuration,
  parseShutdownArgs,
  resolveShutdownLogPath,
  type ShutdownOpts,
  type ShutdownTeam,
  shutdown,
} from "../../../src/verbs/shutdown.ts";

function makeCockpit(names: ReadonlyArray<string>): LoadedCockpit {
  return {
    cockpitSession: "atx",
    sessions: names.map((name) => ({
      type: "team",
      name,
      root: `/tmp/teams/${name}`,
      enabled: true,
    })),
  } as unknown as LoadedCockpit;
}

interface FakeLogger extends Logger {
  logs: string[];
  warns: string[];
}

function makeLogger(): FakeLogger {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logs,
    warns,
    log: (m: string) => {
      logs.push(m);
    },
    ok: () => {},
    warn: (m: string) => {
      warns.push(m);
    },
    err: () => {},
  };
}

interface FakeTmux {
  ns: TmuxNamespace;
  killedSessions: string[];
  killServers: number;
  failSession: boolean;
  failServer: boolean;
  factories: number;
}

function makeFakeTmux(): FakeTmux {
  const fake: FakeTmux = {
    ns: null as unknown as TmuxNamespace,
    killedSessions: [],
    killServers: 0,
    failSession: false,
    failServer: false,
    factories: 0,
  };
  fake.ns = {
    session: {
      killSession: async (target: string) => {
        if (fake.failSession) throw new Error("no such session");
        fake.killedSessions.push(target);
      },
    },
    server: {
      killServer: async () => {
        if (fake.failServer) throw new Error("no server");
        fake.killServers += 1;
      },
    },
  } as unknown as TmuxNamespace;
  return fake;
}

interface FakeLog {
  content: string | null;
  appended: string[];
  rewritten: string[];
}

function makeFakeLog(initial: string | null = null): FakeLog {
  return { content: initial, appended: [], rewritten: [] };
}

interface Harness {
  opts: ShutdownOpts;
  logger: FakeLogger;
  fakeTmux: FakeTmux;
  fakeLog: FakeLog;
  stdout: string[];
  stopped: ShutdownTeam[];
  nowCalls: number;
}

function makeHarness(cockpit: LoadedCockpit, clock: ReadonlyArray<number> = [1000, 1500]): Harness {
  const logger = makeLogger();
  const fakeTmux = makeFakeTmux();
  const fakeLog = makeFakeLog();
  const stdout: string[] = [];
  const stopped: ShutdownTeam[] = [];
  let n = 0;
  const opts: ShutdownOpts = {
    env: {},
    loadCockpitFn: async () => cockpit,
    stopTeamFn: async (t: ShutdownTeam) => {
      stopped.push(t);
    },
    tmuxFactory: (_cfg: TmuxConfig) => {
      fakeTmux.factories += 1;
      return fakeTmux.ns;
    },
    readLogFn: async () => fakeLog.content,
    appendLogFn: async (_p: string, c: string) => {
      fakeLog.appended.push(c);
    },
    writeLogFn: async (_p: string, c: string) => {
      fakeLog.rewritten.push(c);
    },
    nowMs: () => clock[Math.min(n++, clock.length - 1)] ?? 0,
    logger,
    stdout: (line: string) => {
      stdout.push(line);
    },
  };
  return { opts, logger, fakeTmux, fakeLog, stdout, stopped, nowCalls: n };
}

describe("parseShutdownArgs", () => {
  test("empty argv → defaults", () => {
    expect(parseShutdownArgs([])).toEqual({ keepCockpit: false, force: false, dryRun: false });
  });

  test("each flag parses", () => {
    expect(parseShutdownArgs(["--keep-cockpit"])).toEqual({
      keepCockpit: true,
      force: false,
      dryRun: false,
    });
    expect(parseShutdownArgs(["--force"]).force).toBe(true);
    expect(parseShutdownArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseShutdownArgs(["--force", "--keep-cockpit", "--dry-run"])).toEqual({
      keepCockpit: true,
      force: true,
      dryRun: true,
    });
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseShutdownArgs(["--keep"])).toThrow(UsageError);
    expect(() => parseShutdownArgs(["team-a"])).toThrow(UsageError);
  });

  test("shutdown() surfaces parse errors → UsageError", async () => {
    const h = makeHarness(makeCockpit([]));
    await expect(shutdown(["--bogus"], h.opts)).rejects.toThrow(UsageError);
  });
});

describe("shutdown", () => {
  test("empty cockpit → just kills cockpit + server", async () => {
    const h = makeHarness(makeCockpit([]));
    const code = await shutdown([], h.opts);
    expect(code).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.fakeTmux.killedSessions).toEqual(["=atx"]);
    expect(h.fakeTmux.killServers).toBe(1);
    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0]).toContain("[atmux shutdown] 0/0 teams stopped, cockpit torn down (0.5s)");
    expect(h.fakeLog.appended).toHaveLength(1);
    expect(h.fakeLog.appended[0]).toContain("0/0 teams stopped");
  });

  test("multi-team best-effort: one stop throws → rest continue", async () => {
    const h = makeHarness(makeCockpit(["a", "b", "c"]));
    const attempted: string[] = [];
    h.opts.stopTeamFn = async (t: ShutdownTeam) => {
      attempted.push(t.name);
      if (t.name === "b") throw new Error("state.db locked");
    };
    const code = await shutdown([], h.opts);
    expect(code).toBe(0);
    expect(attempted).toEqual(["a", "b", "c"]);
    expect(h.logger.warns).toHaveLength(1);
    expect(h.logger.warns[0]).toContain("stop b failed (state.db locked)");
    expect(h.fakeTmux.killedSessions).toEqual(["=atx"]);
    expect(h.fakeTmux.killServers).toBe(1);
    expect(h.stdout[0]).toContain(
      "[atmux shutdown] 2/3 teams stopped (1 failed: b), cockpit torn down",
    );
  });

  test("--force skips per-team stops", async () => {
    const h = makeHarness(makeCockpit(["a", "b"]));
    const code = await shutdown(["--force"], h.opts);
    expect(code).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.fakeTmux.killedSessions).toEqual(["=atx"]);
    expect(h.fakeTmux.killServers).toBe(1);
    expect(h.stdout[0]).toContain("per-team stop skipped (--force), cockpit torn down");
  });

  test("--keep-cockpit skips kills", async () => {
    const h = makeHarness(makeCockpit(["a", "b"]));
    const code = await shutdown(["--keep-cockpit"], h.opts);
    expect(code).toBe(0);
    expect(h.stopped.map((t) => t.name)).toEqual(["a", "b"]);
    expect(h.fakeTmux.factories).toBe(0);
    expect(h.fakeTmux.killedSessions).toEqual([]);
    expect(h.fakeTmux.killServers).toBe(0);
    expect(h.stdout[0]).toContain("[atmux shutdown] 2/2 teams stopped, cockpit kept");
  });

  test("kill failures warn + continue, exit stays 0", async () => {
    const h = makeHarness(makeCockpit(["a"]));
    h.fakeTmux.failSession = true;
    h.fakeTmux.failServer = true;
    const code = await shutdown([], h.opts);
    expect(code).toBe(0);
    expect(h.stopped.map((t) => t.name)).toEqual(["a"]);
    expect(h.logger.warns.join("\n")).toContain("kill-session atx failed");
    expect(h.logger.warns.join("\n")).toContain("kill-server failed");
    expect(h.stdout[0]).toContain("cockpit torn down");
  });

  test("--dry-run enumerates, changes nothing, exit 0", async () => {
    const h = makeHarness(makeCockpit(["a", "b"]));
    const code = await shutdown(["--dry-run"], h.opts);
    expect(code).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.fakeTmux.factories).toBe(0);
    expect(h.fakeLog.appended).toEqual([]);
    expect(h.fakeLog.rewritten).toEqual([]);
    expect(h.logger.logs.join("\n")).toContain("would stop team a");
    expect(h.stdout[0]).toContain("dry-run: would stop 2 team(s), would tear down cockpit");
  });

  test("--dry-run with --force --keep-cockpit reflects flags", async () => {
    const h = makeHarness(makeCockpit(["a"]));
    const code = await shutdown(["--dry-run", "--force", "--keep-cockpit"], h.opts);
    expect(code).toBe(0);
    expect(h.stopped).toEqual([]);
    expect(h.fakeTmux.factories).toBe(0);
    expect(h.stdout[0]).toContain("would skip per-team stop, would keep cockpit");
  });

  test("cockpit loader failure propagates", async () => {
    const h = makeHarness(makeCockpit([]));
    h.opts.loadCockpitFn = async () => {
      throw new ConfigError({ what: "no cockpit config", hint: "seed one" });
    };
    await expect(shutdown([], h.opts)).rejects.toThrow(ConfigError);
  });
});

describe("shutdown.log", () => {
  test("append when under the 10-entry cap", async () => {
    const h = makeHarness(makeCockpit(["a"]));
    h.fakeLog.content = "l1\nl2\n";
    const code = await shutdown([], h.opts);
    expect(code).toBe(0);
    expect(h.fakeLog.appended).toHaveLength(1);
    expect(h.fakeLog.rewritten).toEqual([]);
  });

  test("rewrite keeps last 10 on overflow", async () => {
    const h = makeHarness(makeCockpit([]));
    const prior = Array.from({ length: 10 }, (_, i) => `old-${i}`);
    h.fakeLog.content = `${prior.join("\n")}\n`;
    await shutdown([], h.opts);
    expect(h.fakeLog.appended).toEqual([]);
    expect(h.fakeLog.rewritten).toHaveLength(1);
    const kept = h.fakeLog.rewritten[0]?.split("\n").filter((l) => l.length > 0) ?? [];
    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe("old-1");
    expect(kept[9]).toContain("[atmux shutdown]");
  });

  test("exactly at cap appends without rewrite", async () => {
    const h = makeHarness(makeCockpit([]));
    const prior = Array.from({ length: 9 }, (_, i) => `old-${i}`);
    h.fakeLog.content = `${prior.join("\n")}\n`;
    await shutdown([], h.opts);
    expect(h.fakeLog.appended).toHaveLength(1);
    expect(h.fakeLog.rewritten).toEqual([]);
  });
});

describe("helpers", () => {
  test("formatShutdownDuration", () => {
    expect(formatShutdownDuration(0)).toBe("0.0s");
    expect(formatShutdownDuration(500)).toBe("0.5s");
    expect(formatShutdownDuration(12500)).toBe("12.5s");
  });

  test("resolveShutdownLogPath honours home override", () => {
    expect(resolveShutdownLogPath({ home: "/tmp/fakehome" })).toBe(
      "/tmp/fakehome/.atmux/state/shutdown.log",
    );
    expect(resolveShutdownLogPath({ env: { HOME: "/tmp/envhome" } })).toBe(
      "/tmp/envhome/.atmux/state/shutdown.log",
    );
  });

  test("defaultStopTeamFn fails loud on a bogus team dir (no live tmux)", async () => {
    await expect(
      defaultStopTeamFn({ name: "nope", root: "/tmp/atmux-shutdown-no-such-team-dir" }),
    ).rejects.toThrow();
  });

  test("defaultShutdownStdout writes to process.stdout", () => {
    const orig = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      defaultShutdownStdout("hello\n");
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toBe("hello\n");
  });
});
