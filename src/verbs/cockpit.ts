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
import type { CockpitSuperdoctor, CockpitTeam } from "../schema/cockpit.ts";
import { UsageError } from "../errors.ts";
import { start } from "./start.ts";

// ---------- ADR-064 §3: per-team driverSession resolution ----------

/** What the cockpit's per-team viewer window should display. */
export type TeamWindowMode =
  /** team.driverSession is null/missing — config-level placeholder. */
  | "no-driver-config"
  /** team.driverSession is set but cage isn't running / has no `driver`
   *  window — point the operator at `atmux start <team>`. */
  | "session-down"
  /** team.driverSession is set + cage live + has a `driver` window —
   *  attach the cockpit viewer to `<session>:driver` (OQ4 default). */
  | "attach";

export interface ResolveTeamWindowDeps {
  /** Override `loadTeam` for tests. Default reads `<root>/.atmux/team.json`. */
  loadTeam?: (opts: { teamDir: string }) => Promise<Team>;
  /** Build the team's cage TmuxNamespace. Default `createTmux({socketPath})`. */
  createCageTmux?: (teamName: string) => TmuxNamespace;
}

interface DriverSessionShape {
  tui?: string | null;
  command?: string;
}

/**
 * Inspect the team.json + the cage socket to decide which mode the
 * per-team cockpit window should run in. Pure modulo IO — every IO
 * call is gated through `deps` for tests.
 *
 * Returns `"no-driver-config"` when `driverSession` is null/missing
 * (regardless of cage state — the operator must opt into the driver
 * pane via team.json before the cockpit can attach). Otherwise probes
 * the cage: if the team session exists AND has a `driver` window,
 * returns `"attach"`; otherwise `"session-down"`.
 *
 * Failures (missing team.json, cage tmux unreachable) collapse to a
 * placeholder mode rather than throwing — the cockpit rebuild must
 * stay green even when a member team is misconfigured.
 */
export async function resolveTeamWindowMode(
  team: CockpitTeam,
  deps: ResolveTeamWindowDeps = {},
): Promise<TeamWindowMode> {
  const loader = deps.loadTeam ?? loadTeam;
  let teamShape: Team;
  try {
    teamShape = await loader({ teamDir: team.root });
  } catch {
    // Missing/unreadable team.json → treat as "not configured" so the
    // operator sees an explanatory placeholder, not an opaque error.
    return "no-driver-config";
  }
  const ds = (teamShape as { driverSession?: DriverSessionShape | null }).driverSession;
  if (ds === undefined || ds === null) return "no-driver-config";

  // driverSession is configured — probe the cage. We use a fresh
  // TmuxNamespace per team since each cage runs on its own socket
  // (ADR-018). Probe failures (cage tmux not reachable, no session)
  // → "session-down" placeholder rather than tearing down the rebuild.
  const cageFactory = deps.createCageTmux ?? makeDefaultCageTmux;
  let cageTmux: TmuxNamespace;
  try {
    cageTmux = cageFactory(team.name);
  } catch {
    return "session-down";
  }
  const session = cageSessionName(team.name);
  try {
    if (!(await cageTmux.session.hasSession(session))) return "session-down";
    const wins = await cageTmux.window.listWindows(session);
    if (!wins.some((w) => w.name === "driver")) return "session-down";
    return "attach";
  } catch {
    return "session-down";
  }
}

function makeDefaultCageTmux(teamName: string): TmuxNamespace {
  return createTmux({ socketPath: cageSocketPath(teamName) });
}

/**
 * Build the shell command the cockpit per-team window runs. Switches
 * on `mode`:
 *
 *   - `"attach"` — same retry-loop pattern as the pre-ADR-064 cockpit
 *     viewer, but targets `<session>:driver` so the cockpit operator
 *     lands on the team's driver pane on focus (OQ4 default).
 *   - `"no-driver-config"` / `"session-down"` — print an explanatory
 *     line + `sleep infinity` so the window stays alive (operator can
 *     re-read at any time; rebuild restores attach on next run after
 *     remediation).
 */
