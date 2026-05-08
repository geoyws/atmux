// ADR-003 + ADR-005: src/core/kanban.ts — task primitives over
// `.atmux/kanban.json`.
//
// Ports the per-task mutation pipeline from bash `lib/kanban.sh` and
// the dep-aware `claim`/`done` mutations from `lib/claim.sh`. Layer
// rule (ADR-003): core libs take dependencies as args; this module
// takes `atmuxDir` and resolves the kanban path via
// `core/common.ts::kanbanJsonPath` so callers don't repeat that join.
//
// Concurrency. Every write path goes through `json.updateJson` which
// wraps in `lock.withLock(kanbanJsonPath, ...)` per ADR-005, matching
// bash's `atmux::jq_update` (mktemp + mv with the kanban.json path as
// the implicit lock anchor — bash relies on the kernel's atomic-rename
// for serialization; the TS port adds an explicit flock per ADR-005).
//
// Schema. The on-disk shape is `Kanban` from `src/schema/kanban.ts`
// (`{tasks, epics?, stories?}` top-level). Bash creates an empty
// `{"tasks": []}` file via `[[ -f $k ]] || echo … > $k` (lib/kanban.sh:14)
// — the TS port mirrors this via `updateJson({initial: emptyKanban()})`.
//
// Parity with bash @ worktree-frozen:
//
// - `addTask`        ↔ `_atmux_task_add` (lib/kanban.sh:28-68). Returns
//   the new task's id. Subject is the joined trailing positional args
//   in bash; TS callers pass an already-joined string. Empty subject
//   is the verb's responsibility — core throws `UsageError`.
// - `listTasks`      ↔ `_atmux_task_list` (lib/kanban.sh:70-99). Returns
//   the filtered task array; sort + tabular formatting belong in the
//   verb (bash printf/awk lives in the verb layer).
// - `showTask`       ↔ `_atmux_task_show` (lib/kanban.sh:101-105).
// - `moveTask`       ↔ `_atmux_task_move` (lib/kanban.sh:107-122). Sets
//   `completedAt` only when the new status is "done" (bash conditional
//   at line 118-120).
// - `assignTask`     ↔ `_atmux_task_assign` (lib/kanban.sh:124-132).
// - `removeTask`     ↔ `_atmux_task_rm` (lib/kanban.sh:134-139).
// - `claimTask`      ↔ `lib/claim.sh:41-60`. Enforces unresolved-deps
//   check; throws `KanbanDepsError` on blocked-by deps (bash
//   `atmux::die "claim: task $id blocked by unresolved deps: …"`).
// - `markTaskDone`   ↔ `lib/claim.sh:61-69`. No deps check (parity).
//
// Inbox-side mirror writes (lib/claim.sh::_atmux_inbox_move) are out of
// scope here — they belong in `core/inbox.ts` (Phase 2 follow-up). The
// claim/done VERBS compose `core/kanban.ts` + `core/inbox.ts` once
// both ship.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import { closeDatabase, type Database, openDatabase, transact } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { type Kanban, Kanban as KanbanSchema, type KanbanTask } from "../schema/kanban.ts";
import { kanbanJsonPath } from "./common.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";

// ---------- Storage routing (ADR-060) ----------
//
// Post-`atmux migrate-state` runs, `<atmuxDir>/state.db` exists; this
// module routes writes/reads through `KanbanRepo` instead of the JSON
// file. Pre-migration (or for teams that haven't migrated yet), the
// existing JSON-based implementation stays the source of truth. Detection
// is per-call via `_useSqlite()` — cheap (one `exists` syscall) and
// safe across concurrent writers (the DB itself only appears after
// the migration verb's atomic kanban.json → archive rename + state.db
// fsync, so a race on the boundary lands cleanly on one side or the
// other).
//
// Per-call DB open/close: ~ms overhead per call via WAL checkpoint on
// close. Acceptable for verb-frequency operations. If hot-path tightens
// later, swap to a module-level Map<atmuxDir, Database> with process-
// exit close.

function _stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

async function _useSqlite(atmuxDir: string): Promise<boolean> {
  return await exists(_stateDbPath(atmuxDir));
}

/** Open DB, run `fn`, close. Migrations apply on open (idempotent). */
async function _withDb<T>(
  atmuxDir: string,
  fn: (db: Database, repo: KanbanRepo) => T | Promise<T>,
): Promise<T> {
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    const repo = new KanbanRepo(db);
    return await fn(db, repo);
  } finally {
    closeDatabase(db);
  }
}

