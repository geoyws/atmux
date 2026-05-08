// ADR-063: cockpit verb — orchestrate the operator superdriver cockpit.
//
// `atmux cockpit rebuild` is idempotent ensure-up. Pre-bash-port (ADR-046,
// ADR-048, ADR-050) the rebuild was a hax-only bash script in operator
// dotfiles; this is the canonical bun home, with roster sourced from
// `~/.atmux/cockpit.json` (loader: src/core/cockpit.ts).
//
// Phases (all idempotent):
//
//   1. normalise team.json on each enabled team — set bareWindowNames=true
//      and write tuiCommands.claude from the cockpit roster's claudeAccount
//      / tuiOverrides config (when present)
//   2. cycle dead cages (live-team-aware: a cage with running claude
//      procs is preserved unless --force-cycle). Calls `start` in-process
//      per team to spawn the bare-shell member windows
//   3. apply the C-\ cage prefix to every cage tmux server
//   4. auto-launch the TUI in each non-claude pane via resolveTuiCommand
//      + tmux send-keys (skip with --no-launch)
//   5. reconcile cockpit session (default `atmux_teams` per ADR-046) on
//      the operator's default tmux socket: window 1 = superdriver,
//      windows 2..N = one viewer per enabled team that nest-attaches
//      to the cage via `tmux -S <sock> attach -t <session>` in a
//      retry-loop (covers cage restarts + first-attach race)
//
// Sub-verbs landed in this commit: `rebuild`. The rest of the verb
// family sketched in ADR-063 §D1 (list / add / remove / enable /
// disable / status) is follow-up; rebuild is the workhorse and the only
// piece the dotfiles bash script exercised, so this is enough to retire
// the script and let the proper bun path become the runtime.

import { dirname } from "node:path";
import { ensureDir } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import {
  cageSessionName,
  cageSocketPath,
  enabledTeams,
  loadCockpit,
  type LoadCockpitOpts,
} from "../core/cockpit.ts";
import { loadTeam, teamJsonPath } from "../core/common.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { resolveTuiCommand } from "../core/tui-cmd.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import { Team } from "../schema/team.ts";
import type { CockpitTeam } from "../schema/cockpit.ts";
import { UsageError } from "../errors.ts";
import { start } from "./start.ts";

// ---------- Arg parsing ----------

export interface ParsedCockpitArgs {
  /** sub-verb (only `rebuild` for now). */
  subverb: "rebuild";
  /** Skip the cage cycle phase (only normalise team.json + reconcile cockpit). */
  noCycle: boolean;
  /** Cycle every cage even if claude procs are running (DESTRUCTIVE — kills in-flight work). */
  forceCycle: boolean;
  /** Skip the TUI auto-launch step (cages stay as bare shells). */
  noLaunch: boolean;
  /** Override cockpit.json path. */
  configPath?: string;
}

/**
 * Parse `cockpit` argv. Throws UsageError on unknown subverb / flag.
 *
 * Usage:
 *   atmux cockpit rebuild [--no-cycle] [--force-cycle] [--no-launch]
 *                         [--config <path>]
 */
export function parseCockpitArgs(args: ReadonlyArray<string>): ParsedCockpitArgs {
  if (args.length === 0) {
    throw new UsageError({
      what: "cockpit: missing sub-verb",
      hint: "usage: atmux cockpit rebuild [--no-cycle | --force-cycle] [--no-launch] [--config <path>]",
    });
  }
  const sub = args[0];
  if (sub !== "rebuild") {
    throw new UsageError({
      what: `cockpit: unknown sub-verb: ${sub}`,
      hint: "only 'rebuild' is implemented in this commit",
    });
  }

  let noCycle = false;
  let forceCycle = false;
  let noLaunch = false;
  let configPath: string | undefined;

  let i = 1;
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--no-cycle":
        noCycle = true;
        i += 1;
        break;
      case "--force-cycle":
        forceCycle = true;
        i += 1;
        break;
      case "--no-launch":
        noLaunch = true;
        i += 1;
        break;
      case "--config": {
        const val = args[i + 1];
        if (val === undefined || val.length === 0) {
          throw new UsageError({
            what: "cockpit rebuild: --config requires a value",
            hint: "usage: atmux cockpit rebuild [--config <path>]",
          });
        }
        configPath = val;
        i += 2;
        break;
      }
      default:
        throw new UsageError({
          what: `cockpit rebuild: unknown arg: ${a}`,
          hint: "see 'atmux cockpit --help'",
        });
    }
  }

  if (noCycle && forceCycle) {
    throw new UsageError({
      what: "cockpit rebuild: --no-cycle and --force-cycle are mutually exclusive",
    });
  }

  const out: ParsedCockpitArgs = { subverb: "rebuild", noCycle, forceCycle, noLaunch };
  if (configPath !== undefined) out.configPath = configPath;
  return out;
}

