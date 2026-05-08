// ADR-063: TUI launch command resolver. Ported from `lib/tui.sh`.
//
// Pure function — given a member entry + the parent team, returns the
// shell command string to send-keys into the member's pane. The send
// itself happens in the verb (start.ts / cockpit.ts), not here.
//
// Resolution priority (highest first):
//
//   1. member.command       — full override, used verbatim. atmux still
//                             prepends `cd <cwd> &&` and the env prefix.
//
//   2. team.tuiCommands[tui] — per-team alias: full launch prefix for a
//                             TUI. Model flag is appended UNLESS the
//                             prefix already contains `--model`.
//
//   3. built-in default     — atmux::tui_claude / tui_opencode / etc.
//
// Bash mirror: `lib/tui.sh::atmux::tui_cmd` (committed atmux 5d2e6f1).
// Behaviour parity verified by tests/unit/core/tui-cmd.test.ts —
// every priority branch + every built-in TUI exercised.

import type { TeamMember, Team as TeamShape } from "../schema/team.ts";
import { UsageError } from "../errors.ts";

export interface ResolveTuiOpts {
  /** Process env. Defaults to `process.env`. Test injection point —
   *  ATMUX_CLAUDE_BIN / ATMUX_CLAUDE_EFFORT / ATMUX_CLAUDE_PERMISSION /
   *  ATMUX_OPENCODE_BIN / ATMUX_OPENCODE_DEFAULT_MODEL / ATMUX_KIMI_BIN /
   *  ATMUX_KIMI_DEFAULT_MODEL / ATMUX_CURSOR_BIN / ATMUX_CURSOR_DEFAULT_MODEL
   *  knobs are read here. */
  env?: NodeJS.ProcessEnv;
  /** Override the member's cwd. Defaults to `member.cwd ?? "."`. */
  cwd?: string;
}

/**
 * Resolve the launch command for a member.
 *
 * @param member — entry from `team.members[]`
 * @param team   — the parent team (for `tuiCommands[<tui>]` lookup)
 * @param opts   — env/cwd injection points
 * @returns the shell command string, ready for `tmux send-keys`.
 *
 * Throws UsageError when `member.tui` is an unknown built-in name AND
 * neither `member.command` nor `team.tuiCommands[<tui>]` covers it —
 * mirrors bash `atmux::die`.
 */
export function resolveTuiCommand(
  member: TeamMember,
  team: TeamShape,
  opts: ResolveTuiOpts = {},
): string {
  const env = opts.env ?? process.env;
  const tui = member.tui ?? "claude";
  const model = member.model ?? "default";
  const cwd = opts.cwd ?? member.cwd ?? ".";
  const name = member.name;
  const role = member.role ?? "member";

  // 1. member.command full override.
  if (member.command !== undefined && member.command.length > 0) {
    return composeOverride(name, cwd, member.command);
  }

  // 2. team.tuiCommands[<tui>] prefix.
  const tcRaw = team.tuiCommands;
  if (tcRaw !== undefined && tcRaw !== null && typeof tcRaw === "object") {
    const tc = tcRaw as Record<string, unknown>;
    const prefix = tc[tui];
    if (typeof prefix === "string" && prefix.length > 0) {
      return composeCustom(name, cwd, prefix, model);
    }
  }

  // 3. Built-in defaults.
  switch (tui) {
    case "claude":
      return tuiClaude(name, cwd, model, member, env);
    case "opencode":
      return tuiOpencode(name, cwd, model, env);
    case "kimi":
      return tuiKimi(name, cwd, model, env);
    case "cursor":
      return tuiCursor(name, cwd, model, env);
    case "shell":
    case "bash":
    case "zsh":
      return tuiShell(name, cwd);
    default:
      throw new UsageError({
        what: `unknown tui type: '${tui}' for member '${name}' (role=${role})`,
        hint: 'use one of: claude, opencode, kimi, cursor, shell — OR register it in team.json\'s "tuiCommands"',
      });
  }
}

// ---------- Built-ins ----------

