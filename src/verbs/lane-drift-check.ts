// ADR-062 §Decision (5) + §OQ5: `atmux lane-drift-check` verb wrapper.
//
// Heavyweight scan (one git-log per call + one pane-classify per
// in-progress Task), so it does NOT join the lane-tick `*/2 *` cron
// line — runs at most daily, hand-fired or cron'd via the team's
// preferred cadence. The eventual home is `atmux groom` (per ADR-062
// §"BE lane"); ports as a stand-alone verb today so it's available
// before groom lands.
//
// Loads in-progress Tasks via `core/kanban.listTasks`, builds a
// classifyMember probe via the team-tmux abstraction (mirroring
// `verbs/pane-state.ts::paneStateWithTmux`), fetches recent commits
// via `git log`, calls the pure helper `core/lane-drift.checkLaneDrift`,
// and acts on each "revert" decision IFF `--reset` is passed:
//
//   - Mutate: `kanban.moveTask(id, "todo")`.
//   - Surface: append a flag entry to `<atmuxDir>/flags.md` with the
//     pre-formatted body from the helper.
//
// `--dry-run` (default OFF — caller must choose) prints the decisions
// + flag bodies to stdout without mutating. Cron-fired invocation
// passes `--reset`.

import { join } from "node:path";
import { appendText } from "../abstractions/fs.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { listTasks, moveTask } from "../core/kanban.ts";
import {
  checkLaneDrift,
  DEFAULT_CLAIMED_AT_THRESHOLD_MIN,
  type DriftDecision,
  formatDurationCompact,
} from "../core/lane-drift.ts";
import { classifyText, maybeLogUnknownPane, type PaneClassification } from "../core/pane-state.ts";
import { UsageError } from "../errors.ts";
import type { KanbanTask } from "../schema/kanban.ts";
import type { Team } from "../schema/team.ts";

const USAGE =
  "atmux lane-drift-check [--threshold-min <n>] [--commits <n>] [--dry-run] [--reset] [--team-dir <dir>]";

const DEFAULT_COMMITS_TO_SCAN = 30;

// ---------- Public types (test-injectable deps) ----------

export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;
export type ClassifyMember = (memberName: string) => Promise<PaneClassification | null>;
/** Mutator hook — moves a Task back to status="todo". Defaults to
 *  `core/kanban.moveTask`. Tests inject a recorder. */
export type MoveTaskFn = (atmuxDir: string, id: string, status: string) => Promise<void>;
/** Append the formatted flag entry. Defaults to `appendText`-to-flags.md.
 *  No `flag` verb exists yet in the bun port; this matches the bash
 *  `lib/flags.sh` precedent of writing markdown to `flags.md`. */
export type RaiseFlag = (atmuxDir: string, body: string) => Promise<void>;

export interface LaneDriftCheckDeps {
  /** Override classifyMember for tests — bypasses tmux entirely. */
  classifyMember?: ClassifyMember;
  /** Pre-built tmux namespace; defaults to `createTmux({ socketPath:
   *  resolveTeamSocket(team) })`. */
  tmux?: TmuxNamespace;
  /** Git spawn override; defaults to `spawn` with `cmd: "git"`. */
  git?: GitSpawn;
  /** Override task move — defaults to `core/kanban.moveTask`. */
  moveTask?: MoveTaskFn;
  /** Override flag-raise — defaults to appending to flags.md. */
  raiseFlag?: RaiseFlag;
  /** Override `listTasks` — tests inject in-flight task fixtures
   *  without touching the kanban DB. */
  listInProgressTasks?: (atmuxDir: string) => Promise<ReadonlyArray<KanbanTask>>;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
  /** Clock override (epoch seconds). Defaults to `Math.floor(Date.now()/1000)`. */
  nowSec?: () => number;
}

export interface LaneDriftCheckResult {
  decisions: DriftDecision[];
  reverted: number;
  flagsRaised: number;
  scanned: number;
}

// ---------- Verb entrypoint ----------

interface ParsedArgs {
  thresholdMin: number;
  commits: number;
  reset: boolean;
  dryRun: boolean;
  teamDir?: string;
}

