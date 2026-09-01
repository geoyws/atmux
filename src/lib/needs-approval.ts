// ADR-085 §Scan API — surface paperwork debt across three buckets:
//   A. Proposed ADRs (docs/adr/*.md with
//      `^**Status**: (proposed|draft|wip|pending)` and no
//      `(deferred: <reason>)` suffix).
//   B. Untriaged driver-inbox asks (heading w/o ✅/📤/⏳/❌ marker in
//      heading text OR first 20 non-blank lines of section body;
//      ageMin > 30 from the heading's `HH:MM MYT` stamp).
//   C. Long-blocked kanban tasks (status=blocked, ageMin > 120 since
//      most recent state transition — claimedAt with createdAt fallback).
//
// Live-not-cached per ADR-068 §HC#4: every invocation re-reads all three
// surfaces from disk / SQLite. Tests inject `ScanDeps` to mock fs +
// clock + kanban without touching real state.

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readTextOrNull, statOrNull } from "../abstractions/fs.ts";
import { driverInboxPath, getAtmuxDir } from "../core/common.ts";
import { parseEntries } from "../core/driver-inbox.ts";
import { listTasks } from "../core/kanban.ts";
import type { KanbanTask } from "../schema/kanban.ts";

// ---------- Public types (ADR-085 §Scan API) ----------

export interface NeedsApprovalEntry {
  /** Source bucket — one of the three approval-debt classes. */
  bucket: "adr" | "inbox" | "kanban";
  /** ADR slug / heading anchor / task-id. Stable identifier within bucket. */
  id: string;
  /** File path the entry lives in. Drives `atmux status --json`
   *  click-through + reviewer audit trail. */
  path: string;
  /** Heading text / task subject — truncated to ≤80 chars (CLAUDE.md
   *  Discord 80-char verdict line). Trailing whitespace stripped. */
  subject: string;
  /** Minutes since the source timestamp. Bucket A uses file mtime
   *  (no heading-style timestamp in ADR bodies); bucket B uses the
   *  heading's `HH:MM MYT` stamp; bucket C uses last state transition. */
  ageMin: number;
}

export interface NeedsApprovalReport {
  adr: NeedsApprovalEntry[];
  inbox: NeedsApprovalEntry[];
  kanban: NeedsApprovalEntry[];
  /** `adr.length + inbox.length + kanban.length` — pre-computed for the
   *  `count > 0` skip-the-ping gate in whip's Discord template. */
  total: number;
}

export interface ScanDeps {
  /** fs surface — defaults to `node:fs/promises::readdir` + the project's
   *  `readTextOrNull` / `statOrNull` abstractions. Tests inject a fake. */
  fs?: ScanFs;
  /** `() => epochSecondsNow`. Default `Date.now() / 1000 | 0`. */
  clock?: () => number;
  /** Kanban reader. Default = the real SQLite-backed `listTasks` filtered
   *  to `status: "blocked"`. Tests pass a stub returning a fixed list. */
  kanban?: ScanKanban;
  /** Override the project root (`.atmux/` containing dir). Default =
   *  walk up from cwd via `getAtmuxDir`-then-strip. */
  projectRoot?: string;
}

export interface ScanFs {
  /** List directory entries (names only, non-recursive). Resolves to
   *  `null` when the path is absent — caller treats null identically to
   *  empty array. */
  listDir(path: string): Promise<string[] | null>;
  /** Read a file's text contents, or `null` when absent. */
  readText(path: string): Promise<string | null>;
  /** mtime epoch seconds, or `null` when absent. Used for bucket A's
   *  ageMin (ADRs don't carry per-entry timestamps in the body). */
  mtimeSec(path: string): Promise<number | null>;
}

export interface ScanKanban {
  /** Return all tasks with `status === "blocked"`. Live read per
   *  ADR-068 §HC#4. */
  listBlocked(atmuxDir: string): Promise<KanbanTask[]>;
}

// ---------- Constants ----------

/** Bucket A: matches the `Status:` line of an ADR markdown body. Tolerant
 *  of optional bold-markdown around `Status` (`**Status**:` form is the
 *  convention; bare `Status:` is also accepted for forward-compat). */