export function buildTeamWindowCommand(team: CockpitTeam, mode: TeamWindowMode): string {
  const sock = cageSocketPath(team.name);
  const session = cageSessionName(team.name);
  switch (mode) {
    case "attach":
      // Retry-loop covers cage restart + first-attach race; sleeps 1s
      // between retries so the cage can come up after its own start.
      // Targeting `<session>:driver` (vs bare `<session>`) lands the
      // operator on the driver pane per OQ4.
      return `while true; do tmux -S ${sock} attach -t ${session}:driver 2>/dev/null; sleep 1; done`;
    case "no-driver-config":
      return shellPlaceholder(
        `no driver configured for ${team.name} — set team.json::driverSession to enable`,
      );
    case "session-down":
      return shellPlaceholder(
        `team ${team.name} session not running — atmux start ${team.name}`,
      );
  }
}

/** Shell-quote-safe single-message placeholder. The single-quote
 *  embedding follows POSIX convention (`'foo'\''bar'` for an embedded
 *  apostrophe); team / driverSession identifiers don't normally contain
 *  apostrophes but the escape keeps the verb robust. */
function shellPlaceholder(msg: string): string {
  const safe = msg.replace(/'/g, "'\\''");
  return `printf '%s\\n' '${safe}'; sleep infinity`;
}

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
  await reconcileCockpitSession(
    cockpitTmux,
    cockpit.cockpitSession,
    teams,
    logger,
    {},
    cockpit.superdoctor,
  );

  logger.ok(`cockpit ready. attach: tmux attach -t ${cockpit.cockpitSession}`);
  // ADR-077: nudge the operator to start the superdoctor loop manually.
  // Rebuild stays purely topological — auto-firing `/loop /superdoctor`
  // on every rebuild would either re-fire on idempotent re-runs or need
  // fragile send-keys timing against a freshly-spawned claude. Manual
  // start is one slash command and matches how the operator drives
  // superdriver in window 1.
  if (cockpit.superdoctor?.enabled === true) {
    logger.log(
      `  ▸ superdoctor: select window 2 ('superdoctor') and type \`/loop /superdoctor\` to start the hourly diagnosis loop`,
    );
  }
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
 * `superdriver`, an optional window 2 = `superdoctor` (ADR-077), and
 * one viewer window per enabled team. Removes windows for disabled
 * teams. Idempotent.
 *
 * ADR-064 §3 + §OQ4 — each per-team window runs in one of three
 * modes resolved by `resolveTeamWindowMode`:
 *   - `attach` — `tmux -S <sock> attach -t <session>:driver` (lands on
 *      the team's driver pane).
 *   - `no-driver-config` — placeholder explaining `driverSession` is
 *      unset.
 *   - `session-down` — placeholder explaining the cage isn't running.
 *
 * ADR-077 — the superdoctor window is optional and singleton:
 *   - When `superdoctor?.enabled === true`, it occupies cockpit window
 *     index 2 (between superdriver and the team viewers). On first
 *     upgrade from a pre-ADR-077 cockpit, an existing team viewer at
 *     index 2 is killed-and-recreated to preserve the slot invariant.
 *   - When unset / disabled, cockpit shape is unchanged from ADR-063
 *     (team viewers occupy 2..N).
 *
 * Idempotence: when a window already exists for `t.name`, this function
 * preserves it as-is — matching the pre-ADR-064 behaviour. State
 * transitions (e.g., team gained driverSession after first rebuild)
 * land on the next rebuild that actually creates the window (operator
 * removes the placeholder, re-runs).
 */
export async function reconcileCockpitSession(
  cockpitTmux: TmuxNamespace,
  sessionName: string,
  teams: CockpitTeam[],
  logger: Logger,
  deps: ResolveTeamWindowDeps = {},
  superdoctor?: CockpitSuperdoctor,
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

  const wantSuperdoctor = superdoctor?.enabled === true;

  // ADR-077: ensure superdoctor exists + sits IMMEDIATELY after the
  // superdriver window BEFORE adding team viewers, so on a fresh cockpit
  // the team viewers naturally land at the slots after superdoctor.
  // The target index is `superdriver.index + 1` rather than a literal
  // `2` because tmux's `base-index` option (operator-config dependent)
  // determines whether window 1 sits at index 0 or 1.
  if (wantSuperdoctor) {
    let windowsBefore = await cockpitTmux.window.listWindows(sessionName);
    const sdrv = windowsBefore.find((w) => w.name === "superdriver");
    const targetIdx = sdrv !== undefined ? sdrv.index + 1 : 2;
    let sd = windowsBefore.find((w) => w.name === "superdoctor");
    if (sd === undefined) {
      const cmd = buildSuperdoctorWindowCommand(superdoctor);
      const newId = await cockpitTmux.window.newWindow({
        sessionName,
        name: "superdoctor",
        detached: true,
        shellCommand: cmd,
      });
      logger.log(`  ✓ added window 'superdoctor' (idx ${newId.windowIndex})`);
      windowsBefore = await cockpitTmux.window.listWindows(sessionName);
      sd = windowsBefore.find((w) => w.name === "superdoctor");
    }
    if (sd !== undefined && sd.index !== targetIdx) {
      // Forced relocation; kill whatever sits at the target slot (likely a
      // team viewer from a pre-ADR-077 cockpit). It's recreated below in
      // the missing-viewer phase.
      await cockpitTmux.window.moveWindow({
        source: { sessionName, windowIndex: sd.index },
        target: { sessionName, windowIndex: targetIdx },
        kill: true,
      });
      logger.log(
        `  ✓ moved 'superdoctor' to idx ${targetIdx} (was idx ${sd.index})`,
      );
    }
  }

  const windows = await cockpitTmux.window.listWindows(sessionName);
  const present = new Set(windows.map((w) => w.name));
  const wanted = new Set([
    "superdriver",
    ...(wantSuperdoctor ? ["superdoctor"] : []),
    ...teams.map((t) => t.name),
  ]);

  // Add missing viewer windows.
  for (const t of teams) {
    if (present.has(t.name)) {
      logger.log(`  · window '${t.name}' already present`);
      continue;
    }
    const mode = await resolveTeamWindowMode(t, deps);
    const cmd = buildTeamWindowCommand(t, mode);
    await cockpitTmux.window.newWindow({
      sessionName,
      name: t.name,
      detached: true,
      shellCommand: cmd,
    });
    logger.log(`  ✓ added window '${t.name}' (${mode})`);
  }

  // Remove orphan viewer windows (e.g. team that was removed/disabled).
  // superdriver + superdoctor (when enabled) are always preserved.
  for (const w of windows) {
    if (wanted.has(w.name)) continue;
    if (w.name === "superdriver") continue;
    if (w.name === "superdoctor") continue;
    try {
      await cockpitTmux.window.killWindow(`${sessionName}:${w.name}`);
      logger.log(`  ✓ removed orphan window '${w.name}'`);
    } catch {
      // window may already be gone
    }
  }
}

/**
 * ADR-077: build the shell command the cockpit superdoctor window runs.
 * Mirrors the team-window claude-bootstrap shape (CLAUDE_CONFIG_DIR +
 * effortLevel + permissionMode + plugin-dir) when `claudeAccount` is
 * set; otherwise emits a bare `claude` invocation that inherits the
 * operator's default shell env (matches superdriver's default).
 *
 * Defaults match `normaliseTeamJson`'s tuiCommands.claude builder
 * (effortLevel=xhigh, permissionMode=auto) so a superdoctor session
 * runs with the same Opus + auto-mode posture as a team window.
 */
export function buildSuperdoctorWindowCommand(sd: CockpitSuperdoctor): string {
  const ov = sd.tuiOverrides;
  const effort = ov?.effortLevel ?? "xhigh";
  const permission = ov?.permissionMode ?? "auto";
  const pluginFlag = ov?.pluginDir !== undefined ? ` --plugin-dir=${ov.pluginDir}` : "";
  if (sd.claudeAccount !== undefined) {
    return (
      `CLAUDE_CONFIG_DIR=${sd.claudeAccount.configDir} ` +
      `CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=${effort} CLAUDE_GUARD_AGENT=1 ` +
      `claude${pluginFlag} --permission-mode ${permission}`
    );
  }
  return (
    `CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=${effort} CLAUDE_GUARD_AGENT=1 ` +
    `claude${pluginFlag} --permission-mode ${permission}`
  );
}

