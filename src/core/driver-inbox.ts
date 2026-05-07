// ADR-057 §D2 (Class B): driver-inbox parsing + cursor primitives.
//
// Pure helpers shared by:
//   - src/verbs/driver-inbox.ts (D2b: delta-only read verb)
//   - src/core/lead-handoff.ts (D2c: pre-rotate handoff composer needs
//     "last 3 entries" extraction)
//   - src/verbs/whip.ts (D2d: stale-anchor finding compares cursor
//     against driver-inbox tip)
//
// Entry format. driver-inbox.md mixes two styles (both pre-existing; this
// module supports both):
//
//   1. Section-style (driver / lead longer-form asks):
//        ## HH:MM MYT — <header>
//        <multi-line body>
//
//   2. Bullet-style (tell-lead one-liners):
//        - [HH:MM MYT] <body>
//
// An ENTRY starts at a line matching either pattern and continues until
// the next entry-starting line OR EOF. The leading timestamp is in MYT
// (CLAUDE.md "Timezone" rule). Entries without a parseable timestamp are
// treated as undated and ALWAYS surfaced (conservative — prevents stale-
// view false negatives if a malformed entry slips in).
//
// Cursor file. `<atmuxDir>/state/last-driver-inbox-read.txt` stores the
// epoch-seconds of the lead's most recent read tip. Empty file / absent
// = "never read" → all entries surface. Updated on `--ack` writes (D2b)
// or via the verb's idempotent read-then-update flow when no other gate
// blocks. R5/R6: pure I/O via `src/abstractions/fs.ts`.

import { join } from "node:path";
import { readTextOrNull, statOrNull, writeText } from "../abstractions/fs.ts";
import { driverInboxPath, stateDir } from "./common.ts";

const CURSOR_FILENAME = "last-driver-inbox-read.txt";

/** Resolve `<atmuxDir>/state/last-driver-inbox-read.txt`. */
export function lastDriverInboxReadPath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), CURSOR_FILENAME);
}

/** Single parsed entry. `tsEpochSec` is `null` when the entry head line
 *  doesn't carry a parseable `HH:MM MYT` stamp — those entries are
 *  always surfaced (never filtered out by cursor). */
export interface DriverInboxEntry {
  /** First line of the entry — the header / bullet starting line. */
  head: string;
  /** Full entry text (head + body + trailing blank lines, no
   *  trailing newline). Render verbatim. */
  body: string;
  /** Parsed timestamp; null when the entry head is undated. */
  tsEpochSec: number | null;
}

// Entry-head patterns:
//   - Section header: `## HH:MM MYT [— rest...]`
//   - Section header w/ date: `## HH:MM MYT YYYY-MM-DD [— rest...]`
//   - Bullet head:    `- [HH:MM MYT] rest...`
//
// The MYT timestamp is `HH:MM MYT` (CLAUDE.md rule). We accept a
// trailing date hint `YYYY-MM-DD` after MYT for entries that span days
// (sample driver-inbox has both forms). Date hint is consumed when
// present; otherwise we resolve "today's date" via the caller-supplied
// `nowEpochSec` so a 09:30 MYT entry written yesterday doesn't mis-
// classify as future.
const SECTION_HEAD_RE = /^##\s+(\d{2}):(\d{2})\s+MYT(?:\s+(\d{4})-(\d{2})-(\d{2}))?\b/;
const BULLET_HEAD_RE = /^-\s+\[(\d{2}):(\d{2})\s+MYT\]/;

/** True iff the line starts a new entry (section or bullet). */
export function isEntryHead(line: string): boolean {
  return SECTION_HEAD_RE.test(line) || BULLET_HEAD_RE.test(line);
}

/**
 * Parse `body` (full driver-inbox.md text) into an ordered list of
 * entries. `nowEpochSec` is used to resolve undated `HH:MM MYT` heads
 * to "today" — they're mapped onto today's date in MYT (UTC+8); if the
 * resulting epoch is in the future relative to `now`, we roll back one
 * day (the entry must be from yesterday).
 */
export function parseEntries(body: string, nowEpochSec: number): DriverInboxEntry[] {
  if (body.length === 0) return [];
  const lines = body.split("\n");
  const entries: DriverInboxEntry[] = [];
  let bufHead: string | null = null;
  let bufBody: string[] = [];

  const flush = (): void => {
    if (bufHead === null) return;
    const text = [bufHead, ...bufBody].join("\n");
    entries.push({
      head: bufHead,
      body: text,
      tsEpochSec: parseEntryTimestamp(bufHead, nowEpochSec),
    });
    bufHead = null;
    bufBody = [];
  };

  for (const line of lines) {
    if (isEntryHead(line)) {
      flush();
      bufHead = line;
    } else if (bufHead !== null) {
      bufBody.push(line);
    }
    // Pre-first-entry header lines (e.g. file frontmatter) are dropped —
    // they're not entries by definition.
  }
  flush();
  return entries;
}

/**
 * Extract the entry timestamp (epoch seconds) from a head line. Returns
 * null when the head doesn't match either pattern — caller should treat
 * null entries as always-surface.
 */
