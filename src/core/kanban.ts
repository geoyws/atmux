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
import { emit as defaultEmit } from "../abstractions/events.ts";
import { exists } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import {
  closeDatabase,
  type Database,
  openDatabase,
  transactImmediate,
} from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import { ConfigError, UsageError } from "../errors.ts";
import {
  type Kanban,
  Kanban as KanbanSchema,
  type KanbanStory,
  type KanbanTask,
} from "../schema/kanban.ts";
import { DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG, type Team } from "../schema/team.ts";
import { type CallerScope, kanbanJsonPath, tryLoadTeam } from "./common.ts";
import { nextId } from "./id-sequence.ts";
import { externalKanbanEnabled } from "./kanban-backend.ts";
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

const externalKanban = new KanbanCliAdapter();

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
  /** ADR-033 driver-only refuse-gate flag. When `true`, auto-pickup
   *  (`claim --next` / lane-tick cron) skips this Task unless the
   *  caller's scope is `driver` (env `ATMUX_CALLER_SCOPE=driver`). */
  driverOnly?: boolean;
  /** ADR-193: parent epic id (`e-<id>`). Validated for shape at the
   *  verb layer; NO existence check (§OQ1 — cross-worktree decomp may
   *  file the epic in a sibling session). */
  epic?: string;
  /** ADR-193: parent story id (`s-<id>`). Same shape-only stance. */
  story?: string;
  /** ADR-193: free-form deliverable description (≤256 chars at the
   *  verb layer — a path / artifact reference, e.g. `docs/adr/171-...md`). */
  deliverable?: string;
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
  if (await externalKanbanEnabled(atmuxDir)) return externalKanban.loadKanban(atmuxDir);
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
  if (await externalKanbanEnabled(atmuxDir))
    return externalKanban.addTask(atmuxDir, { ...opts, subject });
  const createdAt = nowEpoch();
  // ADR-202 §Amendment 2026-05-22 (IV) — task.unclaimed event-emit gate.
  // Fire when ALL of: status='todo' (always true here) AND lane is set
  // AND owner is null. lane-router consumer picks it up and runs
  // lane-tick for the named lane immediately rather than waiting for
  // the 5-min cron tick. Pre-load team for the team.name scope field;
  // tryLoadTeam returns null on absent team.json (JSON-only kanbans /
  // test fixtures), in which case emit silently short-circuits.
  const lane = opts.lane ?? null;
  const ownerCandidate =
    opts.assignee !== undefined && opts.assignee.length > 0 ? opts.assignee : null;
  const wantsUnclaimedEmit = typeof lane === "string" && lane.length > 0 && ownerCandidate === null;
  const team = wantsUnclaimedEmit ? await tryLoadTeam({ dir: atmuxDir }) : null;
  if (await _useSqlite(atmuxDir)) {
    let assignedId = "";
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        // ADR-202 §VIII — running-number ID per-team scoped via
        // `id_sequences` table. Allocated inside the same transaction
        // as the kanban row insert so a rollback drops both.
        const id = nextId(db, "t");
        const task: KanbanTask = {
          id,
          subject,
          body: opts.body ?? "",
          status: "todo",
          owner: ownerCandidate,
          deps: opts.deps !== undefined ? [...opts.deps] : [],
          priority: opts.priority ?? null,
          lane,
          createdAt,
          claimedAt: null,
          completedAt: null,
        };
        if (opts.driverOnly === true) task.driverOnly = true;
        // ADR-193: epic/story/deliverable set only when supplied
        // (mirrors the driverOnly minimal-footprint pattern — absent
        // flag leaves the field undefined, which the repo binds NULL).
        if (opts.epic !== undefined) task.epic = opts.epic;
        if (opts.story !== undefined) task.story = opts.story;
        if (opts.deliverable !== undefined) task.deliverable = opts.deliverable;
        repo.addTask(task);
        if (wantsUnclaimedEmit && team !== null) {
          tryEmitTaskUnclaimed({ db, task, team });
        }
        assignedId = id;
      });
    });
    return assignedId;
  }
  // JSON mode (legacy / pre-SQLite teams) stays on hex IDs — sequence
  // counter requires SQLite write transaction. This is fine because
  // every team running atmux today is SQLite-mode.
  const id = genTaskId();
  const task: KanbanTask = {
    id,
    subject,
    body: opts.body ?? "",
    status: "todo",
    owner: ownerCandidate,
    deps: opts.deps !== undefined ? [...opts.deps] : [],
    priority: opts.priority ?? null,
    lane,
    createdAt,
    claimedAt: null,
    completedAt: null,
  };
  if (opts.driverOnly === true) task.driverOnly = true;
  // ADR-193: epic/story/deliverable parity with the SQLite path above.
  if (opts.epic !== undefined) task.epic = opts.epic;
  if (opts.story !== undefined) task.story = opts.story;
  if (opts.deliverable !== undefined) task.deliverable = opts.deliverable;
  await updateJson(
    kanbanJsonPath(atmuxDir),
    KanbanSchema,
    (k) => ({ ...k, tasks: [...k.tasks, task] }),
    { initial: emptyKanban() },
  );
  return id;
}