// ---------- Verb entry ----------

export interface CockpitOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Inject the tmux factory for tests (default: `createTmux`). Each
   *  cage and the cockpit session itself construct via this factory
   *  with their own socket config. */
  tmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Logger sink override (default: `createLogger()`, stderr). */
  logger?: Logger;
  /** Test seam: in-process `start` invocation. Defaults to the real
   *  `start` verb. Tests stub this to assert dispatch shape without
   *  spinning a real tmux session. */
  startFn?: typeof start;
}

/** Top-level dispatch for `atmux cockpit <subverb>`. */
export async function cockpit(args: ReadonlyArray<string>, opts: CockpitOpts = {}): Promise<number> {
  const parsed = parseCockpitArgs(args);
  switch (parsed.subverb) {
    case "rebuild":
      return await cockpitRebuild(parsed, opts);
  }
}

/** The rebuild flow. Exported for direct unit-test access. */
export async function cockpitRebuild(
  parsed: ParsedCockpitArgs,
  opts: CockpitOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const factory = opts.tmuxFactory ?? createTmux;
  const startImpl = opts.startFn ?? start;

  // Phase 0: load roster.
  const loadOpts: LoadCockpitOpts = { env };
  if (parsed.configPath !== undefined) loadOpts.path = parsed.configPath;
  const cockpit = await loadCockpit(loadOpts);
  const teams = enabledTeams(cockpit);
  if (teams.length === 0) {
    logger.warn("no enabled teams in cockpit.json — nothing to do");
    return 0;
  }
  logger.log(`cockpit roster: ${teams.map((t) => t.name).join(", ")}`);

  // Phase 1: normalise each team's team.json (bareWindowNames + tuiCommands.claude).
  for (const t of teams) {
    await normaliseTeamJson(t, logger);
  }

  // Phase 2: cycle cages (live-team-aware unless --force-cycle).
  if (!parsed.noCycle) {
    for (const t of teams) {
      const sock = cageSocketPath(t.name);
      const cageTmux = factory({ socketPath: sock });
      const alive = await cageAlive(cageTmux);
      if (alive && !parsed.forceCycle) {
        logger.log(`  · ${t.name} cage alive — skipping cycle (use --force-cycle to override)`);
        continue;
      }
      logger.log(`  ▸ ${t.name} cage ${alive ? "force-cycle" : "dead/empty"} — start`);
      // Pre-create socket parent — tmux/atmux-bun don't auto-mkdir (the
      // failure that prompted ADR-063 in the first place).
      await ensureDir(dirname(sock));
      // Run start in-process. Use a per-team env that doesn't pin
      // ATMUX_DIR (would override the per-team cwd-walk).
      const teamEnv: NodeJS.ProcessEnv = { ...env };
      delete teamEnv.ATMUX_DIR;
      delete teamEnv.ATMUX_TEAM_DIR;
      delete teamEnv.ATMUX_SESSION;
      const startArgs = parsed.forceCycle ? ["--force", "--no-doctor"] : ["--no-doctor"];
      await startImpl(startArgs, { env: teamEnv, cwd: t.root, logger });
    }
  }

  // Phase 3: apply C-\ cage prefix on every enabled cage.
  for (const t of teams) {
    const sock = cageSocketPath(t.name);
    const cageTmux = factory({ socketPath: sock });
    await applyCagePrefix(cageTmux);
  }

  // Phase 4: TUI auto-launch (idempotent — skips panes already on claude).
  if (!parsed.noLaunch) {
    for (const t of teams) {
      const sock = cageSocketPath(t.name);
      const cageTmux = factory({ socketPath: sock });
      const teamSummary = await autolaunchTeam(t, cageTmux, env, logger);
      logger.log(
        `  ✓ ${t.name}: launched=${teamSummary.launched} skipped=${teamSummary.skipped} (already-claude)`,
      );
    }
  }

  // Phase 5: cockpit session on default socket.
  const cockpitTmux = factory({ socket: "default" });
  await reconcileCockpitSession(cockpitTmux, cockpit.cockpitSession, teams, logger);

  logger.ok(`cockpit ready. attach: tmux attach -t ${cockpit.cockpitSession}`);
  return 0;
}

