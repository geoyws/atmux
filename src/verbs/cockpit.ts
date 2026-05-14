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
import { type CrontabIO, defaultCrontabIO } from "../abstractions/crontab.ts";
import { ensureDir } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import {
  createTmux,
  type SendTarget,
  type TmuxConfig,
  type TmuxNamespace,
} from "../abstractions/tmux.ts";
import {
  cageSessionName,
  cageSocketPath,
  enabledTeams,
  type LoadCockpitOpts,
  loadCockpit,
  resolveCockpitConfigPath,
} from "../core/cockpit.ts";
import { loadTeam, teamJsonPath } from "../core/common.ts";
import { installCockpitCronBlock } from "../core/cron.ts";
import {
  awaitClaudePaneReady,
  formatReadinessWarning,
  type PaneReadinessResult,
} from "../core/pane-readiness.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { resolveTuiCommand } from "../core/tui-cmd.ts";
import { UsageError } from "../errors.ts";
import type { CockpitSuperdoctor, CockpitTeam } from "../schema/cockpit.ts";
import { Team } from "../schema/team.ts";
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
  /** Override the superdoctor window's shell command (test injection).
   *  Default uses `buildSuperdoctorWindowCommand`. CI runners don't have
   *  `claude` installed; tests inject `() => "sleep infinity"` so the
   *  window persists for topology assertions. */
  buildSuperdoctorCommand?: (sd: CockpitSuperdoctor) => string;
  /** t-22453c1e: sleep override for the superdoctor auto-start poll loop.
   *  Default `setTimeout`-backed. Tests pass a no-op so wait-for-readiness
   *  doesn't burn real wall-clock seconds. */
  autoStartSleep?: (ms: number) => Promise<void>;
  /** t-22453c1e: capture-pane override. Default uses
   *  `tmux.pane.capturePane`. Tests pass a stub returning a controlled
   *  sequence of pane contents to drive the readiness branches. */
  autoStartCapturePane?: (sessionName: string, windowIndex: number) => Promise<string>;
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
      return shellPlaceholder(`team ${team.name} session not running — atmux start ${team.name}`);
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
  /** sub-verb. `reload` is a hot-reload alias for `rebuild --no-cycle
   *  --no-launch` — applies cockpit.json topology changes (window
   *  add/remove/move) without touching live cages or relaunching
   *  TUIs. ADR-077 §D6 follow-on. */
  subverb: "rebuild" | "reload";
  /** Skip the cage cycle phase (only normalise team.json + reconcile cockpit). */
  noCycle: boolean;
  /** Cycle every cage even if claude procs are running (DESTRUCTIVE — kills in-flight work). */
  forceCycle: boolean;
  /** Operator-supplied acknowledgement that `--force-cycle` will tear down
   *  live claude TUI contexts across EVERY enabled team and that this is
   *  intentional. Required whenever `forceCycle` is true; the parser
   *  refuses `--force-cycle` without this flag. Added 2026-05-12 after a
   *  driver-side incident where `--force-cycle` was used to refresh
   *  cockpit viewer attach paths and inadvertently nuked both atmux + sopx
   *  team contexts (~30 members lost their claude TUI state). The flag is
   *  intentionally long + ugly to make muscle-memory invocation impossible. */
  ackDangerous: boolean;
  /** Skip the TUI auto-launch step (cages stay as bare shells). */
  noLaunch: boolean;
  /** Override cockpit.json path. */
  configPath?: string;
  /** t-8b0e077e: confirm destructive cockpit-reconcile ops. Required when
   *  the reconcile would `moveWindow --kill` an occupied target slot OR
   *  `killWindow` an orphan team viewer. Cron / scripts pass `--yes` to
   *  bypass; interactive operator gets a structured warn + non-zero
   *  exit on the first run, re-runs with `--yes` after reviewing the
   *  planned ops. ALSO required when `--force-cycle` is set (the
   *  per-team cage cycle is destructive at the claude-TUI layer). */
  yes: boolean;
}