const STATUS_RE = /^(?:\*\*Status\*\*|Status):\s*(proposed|draft|wip|pending)\b/im;

/** Bucket A escape hatch — `(deferred: <reason>)` after the status word.
 *  ADR author wanting a long-lived `proposed` state writes this; reviewer
 *  enforces a non-empty reason at ADR-write time. */
const DEFERRED_SUFFIX_RE = /\(deferred:\s*[^)]+\)/i;

/** Bucket B: triage markers. The 4 emojis indicate the lead / driver has
 *  arbitrated the ask. NOT 🚨 / 🪫 — those are CATEGORY markers (P0,
 *  budget-pause) per ADR-085 §Heading-marker grammar. */
const TRIAGE_MARKERS = ["✅", "📤", "⏳", "❌"];

/** Bucket B stale threshold (min). Lead's whip cycle is 5 min ⇒ a 30-min
 *  unmarked ask = lead saw it 6 times without triaging. Rot signal. */
const INBOX_STALE_MIN = 30;

/** Bucket C stale threshold (min). Empirically: most blockers resolve
 *  faster than 2h; >2h indicates coordination gap, not "in flight." */
const KANBAN_STALE_MIN = 120;

/** Bucket B body-window. We check the heading text + the first 20
 *  non-blank lines of the section body. Beyond 20, the entry is verbose
 *  (long debug paste) and the marker is presumed missing — surface it. */
const INBOX_BODY_WINDOW = 20;

/** ADR-085 §Subject hygiene: keep `subject` ≤80 chars (CLAUDE.md Discord
 *  verdict-line ceiling). Slice + ellipsis when over. */
const SUBJECT_MAX = 80;

// ---------- Public entry ----------

/**
 * Top-level scan. Three independent bucket reads run concurrently; any
 * single-bucket failure (corrupt ADR, missing inbox, kanban absent)
 * degrades to an empty bucket rather than failing the whole report.
 *
 * Live per ADR-068 §HC#4 — no caching anywhere in the call chain.
 */
export async function scanNeedsApproval(deps: ScanDeps = {}): Promise<NeedsApprovalReport> {
  const fs = deps.fs ?? defaultScanFs();
  const clock = deps.clock ?? defaultClock;
  const kanban = deps.kanban ?? defaultScanKanban();
  const projectRoot = deps.projectRoot ?? (await resolveProjectRoot());

  const [adr, inbox, kanbanRows] = await Promise.all([
    scanProposedAdrs(projectRoot, fs, clock).catch(() => [] as NeedsApprovalEntry[]),
    scanInboxAsks(projectRoot, fs, clock).catch(() => [] as NeedsApprovalEntry[]),
    scanBlockedTasks(projectRoot, kanban, clock).catch(() => [] as NeedsApprovalEntry[]),
  ]);

  return {
    adr,
    inbox,
    kanban: kanbanRows,
    total: adr.length + inbox.length + kanbanRows.length,
  };
}

// ---------- Bucket A: ADRs ----------

/**
 * Read `docs/adr/*.md`, surface the ones
 * with `^**Status**: (proposed|draft|wip|pending)` AND no
 * `(deferred: <reason>)` suffix.
 *
 * ADR id := the filename without `.md` (e.g. `085-whip-approvals-watcher`).
 * Path is the absolute file path. Subject is the first `^# ` heading,
 * truncated to 80 chars; if no `# ` heading, fall back to the file slug.
 * ageMin uses file mtime (ADR bodies don't carry per-entry timestamps).
 */
