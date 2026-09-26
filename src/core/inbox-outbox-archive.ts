// e-77 T1 (t-875eb305): shared archive-cut helper for driver-inbox.md
// and lead-outbox.md.
//
// The inbox/outbox files are append-only logs of `- [HH:MM MYT] msg`
// entries under a fixed header. AI agents are denied direct writes;
// the archive verbs (T2/T3) call THIS helper under the verb's own
// write authority — the verb stays the only AI-accessible mutation
// path (epic e-774065d6 authority model).
//
// Cut contract (epic OQ3/OQ4/OQ5):
//   - Entry dates: entries carry `HH:MM MYT` only. The absolute date is
//     inferred by walking BACK from the file's mtime day: a timestamp
//     later-than-now on the mtime day belongs to the previous day
//     (entries can only age, never post-date their last write).
//   - Duration: `--older-than` takes `Nm|Nh|Nd` (reject bare numeric).
//   - Header: everything before the FIRST dated entry is preserved
//     verbatim in the live file and copied atop the archive.
//   - Idempotency: cutoff math is absolute (mtime-anchored); a re-run
//     after a cut finds only newer entries and is a no-op.
//   - Atomicity: live file rewritten via tmpfile+rename under flock on
//     `<file>.lock` (same sidecar the reply/tell-lead writers honor).

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquire } from "../abstractions/lock.ts";
import { exists, readTextOrNull, statOrNull, writeText } from "../abstractions/fs.ts";
import { UsageError } from "../errors.ts";

/** `HH:MM MYT` entry marker as written by tell-lead/reply (ADR-029 §F8). */
const ENTRY_TS = /\[(\d{2}):(\d{2}) MYT\]/;

/** Parse `--older-than` durations per epic OQ3: `Nm|Nh|Nd` only. */
export function parseDuration(value: string): number {
  const m = /^(\d+)([mhd])$/.exec(value);
  if (m === null) {
    throw new UsageError({
      what: `archive: --older-than takes Nm|Nh|Nd (got ${value}); bare numbers are ambiguous`,
      hint: "examples: 30m, 48h, 7d",
    });
  }
  const n = Number(m[1]);
  if (m[2] === "m") return n * 60_000;
  if (m[2] === "h") return n * 3_600_000;
  return n * 86_400_000;
}

export interface EntrySpan {
  /** Line index of the first entry line (0-based). */
  start: number;
  /** Absolute epoch-ms timestamp inferred for the entry. */
  at: number;
}

/**
 * Locate dated entries in a file body. `mtimeMs` anchors absolute-date
 * inference: entries walk back from the mtime day; an HH:MM later than
 * the mtime clock-time rolls to the previous day.
 */
export function findEntries(body: string, mtimeMs: number): EntrySpan[] {
  const lines = body.split("\n");
  // MYT day boundary in absolute terms: the day (00:00 MYT) containing
  // mtime. MYT is UTC+8 with no DST.
  const mtimeMyt = new Date(mtimeMs + 8 * 3_600_000);
  const mtimeDayStartUtc = Date.UTC(
    mtimeMyt.getUTCFullYear(),
    mtimeMyt.getUTCMonth(),
    mtimeMyt.getUTCDate(),
  ) - 8 * 3_600_000;
  const mtimeMinutes = mtimeMyt.getUTCHours() * 60 + mtimeMyt.getUTCMinutes();

  const spans: EntrySpan[] = [];
  // Forward pass in append order: a clock time NOT strictly increasing
  // vs the previous entry means midnight wrapped — bump the relative
  // day. Equal minutes also count (two entries can't share HH:MM
  // within one day of a single file's chronology).
  const collected: Array<{ start: number; minutes: number; day: number }> = [];
  let prevMinutes: number | null = null;
  let relDay = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = ENTRY_TS.exec(lines[i] as string);
    if (m === null) continue;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (prevMinutes !== null && minutes <= prevMinutes) relDay += 1;
    prevMinutes = minutes;
    collected.push({ start: i, minutes, day: relDay });
  }
  if (collected.length === 0) return spans;

  // Backward anchor: mtime is the file's LAST write, so the LAST entry
  // sits on the mtime day — unless its clock time post-dates mtime's
  // (then the whole run shifts one day further back).
  const last = collected[collected.length - 1] as { start: number; minutes: number; day: number };
  const anchorShift = last.minutes > mtimeMinutes ? 1 : 0;
  for (const c of collected) {
    const daysBack = last.day - c.day + anchorShift;
    spans.push({ start: c.start, at: mtimeDayStartUtc - daysBack * 86_400_000 + c.minutes * 60_000 });
  }
  return spans;
}

export interface ArchiveCut {
  /** Header + non-dated preamble, preserved verbatim in the live file. */
  head: string;
  /** Old-entry block moved to the archive (verbatim lines). */
  archivedBlock: string[];
  /** Recent entries + trailing lines that STAY in the live file. */
  liveTail: string[];
  /** The first old entry's line index — cut boundary in the original. */
  cutAt: number | null;
}

