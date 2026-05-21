// ADR-068 cutover (Tier 1, P0) — `atmux cleanup` verb.
//
// Bash port target: lib/cleanup.sh @ HEAD (frozen ref under
// .archive-bash-atmux-20260507/lib/cleanup.sh).
//
// USAGE:
//   atmux cleanup logs    [--max-size <bytes>] [--dry-run]
//   atmux cleanup inboxes [--max-age-days <N>] [--purge-legacy] [--dry-run]
//   atmux cleanup all     [<flags>]
//
// `all` = `logs` followed by `inboxes` with the same arg vector. Flags
// not relevant to a sub-op are tolerated (logs ignores --max-age-days,
// inboxes ignores --max-size) — bash parity. Idempotent + cron-safe.
//
// Operator-driven (not yet cron-fired); paves the way for an automatic
// schedule without behaviour change.

import {
  type InboxPruneResult,
  type LogRotationResult,
  type PurgeLegacyInboxesResult,
  pruneInboxes,
  purgeLegacyInboxes,
  rotateLogs,
} from "../core/cleanup.ts";
import { getAtmuxDir } from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";

// ---------- Args ----------

export type CleanupSub = "logs" | "inboxes" | "all";

export interface ParsedCleanupArgs {
  sub: CleanupSub;
  maxBytes?: number;
  maxAgeDays?: number;
  dryRun: boolean;
  purgeLegacy: boolean;
}

const VALID_SUBS = new Set<string>(["logs", "inboxes", "all"]);

export function parseCleanupArgs(args: ReadonlyArray<string>): ParsedCleanupArgs {
  if (args.length === 0) {
    throw new UsageError({
      what: "cleanup: missing subcommand",
      hint: "use logs | inboxes | all",
    });
  }
  const sub = args[0] ?? "";
  if (!VALID_SUBS.has(sub)) {
    throw new UsageError({
      what: `cleanup: unknown subcommand: ${sub}`,
      hint: "use logs | inboxes | all",
    });
  }
  let dryRun = false;
  let purgeLegacy = false;
  let maxBytes: number | undefined;
  let maxAgeDays: number | undefined;

  let i = 1;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--purge-legacy") {
      purgeLegacy = true;
      i += 1;
      continue;
    }
    if (a === "--max-size") {
      const val = args[i + 1];
      if (val === undefined) {
        throw new UsageError({
          what: "cleanup: --max-size requires a value",
          hint: "see atmux help",
        });
      }
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new UsageError({
          what: `cleanup: --max-size must be a non-negative integer (got ${val})`,
          hint: "see atmux help",
        });
      }
      maxBytes = n;
      i += 2;
      continue;
    }
    if (a === "--max-age-days") {
      const val = args[i + 1];
      if (val === undefined) {
        throw new UsageError({
          what: "cleanup: --max-age-days requires a value",
          hint: "see atmux help",
        });
      }
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `cleanup: --max-age-days must be a positive integer (got ${val})`,
          hint: "see atmux help",
        });
      }
      maxAgeDays = n;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `cleanup ${sub}: unknown arg: ${a}`,
      hint: "see atmux help",
    });
  }

  const out: ParsedCleanupArgs = { sub: sub as CleanupSub, dryRun, purgeLegacy };
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  if (maxAgeDays !== undefined) out.maxAgeDays = maxAgeDays;
  return out;
}

// ---------- Verb body ----------

export interface CleanupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  stdout?: Writer;
  atmuxDir?: string;
  nowMs?: number;
}

export interface CleanupResult {
  logs?: LogRotationResult;
  inboxes?: InboxPruneResult;
  legacyInboxes?: PurgeLegacyInboxesResult;
}

export async function cleanup(
  argv: ReadonlyArray<string>,
  opts: CleanupOptions = {},
): Promise<number> {
  const _stdout = opts.stdout ?? defaultStdoutWrite;
  const logger = opts.logger ?? createLogger();
  const env = opts.env ?? process.env;
  const parsed = parseCleanupArgs(argv);

  const atmuxDir =
    opts.atmuxDir ??
    (await getAtmuxDir({
      env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    }));

  const out: CleanupResult = {};

  if (parsed.sub === "logs" || parsed.sub === "all") {
    const opts1: { maxBytes?: number; dryRun?: boolean } = {
      dryRun: parsed.dryRun,
    };
    if (parsed.maxBytes !== undefined) opts1.maxBytes = parsed.maxBytes;
    out.logs = await rotateLogs(atmuxDir, opts1);
    if (parsed.dryRun) {
      logger.ok(
        `cleanup logs (dry-run): ${out.logs.rotated.length} would rotate, ${out.logs.skipped} under cap`,
      );
    } else {
      for (const r of out.logs.rotated) {
        logger.log(`cleanup logs: rotated ${r.path} → ${r.path}.1 (${r.size} bytes)`);
      }
      logger.ok(
        `cleanup logs: ${out.logs.rotated.length} rotated, ${out.logs.skipped} under cap (cap=${out.logs.capBytes}B)`,
      );
    }
  }

  if (parsed.sub === "inboxes" || parsed.sub === "all") {
    if (parsed.purgeLegacy) {
      out.legacyInboxes = await purgeLegacyInboxes(atmuxDir, { dryRun: parsed.dryRun });
      if (out.legacyInboxes.skipped) {
        logger.log("cleanup inboxes --purge-legacy: skipped (no state.db — JSON may still be canonical)");
      } else if (parsed.dryRun) {
        for (const name of out.legacyInboxes.removed) {
          logger.log(`  [dry-run] would remove inboxes/${name}`);
        }
        logger.ok(
          `cleanup inboxes --purge-legacy (dry-run): would remove ${out.legacyInboxes.removed.length} legacy file(s)`,
        );
      } else {
        for (const name of out.legacyInboxes.removed) {
          logger.log(`cleanup inboxes --purge-legacy: removed ${name}`);
        }
        logger.ok(
          `cleanup inboxes --purge-legacy: removed ${out.legacyInboxes.removed.length} legacy file(s)`,
        );
      }
    } else {
      const opts2: { maxAgeDays?: number; dryRun?: boolean; nowMs?: number } = {
        dryRun: parsed.dryRun,
      };
      if (parsed.maxAgeDays !== undefined) opts2.maxAgeDays = parsed.maxAgeDays;
      if (opts.nowMs !== undefined) opts2.nowMs = opts.nowMs;
      try {
        out.inboxes = await pruneInboxes(atmuxDir, opts2);
      } catch (e) {
        if (e instanceof RangeError) {
          throw new UsageError({
            what: e.message,
            hint: "see atmux help",
          });
        }
        throw e;
      }
      if (parsed.dryRun) {
        for (const f of out.inboxes.files) {
          logger.log(`  [dry-run] ${f.name}: would prune ${f.pruned} done[], keep ${f.kept}`);
        }
        logger.ok(
          `cleanup inboxes (dry-run): would prune ${out.inboxes.totalPruned} entries (>${out.inboxes.cutoffDays}d), ${out.inboxes.totalKept} recent kept`,
        );
      } else {
        for (const f of out.inboxes.files) {
          logger.log(`cleanup inboxes: ${f.name} pruned=${f.pruned} kept=${f.kept}`);
        }
        logger.ok(
          `cleanup inboxes: pruned ${out.inboxes.totalPruned} entries (>${out.inboxes.cutoffDays}d), ${out.inboxes.totalKept} kept`,
        );
      }
    }
  }

  return 0;
}
