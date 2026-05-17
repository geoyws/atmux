// ADR-147 §D4 / T5: day-bucketed release-notes writer.
//
// Single-file-per-day Markdown with append-only sections:
//   docs/release-notes/<YYYY>/<MM>/<YYYY-MM-DD>.md
//
// Section ownership (per ADR-147 §D4):
//   ## Shipped (kanban→done)           ← gitter post-fan-in / hygiene-tick
//   ## Merges (branch→trunk)           ← gitter post-trunk-merge (ADR-145+146)
//   ## ADRs landed                     ← hygiene-tick on new docs/adr/*.md
//   ## Complaints adjudicated          ← ombudsman per §D3
//   ## Doctor regressions (optional)   ← medic on red-row escalation
//   ## Notes (optional)                ← operator-curated
//
// Concurrency: ADR-147 §D4 claims "no locking needed — append-only at
// section anchors." That's true for tail-append but NOT for the
// read-modify-write we need here (find header → splice entry → write).
// Two concurrent writers reading the same baseline would clobber each
// other. We acquire a per-file lock via `withLock(<path>.lock, ...)` so
// the concurrent-append acceptance test in T5 holds deterministically.

import { dirname, join } from "node:path";
import { readTextOrNull, writeText } from "./fs.ts";
import { withLock } from "./lock.ts";
import { mytDate, now } from "./time.ts";

// ---------- Section taxonomy ----------

/**
 * Canonical release-notes section headers per ADR-147 §D4. The literal
 * type doubles as runtime input validation: passing any other string
 * is a compile-time error (and a `appendSection` call-site rejection
 * via the function's parameter typing).
 *
 * The `(optional)` suffix on "Doctor regressions" / "Notes" mirrors the
 * ADR; it's part of the H2 string the section header is matched on.
 */
export type ReleaseNotesSection =
  | "Shipped (kanban→done)"
  | "Merges (branch→trunk)"
  | "ADRs landed"
  | "Complaints adjudicated"
  | "Doctor regressions (optional)"
  | "Notes (optional)";

/** Skeleton sections in render order (matches ADR-147 §D4 file structure). */
const SECTION_ORDER: ReadonlyArray<ReleaseNotesSection> = [
  "Shipped (kanban→done)",
  "Merges (branch→trunk)",
  "ADRs landed",
  "Complaints adjudicated",
  "Doctor regressions (optional)",
  "Notes (optional)",
];

// ---------- Path resolution ----------

export interface ResolveOpts {
  /** Repository root. Defaults to `process.cwd()`. Tests pass a
   *  scratch dir so writes land in a tmpdir, not the live tree. */
  repoRoot?: string;
}

/**
 * Resolve the day-file path for the MYT-day containing `epochMs`.
 * Returns an absolute path; does NOT touch the filesystem.
 *
 * Example: 2026-05-15 03:00 MYT → `<repoRoot>/docs/release-notes/2026/05/2026-05-15.md`.
 */
export function resolveDayFilePath(epochMs: number = now(), opts: ResolveOpts = {}): string {
  const { year, month, iso } = mytDate(epochMs);
  const repoRoot = opts.repoRoot ?? process.cwd();
  return join(repoRoot, "docs", "release-notes", year, month, `${iso}.md`);
}

// ---------- Skeleton ----------