// ---------- Public API ----------

export interface AddTaskOpts {
  subject: string;
  body?: string;
  /** Member name to pre-assign. Bash's empty-string default lands in
   *  JSON as `null`; we mirror by treating `undefined` as null. */
  assignee?: string;
  /** Dep task ids. Bash splits a comma-separated string; the TS surface
   *  takes an already-split array (verb does the split). */
  deps?: ReadonlyArray<string>;
  /** Optional integer priority. Lower = higher-priority in bash list-sort. */
  priority?: number;
  /** Optional lane (`fe`/`be`/`db`/`ops`/`test`/`review`/`misc`). When set,
   *  enables future lane-claim cron pickup (ADR-062). */
  lane?: string;
}

export interface ListTasksFilter {
  status?: string;
  assignee?: string;
  lane?: string;
}

/**
 * Read-only kanban load. Returns the validated shape from disk; throws
 * `ConfigError` if the file does not exist (bash creates an empty
 * stub on first run — but READ paths in bash assume existence and
 * fall through `jq` empty-iterator on miss; throwing here surfaces
 * the operator misconfiguration earlier).
 */
export async function loadKanban(atmuxDir: string): Promise<Kanban> {
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (_db, repo) => ({
      tasks: repo.listTasks(),
      epics: repo.listEpics(),
      stories: repo.listStories(),
    }));
  }
  // updateJson under a no-op mutator gives us "load with schema validation"
  // without the side-effect of a write. Cleaner than splitting a separate
  // readKanban + writeKanban here — every read path already pays the
  // lock cost in the wrapping write transaction, and the no-op write
  // round-trips the file through atomicWrite which is benign.
  //
  // `noLock: true` mirrors bash's lib/status.sh:85-91 + lib/kanban.sh
  // read-side which use direct `jq` reads against kanban.json without
  // `with_lock` — the bash convention is "writes lock, reads don't"
  // (ADR-005 §"single writer per file" + ADR-029 F2/F9 precedent for
  // inbox helpers). atomicWrite at the writer side guarantees readers
  // see either pre- or post-state, never partial. Without `noLock`,
  // every status / dashboard / list-tasks / show-task call leaves a
  // `kanban.json.lock` sidecar that bash never creates → fs-channel
  // parity divergence (ADR-030 commit-B probe finding).
  return await updateJson(kanbanJsonPath(atmuxDir), KanbanSchema, (k) => k, {
    initial: emptyKanban(),
    noLock: true,
  });
}

/**
 * Append a task to `.tasks[]`, returning the generated id. Mirrors
 * bash `_atmux_task_add` — id shape `t-<8 hex chars>`, `createdAt`
 * stamped now, `status="todo"`, `claimedAt`/`completedAt` start null.
 *
 * Throws `UsageError` on empty subject (bash dies "task add: <subject>
 * required"). Throws `ConfigError` if `kanban.json` is missing or
 * invalid via the shared `loadKanban` path.
 */
export async function addTask(atmuxDir: string, opts: AddTaskOpts): Promise<string> {
  const subject = opts.subject.trim();
  if (subject.length === 0) {
    throw new UsageError({ what: "task add: <subject> required" });
  }
  const id = genTaskId();
  const createdAt = nowEpoch();
  const task: KanbanTask = {
    id,
    subject,
    body: opts.body ?? "",
    status: "todo",
    owner: opts.assignee !== undefined && opts.assignee.length > 0 ? opts.assignee : null,
    deps: opts.deps !== undefined ? [...opts.deps] : [],
    priority: opts.priority ?? null,
    lane: opts.lane ?? null,
    createdAt,
    claimedAt: null,
    completedAt: null,
  };
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (_db, repo) => {
      repo.addTask(task);
    });
    return id;
  }
  await updateJson(
    kanbanJsonPath(atmuxDir),
    KanbanSchema,
    (k) => ({ ...k, tasks: [...k.tasks, task] }),
    { initial: emptyKanban() },
  );
  return id;
}

/**
 * Return the (filtered) task array. Caller-side responsibility: sort
 * + render. Bash's tabular output lives in the verb (lib/kanban.sh:91-98).
 */
