// ADR-147 T8: hygiene-tick / gitter integration — auto-append today's
// release-notes ## Shipped / ## Merges / ## ADRs landed sections.
//
// Pure orchestration on top of `src/abstractions/release-notes.ts`
// (T5). Each section append is gated by an idempotency check: read
// the current day-file body, scan for the entry's stable id marker
// (taskId / commit SHA / `ADR-NNN`), append ONLY when absent. Re-runs
// of the sweep are no-op on already-recorded events; new events
// land cleanly even mid-day.
//
// **Where this is wired (per ADR-147 §D4 + T8 task body)**:
//   - `src/verbs/hygiene-tick.ts` calls `runReleaseNotesAutoAppend`
//     after the kanban drain + phantom-prune sub-ops. This covers
//     ALL three section appends in one place — kanban-done tasks
//     (## Shipped), trunk-merge commits (## Merges), new ADRs
//     (## ADRs landed) — by polling git + kanban rather than hooking
//     each event-source. Polling + idempotency-check is simpler than
//     per-event hooks and survives missed events (cron-tick or
//     event-bus skips).
//   - The merge sub-section could ALSO be appended at the merge-
//     member call site (per the task body's "or sibling" wording);
//     skipping that for now keeps the integration single-point. If
//     latency-to-publish becomes a real pain (current cron cadence
//     is hourly), the merge-member verb can add a sibling call into
//     this module without changing the contract.
//
// Idempotency design: `entryAlreadyRecorded(body, idMarker)` scans
// the section subset of the body for the marker substring. The marker
// is the entry's natural key — `t-xxxxxxxx` for tasks, the commit SHA
// for merges, `ADR-NNN` for ADRs. The scan is intentionally permissive
// (substring match within section bounds) so operator-curated
// reformatting of existing entries doesn't trip the dedup gate.

import { readTextOrNull } from "../abstractions/fs.ts";
import {
  appendSection,
  type ReleaseNotesSection,
  resolveDayFilePath,
} from "../abstractions/release-notes.ts";
import { mytDate, now } from "../abstractions/time.ts";
import type { GitSpawn } from "../abstractions/worktree.ts";
import type { KanbanTask } from "../schema/kanban.ts";

// ---------- Section-scan idempotency helper ----------

/** Find the line range belonging to `## <section>` inside `body`. Returns
 *  `[startIdx, endIdx)` over the line array, where `startIdx` points at
 *  the H2 header line and `endIdx` is exclusive (next `## ` peer, or
 *  EOF). Returns `null` when the section header isn't present. */
export function sectionRange(
  body: string,
  section: ReleaseNotesSection,
): { startIdx: number; endIdx: number; lines: string[] } | null {
  const lines = body.split("\n");
  const header = `## ${section}`;
  const startIdx = lines.findIndex((l) => l === header);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx, lines };
}

/** True iff `idMarker` already appears as a substring anywhere in the
 *  named section. Substring (not whole-word) so operator-curated
 *  formatting around the id doesn't void the dedup. Empty `body` or
 *  missing section both return `false` — the caller appends normally. */
export function entryAlreadyRecorded(
  body: string | null,
  section: ReleaseNotesSection,
  idMarker: string,
): boolean {
  if (body === null || body === "" || idMarker === "") return false;
  const range = sectionRange(body, section);
  if (range === null) return false;
  for (let i = range.startIdx + 1; i < range.endIdx; i++) {
    if ((range.lines[i] ?? "").includes(idMarker)) return true;
  }
  return false;
}

// ---------- MYT day-window helper ----------

/** Start-of-MYT-day in epoch seconds for the day containing `nowMs`.
 *  Used to filter "done today" tasks + "merged today" git log entries.
 *  MYT = UTC+8, so MYT-midnight = UTC 16:00 of the previous day. */
export function startOfMytDayEpochSec(nowMs: number): number {
  const myt = mytDate(nowMs);
  // Construct an ISO string at MYT-midnight then convert to UTC epoch.
  // `Date.parse("2026-05-15T00:00:00+08:00")` gives the right ms.
  const ms = Date.parse(`${myt.iso}T00:00:00+08:00`);
  return Math.floor(ms / 1000);
}

// ---------- Entry renderers ----------

/** Render a `## Shipped (kanban→done)` entry. Stable id = `t-xxxxxxxx`. */
export function renderShippedEntry(task: KanbanTask): string {
  const subject = (task.subject ?? "").trim() || "(no subject)";
  // The note often contains the worker's conventional-commit subject —
  // good enough as a one-line evidence pointer. Trim aggressively; this
  // is a one-line bullet, not a paragraph.
  const note = (task.note ?? "").trim();
  const noteSlice = note.length > 0 ? ` — ${note.split("\n")[0]?.trim() ?? ""}` : "";
  return `- ${task.id} — ${subject}${noteSlice}`;
}

