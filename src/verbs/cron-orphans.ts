// ADR-083 follow-up §DEFERRED row 2: `atmux cron-orphans` verb — emit
// a JSON array of `{team, atmux_dir}` for every marker-fenced crontab
// block whose `ATMUX_DIR=` path no longer exists on disk. Doctor
// consumes the same `findCronOrphans` (see `checkCronOrphans` in
// `src/verbs/doctor.ts`) to surface yellow `cron-config` rows for
// moved / deleted projects.
//
// Bash spec: `lib/cron.sh::atmux::cron_orphans` (archive lines 321-380).
// Output shape matches bash exactly so external consumers (cockpit
// aggregators) can stay agnostic of the TS-vs-bash implementation —
// note the snake_case `atmux_dir` key, intentional.
//
// Non-fatal posture (mirrors bash):
// - `crontab` not on PATH       → emit `[]`, exit 0.
// - `crontab -l` returns empty  → emit `[]`, exit 0.
// - All blocks live on disk     → emit `[]`, exit 0.
//
// t-e1247699: `--prune` flag adds one-shot recovery — emits the same
// JSON payload (so cockpit aggregators stay shape-agnostic) AND rewrites
// the host crontab via `pruneCronOrphans`. Read-only default unchanged.

import { statOrNull } from "../abstractions/fs.ts";
import { defaultCrontabIO, type CrontabIO } from "../abstractions/crontab.ts";
import { findCronOrphans, pruneCronOrphans } from "../core/cron.ts";
import { UsageError } from "../errors.ts";

const USAGE = "atmux cron-orphans [--prune]";

export interface CronOrphansOpts {
  /** Defaults to `defaultCrontabIO()`. Tests inject a fake. */
  crontab?: CrontabIO;
  /** Defaults to a `statOrNull`-backed dir check. Tests pin a map. */
  dirExists?: (path: string) => Promise<boolean>;
  /** Defaults to `process.stdout.write`. */
  stdout?: (s: string) => void;
}

export interface ParsedCronOrphansArgs {
  /** `--prune` — strip orphan blocks from the crontab atomically. */
  prune: boolean;
}

/** Pure parser — accepts `--prune`; refuses everything else. */
export function parseCronOrphansArgs(argv: ReadonlyArray<string>): ParsedCronOrphansArgs {
  let prune = false;
  for (const a of argv) {
    if (a === undefined) continue;
    if (a === "--prune") {
      prune = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new UsageError({ what: `cron-orphans: unknown flag: ${a}`, hint: USAGE });
    }
    throw new UsageError({ what: `cron-orphans: unexpected arg: ${a}`, hint: USAGE });
  }
  return { prune };
}

/** Public entry point. Always exit 0 — orphans are informational, not
 *  a hard failure (doctor uses yellow severity). With `--prune`, also
 *  rewrites the host crontab to remove every orphan block (t-e1247699). */
export async function cronOrphans(
  argv: ReadonlyArray<string>,
  opts: CronOrphansOpts = {},
): Promise<number> {
  const parsed = parseCronOrphansArgs(argv);
  const stdout = opts.stdout ?? ((s: string) => void process.stdout.write(s));
  const crontab = opts.crontab ?? defaultCrontabIO();
  const dirExists = opts.dirExists ?? defaultDirExists;

  if (!(await crontab.available())) {
    stdout("[]\n");
    return 0;
  }

  const orphans = parsed.prune
    ? await pruneCronOrphans({ io: crontab, dirExists })
    : await findCronOrphans({ io: crontab, dirExists });
  // Bash JSON shape: `[{"team": "<n>", "atmux_dir": "<p>"}, ...]` — map
  // the internal camelCase `atmuxDir` to the snake_case key consumers
  // expect.
  const payload = orphans.map((o) => ({ team: o.team, atmux_dir: o.atmuxDir }));
  stdout(`${JSON.stringify(payload)}\n`);
  return 0;
}

async function defaultDirExists(p: string): Promise<boolean> {
  const s = await statOrNull(p);
  return s !== null && s.isDirectory;
}
