// ADR-068 cutover (Tier 1, P0) — `atmux cleanup` core helpers.
//
// Bash port target: lib/cleanup.sh @ HEAD (frozen ref under
// .archive-bash-atmux-20260507/lib/cleanup.sh).
//
// Two idempotent sub-ops, both cron-safe + dry-runnable:
//   1. rotateLogs — rotate any *.log file >1MB to *.log.1 (one
//      generation only; operators wanting longer retention should run
//      logrotate). Current *.log gets truncated; *.log.1 keeps the
//      snapshot. Repeated runs overwrite the .1 each rotation.
//   2. pruneInboxes — drop `.done[]` entries older than `maxAgeDays`
//      (default 7) from `<atmuxDir>/inboxes/*.json`. `.completedAt` is
//      the anchor; entries without one are kept (we don't know their
//      age). `.pending[]` and `.inProgress[]` are NEVER touched.
//
// State files (`kanban.json`, `team.json`, `state/*`) are explicitly
// out of scope here — those are authoritative and groom owns its own
// kanban summarize/prune.

import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  exists,
  removeFile,
  statOrNull,
  writeText,
} from "../abstractions/fs.ts";
import { tryReadJson, updateJson } from "../abstractions/json.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { z } from "zod";
import { inboxDir as resolveInboxDir, logsDir as resolveLogsDir } from "./common.ts";

// ---------- Sub-op 1: log rotation ----------

export interface RotatedLog {
  /** Absolute path of the *.log file. */
  path: string;
  /** Size in bytes at rotation time. */
  size: number;
}

export interface LogRotationResult {
  rotated: RotatedLog[];
  /** Files inspected but not rotated (under cap). Tracked for log
   *  output parity with bash. */
  skipped: number;
  /** The cap actually applied (after default + override). */
  capBytes: number;
}

export interface RotateLogsOpts {
  /** Default 1MB (1024*1024). */
  maxBytes?: number;
  dryRun?: boolean;
}

/**
 * Rotate *.log files in `<atmuxDir>/logs/`. Files >maxBytes are renamed
 * to `<file>.log.1` and the original truncated to zero length. One
 * generation only — re-running on the same logs dir overwrites .1
 * snapshots. Idempotent across runs (a log under cap stays put).
 */
export async function rotateLogs(
  atmuxDir: string,
  opts: RotateLogsOpts = {},
): Promise<LogRotationResult> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const dryRun = opts.dryRun === true;
  const ldir = resolveLogsDir(atmuxDir);
  const out: LogRotationResult = { rotated: [], skipped: 0, capBytes: maxBytes };

  if (!(await exists(ldir))) return out;

  const entries = await readdir(ldir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const full = join(ldir, name);
    const st = await statOrNull(full);
    if (st === null || !st.isFile) continue;
    if (st.size > maxBytes) {
      if (!dryRun) {
        // Bash: `mv "$f" "$f.1"; : > "$f"`. Plain rename + truncate is
        // sufficient — there's no atomicity contract for log rotation
        // (logs are write-only append; a torn .1 is recoverable).
        await rename(full, `${full}.1`).catch(async () => {
          // If a stale .1 has unusual perms / kernel rejected the rename,
          // fall back to write+truncate emulation: append-then-clear is
          // less ideal but better than aborting cleanup entirely.
          await removeFile(`${full}.1`);
          await rename(full, `${full}.1`);
        });
        await writeText(full, "");
      }
      out.rotated.push({ path: full, size: st.size });
    } else {
      out.skipped += 1;
    }
  }
  return out;
}

// ---------- Sub-op 2: inbox `.done[]` prune ----------

/** Loose schema for a member inbox file. We touch only `.done[]`, but
 *  we read the whole file via Zod-passthrough so unknown bash-side
 *  fields (and forward-compat additions) survive the round-trip. */
