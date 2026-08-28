import { describe, expect, test } from "bun:test";
import { renderBootPrompt } from "../../../src/core/boot-claude.ts";
import {
  BOT_DEFAULT_CWD,
  BOT_HOLD_OPTION,
  BOT_WINDOW_NAME,
  botActor,
  botBranch,
  botSendTarget,
  botWindowTarget,
  isBotRoutable,
  resolveBotCwd,
} from "../../../src/core/bot.ts";

describe("ADR-281 bot identity primitives", () => {
  test("pins actor, window, worktree, and branch identities", () => {
    expect(BOT_WINDOW_NAME).toBe("_bot");
    expect(BOT_HOLD_OPTION).toBe("@atmux_bot_hold");
    expect(botActor("atmux")).toBe("bot@atmux");
    expect(botBranch("atmux-geoyws")).toBe("atmux-geoyws-bot");
    expect(resolveBotCwd("/work/atmux")).toBe(`/work/atmux/${BOT_DEFAULT_CWD}`);
    expect(botWindowTarget("atmux")).toBe("atmux:_bot");
    expect(botSendTarget("atmux", "atmux")).toEqual({
      kind: "bot",
      team: "atmux",
      target: "atmux:_bot",
    });
  });

  test("only an enabled explicit non-shell harness is routable", () => {
    expect(isBotRoutable(undefined)).toBe(false);
    expect(isBotRoutable({ enabled: false, cwd: BOT_DEFAULT_CWD, tui: "claude" })).toBe(false);
    expect(isBotRoutable({ enabled: true, cwd: BOT_DEFAULT_CWD, tui: null })).toBe(false);
    expect(isBotRoutable({ enabled: true, cwd: BOT_DEFAULT_CWD, tui: "zsh" })).toBe(false);
    expect(isBotRoutable({ enabled: true, cwd: BOT_DEFAULT_CWD, tui: "claude" })).toBe(true);
  });

  test("bot bootstrap names the exact harness-neutral contract", () => {
    const prompt = renderBootPrompt("atmux", "_bot", "/opt/atmux/templates/briefs/bot.md");
    expect(prompt).toContain("echo $ATMUX_MEMBER");
    expect(prompt).toContain("/opt/atmux/templates/briefs/bot.md");
    expect(prompt).toContain("before accepting work");
    expect(prompt.includes("\n")).toBe(false);
  });
});