export async function listTasks(atmuxDir: string, filter?: ListTasksFilter): Promise<KanbanTask[]> {
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (_db, repo) => {
      // KanbanRepo.listTasks accepts {owner, status, lane, epic, story};
      // map verb-side {assignee} → repo {owner}.
      const repoFilter: Parameters<KanbanRepo["listTasks"]>[0] = {};
      if (filter?.status !== undefined) repoFilter.status = filter.status;
      if (filter?.assignee !== undefined) repoFilter.owner = filter.assignee;
      if (filter?.lane !== undefined) repoFilter.lane = filter.lane;
      return repo.listTasks(repoFilter);
    });
  }
  const k = await loadKanban(atmuxDir);
  let out = k.tasks;
  if (filter?.status !== undefined) {
    const s = filter.status;
    out = out.filter((t) => t.status === s);
  }
  if (filter?.assignee !== undefined) {
    const who = filter.assignee;
    out = out.filter((t) => t.owner === who);
  }
  if (filter?.lane !== undefined) {
    const lane = filter.lane;
    out = out.filter((t) => t.lane === lane);
  }
  return [...out];
}

/** Look up a task by id. Returns `null` on miss (bash returns empty
 *  jq output on miss; we surface as null so callers can choose how to
 *  surface "not found"). */
export async function showTask(atmuxDir: string, id: string): Promise<KanbanTask | null> {
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (_db, repo) => repo.getTask(id));
  }
  const k = await loadKanban(atmuxDir);
  return k.tasks.find((t) => t.id === id) ?? null;
}

/**
 * Move a task to a new status. When `status === "done"`, `completedAt`
 * is stamped (bash conditional at lib/kanban.sh:118-120).
 *
 * `status` is a free-form string per the schema (Kanban schema accepts
 * `z.string().optional()` because bash uses `"todo" | "in-progress" |
 * "done" | "blocked"` as a soft convention only). Validation of legal
 * values lives in the verb layer (bash dies on unknown status; TS
 * verbs do likewise).
 *
 * Throws `ConfigError` if no such id is found.
 */
export async function moveTask(atmuxDir: string, id: string, status: string): Promise<void> {
  const completedAt = status === "done" ? nowEpoch() : undefined;
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transact(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        const next: KanbanTask = { ...cur, status };
        if (completedAt !== undefined) next.completedAt = completedAt;
        repo.upsertTask(next);
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => {
    const next: KanbanTask = { ...t, status };
    if (completedAt !== undefined) next.completedAt = completedAt;
    return next;
  });
}

/** Update a task's lane (`fe`/`be`/`db`/`ops`/`test`/`review`/`misc`).
 *  Throws `ConfigError` on miss. Empty-string / `null` clears the lane. */
export async function setTaskLane(
  atmuxDir: string,
  id: string,
  lane: string | null,
): Promise<void> {
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transact(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, lane });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, lane }));
}

/** Update a task's owner. Throws `ConfigError` on miss. */
export async function assignTask(atmuxDir: string, id: string, owner: string): Promise<void> {
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transact(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, owner });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, owner }));
}

/** Remove a task by id. Throws `ConfigError` on miss. */
export async function removeTask(atmuxDir: string, id: string): Promise<void> {
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (_db, repo) => {
      const removed = repo.deleteTask(id);
      if (!removed) throw new ConfigError({ what: `no such task: ${id}` });
    });
    return;
  }
  await updateJson(
    kanbanJsonPath(atmuxDir),
    KanbanSchema,
    (k) => {
      if (!k.tasks.some((t) => t.id === id)) {
        throw new ConfigError({ what: `no such task: ${id}` });
      }
      return { ...k, tasks: k.tasks.filter((t) => t.id !== id) };
    },
    { initial: emptyKanban() },
  );
}

/**
 * Claim a task: enforce that all `deps[]` are in status "done", then
 * set owner + status="in-progress" + claimedAt. Mirrors `lib/claim.sh:
 * 41-60` and `lib/dispatch.sh:38-58`.
 *
 * Throws `KanbanDepsError` (subclass of `ConfigError`) when one or
 * more deps are not yet done — error context carries the unresolved
 * id list so the verb / operator gets the same diagnostic bash prints
 * ("claim: task <id> blocked by unresolved deps: <ids>").
 *
 * Returns BOTH the pre-mutation snapshot (for inbox-mirror writes —
 * bash captures `task` BEFORE jq_update at lib/dispatch.sh:39 and
 * lib/claim.sh:35 then appends `$task + {dispatchedAt: $now}` /
 * `$task + {claimedAt: $now}` to the inbox; the inbox entry should
 * carry the ORIGINAL task shape, not the mutated owner/status/claimedAt
 * triple) AND the post-mutation snapshot (for verb-level stdout +
 * pings + ack messages). Per ADR-029 §F1 finding from parity-state-
 * impl 12:33 outbox.
 */