export function parseLaneDriftCheckArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let thresholdMin = DEFAULT_CLAIMED_AT_THRESHOLD_MIN;
  let commits = DEFAULT_COMMITS_TO_SCAN;
  let reset = false;
  let dryRun = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--threshold-min") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "lane-drift-check: --threshold-min requires a value",
          hint: USAGE,
        });
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `lane-drift-check: --threshold-min: bad value: ${v}`,
          hint: USAGE,
        });
      }
      thresholdMin = Math.floor(n);
      i += 2;
      continue;
    }
    if (a === "--commits") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "lane-drift-check: --commits requires a value", hint: USAGE });
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({ what: `lane-drift-check: --commits: bad value: ${v}`, hint: USAGE });
      }
      commits = Math.floor(n);
      i += 2;
      continue;
    }
    if (a === "--reset") {
      reset = true;
      i += 1;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "lane-drift-check: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `lane-drift-check: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  if (reset && dryRun) {
    throw new UsageError({
      what: "lane-drift-check: --reset and --dry-run are mutually exclusive",
      hint: USAGE,
    });
  }
  const out: ParsedArgs = { thresholdMin, commits, reset, dryRun };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * `atmux lane-drift-check`. Returns 0 on completion. Default mode is
 * "report-only" (neither `--reset` nor `--dry-run`) — print the
 * decisions, mutate nothing. `--reset` performs the revert + flag
 * raise. `--dry-run` is the explicit no-mutation form (same output as
 * report-only but flagged in the summary).
 */
export async function laneDriftCheck(
  argv: ReadonlyArray<string>,
  deps: LaneDriftCheckDeps = {},
): Promise<number> {
  const parsed = parseLaneDriftCheckArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const result = await runLaneDriftCheck(
    atmuxDir,
    team,
    {
      thresholdMin: parsed.thresholdMin,
      commits: parsed.commits,
      reset: parsed.reset,
      dryRun: parsed.dryRun,
    },
    deps,
  );

  // Stdout summary — single line + per-decision details.
  const log = deps.log ?? defaultLog;
  const mode = parsed.reset ? "reset" : parsed.dryRun ? "dry-run" : "report";
  log(
    `lane-drift-check: mode=${mode} scanned=${result.scanned} ` +
      `reverted=${result.reverted} flags=${result.flagsRaised}`,
  );
  for (const d of result.decisions) {
    if (d.action === "revert") {
      log(`lane-drift-check: REVERT ${d.taskId} ← ${d.member} :: ${d.flagBody ?? ""}`);
    } else {
      const dur =
        d.evidence.claimedAgoMin === null
          ? "?min"
          : formatDurationCompact(d.evidence.claimedAgoMin);
      log(`lane-drift-check: skip ${d.taskId} (${d.reason ?? "?"}) member=${d.member} age=${dur}`);
    }
  }
  return 0;
}

/**
 * Inner driver — exposed for unit tests (no argv parse, no
 * requireTeam / getAtmuxDir IO). Drives the helper through real or
 * injected deps and performs the action-side mutations when reset==true.
 *
 * The function is cron-friendly: per-decision mutation errors log + are
 * surfaced in the result count, but never abort the loop. A failure to
 * raise a flag does NOT block the kanban revert (the revert is the
 * primary action; the flag is observability).
 */