/**
 * ADR-202 §Amendment 2026-05-22 (IV): emit `task.unclaimed` on a fresh
 * unowned-with-lane task. Same-transaction with the addTask write so
 * event durability matches the kanban row. Best-effort — Zod failure
 * or missing events table is swallowed (the kanban write is load-
 * bearing; the event is observability/coordination plumbing).
 */
function tryEmitTaskUnclaimed(args: { db: Database; task: KanbanTask; team: Team }): void {
  const { db, task, team } = args;
  // Narrow the lane to the ADR-203 v1 enum. The kanban-side `lane`
  // field is a string; the event schema is a closed enum. If the
  // lane isn't one of the seven canonical lanes, skip emit silently
  // — the cron */5 lane-tick still catches non-canonical lanes.
  const canonical: ReadonlyArray<string> = ["fe", "be", "db", "ops", "test", "review", "misc"];
  if (typeof task.lane !== "string" || !canonical.includes(task.lane)) return;
  try {
    // emit() auto-detects honkerLoaded from getHonkerState(db) per
    // ADR-202 §Amendment 2026-05-24 — no manual dance required.
    defaultEmit(db, {
      topic: "task.unclaimed",
      taskId: task.id,
      team: team.name,
      lane: task.lane as "fe" | "be" | "db" | "ops" | "test" | "review" | "misc",
      ...(task.priority !== null && task.priority !== undefined ? { priority: task.priority } : {}),
      ...(typeof task.story === "string" ? { storyId: task.story } : {}),
      ...(typeof task.epic === "string" ? { epicId: task.epic } : {}),
    });
  } catch {
    // Best-effort: missing events table or Zod failure must not break
    // task add. The kanban row is the load-bearing side effect.
  }
}

/**
 * Return the (filtered) task array. Caller-side responsibility: sort
 * + render. Bash's tabular output lives in the verb (lib/kanban.sh:91-98).
 */
export async function listTasks(atmuxDir: string, filter?: ListTasksFilter): Promise<KanbanTask[]> {
  if (await externalKanbanEnabled(atmuxDir)) {
    return externalKanban.listTasks(atmuxDir, {
      ...(filter?.status !== undefined ? { status: filter.status } : {}),
      ...(filter?.assignee !== undefined ? { assignee: filter.assignee } : {}),
      ...(filter?.lane !== undefined ? { lane: filter.lane } : {}),
    });
  }
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
  if (await externalKanbanEnabled(atmuxDir)) return externalKanban.showTask(atmuxDir, id);
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
/** Statuses to which a driverOnly Task may NOT be moved unless the
 *  caller scope is `driver`. ADR-033 §Refuse-gate site #2 explicit
 *  carve-out: transitions to `todo` and `blocked` remain allowed for
 *  bookkeeping (e.g. a member parking a stalled task). */
const DRIVER_ONLY_MOVE_BLOCKED_STATUSES: ReadonlyArray<string> = ["in-progress", "done"];

export async function moveTask(
  atmuxDir: string,
  id: string,
  status: string,
  opts: { callerScope?: CallerScope; emit?: typeof defaultEmit } = {},
): Promise<void> {
  const completedAt = status === "done" ? nowEpoch() : undefined;
  // ADR-033: only `in-progress` and `done` are gated; `todo` / `blocked`
  // bookkeeping moves stay allowed regardless of scope.
  const statusGated = DRIVER_ONLY_MOVE_BLOCKED_STATUSES.includes(status);
  const refuseMsg = `task move: ${id} is a driver-only Task — only the driver scope can move it to '${status}'. Driver pane should have ATMUX_CALLER_SCOPE=driver set; if you ARE the driver, export ATMUX_CALLER_SCOPE=driver and retry.`;
  if (await externalKanbanEnabled(atmuxDir)) {
    const current = await externalKanban.showTask(atmuxDir, id);
    if (current === null) throw new ConfigError({ what: `no such task: ${id}` });
    if (statusGated && isDriverOnlyBlocked(current, opts.callerScope)) {
      throw new ConfigError({ what: refuseMsg });
    }
    await externalKanban.moveTask(atmuxDir, id, status, current.owner ?? "atmux");
    return;
  }
  // ADR-146 T2: pre-load team config when this is a done-transition.
  // The auto-emit hook fires only on `done` and only when a Story
  // branch is set; loading the team out-of-band keeps file I/O off
  // the write-lock-held transaction body. tryLoadTeam returns null
  // on absent team.json (JSON-only kanbans / tests that don't stage
  // a team) — auto-emit silently skips in that case.
  //
  // ADR-202/203: also pre-load team for status transitions that emit
  // events (claimed / done) — payload carries team.name as scope.
  const eventStatuses = new Set(["done", "in-progress"]);
  const team: Team | null =
    status === "done" || eventStatuses.has(status) ? await tryLoadTeam({ dir: atmuxDir }) : null;
  const emit = opts.emit ?? defaultEmit;
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      // ADR-146 §Atomic: BEGIN IMMEDIATE so the upsert + the auto-
      // emit addTask either both land or both roll back. The
      // immediate lock acquisition also serializes concurrent
      // ticks that could otherwise race the sibling-count read.
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        if (statusGated && isDriverOnlyBlocked(cur, opts.callerScope)) {
          throw new ConfigError({ what: refuseMsg });
        }
        const next: KanbanTask = { ...cur, status };
        if (completedAt !== undefined) next.completedAt = completedAt;
        repo.upsertTask(next);
        // ADR-146 §D1 hook: post-transition auto-emit. Same-tx so
        // gitter's task-done cascade (ADR-032) wakes only after
        // both rows commit — no false-positive idle nudge.
        if (status === "done" && team !== null) {
          tryAutoEmitTrunkMerge(repo, next, team, db);
        }
        // ADR-202/203 §D2: task-lifecycle event emission, same-tx so
        // event durability matches the kanban row. Honker NOTIFY (if
        // loaded) fires inside emit() via honker_stream_publish; the
        // events table INSERT is authoritative.
        if (team !== null) {
          tryEmitTaskLifecycle({ db, prev: cur, next, team, emit });
        }
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => {
    if (statusGated && isDriverOnlyBlocked(t, opts.callerScope)) {
      throw new ConfigError({ what: refuseMsg });
    }
    const next: KanbanTask = { ...t, status };
    if (completedAt !== undefined) next.completedAt = completedAt;
    return next;
  });
}

