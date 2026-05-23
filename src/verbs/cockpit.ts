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
//   3. apply the level-resolved cage prefix per ADR-089 §C (F1/F2/F3
//      from DEFAULT_PREFIX_CHAIN or operator-supplied cockpit.prefixChain)
//      to every cage tmux server. Legacy `C-\` falls through only when
//      the chain resolution fails — never as the primary path.
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
  perTeamCageSocketPath,
  resolveCageSocket,
  resolveCockpitConfigPath,
  resolvePrefix,
} from "../core/cockpit.ts";
import { loadTeam, teamJsonPath } from "../core/common.ts";
import { installCockpitCronBlock } from "../core/cron.ts";
import {
  awaitClaudePaneReady,
  formatReadinessWarning,
  type PaneReadinessResult,
} from "../core/pane-readiness.ts";
import { getAtmuxTmuxConfPath, getCockpitSocketName } from "../core/tmux-paths.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { resolveTuiCommand } from "../core/tui-cmd.ts";
import { UsageError } from "../errors.ts";
import type {
  CockpitMedic,
  CockpitSentinel,
  CockpitSuperdoctor,
  CockpitTeam,
} from "../schema/cockpit.ts";
import { Team } from "../schema/team.ts";
import { attachWithTmux } from "./attach.ts";
import { cockpitRotate } from "./cockpit-rotate.ts";
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
  /** ADR-063 follow-up (t-31bef86e): override the socket resolver.
   *  Default probes both legacy `/tmp/atmux-<team>/sock` AND per-team
   *  `<root>/.atmux/tmux/tmux-<uid>/default` via
   *  `core/cockpit::resolveCageSocket`, returning whichever exists
   *  (legacy-first for back-compat, falls through to legacy when neither
   *  exists). Tests inject a constant returning a known path to assert
   *  which socket the cage factory is built against. Supersedes the
   *  prior single-socket `resolveTeamSocket(teamShape)` path from
   *  t-b5864443 — see ADR-063 follow-up commit 3cab619. */
  resolveCageSocket?: (teamName: string, teamRoot: string) => Promise<string>;
  /** Build the team's cage TmuxNamespace. Default `createTmux({socketPath})`.
   *  Receives the socket path resolved by `resolveCageSocket` so tests
   *  can capture which candidate was picked. */
  createCageTmux?: (socketPath: string) => TmuxNamespace;
  /** Override the medic (legacy: superdoctor) window's shell command
   *  (test injection). Default uses `buildMedicWindowCommand`. CI
   *  runners don't have `claude` installed; tests inject
   *  `() => "sleep infinity"` so the window persists for topology
   *  assertions. */
  buildMedicCommand?: (m: CockpitMedic) => string;
  /** Back-compat alias for `buildMedicCommand`. Existing test
   *  fixtures injecting `buildSuperdoctorCommand` keep working; the
   *  reconcile prefers `buildMedicCommand` when both are set. */
  buildSuperdoctorCommand?: (sd: CockpitSuperdoctor) => string;
  /** ADR-132 §D2: override the sentinel window's shell command (test
   *  injection). Default uses `buildSentinelWindowCommand`. Tests
   *  inject `() => "sleep infinity"` so the window persists without a
   *  real `claude` binary. */
  buildSentinelCommand?: (m: CockpitSentinel) => string;
  /** t-22453c1e: sleep override for the medic + sentinel auto-start
   *  poll loops. Default `setTimeout`-backed. Tests pass a no-op so
   *  wait-for-readiness doesn't burn real wall-clock seconds. */
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
  //
  // ADR-063 follow-up (t-31bef86e): discover socket via the dual-path
  // resolver so a cage running on the per-team `team.tmuxTmpdir`
  // convention (sopx / unum / atmux dogfood) isn't misclassified as
  // "session-down" just because legacy `/tmp/atmux-<team>/sock` is
  // absent. Supersedes the prior single-`resolveTeamSocket(teamShape)`
  // path from t-b5864443 — the dual-probe avoids the failure mode
  // where team.json was unreadable AND legacy socket missing.
  const socketResolver = deps.resolveCageSocket ?? resolveCageSocket;
  let sock: string;
  try {
    sock = await socketResolver(team.name, team.root);
  } catch {
    return "session-down";
  }
  const cageFactory = deps.createCageTmux ?? defaultCageTmuxFactory;
  let cageTmux: TmuxNamespace;
  try {
    cageTmux = cageFactory(sock);
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

function defaultCageTmuxFactory(socketPath: string): TmuxNamespace {
  return createTmux({ socketPath });
}

/**
 * Build the shell command the cockpit per-team window runs. Switches
 * on `mode`:
 *
 *   - `"attach"` — dual-socket retry-loop attaching `<session>:driver`
 *     so the cockpit operator lands on the team's driver pane on focus
 *     (OQ4 default). Tries legacy `/tmp/atmux-<team>/sock` first then
 *     per-team `<root>/.atmux/tmux/tmux-<uid>/default` so cage flips
 *     between conventions self-recover (ADR-063 follow-up t-31bef86e).
 *   - `"session-down"` — print a one-shot "not running" status THEN
 *     the same dual-socket retry-loop so the window self-heals once
 *     the cage comes back up. Pre-2026-05-14 this branch planted
 *     `sleep infinity`, which left the window dead until a manual
 *     rebuild — exactly the bug reported in driver-inbox 2026-05-14.
 *   - `"no-driver-config"` — print an explanatory line + `sleep
 *     infinity`. No retry loop because waiting can't fix a missing
 *     `team.json::driverSession`; the operator must edit team.json
 *     and re-run rebuild.
 *
 * Supersedes the t-b5864443 socketPath-arg signature — the dual-socket
 * retry-loop derives BOTH paths internally from the team name + root,
 * so callers no longer need to thread a pre-resolved socketPath.
 */
export function buildTeamWindowCommand(team: CockpitTeam, mode: TeamWindowMode): string {
  switch (mode) {
    case "attach":
      return cageRetryLoop(team);
    case "no-driver-config":
      return shellPlaceholder(
        `no driver configured for ${team.name} — set team.json::driverSession to enable`,
      );
    case "session-down": {
      const msg = `team ${team.name} session not running — atmux start ${team.name}`;
      const safe = msg.replace(/'/g, "'\\''");
      return `printf '%s\\n' '${safe}'; ${cageRetryLoop(team)}`;
    }
  }
}

/** Dual-socket attach retry-loop shared by the `attach` and `session-down`
 *  modes. Tries the legacy `/tmp/atmux-<team>/sock` first (back-compat),
 *  falls through to the per-team `<root>/.atmux/tmux/tmux-<uid>/default`
 *  (current convention) inside ONE shell iteration, then sleeps 1s.
 *  Targets `<session>:driver` per OQ4. */
function cageRetryLoop(team: CockpitTeam): string {
  const legacy = cageSocketPath(team.name);
  const perTeam = perTeamCageSocketPath(team.root);
  const session = cageSessionName(team.name);
  return (
    `while true; do ` +
    `tmux -S ${legacy} attach -t ${session}:driver 2>/dev/null ` +
    `|| tmux -S ${perTeam} attach -t ${session}:driver 2>/dev/null; ` +
    `sleep 1; ` +
    `done`
  );
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
   *  TUIs. ADR-077 §D6 follow-on. `migrate-socket` is the ADR-162 TR3
   *  one-shot verb that moves the cockpit session from the operator's
   *  default tmux socket to the dedicated `atmux-cockpit` named socket
   *  (per §Decision-anchor #1 + #4). */
  subverb: "rebuild" | "reload" | "migrate-socket" | "attach";
  /** Skip the cage cycle phase (only normalise team.json + reconcile cockpit). */
  noCycle: boolean;
  /** Cycle every cage even if claude procs are running (DESTRUCTIVE — kills in-flight work). */
  forceCycle: boolean;
  /** ADR-162 TR3 `migrate-socket`: preview the planned migration without
   *  executing. Reports legacy sessions/windows discovered + the cleanup
   *  intent; no socket mutation, no scrollback capture, no window
   *  recreate. Operator runs `--dry-run` first; commits without when
   *  satisfied. Inert on other subverbs. Optional for backward-compat
   *  with test fixtures constructed before TR3 added the flag. */
  dryRun?: boolean;
  /** ADR-162 TR3 `migrate-socket`: skip the legacy-session cleanup
   *  (Phase 6). Old default-socket cockpit and new atmux-cockpit
   *  cockpit coexist. Safety-conscious option for the first migration
   *  on a production cockpit — operator decides when to nuke the
   *  legacy via `tmux kill-session -t atmux_cockpit` (or
   *  `atmux_teams`). Inert on other subverbs. Optional for backward-
   *  compat with test fixtures constructed before TR3 added the flag. */
  keepLegacy?: boolean;
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
  /** ADR-180: `attach`-sub-verb-only flag. Routes the attach through
   *  the inherit-stdio spawn path so the caller's controlling tty
   *  reaches tmux. Default (undefined / false) keeps the agent-path
   *  piped-stdio shape — that path exits 1 with "open terminal failed:
   *  not a terminal" when there's no tty, which is the intended
   *  agent-side semantic. Rejected on every non-`attach` sub-verb.
   *  Optional for backward-compat with test fixtures constructed before
   *  ADR-180 added the flag (mirrors the dryRun / keepLegacy pattern). */
  human?: boolean;
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
        "usage: atmux cockpit {rebuild | reload | migrate-socket | attach} " +
        "[--no-cycle | --force-cycle --acknowledge-dangerous-bau-interruption] " +
        "[--no-launch] [--config <path>] [--dry-run] [--keep-legacy]",
    });
  }
  const sub = args[0];
  if (sub !== "rebuild" && sub !== "reload" && sub !== "migrate-socket" && sub !== "attach") {
    throw new UsageError({
      what: `cockpit: unknown sub-verb: ${sub}`,
      hint:
        "supported: 'rebuild' (full), 'reload' (hot-reload alias), " +
        "'migrate-socket' (ADR-162 TR3: move legacy cockpit-on-default-socket → atmux-cockpit), " +
        "or 'attach' (tmux-attach to the cockpit session on its named socket)",
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
  let dryRun = false;
  let keepLegacy = false;

  let human = false;

  let i = 1;
  while (i < args.length) {
    const a = args[i] ?? "";
    switch (a) {
      case "--human":
        if (sub !== "attach") {
          throw new UsageError({
            what: `cockpit ${sub}: --human only applies to 'attach'`,
            hint:
              "use 'atmux cockpit attach --human' for the human-entry path " +
              "(tty inherited through to tmux); rebuild/reload/migrate-socket " +
              "have no attach step",
          });
        }
        human = true;
        i += 1;
        break;
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
      case "--dry-run":
        if (sub !== "migrate-socket") {
          throw new UsageError({
            what: `cockpit ${sub}: --dry-run only applies to 'migrate-socket'`,
            hint: "use 'atmux cockpit migrate-socket --dry-run' to preview ADR-162 TR3 migration",
          });
        }
        dryRun = true;
        i += 1;
        break;
      case "--keep-legacy":
        if (sub !== "migrate-socket") {
          throw new UsageError({
            what: `cockpit ${sub}: --keep-legacy only applies to 'migrate-socket'`,
            hint: "use 'atmux cockpit migrate-socket --keep-legacy' to preserve the legacy default-socket cockpit",
          });
        }
        keepLegacy = true;
        i += 1;
        break;
      default:
        throw new UsageError({
          what: `cockpit ${sub}: unknown arg: ${a}`,
          hint: "see 'atmux cockpit --help'",
        });
    }
  }

  // `attach` is a read-only operation; reject every rebuild/migrate-socket
  // flag so operators get a clear hint instead of silently-ignored args.
  // `--human` (ADR-180) is the one attach-specific flag — gated above
  // before this check so it doesn't trip the rejection.
  if (sub === "attach") {
    if (noCycle || forceCycle || ackDangerous || noLaunch || yes || dryRun || keepLegacy) {
      throw new UsageError({
        what: "cockpit attach: only --config and --human are accepted",
        hint: "usage: atmux cockpit attach [--config <path>] [--human]",
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
    subverb: sub as "rebuild" | "reload" | "migrate-socket" | "attach",
    noCycle,
    forceCycle,
    ackDangerous,
    noLaunch,
    yes,
    dryRun,
    keepLegacy,
  };
  if (configPath !== undefined) out.configPath = configPath;
  // `human` is attach-only (ADR-180) and declared optional on
  // ParsedCockpitArgs for backward-compat with pre-ADR-180 fixtures.
  // Surface the field only on the `attach` sub-verb so rebuild/reload
  // fixtures stay shape-stable. On attach we always emit (defaulting
  // to false) so callers + tests can read p.human directly.
  if (sub === "attach") out.human = human;
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
  // ADR-167: `cockpit rotate` has its own argv parser (separate flag
  // set: `<session-name>` positional + `--force`) and dispatches via
  // src/verbs/cockpit-rotate.ts. Branch BEFORE parseCockpitArgs so
  // that parser stays focused on rebuild / reload / migrate-socket.
  if (args[0] === "rotate") {
    const rotateOpts: { env?: NodeJS.ProcessEnv } = {};
    if (opts.env !== undefined) rotateOpts.env = opts.env;
    return await cockpitRotate(args.slice(1), rotateOpts);
  }
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
    case "migrate-socket":
      // ADR-162 TR3: one-shot move of the cockpit session from the
      // operator's default tmux socket to the dedicated atmux-cockpit
      // named socket (per §Decision-anchor #1 + #4). Idempotent — re-
      // running on an already-migrated cockpit reports "nothing to do".
      return await cockpitMigrateSocket(parsed, opts);
    case "attach":
      // Convenience verb — `tmux -L <cockpit-socket> attach -t <session>`
      // resolved from the same `getCockpitSocketName` + cockpit.json
      // `cockpitSession` field that `rebuild` writes. Closes the
      // "where's my cockpit?" discoverability gap after ADR-162 moved
      // the cockpit off the operator's default tmux socket.
      return await cockpitAttach(parsed, opts);
  }
}

/** `atmux cockpit attach` — tmux-attach to the cockpit session on its
 *  named socket. Resolves both the socket name (via `getCockpitSocketName`,
 *  honouring the `ATMUX_COCKPIT_SOCKET` escape hatch) and the session name
 *  (via `loadCockpit` → `cockpitSession` field) so this stays correct
 *  across socket renames and operator overrides.
 *
 *  Exported for direct unit-test access (mirrors `cockpitRebuild` /
 *  `cockpitMigrateSocket`). */
export async function cockpitAttach(
  parsed: ParsedCockpitArgs,
  opts: CockpitOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const factory = opts.tmuxFactory ?? createTmux;

  const loadOpts: LoadCockpitOpts = { env };
  if (parsed.configPath !== undefined) loadOpts.path = parsed.configPath;
  const cockpit = await loadCockpit(loadOpts);

  const socket = getCockpitSocketName(env);
  const tmux = factory({ socket });
  return attachWithTmux(tmux, cockpit.cockpitSession, { inheritStdio: parsed.human === true });
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
      const sock = await resolveCageSocket(t.name, t.root);
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

  // Phase 3: apply the level-resolved cage prefix on every enabled cage
  // per ADR-089 §C. Pre-fix (clobber observed 2026-05-21): cockpit rebuild
  // called applyCagePrefix() with no prefix → fell back to legacy `C-\`,
  // which overrode operator-supplied F-key chain configured via
  // `cockpit.prefixChain` (or the DEFAULT_PREFIX_CHAIN F1..F12). atmux
  // start already routes through resolveCagePrefixBestEffort; this loop
  // mirrors the same resolution by reading `t.level` from the flattened
  // enabledTeams() walk + adding 1 (walkSessions yields 0-indexed levels;
  // resolvePrefix expects 1-indexed per ADR-089 §C). Top-level team =
  // level 1 = F1; epic-team child = level 2 = F2; etc.
  for (const t of teams) {
    const sock = await resolveCageSocket(t.name, t.root);
    const cageTmux = factory({ socketPath: sock });
    let prefix: string | undefined;
    try {
      prefix = resolvePrefix(t.level + 1, cockpit.prefixChain);
    } catch {
      // Best-effort — invalid chain or level > MAX_NESTING_LEVEL falls
      // through to applyCagePrefix's legacy `C-\` default (cosmetic
      // only; cage operation unaffected).
    }
    await applyCagePrefix(cageTmux, prefix);
  }

  // Phase 4: TUI auto-launch (idempotent — skips panes already on claude).
  if (!parsed.noLaunch) {
    for (const t of teams) {
      const sock = await resolveCageSocket(t.name, t.root);
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

  // Phase 5: cockpit session on its dedicated socket (ADR-162
  // §Decision-anchor #1 — `tmux -L atmux-cockpit`). Resolver honours
  // `ATMUX_COCKPIT_SOCKET` legacy escape hatch. §Decision-anchor #2:
  // canonical atmux.conf threaded via `-f` so window-naming +
  // key-rebinds match ADR-135's contract irrespective of the
  // operator's personal config.
  // ADR-133 TR2: read the resolved `medic` block (post-shim canonical
  // name). For sessions[]-based configs `enrichLegacyFields` synthesizes
  // both `superdoctor` and `medic` from the same `type: "superdoctor"`
  // entry; for top-level legacy configs the pre-parse shim renames
  // `superdoctor` → `medic` with a deprecation warning. The downstream
  // reconcile + window-name convention stays "superdoctor" until TR3
  // ships the verb / window / skill renames.
  const cockpitTmux = factory({
    socket: getCockpitSocketName(),
    configFile: getAtmuxTmuxConfPath(),
  });
  // ADR-133: loader populates `cockpit.medic` from the canonical block
  // OR coerces from a legacy `superdoctor` block. Pass `medic` directly;
  // the reconcile names the window canonically and migrates any legacy
  // "superdoctor" window in-place on first rebuild.
  // ADR-132 §D2: cockpit-tier sentinel block at W3 (sibling of medic at
  // W2). Loader exposes `cockpit.sentinel`; reconcile provisions W3 when
  // `enabled === true` and shifts team viewers to W4+.
  await reconcileCockpitSession(
    cockpitTmux,
    cockpit.cockpitSession,
    teams,
    logger,
    {},
    cockpit.medic,
    parsed.yes,
    {}, // reconcileOpts — fleet-wide path; no onlyTeam filter
    cockpit.sentinel,
  );

  // Phase 5b (t-3fb7bc54): apply the resolved prefix to the cockpit
  // session itself. Phase 3 above wires per-cage prefixes via
  // applyCagePrefix(cageTmux, resolvePrefix(t.level + 1, ...)) but the
  // cockpit session — a separate tmux server on the `atmux-cockpit`
  // socket per ADR-162 §Decision-anchor #1 — was never set, so its
  // prefix defaulted to whatever the host tmux config (or applyCagePrefix's
  // legacy `C-\` fallback) supplied. Result on operator's hax (observed
  // 2026-05-21 21:57 MYT after a seed-expansion spawn): cockpit prefix
  // clobbered to `C-a`, manual `tmux -L atmux-cockpit set-option -g
  // prefix F1` workaround per rebuild.
  //
  // Resolution: cockpit gets `resolvePrefix(1, cockpit.prefixChain)`
  // (level 1 = `F1` by default). Per ADR-089 §C the chain is 1-indexed
  // for cages (L1 = top-level team cage, L2 = epic-team child, ...);
  // the cockpit is structurally the outer container, not a level in
  // the cage chain, but the chain's first entry is the right operator-
  // facing value because (a) the cockpit and L1 cages live on
  // SEPARATE tmux sockets so the same chord doesn't collide (different
  // tmux servers own different keybinding namespaces), and (b) the
  // operator's documented workaround was `F1`, which is precisely
  // `resolvePrefix(1, ...)`. The alternative — introducing a distinct
  // "cockpit prefix" config knob orthogonal to `prefixChain` — adds
  // surface without solving anything the chain's first entry doesn't
  // already cover; deferred (`Out of scope` candidate) until an
  // operator hits a case where the chain's first entry is wrong for
  // the cockpit (none observed today).
  //
  // Best-effort wrap mirrors the Phase 3 loop above — invalid chain
  // or level > MAX_NESTING_LEVEL falls through to applyCagePrefix's
  // legacy `C-\` default (cosmetic only; cockpit operation
  // unaffected).
  {
    let cockpitPrefix: string | undefined;
    try {
      cockpitPrefix = resolvePrefix(1, cockpit.prefixChain);
    } catch {
      // Same swallow as Phase 3 — best-effort cosmetic.
    }
    await applyCagePrefix(cockpitTmux, cockpitPrefix);
  }

  // Phase 6 (ADR-086): cockpit-scoped cron block install. Idempotent —
  // strips any existing `# >>> atmux:cockpit` block and re-appends a
  // fresh one with the resolved `atmux pulse` line. Honors
  // `ATMUX_NO_CRON=1` opt-out + non-fatal posture (parity with per-team
  // cron-install: a crontab swap failure warns, does not abort).
  await installCockpitCron(opts, cockpit, logger, env);

  logger.ok(`cockpit ready. attach: tmux attach -t ${cockpit.cockpitSession}`);
  // ADR-077 + ADR-133: nudge the operator to start the medic loop
  // manually. Rebuild stays purely topological — auto-firing
  // `/loop /superdoctor` on every rebuild would either re-fire on
  // idempotent re-runs or need fragile send-keys timing against a
  // freshly-spawned claude. Manual start is one slash command and
  // matches how the operator drives superdriver in window 1. Skill
  // slug stays `/superdoctor` until TR3 ships the cascade rename.
  if (cockpit.medic?.enabled === true) {
    logger.log(
      `  ▸ medic: select window 2 ('superdoctor') and type \`/loop /superdoctor\` to start the hourly diagnosis loop`,
    );
  }
  return 0;
}

// ---------- ADR-162 TR3: cockpit migrate-socket ----------

/** Legacy session-name shapes the migration verb discovers on the
 *  operator's default tmux socket. `atmux_cockpit` is the canonical
 *  ADR-135 name; `atmux_teams` is the pre-ADR-135 legacy that the
 *  cockpit.json migration shim (src/core/cockpit.ts) coerces on read.
 *  We surface both — the migration is socket-tier, separate from the
 *  ADR-135 session-name-tier rename.
 *
 *  Exported for unit-test access. */
export const LEGACY_COCKPIT_SESSION_NAMES = ["atmux_cockpit", "atmux_teams"] as const;

/** Per-window context captured from the legacy default-socket cockpit
 *  before recreation on the dedicated atmux-cockpit socket. The
 *  scrollback string is presented to the operator as a breadcrumb
 *  (Phase 5) — atmux can't transfer running PIDs across tmux servers
 *  via stock tmux primitives, so the operator re-invokes any in-pane
 *  process (Claude conversations, manual scripts) with the prior
 *  scroll context preserved in the breadcrumb file.
 *
 *  Exported for unit-test typing. */
export interface CapturedCockpitWindow {
  readonly sessionName: string;
  readonly index: number;
  readonly name: string;
  readonly scrollback: string;
}

/** ADR-162 TR3 — `atmux cockpit migrate-socket` one-shot verb.
 *
 * Moves the cockpit session from the operator's default tmux socket
 * (legacy state, pre-ADR-162) to the dedicated `atmux-cockpit` named
 * socket (per §Decision-anchor #1 + #4). Six phases:
 *
 *   1. **Discovery** — list sessions on `tmux -L default`; filter to
 *      `LEGACY_COCKPIT_SESSION_NAMES`. Zero matches = already
 *      migrated; return 0.
 *   2. **Capture** — for each matched session/window, snapshot the
 *      last 3000 lines of scrollback (`pane.capturePane`). The
 *      capture is non-destructive on the legacy socket — if Phase 6
 *      cleanup fails or `--keep-legacy` is set the legacy session
 *      survives untouched.
 *   3. **Recreate session** — `tmux -L atmux-cockpit new-session -d
 *      -s atmux_cockpit ...` on the dedicated socket. Additive: if
 *      the target session already exists (partial-migration recovery
 *      or sibling cockpit), windows already on the target are
 *      preserved + the migration only adds missing windows by name.
 *   4. **Recreate windows** — preserve window names + relative order.
 *      Empty shell panes (no process re-bind — see §Process-
 *      preservation below).
 *   5. **Breadcrumb** — write captured scrollback to
 *      `/tmp/atmux-cockpit-migrate-<epoch>.log`. Operator reads it
 *      to recover visual context (prior Claude conversation lines,
 *      etc.) before re-invoking processes in the new panes.
 *   6. **Cleanup** — `tmux -L default kill-session -t <legacy-name>`.
 *      Skipped when `--keep-legacy` is set; legacy + new cockpit
 *      coexist until the operator manually nukes the legacy via
 *      `tmux kill-session`.
 *
 * **Process-preservation — honest answer (§Decision-anchor #4
 * amendment).** tmux can't transfer a running pane process between
 * servers (sockets) — the PID is bound to a PTY the source tmux
 * server owns; severing that PTY either SIGHUPs the process or
 * leaves it as a stdio-less orphan. ptrace-based PTY reparenting
 * tools exist (e.g. `reptyr`) but atmux doesn't depend on them
 * (heavy external dep + platform-specific). The realistic
 * mechanism is **graceful-recreate**: scrollback is preserved as
 * visual context; the operator re-invokes any in-pane work in the
 * new panes. Cron-spawned cockpit roles (medic, martinet,
 * sentinel) re-establish themselves on the next cron tick without
 * operator action — they're not state-bearing across ticks.
 *
 * Idempotent — re-running on an already-migrated cockpit returns 0
 * with the "no legacy cockpit on default socket" log. `--dry-run`
 * previews the discovered legacy state without mutating either
 * socket. `--keep-legacy` skips Phase 6 cleanup. Both flags are
 * inert when there's nothing to migrate.
 */
export async function cockpitMigrateSocket(
  parsed: ParsedCockpitArgs,
  opts: CockpitOpts = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const factory = opts.tmuxFactory ?? createTmux;
  const dryRun = parsed.dryRun ?? false;
  const keepLegacy = parsed.keepLegacy ?? false;

  // Phase 1 — discovery on the operator's default tmux socket.
  const legacyTmux = factory({ socket: "default" });
  let sessions: { name: string; windows: number; created: number }[];
  try {
    sessions = await legacyTmux.session.listSessions();
  } catch (e) {
    // No tmux server on default socket = nothing to migrate. This is
    // the steady-state for fresh installs + post-migration cockpits.
    logger.log(
      `✅ no tmux server on default socket — nothing to migrate (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
    return 0;
  }
  const legacyCockpitSessions = sessions.filter((s) =>
    (LEGACY_COCKPIT_SESSION_NAMES as readonly string[]).includes(s.name),
  );
  if (legacyCockpitSessions.length === 0) {
    logger.log(
      "✅ no legacy cockpit session on default socket — already migrated (or fresh install)",
    );
    return 0;
  }

  const cockpitSocketName = getCockpitSocketName(env);
  if (cockpitSocketName === "default") {
    // Operator has explicitly opted back into the legacy default-socket
    // cockpit via the ATMUX_COCKPIT_SOCKET=default escape hatch. Migrating
    // would just move windows from default → default — a no-op that risks
    // double-creating sessions. Refuse with a clear hint.
    logger.warn("ATMUX_COCKPIT_SOCKET=default in effect — migration target equals legacy source.");
    logger.warn(
      "Unset ATMUX_COCKPIT_SOCKET (or set it to 'atmux-cockpit') to proceed with migration.",
    );
    return 0;
  }

  logger.log(
    `▸ migrate-socket: ${legacyCockpitSessions.length} legacy cockpit session(s) on default socket → ${cockpitSocketName}`,
  );

  // Phase 2 — capture per-window scrollback (read-only on legacy).
  const captured: CapturedCockpitWindow[] = [];
  for (const sess of legacyCockpitSessions) {
    const windows = await legacyTmux.window.listWindows(sess.name);
    logger.log(`  · session '${sess.name}': ${windows.length} window(s)`);
    for (const w of windows) {
      if (dryRun) {
        logger.log(`    [dry-run] would migrate window ${w.index} '${w.name}'`);
        captured.push({ sessionName: sess.name, index: w.index, name: w.name, scrollback: "" });
        continue;
      }
      let scrollback = "";
      try {
        scrollback = await legacyTmux.pane.capturePane({
          target: `${sess.name}:${w.index}`,
          start: -3000,
        });
      } catch (e) {
        logger.warn(
          `    ⚠ scrollback capture failed on ${sess.name}:${w.index}: ${
            e instanceof Error ? e.message : String(e)
          } — proceeding without breadcrumb`,
        );
      }
      captured.push({ sessionName: sess.name, index: w.index, name: w.name, scrollback });
    }
  }

  if (dryRun) {
    logger.log(
      `[dry-run] would ${keepLegacy ? "PRESERVE" : "kill"} legacy session(s) on default socket: ${legacyCockpitSessions
        .map((s) => s.name)
        .join(", ")}`,
    );
    logger.log("[dry-run] no mutations applied — re-run without --dry-run to migrate");
    return 0;
  }

  // Phase 3 — recreate session(s) on the dedicated socket. Always
  // canonicalises legacy 'atmux_teams' → 'atmux_cockpit' (per ADR-135 §D4)
  // so the migrated cockpit lands on the current canonical name.
  const newTmux = factory({
    socket: cockpitSocketName,
    configFile: getAtmuxTmuxConfPath(env),
  });
  const targetSessionName = "atmux_cockpit";
  const hasTarget = await newTmux.session.hasSession(targetSessionName);
  if (!hasTarget) {
    const first = captured[0];
    const initialWindowName = first?.name ?? "_superdriver";
    await newTmux.session.newSession({
      name: targetSessionName,
      detached: true,
      windowName: initialWindowName,
    });
    logger.log(
      `  ✓ created session '${targetSessionName}' on ${cockpitSocketName} (window 1: ${initialWindowName})`,
    );
  } else {
    logger.log(
      `  · session '${targetSessionName}' already exists on ${cockpitSocketName} — additive merge`,
    );
  }

  // Phase 4 — recreate windows on the target socket. Existing window
  // names on the target are preserved (additive merge). Empty shell
  // panes; operator re-invokes any in-pane process (see Phase 5).
  const targetWindows = await newTmux.window.listWindows(targetSessionName);
  const targetWindowNames = new Set(targetWindows.map((w) => w.name));
  let createdCount = 0;
  let skippedExistingCount = 0;
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    if (c === undefined) continue; // unreachable; appease TS noUncheckedIndexedAccess
    // The session was just bootstrapped with the first captured window
    // when !hasTarget; don't double-create it.
    if (!hasTarget && i === 0) {
      logger.log(`    ✓ window '${c.name}' (created with session)`);
      targetWindowNames.add(c.name);
      continue;
    }
    if (targetWindowNames.has(c.name)) {
      logger.log(`    · window '${c.name}' already present on target — skip`);
      skippedExistingCount += 1;
      continue;
    }
    await newTmux.window.newWindow({
      sessionName: targetSessionName,
      name: c.name,
      detached: true,
    });
    targetWindowNames.add(c.name);
    createdCount += 1;
    logger.log(`    ✓ window '${c.name}' created`);
  }
  logger.log(
    `  · ${createdCount} window(s) created, ${skippedExistingCount} skipped (already present)`,
  );

  // Phase 5 — scrollback breadcrumb. Operator reads it to recover prior
  // visual context (Claude conversation tails, etc.) before re-invoking
  // processes in the new panes. We don't attempt PID transfer (see
  // §Process-preservation in the function docstring).
  const breadcrumbPath = `/tmp/atmux-cockpit-migrate-${Date.now()}.log`;
  const breadcrumb = buildMigrationBreadcrumb(captured, targetSessionName, cockpitSocketName);
  try {
    await Bun.write(breadcrumbPath, breadcrumb);
    logger.log(`  📋 scrollback breadcrumb → ${breadcrumbPath}`);
    logger.log(`     (cat the file to recover prior pane contents)`);
  } catch (e) {
    logger.warn(
      `  ⚠ breadcrumb write failed (${
        e instanceof Error ? e.message : String(e)
      }) — migration continues; no scrollback record`,
    );
  }

  // Phase 6 — cleanup legacy session(s) on default socket. Skipped
  // when --keep-legacy is set.
  if (keepLegacy) {
    logger.log(
      `  · --keep-legacy set: legacy session(s) left intact on default socket (${legacyCockpitSessions
        .map((s) => s.name)
        .join(", ")})`,
    );
    logger.log(
      `    manually clean up with: tmux kill-session -t ${legacyCockpitSessions[0]?.name ?? "atmux_cockpit"}`,
    );
  } else {
    for (const sess of legacyCockpitSessions) {
      try {
        await legacyTmux.session.killSession(sess.name);
        logger.log(`  ✓ killed legacy session '${sess.name}' on default socket`);
      } catch (e) {
        logger.warn(
          `  ⚠ kill-session '${sess.name}' on default socket failed: ${
            e instanceof Error ? e.message : String(e)
          } — manually clean up with: tmux kill-session -t ${sess.name}`,
        );
      }
    }
  }

  logger.ok(
    `cockpit migrated. attach: tmux -L ${cockpitSocketName} attach -t ${targetSessionName}`,
  );
  return 0;
}

/** Format the captured scrollback into a single breadcrumb file the
 *  operator can `cat` to recover visual context for each migrated
 *  pane. Exported for unit-test access. */
export function buildMigrationBreadcrumb(
  captured: ReadonlyArray<CapturedCockpitWindow>,
  targetSessionName: string,
  cockpitSocketName: string,
): string {
  const header = [
    `# atmux cockpit migrate-socket breadcrumb`,
    `# Generated: ${new Date().toISOString()}`,
    `# Migrated → tmux -L ${cockpitSocketName} attach -t ${targetSessionName}`,
    `# Captured ${captured.length} window(s) from the legacy default-socket cockpit.`,
    `# Process state was NOT transferred (tmux primitives can't re-bind PIDs across`,
    `# servers); re-invoke any in-pane Claude/script process in the new panes.`,
    `# Cron-spawned roles (medic/martinet/sentinel) re-establish on the next tick.`,
    "",
  ].join("\n");
  const body = captured
    .map((c) => {
      const sep = "─".repeat(78);
      return [
        sep,
        `## ${c.sessionName}:${c.index} '${c.name}'`,
        sep,
        c.scrollback.length > 0 ? c.scrollback : "(scrollback empty or capture failed)",
        "",
      ].join("\n");
    })
    .join("\n");
  return `${header}\n${body}`;
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

/** ADR-089 §C: apply the cage's tmux prefix. Pre-ADR-089 path hardcoded
 *  `C-\` (cosmetic, chosen because it doesn't collide with operator-bound
 *  outer-tmux prefixes); post-ADR-089 callers pass the level-derived
 *  F-key (or operator-override entry) so nested cages chain
 *  unambiguously per `resolvePrefix(level, chain)`. The legacy default
 *  `"C-\\"` is preserved when `prefix` is omitted so existing single-cage
 *  callers (today's `atmux start` pre-ADR-089-T5 wiring) stay byte-equal
 *  until T5 wires the chain resolution into `start.ts`.
 *
 *  Best-effort — failures swallow (the prefix is cosmetic, not a
 *  precondition for cage operation). */
export async function applyCagePrefix(cageTmux: TmuxNamespace, prefix?: string): Promise<void> {
  const value = prefix !== undefined && prefix.length > 0 ? prefix : "C-\\";
  try {
    await cageTmux.option.setOption({ name: "prefix", value, global: true });
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
 * `superdriver`, an optional window 2 = `medic` (ADR-077 role renamed
 * per ADR-133), an optional window 3 = `sentinel` (ADR-132 §D2), and
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
 * ADR-077 + ADR-133 — the medic window (legacy: superdoctor) is
 * optional and singleton:
 *   - When `medic?.enabled === true`, it occupies cockpit window
 *     index 2 (between superdriver and the team viewers / sentinel).
 *     On first upgrade from a pre-ADR-077 cockpit, an existing team
 *     viewer at index 2 is killed-and-recreated to preserve the slot
 *     invariant.
 *   - When unset / disabled, the index-2 slot drops back to the
 *     sentinel (if enabled) or to the first team viewer (otherwise).
 *   - Legacy window-name migration: when a window named `superdoctor`
 *     exists from a pre-ADR-133 rebuild AND `medic.enabled === true`,
 *     the legacy window is renamed in-place to `medic` (idempotent;
 *     once renamed, future rebuilds preserve the canonical name).
 *
 * ADR-132 §D2 — the sentinel window is optional and singleton:
 *   - When `sentinel?.enabled === true`, it occupies cockpit window
 *     index N+1 where N = (medic enabled ? 2 : 1). Team viewers
 *     shift to N+2..M.
 *   - When unset / disabled, cockpit shape is unchanged from the
 *     pre-ADR-132 topology (team viewers occupy 2..N or 3..N
 *     depending on medic).
 *
 * Idempotence: when a window already exists for `t.name`, this function
 * preserves it as-is — matching the pre-ADR-064 behaviour. State
 * transitions (e.g., team gained driverSession after first rebuild)
 * land on the next rebuild that actually creates the window (operator
 * removes the placeholder, re-runs).
 */
/** Optional knobs for {@link reconcileCockpitSession}. */
export interface ReconcileCockpitOpts {
  /** ADR-063 ergonomic fix (t-ab8df0b4): narrow reconcile to JUST the
   *  named team's viewer window. When set:
   *   - Session is created if missing (additive, same as fleet path).
   *   - Superdoctor is created if missing + enabled, but NOT relocated
   *     (relocation could displace sibling teams the caller doesn't
   *     own).
   *   - Only the named team's window is added (other teams in the
   *     `teams[]` arg are ignored — the caller should pass only the
   *     target team, but the parameter is the source of truth here).
   *   - Orphan removal pass is SKIPPED entirely (additive only —
   *     never delete sibling windows during a per-team reconcile).
   *  When undefined: existing fleet-wide behaviour (orphans removed,
   *  superdoctor force-relocated to slot 2, every team in `teams[]`
   *  processed). */
  onlyTeam?: string;
}

export async function reconcileCockpitSession(
  cockpitTmux: TmuxNamespace,
  sessionName: string,
  teams: CockpitTeam[],
  logger: Logger,
  deps: ResolveTeamWindowDeps = {},
  /** ADR-133 canonical singleton (fleet self-healing, was superdoctor). */
  medic?: CockpitMedic,
  /** t-8b0e077e: confirm destructive cockpit-reconcile ops (move-with-kill
   *  on medic / sentinel target slots + orphan-prune). Required when
   *  count > 0. Defaults to false — caller (cockpitRebuild) threads
   *  `parsed.yes`.
   *
   *  Position-stable across the ADR-132 reshape — kept at index 7 (the
   *  pre-ADR-132 slot) so existing test callers continue to type-check
   *  without churn. ADR-132 §D2's `sentinel` argument lands at index 8
   *  to preserve back-compat. */
  yes = false,
  /** ADR-063 follow-up — per-team reconcile knobs (only-team filter,
   *  additive-only mode for the orphan-prune pass). When omitted, the
   *  reconcile runs fleet-wide as before. Kept at position 8 (trunk's
   *  position before ADR-132 lands) so existing callers + tests keep
   *  type-checking without ordering churn. */
  reconcileOpts: ReconcileCockpitOpts = {},
  /** ADR-132 §D2 singleton (cockpit-tier whip manager). When unset or
   *  `enabled: false`, no W3 window is provisioned. Discriminated
   *  union on `impl` per the §D4 reshape (Task t-b86fd8cb resolution);
   *  both `claude` + `cursor` variants honour `.enabled` so the gate
   *  below works across either impl. New positional slot 9 — callers
   *  that don't opt in to sentinel just omit. */
  sentinel?: CockpitSentinel,
): Promise<void> {
  const onlyTeam = reconcileOpts.onlyTeam;

  // ADR-135 §D4 — legacy cockpit-session-name migration. When the
  // operator's running tmux session is named `atmux_teams` (pre-ADR-135
  // canonical) AND the target name resolves to the new canonical
  // `atmux_cockpit` AND no session with the canonical name exists yet,
  // rename in-place. `tmux rename-session` preserves pane PIDs,
  // attached clients, and scroll history. Idempotent: subsequent
  // rebuilds find the canonical name and do nothing. Operator-chosen
  // arbitrary session names (e.g. `geoyws_cockpit`) are not touched —
  // only the historical literal `atmux_teams` triggers the migration.
  if (sessionName === "atmux_cockpit") {
    const hasLegacy = await cockpitTmux.session.hasSession("atmux_teams");
    const hasCanonical = await cockpitTmux.session.hasSession("atmux_cockpit");
    if (hasLegacy && !hasCanonical) {
      try {
        await cockpitTmux.session.renameSession("atmux_teams", "atmux_cockpit");
        logger.log(
          `  ✓ renamed session 'atmux_teams' → 'atmux_cockpit' (ADR-135 migration; one-time per cockpit)`,
        );
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(
          `  ⚠ failed to rename legacy 'atmux_teams' session to 'atmux_cockpit': ${cause} — operator may rename manually with 'tmux rename-session -t atmux_teams atmux_cockpit'`,
        );
      }
    } else if (hasLegacy && hasCanonical) {
      logger.warn(
        `  ⚠ both 'atmux_teams' and 'atmux_cockpit' sessions exist — ADR-135 migration ambiguous. Kill the legacy session manually: 'tmux kill-session -t atmux_teams' (recommended).`,
      );
    }
  }

  const has = await cockpitTmux.session.hasSession(sessionName);
  if (!has) {
    await cockpitTmux.session.newSession({
      name: sessionName,
      detached: true,
      windowName: "_superdriver",
    });
    logger.log(`  ✓ created session ${sessionName} (window 1: _superdriver)`);
  }

  const wantMedic = medic?.enabled === true;
  const wantSentinel = sentinel?.enabled === true;

  // ADR-135 §D4 — legacy cockpit-role-window migration. Renames in
  // order: `superdoctor → medic` (ADR-133 carry-over), `superdriver
  // → _superdriver`, `medic → _medic`, `sentinel → _sentinel`.
  // Each rename is idempotent (no-op when canonical name already
  // present). Race-safe within a single rebuild: list windows once,
  // chain renames, list again only if needed by subsequent logic.
  //
  // The ADR-133 `superdoctor → medic` rename runs even when wantMedic
  // is false — a legacy `superdoctor` window left orphaned by an
  // operator who flipped `medic.enabled: false` should still be
  // renamed so the orphan-preserve check downstream can find it
  // under its canonical name. (Pre-ADR-135 the rename was gated on
  // `wantMedic`; the gate is no longer necessary because the orphan-
  // preserve list now accepts both legacy and canonical names.)
  {
    const windowsBefore = await cockpitTmux.window.listWindows(sessionName);
    const renameInPlace = async (legacy: string, canonical: string): Promise<void> => {
      const hasLegacy = windowsBefore.some((w) => w.name === legacy);
      const hasCanonical = windowsBefore.some((w) => w.name === canonical);
      if (hasLegacy && !hasCanonical) {
        try {
          await cockpitTmux.window.renameWindow(`${sessionName}:${legacy}`, canonical);
          logger.log(
            `  ✓ renamed window '${legacy}' → '${canonical}' (ADR-135 migration; one-time per cockpit)`,
          );
          // Mutate windowsBefore so chained renames (superdoctor →
          // medic → _medic) see the post-rename state.
          for (const w of windowsBefore) {
            if (w.name === legacy) w.name = canonical;
          }
        } catch (e) {
          const cause = e instanceof Error ? e.message : String(e);
          logger.warn(
            `  ⚠ failed to rename legacy '${legacy}' window to '${canonical}': ${cause} — operator may rename manually with 'tmux rename-window -t ${sessionName}:${legacy} ${canonical}'`,
          );
        }
      } else if (hasLegacy && hasCanonical) {
        logger.warn(
          `  ⚠ cockpit has BOTH '${legacy}' and '${canonical}' windows — ADR-135 migration ambiguous. Kill the legacy one: 'tmux kill-window -t ${sessionName}:${legacy}' (recommended).`,
        );
      }
    };
    // ADR-133 carry-over: superdoctor → medic. Runs first so the
    // subsequent medic → _medic chain step finds either the renamed
    // legacy window OR a pre-existing medic window.
    await renameInPlace("superdoctor", "medic");
    // ADR-135 §D2: underscore-prefix migration for cockpit-role windows.
    await renameInPlace("superdriver", "_superdriver");
    await renameInPlace("medic", "_medic");
    await renameInPlace("sentinel", "_sentinel");
  }

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
    wantMedic,
    wantSentinel,
    yes,
    logger,
    ...(onlyTeam !== undefined ? { onlyTeam } : {}),
  });

  // ADR-077 + ADR-133: ensure the medic window exists + sits
  // IMMEDIATELY after the superdriver window BEFORE adding sentinel /
  // team viewers, so on a fresh cockpit the downstream windows land
  // at the correct slots. The target index is `superdriver.index + 1`
  // rather than a literal `2` because tmux's `base-index` option
  // (operator-config dependent) determines whether window 1 sits at
  // index 0 or 1.
  //
  // Per-team mode (ADR-063 ergonomic fix): create-if-missing is fine
  // (additive), but the forced-relocation pass is SKIPPED — moving the
  // medic window could displace sibling team viewers that the
  // single-team caller has no authority to disturb. The fleet-wide
  // `cockpit rebuild` is responsible for the relocation invariant.
  if (wantMedic) {
    let windowsBefore = await cockpitTmux.window.listWindows(sessionName);
    const sdrv = windowsBefore.find((w) => w.name === "_superdriver");
    const targetIdx = sdrv !== undefined ? sdrv.index + 1 : 2;
    let md = windowsBefore.find((w) => w.name === "_medic");
    let mdJustCreated = false;
    if (md === undefined) {
      const builder =
        deps.buildMedicCommand ?? deps.buildSuperdoctorCommand ?? buildMedicWindowCommand;
      const cmd = builder(medic);
      const newId = await cockpitTmux.window.newWindow({
        sessionName,
        name: "_medic",
        detached: true,
        shellCommand: cmd,
      });
      logger.log(`  ✓ added window '_medic' (idx ${newId.windowIndex})`);
      windowsBefore = await cockpitTmux.window.listWindows(sessionName);
      md = windowsBefore.find((w) => w.name === "_medic");
      mdJustCreated = true;
    }
    if (onlyTeam === undefined && md !== undefined && md.index !== targetIdx) {
      // Forced relocation; kill whatever sits at the target slot (likely a
      // team viewer from a pre-ADR-077 cockpit). It's recreated below in
      // the missing-viewer phase. Fleet-wide only — per-team mode skips
      // this to preserve sibling team viewers.
      await cockpitTmux.window.moveWindow({
        source: { sessionName, windowIndex: md.index },
        target: { sessionName, windowIndex: targetIdx },
        kill: true,
      });
      logger.log(`  ✓ moved '_medic' to idx ${targetIdx} (was idx ${md.index})`);
    }

    // t-22453c1e: auto-fire `/loop /medic` (legacy `/loop /superdoctor`)
    // ONLY when this rebuild call JUST CREATED the window — pre-existing
    // windows could be mid-loop / mid-thinking / mid-/clear and are not
    // safe to re-poke. Honors `medic.autoStart` (default true) so
    // operators with manual-control workflows can opt out by flipping
    // `false`.
    if (mdJustCreated && medic.autoStart !== false && md !== undefined) {
      const settleSec = medic.autoStartTimeoutSec ?? 30;
      try {
        const autoStartOpts: AutoStartSuperdoctorOpts = {
          tmux: cockpitTmux,
          sessionName,
          windowIndex: md.index,
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
        logger.warn(`  ⚠ _medic auto-start fell through: ${cause}`);
      }
    }
  }

  // ADR-132 §D2: provision the _sentinel window at index (medic ? 3 : 2).
  // Same machinery as _medic — newWindow if missing, moveWindow if at
  // wrong slot, auto-start the loop if just created.
  if (wantSentinel) {
    let windowsBefore = await cockpitTmux.window.listWindows(sessionName);
    const sdrv = windowsBefore.find((w) => w.name === "_superdriver");
    const baseIdx = sdrv !== undefined ? sdrv.index : 1;
    // Sentinel sits at base+2 when medic is enabled, base+1 when not.
    const targetIdx = baseIdx + (wantMedic ? 2 : 1);
    let mt = windowsBefore.find((w) => w.name === "_sentinel");
    let mtJustCreated = false;
    if (mt === undefined) {
      const builder = deps.buildSentinelCommand ?? buildSentinelWindowCommand;
      const cmd = builder(sentinel);
      const newId = await cockpitTmux.window.newWindow({
        sessionName,
        name: "_sentinel",
        detached: true,
        shellCommand: cmd,
      });
      logger.log(`  ✓ added window '_sentinel' (idx ${newId.windowIndex})`);
      windowsBefore = await cockpitTmux.window.listWindows(sessionName);
      mt = windowsBefore.find((w) => w.name === "_sentinel");
      mtJustCreated = true;
    }
    if (mt !== undefined && mt.index !== targetIdx) {
      await cockpitTmux.window.moveWindow({
        source: { sessionName, windowIndex: mt.index },
        target: { sessionName, windowIndex: targetIdx },
        kill: true,
      });
      logger.log(`  ✓ moved '_sentinel' to idx ${targetIdx} (was idx ${mt.index})`);
    }

    // Auto-fire `/loop /sentinel` on fresh creation only. Same
    // pre-existing-window safety as medic. Reuses autoStartSuperdoctorLoop's
    // generic poll-then-send machinery via the sentinel variant below.
    // ADR-132 §D4 discriminated-union narrowing: autoStart +
    // autoStartTimeoutSec are claude-variant-only fields. The cursor
    // variant doesn't auto-fire `/loop /sentinel` (it's a non-Claude
    // process; the cage's spawn command IS the loop entry — no
    // post-spawn keypress needed).
    if (
      mtJustCreated &&
      sentinel.impl === "claude" &&
      sentinel.autoStart !== false &&
      mt !== undefined
    ) {
      const settleSec = sentinel.autoStartTimeoutSec ?? 30;
      try {
        const autoStartOpts: AutoStartSentinelOpts = {
          tmux: cockpitTmux,
          sessionName,
          windowIndex: mt.index,
          timeoutMs: settleSec * 1000,
          logger,
        };
        if (deps.autoStartSleep !== undefined) autoStartOpts.sleep = deps.autoStartSleep;
        if (deps.autoStartCapturePane !== undefined) {
          autoStartOpts.capturePane = deps.autoStartCapturePane;
        }
        await autoStartSentinelLoop(autoStartOpts);
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(`  ⚠ _sentinel auto-start fell through: ${cause}`);
      }
    }
  }

  const windows = await cockpitTmux.window.listWindows(sessionName);
  const present = new Set(windows.map((w) => w.name));
  // ADR-089 §Pillar 1 §Amendment (t-2ea3bdb9, ba1f1c1): the cockpit hosts
  // only L2 parent-team viewer windows. L3 epic-team viewers live INSIDE
  // their parent's cage as 🌳-prefixed siblings of lead/planner/etc — added
  // at epic `atmux start` time via addEpicViewerToParentCage (start.ts:967),
  // not by cockpit rebuild. Filter epic-teams out of every cockpit-side
  // window operation: wanted-set (drives orphan removal), add-loop, reorder
  // pass. Regression source: prior rebuild iterated `teams` (which includes
  // both type:"team" and type:"epic-team" per enabledTeams) and created a
  // cockpit window per row, producing per-epic duplicates of the
  // parent-cage viewers — surfaced 2026-05-18 as complaint c-abb7b603.
  //
  // The runtime check uses `in` rather than asserting a wider type because
  // the param is typed `CockpitTeam[]` for back-compat — real fleet callers
  // (cockpitRebuild) pass FlattenedTeamEntry[] which has `.type`, while
  // legacy test fixtures may pass bare CockpitTeam[] without it. The `in`
  // check is false on the legacy shape → no filtering → byte-identical
  // behavior to pre-fix for callers that never had epic-teams to filter.
  const cockpitTeams = teams.filter(
    (t) => !("type" in t && (t as { type?: string }).type === "epic-team"),
  );
  const wanted = new Set([
    "_superdriver",
    ...(wantMedic ? ["_medic"] : []),
    ...(wantSentinel ? ["_sentinel"] : []),
    ...cockpitTeams.map((t) => t.name),
  ]);

  // Per-team mode: filter teams to JUST the named one before the add
  // pass — defensive against callers passing the full roster but
  // wanting only one window touched. Per-team callers may name an
  // epic-team; cockpitTeams already excludes those, so the filter
  // returns [] for an epic-team target — correct (no cockpit window
  // is wanted) and skips the add pass naturally.
  const teamsToAdd =
    onlyTeam !== undefined ? cockpitTeams.filter((t) => t.name === onlyTeam) : cockpitTeams;

  // Add missing viewer windows.
  for (const t of teamsToAdd) {
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

  // ADR-135 §D2 §Amendment (t-34fa0132): epic-team viewer windows MUST sit
  // immediately after their parent's viewer in cockpit window order. The
  // `teams` array from enabledTeams() is already in DFS pre-order
  // (parent → child → next sibling), so the desired layout is:
  //   [_superdriver, _medic?, _martinet?, ...teams in DFS order]
  // Skip this pass in per-team mode — single-team callers have no authority
  // to reorder sibling team viewers.
  if (onlyTeam === undefined) {
    // Compute the base index where team windows should start, derived from
    // the cockpit-role windows that precede them (per ADR-135 §D2).
    const windowsForOrder = await cockpitTmux.window.listWindows(sessionName);
    const sdrv = windowsForOrder.find((w) => w.name === "_superdriver");
    const cursorBase =
      (sdrv !== undefined ? sdrv.index + 1 : 1) + (wantMedic ? 1 : 0) + (wantSentinel ? 1 : 0);
    // ADR-089 §Pillar 1 §Amendment: epic-teams are NOT cockpit windows;
    // reorder only places L2 parent teams. Using `teams` (which contains
    // epic-teams too) would assign cockpit slots to entries that have no
    // cockpit window, leaving gaps and offsetting sibling teams.
    const desired = cockpitTeams.map((t, i) => ({ name: t.name, finalIdx: cursorBase + i }));

    // Park-then-place to avoid sibling-team collisions.
    //
    // A single-pass in-place reorder using moveWindow({kill:true}) destroys
    // any sibling team viewer that currently occupies the cursor slot —
    // worst-case observed in the medic-displace recreate path: alpha is
    // killed by the displace, recreated at the trailing end, then the
    // reorder of alpha into the slot currently held by beta kills beta. No
    // single-direction walk (left-to-right or right-to-left) escapes this:
    // whenever two teams have swapped relative order vs. the desired layout,
    // at least one collision is mathematically unavoidable in a single pass.
    //
    // Park-then-place sidesteps the collision class: every misaligned team
    // moves first to a high-index parking slot (empty by construction), then
    // moves from parking to its final slot (also empty, since every team
    // that needed that slot is also parked). Already-aligned teams are
    // skipped — they incur zero churn.
    const PARK_BASE = 9000;
    const before = await cockpitTmux.window.listWindows(sessionName);
    for (let i = 0; i < desired.length; i++) {
      const d = desired[i]!;
      const w = before.find((x) => x.name === d.name);
      if (w === undefined) continue;
      if (w.index === d.finalIdx) continue;
      try {
        await cockpitTmux.window.moveWindow({
          source: { sessionName, windowIndex: w.index },
          target: { sessionName, windowIndex: PARK_BASE + i },
          kill: true,
        });
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(`  ⚠ park of '${d.name}' to idx ${PARK_BASE + i} failed: ${cause}`);
      }
    }
    for (let i = 0; i < desired.length; i++) {
      const d = desired[i]!;
      const current = await cockpitTmux.window.listWindows(sessionName);
      const w = current.find((x) => x.name === d.name);
      if (w === undefined) continue;
      if (w.index === d.finalIdx) continue;
      try {
        await cockpitTmux.window.moveWindow({
          source: { sessionName, windowIndex: w.index },
          target: { sessionName, windowIndex: d.finalIdx },
          kill: true,
        });
        logger.log(`  ✓ moved '${d.name}' to idx ${d.finalIdx} (was idx ${w.index})`);
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(`  ⚠ reorder of '${d.name}' to idx ${d.finalIdx} failed: ${cause}`);
      }
    }
  }

  // Remove orphan viewer windows (e.g. team that was removed/disabled).
  // _superdriver + _medic (when enabled) + _sentinel (when enabled)
  // are always preserved (ADR-135 canonical names). The legacy names
  // `superdriver` / `medic` / `sentinel` and the pre-ADR-133 legacy
  // `superdoctor` window are also preserved during the deprecation
  // window so an operator running between releases doesn't lose a
  // cage that hasn't been renamed yet. (Cage rename to canonical
  // happens in the migration shim above; this guard is the
  // belt-and-braces fallback when the shim is somehow skipped, e.g.
  // a test fixture that injects pre-named windows directly.)
  //
  // Per-team mode (ADR-063 ergonomic fix): SKIP this pass entirely.
  // The single-team caller has no authority to remove sibling team
  // viewers; only the fleet-wide `cockpit rebuild` does that.
  if (onlyTeam !== undefined) return;

  for (const w of windows) {
    if (wanted.has(w.name)) continue;
    if (w.name === "_superdriver" || w.name === "superdriver") continue;
    if (w.name === "_medic" || w.name === "medic") continue;
    if (w.name === "superdoctor") continue;
    if (w.name === "_sentinel" || w.name === "sentinel") continue;
    try {
      await cockpitTmux.window.killWindow(`${sessionName}:${w.name}`);
      logger.log(`  ✓ removed orphan window '${w.name}'`);
    } catch {
      // window may already be gone
    }
  }
}

/**
 * ADR-077 + ADR-133: build the shell command the cockpit medic window
 * runs (legacy alias: `buildSuperdoctorWindowCommand`). Mirrors the
 * team-window claude-bootstrap shape (CLAUDE_CONFIG_DIR + effortLevel +
 * permissionMode + plugin-dir) when `claudeAccount` is set; otherwise
 * emits a bare `claude` invocation that inherits the operator's
 * default shell env (matches superdriver's default).
 *
 * Defaults match `normaliseTeamJson`'s tuiCommands.claude builder
 * (effortLevel=xhigh, permissionMode=auto) so a medic session runs with
 * the same Opus + auto-mode posture as a team window.
 */
export function buildMedicWindowCommand(m: CockpitMedic): string {
  return buildClaudeWindowCommand(m);
}

/** @deprecated use {@link buildMedicWindowCommand} (ADR-133 rename) —
 *  kept as alias so legacy callers in tests / cron-install paths
 *  continue to work during the deprecation window. */
export function buildSuperdoctorWindowCommand(sd: CockpitSuperdoctor): string {
  return buildClaudeWindowCommand(sd);
}

/**
 * ADR-132 §D2: build the shell command the cockpit sentinel window
 * runs. Per ADR-132 §D4 the dispatcher cage launches the resolved
 * impl directly — `claude` variant runs the standard claude TUI under
 * the operator account (structurally identical to medic); `cursor`
 * variant runs the `atmux sentinel tick` loop which internally shells
 * out to `cursor-agent --print --model <model>` per tick (wired in
 * `src/verbs/sentinel.ts::buildSentinel` — T3 / t-e96d286a).
 *
 * The window discriminator narrows the invocation:
 *   - claude  → standard claude TUI (`/loop /sentinel` auto-fired
 *               post-settle by `autoStartSentinelLoop`)
 *   - cursor  → bash loop firing `atmux sentinel tick` at the cadence
 *               configured in `team.sentinelOverrides.cadenceSec`
 *               (default 270s per `DEFAULT_SENTINEL_CADENCE_SEC`).
 *               No interactive TUI — cursor-agent is a `--print` CLI
 *               and the loop is owned by the verb shell, not a Claude
 *               REPL.
 *
 * Cage posture (per task body §Cage provisioning + ADR-058 §D3): the
 * cockpit session itself runs as operator UID with full git access —
 * the W3 window therefore IS the Tier-2 cage in trust posture.
 * Sentinel is fleet-wide singleton (one cage observes all teams), so
 * no per-team `/tmp/atmux_cursor_sentinel_<team>/sock` carve-out is
 * provisioned; the task body's per-team cage path predated the §D2
 * fleet-singleton reshape and is reframed here as "operator-UID W3
 * window with per-tick cursor-agent shell-out."
 */
export function buildSentinelWindowCommand(m: CockpitSentinel): string {
  if (m.impl === "claude") {
    return buildClaudeWindowCommand(m);
  }
  // Cursor variant — bash loop firing `atmux sentinel tick` at the
  // cadence configured in `team.sentinelOverrides.cadenceSec` (default
  // 270s per `DEFAULT_SENTINEL_CADENCE_SEC`). The verb's
  // `buildSentinel` constructs CursorSentinel which spawns
  // `cursor-agent --print --output-format json --model <m.model>
  // --force <prompt>` on every tick.
  //
  // Sleep cadence is hard-coded here at 270s (5min - cache-safe per
  // global CLAUDE.md "Don't pick 300s" cache-window rule). Per-team
  // override via `sentinelOverrides.cadenceSec` is honored by the
  // verb's per-team resolver — this loop's cadence is the FLOOR; the
  // verb may exit early if internal timing dictates.
  return ["while true; do", "  atmux sentinel tick", "  sleep 270", "done"].join(" ");
}

/** Shared body for the medic / sentinel window-command builders.
 *  Reads the same `tuiOverrides` + `claudeAccount` fields each block
 *  surfaces (struct shape mirrored on purpose per ADR-077 §D2 +
 *  ADR-132 §D6 — both reuse `CockpitClaudeAccount` / `CockpitTuiOverrides`
 *  verbatim). Kept private so the public builder functions read as
 *  intent-named call sites. */
function buildClaudeWindowCommand(cfg: {
  claudeAccount?: { configDir: string; label?: string | undefined } | undefined;
  tuiOverrides?:
    | {
        effortLevel?: string | undefined;
        permissionMode?: string | undefined;
        pluginDir?: string | undefined;
      }
    | undefined;
}): string {
  const ov = cfg.tuiOverrides;
  const effort = ov?.effortLevel ?? "xhigh";
  const permission = ov?.permissionMode ?? "auto";
  const pluginFlag = ov?.pluginDir !== undefined ? ` --plugin-dir=${ov.pluginDir}` : "";
  if (cfg.claudeAccount !== undefined) {
    return (
      `CLAUDE_CONFIG_DIR=${cfg.claudeAccount.configDir} ` +
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
  wantMedic: boolean;
  wantSentinel: boolean;
  yes: boolean;
  logger: Logger;
  /** ADR-063 ergonomic fix interplay (t-ab8df0b4): when set, the live
   *  reconcile body skips BOTH the superdoctor-relocation path AND the
   *  orphan-prune pass — so the dry-run gate must too, or the test/CI
   *  caller's `onlyTeam` path collides with the safety gate over ops
   *  that will never actually fire. */
  onlyTeam?: string;
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
 *   1. `medic` displacement — when wantMedic is on AND the target slot
 *      (`superdriver.index + 1`) is currently occupied by a NON-medic
 *      (and non-superdoctor-mid-migration) window.
 *   2. `sentinel` displacement — when wantSentinel is on AND the target
 *      slot (`superdriver.index + (wantMedic ? 2 : 1)`) is currently
 *      occupied by a NON-sentinel window.
 *   3. Orphan-prune — any window not in {superdriver, medic (when
 *      enabled), sentinel (when enabled), superdoctor (preserved during
 *      ADR-133 deprecation window), team-names...} that the live code's
 *      `killWindow` would sweep.
 */
async function refusePlannedDestructiveOps(opts: RefuseDestructiveOpts): Promise<void> {
  const { cockpitTmux, sessionName, teams, wantMedic, wantSentinel, yes, logger, onlyTeam } = opts;
  // Per-team (onlyTeam) mode is purely additive in the live body — no
  // medic relocation, no orphan-prune. Skip the dry-run entirely
  // rather than report "destructive" ops that the live path will never
  // execute (t-ab8df0b4 + t-8b0e077e interplay).
  if (onlyTeam !== undefined) return;
  const windows = await cockpitTmux.window.listWindows(sessionName);
  const planned: PlannedDestructiveOp[] = [];

  // ADR-135 §D2 canonical names are `_superdriver` / `_medic` /
  // `_sentinel`; the in-place rename shim (above this call) has
  // already migrated legacy names by the time this dry-run walks the
  // window list. Legacy names are kept in the preserved-window
  // matchers as a belt-and-braces — test fixtures may inject
  // pre-renamed windows directly.
  const sdrv = windows.find((w) => w.name === "_superdriver");
  const baseIdx = sdrv !== undefined ? sdrv.index : 1;

  // Case 1 — _medic displacement.
  if (wantMedic) {
    const targetIdx = baseIdx + 1;
    const md = windows.find((w) => w.name === "_medic");
    // Only counts as destructive when _medic EXISTS at a wrong index
    // AND the target slot has someone else parked there. Fresh adds
    // (md === undefined) land in the empty slot non-destructively. The
    // legacy "superdoctor" / "medic" window is treated as
    // renaming-into-_medic (handled separately by the rename-window
    // pre-pass), not destructive.
    if (md !== undefined && md.index !== targetIdx) {
      const occupant = windows.find(
        (w) =>
          w.index === targetIdx &&
          w.name !== "_medic" &&
          w.name !== "medic" &&
          w.name !== "superdoctor",
      );
      if (occupant !== undefined) {
        planned.push({
          window: occupant.name,
          action: "move-with-kill",
          reason: `target slot ${targetIdx} occupied by '${occupant.name}'; _medic relocation kills it`,
        });
      }
    }
  }

  // Case 2 — _sentinel displacement.
  if (wantSentinel) {
    const targetIdx = baseIdx + (wantMedic ? 2 : 1);
    const mt = windows.find((w) => w.name === "_sentinel");
    if (mt !== undefined && mt.index !== targetIdx) {
      const occupant = windows.find(
        (w) => w.index === targetIdx && w.name !== "_sentinel" && w.name !== "sentinel",
      );
      if (occupant !== undefined) {
        planned.push({
          window: occupant.name,
          action: "move-with-kill",
          reason: `target slot ${targetIdx} occupied by '${occupant.name}'; _sentinel relocation kills it`,
        });
      }
    }
  }

  // Case 3 — orphan-prune. Compute the wanted-name set; anything else
  // that isn't an always-preserved window gets killed.
  const wanted = new Set<string>([
    "_superdriver",
    ...(wantMedic ? ["_medic"] : []),
    ...(wantSentinel ? ["_sentinel"] : []),
    ...teams.map((t) => t.name),
  ]);
  for (const w of windows) {
    if (wanted.has(w.name)) continue;
    if (w.name === "_superdriver" || w.name === "superdriver") continue;
    if (w.name === "_medic" || w.name === "medic") continue;
    if (w.name === "_sentinel" || w.name === "sentinel") continue;
    // Legacy `superdoctor` window is preserved during the ADR-133
    // deprecation window — rebuild migrates it via rename-window
    // (pre-pass), not prune. If wantMedic is OFF and the legacy window
    // exists, leave it alone (operator may still rely on it).
    if (w.name === "superdoctor") continue;
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

// ---------- ADR-132 §D2: sentinel auto-start ----------

export interface AutoStartSentinelOpts {
  tmux: TmuxNamespace;
  sessionName: string;
  windowIndex: number;
  /** Max wall-clock to wait for the pane to settle to a Claude idle
   *  prompt before bailing without a send-keys. Operator falls back to
   *  manual `/loop /sentinel` when this fires. */
  timeoutMs: number;
  logger: Logger;
  /** Test injection — defaults to `setTimeout`-backed. */
  sleep?: (ms: number) => Promise<void>;
  /** Test injection — defaults to `tmux.pane.capturePane`. */
  capturePane?: (sessionName: string, windowIndex: number) => Promise<string>;
}

/**
 * ADR-132 §D2 + ADR-077 §t-22453c1e parallel: poll the freshly-created
 * sentinel pane until it settles to a Claude idle prompt, then
 * `tmux send-keys` `/loop /sentinel` + Enter. Same non-fatal posture as
 * the medic auto-start — every branch logs + returns; the operator
 * falls back to typing the keystroke manually if anything goes wrong.
 *
 * Three terminal outcomes:
 *   - Idle prompt detected → send-keys → verify → log ok / warn-no-verify
 *   - Timeout (default 30s, configurable) → warn + return
 *   - Capture throws → warn + return
 */
export async function autoStartSentinelLoop(opts: AutoStartSentinelOpts): Promise<void> {
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
        `  ⚠ sentinel auto-start: capture-pane failed (${cause}); operator falls back to manual \`/loop /sentinel\``,
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
      `  ⚠ sentinel pane not ready after ${Math.floor(opts.timeoutMs / 1000)}s; type \`/loop /sentinel\` manually`,
    );
    return;
  }

  const target: SendTarget = {
    kind: "member",
    member: "sentinel",
    team: opts.sessionName,
    target: { sessionName: opts.sessionName, windowIndex: opts.windowIndex },
  };
  try {
    await opts.tmux.pane.sendKeys({
      target,
      keys: "/loop /sentinel",
      enter: true,
    });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    opts.logger.warn(
      `  ⚠ sentinel auto-start: send-keys failed (${cause}); operator falls back to manual`,
    );
    return;
  }

  await sleep(SUPERDOCTOR_POST_SEND_VERIFY_MS);
  let postCapture: string;
  try {
    postCapture = await capturePane(opts.sessionName, opts.windowIndex);
  } catch {
    opts.logger.log(
      "  ✓ sentinel auto-started (`/loop /sentinel` sent; verification capture failed — assume ok)",
    );
    return;
  }
  if (SUPERDOCTOR_LOOP_LANDED_MARKERS.some((m) => postCapture.includes(m))) {
    opts.logger.log("  ✓ sentinel auto-started (`/loop /sentinel` confirmed)");
  } else {
    opts.logger.warn(
      "  ⚠ sentinel auto-start: send-keys fired but verification marker not seen in 5s; operator should sanity-check the window",
    );
  }
}
