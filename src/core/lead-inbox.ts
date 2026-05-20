// ADR-057 §D2 (Class B) + ADR-198: lead-inbox parsing + cursor primitives.
//
// ADR-198 (2026-05-20): file renamed driver-inbox.md → lead-inbox.md;
// the lead reads from + the driver writes to ITS OWN inbox, pairing with
// `lead-outbox.md` (asymmetric — both belong to the lead's view).
// `readLeadInbox` accepts BOTH filenames during the one-release grace
// window and concat-merges entries by timestamp when both exist (mid-
// rollout race). Writes are tell-lead's responsibility and go to
// `lead-inbox.md` only.
//
// Pure helpers shared by:
//   - src/verbs/driver-inbox.ts (D2b: delta-only read verb — verb name
//     kept for back-compat; semantics route through `readLeadInbox`)
//   - src/core/lead-handoff.ts (D2c: pre-rotate handoff composer needs
//     "last 3 entries" extraction)
//   - src/verbs/whip.ts (D2d: stale-anchor finding compares cursor
//     against lead-inbox tip)
//
// Entry format. lead-inbox.md (+ legacy driver-inbox.md) mixes two styles
// (both pre-existing; this module supports both):
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
// epoch-seconds of the lead's most recent read tip. Filename retained
// post-ADR-198 (internal state, no operator-facing surface) — append-only
// convention extends to cursor-state filenames. Empty file / absent =
// "never read" → all entries surface. Updated on `--ack` writes (D2b)
// or via the verb's idempotent read-then-update flow when no other gate
// blocks. R5/R6: pure I/O via `src/abstractions/fs.ts`.

import { join } from "node:path";
import { readTextOrNull, statOrNull, writeText } from "../abstractions/fs.ts";
import { driverInboxLegacyPath, leadInboxPath, stateDir } from "./common.ts";

const CURSOR_FILENAME = "last-driver-inbox-read.txt";

/** Canonical header prefixed to a fresh `.atmux/lead-inbox.md` on first
 *  append (per ADR-198). Consumed by `src/verbs/tell-lead.ts` on first
 *  write and by `src/verbs/migrate-lead-inbox.ts` when seeding a freshly
 *  migrated cage. Re-exporting from core keeps the canonical text in one
 *  place so a future header tweak doesn't require touching both verbs. */
export const LEAD_INBOX_HEADER = `# Lead Inbox — driver asks for the lead (ADR-198)

Lead reads this at the start of every whip turn. Mark each entry:
  ✅ done  ·  📤 delegated  ·  ⏳ in-progress  ·  ❌ rejected

Keep entries bulleted, terse, and timestamped. Move >24h entries to "## Archive".

## Open
`;

/** Resolve `<atmuxDir>/state/last-driver-inbox-read.txt`. Filename
 *  retained post-ADR-198 per append-only convention on state files. */
export function lastLeadInboxReadPath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), CURSOR_FILENAME);
}

/** @deprecated ADR-198: use {@link lastLeadInboxReadPath}. Kept for one
 *  release for external imports. */
export const lastDriverInboxReadPath = lastLeadInboxReadPath;

/** Single parsed entry. `tsEpochSec` is `null` when the entry head line
 *  doesn't carry a parseable `HH:MM MYT` stamp — those entries are
 *  always surfaced (never filtered out by cursor). */
export interface LeadInboxEntry {
  /** First line of the entry — the header / bullet starting line. */
  head: string;
  /** Full entry text (head + body + trailing blank lines, no
   *  trailing newline). Render verbatim. */
  body: string;
  /** Parsed timestamp; null when the entry head is undated. */
  tsEpochSec: number | null;
}

/** @deprecated ADR-198: use {@link LeadInboxEntry}. Kept for one release
 *  for external imports. */
export type DriverInboxEntry = LeadInboxEntry;

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
export function parseEntries(body: string, nowEpochSec: number): LeadInboxEntry[] {
  if (body.length === 0) return [];
  const lines = body.split("\n");
  const entries: LeadInboxEntry[] = [];
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
  entries: ReadonlyArray<LeadInboxEntry>,
  cursorSec: number | null,
): LeadInboxEntry[] {
  if (cursorSec === null) return [...entries];
  return entries.filter((e) => e.tsEpochSec === null || e.tsEpochSec > cursorSec);
}

/**
 * Take the last `n` entries in chronological order (file order). Used
 * by lead-handoff (D2c) for the "last 3 entries summarized" payload.
 */
export function lastNEntries(entries: ReadonlyArray<LeadInboxEntry>, n: number): LeadInboxEntry[] {
  if (n <= 0) return [];
  if (entries.length <= n) return [...entries];
  return entries.slice(-n);
}

// ---------- High-level reader ----------

