// ADR-083 §IN §3: `atmux cron-install` verb — refresh the team's
// marker-fenced crontab block. Idempotent: re-running yields a
// byte-identical crontab.
//
// Bash spec: lib/cron.sh::atmux::cron_install (the install path that
// `lib/start.sh:372-387` fires inline). This TS port splits the bash
// monolith into a pure transform (`core/cron.ts::installCronBlock`) + a
// thin CLI wrapper (this file) + a DI seam (`abstractions/crontab.ts`).
//
// Non-fatal posture mirrors bash:
// - `ATMUX_NO_CRON=<truthy>` → silent no-op, exit 0.
// - `crontab` not on PATH    → stderr warn, exit 0.
// - bin resolution fails     → stderr warn, exit 0.
// - swap subprocess fails    → stderr warn, exit 0 (start never aborts
//                              because cron-install hiccuped).
//
// The `--quiet` flag suppresses the success line — `atmux start` uses
// that when it fires this verb inline so its own success line is the
// only one printed.

import { defaultCrontabIO, type CrontabIO } from "../abstractions/crontab.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { installCronBlock } from "../core/cron.ts";
import { UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

const USAGE = "atmux cron-install [--quiet] [--team-dir <dir>]";

export interface CronInstallArgs {
  quiet: boolean;
  teamDir?: string;
}

export interface CronInstallOpts {
  /** Defaults to `defaultCrontabIO()`. Tests inject a fake. */
  crontab?: CrontabIO;
  /** Defaults to `(process.env.ATMUX_BIN ?? Bun.which("atmux"))`. Tests
   *  pin a deterministic path. */
  resolveBin?: () => string | null;
  /** Defaults to `process.env`. Tests pin `ATMUX_NO_CRON`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.stderr.write`. */
  stderr?: (s: string) => void;
  /** Defaults to `process.stdout.write`. */
  stdout?: (s: string) => void;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseCronInstallArgs(argv: ReadonlyArray<string>): CronInstallArgs {
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
        throw new UsageError({ what: "cron-install: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `cron-install: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `cron-install: unexpected arg: ${a}`, hint: USAGE });
  }
  const out: CronInstallArgs = { quiet };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Public entry point. Returns 0 on success, 0 on non-fatal skip
 *  (warns to stderr); UsageError / ConfigError propagate to the CLI
 *  dispatcher per the standard verb contract. */
export async function cronInstall(
  argv: ReadonlyArray<string>,
  opts: CronInstallOpts = {},
): Promise<number> {
  const parsed = parseCronInstallArgs(argv);
  const env = opts.env ?? process.env;
  const stderr = opts.stderr ?? ((s: string) => void process.stderr.write(s));
  const stdout = opts.stdout ?? ((s: string) => void process.stdout.write(s));

  if (isTruthyEnv(env.ATMUX_NO_CRON)) {
    if (env.ATMUX_DEBUG !== undefined && env.ATMUX_DEBUG !== "") {
      stderr("cron-install: ATMUX_NO_CRON set, no-op\n");
    }
    return 0;
  }

  const dirOpts: ResolveDirOpts =
    parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  // kanban.cronAutoInstall=false → explicit opt-out. The verb still
  // honors a direct `atmux cron-install` invocation (operators may
  // disable auto-install on start but install manually); the opt-out
  // ONLY gates the wrapper at `start.ts`. Document the inversion: this
  // verb installs whenever invoked; the auto-install gate lives at the
  // caller.

  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) {
    stderr(
      "cron-install: crontab not on PATH — skipping (install cron to enable scheduled whip/report/digest)\n",
    );
    return 0;
  }

  const atmuxBin = (opts.resolveBin ?? defaultResolveBin)();
  if (atmuxBin === null || atmuxBin === "") {
    stderr(
      "cron-install: cannot resolve atmux binary path (set ATMUX_BIN or install atmux on PATH) — skipping\n",
    );
    return 0;
  }

  const tmuxTmpdir = readTmuxTmpdir(team);
  const current = await crontab.read();
  const opts2: Parameters<typeof installCronBlock>[0] = {
    team,
    atmuxDir,
    atmuxBin,
    current,
  };
  if (tmuxTmpdir !== undefined) opts2.tmuxTmpdir = tmuxTmpdir;
  const next = installCronBlock(opts2);

  try {
    await crontab.write(next);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    stderr(`cron-install: crontab swap failed — manual install required (${cause})\n`);
    return 0;
  }

  if (!parsed.quiet) {
    stdout(
      `installed cron block for team '${team.name}' (inspect: crontab -l | grep 'atmux:team=${team.name}')\n`,
    );
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

function defaultResolveBin(): string | null {
  const envBin = process.env.ATMUX_BIN;
  if (envBin !== undefined && envBin !== "") return envBin;
  return Bun.which("atmux");
}

function readTmuxTmpdir(team: Team): string | undefined {
  const t = (team as { tmuxTmpdir?: unknown }).tmuxTmpdir;
  if (typeof t !== "string" || t === "") return undefined;
  return t;
}

