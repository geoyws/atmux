// ADR-160 candidate (Part b of t-dc830eb0 / t-f8beb03b two-part fix).
//
// Closes the duplicate-ship leak at SOURCE. Where Part a's groom
// kanban-vs-git reconcile (src/core/groom-reconcile.ts) is read-side
// reconciliation that catches what already leaked, this is the
// write-side prevention that closes the leak so reconcile becomes a
// no-op.
//
// Wired by the ADR-134 T9 production merge dispatcher
// (src/core/intra-team-merge-dispatcher.ts) AFTER `performMerge`
// returns `mergedSha`. For every commit in the just-merged range
// (`<previousBaseSha>..<mergedSha>`), extract `t-XXXXXXXX` Task IDs
// from the commit message (subject + body); mark each task done with
// note `"flipped: shipped via merge SHA <hash>"` (distinct from
// groom's `"groomed: shipped via SHA"` for visual distinction in the
// audit trail).
//
// Without (b), members claiming in the 24h window between merge and
// the next groom tick still hit duplicate-ship pre-flight; velocity-
// gate spurious-fire pattern (lead 10:10 MYT outbox: 6× in 75min with
// 0 SHA) recurs whenever groom is behind, even briefly.
//
// Reuses the same Task ID regex + Revert filter as Part a so the two
// helpers stay symmetric; if the convention shifts, both update
// together.

import { dirname } from "node:path";
import { defaultGitSpawn, type GitSpawn } from "./auto-done.ts";
import { listTasks, markTaskDone } from "./kanban.ts";

// ---------- Types ----------

export interface PostMergeFlipOpts {
  /** Git repo for the merge range scan. Defaults to dirname(atmuxDir). */
  repoDir?: string;
  /** When true, scan + report decisions but write nothing. */
  dryRun?: boolean;
  /** Git spawn override (test injection). */
  git?: GitSpawn;
  /** markTaskDone override (test injection). Defaults to the SQLite-aware
   *  helper from `core/kanban.ts` with `callerScope: "driver"` (gitter
   *  is a system role; bypasses ADR-033 driver-only refuse-gate). */
  markDone?: (id: string, note: string) => Promise<void>;
  /** listOpenTasks override (test injection). Defaults to a SQLite query
   *  for `status ∈ {todo, in-progress}`. */
  listOpenTasks?: () => Promise<ReadonlyArray<{ id: string; status: string }>>;
}

export interface PostMergeFlipDecision {
  taskId: string;
  /** SHA of the commit in the merged range that referenced the Task ID. */
  sha: string;
  /** "flip" → would mark/marked done. "skip-not-open" → defensive no-op
   *  (task wasn't open at scan time; e.g. already-done from a prior
   *  groom tick or sibling merge). */
  action: "flip" | "skip-not-open";
}

export interface PostMergeFlipResult {
  /** Commits scanned in the `<from>..<to>` range. */
  commitsScanned: number;
  /** Open tasks in the kanban at scan time. */
  openTasks: number;
  /** Open tasks whose ID was found in a non-revert merged commit. */
  matched: number;
  /** Tasks actually flipped to done (0 in dry-run). */
  flipped: number;
  /** Per-decision audit trail. */
  decisions: PostMergeFlipDecision[];
  /** True when the helper bailed (range invalid / git log failed / no
   *  range provided). Caller treats as soft-skip; the merge itself
   *  succeeded, the kanban hygiene is best-effort. */
  skippedReason?: "git-log-failed" | "no-range";
}

// ---------- Constants ----------

/** Same shape as Part a per `genTaskId` in core/kanban.ts. */
const TASK_ID_RE = /\bt-[a-f0-9]{8}\b/g;

/** Mirrored from groom-reconcile.ts (Part a). Per t-4ea69dd1 P0 fix —
 *  body content (cross-refs, EPIC parents, deps lists, follow-up
 *  filings) is reference scaffolding, NOT ship signals; AND subject-
 *  level parent-ref annotations like `(EPIC t-XXXX)` are filtered out
 *  via PARENT_REF_KEYWORDS. Duplicated (not imported) so the two helpers
 *  stay symmetric — they share a convention contract; if the convention
 *  shifts, both update together. */
const PARENT_REF_KEYWORDS = ["EPIC ", "parent ", "Parent: ", "Refs: ", "Ref: "];

/** Same Revert filter as Part a — a revert of a shipping commit isn't
 *  itself a fresh ship signal. */
function isShipSignal(subject: string): boolean {
  if (subject.startsWith("Revert ")) return false;
  if (subject.startsWith('Revert "')) return false;
  return true;
}

/** Mirrored from groom-reconcile.ts. True when `subject[matchIdx-N..matchIdx]`
 *  ends with any PARENT_REF_KEYWORDS entry (case-insensitive). */