/** Render a `## Merges (branch→trunk)` entry from a `git log --merges`
 *  parsed row. Stable id = the merge commit's short SHA. */
export function renderMergeEntry(merge: { sha: string; subject: string }): string {
  return `- ${merge.sha} — ${merge.subject}`;
}

/** Render an `## ADRs landed` entry. Stable id = `ADR-NNN`. */
export function renderAdrEntry(adr: { id: string; title: string; sha: string }): string {
  // `ADR-147` is the id marker the idempotency check matches on. The
  // SHA is bonus context for operators reading the log; not part of the
  // dedup key (an ADR's first-add SHA is fixed but operators sometimes
  // re-format with the merge SHA for traceability — both shapes carry
  // ADR-NNN, so dedup holds).
  return `- ${adr.id} — ${adr.title} (first-add @ ${adr.sha})`;
}

// ---------- Git-log probes ----------

/** Lightweight parsed git-log row. `git log --merges --first-parent
 *  --since=<iso> --format='%h\t%s'` on trunk. */
interface MergeRow {
  sha: string;
  subject: string;
}

/** List trunk-merge commits since `sinceIso`. `--first-parent` keeps
 *  the trunk's linear view (skips merges' second-parents). */
export async function listMergesSince(
  git: GitSpawn,
  repoRoot: string,
  branch: string,
  sinceIso: string,
): Promise<MergeRow[]> {
  const r = await git([
    "-C",
    repoRoot,
    "log",
    "--merges",
    "--first-parent",
    branch,
    `--since=${sinceIso}`,
    "--format=%h\t%s",
  ]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const tabIdx = l.indexOf("\t");
      if (tabIdx === -1) return { sha: l, subject: "" };
      return {
        sha: l.slice(0, tabIdx),
        subject: l.slice(tabIdx + 1),
      };
    });
}

/** List `docs/adr/NNN-*.md` files whose FIRST-add commit landed since
 *  `sinceIso`. Returns `[{id, title, sha}]`. Title parsed from the first
 *  `# ADR-NNN: <title>` H1 in the file at HEAD; defaults to filename
 *  base when missing. */
export async function listAdrsLandedSince(
  git: GitSpawn,
  repoRoot: string,
  sinceIso: string,
): Promise<{ id: string; title: string; sha: string }[]> {
  // `git log --diff-filter=A --name-only --since=<iso> -- docs/adr/`
  // surfaces additions on either side of a merge; collapsing per-path
  // to the first commit that added it is the goal. We use `git log
  // --follow` per-file in a second pass to keep the parse simple.
  const r = await git([
    "-C",
    repoRoot,
    "log",
    "--diff-filter=A",
    "--name-only",
    `--since=${sinceIso}`,
    "--format=%h",
    "--",
    "docs/adr",
  ]);
  if (r.exitCode !== 0) return [];

  // Output shape: alternating `<sha>` lines and `<path>` lines, blank
  // separators between commits. Parse defensively.
  const lines = r.stdout.split("\n");
  const firstSeen = new Map<string, string>(); // path → sha
  let currentSha = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      currentSha = "";
      continue;
    }
    if (/^[0-9a-f]{7,40}$/i.test(line)) {
      currentSha = line;
      continue;
    }
    if (line.startsWith("docs/adr/") && line.endsWith(".md")) {
      if (!firstSeen.has(line)) firstSeen.set(line, currentSha);
    }
  }

  const out: { id: string; title: string; sha: string }[] = [];
  for (const [path, sha] of firstSeen) {
    const idMatch = /(?:^|\/)(?:adr-)?(\d{3,})[-_].*\.md$/i.exec(path);
    if (idMatch === null || idMatch[1] === undefined) continue;
    const id = `ADR-${idMatch[1]}`;
    const title = await readAdrTitle(git, repoRoot, path, id);
    out.push({ id, title, sha });
  }
  return out;
}

/** Read the H1 title from `docs/adr/<path>` at HEAD. Strips the leading
 *  `# ADR-NNN: ` prefix so the rendered entry doesn't repeat the id. */