const InboxFile = z
  .object({
    pending: z.array(z.unknown()).optional(),
    inProgress: z.array(z.unknown()).optional(),
    done: z
      .array(
        z
          .object({
            completedAt: z.number().int().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface InboxPruneResult {
  /** Per-file outcome (only files with at least one prune candidate
   *  appear; bash logs the full per-file decision but parity-priority is
   *  the totals). */
  files: { name: string; pruned: number; kept: number }[];
  totalPruned: number;
  totalKept: number;
  /** The day-cutoff actually applied. */
  cutoffDays: number;
}

export interface PruneInboxesOpts {
  /** Default 7. Bash `assertValid` requires positive integer; same here. */
  maxAgeDays?: number;
  dryRun?: boolean;
  nowMs?: number;
}

/**
 * Prune `.done[]` entries older than `maxAgeDays` from every
 * `<atmuxDir>/inboxes/*.json`. `.completedAt`-less entries are kept
 * (we don't know their age — defensive, matches bash). `.pending[]`
 * and `.inProgress[]` are NEVER touched (live work + active dispatches).
 *
 * @throws RangeError on non-positive `maxAgeDays`.
 */
export async function pruneInboxes(
  atmuxDir: string,
  opts: PruneInboxesOpts = {},
): Promise<InboxPruneResult> {
  const maxAgeDays = opts.maxAgeDays ?? 7;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays <= 0) {
    throw new RangeError(
      `cleanup inboxes: --max-age-days must be a positive integer (got ${maxAgeDays})`,
    );
  }
  const dryRun = opts.dryRun === true;
  const stampMs = opts.nowMs ?? nowMs();
  const cutoffSec = Math.floor(stampMs / 1000) - maxAgeDays * 86400;

  const ibDir = resolveInboxDir(atmuxDir);
  const out: InboxPruneResult = {
    files: [],
    totalPruned: 0,
    totalKept: 0,
    cutoffDays: maxAgeDays,
  };
  if (!(await exists(ibDir))) return out;

  const entries = await readdir(ibDir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const full = join(ibDir, name);
    const st = await statOrNull(full);
    if (st === null || !st.isFile) continue;

    if (dryRun) {
      // Read-only path; mirror bash `--dry-run` shape (count what would
      // prune without writing).
      const before = await readDoneEntries(full);
      const after = before.filter((e) => keep(e, cutoffSec));
      const pruned = before.length - after.length;
      out.totalPruned += pruned;
      out.totalKept += after.length;
      if (pruned > 0) out.files.push({ name, pruned, kept: after.length });
      continue;
    }

    let pruned = 0;
    let after = 0;
    try {
      const next = await updateJson(full, InboxFile, (current) => {
        const done = current.done ?? [];
        const filtered = done.filter((e) => keep(e, cutoffSec));
        pruned = done.length - filtered.length;
        after = filtered.length;
        return { ...current, done: filtered };
      });
      // updateJson returns post-validate value; defensive recompute.
      after = next.done?.length ?? after;
    } catch {
      // If the file is malformed Zod throws — parity preserves the bash
      // posture of "skip this inbox, keep going". Counts unchanged.
      continue;
    }
    out.totalPruned += pruned;
    out.totalKept += after;
    if (pruned > 0) out.files.push({ name, pruned, kept: after });
  }
  return out;
}

interface DoneLike {
  completedAt?: number | null | undefined;
}

function keep(entry: DoneLike, cutoffSec: number): boolean {
  const ca = entry.completedAt;
  if (ca === undefined || ca === null || ca === 0) return true; // defensive
  return ca >= cutoffSec;
}

async function readDoneEntries(path: string): Promise<DoneLike[]> {
  // tryReadJson throws SchemaError on malformed; swallow + return []
  // so the caller (dry-run path) can keep walking other inboxes.
  let parsed;
  try {
    parsed = await tryReadJson(path, InboxFile);
  } catch {
    return [];
  }
  if (parsed === null) return [];
  const done = parsed.done;
  return done === undefined ? [] : (done as unknown as DoneLike[]);
}
