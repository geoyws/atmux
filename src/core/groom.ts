// ADR-068 cutover (Tier 1, P0) — `atmux groom` core helpers.
//
// Bash port target: lib/groom.sh @ HEAD (frozen ref under
// .archive-bash-atmux-20260507/lib/groom.sh).
//
// Five idempotent sub-ops, all wired by `src/verbs/groom.ts`:
//   1. flushInboxOutboxArchive — extract `## Archive` body from
//      driver-inbox.md + lead-outbox.md into archive/<file>-YYYY-MM.md;
//      rebuild active file with header through `## Archive` line + blank.
//   2. archiveDecisions — partition decisions.md `### d-<id>` blocks by
//      timestamp epoch; stale blocks (older than threshold) flush to
//      archive/decisions-<entry-month>.md.
//   3. summarizeKanban — done/cancelled tasks older than threshold get
//      one-line summaries appended to archive/kanban-log-<month>.md
//      (grouped by completedAt month) and are removed from kanban.json.
//   4. cullBakFiles — keep newest N of each kanban.json.bak.* /
//      team.json.bak.*; delete the rest.
//   5. archiveSizeCheck — warn (non-fatal) when archive/ exceeds 50MB
//      total or kanban-log archives exceed 5MB.
//
// All helpers take an explicit `nowMs` (default `time.now()`) so tests
// can pin the clock; archive month-stamps default to UTC formatting to
// match bash's cron-on-hax (TZ=UTC) behaviour byte-for-byte.

import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendText,
  atomicWrite,
  ensureDir,
  exists,
  readText,
  removeFile,
  statOrNull,
  writeText,
} from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { createTmux } from "../abstractions/tmux.ts";
import { Kanban } from "../schema/kanban.ts";
import { hasLiveChildCages } from "./cage-children.ts";
import { kanbanJsonPath, archiveDir as resolveArchiveDir } from "./common.ts";

// ---------- Shared time helpers ----------

/** YYYY-MM stamp from epoch ms in UTC. Matches bash `date +%Y-%m`
 *  semantics on hax (cron runs with TZ=UTC). Exported so tests can
 *  exercise specific months. */
export function ymStampUtc(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** YYYY-MM-DD stamp from epoch ms in UTC. For kanban-log row dates. */
export function ymdStampUtc(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD HH:MM:SS UTC stamp for the per-archive `_groom run_` header
 *  line. Matches bash `date +'%Y-%m-%d %H:%M:%S %Z'`. */
export function groomRunStampUtc(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss} UTC`;
}

// ---------- Sub-op 1: inbox/outbox archive flush ----------

export interface InboxOutboxFlushResult {
  /** Filename — `driver-inbox.md` or `lead-outbox.md`. */
  file: string;
  /** Absolute path of the archive file the body was appended to. */
  destPath: string;
  /** Lines in the body that was flushed (excludes the `## Archive` header). */
  bodyLineCount: number;
}

export interface FlushInboxOutboxOpts {
  /** When true, parse + report counts but skip writes. */
  dryRun?: boolean;
  /** Clock override (test injection). Defaults to `time.now()`. */
  nowMs?: number;
  /** Files to consider, relative to atmuxDir. Test injection point;
   *  defaults to the canonical pair. */
  files?: ReadonlyArray<string>;
}

/**
 * For `driver-inbox.md` + `lead-outbox.md`, find the `^## Archive` line
 * and move every line BELOW it into `archive/<file-base>-YYYY-MM.md`.
 * Re-emit the active file with the original header through the
 * `## Archive` line + a single trailing blank line.
 *
 * Returns one entry per file actually flushed. Files with no `## Archive`
 * section, or with only blank lines below it, are skipped (no entry).
 */
export async function flushInboxOutboxArchive(
  atmuxDir: string,
  opts: FlushInboxOutboxOpts = {},
): Promise<InboxOutboxFlushResult[]> {
  const dryRun = opts.dryRun === true;
  const stampMs = opts.nowMs ?? nowMs();
  const adir = resolveArchiveDir(atmuxDir);
  const candidateFiles = opts.files ?? ["driver-inbox.md", "lead-outbox.md"];
  const out: InboxOutboxFlushResult[] = [];

  await ensureDir(adir);

  for (const file of candidateFiles) {
    const src = join(atmuxDir, file);
    if (!(await exists(src))) continue;

    const text = await readText(src);
    const lines = text.split("\n");
    // Bash's grep `^## Archive` matches lines starting with that string.
    // First match wins. 1-indexed in bash; 0-indexed here.
    let archiveIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("## Archive")) {
        archiveIdx = i;
        break;
      }
    }
    if (archiveIdx < 0) continue;

    // `tail -n +<archive_line+1>` body. We may have a final empty
    // segment from `split("\n")` if the file ended with `\n`; that
    // blank carries through the count-as-blank check below.
    const bodyLines = lines.slice(archiveIdx + 1);
    if (bodyLines.length === 0) continue;
    const bodyJoined = bodyLines.join("\n");
    if (bodyJoined.replace(/\s+/g, "").length === 0) continue;

    const baseNoExt = file.endsWith(".md") ? file.slice(0, -3) : file;
    const stamp = ymStampUtc(stampMs);
    const destPath = join(adir, `${baseNoExt}-${stamp}.md`);
    const bodyLineCount = bodyLines.length;

    if (!dryRun) {
      const destExists = await exists(destPath);
      const blocks: string[] = [];
      if (!destExists) {
        blocks.push(`# ${baseNoExt} archive — ${stamp}\n\n`);
      } else {
        blocks.push(`\n---\n\n`);
      }
      blocks.push(`_groom run: ${groomRunStampUtc(stampMs)}_\n\n`);
      blocks.push(`${bodyJoined}\n`);
      await appendText(destPath, blocks.join(""));

      // Rebuild active file: lines [0..archiveIdx] (inclusive), plus a
      // trailing blank line — bash does `head -n archive_line` then
      // `printf '\n'`.
      const kept = lines.slice(0, archiveIdx + 1).join("\n");
      await atomicWrite(src, `${kept}\n\n`);
    }

    out.push({ file, destPath, bodyLineCount });
  }
  return out;
}