export async function scanProposedAdrs(
  projectRoot: string,
  fs: ScanFs,
  clock: () => number,
): Promise<NeedsApprovalEntry[]> {
  const dirs = [join(projectRoot, "docs", "adr")];
  const out: NeedsApprovalEntry[] = [];
  const now = clock();

  for (const dir of dirs) {
    const entries = await fs.listDir(dir);
    if (entries === null) continue;
    const mdFiles = entries.filter((n) => n.endsWith(".md")).sort();
    for (const name of mdFiles) {
      const path = join(dir, name);
      const text = await fs.readText(path);
      if (text === null) continue;
      // Pull the Status: line in full to test for `(deferred: ...)`. The
      // suffix can appear anywhere on the same line — match by line, not
      // by capture-group offset.
      const statusLine = extractStatusLine(text);
      if (statusLine === null) continue;
      if (DEFERRED_SUFFIX_RE.test(statusLine)) continue;

      const mtimeSec = await fs.mtimeSec(path);
      const ageMin = mtimeSec === null ? 0 : Math.max(0, Math.floor((now - mtimeSec) / 60));
      const subject = extractAdrSubject(text, name);
      out.push({
        bucket: "adr",
        id: name.replace(/\.md$/, ""),
        path,
        subject,
        ageMin,
      });
    }
  }
  return out;
}

/** First match of `^(?:**Status**|Status):...` returned in full. */
function extractStatusLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (STATUS_RE.test(line)) return line;
  }
  return null;
}

/** First `^# ` heading text, ≤80 chars. Falls back to the file slug
 *  stripped of the leading `NNN-` numeric prefix. */
function extractAdrSubject(text: string, filename: string): string {
  for (const line of text.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m !== null) return truncSubject(m[1] ?? filename);
  }
  return truncSubject(filename.replace(/\.md$/, "").replace(/^\d+-/, ""));
}

// ---------- Bucket B: untriaged driver-inbox asks ----------

/**
 * Parse `.atmux/driver-inbox.md`, walk each `## HH:MM MYT ...` heading,
 * decide whether it's triaged (✅/📤/⏳/❌ in heading or first 20 body
 * lines), compute ageMin from the heading timestamp. Stale ⇔ untriaged
 * AND ageMin > 30.
 *
 * Reuses `parseEntries` from `core/driver-inbox.ts` so the heading
 * grammar stays single-sourced.
 */
