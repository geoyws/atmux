import { type CrontabIO, defaultCrontabIO } from "../../abstractions/crontab.ts";
import { exists, readTextOrNull, statOrNull } from "../../abstractions/fs.ts";
import { resolveDayFilePath } from "../../abstractions/release-notes.ts";
import { mytDate, now } from "../../abstractions/time.ts";
import { teamJsonPath } from "../../core/common.ts";
import { type CronBlockTarget, findCronOrphans } from "../../core/cron.ts";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  type DriftReport,
} from "../../core/whip-config-drift.ts";
import { type Team, Team as TeamSchema } from "../../schema/team.ts";
import { type DoctorRow, type GitSpawn, defaultGitSpawn } from "./types.ts";

// ---------- ADR-054 §D4: whip-config-drift ----------

/**
 * Re-runs the same Zod safe-parse the whip tick performs and surfaces
 * any drift as a P3 (yellow) finding. Operator gets the drift signal
 * via `atmux doctor` immediately rather than waiting up to 5min for the
 * next whip tick.
 *
 * Returns no rows when team.json is absent — `checkTeam` already emits
 * the absent-file finding and we'd otherwise double-report.
 */

export async function checkWhipConfigDrift(atmuxDir: string): Promise<DoctorRow[]> {
  const path = teamJsonPath(atmuxDir);
  const raw = await readTextOrNull(path);
  if (raw === null) return [];

  let driftReport: DriftReport | null = null;
  try {
    const parsed = JSON.parse(raw);
    const result = TeamSchema.safeParse(parsed);
    if (!result.success) {
      driftReport = composeDriftReport(result.error, raw);
    }
  } catch (e) {
    driftReport = composeCatastrophicDrift(e, raw);
  }
  if (driftReport === null) return [];

  const issuesCount = driftReport.issues.length;
  const first = driftReport.issues[0];
  const firstSummary =
    first === undefined
      ? ""
      : ` first: ${first.path.length === 0 ? "<root>" : first.path.join(".")} (${first.code})`;
  return [
    {
      status: "yellow",
      label: "poke-config-drift",
      detail: driftReport.catastrophic
        ? `team.json malformed — poke will use full safe defaults${firstSummary}`
        : `team.json::whip validation failed — ${issuesCount} issue(s)${firstSummary}`,
      hint: "edit team.json + re-run atmux doctor (per ADR-054)",
    },
  ];
}

// ---------- ADR-079 §A: cron-interval-divisor ----------

/**
 * ADR-079 §A — surface non-divisor / out-of-range cron interval config
 * at config-load time as yellow rows, BEFORE `atmux start` trips
 * `cronEvery`'s render-time throw. Operator-friendly preview of what
 * would otherwise be a hard fail.
 *
 * Checked fields:
 *   - team.whip.intervalMins (divisor of 60, 1–60)
 *   - team.report.intervalMins (divisor of 60, 1–60)
 *   - team.report.heartbeatHours (divisor of 24, 1–24)
 *   - team.decisions.intervalHours (divisor of 24, 1–24)
 *   - team.groom.atHour (0–23)
 *   - team.unblocker.intervalMins (divisor of 60, 1–60)
 *
 * One row per offender. No rows when team is null or every value is
 * within range + a divisor.
 */