// ---------- Sub-op 1a: per-entry inbox aging (## Open → ## Archive) ----------
//
// Closes c-7a308f7f / t-82b6aed9. Wires the previously-reserved
// --inbox-days flag (verbs/groom.ts) so per-entry timestamped rows in
// driver-inbox.md / lead-outbox.md ## Open sections migrate to the
// same file's ## Archive section once they pass the days threshold.
//
// Runs BEFORE flushInboxOutboxArchive in the same groom pass so the
// just-aged entries get swept to the monthly archive file in one tick
// (per t-82b6aed9 §Scope "same pass" intent — note the dispatch literal
// said "Order AFTER flushInboxOutboxArchive" but the "same pass" sweep
// requires aging BEFORE flush chronologically; this is the
// chronological reading).
//
// Stopgap until ADR-154 (markdown→SQLite migration for driver-inbox +
// lead-outbox) lands. Post-cutover the legacy .md files become read-
// only renders of SQLite rows and this sub-op becomes dead code.

export interface AgeInboxResult {
  /** Filename — `driver-inbox.md` or `lead-outbox.md`. */
  file: string;
  /** Entries moved from `## Open` → `## Archive` this pass. */
  agedCount: number;
  /** Entries left in `## Open` (fresh + unparseable-timestamp entries
   *  when not aggressive). */
  remainingOpen: number;
}

export interface AgeInboxOpenToArchiveOpts {
  /** When true, parse + count but skip writes. */
  dryRun?: boolean;
  /** Clock override (test injection). Defaults to `time.now()`. */
  nowMs?: number;
  /** Files (relative to atmuxDir) to consider. Default: the canonical
   *  pair `["driver-inbox.md", "lead-outbox.md"]`. */
  files?: ReadonlyArray<string>;
  /** When true (or when `days === 0`), move EVERY entry in `## Open`
   *  to `## Archive` regardless of timestamp (and regardless of whether
   *  the timestamp parsed). Use case: historical bloat one-shot per
   *  task-body §Scope 4 ("sopx 10668-line outbox" residue clear). */
  aggressive?: boolean;
}

/**
 * Age `## Open` entries older than `days * 86400s` into the same file's
 * `## Archive` section. Conservative on unparseable timestamps (left in
 * `## Open`) unless `aggressive` (or `days === 0`) is set.
 *
 * Returns one entry per file processed (even when zero entries aged —
 * the `remainingOpen` count is still useful for observability). Files
 * with no `## Open` section are skipped (no entry returned).
 *
 * Entry shape: list items starting with `- [HH:MM MYT]` or
 * `- [HH:MM MYT YYYY-MM-DD]` (driver-inbox convention; date omitted is
 * "today implicit"). lead-outbox additionally suffixes the member name
 * (`- [HH:MM MYT] **<member>**:`), but the timestamp prefix shape is
 * identical so one parser handles both. Continuation lines (anything
 * up to the next entry-start `- [` line or section boundary) belong to
 * the preceding entry.
 */
export async function ageInboxOpenToArchive(
  atmuxDir: string,
  days: number,
  opts: AgeInboxOpenToArchiveOpts = {},
): Promise<AgeInboxResult[]> {
  const dryRun = opts.dryRun === true;
  const stampMs = opts.nowMs ?? nowMs();
  const aggressive = opts.aggressive === true || days === 0;
  const cutoffEpoch = Math.floor(stampMs / 1000) - days * 86400;
  const candidateFiles = opts.files ?? ["driver-inbox.md", "lead-outbox.md"];
  const out: AgeInboxResult[] = [];

  for (const file of candidateFiles) {
    const src = join(atmuxDir, file);
    if (!(await exists(src))) continue;

    const text = await readText(src);
    const sliced = sliceOpenArchive(text);
    if (sliced === null) continue;

    const { head, openHeader, openBody, archiveHeader, archiveBody } = sliced;
    const entries = parseOpenEntries(openBody);
    if (entries.length === 0) {
      out.push({ file, agedCount: 0, remainingOpen: 0 });
      continue;
    }

    const aged: ParsedInboxEntry[] = [];
    const kept: ParsedInboxEntry[] = [];
    for (const entry of entries) {
      if (aggressive) {
        aged.push(entry);
        continue;
      }
      const epochSec = entry.epochSec;
      if (epochSec === null) {
        kept.push(entry); // conservative: unparseable timestamps stay
      } else if (epochSec < cutoffEpoch) {
        aged.push(entry);
      } else {
        kept.push(entry);
      }
    }

    if (aged.length > 0 && !dryRun) {
      const newOpenBody = kept.map((e) => e.text).join("");
      // Aged entries land at the TOP of ARCHIVE — preserves newest-at-
      // top within ARCHIVE assuming both OPEN + existing ARCHIVE follow
      // the convention. We don't sort; we just splice in OPEN order.
      const agedConcat = aged.map((e) => e.text).join("");
      const newArchiveBody = `${agedConcat}${archiveBody}`;
      const archiveSection = archiveHeader === null ? "\n## Archive\n" : archiveHeader;
      const rebuilt = `${head}${openHeader}${newOpenBody}${archiveSection}${newArchiveBody}`;
      await atomicWrite(src, rebuilt);
    }

    out.push({ file, agedCount: aged.length, remainingOpen: kept.length });
  }
  return out;
}

