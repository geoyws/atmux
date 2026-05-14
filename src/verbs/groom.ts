// ADR-068 cutover (Tier 1, P0) — `atmux groom` verb.
//
// Bash port target: lib/groom.sh @ HEAD (frozen ref under
// .archive-bash-atmux-20260507/lib/groom.sh).
//
// Cron-fired daily at 04:00 (cron line registered by src/core/cron.ts):
//
//   0 4 * * * <env> atmux groom --quiet >> .../groom.log 2>&1
//
// Sub-ops live in src/core/groom.ts. This verb adds:
//   - arg parsing (--dry-run / --quiet / --kanban-days / --decisions-days
//     / --keep-bak)
//   - ATMUX_NO_GROOM kill-switch (sandbox + operator override)
//   - flock single-flight on `<atmuxDir>/groom.lock`
//   - per-sub-op error containment (one failing sub-op never aborts the
//     remaining steps; warns surface individually)
//
// USAGE:
//   atmux groom [--dry-run] [--quiet]
//               [--inbox-days N]      # accepted for parity; reserved
//               [--kanban-days N]     # default 30
//               [--decisions-days N]  # default 30
//               [--keep-bak N]        # default 5

import { dirname, join } from "node:path";
import { ensureDir } from "../abstractions/fs.ts";
import { acquireWithTTL } from "../abstractions/lock.ts";
import { getAtmuxDir, stateDir, tryLoadTeam } from "../core/common.ts";
import {
  type ArchiveSizeWarning,
  archiveDecisions,
  archiveSizeCheck,
  type BakCullResult,
  cullBakFiles,
  type DecisionsArchiveResult,
  flushInboxOutboxArchive,
  type InboxOutboxFlushResult,
  type KanbanSummarizeResult,
  summarizeKanban,
} from "../core/groom.ts";
import { groomArchive, type GroomArchiveResult } from "../core/groom-archive.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { LockError, LockTimeoutError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";
import {
  DEFAULT_CLAIMED_AT_THRESHOLD_MIN,
} from "../core/lane-drift.ts";
import {
  type LaneDriftCheckResult,
  runLaneDriftCheck,
} from "./lane-drift-check.ts";

// ---------- Args ----------

export interface ParsedGroomArgs {
  dryRun: boolean;
  quiet: boolean;
  /** Reserved per bash flag set; not yet consumed by any sub-op. */
  inboxDays: number;
  kanbanDays: number;
  decisionsDays: number;
  keepBak: number;
  /** t-8287b37d C1: when set, also archive state.db rows (tasks +
   *  inbox_messages) older than `kanbanDays` into sibling archive.db. */
  archive: boolean;
  /** When true, the verb returns 0 immediately after arg parse. Bash
   *  emits help via `_groom_usage` then `return 0`. */
  showHelp: boolean;
}

const DEFAULTS = {
  inboxDays: 7,
  kanbanDays: 30,
  decisionsDays: 30,
  keepBak: 5,
};

export function parseGroomArgs(args: ReadonlyArray<string>): ParsedGroomArgs {
  let dryRun = false;
  let quiet = false;
  let showHelp = false;
  let archive = false;
  let inboxDays = DEFAULTS.inboxDays;
  let kanbanDays = DEFAULTS.kanbanDays;
  let decisionsDays = DEFAULTS.decisionsDays;
  let keepBak = DEFAULTS.keepBak;

  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--quiet") {
      quiet = true;
      i += 1;
      continue;
    }
    if (a === "--archive") {
      archive = true;
      i += 1;
      continue;
    }
    if (a === "-h" || a === "--help") {
      showHelp = true;
      i += 1;
      continue;
    }
    if (
      a === "--inbox-days" ||
      a === "--kanban-days" ||
      a === "--decisions-days" ||
      a === "--keep-bak"
    ) {
      const val = args[i + 1];
      if (val === undefined) {
        throw new UsageError({
          what: `groom: ${a} requires a value`,
          hint: "see atmux groom --help",
        });
      }
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new UsageError({
          what: `groom: ${a} must be a non-negative integer (got ${val})`,
          hint: "see atmux groom --help",
        });
      }
      switch (a) {
        case "--inbox-days":
          inboxDays = n;
          break;
        case "--kanban-days":
          kanbanDays = n;
          break;
        case "--decisions-days":
          decisionsDays = n;
          break;
        case "--keep-bak":
          keepBak = n;
          break;
      }
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `groom: unknown arg: ${a}`,
      hint: "see atmux groom --help",
    });
  }

  return { dryRun, quiet, archive, inboxDays, kanbanDays, decisionsDays, keepBak, showHelp };
}