// ---------- ADR-202/203 task-lifecycle event emit hook ----------

/**
 * Emit task-lifecycle events on status flips per ADR-203 §D2:
 *
 *   - `done`         → `task.done`    (every move TO done)
 *   - `in-progress`  → `task.claimed` (only on FIRST move from todo →
 *                      in-progress; status-flips within in-progress are
 *                      no-ops to avoid noise)
 *
 * Best-effort: a missing events table (pre-migration) or a Zod failure
 * is swallowed — the kanban-row mutation is the load-bearing side
 * effect; the event is observability/coordination plumbing.
 *
 * Same-tx with the upsertTask write — `emit()` INSERTs into the events
 * table inside the transactImmediate scope, so a rollback drops the
 * event alongside the kanban row. Atomic by construction.
 *
 * Honker NOTIFY happens inside emit() automatically (auto-detected
 * via `getHonkerState(db)?.loaded` per ADR-202 §Amendment 2026-05-24)
 * — gracefully swallowed when the substrate isn't loaded.
 */
function tryEmitTaskLifecycle(args: {
  db: Database;
  prev: KanbanTask;
  next: KanbanTask;
  team: Team;
  emit: typeof defaultEmit;
}): void {
  const { db, prev, next, team, emit } = args;
  try {
    if (next.status === "done") {
      const doneAt = (next.completedAt ?? nowEpoch()) as number;
      emit(db, {
        topic: "task.done",
        taskId: next.id,
        member: prev.owner ?? next.owner ?? "",
        team: team.name,
        doneAtSec: doneAt,
        ...(typeof next.story === "string" ? { storyId: next.story } : {}),
        ...(typeof next.epic === "string" ? { epicId: next.epic } : {}),
      });
      return;
    }
    if (next.status === "in-progress" && prev.status !== "in-progress") {
      emit(db, {
        topic: "task.claimed",
        taskId: next.id,
        member: next.owner ?? prev.owner ?? "",
        team: team.name,
        ...(typeof next.story === "string" ? { storyId: next.story } : {}),
        ...(typeof next.epic === "string" ? { epicId: next.epic } : {}),
      });
    }
  } catch {
    // Best-effort: missing events table or programmer-introduced Zod
    // failure must not break task move. The kanban row is the
    // load-bearing side effect.
  }
}

// ---------- ADR-146 T2: trunk-merge auto-emit hook ----------

/** Resolve the effective `team.autoEmitTrunkMerge` config — fills
 *  missing keys from {@link DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG}
 *  and computes the team-wide `enabled` default from
 *  `team.worktreeIsolation` per ADR-146 §D7 ("default `true` when
 *  `worktreeIsolation: true`, `false` otherwise"). */
export function resolveAutoEmitTrunkMergeConfig(team: Team): {
  enabled: boolean;
  fallbackAssignee: string | null;
  shortCircuitOnSharedBase: boolean;
} {
  const block = team.autoEmitTrunkMerge;
  // Default `enabled` flips per worktreeIsolation per ADR-146 §D7.
  const defaultEnabled = team.worktreeIsolation === true;
  return {
    enabled: block?.enabled ?? defaultEnabled,
    fallbackAssignee:
      block?.fallbackAssignee ?? DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG.fallbackAssignee,
    shortCircuitOnSharedBase:
      block?.shortCircuitOnSharedBase ??
      DEFAULT_AUTO_EMIT_TRUNK_MERGE_CONFIG.shortCircuitOnSharedBase,
  };
}

