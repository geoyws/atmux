// Sub-op #6.5 of `atmux groom` — kanban-vs-git reconciliation.
//
// Per Task t-dc830eb0: every claim was hitting duplicate-ship collisions
// because tasks shipped via "feat(scope): t-XXXXXXXX — desc" were left
// in `todo` / `in-progress` after the commit landed. Members had to
// pre-flight `git log --all | grep <id>` on every claim. Velocity gate
// fired 6× in 75min with 0 SHA because every dispatch redirected on
// duplicate-detect.
//
// This is the read-side fix (Part a of the two-part plan): one bulk
// `git log --all` scan per groom run; for every open task whose ID
// appears in any commit message (subject or body), auto-flip to `done`
// with note "groomed: shipped via SHA <hash>".
//
// Idempotent — re-running on already-done tasks is a no-op (filter is
// status ∈ {todo, in-progress}). Safe — no commit-verb assumptions are
// baked in beyond skipping `^Revert` commits (a revert of a shipping
// commit isn't a fresh ship signal).
//
// Part b (post-merge done-flip hook in gitter, prevents the leak at
// source) lives in a follow-on task and ADR-160 candidate; this module
// is read-side reconciliation only.
//
// Extends ADR-068 (atmux groom verb) sub-op chain. Sibling pattern to
// ADR-080's `findCommitForTask` (auto-done on lane-tick poll), but
// scope here is "every open task in one bulk pass", not "one specific
// task with a since-window".

import { dirname } from "node:path";
import { statOrNull } from "../abstractions/fs.ts";
import {
  type GitSpawn,
  defaultGitSpawn,
} from "./auto-done.ts";
import { listTasks, markTaskDone } from "./kanban.ts";

// ---------- Types ----------

export interface ReconcileOpts {
  /** When true, scan + report decisions but write nothing. */
  dryRun?: boolean;
  /** Git repo to scan. Defaults to `dirname(atmuxDir)` (project root). */
  repoDir?: string;
  /** Git spawn override (test injection). */
  git?: GitSpawn;
  /** markTaskDone override (test injection). Default uses the SQLite-aware
   *  helper from `core/kanban.ts`. */
  markDone?: (id: string, note: string) => Promise<void>;
  /** listTasks override (test injection). Default reads via `core/kanban.ts`. */
  listOpenTasks?: () => Promise<ReadonlyArray<{ id: string; status: string }>>;
}

export interface ReconcileDecision {
  taskId: string;
  sha: string;
  /** "flip" → would mark/marked done. "skip-already-done" → defensive
   *  no-op (task moved between scan + flip). */
  action: "flip" | "skip-already-done";
}

export interface ReconcileResult {
  /** Open tasks scanned (status ∈ {todo, in-progress}). */
  scanned: number;
  /** Open tasks whose ID was found in a non-revert commit's message. */
  matched: number;
  /** Tasks actually flipped to done (0 in dry-run). */
  flipped: number;
  /** Per-decision audit trail. */
  decisions: ReconcileDecision[];
  /** True when the helper bailed because `repoDir` isn't a git repo or
   *  the `git log` invocation failed. Caller treats as soft-skip (groom
   *  sub-op error containment). */
  skippedReason?: "not-a-repo" | "git-log-failed";
}

// ---------- Constants ----------

/** Task ID shape per `genTaskId` in core/kanban.ts: `t-` + 8 hex chars. */
const TASK_ID_RE = /\bt-[a-f0-9]{8}\b/g;

/** Skip these commits: a revert of a shipping commit isn't a fresh ship
 *  signal, and merge commits typically restate the merged subjects (we
 *  catch the underlying ship via the merged commit itself). */
function isShipSignal(subject: string): boolean {
  if (subject.startsWith("Revert ")) return false;
  if (subject.startsWith('Revert "')) return false;
  return true;
}

// ---------- Public API ----------

/**
 * Bulk-reconcile open kanban tasks against `git log --all`. For every
 * open task (status ∈ {todo, in-progress}) whose ID appears in a
 * non-revert commit's message, mark it done with note
 * `"groomed: shipped via SHA <hash>"`.
 *
 * Single git log invocation per call (not per-task) — scales to ~10k
 * commits with negligible latency for a daily cron sub-op.
 *
 * Returns `skippedReason` instead of throwing when the repo lookup
 * fails — groom's sub-op error containment treats failures as warnings,
 * not aborts. The atmuxDir-not-a-git-repo case (rare; would mean the
 * project root isn't versioned) skip-soft-no-ops.
 */