export interface ReadLeadInboxResult {
  /** All parsed entries (merged across legacy + canonical files when
   *  both exist; ordered by tsEpochSec asc, undated last in file-order). */
  all: LeadInboxEntry[];
  /** Entries newer than the cursor. */
  delta: LeadInboxEntry[];
  /** Cursor that was in effect (null = first read). */
  priorCursor: number | null;
  /** Latest entry timestamp seen (null when file(s) empty / undated). */
  tipTs: number | null;
  /** mtime of the canonical (lead-inbox.md) file in epoch seconds; falls
   *  back to legacy (driver-inbox.md) mtime when only legacy exists.
   *  `null` when neither file exists. */
  fileMtimeSec: number | null;
  /** ADR-198: true when the legacy `driver-inbox.md` file was read as
   *  part of this load. Callers (`atmux doctor`) surface this to warn
   *  the operator to run the T2 migration walker. */
  legacyPresent: boolean;
}

/** @deprecated ADR-198: use {@link ReadLeadInboxResult}. */
export type ReadDriverInboxResult = ReadLeadInboxResult;

/**
 * Read lead-inbox.md (+ legacy driver-inbox.md during ADR-198 grace) from
 * disk, parse, and apply the cursor. Returns `null`-shaped values when
 * BOTH files are absent (a valid state on a fresh team). Pure I/O —
 * caller decides whether to write the cursor back.
 *
 * ADR-198 read-shim: when both files exist (mid-rollout race), parse
 * entries from each and concat-merge by tsEpochSec; undated entries from
 * each file are preserved in file-order (legacy first, canonical second
 * — legacy was the older file by definition during the grace window).
 */
export async function readLeadInbox(
  atmuxDir: string,
  nowEpochSec: number,
  cursorOverride?: number,
): Promise<ReadLeadInboxResult> {
  const canonicalPath = leadInboxPath(atmuxDir);
  const legacyPath = driverInboxLegacyPath(atmuxDir);
  const [canonicalTxt, legacyTxt] = await Promise.all([
    readTextOrNull(canonicalPath),
    readTextOrNull(legacyPath),
  ]);
  const legacyPresent = legacyTxt !== null;

  if (canonicalTxt === null && legacyTxt === null) {
    return {
      all: [],
      delta: [],
      priorCursor: null,
      tipTs: null,
      fileMtimeSec: null,
      legacyPresent: false,
    };
  }

  const legacyEntries = legacyTxt === null ? [] : parseEntries(legacyTxt, nowEpochSec);
  const canonicalEntries = canonicalTxt === null ? [] : parseEntries(canonicalTxt, nowEpochSec);
  const all = mergeEntriesByTs(legacyEntries, canonicalEntries);

  const cursor = cursorOverride ?? (await readCursor(atmuxDir));
  const delta = entriesSince(all, cursor ?? null);
  const tipTs = computeTipTs(all);

  // Prefer canonical mtime when present; fall back to legacy only when
  // canonical is absent. The mtime feeds the heads-up dedup cursor +
  // operator-facing freshness checks, both of which care about the
  // post-ADR-198 write surface.
  const primaryStat =
    canonicalTxt !== null ? await statOrNull(canonicalPath) : await statOrNull(legacyPath);
  const fileMtimeSec = primaryStat === null ? null : Math.floor(primaryStat.mtimeMs / 1000);

  return { all, delta, priorCursor: cursor ?? null, tipTs, fileMtimeSec, legacyPresent };
}

/** @deprecated ADR-198: use {@link readLeadInbox}. Kept for one release
 *  for external imports. */
export const readDriverInbox = readLeadInbox;

/** Merge entries from legacy + canonical files by timestamp ascending.
 *  Undated entries are preserved in file-order (legacy block first,
 *  canonical block second) — they always surface anyway (entriesSince
 *  filter), so position is cosmetic. */
function mergeEntriesByTs(
  legacy: ReadonlyArray<LeadInboxEntry>,
  canonical: ReadonlyArray<LeadInboxEntry>,
): LeadInboxEntry[] {
  if (legacy.length === 0) return [...canonical];
  if (canonical.length === 0) return [...legacy];

  const dated: LeadInboxEntry[] = [];
  const undatedLegacy: LeadInboxEntry[] = [];
  const undatedCanonical: LeadInboxEntry[] = [];
  for (const e of legacy) {
    if (e.tsEpochSec === null) undatedLegacy.push(e);
    else dated.push(e);
  }
  for (const e of canonical) {
    if (e.tsEpochSec === null) undatedCanonical.push(e);
    else dated.push(e);
  }
  dated.sort((a, b) => (a.tsEpochSec ?? 0) - (b.tsEpochSec ?? 0));
  return [...dated, ...undatedLegacy, ...undatedCanonical];
}

/** Latest non-null timestamp across entries. */
function computeTipTs(entries: ReadonlyArray<LeadInboxEntry>): number | null {
  let tip: number | null = null;
  for (const e of entries) {
    if (e.tsEpochSec === null) continue;
    if (tip === null || e.tsEpochSec > tip) tip = e.tsEpochSec;
  }
  return tip;
}