/**
 * Parse `cockpit` argv. Throws UsageError on unknown subverb / flag.
 *
 * Usage:
 *   atmux cockpit rebuild [--no-cycle] [--force-cycle
 *                         --acknowledge-dangerous-bau-interruption]
 *                         [--no-launch] [--config <path>]
 */
export function parseCockpitArgs(args: ReadonlyArray<string>): ParsedCockpitArgs {
  if (args.length === 0) {
    throw new UsageError({
      what: "cockpit: missing sub-verb",
      hint:
        "usage: atmux cockpit {rebuild | reload} " +
        "[--no-cycle | --force-cycle --acknowledge-dangerous-bau-interruption] " +
        "[--no-launch] [--config <path>]",
    });
  }
  const sub = args[0];
  if (sub !== "rebuild" && sub !== "reload") {
    throw new UsageError({
      what: `cockpit: unknown sub-verb: ${sub}`,
      hint: "supported: 'rebuild' (full) or 'reload' (hot-reload alias)",
    });
  }

  // reload = rebuild + auto-set --no-cycle --no-launch. Operator can
  // still pass --config <path>, but cycle/launch flags are forbidden
  // (the whole point of the alias is "don't touch live cages or
  // relaunch claude — just apply the topology diff").
  let noCycle = sub === "reload";
  let forceCycle = false;
  let ackDangerous = false;
  let noLaunch = sub === "reload";
  let yes = false;
  let configPath: string | undefined;

  let i = 1;
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--no-cycle":
        if (sub === "reload") {
          throw new UsageError({
            what: "cockpit reload: --no-cycle is implicit; flag is redundant",
            hint: "reload = rebuild --no-cycle --no-launch",
          });
        }
        noCycle = true;
        i += 1;
        break;
      case "--force-cycle":
        if (sub === "reload") {
          throw new UsageError({
            what: "cockpit reload: --force-cycle is incompatible with hot-reload",
            hint: "use 'cockpit rebuild --force-cycle' for full cage cycle",
          });
        }
        forceCycle = true;
        i += 1;
        break;
      case "--acknowledge-dangerous-bau-interruption":
        ackDangerous = true;
        i += 1;
        break;
      case "--no-launch":
        if (sub === "reload") {
          throw new UsageError({
            what: "cockpit reload: --no-launch is implicit; flag is redundant",
            hint: "reload = rebuild --no-cycle --no-launch",
          });
        }
        noLaunch = true;
        i += 1;
        break;
      case "--yes":
      case "-y":
        yes = true;
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

  // ADR-084-companion safety gate: `--force-cycle` is destructive (tears
  // down live claude TUI contexts across EVERY enabled team), so refuse
  // it without the operator-supplied ack flag. Added 2026-05-12 after
  // ~30 members' claude contexts were nuked when --force-cycle was used
  // to refresh viewer attach paths. The flag is intentionally long +
  // ugly to make muscle-memory invocation impossible — see
  // `ackDangerous` JSDoc on ParsedCockpitArgs.
  if (forceCycle && !ackDangerous) {
    throw new UsageError({
      what: "cockpit rebuild: --force-cycle requires " + "--acknowledge-dangerous-bau-interruption",
      hint:
        "--force-cycle tears down live claude TUI contexts across EVERY enabled team " +
        "(every member's in-flight reasoning + tool state is lost). " +
        "If you really mean to do this, pass " +
        "--acknowledge-dangerous-bau-interruption. " +
        "Otherwise use bare `cockpit rebuild` (live cages are preserved).",
    });
  }

  // t-8b0e077e: --force-cycle ALSO needs --yes layered on top of the
  // existing --acknowledge-dangerous-bau-interruption gate. The two flags
  // gate distinct surfaces: ackDangerous covers the claude-TUI loss; yes
  // covers the cockpit-reconcile destructive ops the same rebuild call
  // is about to apply. Both are required.
  if (forceCycle && !yes) {
    throw new UsageError({
      what: "cockpit rebuild: --force-cycle requires --yes",
      hint:
        "--force-cycle implies destructive cockpit-reconcile ops; pass --yes to confirm. " +
        "(--acknowledge-dangerous-bau-interruption covers the claude-TUI loss; --yes covers the cockpit-window mutation set.)",
    });
  }

  const out: ParsedCockpitArgs = {
    subverb: sub as "rebuild" | "reload",
    noCycle,
    forceCycle,
    ackDangerous,
    noLaunch,
    yes,
  };
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
  /** ADR-086: crontab IO seam for cockpit-scoped cron install (test
   *  injection). Default `defaultCrontabIO()`. */
  crontab?: CrontabIO;
  /** ADR-086: resolve the atmux binary path for the cron line. Default
   *  reads `ATMUX_BIN` env then falls back to `Bun.which("atmux")`. */
  resolveAtmuxBin?: () => string | null;
}