/** Render the empty skeleton for a fresh day-file. */
function renderSkeleton(isoDate: string): string {
  const lines: string[] = [`# ${isoDate}`, ""];
  for (const section of SECTION_ORDER) {
    lines.push(`## ${section}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Idempotent create-on-miss. If the day-file already exists, returns
 * its path unchanged. Otherwise writes the full skeleton (every
 * section header, empty body under each).
 *
 * Race-safe via `withLock` — two concurrent first-callers will not
 * race-create with partial / clobbered content.
 */
export async function ensureDayFile(
  epochMs: number = now(),
  opts: ResolveOpts = {},
): Promise<string> {
  const path = resolveDayFilePath(epochMs, opts);
  const { iso } = mytDate(epochMs);
  await withLock(`${path}.lock`, async () => {
    const existing = await readTextOrNull(path);
    if (existing !== null) return;
    await writeText(path, renderSkeleton(iso));
  });
  return path;
}

// ---------- appendSection ----------

export interface AppendSectionOpts extends ResolveOpts {
  /** Multi-team mode (ADR-147 §D6). When set, the entry lands inside a
   *  `### <teamName>` sub-section within the target H2. Single-team
   *  callers (atmux today) omit and entries go directly under the H2. */
  teamName?: string;
}

/**
 * Append an entry to a release-notes section. Creates the day-file
 * with skeleton if absent (delegating to `ensureDayFile`).
 *
 * `entry` is the raw entry body — typically a bullet line
 * (`- t-xxxxxxxx — <subject> — SHA <hash>`). Callers retain full
 * control over the bullet shape; this helper only handles header
 * targeting + race-safe insertion.
 *
 * Insertion rules:
 *   - Single-team (no `teamName`): insert entry as the last line of the
 *     section's body, before the next H2 header (or EOF).
 *   - Multi-team (`teamName` set): find or create a `### <teamName>`
 *     H3 under the section, insert entry as the last line of that
 *     sub-section's body before the next H3 / H2 / EOF.
 *
 * Append-only: never deletes or rewrites existing content. Idempotent
 * for the file-creation step (skeleton lands once); the entry itself
 * is NOT deduped (callers handling duplicate-write semantics).
 */
export async function appendSection(
  epochMs: number,
  section: ReleaseNotesSection,
  entry: string,
  opts: AppendSectionOpts = {},
): Promise<void> {
  const path = resolveDayFilePath(epochMs, opts);
  const { iso } = mytDate(epochMs);
  await withLock(`${path}.lock`, async () => {
    let body = await readTextOrNull(path);
    if (body === null) {
      body = renderSkeleton(iso);
    }
    const next = spliceEntry(body, section, entry, opts.teamName);
    await writeText(path, next);
  });
}

/**
 * Pure splice — no IO. Exported for direct unit tests of the section /
 * sub-section insertion logic, independent of the lock + file IO above.
 *
 * Returns a NEW body string with `entry` inserted at the correct
 * location. If the section header is absent (corrupt / older file),
 * appends a fresh `## <section>` block at EOF and inserts the entry
 * underneath — keeps the writer best-effort rather than throwing on
 * malformed files (mirrors the ADR's "append-only, never destructive"
 * stance).
 */
export function spliceEntry(
  body: string,
  section: ReleaseNotesSection,
  entry: string,
  teamName?: string,
): string {
  const lines = body.split("\n");
  const sectionHeader = `## ${section}`;
  const sectionIdx = lines.findIndex((l) => l === sectionHeader);

  if (sectionIdx === -1) {
    // Section header missing — append it + the entry at EOF.
    // Trailing-newline normalize so the appended block starts clean.
    const trimmed = body.replace(/\n+$/, "");
    const tail =
      teamName === undefined
        ? `## ${section}\n\n${entry}\n`
        : `## ${section}\n\n### ${teamName}\n\n${entry}\n`;
    return `${trimmed}\n\n${tail}`;
  }

  // Locate the END of this section's body — the index of the next
  // `## ` header at the same level, or EOF.
  let endIdx = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      endIdx = i;
      break;
    }
  }

  if (teamName === undefined) {
    return insertBeforeIdx(lines, endIdx, entry).join("\n");
  }

  // Multi-team mode: find or create the `### <teamName>` H3 within
  // [sectionIdx+1, endIdx).
  const subHeader = `### ${teamName}`;
  let subIdx = -1;
  for (let i = sectionIdx + 1; i < endIdx; i++) {
    if (lines[i] === subHeader) {
      subIdx = i;
      break;
    }
  }

  if (subIdx === -1) {
    // Sub-section absent — insert `\n### <teamName>\n\n<entry>` just
    // before endIdx (i.e. at the tail of the section's body).
    const block = ["", subHeader, "", entry];
    const out = [...lines.slice(0, endIdx), ...block, ...lines.slice(endIdx)];
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  // Sub-section exists — find ITS end (next `### ` peer, or the
  // section's endIdx, whichever comes first).
  let subEnd = endIdx;
  for (let i = subIdx + 1; i < endIdx; i++) {
    if ((lines[i] ?? "").startsWith("### ")) {
      subEnd = i;
      break;
    }
  }
  return insertBeforeIdx(lines, subEnd, entry).join("\n");
}

/** Splice `entry` (plus a leading blank line if needed) before line
 *  `idx`. Trims any trailing blank-only lines from the target block
 *  first so the result doesn't accumulate visual gaps over many
 *  appends. */
function insertBeforeIdx(lines: ReadonlyArray<string>, idx: number, entry: string): string[] {
  // Walk backwards from `idx` over any pure-blank lines so the entry
  // attaches snug under the last non-blank line of the section body.
  let insertAt = idx;
  while (insertAt > 0 && (lines[insertAt - 1] ?? "").trim().length === 0) {
    insertAt--;
  }
  // Restore exactly one blank line as the section's trailing gap
  // (before the next H2 / H3 / EOF).
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  // If the section currently has NO body (header → blank → blank →
  // next header), the previous loop walks back to header-row + 1; we
  // still want a single blank between header and entry, so the
  // resulting shape is `## Section\n\n<entry>\n\n<next header>`.
  return [...before, entry, "", ...trimLeadingBlanks(after)];
}

function trimLeadingBlanks(lines: ReadonlyArray<string>): string[] {
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim().length === 0) i++;
  return [...lines.slice(i)];
}

// ---------- Re-exports for section iteration (tests / probes) ----------

// Re-export `dirname` for the rare caller that wants to derive the
// containing month dir (e.g. README index generation). Kept inline to
// avoid forcing every consumer to import from `node:path` separately.
export { dirname, SECTION_ORDER };