export async function claimTask(
  atmuxDir: string,
  id: string,
  who: string,
): Promise<{ pre: KanbanTask; post: KanbanTask }> {
  const claimedAt = nowEpoch();
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (db, repo) =>
      transact(db, () => {
        const task = repo.getTask(id);
        if (task === null) {
          throw new ConfigError({ what: `no such task: ${id}` });
        }
        const allTasks = repo.listTasks();
        const unresolved = unresolvedDeps(allTasks, task);
        if (unresolved.length > 0) {
          throw new ConfigError({
            what: `claim: task ${id} blocked by unresolved deps: ${unresolved.join(",")}`,
          });
        }
        const pre = task;
        const post: KanbanTask = { ...task, owner: who, status: "in-progress", claimedAt };
        repo.upsertTask(post);
        return { pre, post };
      }),
    );
  }
  let pre!: KanbanTask;
  let post!: KanbanTask;
  await updateJson(
    kanbanJsonPath(atmuxDir),
    KanbanSchema,
    (k) => {
      const task = k.tasks.find((t) => t.id === id);
      if (task === undefined) {
        throw new ConfigError({ what: `no such task: ${id}` });
      }
      const unresolved = unresolvedDeps(k.tasks, task);
      if (unresolved.length > 0) {
        throw new ConfigError({
          what: `claim: task ${id} blocked by unresolved deps: ${unresolved.join(",")}`,
        });
      }
      pre = task;
      post = {
        ...task,
        owner: who,
        status: "in-progress",
        claimedAt,
      };
      return {
        ...k,
        tasks: k.tasks.map((t) => (t.id === id ? post : t)),
      };
    },
    { initial: emptyKanban() },
  );
  return { pre, post };
}

/**
 * Mark a task done: status="done", completedAt stamped, optional note.
 * No deps check (parity with bash claim.sh:61-69).
 *
 * Returns the post-mutation task for the caller's inbox-mirror write.
 */
export async function markTaskDone(
  atmuxDir: string,
  id: string,
  note?: string,
): Promise<KanbanTask> {
  const completedAt = nowEpoch();
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (db, repo) =>
      transact(db, () => {
        const task = repo.getTask(id);
        if (task === null) {
          throw new ConfigError({ what: `no such task: ${id}` });
        }
        const next: KanbanTask = { ...task, status: "done", completedAt };
        if (note !== undefined) {
          (next as KanbanTask & { note?: string }).note = note;
        }
        repo.upsertTask(next);
        return next;
      }),
    );
  }
  let done!: KanbanTask;
  await updateJson(
    kanbanJsonPath(atmuxDir),
    KanbanSchema,
    (k) => {
      const task = k.tasks.find((t) => t.id === id);
      if (task === undefined) {
        throw new ConfigError({ what: `no such task: ${id}` });
      }
      const next: KanbanTask = {
        ...task,
        status: "done",
        completedAt,
      };
      // Bash sets `.note` even when empty (lib/claim.sh:65). Mirror.
      if (note !== undefined) {
        (next as KanbanTask & { note?: string }).note = note;
      }
      done = next;
      return {
        ...k,
        tasks: k.tasks.map((t) => (t.id === id ? next : t)),
      };
    },
    { initial: emptyKanban() },
  );
  return done;
}

/** Options for `selectNextClaimable` — ADR-062 §1 lane-aware pull. */
export interface SelectNextOpts {
  /** Caller's lane from `team.members[].lane`. `null` → no lane preference;
   *  selection runs the second-pass `lane=null` fallback directly. */
  callerLane: string | null;
  /** `team.kanban.crossLaneClaim` (default true). When `false` AND the
   *  caller has a lane, suppress the `lane=null` fallback. */
  crossLaneClaim: boolean;
  /** Caller's name, used for the owner gate — pre-assigned-to-self Tasks
   *  remain claimable; pre-assigned-to-other are skipped (bash
   *  d-515de5ce relax). */
  caller: string;
}