/** Top-level dispatch for `atmux cockpit <subverb>`. */
export async function cockpit(
  args: ReadonlyArray<string>,
  opts: CockpitOpts = {},
): Promise<number> {
  const parsed = parseCockpitArgs(args);
  switch (parsed.subverb) {
    case "rebuild":
      return await cockpitRebuild(parsed, opts);
    case "reload":
      // Hot-reload: same flow as rebuild with --no-cycle --no-launch
      // pre-applied (parseCockpitArgs already set those flags). Live
      // cages and member panes are never touched; only Phase 1
      // (team.json normalise — idempotent), Phase 3 (cage prefix —
      // idempotent), and Phase 5 (cockpit window reconcile) run.
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
      const unbootMsg =
        teamSummary.unbootstrapped.length > 0
          ? ` ⚠ unbootstrapped=${teamSummary.unbootstrapped.length} ` +
            `(${teamSummary.unbootstrapped.map((u) => `${u.member}:${u.result.state}`).join(", ")})`
          : "";
      logger.log(
        `  ✓ ${t.name}: launched=${teamSummary.launched} ` +
          `skipped=${teamSummary.skipped} (already-claude)${unbootMsg}`,
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
    parsed.yes,
  );

  // Phase 6 (ADR-086): cockpit-scoped cron block install. Idempotent —
  // strips any existing `# >>> atmux:cockpit` block and re-appends a
  // fresh one with the resolved `atmux pulse` line. Honors
  // `ATMUX_NO_CRON=1` opt-out + non-fatal posture (parity with per-team
  // cron-install: a crontab swap failure warns, does not abort).
  await installCockpitCron(opts, cockpit, logger, env);

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

// ---------- Phase 6 helper (ADR-086) ----------

/** Install the cockpit-scoped cron block (currently just `atmux pulse`).
 *  Mirrors the non-fatal posture of `src/verbs/cron-install.ts`: every
 *  failure path warns to the logger and returns without throwing — a
 *  cron hiccup MUST NOT wedge `atmux cockpit rebuild`. */
export async function installCockpitCron(
  opts: CockpitOpts,
  cockpit: Awaited<ReturnType<typeof loadCockpit>>,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (isTruthyEnv(env.ATMUX_NO_CRON)) {
    if (env.ATMUX_DEBUG !== undefined && env.ATMUX_DEBUG !== "") {
      logger.log("  · cockpit cron: ATMUX_NO_CRON set, no-op");
    }
    return;
  }
  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) {
    logger.warn(
      "cockpit cron: crontab not on PATH — skipping (install cron to enable scheduled pulse)",
    );
    return;
  }
  const atmuxBin = (opts.resolveAtmuxBin ?? defaultResolveAtmuxBin)();
  if (atmuxBin === null || atmuxBin === "") {
    logger.warn(
      "cockpit cron: cannot resolve atmux binary path (set ATMUX_BIN or install atmux on PATH) — skipping",
    );
    return;
  }
  const cockpitConfigPath = resolveCockpitConfigPath({ env });
  const pulseIntervalMins = cockpit.pulse?.intervalMins;
  const current = await crontab.read();
  const installOpts: Parameters<typeof installCockpitCronBlock>[0] = {
    atmuxBin,
    cockpitConfigPath,
    current,
  };
  if (pulseIntervalMins !== undefined) installOpts.pulseIntervalMins = pulseIntervalMins;
  const next = installCockpitCronBlock(installOpts);
  if (next === (current ?? "")) {
    logger.log("  · cockpit cron: up to date (atmux:cockpit block already current)");
    return;
  }
  try {
    await crontab.write(next);
    logger.log(
      `  ✓ cockpit cron: installed atmux pulse (inspect: crontab -l | grep 'atmux:cockpit')`,
    );
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    logger.warn(`cockpit cron: crontab swap failed — manual install required (${cause})`);
  }
}

function isTruthyEnv(v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  switch (v.toLowerCase()) {
    case "0":
    case "false":
      return false;
    default:
      return true;
  }
}

function defaultResolveAtmuxBin(): string | null {
  const envBin = process.env.ATMUX_BIN;
  if (envBin !== undefined && envBin !== "") return envBin;
  return Bun.which("atmux");
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
  /** Per-pane readiness verification result for each launched member —
   *  t-47f4425f (Stage A, complaint c-fbecbf65). Entries are populated
   *  ONLY for members whose post-spawn probe returned a non-`ready`
   *  state (`starving` / `absent` / `timeout`); a happy spawn leaves
   *  this array empty. Callers fold these into operator-visible warnings.
   *  Empty array when the probe is skipped via `opts.skipReadinessProbe`. */
  unbootstrapped: ReadonlyArray<{ member: string; result: PaneReadinessResult }>;
}

/** Per-pane readiness probe signature. The default (constructed via
 *  {@link buildDefaultReadinessProbe}) wires {@link awaitClaudePaneReady}
 *  to `cageTmux.pane.capturePane`; tests inject a synchronous fake. */
export type ReadinessProbe = (target: string, member: string) => Promise<PaneReadinessResult>;

export interface AutolaunchOpts {
  /** Skip the post-spawn readiness probe. Default `false` — production
   *  path always verifies. Tests that use non-claude TUIs (e.g.
   *  `tui: "shell"`) MUST set this to avoid 30s polling against a pane
   *  that will never reach the claude welcome screen. */
  skipReadinessProbe?: boolean;
  /** Override the readiness probe entirely (test injection — full
   *  control over result + timing). When set, all `readiness*` options
   *  below are ignored. */
  readinessProbe?: ReadinessProbe;
  /** Override the default probe's deadline. Default 30_000 ms — matches
   *  the cap in t-47f4425f's task brief §A.1. */
  readinessDeadlineMs?: number;
  /** Override the default probe's poll interval. Default 500 ms. */
  readinessPollIntervalMs?: number;
}

/**
 * For each pane in the cage that's NOT already running claude, send the
 * resolved TUI command via tmux send-keys. Skips panes already on
 * claude/node so re-runs are idempotent.
 *
 * After spawn, runs a per-pane Stage A readiness probe (t-47f4425f) so
 * the cockpit rebuild output can flag panes where claude failed to
 * launch — `tmux send-keys` succeeds even when the TUI subsequently
 * crashes / never reaches a prompt, so a probe-side signal is the only
 * way to differentiate "spawn green" from "spawn fired and silently
 * starved" (the c-fbecbf65 incident shape). Default mode here is the
 * relaxed `requireBriefConsumed: false` because `autolaunchTeam` itself
 * does not yet paste the bootstrap brief (ADR-081 §C); once §C lands,
 * the caller can flip the probe strict by injecting a custom
 * `readinessProbe`.
 */
export async function autolaunchTeam(
  team: CockpitTeam,
  cageTmux: TmuxNamespace,
  env: NodeJS.ProcessEnv,
  logger: Logger,
  opts: AutolaunchOpts = {},
): Promise<AutolaunchSummary> {
  const session = cageSessionName(team.name);
  // Read the team.json to drive resolveTuiCommand per member. We re-read
  // here (not relying on phase-1's mutator return) so this helper stays
  // independently callable (test directness + the --no-cycle path).
  const teamShape = await loadTeam({ teamDir: team.root });
  let launched = 0;
  let skipped = 0;
  const launchedTargets: Array<{ member: string; target: string }> = [];
  const unbootstrapped: Array<{ member: string; result: PaneReadinessResult }> = [];
  let windows: { index: number; name: string }[];
  try {
    windows = await cageTmux.window.listWindows(session);
  } catch {
    // No session yet — happens under --no-cycle on a never-started cage.
    return { launched, skipped, unbootstrapped };
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
    launchedTargets.push({ member: member.name, target });
  }

  // Stage A readiness verification (t-47f4425f / c-fbecbf65). Per-pane,
  // post-spawn — flags members whose TUI never reached a stable state.
  // Probe failures bubble through as `timeout` or `absent`; we log a
  // structured warning + record in the summary, but DO NOT throw — a
  // partial-fail-during-spawn must not wedge the rest of the rebuild.
  if (!opts.skipReadinessProbe && launchedTargets.length > 0) {
    const probe = opts.readinessProbe ?? buildDefaultReadinessProbe(cageTmux, opts);
    for (const { member, target } of launchedTargets) {
      let result: PaneReadinessResult;
      try {
        result = await probe(target, member);
      } catch (err) {
        // Probe-itself failure (e.g., capture-pane errored mid-poll).
        // Treat as a timeout-shaped warning so the operator sees the
        // member name + the cause.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`autolaunchTeam: ${member}: probe error — ${msg}`);
        continue;
      }
      if (result.state !== "ready") {
        unbootstrapped.push({ member, result });
        const warning = formatReadinessWarning(member, result);
        if (warning !== null) logger.warn(`autolaunchTeam:${warning}`);
      }
    }
  }

  return { launched, skipped, unbootstrapped };
}

function buildDefaultReadinessProbe(cageTmux: TmuxNamespace, opts: AutolaunchOpts): ReadinessProbe {
  return async (target, _member) => {
    return await awaitClaudePaneReady(
      target,
      {
        deadlineMs: opts.readinessDeadlineMs ?? 30_000,
        pollIntervalMs: opts.readinessPollIntervalMs ?? 500,
        // Relaxed mode: autolaunchTeam does not (yet — ADR-081 §C)
        // paste the bootstrap brief, so welcome-screen panes are
        // legitimate "TUI booted" state. Callers that own brief-paste
        // should inject a custom probe with `requireBriefConsumed: true`.
        requireBriefConsumed: false,
      },
      {
        capture: async (t) => await cageTmux.pane.capturePane({ target: t }),
      },
    );
  };
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
  /** t-8b0e077e: confirm destructive cockpit-reconcile ops (move-with-kill
   *  on superdoctor's target slot + orphan-prune). Required when count > 0.
   *  Defaults to false — caller (cockpitRebuild) threads `parsed.yes`. */
  yes = false,
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

  // t-8b0e077e: pre-pass destructive-op detection. Walk the windows
  // ONCE before any mutation, compute the planned destructive set, and
  // refuse with a structured warning when count > 0 AND yes is false.
  // Race-window between dry-run + apply is fine for single-operator
  // workflows; the gate's value is "don't silently nuke" not strict
  // atomicity.
  await refusePlannedDestructiveOps({
    cockpitTmux,
    sessionName,
    teams,
    wantSuperdoctor,
    yes,
    logger,
  });

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
    let sdJustCreated = false;
    if (sd === undefined) {
      const cmd = (deps.buildSuperdoctorCommand ?? buildSuperdoctorWindowCommand)(superdoctor);
      const newId = await cockpitTmux.window.newWindow({
        sessionName,
        name: "superdoctor",
        detached: true,
        shellCommand: cmd,
      });
      logger.log(`  ✓ added window 'superdoctor' (idx ${newId.windowIndex})`);
      windowsBefore = await cockpitTmux.window.listWindows(sessionName);
      sd = windowsBefore.find((w) => w.name === "superdoctor");
      sdJustCreated = true;
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
      logger.log(`  ✓ moved 'superdoctor' to idx ${targetIdx} (was idx ${sd.index})`);
    }

    // t-22453c1e: auto-fire `/loop /superdoctor` ONLY when this rebuild
    // call JUST CREATED the window — pre-existing windows could be mid-
    // loop / mid-thinking / mid-/clear and are not safe to re-poke.
    // Honors `superdoctor.autoStart` (default true) so operators with
    // manual-control workflows can opt out by flipping `false`.
    if (sdJustCreated && superdoctor.autoStart !== false && sd !== undefined) {
      const settleSec = superdoctor.autoStartTimeoutSec ?? 30;
      try {
        const autoStartOpts: AutoStartSuperdoctorOpts = {
          tmux: cockpitTmux,
          sessionName,
          windowIndex: sd.index,
          timeoutMs: settleSec * 1000,
          logger,
        };
        // exactOptionalPropertyTypes: only forward the injection points
        // when callers actually set them. Defaults inside the helper
        // wire the real `setTimeout` + `tmux.pane.capturePane`.
        if (deps.autoStartSleep !== undefined) autoStartOpts.sleep = deps.autoStartSleep;
        if (deps.autoStartCapturePane !== undefined) {
          autoStartOpts.capturePane = deps.autoStartCapturePane;
        }
        await autoStartSuperdoctorLoop(autoStartOpts);
      } catch (e) {
        // Defense-in-depth: autoStartSuperdoctorLoop is non-fatal by
        // construction (all branches log + return); rethrow shouldn't
        // happen but if a future bug raises one, don't wedge the rebuild.
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(`  ⚠ superdoctor auto-start fell through: ${cause}`);
      }
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

// ---------- t-8b0e077e: cockpit safety gate ----------

/** One planned destructive cockpit-reconcile op. Surfaces in the warn
 *  log + the UsageError message so the operator can review before
 *  re-running with `--yes`. */
export interface PlannedDestructiveOp {
  /** Tmux window-name the op touches. */
  window: string;
  /** Human-readable action — `"move-with-kill"` or `"prune-orphan"`. */
  action: "move-with-kill" | "prune-orphan";
  /** Free-form context — e.g. `"target slot 2 occupied by team viewer 'alpha'"`. */
  reason: string;
}

interface RefuseDestructiveOpts {
  cockpitTmux: TmuxNamespace;
  sessionName: string;
  teams: ReadonlyArray<CockpitTeam>;
  wantSuperdoctor: boolean;
  yes: boolean;
  logger: Logger;
}

/**
 * Walk the cockpit's current window state ONCE before reconcile mutates
 * anything; compute the destructive op set; if non-empty AND `yes` is
 * false, log each op + throw `UsageError` with a hint to re-run with
 * `--yes`. Idempotent reconciles (zero destructive ops planned) pass
 * silently regardless of `yes`.
 *
 * Detected destructive cases — must stay in sync with the live
 * `reconcileCockpitSession` body below:
 *   1. `superdoctor` displacement — when wantSuperdoctor is on AND the
 *      target slot (`superdriver.index + 1`) is currently occupied by a
 *      NON-superdoctor window. The live code calls
 *      `moveWindow({kill: true})` there.
 *   2. Orphan-prune — any window not in {superdriver, superdoctor (when
 *      enabled), team-names...} that the live code's `killWindow` would
 *      sweep.
 */
async function refusePlannedDestructiveOps(opts: RefuseDestructiveOpts): Promise<void> {
  const { cockpitTmux, sessionName, teams, wantSuperdoctor, yes, logger } = opts;
  const windows = await cockpitTmux.window.listWindows(sessionName);
  const planned: PlannedDestructiveOp[] = [];

  // Case 1 — superdoctor displacement.
  if (wantSuperdoctor) {
    const sdrv = windows.find((w) => w.name === "superdriver");
    const targetIdx = sdrv !== undefined ? sdrv.index + 1 : 2;
    const sd = windows.find((w) => w.name === "superdoctor");
    // Only counts as destructive when superdoctor EXISTS at a wrong
    // index AND the target slot has someone else parked there. Fresh
    // adds (sd === undefined) land in the empty slot non-destructively.
    if (sd !== undefined && sd.index !== targetIdx) {
      const occupant = windows.find((w) => w.index === targetIdx && w.name !== "superdoctor");
      if (occupant !== undefined) {
        planned.push({
          window: occupant.name,
          action: "move-with-kill",
          reason: `target slot ${targetIdx} occupied by '${occupant.name}'; superdoctor relocation kills it`,
        });
      }
    }
  }

  // Case 2 — orphan-prune. Compute the wanted-name set; anything else
  // that isn't an always-preserved window gets killed.
  const wanted = new Set<string>([
    "superdriver",
    ...(wantSuperdoctor ? ["superdoctor"] : []),
    ...teams.map((t) => t.name),
  ]);
  for (const w of windows) {
    if (wanted.has(w.name)) continue;
    if (w.name === "superdriver" || w.name === "superdoctor") continue;
    planned.push({
      window: w.name,
      action: "prune-orphan",
      reason: "window not in cockpit.json roster + not preserved",
    });
  }

  if (planned.length === 0) return; // idempotent — nothing to gate

  // Log each planned op so a `--yes` re-run is informed by the same
  // surface. Even when yes is true we keep the warn line so the operator
  // sees what's about to happen.
  for (const op of planned) {
    logger.warn(`  ⚠ destructive: ${op.action} '${op.window}' — ${op.reason}`);
  }
  if (yes) return;
  throw new UsageError({
    what: `cockpit reconcile: ${planned.length} destructive op(s) planned; refusing without --yes`,
    hint:
      "Review the listed ops above. Re-run with `--yes` to apply, or edit cockpit.json " +
      "to keep the windows in scope. (Cron / scripts should pass `--yes` to bypass.)",
  });
}

// ---------- t-22453c1e: superdoctor auto-start ----------

export interface AutoStartSuperdoctorOpts {
  tmux: TmuxNamespace;
  sessionName: string;
  windowIndex: number;
  /** Max wall-clock to wait for the pane to settle to a Claude idle
   *  prompt before bailing without a send-keys. Operator falls back to
   *  manual `/loop /superdoctor` when this fires. */
  timeoutMs: number;
  logger: Logger;
  /** Test injection — defaults to `setTimeout`-backed. */
  sleep?: (ms: number) => Promise<void>;
  /** Test injection — defaults to `tmux.pane.capturePane`. */
  capturePane?: (sessionName: string, windowIndex: number) => Promise<string>;
}

/** Poll cadence when waiting for the Claude REPL idle prompt. 500ms is
 *  the spec value from t-22453c1e — finer is wasted IO, coarser misses
 *  the window between welcome-screen-finished and operator-tabbing-away. */
const SUPERDOCTOR_POLL_INTERVAL_MS = 500;

/** Settle window AFTER sendKeys before verifying the loop landed. Per
 *  t-22453c1e §4 we wait up to 5s for the skill-loaded marker. */
const SUPERDOCTOR_POST_SEND_VERIFY_MS = 5_000;

/** Markers that indicate the Claude Code TUI is at an idle prompt (per
 *  t-22453c1e §2 readiness check). Matched as substrings against the
 *  full capture. The order is "best-confidence first" — the auto-mode
 *  + tok 0/0 footer is the most reliable signal; the `❯ Try ` placeholder
 *  is the visual prompt the operator sees on a fresh session. */
const SUPERDOCTOR_READY_MARKERS: ReadonlyArray<string> = ["auto mode on", "❯ Try "];

/** Bail markers — if any of these appear, the pane is NOT idle and the
 *  send-keys would land in the wrong state (queued message, compacting,
 *  thinking mid-turn). Spec §2. */
const SUPERDOCTOR_NOT_READY_MARKERS: ReadonlyArray<string> = [
  "Compacting conversation",
  "thinking with",
];

/** Verification markers after send-keys. Either form is acceptable per
 *  t-22453c1e §4 (skill loaded OR model acting on it). */
const SUPERDOCTOR_LOOP_LANDED_MARKERS: ReadonlyArray<string> = [
  "Successfully loaded skill",
  "self-pace this loop",
  "self-pacing this loop",
];

/**
 * t-22453c1e: poll the freshly-created superdoctor pane until it settles
 * to a Claude idle prompt, then `tmux send-keys` `/loop /superdoctor` +
 * Enter. Non-fatal on every branch — a timeout / send failure logs a
 * warning and the operator falls back to typing the keystroke manually.
 *
 * Three terminal outcomes:
 *   - Idle prompt detected → send-keys → verify → log ok / warn-no-verify
 *   - Timeout (default 30s, configurable) → warn + return
 *   - Capture throws → warn + return
 */
export async function autoStartSuperdoctorLoop(opts: AutoStartSuperdoctorOpts): Promise<void> {
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((res) => {
        setTimeout(res, ms);
      }));
  const capturePane =
    opts.capturePane ??
    (async (session: string, idx: number): Promise<string> => {
      return await opts.tmux.pane.capturePane({
        target: { sessionName: session, windowIndex: idx },
      });
    });

  const deadline = Date.now() + opts.timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    let capture: string;
    try {
      capture = await capturePane(opts.sessionName, opts.windowIndex);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      opts.logger.warn(
        `  ⚠ superdoctor auto-start: capture-pane failed (${cause}); operator falls back to manual \`/loop /superdoctor\``,
      );
      return;
    }
    if (paneIsReady(capture)) {
      ready = true;
      break;
    }
    await sleep(SUPERDOCTOR_POLL_INTERVAL_MS);
  }
  if (!ready) {
    opts.logger.warn(
      `  ⚠ superdoctor pane not ready after ${Math.floor(opts.timeoutMs / 1000)}s; type \`/loop /superdoctor\` manually`,
    );
    return;
  }

  // Send the keystroke. The text + Enter go in a single sendKeys call
  // with `enter: true` — `tmux send-keys` natively appends C-m when
  // `Enter` is passed alongside literal text, so we don't need the
  // separate-call dance the bash equivalent does.
  const target: SendTarget = {
    kind: "member",
    member: "superdoctor",
    team: opts.sessionName,
    target: { sessionName: opts.sessionName, windowIndex: opts.windowIndex },
  };
  try {
    await opts.tmux.pane.sendKeys({
      target,
      keys: "/loop /superdoctor",
      enter: true,
    });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    opts.logger.warn(
      `  ⚠ superdoctor auto-start: send-keys failed (${cause}); operator falls back to manual`,
    );
    return;
  }

  // Verify the loop landed — best-effort. The skill-loaded marker takes
  // a moment to render after Enter; cap the wait at SUPERDOCTOR_POST_SEND_
  // VERIFY_MS so a slow loader doesn't wedge rebuild.
  await sleep(SUPERDOCTOR_POST_SEND_VERIFY_MS);
  let postCapture: string;
  try {
    postCapture = await capturePane(opts.sessionName, opts.windowIndex);
  } catch {
    // Verification capture failure is non-blocking — the send-keys may
    // have landed fine. Log + treat as best-effort success.
    opts.logger.log(
      "  ✓ superdoctor auto-started (`/loop /superdoctor` sent; verification capture failed — assume ok)",
    );
    return;
  }
  if (SUPERDOCTOR_LOOP_LANDED_MARKERS.some((m) => postCapture.includes(m))) {
    opts.logger.log("  ✓ superdoctor auto-started (`/loop /superdoctor` confirmed)");
  } else {
    opts.logger.warn(
      "  ⚠ superdoctor auto-start: send-keys fired but verification marker not seen in 5s; operator should sanity-check the window",
    );
  }
}

/** Pane-ready predicate. Idle ⇔ at least one ready-marker present AND
 *  no not-ready-marker (compacting / thinking). */
function paneIsReady(capture: string): boolean {
  for (const blocker of SUPERDOCTOR_NOT_READY_MARKERS) {
    if (capture.includes(blocker)) return false;
  }
  for (const marker of SUPERDOCTOR_READY_MARKERS) {
    if (capture.includes(marker)) return true;
  }
  return false;
}
