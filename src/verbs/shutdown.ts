// ADR-242: `atmux shutdown` — single-verb whole-fleet teardown.
//
// Inverse of `atmux start`: stops every enabled team, then kills the
// cockpit session + the atmux-pinned tmux server. No confirmation
// prompt (D5) — `--dry-run` is the safety valve.
//
// Behaviour (deviation from ADR-242 D1 recorded in the task brief:
// the orchd sweep is DROPPED — orchd retired per ADR-276 — and the
// summary carries no orchd count):
//
//   1. Enumerate enabled `type: "team"` entries via `enabledTeams`.
//   2. Unless --force: per-team stop for each (best-effort — a single
//      failure warns + the sweep continues).
//   3. Unless --keep-cockpit: `kill-session -t <cockpitSession>` then
//      `kill-server` on the atmux-pinned socket (best-effort each).
//   4. One-line summary to stdout + append to
//      `~/.atmux/state/shutdown.log` (append-only, last 10 entries).
//   5. --dry-run: enumerate + log what WOULD happen, change nothing,
//      exit 0 (no log-file write).
//
// NO active-pane inference, NO send-keys (repo invariants).

import { homedir } from "node:os";
import { join } from "node:path";
import { appendText, readTextOrNull, writeText } from "../abstractions/fs.ts";
import { now, nowIso } from "../abstractions/time.ts";
import {
  createTmux,
  exactSessionTarget,
  type TmuxConfig,
  type TmuxNamespace,
} from "../abstractions/tmux.ts";
import { enabledTeams, type LoadedCockpit, loadCockpit } from "../core/cockpit.ts";
import { getCockpitSocketName } from "../core/tmux-paths.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";
import { stop } from "./stop.ts";

const USAGE = "atmux shutdown [--keep-cockpit] [--force] [--dry-run]";

/** Max entries retained in `shutdown.log` (ADR-242 D1 step 6). */
export const SHUTDOWN_LOG_CAP = 10;

/** Parsed `shutdown` argv. */
export interface ShutdownArgs {
  keepCockpit: boolean;
  force: boolean;
  dryRun: boolean;
}

/** Pure parser. Throws `UsageError` on unknown args. */
export function parseShutdownArgs(argv: ReadonlyArray<string>): ShutdownArgs {
  let keepCockpit = false;
  let force = false;
  let dryRun = false;
  for (const a of argv) {
    if (a === "--keep-cockpit") {
      keepCockpit = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else {
      throw new UsageError({ what: `shutdown: unknown arg: ${a}`, hint: USAGE });
    }
  }
  return { keepCockpit, force, dryRun };
}

/** Minimal team handle handed to the per-team stop seam. */
export interface ShutdownTeam {
  name: string;
  root: string;
}

/** `atmux shutdown` injectable seams. Production callers omit all opts. */
export interface ShutdownOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Cockpit loader. Default = the real `loadCockpit`. Tests inject a
   *  canned roster so no `cockpit.json` is read. */
  loadCockpitFn?: () => Promise<LoadedCockpit>;
  /** Per-team stop. Default = the real `stop` verb scoped via
   *  `--team-dir <root>`. Tests inject a recorder/thrower. */
  stopTeamFn?: (team: ShutdownTeam) => Promise<void>;
  /** Tmux factory for the cockpit socket. Default = `createTmux`.
   *  Tests inject a fake namespace so no live tmux is touched. */
  tmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Override the shutdown.log path. Default resolves under
   *  `<home>/.atmux/state/shutdown.log`. */
  shutdownLogPath?: string;
  /** Home-dir override for log-path resolution (test injection). */
  home?: string;
  /** Log-file read seam (`null` ⇒ absent). Default = `readTextOrNull`. */
  readLogFn?: (path: string) => Promise<string | null>;
  /** Log-file append seam. Default = `appendText`. */
  appendLogFn?: (path: string, content: string) => Promise<void>;
  /** Log-file rewrite seam (cap enforcement). Default = `writeText`. */
  writeLogFn?: (path: string, content: string) => Promise<void>;
  /** Clock override (test injection). Default = `time.now()`. */
  nowMs?: () => number;
  /** Logger sink override (default: `createLogger()`, stderr). */
  logger?: Logger;
  /** Stdout sink override (default: `process.stdout.write`). */
  stdout?: (line: string) => void;
}

/** Default per-team stop: the real `stop` verb scoped to the team's root. */
export async function defaultStopTeamFn(team: ShutdownTeam): Promise<void> {
  await stop(["--team-dir", team.root]);
}

/** Default stdout sink. Exported so tests can cover it directly. */
export function defaultShutdownStdout(line: string): void {
  process.stdout.write(line);
}