export async function runLaneDriftCheck(
  atmuxDir: string,
  team: Team,
  opts: {
    thresholdMin: number;
    commits: number;
    reset: boolean;
    dryRun: boolean;
  },
  deps: LaneDriftCheckDeps = {},
): Promise<LaneDriftCheckResult> {
  const log = deps.log ?? defaultLog;
  const nowSec = deps.nowSec ?? ((): number => Math.floor(Date.now() / 1000));
  const moveFn = deps.moveTask ?? moveTask;
  const flagFn = deps.raiseFlag ?? defaultRaiseFlag;
  const git = deps.git ?? defaultGitSpawn;
  const tmux =
    deps.tmux ??
    (deps.classifyMember === undefined
      ? createTmux({ socketPath: resolveTeamSocket(team) })
      : undefined);

  const inFlightLister =
    deps.listInProgressTasks ??
    (async (dir: string): Promise<ReadonlyArray<KanbanTask>> =>
      await listTasks(dir, { status: "in-progress" }));
  const inProgressTasks = await inFlightLister(atmuxDir);

  // Build classifyMember probe: pane-state via tmux, scoped to the
  // team session. Skips members not in team.json (returns null —
  // helper treats null as criterion-(b) fail). Mirrors lane-tick's
  // capture+classify pattern (verbs/lane-tick.ts:152-161) — keeps the
  // tmux dependency minimal so this verb stays compatible across
  // common.ts evolutions.
  const sessionName = await getSessionName({ dir: atmuxDir, team });
  const classifyMember: ClassifyMember =
    deps.classifyMember ??
    (async (memberName: string): Promise<PaneClassification | null> => {
      const memberEntry = team.members.find((m) => m.name === memberName);
      if (memberEntry === undefined || tmux === undefined) return null;
      const windowName = buildWindowName(memberEntry.name, memberEntry.emoji, memberEntry.label, memberEntry.role);
      const target = `${sessionName}:${windowName}`;
      try {
        const text = await tmux.pane.capturePane({ target, start: -30 });
        const classification = classifyText(text);
        // t-e89c03f7: opt-in UNKNOWN-state forensic logging. Gated on
        // `team.observability.paneStateUnknownLog === true`; default-off
        // teams pay zero (gate returns immediately). Best-effort —
        // append failures never block the classify path.
        await maybeLogUnknownPane({
          team: team as { observability?: { paneStateUnknownLog?: boolean } },
          atmuxDir,
          target,
          text,
          capturedAt: classification.capturedAt,
          appendFn: appendText,
          now: () => Date.now(),
        });
        return classification;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`lane-drift-check: classify(${memberName}) error: ${msg}`);
        return null;
      }
    });

  // Fetch recent commits — concatenated subject+body of the last N.
  // Failure-tolerant: on `git log` failure (not a repo, etc.) we fall
  // through with empty text; criterion (c) defaults to "no ref found",
  // which is the conservative choice. The helper documents commitsScanned
  // so operators can spot the diagnostic ("scanned=0 → git log failed").
  let recentCommitsText = "";
  let commitsScanned = 0;
  try {
    const r = await git(["log", `-${opts.commits}`, "--format=%H%n%s%n%b%n--END--"]);
    if (r.exitCode === 0) {
      recentCommitsText = r.stdout;
      // Each commit ends in `--END--\n` — count the markers.
      commitsScanned = (r.stdout.match(/^--END--$/gm) ?? []).length;
    } else {
      log(`lane-drift-check: git log exit=${r.exitCode}: ${r.stderr.trim()}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`lane-drift-check: git log error: ${msg}`);
  }

  // Drive the pure helper.
  const decisions = await checkLaneDrift({
    inProgressTasks,
    classifyMember,
    recentCommitsText,
    commitsScanned,
    nowSec: nowSec(),
    claimedAtThresholdMin: opts.thresholdMin,
  });

  let reverted = 0;
  let flagsRaised = 0;
  for (const d of decisions) {
    if (d.action !== "revert") continue;
    if (!opts.reset) continue; // dry-run + report-only: never mutate.
    try {
      await moveFn(atmuxDir, d.taskId, "todo");
      reverted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`lane-drift-check: moveTask(${d.taskId}) error: ${msg}`);
      // Skip flag too — the revert didn't actually happen.
      continue;
    }
    if (d.flagBody !== undefined) {
      try {
        await flagFn(atmuxDir, d.flagBody);
        flagsRaised++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`lane-drift-check: raiseFlag(${d.taskId}) error: ${msg}`);
      }
    }
  }

  return {
    decisions,
    reverted,
    flagsRaised,
    scanned: inProgressTasks.length,
  };
}

// ---------- Defaults ----------

/** Default git spawner — wraps `abstractions/spawn.spawn` with `git`
 *  + 30s timeout + accept-any-status. Mirrors `core/auto-push.ts`. */
const defaultGitSpawn: GitSpawn = async (argv) =>
  await defaultSpawn({
    cmd: "git",
    argv,
    timeoutMs: 30_000,
    expectExitCode: "any",
  });

/** Default flag-raise — append a markdown line to `<atmuxDir>/flags.md`.
 *  Best-effort: matches the bash `lib/flags.sh` precedent of writing to
 *  flags.md. Once the `flag` verb ports, this default can wire into it
 *  for severity / dedup / Discord ping. */
async function defaultRaiseFlag(atmuxDir: string, body: string): Promise<void> {
  const path = join(atmuxDir, "flags.md");
  // One-line entry under the convention shared with bash flags.md:
  // append-only, markdown bullet, body verbatim. Caller pre-formatted
  // via core/lane-drift.formatFlagBody.
  await appendText(path, `- ${body}\n`);
}

function defaultLog(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