export async function reconcileKanbanVsGit(
  atmuxDir: string,
  opts: ReconcileOpts = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    scanned: 0,
    matched: 0,
    flipped: 0,
    decisions: [],
  };

  const repoDir = opts.repoDir ?? dirname(atmuxDir);

  // Pre-flight: skip silently if repoDir doesn't exist or isn't a
  // directory (e.g., user pointed atmuxDir at a non-versioned tmpdir).
  const s = await statOrNull(repoDir);
  if (s === null || !s.isDirectory) {
    result.skippedReason = "not-a-repo";
    return result;
  }

  // List open tasks first so we know what to look for. Bypassed in tests
  // via `listOpenTasks` injection.
  const open = opts.listOpenTasks
    ? await opts.listOpenTasks()
    : (
        (await listTasks(atmuxDir, { status: "todo" })).concat(
          await listTasks(atmuxDir, { status: "in-progress" }),
        )
      ).map((t) => ({ id: t.id, status: t.status ?? "" }));
  result.scanned = open.length;
  if (open.length === 0) return result;

  const openSet = new Set(open.map((t) => t.id));

  // Single bulk scan: %H<NL>%s<NL>%b<NUL>. NUL terminator survives
  // arbitrary multi-line bodies (newlines + percent literals) without
  // collision.
  const git = opts.git ?? defaultGitSpawn;
  const r = await git([
    "-C",
    repoDir,
    "log",
    "--all",
    "--format=%H%n%s%n%b%x00",
  ]);
  if (r.exitCode !== 0) {
    // Most common: not a git repo. Soft-skip + audit reason; groom
    // surfaces this as a warning at call site.
    result.skippedReason = "git-log-failed";
    return result;
  }

  // Map<taskId, sha> — first SHA wins. git log default order is reverse-
  // chrono; first hit per task = newest commit referencing it. (For the
  // "groomed: shipped via SHA" note we only need *a* SHA, not the
  // canonical one.)
  const taskShipMap = new Map<string, string>();
  const records = r.stdout.split("\0");
  for (const rec of records) {
    const trimmed = rec.replace(/^\n+/, "");
    if (trimmed.length === 0) continue;
    const nl = trimmed.indexOf("\n");
    if (nl < 0) continue;
    const sha = trimmed.slice(0, nl);
    const rest = trimmed.slice(nl + 1);
    const subjEnd = rest.indexOf("\n");
    const subject = subjEnd < 0 ? rest : rest.slice(0, subjEnd);
    const body = subjEnd < 0 ? "" : rest.slice(subjEnd + 1);
    if (!isShipSignal(subject)) continue;
    const haystack = `${subject}\n${body}`;
    const matches = haystack.match(TASK_ID_RE);
    if (matches === null) continue;
    for (const id of matches) {
      if (!openSet.has(id)) continue;
      if (!taskShipMap.has(id)) {
        taskShipMap.set(id, sha);
      }
    }
  }

  // Apply decisions. markTaskDone is idempotent (defensive: re-flip of
  // an already-done task is a no-op upsert; we still skip + audit it
  // for visibility).
  const markDone =
    opts.markDone ??
    (async (id: string, note: string) => {
      // callerScope: "driver" — groom is a system maintenance verb
      // (cron-fired or operator-fired); the driver-only refuse-gate is
      // intended for member-pane mistakes, not the daily reconcile.
      await markTaskDone(atmuxDir, id, note, { callerScope: "driver" });
    });

  for (const t of open) {
    const sha = taskShipMap.get(t.id);
    if (sha === undefined) continue;
    result.matched += 1;
    if (t.status === "done") {
      result.decisions.push({ taskId: t.id, sha, action: "skip-already-done" });
      continue;
    }
    result.decisions.push({ taskId: t.id, sha, action: "flip" });
    if (opts.dryRun !== true) {
      await markDone(t.id, `groomed: shipped via SHA ${sha}`);
      result.flipped += 1;
    }
  }

  return result;
}
