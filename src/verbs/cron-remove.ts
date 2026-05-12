// ADR-083 follow-up §DEFERRED row 1: `atmux cron-remove` verb — drop
// the team's marker-fenced crontab block. Symmetric inverse of
// `cron-install`. Idempotent: re-running when no block is present is a
// silent no-op (matches bash `lib/cron.sh::atmux::cron_remove`
// lines 283-312).
//
// Bash call site: `lib/stop.sh:115` fires `cron_remove` unconditionally
// after the session is killed. Comment there explains why no
// `kanban.cronAutoInstall` gate is needed: when the operator opts out
// of auto-install, no marker block exists, so the strip is a free
// no-op. We mirror that posture — `stop.ts` calls this verb on every
// stop, the strip handles the opt-out path naturally.
//
// Non-fatal posture mirrors `cron-install`:
// - `ATMUX_NO_CRON=<truthy>` → silent no-op, exit 0.
// - `crontab` not on PATH    → exit 0 (silent — bash returns 0 without
//                              a warning here; nothing for the operator
//                              to fix on a cronless host).
// - swap subprocess fails    → stderr warn, exit 0 (stop never aborts
//                              because cron cleanup hiccuped).
//
// The `--quiet` flag suppresses the success line — `atmux stop` uses
// that when it fires this verb inline so its own success line is the
// only one printed.

import { defaultCrontabIO, type CrontabIO } from "../abstractions/crontab.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { stripBlockByTeam } from "../core/cron.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux cron-remove [--quiet] [--team-dir <dir>]";

export interface CronRemoveArgs {
  quiet: boolean;
  teamDir?: string;
}

export interface CronRemoveOpts {
  /** Defaults to `defaultCrontabIO()`. Tests inject a fake. */
  crontab?: CrontabIO;
  /** Defaults to `process.env`. Tests pin `ATMUX_NO_CRON`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.stderr.write`. */
  stderr?: (s: string) => void;
  /** Defaults to `process.stdout.write`. */
  stdout?: (s: string) => void;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseCronRemoveArgs(argv: ReadonlyArray<string>): CronRemoveArgs {
  let quiet = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--quiet") {
      quiet = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "cron-remove: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `cron-remove: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `cron-remove: unexpected arg: ${a}`, hint: USAGE });
  }
  const out: CronRemoveArgs = { quiet };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Public entry point. Returns 0 on success, 0 on non-fatal skip
 *  (warns to stderr); UsageError / ConfigError propagate to the CLI
 *  dispatcher per the standard verb contract. */
export async function cronRemove(
  argv: ReadonlyArray<string>,
  opts: CronRemoveOpts = {},
): Promise<number> {
  const parsed = parseCronRemoveArgs(argv);
  const env = opts.env ?? process.env;
  const stderr = opts.stderr ?? ((s: string) => void process.stderr.write(s));
  const stdout = opts.stdout ?? ((s: string) => void process.stdout.write(s));

  if (isTruthyEnv(env.ATMUX_NO_CRON)) {
    if (env.ATMUX_DEBUG !== undefined && env.ATMUX_DEBUG !== "") {
      stderr("cron-remove: ATMUX_NO_CRON set, no-op\n");
    }
    return 0;
  }

  const dirOpts: ResolveDirOpts =
    parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  // atmuxDir is resolved as a side-effect-validating call to surface
  // ConfigError early if the .atmux dir is gone (matches `requireTeam`
  // sibling pattern). The value is not needed by the strip itself.
  void (await getAtmuxDir(dirOpts));

  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) {
    // Bash returns 0 silently when crontab is absent — no fix the
    // operator can apply on a cronless host. Mirror.
    return 0;
  }

  const current = await crontab.read();
  if (current === null || current === "") {
    // No crontab at all → nothing to remove. Silent no-op.
    return 0;
  }

  const stripped = stripBlockByTeam(current, team.name);
  // Idempotence: when nothing changed, avoid a needless crontab swap
  // that would bump mtime and trip cron-config detectors. Bash same
  // guard at lib/cron.sh:300-302.
  if (stripped === current || `${stripped}\n` === current) {
    return 0;
  }

  try {
    await crontab.write(stripped);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    stderr(`cron-remove: crontab swap failed (${cause})\n`);
    return 0;
  }

  if (!parsed.quiet) {
    stdout(`removed cron block for team '${team.name}'\n`);
  }
  return 0;
}

// ---------- Internals ----------

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