export function checkCronIntervalDivisors(team: Team | null): DoctorRow[] {
  if (team === null) return [];
  const rows: DoctorRow[] = [];

  const checkMinutes = (label: string, minutes: number | undefined): void => {
    if (minutes === undefined) return;
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 60) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${minutes} out of range (1–60)`,
        hint: "edit team.json — atmux start will fail at cron render time",
      });
      return;
    }
    if (minutes !== 60 && 60 % minutes !== 0) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${minutes} not a divisor of 60 — cron skew expected`,
        hint: "use one of: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60",
      });
    }
  };

  const checkHours = (label: string, hours: number | undefined): void => {
    if (hours === undefined) return;
    if (!Number.isInteger(hours) || hours <= 0 || hours > 24) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${hours} out of range (1–24)`,
        hint: "edit team.json — atmux start will fail at cron render time",
      });
      return;
    }
    if (hours !== 24 && hours !== 1 && 24 % hours !== 0) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${hours} not a divisor of 24 — cron skew expected`,
        hint: "use one of: 1, 2, 3, 4, 6, 8, 12, 24",
      });
    }
  };

  const checkHourOfDay = (label: string, hour: number | undefined): void => {
    if (hour === undefined) return;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${hour} out of range (0–23)`,
        hint: "edit team.json — atmux start will fail at cron render time",
      });
    }
  };

  checkMinutes("whip.intervalMins", team.whip?.intervalMins);
  checkMinutes("report.intervalMins", team.report?.intervalMins);
  checkHours("report.heartbeatHours", team.report?.heartbeatHours);
  checkHours("decisions.intervalHours", team.decisions?.intervalHours);
  checkHourOfDay("groom.atHour", team.groom?.atHour);
  checkMinutes("unblocker.intervalMins", team.unblocker?.intervalMins);

  return rows;
}

// ---------- ADR-083 follow-up §DEFERRED row 2: cron-orphans ----------

/**
 * DI surface — `findCronOrphans` already takes its IO seam + dirExists
 * predicate; we just thread defaults the same way as the verb does so
 * tests can pin both sides via the doctor entry point too.
 */

export interface CheckCronOrphansOpts {
  /** Defaults to `defaultCrontabIO()`. */
  crontab?: CrontabIO;
  /** Defaults to `statOrNull`-backed dir check. */
  dirExists?: (path: string) => Promise<boolean>;
}

/**
 * ADR-083 follow-up §DEFERRED row 2 (paired with `atmux cron-orphans`
 * verb in `src/verbs/cron-orphans.ts`): surface marker-fenced crontab
 * blocks whose `ATMUX_DIR=<path>` no longer exists on disk. Emits one
 * `cron-config` yellow row per orphan (label + team + path); empty
 * when host has no crontab, no crontab blocks, or every block's dir
 * is alive.
 *
 * Operator-facing fix: `crontab -e` to drop the orphan block, or
 * restore the missing dir if the project simply moved.
 */

export async function checkCronOrphans(opts: CheckCronOrphansOpts = {}): Promise<DoctorRow[]> {
  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) return [];
  const dirExists = opts.dirExists ?? defaultDirExistsForCron;
  const orphans = await findCronOrphans({ io: crontab, dirExists });
  return orphans.map((o: CronBlockTarget) => ({
    status: "yellow" as const,
    label: "cron-config",
    detail: `orphan cron block: team='${o.team}' atmux_dir='${o.atmuxDir}' (path does not exist)`,
    hint: `crontab -e to drop the block, or restore ${o.atmuxDir} if the project moved`,
  }));
}

async function defaultDirExistsForCron(p: string): Promise<boolean> {
  const s = await statOrNull(p);
  return s !== null && s.isDirectory;
}

// ---------- t-dcbff97c: cron-block:missing — team has no managed block in host crontab ----------

export interface CheckCronBlockOpts {
  /** Defaults to `defaultCrontabIO()`. Tests inject a fake. */
  crontab?: CrontabIO;
}

/**
 * t-dcbff97c §2 — RED finding when a team that opts into cron auto-install
 * has no marker-fenced block in the host crontab. The atmux team died
 * three consecutive overnights because `atmux start` reported success
 * but the cron block was absent; doctor missed it, so the only signal
 * was the silently-stalled lead the morning after.
 *
 * **2026-05-24 post-ADR-233**: cron auto-install retired (orchd is the
 * runtime via Honker substrate). The probe now expects ZERO cron blocks
 * by default — `team.kanban.cronAutoInstall === false` is the canonical
 * post-cutover state and this probe is silent. The check is retained
 * for the deprecation window so teams that explicitly opt back in (via
 * `atmux cron-install`) get the safety net.
 *
 * Returns:
 * - `[]` when team is null (the team-shape row already surfaced).
 * - `[]` when `team.kanban.cronAutoInstall === false` — explicit opt-out
 *    (canonical post-ADR-233 state) or operator manages cron some other way.
 * - `[]` when `crontab` is not on the host (no PATH match); ADR-083
 *    posture is "skip gracefully on cron-less hosts."
 * - `[]` when the team's marker header (`# >>> atmux:team=<name> …`) is
 *    present anywhere in the current crontab.
 * - one RED row otherwise, hinting `atmux cron-install` (legacy path).
 *
 * RED (not YELLOW) because pre-ADR-233 the failure mode was overnight
 * team death — a GREEN doctor that hid a missing cron block was worse
 * than a noisy one. Post-ADR-233 the trigger is opt-in, so the row is
 * actionable only for operators who explicitly armed cron.
 */

export async function checkCronBlock(
  team: Team | null,
  opts: CheckCronBlockOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  // Honor explicit opt-out — mirror `start.ts::shouldAutoInstallCron`
  // semantics so doctor + start stay in lockstep on the gating decision.
  const kanban = (team as { kanban?: { cronAutoInstall?: boolean } }).kanban;
  if (kanban?.cronAutoInstall === false) return [];

  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) return [];

  const current = (await crontab.read()) ?? "";
  // Match the exact marker header rendered by `renderCronBlock` so a
  // similarly-named team can't false-pass on a substring brush-by.
  const header = `# >>> atmux:team=${team.name} — managed by atmux start; do not edit by hand`;
  if (current.includes(header)) return [];

  return [
    {
      status: "red",
      label: "cron-block:missing",
      detail: `no managed atmux:team=${team.name} block in host crontab — whip / report / decisions / groom won't fire`,
      hint: "run `atmux cron-install` (or re-run `atmux start`) — block uses ATMUX_DIR + optional TMUX_TMPDIR so worktree-isolation is safe",
    },
  ];
}