async function readAdrTitle(
  git: GitSpawn,
  repoRoot: string,
  path: string,
  id: string,
): Promise<string> {
  const r = await git(["-C", repoRoot, "show", `HEAD:${path}`]);
  if (r.exitCode !== 0) return path.replace(/^docs\/adr\//, "").replace(/\.md$/, "");
  const h1 = r.stdout.split("\n").find((l) => l.startsWith("# "));
  if (h1 === undefined) return path;
  // Strip `# ADR-147: `; leave whatever the author wrote after.
  return h1
    .replace(/^#\s*/, "")
    .replace(new RegExp(`^${id}:\\s*`, "i"), "")
    .trim();
}

// ---------- Top-level sweep ----------

export interface ReleaseNotesSweepDeps {
  /** Repo root — the worktree containing `docs/adr/` + `docs/release-notes/`. */
  repoRoot: string;
  /** Branch to read merges from — typically the team's base (`geoyws`). */
  baseBranch: string;
  /** Kanban task snapshot. Pass `KanbanRepo.listTasks()`. */
  kanban: ReadonlyArray<KanbanTask>;
  /** Git spawn — abstraction's `defaultGitSpawn` in production. */
  git: GitSpawn;
  /** Epoch ms anchor for "today". Defaults to {@link now}. */
  nowMs?: number;
}

export interface ReleaseNotesSweepSection {
  appended: string[];
  skipped: string[];
}

export interface ReleaseNotesSweepResult {
  /** Day-file path the sweep wrote to (or would have). */
  dayFilePath: string;
  shipped: ReleaseNotesSweepSection;
  merges: ReleaseNotesSweepSection;
  adrsLanded: ReleaseNotesSweepSection;
}

/** Run the three-section sweep for today's MYT day-file.
 *
 *  Each candidate entry is idempotency-checked against the current
 *  day-file body BEFORE appending; re-runs are no-op. Brand-new days
 *  pick up the full skeleton via the underlying `appendSection`
 *  call (T5's `ensureDayFile` behavior).
 *
 *  Returns the per-section append-vs-skip breakdown; the caller (the
 *  hygiene-tick verb) renders it into its JSON output for cron-log
 *  visibility. */
export async function runReleaseNotesAutoAppend(
  deps: ReleaseNotesSweepDeps,
): Promise<ReleaseNotesSweepResult> {
  const nowMs = deps.nowMs ?? now();
  const dayFilePath = resolveDayFilePath(nowMs, { repoRoot: deps.repoRoot });
  const sinceSec = startOfMytDayEpochSec(nowMs);
  const sinceIso = new Date(sinceSec * 1000).toISOString();

  const shipped: ReleaseNotesSweepSection = { appended: [], skipped: [] };
  const merges: ReleaseNotesSweepSection = { appended: [], skipped: [] };
  const adrsLanded: ReleaseNotesSweepSection = { appended: [], skipped: [] };

  // ---------- ## Shipped ----------
  // Re-read body for each append so idempotency holds even mid-sweep
  // (a hypothetical second invocation racing inside the same tick
  // would still dedupe). Cheap — day-files stay small (<200 lines).
  for (const task of deps.kanban) {
    if (task.status !== "done") continue;
    if ((task.completedAt ?? 0) < sinceSec) continue;
    const entry = renderShippedEntry(task);
    const body = await readTextOrNull(dayFilePath);
    if (entryAlreadyRecorded(body, "Shipped (kanban→done)", task.id)) {
      shipped.skipped.push(task.id);
      continue;
    }
    await appendSection(nowMs, "Shipped (kanban→done)", entry, {
      repoRoot: deps.repoRoot,
    });
    shipped.appended.push(task.id);
  }

  // ---------- ## Merges ----------
  const mergeRows = await listMergesSince(deps.git, deps.repoRoot, deps.baseBranch, sinceIso);
  for (const merge of mergeRows) {
    const body = await readTextOrNull(dayFilePath);
    if (entryAlreadyRecorded(body, "Merges (branch→trunk)", merge.sha)) {
      merges.skipped.push(merge.sha);
      continue;
    }
    await appendSection(nowMs, "Merges (branch→trunk)", renderMergeEntry(merge), {
      repoRoot: deps.repoRoot,
    });
    merges.appended.push(merge.sha);
  }

  // ---------- ## ADRs landed ----------
  const adrRows = await listAdrsLandedSince(deps.git, deps.repoRoot, sinceIso);
  for (const adr of adrRows) {
    const body = await readTextOrNull(dayFilePath);
    if (entryAlreadyRecorded(body, "ADRs landed", adr.id)) {
      adrsLanded.skipped.push(adr.id);
      continue;
    }
    await appendSection(nowMs, "ADRs landed", renderAdrEntry(adr), {
      repoRoot: deps.repoRoot,
    });
    adrsLanded.appended.push(adr.id);
  }

  return { dayFilePath, shipped, merges, adrsLanded };
}
