// ADR-003 + ADR-005 + ADR-076: src/core/inbox.ts — per-member inbox primitives.
//
// **ADR-076 cutover (2026-05-08): reads now SQL-canonical.**
// `loadInbox` queries the `tasks` table (filtered by `owner`) and buckets
// by status: `todo` → pending, `in-progress` → inProgress, `done` →
// done. Returns the same `Inbox` shape so all existing callers
// (status verb's pendingCount, atmux inbox <member>, doctor phantom-
// inbox check, claim/dispatch/done verbs) keep working unchanged.
//
// Falls back to the JSON file at `<atmuxDir>/inboxes/<member>.json`
// only when `state.db` doesn't exist (fresh teams pre-migration).
// Most teams ran `atmux migrate-state json-to-sqlite --target=inboxes`
// already; the fallback exists for deployment-edge teams.
//
// **Writers below are dual-path during the rollout window** — they
// continue to write JSON to keep the .atmux/inboxes/<member>.json
// files current as a safety net. Phase 3 of ADR-076 drops the JSON
// writes entirely; until then the JSON is a write-only mirror.
//
// Bash parity history (now historical — bash decommissioned per ADR-064):
//
// - `appendDispatched` ↔ `lib/dispatch.sh:62-65` (inProgress with dispatchedAt).
// - `appendPending`    ↔ alternative pending-bucket dispatch flow.
// - `movePendingToInProgress` ↔ `lib/claim.sh:88-95` (claim with claimedAt).
// - `moveInProgressToDone` ↔ `lib/claim.sh:96-101` (done with completedAt).

import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";
import { Inbox as InboxSchema, type Inbox, type InboxEntry } from "../schema/inbox.ts";
import { inboxPathFor } from "./common.ts";

// ---------- SQL helper (ADR-076) ----------

function _stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

/** SQL-backed loadInbox. Queries `tasks` table for member-owned rows
 *  and buckets by status. KanbanTask → InboxEntry is essentially identity
 *  (the schemas mirror each other per src/schema/inbox.ts header). */
function _loadInboxFromTasks(atmuxDir: string, member: string): Inbox {
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    const repo = new KanbanRepo(db);
    const tasks = repo.listTasks({ owner: member });
    const pending: InboxEntry[] = [];
    const inProgress: InboxEntry[] = [];
    const done: InboxEntry[] = [];
    for (const t of tasks) {
      // KanbanTask is shape-compatible with InboxEntry (passthrough).
      // Cast through unknown to satisfy the structural check.
      const entry = t as unknown as InboxEntry;
      switch (t.status) {
        case "todo":
          pending.push(entry);
          break;
        case "in-progress":
          inProgress.push(entry);
          break;
        case "done":
          done.push(entry);
          break;
        // "blocked", "cancelled", and other statuses are intentionally
        // omitted — pre-ADR-076 JSON inbox didn't track them either
        // (claim.sh moved blocked tasks to pending, cancelled tasks to
        // done; both behaviors fold into the SQL view via the kanban
        // status column without bucket promotion).
      }
    }
    return { pending, inProgress, done };
  } finally {
    closeDatabase(db);
  }
}

// ---------- Public API ----------

/** Empty `{pending,inProgress,done}` shape. Equivalent to bash's
 *  `echo '{"pending":[],"inProgress":[],"done":[]}' > $ib` first-run
 *  initialization at lib/claim.sh:85 / lib/dispatch.sh:64. */
export function emptyInbox(): Inbox {
  return { pending: [], inProgress: [], done: [] };
}

/**
 * Read-only inbox load.
 *
 * **ADR-076 (2026-05-08): SQL-canonical with JSON fallback.**
 * If `<atmuxDir>/state.db` exists → query the `tasks` table for owner-
 * matching rows and bucket by status. Otherwise (fresh teams pre-
 * migration) fall back to the legacy JSON file at
 * `<atmuxDir>/inboxes/<member>.json`. Both paths return the same `Inbox`
 * shape so callers don't need to change.
 *
 * Reads are NOT locked. SQLite WAL mode handles concurrent reads
 * natively; the JSON fallback preserves the legacy single-writer-per-
 * file convention (transient mid-write reads tolerated thanks to
 * atomicWrite's rename atomicity).
 *
 * If the file/DB doesn't exist, returns the empty shape (parity with
 * bash's first-run stub-write — both bash and TS treat absence as
 * "empty inbox").
 */
