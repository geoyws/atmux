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

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type CrontabIO, defaultCrontabIO } from "../abstractions/crontab.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { installCronBlock, migrateSuperdoctorToMedicCronLines } from "../core/cron.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

const USAGE =
  "atmux cron-install [--quiet] [--template merge-cycle] [--interval 5m|15m|1h|<N>m] [--team-dir <dir>]";

/** Allowed `--template` values (ADR-088 W7: only `merge-cycle` lands
 *  in this commit; future templates would extend this list). */
export const CRON_INSTALL_TEMPLATES = ["merge-cycle"] as const;
export type CronInstallTemplate = (typeof CRON_INSTALL_TEMPLATES)[number];

export interface CronInstallArgs {
  quiet: boolean;
  /** ADR-088 W7 (t-2f12839e) — template validator. When `merge-cycle`,
   *  the install path verifies `team.merger.enabled === true` and
   *  errors out with a config hint if not. The standard install
   *  block ALWAYS includes the merge-cycle line when merger is enabled
   *  regardless of `--template`; this flag is the operator-facing
   *  "I'm installing for merge-cycle specifically" assertion (also
   *  the natural place to validate the schema). */
  template?: CronInstallTemplate;
  /** ADR-088 W7 — transient cadence override for merge-cycle line.
   *  Parsed from `5m` / `15m` / `1h` / `<N>m` (canonical → minutes).
   *  Threaded into `installCronBlock` as `mergerIntervalOverride`.
   *  Only meaningful with `--template merge-cycle`. */
  intervalMins?: number;
  teamDir?: string;
}

/** Parse the `--interval` suffix (`5m`, `15m`, `1h`, `<N>m`) into
 *  minutes. Exported for unit tests + symmetric reuse if future
 *  templates need their own interval flag. */
export function parseIntervalToMins(raw: string): number {
  if (raw.endsWith("m")) {
    const n = Number.parseInt(raw.slice(0, -1), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError({
        what: `cron-install: --interval value '${raw}' is not a positive minutes count`,
        hint: USAGE,
      });
    }
    return n;
  }
  if (raw.endsWith("h")) {
    const n = Number.parseInt(raw.slice(0, -1), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError({
        what: `cron-install: --interval value '${raw}' is not a positive hours count`,
        hint: USAGE,
      });
    }
    return n * 60;
  }
  throw new UsageError({
    what: `cron-install: --interval value '${raw}' missing unit suffix (m for minutes, h for hours)`,
    hint: USAGE,
  });
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
  let template: CronInstallTemplate | undefined;
  let intervalMins: number | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--quiet") {
      quiet = true;
      i += 1;
      continue;
    }
    if (a === "--template") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "cron-install: --template requires a value", hint: USAGE });
      }
      if (!CRON_INSTALL_TEMPLATES.includes(v as never)) {
        throw new UsageError({
          what: `cron-install: --template must be one of ${CRON_INSTALL_TEMPLATES.join("|")} (got: ${v})`,
          hint: USAGE,
        });
      }
      template = v as CronInstallTemplate;
      i += 2;
      continue;
    }
    if (a === "--interval") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "cron-install: --interval requires a value", hint: USAGE });
      }
      intervalMins = parseIntervalToMins(v);
      i += 2;
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
  if (intervalMins !== undefined && template !== "merge-cycle") {
    throw new UsageError({
      what: "cron-install: --interval only meaningful with --template merge-cycle",
      hint: USAGE,
    });
  }
  const out: CronInstallArgs = { quiet };
  if (template !== undefined) out.template = template;
  if (intervalMins !== undefined) out.intervalMins = intervalMins;
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

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
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

  // ADR-088 W7: when `--template merge-cycle` is passed, validate that
  // the team has merger enabled in config — otherwise the install would
  // be a no-op (the merge-cycle line is gated on team.merger.enabled in
  // renderCronLines) and the operator silently has no effect from the
  // flag. Fail-fast with a clear hint at install time.
  if (parsed.template === "merge-cycle" && team.merger?.enabled !== true) {
    throw new ConfigError({
      what: "cron-install --template merge-cycle: requires team.merger.enabled = true in team.json",
      hint: "set `team.merger.enabled: true` (per ADR-088) before installing the merge-cycle cron template",
    });
  }

  const tmuxTmpdir = readTmuxTmpdir(team);
  const rawCurrent = await crontab.read();

  // ADR-133 TR6: idempotent superdoctor → medic rewrite on atmux-managed
  // lines BEFORE the standard install pass. No-op on every current
  // installation (no legacy `atmux superdoctor` cron lines exist today);
  // defensive forward-compat for the deprecation window.
  const migrated = migrateSuperdoctorToMedicCronLines(rawCurrent ?? "");
  if (migrated.migrated > 0) {
    await logSuperdoctorMigration({
      atmuxDir,
      team: team.name,
      count: migrated.migrated,
      stderr,
    });
  }

  const current = migrated.body;
  const opts2: Parameters<typeof installCronBlock>[0] = {
    team,
    atmuxDir,
    atmuxBin,
    current,
  };
  if (tmuxTmpdir !== undefined) opts2.tmuxTmpdir = tmuxTmpdir;
  if (parsed.intervalMins !== undefined) opts2.mergerIntervalOverride = parsed.intervalMins;
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

/** ADR-133 TR6: best-effort append to `~/.atmux/state/cron-rename-migration.log`
 *  when a superdoctor → medic migration fires. Non-fatal: log failures
 *  warn to stderr but don't abort the cron install. */
async function logSuperdoctorMigration(args: {
  atmuxDir: string;
  team: string;
  count: number;
  stderr: (s: string) => void;
}): Promise<void> {
  const logPath = `${args.atmuxDir}/state/cron-rename-migration.log`;
  const stamp = new Date().toISOString();
  const entry = `${stamp} team=${args.team} migrated=${args.count} (atmux superdoctor → atmux medic) per ADR-133 TR6\n`;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, entry, "utf-8");
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    args.stderr(
      `cron-install: superdoctor→medic migration applied (${args.count}) but log write failed (${cause})\n`,
    );
  }
}