// ---------- Phase helpers (exported for test directness) ----------

/**
 * Set bareWindowNames=true and write tuiCommands.claude from the cockpit
 * team's claudeAccount + tuiOverrides config (when claudeAccount is
 * present). Idempotent — repeated runs converge.
 */
export async function normaliseTeamJson(team: CockpitTeam, logger: Logger): Promise<void> {
  const path = teamJsonPath(`${team.root}/.atmux`);
  await updateJson(path, Team, (current) => {
    const next = { ...current, bareWindowNames: true } as typeof current;
    if (team.claudeAccount !== undefined) {
      const ov = team.tuiOverrides;
      const effort = ov?.effortLevel ?? "xhigh";
      const permission = ov?.permissionMode ?? "auto";
      const pluginFlag = ov?.pluginDir !== undefined ? ` --plugin-dir=${ov.pluginDir}` : "";
      const prefix =
        `CLAUDE_CONFIG_DIR=${team.claudeAccount.configDir} ` +
        `CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=${effort} CLAUDE_GUARD_AGENT=1 ` +
        `claude${pluginFlag} --permission-mode ${permission}`;
      const tcRaw = next.tuiCommands;
      const tc =
        tcRaw !== undefined && tcRaw !== null && typeof tcRaw === "object"
          ? { ...(tcRaw as Record<string, unknown>) }
          : {};
      tc.claude = prefix;
      next.tuiCommands = tc;
    }
    return next;
  });
  logger.log(`  ✓ ${team.name} → ${path}`);
}

/** True iff the cage's tmux server is up AND has at least one pane
 *  whose current command is `claude` (or `node`, which can be the
 *  bun-claude or claude-code wrapper while it boots). */
export async function cageAlive(cageTmux: TmuxNamespace): Promise<boolean> {
  if (!(await cageTmux.server.hasServer())) return false;
  // listSessions throws if no server / no sessions — wrap defensively.
  let sessions: { name: string }[];
  try {
    sessions = await cageTmux.session.listSessions();
  } catch {
    return false;
  }
  if (sessions.length === 0) return false;
  for (const s of sessions) {
    const windows = await cageTmux.window.listWindows(s.name);
    for (const w of windows) {
      const target = `${s.name}:${w.index}`;
      try {
        const cmd = await cageTmux.pane.displayMessage({
          target,
          format: "#{pane_current_command}",
          print: true,
        });
        const trimmed = cmd.trim();
        if (trimmed === "claude" || trimmed === "node") return true;
      } catch {
        // ignore — pane may be in transition
      }
    }
  }
  return false;
}

/** Apply the C-\ cage prefix. Best-effort — failures swallow (the
 *  prefix is cosmetic, not a precondition for cage operation). */
export async function applyCagePrefix(cageTmux: TmuxNamespace): Promise<void> {
  try {
    await cageTmux.option.setOption({ name: "prefix", value: "C-\\", global: true });
  } catch {
    // ignored
  }
}

