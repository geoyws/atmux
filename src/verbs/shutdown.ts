// ADR-242: `atmux shutdown` — single-verb whole-fleet teardown.
//
// Default invocation drains every enabled team (`stop --team-dir`),
// then kills the cockpit session and the atmux tmux server, and
// appends a one-line receipt to ~/.atmux/state/shutdown.log.
// Best-effort sweep: one team's failure warns and continues; the verb
// still returns 0 (mirror `stop`'s warn-and-continue posture).
//
// Deviations from the ADR text, both forced by later retirements:
// - No pkill-orphan-orchd sweep (D1 step 5): orchd is retired per
//   ADR-276, nothing to sweep.
// - Socket via getCockpitSocketName() (atmux-cockpit per ADR-162),
//   not the `-L atmux` literal in D1 steps 3-4.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCockpitSocketName } from "../core/tmux-paths.ts";
import { enabledTeams, loadCockpit } from "../core/cockpit.ts";
import type { Logger } from "../core/tui.ts";
import { createLogger } from "../core/tui.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import { UsageError } from "../errors.ts";
import { stop } from "./stop.ts";

const USAGE =
  "atmux shutdown [--keep-cockpit] [--force] [--dry-run]";

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
    if (a === "--keep-cockpit") keepCockpit = true;
    else if (a === "--force") force = true;
    else if (a === "--dry-run") dryRun = true;
    else throw new UsageError({ what: `shutdown: unknown arg: ${a}`, hint: USAGE });
  }
  return { keepCockpit, force, dryRun };
}

/** `atmux shutdown` test seams. */
export interface ShutdownOpts {
  /** Override `process.env`. Tests pass a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Inject the tmux factory for tests (default: `createTmux`). */
  tmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Logger sink override (default: `createLogger()`). */
  logger?: Logger;
  /** In-process per-team stop. Defaults to the real `stop` verb.
   *  Tests stub this to avoid touching live cages. */
  stopFn?: (argv: ReadonlyArray<string>) => Promise<number>;
  /** Override the cockpit.json path (tests). */
  configPath?: string;
  /** Now-provider (tests). Defaults to `Date.now()`. */
  nowMs?: () => number;
}

/** `atmux shutdown [--keep-cockpit] [--force] [--dry-run]`. Returns 0. */
export async function shutdown(
  argv: ReadonlyArray<string>,
  opts: ShutdownOpts = {},
): Promise<number> {
  const parsed = parseShutdownArgs(argv);
  const env = opts.env ?? process.env;
  const factory = opts.tmuxFactory ?? createTmux;
  const logger = opts.logger ?? createLogger();
  const stopFn = opts.stopFn ?? stop;
  const nowMs = opts.nowMs ?? Date.now;

  const loadOpts = opts.configPath !== undefined ? { env, path: opts.configPath } : { env };
  const cockpit = await loadCockpit(loadOpts);
  const teams = enabledTeams(cockpit);

  if (parsed.dryRun) {
    logger.log(`[atmux shutdown] dry-run: ${teams.length} team(s) would stop`);
    for (const t of teams) logger.log(`  would stop: ${t.name} (${t.root})`);
    if (!parsed.force) logger.log("  per-team stop would run (best-effort, warnings continue)");
    else logger.log("  --force: per-team stop would be skipped");
    if (!parsed.keepCockpit) {
      logger.log(`  would kill session: ${cockpit.cockpitSession}`);
      logger.log("  would kill atmux tmux server");
    } else {
      logger.log("  --keep-cockpit: cockpit session + server would survive");
    }
    return 0;
  }

  const t0 = nowMs();
  let stopped = 0;
  if (!parsed.force) {
    for (const t of teams) {
      try {
        await stopFn(["--team-dir", t.root]);
        stopped += 1;
        logger.log(`  ✓ stopped team '${t.name}'`);
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        logger.warn(`  ⚠ stop of team '${t.name}' failed (${cause}) — continuing teardown`);
      }
    }
  } else {
    logger.log("  --force: skipping per-team stop, straight to tmux-kill");
  }

  let cockpitTornDown = false;
  if (!parsed.keepCockpit) {
    const tmux = factory({ socket: getCockpitSocketName(env) });
    try {
      if (await tmux.session.hasSession(`=${cockpit.cockpitSession}`)) {
        await tmux.session.killSession(`=${cockpit.cockpitSession}`);
        logger.log(`  ✓ killed cockpit session '${cockpit.cockpitSession}'`);
      } else {
        logger.warn(`  ⚠ cockpit session '${cockpit.cockpitSession}' absent — nothing to kill`);
      }
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      logger.warn(`  ⚠ cockpit session kill failed (${cause}) — continuing to kill-server`);
    }
    try {
      await tmux.server.killServer();
      logger.log("  ✓ killed atmux tmux server");
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      logger.warn(`  ⚠ kill-server failed (${cause})`);
    }
    cockpitTornDown = true;
  } else {
    logger.log("  --keep-cockpit: cockpit session + server left alive");
  }

  const secs = ((nowMs() - t0) / 1000).toFixed(1);
  const summary =
    `[atmux shutdown] ${stopped}/${teams.length} teams stopped, ` +
    (cockpitTornDown ? "cockpit torn down" : "cockpit kept") +
    ` (${secs}s)`;
  logger.log(summary);
  await appendShutdownLog(env, summary);
  return 0;
}

/** Append one receipt line, keeping the last 10. */
async function appendShutdownLog(env: NodeJS.ProcessEnv, line: string): Promise<void> {
  const home = env.HOME ?? env.HOMEDIR ?? "";
  if (home === "") return;
  const dir = join(home, ".atmux", "state");
  const file = join(dir, "shutdown.log");
  await mkdir(dir, { recursive: true });
  let prev: string[] = [];
  try {
    prev = (await readFile(file, "utf8")).split("\n").filter((l) => l.length > 0);
  } catch {
    // first shutdown on this host — no log yet
  }
  const kept = [...prev, line].slice(-10);
  await writeFile(file, kept.join("\n") + "\n", "utf8");
}