/** Inbox/outbox file shape after slicing on `## Open` / `## Archive`. */
interface SlicedOpenArchive {
  /** Everything before the `## Open` line (inclusive of trailing
   *  newline if present). */
  head: string;
  /** The `## Open` header line itself, with trailing newline. */
  openHeader: string;
  /** Body between `## Open` line (exclusive) and `## Archive` line
   *  (exclusive) — or to EOF if no `## Archive` header. */
  openBody: string;
  /** The `## Archive` header line itself with trailing newline, or
   *  null if the file has no `## Archive` section (caller synthesizes). */
  archiveHeader: string | null;
  /** Body below the `## Archive` line; empty string when synthesizing. */
  archiveBody: string;
}

/** Locate `## Open` + (optional) `## Archive` headers and slice the
 *  file into HEAD / OPEN-body / ARCHIVE-body segments. Returns null when
 *  no `## Open` is present (file isn't aging-eligible). Exported for
 *  unit tests. */
export function sliceOpenArchive(text: string): SlicedOpenArchive | null {
  const lines = text.split("\n");
  let openIdx = -1;
  let archiveIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (openIdx < 0 && line === "## Open") {
      openIdx = i;
      continue;
    }
    if (openIdx >= 0 && archiveIdx < 0 && line.startsWith("## Archive")) {
      archiveIdx = i;
      break;
    }
  }
  if (openIdx < 0) return null;

  // HEAD = lines[0..openIdx-1] joined with `\n`, plus trailing `\n`
  // to keep the `## Open` line as its own row when stitched.
  const headLines = lines.slice(0, openIdx);
  const head = headLines.length === 0 ? "" : `${headLines.join("\n")}\n`;
  const openHeader = `${lines[openIdx] ?? "## Open"}\n`;

  if (archiveIdx < 0) {
    // No archive section yet — body runs to EOF; caller synthesizes
    // the `## Archive` line.
    const openBodyLines = lines.slice(openIdx + 1);
    const openBody = openBodyLines.length === 0 ? "" : `${openBodyLines.join("\n")}`;
    return {
      head,
      openHeader,
      openBody,
      archiveHeader: null,
      archiveBody: "",
    };
  }

  const openBodyLines = lines.slice(openIdx + 1, archiveIdx);
  const openBody = openBodyLines.length === 0 ? "" : `${openBodyLines.join("\n")}\n`;
  const archiveHeader = `${lines[archiveIdx] ?? "## Archive"}\n`;
  const archiveBodyLines = lines.slice(archiveIdx + 1);
  // Preserve final newline byte-for-byte: if split produced an empty
  // trailing element, the original file ended with `\n` and we want to
  // re-emit that. join("\n") gives us the body content; we restore the
  // trailing newline only when the original archive body was non-empty.
  const archiveBody = archiveBodyLines.length === 0 ? "" : archiveBodyLines.join("\n");
  return { head, openHeader, openBody, archiveHeader, archiveBody };
}

/** One entry inside `## Open` — the leading list-item line plus any
 *  continuation lines up to the next entry-start or section boundary.
 *  `text` carries the verbatim slice including trailing newline so
 *  splicing rebuilds byte-equivalently. */
export interface ParsedInboxEntry {
  /** Full entry text (leading `- [...]` line + continuation lines +
   *  trailing newline). */
  text: string;
  /** Parsed timestamp epoch seconds, or null when the prefix didn't
   *  match the `- [HH:MM MYT [YYYY-MM-DD]]` shape. */
  epochSec: number | null;
}

/** Parse a `## Open` body into entries. An entry starts with `- [`
 *  at column 0; everything up to (but excluding) the next `- [` line
 *  is the entry's text. Lines before the first `- [` (e.g. a blank
 *  line right after the `## Open` header) are NOT entries — they're
 *  preserved on the FIRST entry's leading position to keep byte-shape
 *  stable. Exported for unit tests.
 *
 *  `nowMs` controls today-implicit date resolution (entries with
 *  `- [HH:MM MYT]` lacking a date). Defaults to `time.now()`. */
export function parseOpenEntries(openBody: string, nowMsOverride?: number): ParsedInboxEntry[] {
  if (openBody.length === 0) return [];
  const stampMs = nowMsOverride ?? nowMs();
  const lines = openBody.split("\n");
  // Find each entry start index. Per t-754c1c57: accept BOTH list-item
  // shape (`- [HH:MM MYT...]`, lead-outbox + driver-inbox legacy) AND
  // H3-header shape (`### [HH:MM MYT...]`, unum-monorepo driver-inbox
  // 2026-05-21 convention). Use a regex that matches the timestamp
  // bracket — checkbox sub-items (`- [ ]` acceptance criteria within
  // H3 entries) won't match the `[HH:MM MYT` prefix, so they're
  // correctly excluded from the entry-start list (the pre-fix
  // `startsWith("- [")` check matched them, shredding parent H3
  // entries under --aggressive).
  const ENTRY_START_RE = /^(?:- |### )\[\d{2}:\d{2} MYT/;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ENTRY_START_RE.test(lines[i] ?? "")) starts.push(i);
  }
  if (starts.length === 0) return [];

  // openBody ends with `\n` whenever the source had non-empty content
  // before `## Archive` (per sliceOpenArchive's join + tail-`\n`). If
  // we get here with a trailing empty element from split, we drop it
  // to avoid double-newline on the last entry; we restore it via the
  // `\n` we append per-entry below.
  const trailingBlank = lines.length > 0 && lines[lines.length - 1] === "";
  const effectiveEnd = trailingBlank ? lines.length - 1 : lines.length;

  const entries: ParsedInboxEntry[] = [];
  for (let s = 0; s < starts.length; s++) {
    const startIdx = starts[s] ?? 0;
    const endIdxExclusive = s + 1 < starts.length ? (starts[s + 1] ?? effectiveEnd) : effectiveEnd;
    const slice = lines.slice(startIdx, endIdxExclusive).join("\n");
    // Re-add the trailing newline so splicing is byte-stable.
    const text = `${slice}\n`;
    const epochSec = parseEntryTimestamp(lines[startIdx] ?? "", stampMs);
    entries.push({ text, epochSec });
  }
  return entries;
}

