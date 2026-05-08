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

import { stateDir, getAtmuxDir } from "../core/common.ts";
import {
  archiveDecisions,
  archiveSizeCheck,
  cullBakFiles,
  flushInboxOutboxArchive,
  summarizeKanban,
  type ArchiveSizeWarning,
  type BakCullResult,
  type DecisionsArchiveResult,
  type InboxOutboxFlushResult,
  type KanbanSummarizeResult,
} from "../core/groom.ts";
import { acquireWithTTL } from "../abstractions/lock.ts";
import { ensureDir } from "../abstractions/fs.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { LockError, LockTimeoutError, UsageError } from "../errors.ts";
import { join } from "node:path";

// ---------- Args ----------

export interface ParsedGroomArgs {
  dryRun: boolean;
  quiet: boolean;
  /** Reserved per bash flag set; not yet consumed by any sub-op. */
  inboxDays: number;
  kanbanDays: number;
  decisionsDays: number;
  keepBak: number;
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

  return { dryRun, quiet, inboxDays, kanbanDays, decisionsDays, keepBak, showHelp };
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

Sub-operations (all idempotent):
  1. driver-inbox.md / lead-outbox.md: flush \`## Archive\` body into dated archive.
  2. decisions.md: move entries older than --decisions-days to dated archive.
  3. kanban.json: summarize + remove done/cancelled cards older than --kanban-days.
  4. .bak.* files: keep newest --keep-bak per family.
  5. archive/ size guard: warn if growth exceeds threshold.

Fires daily via cron (04:00) and once on every \`atmux start\`.
`;

export interface GroomResult {
  inboxOutbox: InboxOutboxFlushResult[];
  decisions: DecisionsArchiveResult;
  kanban: KanbanSummarizeResult;
  bakCull: BakCullResult[];
  sizeWarnings: ArchiveSizeWarning[];
  /** Sub-ops that threw — surfaced as warnings; verb still returns 0. */
  errors: { op: string; message: string }[];
  skippedReason?: "no-groom-env" | "lock-held";
}

export async function groom(
  argv: ReadonlyArray<string>,
  opts: GroomOptions = {},
): Promise<number> {
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
            logger.ok(
              `groom: flushed ${r.file} archive → ${baseName(r.destPath)}`,
            );
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
          logger.ok(
            `groom: summarized + removed ${result.kanban.removed} stale kanban card(s)`,
          );
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
            logger.ok(
              `groom: culled ${r.removed.length} stale ${r.family}.bak.*`,
            );
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
