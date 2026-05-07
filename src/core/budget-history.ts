// ADR-053 §D5: durable budget probe history log.
//
// Append-only JSONL at `<atmuxDir>/logs/budget-history.jsonl`. One line
// per probe attempt — success AND failure. Producers:
//
//   - src/abstractions/budget-probe.ts (per-tick whip + R1-T1 base flow)
//   - src/verbs/whip-resume-check.ts (R1-T7 1-min cron)
//   - src/verbs/whip.ts (cache-hit observations, optional)
//
// Race-safe: `withLock(<path>.lock)` serializes writes when whip ticks
// and the lighter-weight whip-resume-check fire from cron concurrently.
// Rotation is owned by the bash-side `groom` machinery (§D5 last
// paragraph) — when the file > 1MB, groom renames to `.log.1` per its
// `--keep-bak` policy. This module is append-only, never rotates.
//
// Operator query path (jsonl):
//   `jq -c '.[]' .atmux/logs/budget-history.jsonl | grep '"account":"icloud"' | jq '.h5_util'`
//   No new verb needed in v1; `atmux budget-history` is a v1.1 candidate
//   if heavy demand emerges.

import { join } from "node:path";
import { appendText } from "../abstractions/fs.ts";
import { withLock } from "../abstractions/lock.ts";

/** Single history entry shape per ADR-053 §D5. */
export interface BudgetHistoryEntry {
  /** Epoch seconds when the probe outcome was determined. */
  ts: number;
  /** Account identity (matches `~/.claude-<account>/` directory basename). */
  account: string;
  /** 5h utilization (0–1 fraction; bash convention). */
  h5_util: number;
  /** 7d utilization (0–1 fraction). */
  wk_util: number;
  /** 5h reset epoch seconds (0 when unknown). */
  h5_reset: number;
  /** 7d reset epoch seconds (0 when unknown). */
  wk_reset: number;
  /** Structured outcome enum. */
  status: "allowed" | "rejected" | "probe-401" | "probe-error" | "no-credentials";
  /** Whether this entry came from a live probe or a cached read. */
  source: "probe" | "cache-hit";
  /** True when the probe triggered a Fix C OAuth refresh. */
  tokenRefreshed: boolean;
}

const HISTORY_LOG_REL = "logs/budget-history.jsonl";

/**
 * Append a single history entry to `<atmuxDir>/logs/budget-history.jsonl`.
 *
 * Best-effort under flock — write failures are SWALLOWED (logged via
 * the caller's stderr if it cares); the primary probe outcome must
 * never be masked by an unrelated history-log failure (per ADR-053
 * §D1 "regardless of status" + R6 "every IO failure ladders to a
 * typed error" carve-out: history-log is observability, not auth-of-
 * truth).
 *
 * Returns when the entry has been appended (or when the write quietly
 * failed). Never throws.
 */
export async function appendHistoryEntry(
  atmuxDir: string,
  entry: BudgetHistoryEntry,
): Promise<void> {
  const path = join(atmuxDir, HISTORY_LOG_REL);
  const lockPath = `${path}.lock`;
  try {
    await withLock(lockPath, async () => {
      await appendText(path, `${JSON.stringify(entry)}\n`);
    });
  } catch {
    // Best-effort: log failure must never mask the caller's primary outcome.
  }
}

/** Resolve the canonical history-log path for a given atmuxDir. */
export function budgetHistoryPath(atmuxDir: string): string {
  return join(atmuxDir, HISTORY_LOG_REL);
}