/** Match the entry-start prefix `- [HH:MM MYT]` or
 *  `- [HH:MM MYT YYYY-MM-DD]` (with or without trailing `**member**:`).
 *  Returns epoch seconds (MYT interpreted as UTC+8) or null when the
 *  shape doesn't match. Exported for unit tests. */
export function parseEntryTimestamp(line: string, nowMs: number): number | null {
  // `- [HH:MM MYT YYYY-MM-DD]` (driver-inbox, dated form)
  // `- [HH:MM MYT]` (driver-inbox today-implicit OR lead-outbox)
  // `### [HH:MM MYT YYYY-MM-DD]` (driver-inbox H3-shaped, unum-monorepo
  //   2026-05-21 convention — same data, different markdown wrapper)
  // Per t-754c1c57.
  const m = /^(?:- |### )\[(\d{2}):(\d{2}) MYT(?: (\d{4})-(\d{2})-(\d{2}))?\]/.exec(line);
  if (m === null) return null;
  const hh = Number.parseInt(m[1] ?? "", 10);
  const mm = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  let yyyy: number;
  let mo: number;
  let dd: number;
  if (m[3] !== undefined && m[4] !== undefined && m[5] !== undefined) {
    yyyy = Number.parseInt(m[3], 10);
    mo = Number.parseInt(m[4], 10);
    dd = Number.parseInt(m[5], 10);
  } else {
    // Today-implicit — derive YYYY-MM-DD in MYT from nowMs.
    const today = mytYmd(nowMs);
    yyyy = today.y;
    mo = today.m;
    dd = today.d;
  }
  if (
    !Number.isFinite(yyyy) ||
    !Number.isFinite(mo) ||
    !Number.isFinite(dd) ||
    mo < 1 ||
    mo > 12 ||
    dd < 1 ||
    dd > 31
  ) {
    return null;
  }
  // Construct epoch from MYT (UTC+8) wall-clock. Date.UTC takes 0-indexed
  // month. MYT = UTC+8, so the UTC wall-clock for the same instant is
  // HH-8:MM on the SAME calendar date (or previous date if HH < 8).
  // Easier: build ISO string with `+08:00` offset and parse.
  const iso = `${pad4(yyyy)}-${pad2(mo)}-${pad2(dd)}T${pad2(hh)}:${pad2(mm)}:00+08:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** YYYY-MM-DD components in MYT (UTC+8) for the given epoch ms. */
function mytYmd(epochMs: number): { y: number; m: number; d: number } {
  // MYT = UTC+8, no DST. Shift epoch by +8h then read UTC components.
  const d = new Date(epochMs + 8 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
  };
}

// ---------- Sub-op 2: decisions archival ----------

export interface DecisionsArchiveResult {
  /** Number of stale blocks routed to archive across all month buckets. */
  staleBlocks: number;
  /** Per-month destination files written. */
  destPaths: string[];
}

export interface ArchiveDecisionsOpts {
  /** Threshold in days. Blocks with `- **timestamp**: <epoch>` older
   *  than `now - days*86400` get archived. Default 30. */
  days?: number;
  dryRun?: boolean;
  nowMs?: number;
}

interface ParsedDecisionsBlock {
  /** Block text including trailing newline(s). */
  text: string;
  /** Epoch seconds parsed from the `- **timestamp**: <epoch>` line, or
   *  `null` when the line is absent / unparseable. */
  epochSec: number | null;
}

/**
 * Parse decisions.md into a `preamble` (everything before the first
 * `### d-<id>` line) plus an ordered list of blocks. Each block runs
 * from a `### d-<id>` line up to (exclusive of) the next `### d-` or
 * end-of-file. Blocks without a parseable timestamp keep `epochSec:
 * null` and are NEVER archived (defensive — bash `block_epoch_set`
 * gate). Exported for unit tests.
 */
export function parseDecisionsMd(text: string): {
  preamble: string;
  blocks: ParsedDecisionsBlock[];
} {
  const lines = text.split("\n");
  const blocks: ParsedDecisionsBlock[] = [];
  let preambleEnd = -1;

  // Walk lines, splitting at each `### d-` boundary.
  type Cursor = { startIdx: number; epochSec: number | null };
  let cursor: Cursor | null = null;

  const flush = (endIdxExclusive: number): void => {
    if (cursor === null) return;
    const slice = lines.slice(cursor.startIdx, endIdxExclusive).join("\n");
    // Re-attach the trailing newline (split dropped it).
    const text = endIdxExclusive < lines.length ? `${slice}\n` : slice;
    blocks.push({ text, epochSec: cursor.epochSec });
    cursor = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("### d-")) {
      if (cursor === null && preambleEnd < 0) preambleEnd = i;
      flush(i);
      cursor = { startIdx: i, epochSec: null };
      continue;
    }
    if (cursor !== null && cursor.epochSec === null) {
      const ts = matchTimestampLine(line);
      if (ts !== null) cursor.epochSec = ts;
    }
  }
  flush(lines.length);

  const preambleLines = preambleEnd < 0 ? lines : lines.slice(0, preambleEnd);
  const preamble = preambleLines.join("\n");
  return { preamble, blocks };
}

/** Match `- **timestamp**: <epoch>` line and return the epoch seconds.
 *  Returns null when the line shape doesn't match. Tolerates trailing
 *  whitespace + non-digit suffix per bash's `sub(/[^0-9].*$/, "", ts)`. */
function matchTimestampLine(line: string): number | null {
  const m = /^- \*\*timestamp\*\*: ([0-9]+)/.exec(line);
  if (m === null) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function archiveDecisions(
  atmuxDir: string,
  opts: ArchiveDecisionsOpts = {},
): Promise<DecisionsArchiveResult> {
  const days = opts.days ?? 30;
  const dryRun = opts.dryRun === true;
  const stampMs = opts.nowMs ?? nowMs();
  const cutoffEpoch = Math.floor(stampMs / 1000) - days * 86400;
  const adir = resolveArchiveDir(atmuxDir);
  const src = join(atmuxDir, "decisions.md");

  if (!(await exists(src))) {
    return { staleBlocks: 0, destPaths: [] };
  }
  await ensureDir(adir);

  const text = await readText(src);
  const { preamble, blocks } = parseDecisionsMd(text);

  const stale: ParsedDecisionsBlock[] = [];
  const kept: ParsedDecisionsBlock[] = [];
  for (const b of blocks) {
    if (b.epochSec !== null && b.epochSec < cutoffEpoch) {
      stale.push(b);
    } else {
      kept.push(b);
    }
  }
  if (stale.length === 0) {
    return { staleBlocks: 0, destPaths: [] };
  }
  if (dryRun) {
    // Bucket by month-of-entry to surface destPaths even on dry-run.
    const months = new Set<string>();
    for (const b of stale) {
      if (b.epochSec === null) continue;
      months.add(ymStampUtc(b.epochSec * 1000));
    }
    return {
      staleBlocks: stale.length,
      destPaths: [...months].sort().map((ym) => join(adir, `decisions-${ym}.md`)),
    };
  }

  // Group stale blocks by their own entry-month.
  const buckets = new Map<string, string[]>();
  for (const b of stale) {
    if (b.epochSec === null) continue;
    const ym = ymStampUtc(b.epochSec * 1000);
    const arr = buckets.get(ym) ?? [];
    arr.push(b.text);
    buckets.set(ym, arr);
  }

  const destPaths: string[] = [];
  const runStamp = groomRunStampUtc(stampMs);
  // Sort keys for deterministic ordering across platforms (test-friendly).
  for (const ym of [...buckets.keys()].sort()) {
    const dest = join(adir, `decisions-${ym}.md`);
    const blocksText = (buckets.get(ym) ?? []).join("");
    const destExists = await exists(dest);
    const head = destExists
      ? `\n---\n\n_groom run: ${runStamp}_\n\n${blocksText}`
      : `# decisions archive — ${ym}\n\n_groom run: ${runStamp}_\n\n${blocksText}`;
    await appendText(dest, head);
    destPaths.push(dest);
  }

  // Rewrite decisions.md: preamble + kept-blocks. If everything is
  // stale, write just an empty header line per bash's fallback.
  const keptText = kept.map((b) => b.text).join("");
  if (keptText.length === 0 && preamble.replace(/\s+/g, "").length === 0) {
    await atomicWrite(src, `# atmux decisions — append-only log\n\n`);
  } else {
    await atomicWrite(src, `${preamble}${keptText}`);
  }

  return { staleBlocks: stale.length, destPaths };
}

// ---------- Sub-op 3: kanban summarize + remove ----------

export interface KanbanSummarizeResult {
  /** How many done/cancelled tasks were summarized + removed. */
  removed: number;
  /** Per-month archive files appended to. */
  destPaths: string[];
}

export interface SummarizeKanbanOpts {
  /** Threshold in days. Default 30. */
  days?: number;
  dryRun?: boolean;
  nowMs?: number;
}

/** Coerce a `completedAt` field (number | string | null) to epoch
 *  seconds, mirroring bash's `to_epoch` jq filter (numbers passthrough,
 *  strings try fromdateiso8601 then tonumber, fall back to 0). */
function toEpochSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

export async function summarizeKanban(
  atmuxDir: string,
  opts: SummarizeKanbanOpts = {},
): Promise<KanbanSummarizeResult> {
  const days = opts.days ?? 30;
  const dryRun = opts.dryRun === true;
  const stampMs = opts.nowMs ?? nowMs();
  const cutoffEpoch = Math.floor(stampMs / 1000) - days * 86400;

  const path = kanbanJsonPath(atmuxDir);
  if (!(await exists(path))) return { removed: 0, destPaths: [] };

  const adir = resolveArchiveDir(atmuxDir);
  await ensureDir(adir);

  // Read kanban via Zod; the schema is permissive (`.passthrough()`).
  const text = await readText(path);
  const parsed = Kanban.parse(JSON.parse(text));

  const stale: typeof parsed.tasks = [];
  for (const t of parsed.tasks) {
    if (t.status !== "done" && t.status !== "cancelled") continue;
    const epoch = toEpochSeconds(t.completedAt);
    if (epoch === 0) continue;
    if (epoch < cutoffEpoch) stale.push(t);
  }
  if (stale.length === 0) return { removed: 0, destPaths: [] };
  if (dryRun) {
    const months = new Set<string>();
    for (const t of stale) {
      months.add(ymStampUtc(toEpochSeconds(t.completedAt) * 1000));
    }
    return {
      removed: stale.length,
      destPaths: [...months].sort().map((ym) => join(adir, `kanban-log-${ym}.md`)),
    };
  }

  // Bucket by completedAt-month + append summary lines.
  const buckets = new Map<string, string[]>();
  for (const t of stale) {
    const completedSec = toEpochSeconds(t.completedAt);
    const ym = ymStampUtc(completedSec * 1000);
    const id = t.id;
    const status = t.status ?? "";
    const owner = (t.owner ?? "-") || "-";
    const subject = (t.subject ?? "").replace(/[\n\r\t]/g, " ");
    const cdate = ymdStampUtc(completedSec * 1000);
    const line = `- \`${id}\` [${status}] ${subject} — owner=${owner}, completed=${cdate}\n`;
    const arr = buckets.get(ym) ?? [];
    arr.push(line);
    buckets.set(ym, arr);
  }

  const destPaths: string[] = [];
  const runStamp = groomRunStampUtc(stampMs);
  for (const ym of [...buckets.keys()].sort()) {
    const dest = join(adir, `kanban-log-${ym}.md`);
    const lines = (buckets.get(ym) ?? []).join("");
    const destExists = await exists(dest);
    const head = destExists
      ? `\n---\n\n_groom run: ${runStamp}_\n\n${lines}`
      : `# kanban summary — ${ym}\n\n_groom run: ${runStamp}_\n\n${lines}`;
    await appendText(dest, head);
    destPaths.push(dest);
  }

  // Backup kanban.json before destructive rewrite (groom-side bak,
  // matches bash `atmux::kanban_json_backup`). Naming: `<path>.bak.<epoch>`
  // — bak-cull walks `kanban.json.bak.*` glob.
  const backupPath = `${path}.bak.${Math.floor(stampMs / 1000)}`;
  if (!(await exists(backupPath))) {
    await writeText(backupPath, text);
  }

  // Rewrite kanban.json without the stale tasks (passthrough preserves
  // unknown fields; we only filter on .tasks).
  const staleIds = new Set(stale.map((t) => t.id));
  await updateJson(path, Kanban, (current) => ({
    ...current,
    tasks: current.tasks.filter((t) => !staleIds.has(t.id)),
  }));

  return { removed: stale.length, destPaths };
}

// ---------- Sub-op 4: bak cull ----------

export interface BakCullResult {
  family: string;
  /** Files that were (or would be) deleted; newest-first per bash `ls -t`. */
  removed: string[];
}

export interface CullBakOpts {
  keep?: number;
  dryRun?: boolean;
  /** Test injection — override the family list. Defaults to the bash
   *  pair `["kanban.json", "team.json"]`. */
  families?: ReadonlyArray<string>;
}

export async function cullBakFiles(
  atmuxDir: string,
  opts: CullBakOpts = {},
): Promise<BakCullResult[]> {
  const keep = opts.keep ?? 5;
  const dryRun = opts.dryRun === true;
  const families = opts.families ?? ["kanban.json", "team.json"];
  const out: BakCullResult[] = [];

  if (keep < 0) return out;

  const all = await readdir(atmuxDir).catch(() => [] as string[]);
  for (const family of families) {
    const prefix = `${family}.bak.`;
    const matches: { name: string; mtimeMs: number }[] = [];
    for (const name of all) {
      if (!name.startsWith(prefix)) continue;
      const full = join(atmuxDir, name);
      const st = await statOrNull(full);
      if (st === null || !st.isFile) continue;
      matches.push({ name, mtimeMs: st.mtimeMs });
    }
    if (matches.length <= keep) continue;
    // Newest-first ordering, like bash `ls -t`.
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toRemove = matches.slice(keep);
    const removed: string[] = [];
    for (const m of toRemove) {
      const full = join(atmuxDir, m.name);
      if (!dryRun) await removeFile(full);
      removed.push(full);
    }
    if (removed.length > 0) out.push({ family, removed });
  }
  return out;
}

// ---------- Sub-op 5: archive size guard ----------

export interface ArchiveSizeWarning {
  /** Human-readable subject — `archive` or `kanban-log`. */
  scope: "archive" | "kanban-log";
  /** Total bytes observed. */
  bytes: number;
  /** Number of files contributing (kanban-log: month buckets). */
  fileCount: number;
  /** Threshold (bytes) the scope crossed. */
  thresholdBytes: number;
}

export interface ArchiveSizeOpts {
  /** Bytes — total archive/ warns at this floor. Default 50MB. */
  archiveCapBytes?: number;
  /** Bytes — sum of kanban-log-*.md warns at this floor. Default 5MB. */
  kanbanLogCapBytes?: number;
}

/**
 * Walk archive/ and return zero or more warnings. Non-fatal — caller
 * surfaces via `logger.warn`. Returns empty array when archive/ is
 * absent (cold-start state).
 */
export async function archiveSizeCheck(
  atmuxDir: string,
  opts: ArchiveSizeOpts = {},
): Promise<ArchiveSizeWarning[]> {
  const archiveCap = opts.archiveCapBytes ?? 50 * 1024 * 1024;
  const kanbanLogCap = opts.kanbanLogCapBytes ?? 5 * 1024 * 1024;
  const adir = resolveArchiveDir(atmuxDir);
  if (!(await exists(adir))) return [];

  const out: ArchiveSizeWarning[] = [];

  // Recurse archive/ to total bytes; archive/ is shallow (per bash
  // ouput shape — month-stamped flat files), but we walk recursively
  // to be defensive.
  const total = await sumDirBytes(adir);
  if (total.bytes >= archiveCap) {
    out.push({
      scope: "archive",
      bytes: total.bytes,
      fileCount: total.files,
      thresholdBytes: archiveCap,
    });
  }

  const klogs: { path: string; size: number }[] = [];
  for (const name of await readdir(adir).catch(() => [])) {
    if (!name.startsWith("kanban-log-") || !name.endsWith(".md")) continue;
    const full = join(adir, name);
    const st = await statOrNull(full);
    if (st === null || !st.isFile) continue;
    klogs.push({ path: full, size: st.size });
  }
  if (klogs.length > 0) {
    const klogTotal = klogs.reduce((acc, k) => acc + k.size, 0);
    if (klogTotal >= kanbanLogCap) {
      out.push({
        scope: "kanban-log",
        bytes: klogTotal,
        fileCount: klogs.length,
        thresholdBytes: kanbanLogCap,
      });
    }
  }

  return out;
}

async function sumDirBytes(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    const entries = await readdir(cur, { withFileTypes: true }).catch(() => null);
    if (entries === null) continue;
    for (const ent of entries) {
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        const st = await statOrNull(full);
        if (st !== null) {
          bytes += st.size;
          files += 1;
        }
      }
    }
  }
  return { bytes, files };
}