/** Resolve the auto-Task's owner per ADR-146 §D3: prefer a member
 *  with `role === "committer"` (canonical post-ADR-159 TR3; legacy
 *  `role === "gitter"` still accepted during grace cycle — schema
 *  transforms to canonical, but Zod-bypassed in-memory objects may
 *  carry the legacy value), or `name === "gitter"` for the legacy
 *  no-role-set case, else fall back to
 *  `autoEmitTrunkMerge.fallbackAssignee` (null = unassigned). */
function resolveAutoEmitOwner(team: Team, fallbackAssignee: string | null): string | null {
  const gitter = team.members.find(
    (m) => m.role === "committer" || m.role === "gitter" || m.name === "gitter",
  );
  if (gitter !== undefined) return gitter.name;
  return fallbackAssignee;
}

/** ADR-146 §D2 subject pattern. Loop-prevention §D5 matches against
 *  this exact shape so an auto-emit Task doesn't re-trigger itself
 *  if its own status flips. */
// Loop-prevention: matches BOTH legacy hex IDs (`t-3b017960`) and the
// ADR-202 §VIII compound IDs (`t-1-3b017960`). Either form may appear
// on disk as the subject prefix.
const AUTO_EMIT_SUBJECT_RE = /^merge t-(?:[1-9][0-9]*-)?[0-9a-f]+ \(branch→trunk\):/;

/** ADR-146 §D5 + §D1 + §D2: emit a `merge t-xxx (branch→trunk)`
 *  Task when ALL of these hold for the just-done Task:
 *
 *    1. The done Task has a parent Story (`task.story` set)
 *    2. The parent Story has a `branch` field set (per ADR-146 §D4)
 *    3. Team `autoEmitTrunkMerge.enabled` resolves true
 *    4. Team has `worktreeIsolation: true` (§D5 row)
 *    5. The Story's branch is NOT the team's base branch when
 *       `shortCircuitOnSharedBase` is on
 *    6. Zero remaining non-done sibling Tasks under the same Story
 *    7. The done Task itself isn't an auto-emit merge Task
 *       (loop-prevention §D5 last row)
 *
 *  Returns the new auto-emit Task's id when fired, null on any
 *  short-circuit. All work happens inside the caller's
 *  transactImmediate wrap — no separate transaction needed. */
export function tryAutoEmitTrunkMerge(
  repo: KanbanRepo,
  doneTask: KanbanTask,
  team: Team,
  /** ADR-202 §VIII — Database handle for running-number ID
   *  allocation via `id_sequences` table. The function is called
   *  inside an open transactImmediate scope so the sequence increment
   *  and the auto-emit task insert are atomic. */
  db: Database,
): string | null {
  // (1) Storyless Tasks never emit. One-off branches / hot-fixes
  //     remain manual per ADR-146 §"Storyless trunk-merges".
  if (doneTask.story === undefined || doneTask.story === null) return null;
  // (7) Loop-prevention: an auto-emit Task transitioning to done
  //     would otherwise re-trigger emission against the same Story.
  //     Subject-pattern check matches §D5 last row.
  if (doneTask.subject !== undefined && AUTO_EMIT_SUBJECT_RE.test(doneTask.subject)) {
    return null;
  }

  const cfg = resolveAutoEmitTrunkMergeConfig(team);
  // (3) Master switch.
  if (!cfg.enabled) return null;
  // (4) Worktree-isolation gate per ADR-146 §D5 row 3. Shared-cwd
  //     teams don't fan-in.
  if (team.worktreeIsolation !== true) return null;

  // (2) Parent Story must exist + carry a branch field.
  const story = repo.getStory(doneTask.story);
  if (story === null) return null;
  // The `branch` field rides through `extra` JSON on the
  // KanbanStory row (no DB column added). storyFromRow spreads
  // `extra` last so `story.branch` is populated when present.
  const sourceBranch = (story as KanbanStory).branch;
  if (sourceBranch === undefined || sourceBranch === null || sourceBranch.length === 0) {
    return null;
  }

  // (5) Shared-base short-circuit per §D5 row 2. Compare against
  //     the team's `merger.baseBranch` (when set) — see ADR-179.
  //     The resolver in `src/core/merger-config.ts` is the strict
  //     resolver, but the kanban hook intentionally stays config-
  //     local to avoid pulling in the merger resolver's git-probe
  //     side-effects.
  if (cfg.shortCircuitOnSharedBase) {
    const baseBranch = team.merger?.baseBranch;
    if (baseBranch !== undefined && baseBranch.length > 0 && sourceBranch === baseBranch) {
      return null;
    }
  }

  // (6) Zero remaining non-done siblings.
  const siblings = repo.listTasks({ story: doneTask.story });
  for (const s of siblings) {
    if (s.id === doneTask.id) continue;
    if (s.status !== "done") return null;
  }

  // All gates passed — build + insert the auto-emit Task per
  // ADR-146 §D2 shape verbatim. Body is YAML-flavored markdown
  // so gitter's brief (subject-pattern + body grep) parses the
  // source-branch + target identically to a manually-filed Task.
  const owner = resolveAutoEmitOwner(team, cfg.fallbackAssignee);
  const emittedAt = nowEpoch();
  // ADR-202 §VIII — running-number ID. Inside the caller's
  // transactImmediate so atomicity matches the row insert.
  const autoId = nextId(db, "t");
  // Owning-lane derive per §D2: read the done Task's lane (proxy
  // for "Story's task chain primary lane"). Fall back to "misc"
  // when the done Task is laneless.
  const owningLane = doneTask.lane ?? "misc";
  const body =
    `source-branch: ${sourceBranch}\n` +
    `target: trunk\n` +
    `owning-lane: ${owningLane}\n` +
    "conflict-hint: \n" +
    `parent-story: ${story.id}\n` +
    "auto-emitted: true\n" +
    `emitted-at: ${emittedAt}\n`;
  const autoTask: KanbanTask = {
    id: autoId,
    subject: `merge ${autoId} (branch→trunk): ${sourceBranch} → trunk`,
    body,
    status: "todo",
    owner,
    deps: [],
    priority: null,
    lane: "misc",
    createdAt: emittedAt,
    claimedAt: null,
    completedAt: null,
  };
  repo.addTask(autoTask);
  return autoId;
}