// ---------- ATMUX_NO_GROOM kill-switch ----------

/** True when the env var indicates groom should no-op. Mirrors bash:
 *
 *    case "${ATMUX_NO_GROOM:-}" in
 *      ''|0|false|FALSE|False) ;;
 *      *) ... return 0 ;;
 *    esac
 *
 *  i.e. unset / "" / "0" / "false"/"FALSE"/"False" → groom runs;
 *  ANY other value (including "1" / "true") → groom is disabled. */
export function groomDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ATMUX_NO_GROOM;
  if (raw === undefined) return false;
  if (raw === "") return false;
  if (raw === "0") return false;
  if (raw === "false" || raw === "FALSE" || raw === "False") return false;
  return true;
}

// ---------- Verb body ----------

export interface GroomOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  stdout?: Writer;
  /** Test injection — explicit atmux dir. */
  atmuxDir?: string;
  /** Test injection — clock. Defaults to time.now(). */
  nowMs?: number;
  /** ADR-062 §5 follow-up: test injection — pre-loaded team. Skips the
   *  internal `tryLoadTeam` call; useful for tests that don't seed a
   *  `team.json` file. Production callers leave this unset. */
  team?: Team;
  /** ADR-062 §5 follow-up: test injection — substitute for
   *  `runLaneDriftCheck`. Lets tests assert invocation + skip without
   *  loading the real implementation's `git log` / tmux probes. */
  runLaneDriftCheckFn?: typeof runLaneDriftCheck;
}

const USAGE_TEXT = `\
atmux groom — sweep stale state into .atmux/archive/

Usage: atmux groom [flags]

Flags:
  --dry-run                Show what would change; touch nothing.
  --quiet                  Suppress per-step ok/log lines (cron-friendly).
  --inbox-days N           Reserved for future per-entry inbox parsing
                           (currently flushes whole \`## Archive\` section).
  --kanban-days N          Threshold for done/cancelled card summary (default 30).
  --decisions-days N       Threshold for decisions.md entry archival (default 30).
  --keep-bak N             Keep newest N of each .bak.* family (default 5).
  --archive                Also move state.db rows (done tasks + inbox
                           messages older than --kanban-days) into a
                           sibling archive.db. Idempotent. Per t-8287b37d.

Sub-operations (all idempotent):
  1. driver-inbox.md / lead-outbox.md: flush \`## Archive\` body into dated archive.
  2. decisions.md: move entries older than --decisions-days to dated archive.
  3. kanban.json: summarize + remove done/cancelled cards older than --kanban-days.
  4. .bak.* files: keep newest --keep-bak per family.
  5. archive/ size guard: warn if growth exceeds threshold.
  6. lane-drift-check: revert stuck in-progress claims (ADR-062 §5 catch-the-stragglers
     pass; auto-gated on team.json::groom.laneDriftCheck — default true when team has
     lane-tagged members, false to disable). Pairs with the every-2-min cron line for fast
     feedback + the standalone \`atmux lane-drift-check\` verb for ad-hoc invocation.
  7. (--archive) state.db → archive.db row move (tasks + inbox_messages).

Fires daily via cron (04:00) and once on every \`atmux start\`.
`;