function isParentRefAnnotation(subject: string, matchIdx: number): boolean {
  const start = Math.max(0, matchIdx - 12);
  const preceding = subject.slice(start, matchIdx).toLowerCase();
  for (const kw of PARENT_REF_KEYWORDS) {
    if (preceding.endsWith(kw.toLowerCase())) return true;
  }
  return false;
}

// ---------- Public API ----------

/**
 * Flip every open kanban task whose ID appears in a non-revert commit
 * inside the freshly-merged range. One bulk `git log <from>..<to>` per
 * call; one `markTaskDone` per matched Task ID.
 *
 * `fromSha` / `toSha` are the bounds of the just-merged range. Caller
 * threads them from the merger_state row's pre-merge `baseSha` and the
 * post-merge `mergedSha` returned by `performMerge`. When `fromSha` is
 * null (first-ever merge for this branch — no prior baseSha recorded),
 * the helper soft-skips with `skippedReason: "no-range"` rather than
 * scanning all of git history (that's groom-reconcile's job per Part a).
 *
 * Idempotent: re-running on the same range with already-done tasks is
 * a no-op (`skip-not-open` decision per task; no markDone call).
 */
export async function flipTasksMergedInRange(
  atmuxDir: string,
  fromSha: string | null,
  toSha: string,
  opts: PostMergeFlipOpts = {},
): Promise<PostMergeFlipResult> {
  const result: PostMergeFlipResult = {
    commitsScanned: 0,
    openTasks: 0,
    matched: 0,
    flipped: 0,
    decisions: [],
  };

  if (fromSha === null || fromSha.length === 0 || toSha.length === 0) {
    result.skippedReason = "no-range";
    return result;
  }

  const repoDir = opts.repoDir ?? dirname(atmuxDir);
  const git = opts.git ?? defaultGitSpawn;

  // Bulk scan of the merged range. SUBJECT-ONLY per t-4ea69dd1 P0 fix
  // (mirrored from groom-reconcile.ts). NUL-terminated records survive
  // arbitrary subject contents. Note: `<from>..<to>` is git's
  // exclusive-low / inclusive-high range — exactly the commits that
  // newly arrived in the base branch as a result of this merge.
  const r = await git(["-C", repoDir, "log", `${fromSha}..${toSha}`, "--format=%H%n%s%x00"]);
  if (r.exitCode !== 0) {
    result.skippedReason = "git-log-failed";
    return result;
  }

  // Map<taskId, sha> — first SHA wins (git log default reverse-chrono).
  const records = r.stdout.split("\0");
  const taskShipMap = new Map<string, string>();
  let parsedCount = 0;
  for (const rec of records) {
    const trimmed = rec.replace(/^\n+/, "");
    if (trimmed.length === 0) continue;
    parsedCount += 1;
    const nl = trimmed.indexOf("\n");
    if (nl < 0) continue;
    const sha = trimmed.slice(0, nl);
    const subject = trimmed.slice(nl + 1);
    if (!isShipSignal(subject)) continue;
    // SUBJECT-ONLY match + PARENT_REF_KEYWORDS filter (mirrors Part a
    // groom-reconcile.ts). Body content is reference scaffolding;
    // subject parent-ref annotations like `(EPIC t-XXXX)` are filtered
    // out so EPIC parent IDs in conventional-commits parentheticals
    // don't trip the flip.
    for (const m of subject.matchAll(TASK_ID_RE)) {
      const id = m[0];
      const idx = m.index ?? 0;
      if (isParentRefAnnotation(subject, idx)) continue;
      if (!taskShipMap.has(id)) {
        taskShipMap.set(id, sha);
      }
    }
  }
  result.commitsScanned = parsedCount;
  if (taskShipMap.size === 0) return result;

  const open = opts.listOpenTasks
    ? await opts.listOpenTasks()
    : (await listTasks(atmuxDir, { status: "todo" }))
        .concat(await listTasks(atmuxDir, { status: "in-progress" }))
        .map((t) => ({ id: t.id, status: t.status ?? "" }));
  result.openTasks = open.length;
  const openSet = new Set(open.map((t) => t.id));

  const markDone =
    opts.markDone ??
    (async (id: string, note: string) => {
      // callerScope: "driver" — gitter is a system role; the merge
      // already happened, the work is shipped, the driver-only
      // refuse-gate is intended for member-pane mistakes not
      // post-merge hygiene.
      await markTaskDone(atmuxDir, id, note, { callerScope: "driver" });
    });

  for (const [taskId, sha] of taskShipMap) {
    if (!openSet.has(taskId)) {
      result.decisions.push({ taskId, sha, action: "skip-not-open" });
      continue;
    }
    result.matched += 1;
    result.decisions.push({ taskId, sha, action: "flip" });
    if (opts.dryRun !== true) {
      await markDone(taskId, `flipped: shipped via merge SHA ${sha}`);
      result.flipped += 1;
    }
  }

  return result;
}