/** Per t-af159454: flip a task to `blocked` with an audit note in a
 *  single transaction. Used by `phantom-prune` (doctor --fix + atmux
 *  stop teardown) to surface auto-prune provenance in `task.note`
 *  without losing the source-of-truth status flip.
 *
 *  Idempotent — if the task is already `blocked` AND the existing
 *  note already starts with `auto-pruned`, this is a no-op (returns
 *  `false`). Useful for repeated `--fix` runs.
 *
 *  Throws `ConfigError` when the id is unknown. */
export async function markTaskBlockedWithNote(
  atmuxDir: string,
  id: string,
  note: string,
): Promise<boolean> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const current = await externalKanban.showTask(atmuxDir, id);
    if (current === null) throw new ConfigError({ what: `no such task: ${id}` });
    await externalKanban.addNote(atmuxDir, id, current.owner ?? "atmux", "blocker", note);
    await externalKanban.moveTask(atmuxDir, id, "blocked", current.owner ?? "atmux");
    return true;
  }
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (db, repo) => {
      return transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        if (cur.status === "blocked" && (cur.note ?? "").startsWith("auto-pruned")) {
          return false;
        }
        repo.upsertTask({ ...cur, status: "blocked", note });
        return true;
      });
    });
  }
  let mutated = false;
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => {
    if (t.status === "blocked" && (t.note ?? "").startsWith("auto-pruned")) {
      return t;
    }
    mutated = true;
    return { ...t, status: "blocked", note };
  });
  return mutated;
}

/** Update a task's lane (`fe`/`be`/`db`/`ops`/`test`/`review`/`misc`).
 *  Throws `ConfigError` on miss. Empty-string / `null` clears the lane. */
export async function setTaskLane(
  atmuxDir: string,
  id: string,
  lane: string | null,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { lane });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, lane });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, lane }));
}

/** ADR-193: set/clear a task's parent epic id. `null` clears the link
 *  (`task update --epic ''`). Shape-validated at the verb layer; this
 *  setter is the no-existence-check write path (§OQ1). Throws
 *  `ConfigError` on missing task id. */
export async function setTaskEpic(
  atmuxDir: string,
  id: string,
  epic: string | null,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const current = await externalKanban.showTask(atmuxDir, id);
    if (current === null) throw new ConfigError({ what: `no such task: ${id}` });
    await externalKanban.updateTask(atmuxDir, current.story ?? id, "atmux", { parentID: epic });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, epic });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, epic }));
}

/** ADR-193: set/clear a task's parent story id. `null` clears the link
 *  (`task update --story ''`). Shape-validated at the verb layer.
 *  Throws `ConfigError` on missing task id. */
export async function setTaskStory(
  atmuxDir: string,
  id: string,
  story: string | null,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const current = await externalKanban.showTask(atmuxDir, id);
    if (current === null) throw new ConfigError({ what: `no such task: ${id}` });
    await externalKanban.updateTask(atmuxDir, id, "atmux", {
      parentID: story ?? current.epic ?? null,
    });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, story });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, story }));
}

/** ADR-193: set/clear a task's free-form deliverable description.
 *  `null` / empty-string both clear it (`task update --deliverable ''`).
 *  Length-capped (≤256) at the verb layer. Throws `ConfigError` on
 *  missing task id. */