export interface GroomResult {
  inboxOutbox: InboxOutboxFlushResult[];
  decisions: DecisionsArchiveResult;
  kanban: KanbanSummarizeResult;
  bakCull: BakCullResult[];
  sizeWarnings: ArchiveSizeWarning[];
  /** ADR-062 §5 follow-up: lane-drift-check sub-op result. `undefined`
   *  when the sub-op was skipped (no team.json / opt-out / no lane-
   *  tagged members). */
  laneDrift?: LaneDriftCheckResult;
  /** t-8287b37d C1: present only when `--archive` was passed. */
  archive?: GroomArchiveResult;
  /** Sub-ops that threw — surfaced as warnings; verb still returns 0. */
  errors: { op: string; message: string }[];
  skippedReason?: "no-groom-env" | "lock-held";
}

/** ADR-062 §5 follow-up. Resolution order for the groom→lane-drift-
 *  check gate:
 *
 *  1. `team.groom.laneDriftCheck === false` → never run.
 *  2. `team.groom.laneDriftCheck === true`  → always run.
 *  3. unset                                  → run iff ≥1 member has a
 *     non-empty `.lane` field.
 *
 *  Matches the auto-shape of `crons.laneTickEnabled` (the every-2-min
 *  cron line — t-727f1f42 sibling): both default-enable on lane presence,
 *  both let operators force-disable without removing `.lane`
 *  annotations from `team.members[]`. */
export function shouldRunLaneDriftCheck(team: Team): boolean {
  const explicit = team.groom?.laneDriftCheck;
  if (explicit === false) return false;
  if (explicit === true) return true;
  return team.members.some((m) => {
    const lane = (m as { lane?: string }).lane;
    return typeof lane === "string" && lane.length > 0;
  });
}