export async function scanInboxAsks(
  projectRoot: string,
  fs: ScanFs,
  clock: () => number,
): Promise<NeedsApprovalEntry[]> {
  const path = driverInboxPath(join(projectRoot, ".atmux"));
  const text = await fs.readText(path);
  if (text === null) return [];
  const now = clock();
  const entries = parseEntries(text, now);
  const out: NeedsApprovalEntry[] = [];
  for (const entry of entries) {
    if (isTriaged(entry.head, entry.body)) continue;
    // Per ADR-085: stale ⇔ marker absent AND ageMin>30. Undated entries
    // (tsEpochSec === null) ALWAYS surface (per parseEntries doc; an
    // unparseable timestamp is a structural problem worth flagging).
    if (entry.tsEpochSec !== null) {
      const ageMin = Math.floor((now - entry.tsEpochSec) / 60);
      if (ageMin <= INBOX_STALE_MIN) continue;
    }
    const ageMin =
      entry.tsEpochSec === null ? 0 : Math.max(0, Math.floor((now - entry.tsEpochSec) / 60));
    out.push({
      bucket: "inbox",
      id: deriveHeadingAnchor(entry.head),
      path,
      subject: truncSubject(entry.head.replace(/^##\s+/, "").replace(/^-\s+\[[^\]]+\]\s*/, "")),
      ageMin,
    });
  }
  return out;
}

/** True iff the heading or first INBOX_BODY_WINDOW non-blank body lines
 *  contain at least one of ✅ / 📤 / ⏳ / ❌. The 🚨 / 🪫 emojis are
 *  CATEGORY markers (P0 / budget-pause) and explicitly DO NOT count as
 *  triage — see ADR-085 §Heading-marker grammar. */
function isTriaged(head: string, body: string): boolean {
  if (containsAny(head, TRIAGE_MARKERS)) return true;
  // The body string starts with the head line itself (parseEntries
  // returns head + body joined). Skip the head line; then walk the
  // first INBOX_BODY_WINDOW non-blank lines.
  const lines = body.split("\n").slice(1);
  let nonBlank = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    nonBlank += 1;
    if (containsAny(line, TRIAGE_MARKERS)) return true;
    if (nonBlank >= INBOX_BODY_WINDOW) break;
  }
  return false;
}

function containsAny(s: string, needles: ReadonlyArray<string>): boolean {
  for (const n of needles) {
    if (s.includes(n)) return true;
  }
  return false;
}

/** Anchor-style id from a heading line. Lowercase, alnum-or-hyphen,
 *  collapsed. Used as `NeedsApprovalEntry.id` so two entries with the
 *  same timestamp (rare but possible) still get distinct ids. */
function deriveHeadingAnchor(head: string): string {
  const stripped = head
    .replace(/^##\s+/, "")
    .replace(/^-\s+\[[^\]]+\]\s*/, "")
    .toLowerCase();
  return (
    stripped
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

// ---------- Bucket C: blocked tasks ----------

/**
 * Query kanban for `status === "blocked"` rows, compute ageMin from the
 * most recent state transition (`claimedAt` if set, else `createdAt`),
 * surface those with ageMin > 120.
 *
 * `subject` is the task's own subject field (truncated). Path points at
 * the SQLite DB — there's no per-task file; the click-through is via
 * `atmux task show <id>`.
 */
export async function scanBlockedTasks(
  projectRoot: string,
  kanban: ScanKanban,
  clock: () => number,
): Promise<NeedsApprovalEntry[]> {
  const atmuxDir = join(projectRoot, ".atmux");
  const dbPath = join(atmuxDir, "state.db");
  const rows = await kanban.listBlocked(atmuxDir);
  const now = clock();
  const out: NeedsApprovalEntry[] = [];
  for (const t of rows) {
    const ts = t.claimedAt ?? t.createdAt ?? null;
    if (ts === null) continue;
    const ageMin = Math.max(0, Math.floor((now - ts) / 60));
    if (ageMin <= KANBAN_STALE_MIN) continue;
    out.push({
      bucket: "kanban",
      id: t.id,
      path: dbPath,
      subject: truncSubject(t.subject ?? t.id),
      ageMin,
    });
  }
  return out;
}

// ---------- Defaults ----------

/** Real `node:fs`-backed implementation. */
export function defaultScanFs(): ScanFs {
  return {
    async listDir(path: string): Promise<string[] | null> {
      try {
        return await readdir(path);
      } catch {
        // ENOENT / ENOTDIR / permission — treat as absent.
        return null;
      }
    },
    readText: readTextOrNull,
    async mtimeSec(path: string): Promise<number | null> {
      const s = await statOrNull(path);
      return s === null ? null : Math.floor(s.mtimeMs / 1000);
    },
  };
}

/** Production kanban reader — defers to the SQLite-backed `listTasks`. */
export function defaultScanKanban(): ScanKanban {
  return {
    async listBlocked(atmuxDir: string): Promise<KanbanTask[]> {
      return await listTasks(atmuxDir, { status: "blocked" });
    },
  };
}

/** Default epoch-seconds clock. */
export function defaultClock(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The project root that owns an `.atmux` directory — i.e. the directory
 * CONTAINING it. Falls back to `"/"` when the strip would yield empty.
 *
 * Exported because callers that already hold the team's `atmuxDir` must
 * pass `projectRoot` in rather than let {@link resolveProjectRoot} guess:
 * the guess walks up from `process.cwd()` and so describes whoever is
 * CALLING, not the team being scanned. `atmux status --team-dir <other>`
 * is exactly that case.
 */
export function projectRootFromAtmuxDir(atmuxDir: string): string {
  return atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
}

/** Walk up from cwd, locate the project root. Only correct when the caller
 *  IS standing in the team it is asking about — callers holding an
 *  `atmuxDir` pass `deps.projectRoot` instead. */
async function resolveProjectRoot(): Promise<string> {
  return projectRootFromAtmuxDir(await getAtmuxDir());
}

// ---------- Internals ----------

/** Slice with ellipsis when over `SUBJECT_MAX`. Trailing whitespace
 *  stripped in either branch. */
function truncSubject(s: string): string {
  const t = s.trim();
  if (t.length <= SUBJECT_MAX) return t;
  return `${t.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

// `basename` is imported to keep the path-derivation site obvious even
// though no public-facing API uses it directly — kept for the test
// helpers in `tests/unit/lib/needs-approval.test.ts` that mirror the
// production fs layout.
export const _internal = { basename };