/**
 * Pure: pick the next claimable task for a worker per ADR-062 §1.
 *
 * Selection pipeline:
 *   1. Filter to `status='todo'` AND deps[] all done AND owner ∈ {null, caller}.
 *   2. First pass — when `callerLane` is set, prefer Tasks with `.lane==callerLane`.
 *   3. Second pass — when first-pass empty AND (`crossLaneClaim` OR no callerLane),
 *      fall back to `.lane==null` Tasks (ADR-062 §OQ4: "fall back to lane-less
 *      Tasks; do NOT cross into another worker's lane").
 *   4. Tie-break: priority asc (null treated as 999), createdAt asc.
 *
 * Returns the chosen task or null. No mutation; the caller threads the id
 * through `claimTask` for the actual ownership flip.
 */
export function selectNextClaimable(
  tasks: ReadonlyArray<KanbanTask>,
  opts: SelectNextOpts,
): KanbanTask | null {
  const ownerOk = (t: KanbanTask): boolean =>
    t.owner === null || t.owner === undefined || t.owner === opts.caller;
  const baseEligible = tasks.filter(
    (t) => t.status === "todo" && ownerOk(t) && unresolvedDeps(tasks, t).length === 0,
  );
  const tiebreak = (a: KanbanTask, b: KanbanTask): number => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  };
  // First pass — own-lane only when caller has a lane.
  if (opts.callerLane !== null && opts.callerLane.length > 0) {
    const ownLane = baseEligible.filter((t) => t.lane === opts.callerLane);
    if (ownLane.length > 0) {
      return [...ownLane].sort(tiebreak)[0] ?? null;
    }
    // First pass dry — gate the fallback on crossLaneClaim.
    if (!opts.crossLaneClaim) return null;
  }
  // Second pass — lane=null only (no other lane). When caller has no lane,
  // there's nothing to "cross" from, so the gate is bypassed.
  const noLane = baseEligible.filter((t) => t.lane === null || t.lane === undefined);
  if (noLane.length === 0) return null;
  return [...noLane].sort(tiebreak)[0] ?? null;
}

/**
 * Pure: given a tasks[] roster + a target task, return the dep ids
 * that are NOT in status "done". Empty array means deps are clear.
 * Exported for direct unit-testing without spinning the JSON pipeline.
 */
export function unresolvedDeps(tasks: ReadonlyArray<KanbanTask>, target: KanbanTask): string[] {
  const deps = target.deps ?? [];
  if (deps.length === 0) return [];
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const knownIds = new Set(tasks.map((t) => t.id));
  // Bash treats unknown ids as "open" (jq's `IN` matches any non-done
  // task; an unknown id never appears in $open, so it's NOT included).
  // We mirror: only count deps that are KNOWN and not-done.
  return deps.filter((d) => knownIds.has(d) && !doneIds.has(d));
}

/**
 * Generate a task id with the bash shape `t-<8 hex chars>`. Matches
 * `atmux::gen_id` from lib/common.sh — `head -c 4 /dev/urandom | od`.
 */
export function genTaskId(): string {
  return `t-${randomBytes(4).toString("hex")}`;
}

/** Now in epoch SECONDS (bash atmux::now_epoch shape, not ms). */
export function nowEpoch(): number {
  return Math.floor(now() / 1000);
}

/** Shape used as the `initial` for `updateJson` when the kanban.json
 *  doesn't exist yet. Bash creates `{"tasks": []}` — the TS Kanban
 *  schema requires all three top-level arrays to land schema-strict,
 *  so we materialize empty `epics` and `stories` here. Equivalent
 *  on-disk shape vs bash; reads don't differ. */
export function emptyKanban(): Kanban {
  return { tasks: [], epics: [], stories: [] };
}

// ---------- Internals ----------

/**
 * Shared mutator wrapper: load, find by id (throw ConfigError if absent),
 * apply mutator, write back. Used by `moveTask` + `assignTask`.
 */
async function updateTaskByIdOrThrow(
  atmuxDir: string,
  id: string,
  mutate: (t: KanbanTask) => KanbanTask,
): Promise<void> {
  await updateJson(
    kanbanJsonPath(atmuxDir),
    KanbanSchema,
    (k) => {
      const idx = k.tasks.findIndex((t) => t.id === id);
      if (idx < 0) {
        throw new ConfigError({ what: `no such task: ${id}` });
      }
      const cur = k.tasks[idx];
      if (cur === undefined) {
        // Defensive — findIndex already established existence.
        throw new ConfigError({ what: `no such task: ${id}` });
      }
      const next = mutate(cur);
      const tasks = k.tasks.slice();
      tasks[idx] = next;
      return { ...k, tasks };
    },
    { initial: emptyKanban() },
  );
}
