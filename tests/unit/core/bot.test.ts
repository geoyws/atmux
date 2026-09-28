import { describe, expect, test } from "bun:test";
import { renderBootPrompt } from "../../../src/core/boot-claude.ts";
import {
  BOT_HOLD_OPTION,
  BOT_WINDOW_NAME,
  botActor,
  botSendTarget,
  isBotRoutable,
} from "../../../src/core/bot.ts";

describe("bot identity primitives (superbot offer targets)", () => {
  test("pins actor, window, and send target identities", () => {
    expect(BOT_WINDOW_NAME).toBe("_bot");
    expect(BOT_HOLD_OPTION).toBe("@atmux_bot_hold");
    expect(botActor("atmux")).toBe("bot@atmux");
    expect(botSendTarget("atmux", "atmux")).toEqual({
      kind: "bot",
      team: "atmux",
      target: "atmux:_bot",
    });
  });

  test("only an enabled explicit non-shell harness is routable", () => {
    const cwd = ".atmux/worktrees/bot" as const;
    expect(isBotRoutable(undefined)).toBe(false);
    expect(isBotRoutable({ enabled: false, cwd, tui: "claude" })).toBe(false);
    expect(isBotRoutable({ enabled: true, cwd, tui: null })).toBe(false);
    expect(isBotRoutable({ enabled: true, cwd, tui: "zsh" })).toBe(false);
    expect(isBotRoutable({ enabled: true, cwd, tui: "claude" })).toBe(true);
  });

  test("bot bootstrap names the exact harness-neutral contract", () => {
    const prompt = renderBootPrompt("atmux", "_bot", "/opt/atmux/templates/briefs/bot.md");
    expect(prompt).toContain("echo $ATMUX_MEMBER");
    expect(prompt).toContain("/opt/atmux/templates/briefs/bot.md");
    expect(prompt).toContain("before accepting work");
    expect(prompt.includes("\n")).toBe(false);
  });
});
