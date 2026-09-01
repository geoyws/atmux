import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { BOT_HOLD_OPTION } from "../../../src/core/bot.ts";
import type { LoadCockpitOpts, LoadedCockpit } from "../../../src/core/cockpit.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import { bot, parseBotArgs, setBotHoldWithTmux } from "../../../src/verbs/bot.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

const EXPECTED_ATMUX_TMUX_CONF_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "templates",
  "tmux",
  "atmux.conf",
);

function makeFakeBotTmux(
  sessionUp = true,
  windows: Array<{ index: number; id: string; name: string; active: boolean }> = [
    { index: 0, id: "@0", name: "_bot", active: true },
  ],
) {
  const calls = {
    hasSession: [] as string[],
    listWindows: [] as string[],
    setOption: [] as Array<{
      window: boolean;
      target: string;
      name: string;
      value: string;
    }>,
  };
  const tmux = {
    session: {
      async hasSession(name: string): Promise<boolean> {
        calls.hasSession.push(name);
        return sessionUp;
      },
    },
    window: {
      async listWindows(
        sessionName: string,
      ): Promise<{ index: number; id: string; name: string; active: boolean }[]> {
        calls.listWindows.push(sessionName);
        return windows;
      },
    },
    option: {
      async setOption(opts: {
        window: boolean;
        target: string;
        name: string;
        value: string;
      }): Promise<void> {
        calls.setOption.push(opts);
      },
    },
  } as unknown as TmuxNamespace;
  return { calls, tmux };
}

async function writeTeamFixture(root: string, team: Team, sessionName?: string): Promise<void> {
  const atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team, null, 2));
  if (sessionName !== undefined) {
    await writeFile(join(atmuxDir, "state", "session.txt"), `${sessionName}\n`);
  }
}

describe("parseBotArgs", () => {
  test("parses local and named-team forms", () => {
    expect(parseBotArgs(["hold"])).toEqual({ action: "hold" });
    expect(parseBotArgs(["resume", "atmux"])).toEqual({
      action: "resume",
      team: "atmux",
    });
  });

  test("rejects invalid actions, duplicate teams, and ambiguous roots", () => {
    expect(() => parseBotArgs([])).toThrow(UsageError);
    expect(() => parseBotArgs(["status"])).toThrow(UsageError);
    expect(() => parseBotArgs(["hold", "a", "b"])).toThrow(UsageError);
    expect(() => parseBotArgs(["hold", "a", "--team-dir", "/x"])).toThrow(UsageError);
  });

  test("parses --config and rejects a missing option value", () => {
    expect(parseBotArgs(["resume", "--config", "/tmp/cockpit.json"])).toEqual({
      action: "resume",
      configPath: "/tmp/cockpit.json",
    });
    expect(() => parseBotArgs(["hold", "--config"])).toThrow(UsageError);
    expect(() => parseBotArgs(["hold", "--bogus"])).toThrow(UsageError);
  });
});