// ---------- Sub-op 6: zombie tmux socket sweep ----------
//
// Closes the SIGKILL-bypass arm (b) of complaint c-4698c603.
// t-88b60ca7 shipped arm (a) — module-level fixture registry +
// `process.on('exit')` + `afterAll` sweep in
// `tests/unit/verbs/cockpit.test.ts`. That defense covers
// throw / unhandled-rejection escape paths inside bun-test's own
// process lifecycle. It does NOT cover SIGKILL on the bun-test
// process itself (e.g. BashTool wrapper timeout per CLAUDE.md §`bun
// test` orphan rule) — no userland exit hook fires under SIGKILL,
// so the fixture's mkdtemp'd tmux socket dir + tmux server leak.
//
// This sub-op is the housekeeping defense-in-depth: walk
// `os.tmpdir()` for fixture-shape `atmux-*-…` directories older than
// `minAgeMs` (default 6h), kill any tmux server bound to a socket
// inside, then `rm -rf` the directory.
//
// Naming pattern: `^atmux-(cockpit-)?[^/]+-` per Task body
// t-0027eec3. The mandatory trailing `-…` filters out production
// cage dirs (e.g. `/tmp/atmux-atmux/sock`) which lack the mkdtemp
// random suffix; only test fixture dirs (e.g.
// `/tmp/atmux-cockpit-cockpit-reb-sd-XXXXXX/`) match.
//
// Idempotent — re-running on the same set is a no-op (already-cleaned
// dirs are absent on the second walk; `tmux kill-server` against a
// non-existent socket returns non-zero but is harmless and tolerated).
//
// Opt-in via `--zombie-sweep` flag on the groom verb. Default-OFF on
// the cron path for v1 (safer); follow-up Task can flip to
// default-on once N weeks of opt-in production confirm no
// false-positive deletes.