export async function setTaskDeliverable(
  atmuxDir: string,
  id: string,
  deliverable: string | null,
): Promise<void> {
  const normalized = deliverable === "" ? null : deliverable;
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { deliverable: normalized });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, deliverable: normalized });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, deliverable: normalized }));
}

/** Update a task's priority (integer; lower = higher priority in
 *  bash list-sort). Throws `ConfigError` on miss. `null` clears the
 *  priority (treated as default 99 in selection / list ordering, per
 *  bash `lib/kanban.sh:91` `sort_by(.priority // 99)`). */
export async function setTaskPriority(
  atmuxDir: string,
  id: string,
  priority: number | null,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { priority: priority ?? 3 });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, priority });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, priority }));
}

/** Update a task's body (multi-line prose stored in `tasks.body`). Throws
 *  `ConfigError` on miss. `null` / empty-string both clear the body. */
export async function setTaskBody(
  atmuxDir: string,
  id: string,
  body: string | null,
): Promise<void> {
  const normalized = body === "" ? null : body;
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { body: normalized ?? "" });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, body: normalized });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, body: normalized }));
}

/** Update a task's deps list. Throws `ConfigError` on miss. Empty array
 *  clears the deps (no upstream blocker). */
export async function setTaskDeps(
  atmuxDir: string,
  id: string,
  deps: ReadonlyArray<string>,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { dependencies: deps });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        repo.upsertTask({ ...cur, deps: [...deps] });
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => ({ ...t, deps: [...deps] }));
}

/** ADR-033 retro-flag setter — flip an existing task's `driverOnly`
 *  flag. Per t-2ef0c994: `task add --driver-only` was the only entry
 *  point; this closes the "I forgot at filing time" / "decided to park
 *  it after filing" gap so operators can promote any todo or blocked
 *  task into the driver-only refuse-gate without going through SQL.
 *
 *  Passing `true` sets the flag; `false` clears it (back to undefined-
 *  equivalent). Idempotent — re-setting the same value is a no-op
 *  upsert. */
export async function setTaskDriverOnly(
  atmuxDir: string,
  id: string,
  driverOnly: boolean,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { driverOnly });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
        const cur = repo.getTask(id);
        if (cur === null) throw new ConfigError({ what: `no such task: ${id}` });
        // Setting false collapses to omitted (consistent with task add's
        // "only stamp when explicitly true" pattern at line 208) — the
        // schema treats `undefined` and `false` as equivalent for the
        // refuse-gate semantics, so we normalize on write.
        const next = { ...cur };
        if (driverOnly) {
          next.driverOnly = true;
        } else {
          delete (next as { driverOnly?: boolean }).driverOnly;
        }
        repo.upsertTask(next);
      });
    });
    return;
  }
  await updateTaskByIdOrThrow(atmuxDir, id, (t) => {
    const next = { ...t };
    if (driverOnly) {
      next.driverOnly = true;
    } else {
      delete (next as { driverOnly?: boolean }).driverOnly;
    }
    return next;
  });
}

/** Update a task's owner. Throws `ConfigError` on miss.
 *
 *  Pass `null` to unassign (parking-lot convention per `feedback_
 *  task_body_no_self_claim_language`) — surfaces in `task list` as
 *  the bare `-` placeholder and skips the pull-model claim path. */