// ---------- ADR-147 §D5 T6: release-note-missing probe (warn, NOT block) ----------

/** Test-injection seam for {@link checkReleaseNoteMissing}. */

export interface CheckReleaseNoteMissingOpts {
  /** Git spawn override (test injection). Default uses `defaultGitSpawn`. */
  gitSpawn?: GitSpawn;
  /** Clock override (test injection). Defaults to `now()` from `time.ts`
   *  — which itself honours `setNow()` for clock-pinned tests. */
  now?: () => number;
  /** Repo root override (test injection). Default `process.cwd()` —
   *  matches the convention `defaultGitSpawn` uses (commands run from
   *  the caller's cwd) so the day-file path lookup sees the same tree
   *  the git probe interrogates. */
  repoRoot?: string;
}

/**
 * ADR-147 §D5 backstop probe — emit a yellow row when today (MYT) has
 * ≥1 commit on the current branch AND the day's release-notes file
 * does not exist yet. Warn class only; never blocks. The expected
 * pattern is that gitter / hygiene-tick / ombudsman creates the file
 * on the first event of the day; this probe surfaces missed days so
 * the ombudsman can backfill.
 *
 * Failure mode tolerance — every error path degrades silently:
 *   - `git log` exit != 0 (not in a repo, no `.git`, permission)  → []
 *   - `git log` stdout empty (no commits today)                   → []
 *   - day-file exists on disk                                     → []
 *   - day-file missing despite today's commit                     → [yellow]
 *
 * Why silent-on-error: `atmux doctor` runs in many environments
 * (deployed cages, CI agents, build hosts). A spurious red/yellow row
 * because git isn't available isn't actionable for the operator;
 * better to skip the probe and let other rows surface the real
 * config issue.
 *
 * The `--since` argument is anchored on MYT midnight via the ISO-8601
 * `+08:00` offset (`YYYY-MM-DDT00:00:00+08:00`). Git parses this
 * directly — no need for a TZ env variable override. Date boundary
 * tests exercise the 23:00 MYT / 15:00 UTC edge where the previous
 * day's commit is also today's commit until 00:00 MYT.
 */

export async function checkReleaseNoteMissing(
  opts: CheckReleaseNoteMissingOpts = {},
): Promise<DoctorRow[]> {
  const git = opts.gitSpawn ?? defaultGitSpawn;
  const nowFn = opts.now ?? now;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const epochMs = nowFn();

  // Compute today's MYT midnight as an ISO-8601 timestamp with explicit
  // +08:00 offset. Git's `--since` parser accepts this format directly.
  const { iso: todayIso } = mytDate(epochMs);
  const sinceArg = `${todayIso}T00:00:00+08:00`;

  // `git log --since=<X> --format=%H -1` — exit code 0 + empty stdout
  // means no commits since X; exit code 0 + one line means there's at
  // least one. `-C <repoRoot>` so the probe is decoupled from the
  // caller's actual cwd (test-injection clean).
  const r = await git(["-C", repoRoot, "log", `--since=${sinceArg}`, "--format=%H", "-1"]);
  if (r.exitCode !== 0) return []; // not a repo / no .git / permission
  if (r.stdout.trim() === "") return []; // no commits today (MYT)

  // Day-file path lookup. T5's `resolveDayFilePath` returns the absolute
  // path; we check `exists()` to gate the row.
  const dayPath = resolveDayFilePath(epochMs, { repoRoot });
  if (await exists(dayPath)) return []; // file present — silent

  // Today has commits but no day-file. Yellow row + actionable hint.
  // Strip the repoRoot prefix from the displayed path so the detail
  // line is short + grep-friendly.
  const relPath = dayPath.startsWith(`${repoRoot}/`) ? dayPath.slice(repoRoot.length + 1) : dayPath;
  return [
    {
      status: "yellow",
      label: "release-note-missing",
      detail: `${relPath} — today (${todayIso} MYT) has commits but day-file absent`,
      hint:
        "ombudsman / gitter / hygiene-tick should auto-create on the day's first event; " +
        "backfill manually via `ensureDayFile(...)` from src/abstractions/release-notes.ts",
    },
  ];
}