/** Sweep result — counts + per-dir error log. */
export interface ZombieSweepResult {
  /** Candidate fixture dirs that matched the regex AND were old
   *  enough (>= minAgeMs). Excludes those skipped by the dryRun flag. */
  scanned: number;
  /** Subset of `scanned` where at least one `tmux kill-server` was
   *  attempted against a discovered socket. Idempotent re-runs may
   *  bump this by 0 (sockets already absent). */
  killed: number;
  /** Subset of `scanned` where the parent dir was successfully
   *  removed. */
  removed: number;
  /** ADR-252 (t-65bec10b), generalised by ADR-280 stage 3: subset of
   *  `scanned` SKIPPED — neither killed nor removed — because
   *  `hasLiveChildCages` reported a live NESTED cage under `<dir>`.
   *  Structural guard against orphaning live children when a parent
   *  tmpdir is swept. */
  skippedLiveChildren: number;
  /** Per-dir errors that did NOT abort the sweep. */
  errors: { path: string; message: string }[];
}

export interface SweepZombieSocketsOpts {
  /** Override `os.tmpdir()`. Test injection point. */
  tmpDir?: string;
  /** Min age before a dir is considered zombie. Default 6h. */
  minAgeMs?: number;
  /** Clock override (test injection). Defaults to `time.now()`. */
  nowMs?: number;
  /** When true, scans + reports counts but does NOT kill or remove. */
  dryRun?: boolean;
  /** Test injection — replace the tmux kill-server call. Production
   *  uses `createTmux({ socketPath }).server.killServer()`. */
  killServer?: (socketPath: string) => Promise<void>;
  /** ADR-252 (t-65bec10b) test seam — live-child-cage guard. Default:
   *  real {@link hasLiveChildCages}. Returns `true` when a nested cage
   *  under `<dir>` is live ⇒ the sweep SKIPS removing that parent dir
   *  (no kill, no rm) and bumps `skippedLiveChildren`. */
  hasLiveChildren?: (parentTmpdir: string) => Promise<boolean>;
}

