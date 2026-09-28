// ADR-285 — cooperative per-team `_bot` seat primitives.
//
// This module deliberately does not import the member or driver lifecycle.
// `_bot` is an operator-cooperative automation target: it may receive a
// verified offer from `_superbot`. Driver panes are a separate seat with
// their own lifecycle (ADR-239), not a flavour of this one.

import type { SendTarget } from "../abstractions/tmux.ts";
import type { Team } from "../schema/team.ts";

export const BOT_WINDOW_NAME = "_bot";
export const BOT_HOLD_OPTION = "@atmux_bot_hold";

export type TeamBot = NonNullable<Team["bot"]>;

/** Canonical Kanban actor for exact-task claims. */
export function botActor(teamName: string): string {
  return `bot@${teamName}`;
}

/** A shell-only bot is valid for direct operator work but cannot receive
 *  unattended offers. Harness choice must be explicit for routing. */
export function isBotRoutable(bot: TeamBot | undefined): boolean {
  if (bot?.enabled !== true) return false;
  const tui = bot.tui;
  return (
    typeof tui === "string" && tui.length > 0 && tui !== "shell" && tui !== "bash" && tui !== "zsh"
  );
}

/** Typed input target for bootstrapping and later verified offers. */
export function botSendTarget(teamName: string, sessionName: string): SendTarget {
  return {
    kind: "bot",
    team: teamName,
    target: `${sessionName}:${BOT_WINDOW_NAME}`,
  };
}

