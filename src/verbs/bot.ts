// ADR-280 §D3 — operator availability interlock for the cooperative
// per-team `_bot` seat. This verb only mutates a window-scoped tmux
// option; it never claims, assigns, or changes Kanban work state.

import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import { BOT_HOLD_OPTION, BOT_WINDOW_NAME, botWindowTarget } from "../core/bot.ts";
import {
  findTeamByName,
  loadCockpit,
  resolveCageSessionName,
  resolveCageSocket,
} from "../core/cockpit.ts";
import {
  getSessionName,
  loadTeam,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { getAtmuxTmuxConfPath } from "../core/tmux-paths.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

const USAGE = "atmux bot <hold|resume> [team] [--team-dir <root>] [--config <path>]";

export interface BotArgs {
  action: "hold" | "resume";
  team?: string;
  teamDir?: string;
  configPath?: string;
}

export function parseBotArgs(argv: ReadonlyArray<string>): BotArgs {
  const action = argv[0];
  if (action !== "hold" && action !== "resume") {
    throw new UsageError({ what: "bot: expected hold or resume", hint: USAGE });
  }
  let team: string | undefined;
  let teamDir: string | undefined;
  let configPath: string | undefined;
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--team-dir" || arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0) {
        throw new UsageError({ what: `bot: ${arg} requires a value`, hint: USAGE });
      }
      if (arg === "--team-dir") teamDir = value;
      else configPath = value;
      i += 2;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new UsageError({ what: `bot: unknown argument: ${arg}`, hint: USAGE });
    }
    if (team !== undefined) {
      throw new UsageError({ what: "bot: at most one team may be named", hint: USAGE });
    }
    team = arg;
    i += 1;
  }
  if (team !== undefined && teamDir !== undefined) {
    throw new UsageError({ what: "bot: team and --team-dir are mutually exclusive", hint: USAGE });
  }
  const out: BotArgs = { action };
  if (team !== undefined) out.team = team;
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (configPath !== undefined) out.configPath = configPath;
  return out;
}

/** Inner mutation, exported for unit tests with a fake namespace. */
export async function setBotHoldWithTmux(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  action: "hold" | "resume",
): Promise<void> {
  if (team.bot?.enabled !== true) {
    throw new ConfigError({
      what: `bot: team '${team.name}' has no enabled bot seat`,
      hint: "add an enabled team.json::bot block and run atmux start",
    });
  }
  if (!(await tmux.session.hasSession(sessionName))) {
    throw new ConfigError({
      what: `bot: session '${sessionName}' is not running`,
      hint: "run atmux start before changing the bot interlock",
    });
  }
  const windows = await tmux.window.listWindows(sessionName);
  if (!windows.some((window) => window.name === BOT_WINDOW_NAME)) {
    throw new ConfigError({
      what: `bot: ${sessionName}:${BOT_WINDOW_NAME} does not exist`,
      hint: "run atmux start to provision the configured bot seat",
    });
  }
  await tmux.option.setOption({
    window: true,
    target: botWindowTarget(sessionName),
    name: BOT_HOLD_OPTION,
    value: action === "hold" ? "1" : "0",
  });
}

export interface BotOpts {
  tmuxFactory?: typeof createTmux;
  loadCockpitFn?: typeof loadCockpit;
}

export async function bot(argv: ReadonlyArray<string>, opts: BotOpts = {}): Promise<number> {
  const parsed = parseBotArgs(argv);
  let team: Team;
  let sessionName: string;
  let socketPath: string;

  if (parsed.team !== undefined) {
    const cockpitOpts = parsed.configPath !== undefined ? { path: parsed.configPath } : {};
    const cockpit = await (opts.loadCockpitFn ?? loadCockpit)(cockpitOpts);
    const entry = findTeamByName(cockpit, parsed.team);
    if (entry === null || entry.type !== "team") {
      throw new ConfigError({
        what: `bot: no persistent parent team named '${parsed.team}' in cockpit`,
        hint: "v1 bot seats are not inherited by epic/worker teams",
      });
    }
    team = await loadTeam({ teamDir: entry.root });
    sessionName = await resolveCageSessionName(entry);
    socketPath = await resolveCageSocket(entry.name, entry.root);
  } else {
    const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
    team = await requireTeam(dirOpts);
    sessionName = await getSessionName({ ...dirOpts, team });
    socketPath = resolveTeamSocket(team);
  }

  const factory = opts.tmuxFactory ?? createTmux;
  const tmux = factory({ socketPath, configFile: getAtmuxTmuxConfPath() });
  await setBotHoldWithTmux(tmux, team, sessionName, parsed.action);
  return 0;
}