/** Log-path resolution inputs. Both optional; `home` wins over `env.HOME`. */
export interface ShutdownLogPathOpts {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Resolve the shutdown.log path: `<home>/.atmux/state/shutdown.log`. */
export function resolveShutdownLogPath(opts: ShutdownLogPathOpts): string {
  const home = opts.home ?? opts.env?.HOME ?? homedir();
  return join(home, ".atmux", "state", "shutdown.log");
}

/** Render a millisecond duration as `<s>s` with one decimal. */
export function formatShutdownDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * `atmux shutdown` — stop every enabled team, kill the cockpit session +
 * the atmux-pinned tmux server. Best-effort throughout: a single team's
 * stop failure (or a kill failure) warns and the teardown continues.
 * Returns the process exit code (0 on completion, including partial).
 */
export async function shutdown(
  argv: ReadonlyArray<string>,
  opts: ShutdownOpts = {},
): Promise<number> {
  const parsed = parseShutdownArgs(argv);
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? createLogger();
  const stdout = opts.stdout ?? defaultShutdownStdout;
  const nowMs = opts.nowMs ?? now;
  const started = nowMs();

  const load = opts.loadCockpitFn ?? loadCockpit;
  const cockpit = await load();
  const teams = enabledTeams(cockpit);

  if (parsed.dryRun) {
    if (!parsed.force) {
      for (const t of teams) logger.log(`shutdown: would stop team ${t.name}`);
    } else {
      logger.log("shutdown: would skip per-team stop (--force)");
    }
    if (!parsed.keepCockpit) {
      logger.log(`shutdown: would kill-session ${cockpit.cockpitSession}`);
      logger.log("shutdown: would kill-server on the atmux-pinned socket");
    } else {
      logger.log("shutdown: would keep cockpit (--keep-cockpit)");
    }
    const teamsPart = parsed.force
      ? "would skip per-team stop"
      : `would stop ${teams.length} team(s)`;
    const cockpitPart = parsed.keepCockpit ? "would keep cockpit" : "would tear down cockpit";
    stdout(
      `[atmux shutdown] dry-run: ${teamsPart}, ${cockpitPart} (${formatShutdownDuration(nowMs() - started)})\n`,
    );
    return 0;
  }

  const stopTeam = opts.stopTeamFn ?? defaultStopTeamFn;
  let stopped = 0;
  const failed: string[] = [];
  if (!parsed.force) {
    for (const t of teams) {
      try {
        await stopTeam({ name: t.name, root: t.root });
        stopped += 1;
        logger.log(`shutdown: stopped team ${t.name}`);
      } catch (e) {
        failed.push(t.name);
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(`shutdown: stop ${t.name} failed (${cause}) — continuing`);
      }
    }
  }

  if (!parsed.keepCockpit) {
    const socket = getCockpitSocketName(env);
    const factory = opts.tmuxFactory ?? createTmux;
    const tmux = factory({ socket });
    const target = exactSessionTarget(cockpit.cockpitSession);
    try {
      await tmux.session.killSession(target);
      logger.log(`shutdown: killed cockpit session ${cockpit.cockpitSession}`);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      logger.warn(
        `shutdown: kill-session ${cockpit.cockpitSession} failed (${cause}) — continuing`,
      );
    }
    try {
      await tmux.server.killServer();
      logger.log(`shutdown: killed tmux server on socket ${socket}`);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      logger.warn(`shutdown: kill-server failed (${cause}) — continuing`);
    }
  }

  const teamsPart = parsed.force
    ? "per-team stop skipped (--force)"
    : `${stopped}/${teams.length} teams stopped${failed.length > 0 ? ` (${failed.length} failed: ${failed.join(", ")})` : ""}`;
  const cockpitPart = parsed.keepCockpit ? "cockpit kept" : "cockpit torn down";
  const summary = `[atmux shutdown] ${teamsPart}, ${cockpitPart} (${formatShutdownDuration(nowMs() - started)})`;
  stdout(`${summary}\n`);
  await appendShutdownLog(summary, started, opts);
  return 0;
}

/** Append the summary line to `shutdown.log`, capping at the last 10. */
async function appendShutdownLog(
  summary: string,
  started: number,
  opts: ShutdownOpts,
): Promise<void> {
  const logPath =
    opts.shutdownLogPath ?? resolveShutdownLogPath({ home: opts.home, env: opts.env });
  const readLog = opts.readLogFn ?? readTextOrNull;
  const appendLog = opts.appendLogFn ?? appendText;
  const writeLog = opts.writeLogFn ?? writeText;
  const line = `${nowIso(started)} ${summary}\n`;
  const existing = await readLog(logPath);
  if (existing === null || existing === "") {
    await appendLog(logPath, line);
    return;
  }
  const lines = existing.split("\n").filter((l) => l.length > 0);
  lines.push(line.trimEnd());
  if (lines.length <= SHUTDOWN_LOG_CAP) {
    await appendLog(logPath, line);
    return;
  }
  await writeLog(logPath, `${lines.slice(-SHUTDOWN_LOG_CAP).join("\n")}\n`);
}