/** Fixture-shape regex: trailing `-…` is the mkdtemp random suffix
 *  that production cage dirs (e.g. `/tmp/atmux-atmux`) lack. The
 *  `(cockpit-)?` group covers `atmux-cockpit-<name>-…` test patterns
 *  per the c-4698c603 (b) arm proposal. */
const ZOMBIE_FIXTURE_PATTERN = /^atmux-(cockpit-)?[^/]+-[^/]+$/;

/** Production dir prefixes this sweep must NEVER classify as a fixture,
 *  however fixture-shaped their names look.
 *
 *  `atmux-grp-<group>` is a live GROUP SERVER socket dir
 *  (`groupSocketPath`, e-419553c6 2026-08-28). It is two segments after
 *  `atmux-`, so {@link ZOMBIE_FIXTURE_PATTERN} matches it — and the
 *  live-child guard below does NOT save it, because that guard looks for
 *  a nested `<dir>/tmux-<uid>/default` cage and a group dir contains only
 *  `sock`. On @@mbp 2026-09-04 all three of `atmux-grp-geoyws`,
 *  `-ifca` and `-unum` matched, were 12h old (past the 6h floor) and had
 *  zero nested cages: `groom --zombie-sweep` would have killed all three
 *  live group servers.
 *
 *  This is a case of a later feature invalidating an earlier stated
 *  safety argument. The comment on the live-child guard reasons that the
 *  pattern "already excludes the canonical parent dir /tmp/atmux-atmux
 *  (no trailing-hyphen suffix), so this sweep can't reach it today" —
 *  true for `atmux-<team>`, and silently untrue once `atmux-grp-<group>`
 *  existed.
 *
 *  Why an explicit prefix list rather than a smarter shape test: the
 *  suffixes are genuinely indistinguishable. `mkdtemp` yields
 *  `atmux-start-sock-NMThvC`; a real group yields `atmux-grp-geoyws`.
 *  Both are six alphanumeric characters. No regex over the NAME can tell
 *  a random suffix from a short group name, so the production namespace
 *  has to be named. Keep this in sync with any new `/tmp/atmux-*` dir
 *  shape that is not a test fixture. */
