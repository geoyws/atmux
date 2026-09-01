import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { BOT_HOLD_OPTION } from "../../../src/core/bot.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import { parseBotArgs, setBotHoldWithTmux } from "../../../src/verbs/bot.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

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