export async function groom(argv: ReadonlyArray<string>, opts: GroomOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const logger = opts.logger ?? createLogger();
  const env = opts.env ?? process.env;

  const parsed = parseGroomArgs(argv);
  if (parsed.showHelp) {
    stdout(USAGE_TEXT);
    return 0;
  }

  if (groomDisabledByEnv(env)) {
    if (env.ATMUX_DEBUG !== undefined && env.ATMUX_DEBUG !== "") {
      logger.log("groom: ATMUX_NO_GROOM set — no-op");
    }
    return 0;
  }

  const atmuxDir =
    opts.atmuxDir ??
    (await getAtmuxDir({
      env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }));

  const result: GroomResult = {
    inboxOutbox: [],
    decisions: { staleBlocks: 0, destPaths: [] },
    kanban: { removed: 0, destPaths: [] },
    bakCull: [],
    sizeWarnings: [],
    errors: [],
  };

  // Single-flight lock on `<atmuxDir>/groom.lock`. Bash uses `flock -n
  // 9` with `exec 9>"$d/groom.lock"` — non-blocking; if held, return 0
  // cleanly (cron + on-activate may fire near-simultaneously). TS port
  // uses `acquireWithTTL` with timeout=0 to mirror the non-blocking
  // semantics, plus the orphaned-lock recovery path inherited from
  // ADR-057 §D3a (free win — bash had no recovery).
  await ensureDir(atmuxDir);
  const lockBase = join(atmuxDir, "groom");
  let handle = null;
  try {
    handle = await acquireWithTTL(lockBase, {
      timeoutMs: 0,
      auditDir: stateDir(atmuxDir),
    });
  } catch (e) {
    if (e instanceof LockTimeoutError || e instanceof LockError) {
      if (!parsed.quiet) {
        logger.log("groom: another run holds the lock — skipping");
      }
      result.skippedReason = "lock-held";
      return 0;
    }
    throw e;
  }

  try {
    // Each sub-op is wrapped — failures surface as warnings; the
    // remaining steps still run. Mirrors bash `|| atmux::warn ...`.
    try {
      result.inboxOutbox = await flushInboxOutboxArchive(atmuxDir, {
        dryRun: parsed.dryRun,
        ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      });
      if (!parsed.quiet) {
        for (const r of result.inboxOutbox) {
          if (parsed.dryRun) {
            logger.log(
              `groom[dry-run]: would flush ${r.file} archive → ${baseName(r.destPath)} (${r.bodyLineCount} lines)`,
            );
          } else {
            logger.ok(`groom: flushed ${r.file} archive → ${baseName(r.destPath)}`);
          }
        }
      }
    } catch (e) {
      logger.warn(`groom: inbox/outbox sub-op failed (continuing): ${errMsg(e)}`);
      result.errors.push({ op: "inbox-outbox", message: errMsg(e) });
    }

    try {
      result.decisions = await archiveDecisions(atmuxDir, {
        days: parsed.decisionsDays,
        dryRun: parsed.dryRun,
        ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      });
      if (!parsed.quiet && result.decisions.staleBlocks > 0) {
        if (parsed.dryRun) {
          logger.log(
            `groom[dry-run]: would archive ${result.decisions.staleBlocks} decisions block(s) into ${result.decisions.destPaths.length} month bucket(s)`,
          );
        } else {
          logger.ok(
            `groom: archived ${result.decisions.destPaths.length} decisions month-bucket(s)`,
          );
        }
      }
    } catch (e) {
      logger.warn(`groom: decisions sub-op failed (continuing): ${errMsg(e)}`);
      result.errors.push({ op: "decisions", message: errMsg(e) });
    }

    try {
      result.kanban = await summarizeKanban(atmuxDir, {
        days: parsed.kanbanDays,
        dryRun: parsed.dryRun,
        ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      });
      if (!parsed.quiet && result.kanban.removed > 0) {
        if (parsed.dryRun) {
          logger.log(
            `groom[dry-run]: would summarize+remove ${result.kanban.removed} done/cancelled cards older than ${parsed.kanbanDays}d`,
          );
        } else {
          logger.ok(`groom: summarized + removed ${result.kanban.removed} stale kanban card(s)`);
        }
      }
    } catch (e) {
      logger.warn(`groom: kanban sub-op failed (continuing): ${errMsg(e)}`);
      result.errors.push({ op: "kanban", message: errMsg(e) });
    }

    try {
      result.bakCull = await cullBakFiles(atmuxDir, {
        keep: parsed.keepBak,
        dryRun: parsed.dryRun,
      });
      if (!parsed.quiet) {
        for (const r of result.bakCull) {
          if (parsed.dryRun) {
            logger.log(
              `groom[dry-run]: would delete ${r.removed.length} stale ${r.family}.bak.* (keeping newest ${parsed.keepBak})`,
            );
          } else {
            logger.ok(`groom: culled ${r.removed.length} stale ${r.family}.bak.*`);
          }
        }
      }
    } catch (e) {
      logger.warn(`groom: bak-cull sub-op failed (continuing): ${errMsg(e)}`);
      result.errors.push({ op: "bak-cull", message: errMsg(e) });
    }

    try {
      result.sizeWarnings = await archiveSizeCheck(atmuxDir);
      for (const w of result.sizeWarnings) {
        if (w.scope === "archive") {
          const mb = Math.floor(w.bytes / 1024 / 1024);
          logger.warn(
            `groom: archive/ at ${mb} MB — consider raising --kanban-days or pruning oldest archive files manually`,
          );
        } else {
          const mb = Math.floor(w.bytes / 1024 / 1024);
          logger.warn(
            `groom: kanban-log archive at ${mb} MB across ${w.fileCount} months — growth check`,
          );
        }
      }
    } catch (e) {
      logger.warn(`groom: size-check sub-op failed (continuing): ${errMsg(e)}`);
      result.errors.push({ op: "size-check", message: errMsg(e) });
    }

    // ADR-062 §5 follow-up: lane-drift-check sub-op (catch-the-stragglers
    // pass). Cron's `*/2` lane-tick line gives real-time drift feedback;
    // this daily groom pass catches drift the cron missed (e.g. host
    // suspended overnight, cron disabled, pane classifier wedged for a
    // window). Sweep before the `--archive` sub-op (which depends on
    // kanban state being finalized) per Task body — drift-check is the
    // slowest piece (one git log + per-task pane probe), so sweep
    // late so partial-run still benefits the cheap flushes above.
    //
    // Sub-op error-contained like the others. Loads team.json via the
    // tryLoadTeam null-on-missing form: missing team.json is treated as
    // "no team config to drive drift-check from" → silent skip, not a
    // crash (groom is cron-fired; a host transient that nukes team.json
    // shouldn't kill the rest of the sweep).
    try {
      const team = opts.team ?? (await tryLoadTeam({ teamDir: dirname(atmuxDir) }));
      if (team === null) {
        if (env.ATMUX_DEBUG !== undefined && env.ATMUX_DEBUG !== "") {
          logger.log("groom: lane-drift-check skipped (no team.json at expected path)");
        }
      } else if (!shouldRunLaneDriftCheck(team)) {
        if (env.ATMUX_DEBUG !== undefined && env.ATMUX_DEBUG !== "") {
          logger.log(
            "groom: lane-drift-check skipped (groom.laneDriftCheck=false or no lane-tagged members)",
          );
        }
      } else {
        const driftFn = opts.runLaneDriftCheckFn ?? runLaneDriftCheck;
        const driftResult = await driftFn(
          atmuxDir,
          team,
          {
            thresholdMin: DEFAULT_CLAIMED_AT_THRESHOLD_MIN,
            commits: 30,
            // Map groom's --dry-run to drift's dry-run; otherwise run
            // in reset-mode (mutate kanban + raise flags). Cron's daily
            // 04:00 invocation never passes --dry-run, so the default
            // production path resets stale claims.
            reset: !parsed.dryRun,
            dryRun: parsed.dryRun,
          },
          {},
        );
        result.laneDrift = driftResult;
        if (!parsed.quiet) {
          if (parsed.dryRun) {
            logger.log(
              `groom[dry-run]: would lane-drift-check ${driftResult.scanned} in-progress task(s) — ` +
                `${driftResult.decisions.filter((d) => d.action === "revert").length} revert candidate(s)`,
            );
          } else if (driftResult.reverted > 0 || driftResult.flagsRaised > 0) {
            logger.ok(
              `groom: lane-drift-check reverted ${driftResult.reverted} stuck claim(s), raised ${driftResult.flagsRaised} flag(s)`,
            );
          } else if (driftResult.scanned > 0) {
            logger.ok(
              `groom: lane-drift-check scanned ${driftResult.scanned} in-progress task(s) — no drift`,
            );
          }
        }
      }
    } catch (e) {
      logger.warn(`groom: lane-drift-check sub-op failed (continuing): ${errMsg(e)}`);
      result.errors.push({ op: "lane-drift-check", message: errMsg(e) });
    }

    // t-8287b37d C1: state.db → archive.db row move. Opt-in via
    // --archive; runs last so any earlier sub-op failures (which
    // surfaced as warnings, not aborts) don't pollute the archive
    // with rows that should have been rewritten by an earlier step.
    if (parsed.archive) {
      try {
        const ar = await groomArchive(atmuxDir, {
          days: parsed.kanbanDays,
          dryRun: parsed.dryRun,
          ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
        });
        result.archive = ar;
        if (!parsed.quiet && (ar.tasksArchived > 0 || ar.inboxArchived > 0)) {
          const verb = parsed.dryRun ? "would archive" : "archived";
          logger.ok(
            `groom: ${verb} ${ar.tasksArchived} task(s) + ${ar.inboxArchived} inbox row(s) (state.db → archive.db, cutoff=${parsed.kanbanDays}d)`,
          );
        }
      } catch (e) {
        logger.warn(`groom: archive sub-op failed (continuing): ${errMsg(e)}`);
        result.errors.push({ op: "archive", message: errMsg(e) });
      }
    }
  } finally {
    if (handle !== null) await handle.release();
  }

  return 0;
}

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