export async function assignTask(
  atmuxDir: string,
  id: string,
  owner: string | null,
): Promise<void> {
  if (await externalKanbanEnabled(atmuxDir)) {
    await externalKanban.updateTask(atmuxDir, id, "atmux", { assignee: owner });
    return;
  }
  if (await _useSqlite(atmuxDir)) {
    await _withDb(atmuxDir, (db, repo) => {
      transactImmediate(db, () => {
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
  opts: { callerScope?: CallerScope; refuseInProgressOther?: boolean } = {},
): Promise<{ pre: KanbanTask; post: KanbanTask }> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const pre = await externalKanban.showTask(atmuxDir, id);
    if (pre === null) throw new ConfigError({ what: `no such task: ${id}` });
    const post = await externalKanban.claimTask(atmuxDir, id, who, {
      ...(opts.callerScope === "driver"
        ? { callerScope: "driver" as const }
        : { callerScope: "member" as const }),
      allowReassign: opts.refuseInProgressOther !== true,
    });
    return { pre, post };
  }
  const claimedAt = nowEpoch();
  // ADR-033 driver-only refuse message — quoted verbatim so the bash
  // and TS surfaces print the same string (audit + grep parity).
  const driverOnlyRefuse = `claim: ${id} is a driver-only Task — only the driver scope can claim it. Driver pane should have ATMUX_CALLER_SCOPE=driver set; if you ARE the driver, export ATMUX_CALLER_SCOPE=driver and retry.`;
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (db, repo) =>
      transactImmediate(db, () => {
        const task = repo.getTask(id);
        if (task === null) {
          throw new ConfigError({ what: `no such task: ${id}` });
        }
        // ADR-085 member-claim gate (folded in from claimTaskForMember so
        // the in-progress-owner read + the ownership flip run under ONE
        // BEGIN IMMEDIATE — no concurrent claimant can interleave between
        // the check and the write). Bare claimTask (dispatch path) leaves
        // the flag off → owner override stays allowed.
        if (
          opts.refuseInProgressOther === true &&
          task.status === "in-progress" &&
          task.owner !== null &&
          task.owner !== undefined &&
          task.owner !== who
        ) {
          throw new ConfigError({ what: inProgressOtherRefuseMessage(id, task.owner) });
        }
        if (task.status === "done") {
          throw new ConfigError({ what: doneRefuseMessage(task) });
        }
        if (isDriverOnlyBlocked(task, opts.callerScope)) {
          throw new ConfigError({ what: driverOnlyRefuse });
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
      // ADR-085 member-claim gate (parity with the SQLite path above —
      // updateJson serializes via the file lock, so the read + flip are
      // already atomic here; gated by the same flag for behavior parity).
      if (
        opts.refuseInProgressOther === true &&
        task.status === "in-progress" &&
        task.owner !== null &&
        task.owner !== undefined &&
        task.owner !== who
      ) {
        throw new ConfigError({ what: inProgressOtherRefuseMessage(id, task.owner) });
      }
      if (task.status === "done") {
        throw new ConfigError({ what: doneRefuseMessage(task) });
      }
      if (isDriverOnlyBlocked(task, opts.callerScope)) {
        throw new ConfigError({ what: driverOnlyRefuse });
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
 * t-381a6ea0: Build the refuse-message for a done-state claim attempt.
 * The completedAt is rendered ISO-8601 + the owner inlined so the
 * operator can correlate against `atmux task show <id>` audit fields
 * without a second lookup. Recovery path explicitly cites
 * `atmux task move <id> todo` per Task body — discoverability matters
 * because re-opening a done Task is rare and the workflow shouldn't
 * have to be hunted in docs.
 *
 * Exported for direct unit-testing — keeps the message format stable
 * (operator + lead may grep for "already done" in audit trails).
 */
export function doneRefuseMessage(task: KanbanTask): string {
  const completedIso =
    task.completedAt !== null && task.completedAt !== undefined && task.completedAt > 0
      ? new Date(task.completedAt * 1000).toISOString()
      : "unknown";
  const owner =
    task.owner !== null && task.owner !== undefined && task.owner.length > 0
      ? task.owner
      : "unknown";
  return (
    `claim: task ${task.id} already done (completedAt=${completedIso}, owner=${owner}) — claim refused. ` +
    `To re-open, use \`atmux task move ${task.id} todo\` first.`
  );
}

/**
 * ADR-085 — refuse message when a member-initiated claim hits a task
 * already in-progress under a DIFFERENT owner. Built here so the SQLite
 * + JSON `claimTask` paths print it identically. The check that uses it
 * fires INSIDE `claimTask`'s BEGIN IMMEDIATE transaction (gated by
 * `opts.refuseInProgressOther`) — folded in from the former
 * `claimTaskForMember` pre-check, which read the owner OUTSIDE any
 * transaction (a check-then-act TOCTOU two racing members could slip
 * through). Exported for direct message-format testing.
 */
export function inProgressOtherRefuseMessage(id: string, owner: string): string {
  return (
    `claim: ${id} already in-progress under '${owner}'; refuse — ` +
    `pick a different task or coordinate with lead to reassign. ` +
    `If '${owner}' has stalled, lead can ` +
    `\`atmux task move ${id} todo\` (un-claim) and you can re-claim cleanly. ` +
    `Force-override is intentionally unavailable; the silent duplication ` +
    `this gate prevents costs more than a one-line lead nudge.`
  );
}

/**
 * 2026-05-12 race-condition gate — refuse a member-initiated claim when
 * the task is already in-progress under a DIFFERENT owner.
 *
 * This is the THIN wrapper used by the `claim` verb (member-initiated
 * pull), NOT by `dispatch` (lead-initiated reassignment). Dispatch needs
 * to override the assignee freely; claim should refuse because two members
 * silently claiming the same in-progress task is the documented
 * duplication failure mode (see ADR-085, t-eee0a7f6-followup).
 *
 * The gate fires only for `in-progress` tasks under a different owner;
 * re-claiming a `done` / `blocked` / `cancelled` task or re-claiming
 * your own in-progress task is allowed (idempotent + recovery paths).
 *
 * Implementation routes through `claimTask` with `refuseInProgressOther`,
 * so the in-progress-owner check runs INSIDE claimTask's BEGIN IMMEDIATE
 * transaction (atomic with the ownership flip) — no separate pre-read.
 * The deps + driver-only gates still fire in their normal order.
 */
export async function claimTaskForMember(
  atmuxDir: string,
  id: string,
  who: string,
  opts: { callerScope?: CallerScope } = {},
): Promise<{ pre: KanbanTask; post: KanbanTask }> {
  return claimTask(atmuxDir, id, who, { ...opts, refuseInProgressOther: true });
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
  opts: { callerScope?: CallerScope } = {},
): Promise<KanbanTask> {
  if (await externalKanbanEnabled(atmuxDir)) {
    const current = await externalKanban.showTask(atmuxDir, id);
    if (current === null) throw new ConfigError({ what: `no such task: ${id}` });
    if (isDriverOnlyBlocked(current, opts.callerScope)) {
      throw new ConfigError({
        what: `done: ${id} is a driver-only Task — only the driver scope can move it to 'done'. Driver pane should have ATMUX_CALLER_SCOPE=driver set; if you ARE the driver, export ATMUX_CALLER_SCOPE=driver and retry.`,
      });
    }
    return externalKanban.markTaskDone(atmuxDir, id, current.owner ?? "atmux", note);
  }
  const completedAt = nowEpoch();
  // ADR-033 driver-only refuse-gate. `done` is just `task move ... done`
  // with implicit assignee, so the message matches taskMove's `done`
  // path verbatim.
  const refuseMsg = `done: ${id} is a driver-only Task — only the driver scope can move it to 'done'. Driver pane should have ATMUX_CALLER_SCOPE=driver set; if you ARE the driver, export ATMUX_CALLER_SCOPE=driver and retry.`;
  if (await _useSqlite(atmuxDir)) {
    return await _withDb(atmuxDir, (db, repo) =>
      transactImmediate(db, () => {
        const task = repo.getTask(id);
        if (task === null) {
          throw new ConfigError({ what: `no such task: ${id}` });
        }
        if (isDriverOnlyBlocked(task, opts.callerScope)) {
          throw new ConfigError({ what: refuseMsg });
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
      if (isDriverOnlyBlocked(task, opts.callerScope)) {
        throw new ConfigError({ what: refuseMsg });
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

/**
 * ADR-033 driver-only refuse-gate predicate. Returns `true` when the
 * given Task carries `driverOnly === true` AND the caller's resolved
 * scope is not `driver` — i.e., the action (claim / move) must be
 * refused. Returns `false` for legacy Tasks (driverOnly undefined) and
 * for driver-scope callers.
 *
 * Centralizes the predicate so the three refuse-gate sites
 * (selectNextClaimable, claimTask, markTaskDone) share the same shape;
 * a future change to scope semantics (e.g. team-roster sniff once the
 * defense-in-depth check returns post-ADR-017) lands in one place.
 */
export function isDriverOnlyBlocked(
  task: Pick<KanbanTask, "driverOnly">,
  scope: CallerScope | undefined,
): boolean {
  return task.driverOnly === true && scope !== "driver";
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
  /** ADR-033 caller-scope verdict. Tasks with `driverOnly: true` are
   *  invisible to the selection when this is `"member"` (the auto-
   *  pickup default). Tests / explicit driver callers pass `"driver"`
   *  to bypass the filter. Default at call sites: `"member"`. */
  callerScope?: CallerScope;
  /** ADR-210 Tier-2 §73: explicit role-tag filter from `claim --next
   *  --role <X>`. When set (non-empty), selection is restricted to Tasks
   *  whose `.lane === roleFilter` and the `callerLane` / `crossLaneClaim`
   *  lane passes are bypassed entirely — a hard filter, no lane-less
   *  fallback or cross-lane. A role with no eligible Task returns null
   *  (no-op), so a fe member passing `--role be` claims nothing unless a
   *  BE-tagged Task is eligible. `undefined`/empty → legacy lane logic. */
  roleFilter?: string;
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
  // ADR-033 driver-only refuse-gate: skip Tasks where `driverOnly:true`
  // unless the caller's resolved scope is `driver`. Auto-pickup
  // (`claim --next` / lane-tick cron) MUST set `callerScope` for this
  // to fire; default `undefined`/`"member"` is fail-secure.
  const driverOnlyOk = (t: KanbanTask): boolean => !isDriverOnlyBlocked(t, opts.callerScope);
  const baseEligible = tasks.filter(
    (t) =>
      t.status === "todo" && ownerOk(t) && driverOnlyOk(t) && unresolvedDeps(tasks, t).length === 0,
  );
  const tiebreak = (a: KanbanTask, b: KanbanTask): number => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  };
  // ADR-210 Tier-2 §73: explicit `--role <X>` is a hard lane filter that
  // takes precedence over the callerLane/crossLaneClaim passes. Only
  // Tasks whose `.lane === roleFilter` are eligible; no lane-less
  // fallback, no cross-lane. A role with no eligible Task → null (no-op),
  // so a fe member passing `--role be` claims nothing unless a BE Task is
  // ready. Empty / undefined roleFilter falls through to legacy lane logic.
  if (opts.roleFilter !== undefined && opts.roleFilter.length > 0) {
    const roleLane = baseEligible.filter((t) => t.lane === opts.roleFilter);
    if (roleLane.length === 0) return null;
    return [...roleLane].sort(tiebreak)[0] ?? null;
  }
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
