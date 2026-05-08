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

/**
 * Append a task to `.inProgress` with `dispatchedAt` stamped — the
 * lead-side dispatch path (bash lib/dispatch.sh:62-65).
 *
 * The TS port stamps `dispatchedAt` on the appended entry to mirror
 * bash's `$task + {dispatchedAt: $now}` jq expression. The schema's
 * `dispatchedAt: z.number().int().nullable().optional()` accepts the
 * shape; reads via `whip.sh` use it as the staleness anchor when
 * `claimedAt` is absent (per `feedback_parity_claim_source_cite.md`).
 */
export async function appendDispatched(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  dispatchedAt: number,
): Promise<void> {
  const entry: InboxEntry = { ...task, dispatchedAt };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => ({ ...i, inProgress: [...i.inProgress, entry] }),
    // Per ADR-029 §F2 + F9 (parity-state-impl 12:33 + 12:35 outbox):
    // bash inbox writes don't use atmux::with_lock (lib/dispatch.sh:60-65,
    // lib/claim.sh:81-101, lib/inbox.sh:23-24 — direct jq writes). The TS
    // port matches to keep `<path>.lock` sidecar absence symmetric on the
    // parity fs-snapshot byte-equal gate. Single-writer-per-inbox-file
    // convention covers the operational concurrency story.
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Append a task to `.pending` — used by dispatch flows that want the
 * member to claim explicitly (vs. forced-claim via `appendDispatched`).
 * Reserved primitive; bash dispatch.sh @ worktree-frozen does not use
 * this path, but the inbox schema has the `pending` bucket and verb
 * porters in Phase 2+ may need it.
 */
export async function appendPending(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  dispatchedAt?: number,
): Promise<void> {
  const entry: InboxEntry = dispatchedAt !== undefined ? { ...task, dispatchedAt } : { ...task };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => ({ ...i, pending: [...i.pending, entry] }),
    // Per ADR-029 §F2 + F9 (parity-state-impl 12:33 + 12:35 outbox):
    // bash inbox writes don't use atmux::with_lock (lib/dispatch.sh:60-65,
    // lib/claim.sh:81-101, lib/inbox.sh:23-24 — direct jq writes). The TS
    // port matches to keep `<path>.lock` sidecar absence symmetric on the
    // parity fs-snapshot byte-equal gate. Single-writer-per-inbox-file
    // convention covers the operational concurrency story.
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Member-side claim mirror: remove from `.pending`, append to
 * `.inProgress` with `claimedAt` stamped. Bash idempotence guard
 * preserved — if `.inProgress` already contains the task id, the
 * append is skipped (still removes from `.pending` so a stale
 * pending entry can't re-trigger).
 */
export async function movePendingToInProgress(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  claimedAt: number,
): Promise<void> {
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
    // Per ADR-029 §F2 + F9 (parity-state-impl 12:33 + 12:35 outbox):
    // bash inbox writes don't use atmux::with_lock (lib/dispatch.sh:60-65,
    // lib/claim.sh:81-101, lib/inbox.sh:23-24 — direct jq writes). The TS
    // port matches to keep `<path>.lock` sidecar absence symmetric on the
    // parity fs-snapshot byte-equal gate. Single-writer-per-inbox-file
    // convention covers the operational concurrency story.
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Drain a task by id from a member's `.inProgress` without appending
 * anywhere. Used by status transitions that orphan the inbox entry
 * without going through `done` — e.g. `task move <id> blocked` parks
 * the task on the kanban side, but bash's mirror left the assignee's
 * inbox entry behind, causing whip's `inProgress > 90min` alert to
 * fire on tasks that the lead had already shelved (t-e452296b drift).
 *
 * Idempotent: filtering removes 0 or 1 entries; absent ids are no-ops.
 * The verb layer is responsible for member resolution + ownership
 * checks; this primitive trusts its inputs.
 */
export async function removeFromInProgress(
  atmuxDir: string,
  member: string,
  id: string,
): Promise<void> {
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => ({ ...i, inProgress: i.inProgress.filter((t) => t.id !== id) }),
    // Same noLock semantics as the other inbox writers — single-writer
    // -per-inbox convention preserved (ADR-029 §F2 + F9).
    { initial: emptyInbox(), noLock: true },
  );
}

/**
 * Member-side done mirror: remove from `.inProgress`, append to
 * `.done` with `completedAt` stamped. No idempotence guard — bash
 * lib/claim.sh:96-101 doesn't gate; mirror.
 */
export async function moveInProgressToDone(
  atmuxDir: string,
  member: string,
  task: InboxEntry,
  completedAt: number,
): Promise<void> {
  const entry: InboxEntry = { ...task, completedAt };
  await updateJson(
    inboxPathFor(atmuxDir, member),
    InboxSchema,
    (i) => {
      const inProgress = i.inProgress.filter((t) => t.id !== task.id);
      const done = [...i.done, entry];
      return { ...i, inProgress, done };
    },
    // Per ADR-029 §F2 + F9 (parity-state-impl 12:33 + 12:35 outbox):
    // bash inbox writes don't use atmux::with_lock (lib/dispatch.sh:60-65,
    // lib/claim.sh:81-101, lib/inbox.sh:23-24 — direct jq writes). The TS
    // port matches to keep `<path>.lock` sidecar absence symmetric on the
    // parity fs-snapshot byte-equal gate. Single-writer-per-inbox-file
    // convention covers the operational concurrency story.
    { initial: emptyInbox(), noLock: true },
  );
}