describe("setBotHoldWithTmux — isolated tmux", () => {
  let dir = "";
  let homeDir = "";
  let tmux: TmuxNamespace;
  let restoreHome: (() => void) | undefined;
  const session = "atmux-bot-hold-test";
  const team: Team = {
    name: "demo",
    members: [],
    bot: { enabled: true, tui: null, cwd: ".atmux/worktrees/bot" },
  };

  beforeEach(async () => {
    delete process.env.TMUX;
    dir = await mkdtemp(join(tmpdir(), "atmux-bot-hold-"));
    homeDir = await mkdtemp(join(tmpdir(), "atmux-bot-home-"));
    restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
    tmux = createCanonicalAtmuxTmux({ socketPath: join(dir, "sock") });
    await tmux.session.newSession({ name: session, windowName: "_bot" });
    const opts = await tmux.option.showOptions({ global: true });
    const windowOpts = await tmux.option.showOptions({ global: true, window: true });
    expect(opts["base-index"]).toBe("1");
    expect(windowOpts["pane-base-index"]).toBe("0");
    expect(windowOpts["automatic-rename"]).toBe("off");
  });

  afterEach(async () => {
    if (tmux !== undefined) await tmux.server.killServer().catch(() => {});
    restoreHome?.();
    restoreHome = undefined;
    if (dir !== "") await rm(dir, { recursive: true, force: true });
    if (homeDir !== "") await rm(homeDir, { recursive: true, force: true });
  });

  test("hold and resume write only the _bot window option", async () => {
    await setBotHoldWithTmux(tmux, team, session, "hold");
    expect(
      (
        await tmux.option.showOptions({
          window: true,
          target: `${session}:_bot`,
        })
      )[BOT_HOLD_OPTION],
    ).toBe("1");

    await setBotHoldWithTmux(tmux, team, session, "resume");
    expect(
      (
        await tmux.option.showOptions({
          window: true,
          target: `${session}:_bot`,
        })
      )[BOT_HOLD_OPTION],
    ).toBe("0");
  });

  test("refuses a team without an enabled bot", async () => {
    await expect(
      setBotHoldWithTmux(tmux, { name: "demo", members: [] }, session, "hold"),
    ).rejects.toThrow(ConfigError);
  });

  test("refuses when the exact _bot window is absent", async () => {
    await tmux.window.renameWindow(`${session}:_bot`, "not-bot");
    await expect(setBotHoldWithTmux(tmux, team, session, "hold")).rejects.toThrow(ConfigError);
  });
});