/**
 * Compute the cut for one archive pass: entries older than the cutoff
 * move to the archive; the header AND every recent entry stay in the
 * live file (epic: "leaves header + recent live tail in place").
 * `nowMs` defaults to Date.now; tests pin it. Returns cutAt=null when
 * nothing is old enough. Conservative: only the contiguous block from
 * the first old entry up to the first recent entry is archived — an
 * inferred-old entry appearing after a recent one stays live.
 */
export function planCut(body: string, mtimeMs: number, olderThanMs: number, nowMs = Date.now()): ArchiveCut {
  const spans = findEntries(body, mtimeMs);
  const cutoff = nowMs - olderThanMs;
  const firstOld = spans.find((s) => s.at < cutoff);
  if (firstOld === undefined) {
    return { head: body, archivedBlock: [], liveTail: [], cutAt: null };
  }
  const firstRecent = spans.find((s) => s.at >= cutoff && s.start > firstOld.start);
  const lines = body.split("\n");
  const cutAt = firstOld.start;
  const liveFrom = firstRecent !== undefined ? firstRecent.start : lines.length;
  return {
    head: lines.slice(0, cutAt).join("\n"),
    archivedBlock: lines.slice(cutAt, liveFrom),
    liveTail: lines.slice(liveFrom),
    cutAt,
  };
}

export interface ArchiveResult {
  /** Archive file path written (null when nothing to archive). */
  archivePath: string | null;
  /** Number of entry lines moved. */
  entriesArchived: number;
}

export interface ArchiveOpts {
  /** Override clock (tests). */
  now?: () => number;
  /** Override stat (tests). */
  stat?: (path: string) => Promise<{ mtimeMs: number } | null>;
}

/**
 * Archive entries older than `olderThanMs` from `inboxPath` into
 * `<dir(inboxPath)>/../archive/<base>.archive-<ts>.md`. Atomic: the
 * live file is rewritten tmpfile+rename under flock on
 * `<inboxPath>.lock`; the archive file is written before the live
 * rewrite so a crash mid-pass loses nothing (worst case duplicates).
 */
export async function archiveFile(
  inboxPath: string,
  olderThanMs: number,
  opts: ArchiveOpts = {},
): Promise<ArchiveResult> {
  const stat = opts.stat ?? (async (p: string) => statOrNull(p));
  const now = opts.now ?? Date.now;
  const st = await stat(inboxPath);
  if (st === null) return { archivePath: null, entriesArchived: 0 };
  const body = await readTextOrNull(inboxPath);
  if (body === null || body.length === 0) return { archivePath: null, entriesArchived: 0 };

  const cut = planCut(body, st.mtimeMs, olderThanMs, now());
  if (cut.cutAt === null || cut.archivedBlock.length === 0) {
    return { archivePath: null, entriesArchived: 0 };
  }

  const lock = await acquire(inboxPath);
  try {
    // Re-read under the lock: a concurrent tell-lead/reply append may
    // have moved the tail since the planning read.
    const locked = (await readTextOrNull(inboxPath)) ?? body;
    const lockedCut = planCut(locked, st.mtimeMs, olderThanMs, now());
    if (lockedCut.cutAt === null || lockedCut.archivedBlock.length === 0) {
      return { archivePath: null, entriesArchived: 0 };
    }

    const dir = dirname(inboxPath);
    const archiveDir = join(dir, "archive");
    await mkdir(archiveDir, { recursive: true });
    const base = inboxPath.split("/").pop() ?? "archive";
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    const archivePath = join(archiveDir, `${base}.archive-${stamp}.md`);
    // Archive = head + old block (header context preserved per OQ4).
    await writeText(archivePath, `${lockedCut.head}\n${lockedCut.archivedBlock.join("\n")}\n`);

    // Live file = head + recent tail (tmpfile + rename under the lock).
    const liveBody =
      lockedCut.liveTail.length === 0
        ? lockedCut.head.length === 0 || lockedCut.head.endsWith("\n")
          ? lockedCut.head
          : `${lockedCut.head}\n`
        : `${lockedCut.head}\n${lockedCut.liveTail.join("\n")}`;
    const tmp = `${inboxPath}.archive-tmp-${process.pid}`;
    await writeText(tmp, liveBody);
    await rename(tmp, inboxPath);
    return { archivePath, entriesArchived: countEntries(lockedCut.archivedBlock.join("\n")) };
  } finally {
    await lock.release();
    await rm(`${inboxPath}.archive-tmp-${process.pid}`, { force: true }).catch(() => {});
  }
}

function countEntries(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (ENTRY_TS.test(line)) n += 1;
  return n;
}

/** Exists-check helper for verb wiring (T2/T3). */
export async function inboxExists(path: string): Promise<boolean> {
  return await exists(path);
}