export interface AutolaunchSummary {
  launched: number;
  skipped: number;
}

/**
 * For each pane in the cage that's NOT already running claude, send the
 * resolved TUI command via tmux send-keys. Skips panes already on
 * claude/node so re-runs are idempotent.
 */
export async function autolaunchTeam(
  team: CockpitTeam,
  cageTmux: TmuxNamespace,
  env: NodeJS.ProcessEnv,
  _logger: Logger,
): Promise<AutolaunchSummary> {
  const session = cageSessionName(team.name);
  // Read the team.json to drive resolveTuiCommand per member. We re-read
  // here (not relying on phase-1's mutator return) so this helper stays
  // independently callable (test directness + the --no-cycle path).
  const teamShape = await loadTeam({ teamDir: team.root });
  let launched = 0;
  let skipped = 0;
  let windows: { index: number; name: string }[];
  try {
    windows = await cageTmux.window.listWindows(session);
  } catch {
    // No session yet — happens under --no-cycle on a never-started cage.
    return { launched, skipped };
  }
  for (const w of windows) {
    const target = `${session}:${w.index}`;
    let cur = "";
    try {
      cur = (
        await cageTmux.pane.displayMessage({
          target,
          format: "#{pane_current_command}",
          print: true,
        })
      ).trim();
    } catch {
      continue;
    }
    if (cur === "claude" || cur === "node") {
      skipped += 1;
      continue;
    }
    // Match window name back to a member entry. Window names are
    // `<emoji><member>` per ADR-017 (buildWindowName). Find the member
    // whose name is a suffix of the window name.
    const member = teamShape.members.find((m) => w.name.endsWith(m.name));
    if (member === undefined) continue; // home placeholder etc.
    const cmd = resolveTuiCommand(member, teamShape, { env });
    await cageTmux.pane.sendKeys({
      target: { kind: "member", member: member.name, team: team.name, target },
      keys: cmd,
      enter: true,
    });
    launched += 1;
  }
  return { launched, skipped };
}

/**
 * Reconcile the cockpit session: ensure it exists with window 1 =
 * `superdriver`, and one viewer window per enabled team. Removes
 * windows for disabled teams. Idempotent.
 */
export async function reconcileCockpitSession(
  cockpitTmux: TmuxNamespace,
  sessionName: string,
  teams: CockpitTeam[],
  logger: Logger,
): Promise<void> {
  const has = await cockpitTmux.session.hasSession(sessionName);
  if (!has) {
    await cockpitTmux.session.newSession({
      name: sessionName,
      detached: true,
      windowName: "superdriver",
    });
    logger.log(`  ✓ created session ${sessionName} (window 1: superdriver)`);
  }
  const windows = await cockpitTmux.window.listWindows(sessionName);
  const present = new Set(windows.map((w) => w.name));
  const wanted = new Set(["superdriver", ...teams.map((t) => t.name)]);

  // Add missing viewer windows.
  for (const t of teams) {
    if (present.has(t.name)) {
      logger.log(`  · window '${t.name}' already present`);
      continue;
    }
    const sock = cageSocketPath(t.name);
    const session = cageSessionName(t.name);
    // Retry-loop: covers cage restart + first-attach race. Sleeps 1s
    // between retries so the cage can come up after its own start.
    const cmd = `while true; do tmux -S ${sock} attach -t ${session} 2>/dev/null; sleep 1; done`;
    await cockpitTmux.window.newWindow({
      sessionName,
      name: t.name,
      detached: true,
      shellCommand: cmd,
    });
    logger.log(`  ✓ added window '${t.name}'`);
  }

  // Remove orphan viewer windows (e.g. team that was removed/disabled).
  for (const w of windows) {
    if (wanted.has(w.name)) continue;
    if (w.name === "superdriver") continue;
    try {
      await cockpitTmux.window.killWindow(`${sessionName}:${w.name}`);
      logger.log(`  ✓ removed orphan window '${w.name}'`);
    } catch {
      // window may already be gone
    }
  }
}