const PRODUCTION_DIR_PREFIXES: ReadonlyArray<string> = ["atmux-grp-"];

/** True when `name` is a production socket dir the sweep must skip. */
export function isProductionSocketDir(name: string): boolean {
  return PRODUCTION_DIR_PREFIXES.some((p) => name.startsWith(p));
}

/** 6h default — short enough to drain typical CI rounds, long enough
 *  that a stale-looking fixture dir at minute 5h59 of an actively-
 *  running spec doesn't get nuked mid-test. */
const DEFAULT_ZOMBIE_MIN_AGE_MS = 6 * 60 * 60 * 1000;

export async function sweepZombieTmuxSockets(
  opts: SweepZombieSocketsOpts = {},
): Promise<ZombieSweepResult> {
  const dirRoot = opts.tmpDir ?? tmpdir();
  const minAgeMs = opts.minAgeMs ?? DEFAULT_ZOMBIE_MIN_AGE_MS;
  const now = opts.nowMs ?? nowMs();
  const dryRun = opts.dryRun === true;
  const killServer = opts.killServer ?? defaultKillServer;
  const hasLiveChildren = opts.hasLiveChildren ?? hasLiveChildCages;

  const result: ZombieSweepResult = {
    scanned: 0,
    killed: 0,
    removed: 0,
    skippedLiveChildren: 0,
    errors: [],
  };

  const entries = await readdir(dirRoot, { withFileTypes: true }).catch(() => null);
  if (entries === null) return result;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!ZOMBIE_FIXTURE_PATTERN.test(ent.name)) continue;
    // Production namespaces are excluded BEFORE the age and live-child
    // gates, so no combination of mtime or emptiness can reach them.
    if (isProductionSocketDir(ent.name)) continue;

    const full = join(dirRoot, ent.name);
    const st = await statOrNull(full);
    if (st === null) continue;
    if (now - st.mtimeMs < minAgeMs) continue;

    result.scanned += 1;

    // ADR-252 (t-65bec10b) — structural live-child-cage guard, generalised
    // past epic-teams by ADR-280 stage 3. BEFORE any kill/rm, refuse to
    // touch a parent tmpdir that hosts a LIVE nested cage at
    // `<full>/…/tmux-<uid>/default`. The 2026-05-17 P0 class: a probe found
    // the parent's OWN socket dead, declared the whole `/tmp/atmux-<parent>/`
    // dir an orphan, and `rm -rf`'d it — taking its live children with it.
    // The epic-team instance that motivated the guard is retired; nested
    // cages are not (ADR-089 §Amendment 2026-08-27 §(A) makes nesting the
    // general model), so the invariant stands and the glob is structural
    // rather than name-based. Belt-and-suspenders: ZOMBIE_FIXTURE_PATTERN
    // already excludes the canonical parent dir `/tmp/atmux-atmux` (no
    // trailing-hyphen suffix), so this sweep can't reach it today — but
    // this guard protects ANY team whose tmpdir DOES match the fixture
    // pattern AND happens to host nested cages, and hardens this removal
    // path against future regressions. `hasLiveChildren` is fail-SAFE: on
    // any uncertainty it returns true ⇒ we skip removal.
    if (!dryRun && (await hasLiveChildren(full))) {
      result.skippedLiveChildren += 1;
      continue;
    }

    // Find sockets inside this dir. Two canonical shapes:
    //   - `<full>/sock`            (atmux default cage convention per
    //                               getDefaultSocket — `/tmp/atmux-<team>/sock`)
    //   - `<full>/tmux-<uid>/default` (resolveTeamSocket with explicit
    //                               team.tmuxTmpdir — `<tmpdir>/tmux-<uid>/default`)
    const sockets: string[] = [];
    const directSock = join(full, "sock");
    if ((await statOrNull(directSock)) !== null) sockets.push(directSock);
    const sub = await readdir(full, { withFileTypes: true }).catch(() => []);
    for (const s of sub) {
      if (s.isDirectory() && s.name.startsWith("tmux-")) {
        const def = join(full, s.name, "default");
        if ((await statOrNull(def)) !== null) sockets.push(def);
      }
    }

    if (dryRun) continue;

    let attemptedKill = false;
    for (const sock of sockets) {
      try {
        await killServer(sock);
        attemptedKill = true;
      } catch (e) {
        // tmux kill-server against a non-existent server returns
        // non-zero; tolerated. Surface only unexpected errors.
        if (!isExpectedKillError(e)) {
          result.errors.push({ path: sock, message: errMsg(e) });
        }
      }
    }
    if (attemptedKill) result.killed += 1;

    try {
      await rm(full, { recursive: true, force: true });
      result.removed += 1;
    } catch (e) {
      result.errors.push({ path: full, message: errMsg(e) });
    }
  }

  return result;
}

/** Production kill-server: spawn `tmux -S <sock> kill-server` via
 *  the canonical tmux abstraction. Failures bubble up; the caller
 *  filters expected "no server" errors via `isExpectedKillError`. */
async function defaultKillServer(socketPath: string): Promise<void> {
  const tmux = createTmux({ socketPath });
  await tmux.server.killServer();
}

/** True for the "no server running at socket" failure shape that's
 *  the EXPECTED idempotent-re-run case. Other errors (permissions,
 *  garbled socket) surface to the result. */
function isExpectedKillError(e: unknown): boolean {
  const msg = errMsg(e).toLowerCase();
  return (
    msg.includes("no server running") ||
    msg.includes("server not found") ||
    msg.includes("no such file") ||
    msg.includes("connection refused")
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