export function parseEntryTimestamp(head: string, nowEpochSec: number): number | null {
  const sectionMatch = head.match(SECTION_HEAD_RE);
  if (sectionMatch !== null) {
    const [, hh, mm, yyyy, mo, dd] = sectionMatch;
    if (yyyy !== undefined && mo !== undefined && dd !== undefined) {
      return mytEpochFromParts(
        Number.parseInt(yyyy, 10),
        Number.parseInt(mo, 10),
        Number.parseInt(dd, 10),
        Number.parseInt(hh ?? "0", 10),
        Number.parseInt(mm ?? "0", 10),
      );
    }
    return resolveTodayMyt(
      Number.parseInt(hh ?? "0", 10),
      Number.parseInt(mm ?? "0", 10),
      nowEpochSec,
    );
  }
  const bulletMatch = head.match(BULLET_HEAD_RE);
  if (bulletMatch !== null) {
    return resolveTodayMyt(
      Number.parseInt(bulletMatch[1] ?? "0", 10),
      Number.parseInt(bulletMatch[2] ?? "0", 10),
      nowEpochSec,
    );
  }
  return null;
}

/**
 * Map an HH:MM MYT pair (no date) onto an absolute epoch by anchoring
 * to today-in-MYT. If the resulting epoch is more than 5min in the
 * future relative to `nowEpochSec`, roll back one day (the entry must
 * be from yesterday).
 */
function resolveTodayMyt(hh: number, mm: number, nowEpochSec: number): number {
  const nowMs = nowEpochSec * 1000;
  // MYT == UTC+8. Build today's MYT date by reading the UTC date that
  // currently maps to MYT.
  const mytNowMs = nowMs + 8 * 3600 * 1000;
  const d = new Date(mytNowMs);
  const yyyy = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const candidate = mytEpochFromParts(yyyy, mo, dd, hh, mm);
  // 5-minute look-ahead grace window — reject only entries clearly in
  // the future. Useful when the writer + reader clocks drift slightly.
  if (candidate > nowEpochSec + 300) {
    return candidate - 86_400;
  }
  return candidate;
}

/** Compose epoch seconds for a (Y, Mo, D, H, M) tuple interpreted in MYT. */
function mytEpochFromParts(yyyy: number, mo: number, dd: number, hh: number, mm: number): number {
  const mytMs = Date.UTC(yyyy, mo - 1, dd, hh, mm, 0);
  return Math.floor(mytMs / 1000) - 8 * 3600;
}

// ---------- Cursor I/O ----------

/** Read the cursor (epoch seconds). Returns null on absent / corrupt. */
export async function readCursor(atmuxDir: string): Promise<number | null> {
  const txt = await readTextOrNull(lastDriverInboxReadPath(atmuxDir));
  if (txt === null) return null;
  const trimmed = txt.trim();
  if (trimmed.length === 0) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Write the cursor (epoch seconds). Atomic via writeText (which itself
 *  uses tmp+rename per ADR-057 §D3c). */
export async function writeCursor(atmuxDir: string, epochSec: number): Promise<void> {
  await writeText(lastDriverInboxReadPath(atmuxDir), `${epochSec}\n`);
}

// ---------- Slicing helpers ----------

/**
 * Filter entries to those after the cursor. Entries with `tsEpochSec`
 * null (undated) ALWAYS surface — conservative posture per the
 * "always-surface" rule above.
 */
export function entriesSince(
  entries: ReadonlyArray<DriverInboxEntry>,
  cursorSec: number | null,
): DriverInboxEntry[] {
  if (cursorSec === null) return [...entries];
  return entries.filter((e) => e.tsEpochSec === null || e.tsEpochSec > cursorSec);
}

/**
 * Take the last `n` entries in chronological order (file order). Used
 * by lead-handoff (D2c) for the "last 3 entries summarized" payload.
 */
export function lastNEntries(
  entries: ReadonlyArray<DriverInboxEntry>,
  n: number,
): DriverInboxEntry[] {
  if (n <= 0) return [];
  if (entries.length <= n) return [...entries];
  return entries.slice(-n);
}

// ---------- High-level reader ----------

export interface ReadDriverInboxResult {
  /** All parsed entries from the file. */
  all: DriverInboxEntry[];
  /** Entries newer than the cursor. */
  delta: DriverInboxEntry[];
  /** Cursor that was in effect (null = first read). */
  priorCursor: number | null;
  /** Latest entry timestamp seen (null when file empty / undated). */
  tipTs: number | null;
  /** mtime of the driver-inbox file, epoch seconds (null when absent). */
  fileMtimeSec: number | null;
}

/**
 * Read driver-inbox.md from disk + parse + apply cursor. Returns
 * `null`-shaped values when the file is absent (still a valid state on
 * a fresh team). Pure I/O — caller decides whether to write the cursor
 * back.
 */
export async function readDriverInbox(
  atmuxDir: string,
  nowEpochSec: number,
  cursorOverride?: number,
): Promise<ReadDriverInboxResult> {
  const path = driverInboxPath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) {
    return { all: [], delta: [], priorCursor: null, tipTs: null, fileMtimeSec: null };
  }
  const all = parseEntries(txt, nowEpochSec);
  const cursor = cursorOverride ?? (await readCursor(atmuxDir));
  const delta = entriesSince(all, cursor ?? null);
  const tipTs = computeTipTs(all);
  const stat = await statOrNull(path);
  const fileMtimeSec = stat === null ? null : Math.floor(stat.mtimeMs / 1000);
  return { all, delta, priorCursor: cursor ?? null, tipTs, fileMtimeSec };
}

/** Latest non-null timestamp across entries. */
function computeTipTs(entries: ReadonlyArray<DriverInboxEntry>): number | null {
  let tip: number | null = null;
  for (const e of entries) {
    if (e.tsEpochSec === null) continue;
    if (tip === null || e.tsEpochSec > tip) tip = e.tsEpochSec;
  }
  return tip;
}
