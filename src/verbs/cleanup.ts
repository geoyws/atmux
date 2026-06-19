// ADR-068 cutover (Tier 1, P0) — `atmux cleanup` verb.
//
// ADR-263 (the great simplification): inbox/legacy-fleet-state cleanup is
// retired with the fleet-coordination layer. `cleanup` is now a pure
// log-rotation harness primitive.
//
// USAGE:
//   atmux cleanup logs [--max-size <bytes>] [--dry-run]
//   atmux cleanup all  [<flags>]
//
// `all` is an alias for `logs` (the inbox sub-op is gone per ADR-263).
// Idempotent + cron-safe.
//
// Operator-driven (not yet cron-fired); paves the way for an automatic
// schedule without behaviour change.

import { type LogRotationResult, rotateLogs } from "../core/cleanup.ts";
import { getAtmuxDir } from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";

// ---------- Args ----------

export type CleanupSub = "logs" | "all";

export interface ParsedCleanupArgs {
  sub: CleanupSub;
  maxBytes?: number;
  dryRun: boolean;
}

const VALID_SUBS = new Set<string>(["logs", "all"]);

export function parseCleanupArgs(args: ReadonlyArray<string>): ParsedCleanupArgs {
  if (args.length === 0) {
    throw new UsageError({
      what: "cleanup: missing subcommand",
      hint: "use logs | all",
    });
  }
  const sub = args[0] ?? "";
  if (!VALID_SUBS.has(sub)) {
    throw new UsageError({
      what: `cleanup: unknown subcommand: ${sub}`,
      hint: "use logs | all",
    });
  }
  let dryRun = false;
  let maxBytes: number | undefined;

  let i = 1;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "--dry-run") {
      dryRun = true;
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
    throw new UsageError({
      what: `cleanup ${sub}: unknown arg: ${a}`,
      hint: "see atmux help",
    });
  }

  const out: ParsedCleanupArgs = { sub: sub as CleanupSub, dryRun };
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  return out;
}

// ---------- Verb body ----------

export interface CleanupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  stdout?: Writer;
  atmuxDir?: string;
}

export interface CleanupResult {
  logs?: LogRotationResult;
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

  return 0;
}