export async function loadInbox(atmuxDir: string, member: string): Promise<Inbox> {
  if (await exists(_stateDbPath(atmuxDir))) {
    return _loadInboxFromTasks(atmuxDir, member);
  }
  return await updateJson(inboxPathFor(atmuxDir, member), InboxSchema, (i) => i, {
    initial: emptyInbox(),
    // Legacy JSON fallback for pre-migration teams. Lock semantics
    // preserved per the original bash parity comment (ADR-029 §F2 + F9).
    noLock: true,
  });
}

// ---------- Writers (ADR-076 Phase 3) ----------
//
// All 5 writers below are no-ops on SQL-canonical teams (state.db
// exists). The kanban-repo paired callers (dispatch.ts → claimTask;
// claim.ts → claimTask + completeTask; task.ts → moveTask) handle the
// authoritative tasks-table write. JSON-mirror writes are pure
// redundancy; skipping them stops the .atmux/inboxes/<member>.json
// files from accumulating stale state.
//
// On pre-migration teams (state.db absent), each writer falls through
// to the legacy JSON path so deployment-edge teams keep working.

/**
 * Append a task to `.inProgress` with `dispatchedAt` stamped (lead-side
 * dispatch). On SQL-canonical teams, no-op — `claimTask` in dispatch.ts
 * writes the tasks-table row authoritatively.
 */
export async function appendDispatched(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  dispatchedAt: number,
): Promise<void> {
  if (await exists(_stateDbPath(atmuxDir))) {
    return; // SQL-canonical: kanban-repo paired write is authoritative.
  }
  const entry: InboxEntry = { ...task, dispatchedAt };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => ({ ...i, inProgress: [...i.inProgress, entry] }),
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Append a task to `.pending`. Reserved primitive (no live caller as
 * of Phase 3 cutover; kept for forward-compat). No-op on SQL-canonical
 * teams.
 */
export async function appendPending(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  dispatchedAt?: number,
): Promise<void> {
  if (await exists(_stateDbPath(atmuxDir))) {
    return;
  }
  const entry: InboxEntry = dispatchedAt !== undefined ? { ...task, dispatchedAt } : { ...task };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => ({ ...i, pending: [...i.pending, entry] }),
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Member-side claim mirror: remove from `.pending`, append to
 * `.inProgress` with `claimedAt` stamped. No-op on SQL-canonical teams
 * — claim.ts's `claimTask` (kanban-repo path) handles the authoritative
 * status flip + claimedAt stamp.
 */
export async function movePendingToInProgress(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  claimedAt: number,
): Promise<void> {
  if (await exists(_stateDbPath(atmuxDir))) {
    return;
  }
  const entry: InboxEntry = { ...task, claimedAt };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => {
      const pending = i.pending.filter((t) => t.id !== task.id);
      const alreadyInProgress = i.inProgress.some((t) => t.id === task.id);
      const inProgress = alreadyInProgress ? i.inProgress : [...i.inProgress, entry];
      return { ...i, pending, inProgress };
    },
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Drain a task by id from a member's `.inProgress`. Used by `task move
 * <id> blocked` to clear the inbox-mirror entry alongside the kanban
 * status flip. No-op on SQL-canonical teams — the SQL view derives the
 * inbox shape from `tasks.status` so changing status alone updates the
 * loadInbox result; no separate inbox-mirror to drain.
 */
export async function removeFromInProgress(
  atmuxDir: string,
  member: string,
  id: string,
): Promise<void> {
  if (await exists(_stateDbPath(atmuxDir))) {
    return;
  }
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => ({ ...i, inProgress: i.inProgress.filter((t) => t.id !== id) }),
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Member-side done mirror: remove from `.inProgress`, append to `.done`
 * with `completedAt` stamped. No-op on SQL-canonical teams — done verb
 * (claim.ts) calls `completeTask` which sets the canonical status.
 */
export async function moveInProgressToDone(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  completedAt: number,
): Promise<void> {
  if (await exists(_stateDbPath(atmuxDir))) {
    return;
  }
  const entry: InboxEntry = { ...task, completedAt };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => {
      const inProgress = i.inProgress.filter((t) => t.id !== task.id);
      const done = [...i.done, entry];
      return { ...i, inProgress, done };
    },
    // Pre-migration JSON path:
    // bash inbox writes don't use atmux::with_lock (lib/dispatch.sh:60-65,
    // lib/claim.sh:81-101, lib/inbox.sh:23-24 — direct jq writes). The TS
    // port matches to keep `<path>.lock` sidecar absence symmetric on the
    // parity fs-snapshot byte-equal gate. Single-writer-per-inbox-file
    // convention covers the operational concurrency story.
    { initial: emptyInbox(), noLock: true },
  );
}