describe("bot", () => {
  const baseTeam: Team = {
    name: "demo",
    members: [],
    bot: { enabled: true, tui: null, cwd: ".atmux/worktrees/bot" },
    tmuxTmpdir: "",
  };

  test("dispatches the local team-dir form through requireTeam and tmux", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-bot-local-"));
    const teamDir = join(root, "project");
    const tmuxTmpdir = join(root, "tmux");
    const team: Team = {
      ...baseTeam,
      name: "local-team",
      tmuxTmpdir,
    };
    await mkdir(teamDir, { recursive: true });
    await writeTeamFixture(teamDir, team, "local-session");

    const { calls, tmux } = makeFakeBotTmux();
    let factoryCfg: TmuxConfig | undefined;
    const tmuxFactory = (cfg: TmuxConfig) => {
      factoryCfg = cfg;
      return tmux;
    };

    try {
      await expect(bot(["hold", "--team-dir", teamDir], { tmuxFactory })).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(factoryCfg).toEqual({
      socketPath: join(tmuxTmpdir, `tmux-${process.getuid?.() ?? 0}`, "default"),
      configFile: EXPECTED_ATMUX_TMUX_CONF_PATH,
    });
    expect(calls.hasSession).toEqual(["local-session"]);
    expect(calls.listWindows).toEqual(["local-session"]);
    expect(calls.setOption).toEqual([
      {
        window: true,
        target: "local-session:_bot",
        name: BOT_HOLD_OPTION,
        value: "1",
      },
    ]);
  });

  test("dispatches the named-team form through cockpit lookup and cage resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-bot-named-"));
    const teamRoot = join(root, "demo-team");
    const teamName = `demo-${root.split("/").pop() ?? "named"}`;
    const team: Team = {
      ...baseTeam,
      name: teamName,
      tmuxTmpdir: join(root, "tmux"),
    };
    await mkdir(teamRoot, { recursive: true });
    await writeTeamFixture(teamRoot, team, "cage-session");
    await mkdir(join(teamRoot, ".atmux", "tmux", `tmux-${process.getuid?.() ?? 0}`), {
      recursive: true,
    });
    await writeFile(
      join(teamRoot, ".atmux", "tmux", `tmux-${process.getuid?.() ?? 0}`, "default"),
      "",
    );

    const { calls, tmux } = makeFakeBotTmux();
    let factoryCfg: TmuxConfig | undefined;
    const tmuxFactory = (cfg: TmuxConfig) => {
      factoryCfg = cfg;
      return tmux;
    };
    const loadedConfig: Array<{ path?: string }> = [];
    const loadCockpitFn = async (opts: LoadCockpitOpts = {}) => {
      loadedConfig.push(opts);
      return {
        sessions: [{ type: "team", name: teamName, root: teamRoot, enabled: true }],
      } as unknown as LoadedCockpit;
    };

    try {
      await expect(
        bot(["resume", teamName, "--config", "/tmp/cockpit.json"], {
          tmuxFactory,
          loadCockpitFn,
        }),
      ).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(loadedConfig).toEqual([{ path: "/tmp/cockpit.json" }]);
    expect(factoryCfg).toEqual({
      socketPath: join(teamRoot, ".atmux", "tmux", `tmux-${process.getuid?.() ?? 0}`, "default"),
      configFile: EXPECTED_ATMUX_TMUX_CONF_PATH,
    });
    expect(calls.hasSession).toEqual(["cage-session"]);
    expect(calls.listWindows).toEqual(["cage-session"]);
    expect(calls.setOption).toEqual([
      {
        window: true,
        target: "cage-session:_bot",
        name: BOT_HOLD_OPTION,
        value: "0",
      },
    ]);
  });

  test("refuses a named team that is missing from the cockpit", async () => {
    const loadCockpitCalls: Array<LoadCockpitOpts> = [];
    let tmuxFactoryCalled = false;
    const loadCockpitFn = async (opts: LoadCockpitOpts = {}) => {
      loadCockpitCalls.push(opts);
      return {
        sessions: [],
      } as unknown as LoadedCockpit;
    };
    const tmuxFactory = () => {
      tmuxFactoryCalled = true;
      throw new Error("tmuxFactory should not be called when the cockpit lookup fails");
    };

    await expect(
      bot(["hold", "missing", "--config", "/tmp/cockpit.json"], {
        loadCockpitFn,
        tmuxFactory,
      }),
    ).rejects.toThrow(ConfigError);

    expect(loadCockpitCalls).toEqual([{ path: "/tmp/cockpit.json" }]);
    expect(tmuxFactoryCalled).toBe(false);
  });

  test("refuses a loaded team whose cage session is not running", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-bot-stopped-"));
    const teamDir = join(root, "project");
    const team: Team = {
      ...baseTeam,
      name: "stopped-team",
      tmuxTmpdir: join(root, "tmux"),
    };
    await mkdir(teamDir, { recursive: true });
    await writeTeamFixture(teamDir, team, "stopped-session");
    const { calls, tmux } = makeFakeBotTmux(false);

    try {
      await expect(
        bot(["hold", "--team-dir", teamDir], { tmuxFactory: () => tmux }),
      ).rejects.toThrow(ConfigError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(calls.hasSession).toEqual(["stopped-session"]);
    expect(calls.listWindows).toEqual([]);
    expect(calls.setOption).toEqual([]);
  });

  test("refuses a loaded local team when the _bot window is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "atmux-bot-missing-window-"));
    const teamDir = join(root, "project");
    const team: Team = {
      ...baseTeam,
      name: "missing-window-team",
      tmuxTmpdir: join(root, "tmux"),
    };
    await mkdir(teamDir, { recursive: true });
    await writeTeamFixture(teamDir, team, "missing-window-session");
    const { calls, tmux } = makeFakeBotTmux(true, []);

    try {
      await expect(
        bot(["hold", "--team-dir", teamDir], { tmuxFactory: () => tmux }),
      ).rejects.toThrow(ConfigError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(calls.hasSession).toEqual(["missing-window-session"]);
    expect(calls.listWindows).toEqual(["missing-window-session"]);
    expect(calls.setOption).toEqual([]);
  });
});
