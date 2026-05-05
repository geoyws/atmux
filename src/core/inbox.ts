// ADR-003 + ADR-005: src/core/inbox.ts — per-member inbox primitives
// over `.atmux/inbox/<member>.json`.
//
// Ports the inbox-mirror writes from `lib/claim.sh::_atmux_inbox_move`
// and `lib/dispatch.sh` (inbox-push leg). Per-member files have shape
// `{pending: [], inProgress: [], done: []}` (matches `Inbox` schema in
// `src/schema/inbox.ts`).
//
// Layer rule (ADR-003): core libs take `atmuxDir` and the member name;
// they resolve the path via `core/common.ts::inboxPathFor` so callers
// don't repeat the join.
//
// Concurrency. Every write path goes through `json.updateJson` per
// ADR-005; bash relied on kernel atomic-rename for serialization on a
// single-writer-per-file convention. The TS port adds explicit flock
// per the ADR.
//
// Parity with bash @ worktree-frozen:
//
// - `appendDispatched` ↔ `lib/dispatch.sh:62-65`. Pushes the task into
//   `.inProgress` with `dispatchedAt` stamped (NOT `.pending` — bash
//   dispatch is a lead-side forced-claim, the member just receives the
//   task already in-progress).
// - `appendPending`    ↔ alternative dispatch flow when a verb wants
//   "lead pushes to inbox.pending, member claims later". Bash @
//   worktree-frozen does not have this path on dispatch.sh, but
//   leaving it as a primitive preserves the inbox schema's `pending`
//   bucket for future verbs.
// - `movePendingToInProgress` ↔ `lib/claim.sh:88-95`. Member-side claim:
//   removes from `.pending`, appends to `.inProgress` (with stamped
//   `claimedAt`), with bash's IDEMPOTENCE guard ("if any inProgress
//   has this id, skip the append" — `if any(.inProgress[]; .id == $id)`).
// - `moveInProgressToDone` ↔ `lib/claim.sh:96-101`. Member-side done:
//   removes from `.inProgress`, appends to `.done` with stamped
//   `completedAt`. No idempotence guard in bash; mirror.

import { updateJson } from "../abstractions/json.ts";
import { Inbox as InboxSchema, type Inbox, type InboxEntry } from "../schema/inbox.ts";
import { inboxPathFor } from "./common.ts";

// ---------- Public API ----------

/** Empty `{pending,inProgress,done}` shape. Equivalent to bash's
 *  `echo '{"pending":[],"inProgress":[],"done":[]}' > $ib` first-run
 *  initialization at lib/claim.sh:85 / lib/dispatch.sh:64. */
export function emptyInbox(): Inbox {
  return { pending: [], inProgress: [], done: [] };
}

/**
 * Read-only inbox load. Returns the validated shape; if the file does
 * not exist, returns the empty shape (parity with bash's first-run
 * stub-write — both bash and TS treat absence as "empty inbox").
 *
 * Reads are NOT locked — single-writer-per-file is the inbox
 * convention; concurrent reads against a transient mid-write state
 * are tolerated (the value is either pre-write or post-write thanks
 * to `atomicWrite`'s rename atomicity).
 */
export async function loadInbox(atmuxDir: string, member: string): Promise<Inbox> {
  return await updateJson(inboxPathFor(atmuxDir, member), InboxSchema, (i) => i, {
    initial: emptyInbox(),
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
    { initial: emptyInbox() },
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
    { initial: emptyInbox() },
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
    { initial: emptyInbox() },
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
    { initial: emptyInbox() },
  );
}