function tuiClaude(
  name: string,
  cwd: string,
  model: string,
  member: TeamMember,
  env: NodeJS.ProcessEnv,
): string {
  const bin = env.ATMUX_CLAUDE_BIN ?? "claude";
  const effort = env.ATMUX_CLAUDE_EFFORT ?? "xhigh";
  const permission = env.ATMUX_CLAUDE_PERMISSION ?? "dontAsk";
  const modelFlag = composeModelFlag(model);
  // Per-member account isolation (ADR §"Per-member Claude account"):
  // `member.claudeAccount` is a passthrough field on the schema (TeamMember
  // is .passthrough()). When present + non-default, prefix the command
  // with CLAUDE_CONFIG_DIR=$HOME/.claude-<account>.
  const home = env.HOME ?? "";
  let accountEnv = "";
  const ma = (member as unknown as Record<string, unknown>).claudeAccount;
  if (typeof ma === "string" && ma.length > 0 && ma !== "default" && home.length > 0) {
    accountEnv = `CLAUDE_CONFIG_DIR=${posixQuote(`${home}/.claude-${ma}`)} `;
  }
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && ${accountEnv}CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=${effort} ${bin} --permission-mode ${permission}${modelFlag}`;
}

function tuiOpencode(name: string, cwd: string, model: string, env: NodeJS.ProcessEnv): string {
  const bin = env.ATMUX_OPENCODE_BIN ?? "opencode";
  const m =
    model === "default" || model.length === 0
      ? (env.ATMUX_OPENCODE_DEFAULT_MODEL ?? "minimax-coding-plan/MiniMax-M2.7-highspeed")
      : model;
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && ${bin} --model ${posixQuote(m)}`;
}

function tuiKimi(name: string, cwd: string, model: string, env: NodeJS.ProcessEnv): string {
  const bin = env.ATMUX_KIMI_BIN ?? "kimi";
  const m =
    model === "default" || model.length === 0 ? (env.ATMUX_KIMI_DEFAULT_MODEL ?? "kimi-latest") : model;
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && ${bin} --model ${posixQuote(m)}`;
}

function tuiCursor(name: string, cwd: string, model: string, env: NodeJS.ProcessEnv): string {
  const bin = env.ATMUX_CURSOR_BIN ?? "cursor-agent";
  const m =
    model === "default" || model.length === 0 ? (env.ATMUX_CURSOR_DEFAULT_MODEL ?? "composer-2") : model;
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && ${bin} --model ${posixQuote(m)}`;
}

function tuiShell(name: string, cwd: string): string {
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && exec $SHELL`;
}

// ---------- Composers ----------

function composeOverride(name: string, cwd: string, command: string): string {
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && ${command}`;
}

function composeCustom(name: string, cwd: string, prefix: string, model: string): string {
  // Append `--model <model>` UNLESS the prefix already names a model OR
  // model is "default". Bash mirror: `_atmux_compose_custom` (lib/tui.sh:65-74).
  let modelFlag = "";
  if (model.length > 0 && model !== "default" && !prefix.includes("--model")) {
    modelFlag = ` --model ${posixQuote(model)}`;
  }
  return `${envPrefix(name)} cd ${posixQuote(cwd)} && ${prefix}${modelFlag}`;
}

function composeModelFlag(model: string): string {
  if (model.length === 0 || model === "default") return "";
  return ` --model ${posixQuote(model)}`;
}

/** `export ATMUX_MEMBER=<name> &&` — lets `atmux claim`/`done` infer the
 *  member without `--as` per the bash `_atmux_env_prefix` convention.
 *  Exposed for tests. */
export function envPrefix(name: string): string {
  return `export ATMUX_MEMBER=${posixQuote(name)} &&`;
}

/** POSIX shell single-quote escape (`printf %q` semantic): wraps in
 *  single quotes, escapes embedded single quotes via the `'\''` pattern.
 *  Exported for tests. */
export function posixQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/^[\w./@%+:=,_-]+$/.test(s)) return s; // no quoting needed
  return `'${s.replace(/'/g, "'\\''")}'`;
}
