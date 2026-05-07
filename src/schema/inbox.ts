// ADR-005 + ADR-003: Zod schema for `<atmuxDir>/inboxes/<member>.json`.
//
// Bash-shared schema per the carve-out documented in
// `src/schema/README.md` § "Burn-in compatibility: bash-shared schemas".
// Both atmux (bash) and atmux-bun (TS) read AND write this file during
// the burn-in window, so this schema OMITS `schemaVersion` per #12 +
// ADR-016 (Phase 6 introduces versioning post-bash-decommission).
//
// Source-of-truth for shape:
//   - `lib/claim.sh::_atmux_inbox_move` (lines 356-382 at HEAD `2aadc3f`):
//     canonical writer + the initial-file template
//     `{"pending":[],"inProgress":[],"done":[]}` (line 360).
//   - `lib/kanban.sh::_atmux_kanban_push_inbox` (lines 655+ at HEAD):
//     pushes whole kanban tasks into `pending` with their full
//     KanbanTask shape; bash-side init template at line 662 matches
//     claim.sh's (`{"pending":[],"inProgress":[],"done":[]}`).
//   - Live `.atmux/inboxes/<member>.json` field union via
//     `jq -s '[.[] | (.pending[]?, .inProgress[]?, .done[]?)] |
//          map(keys) | flatten | unique'` — 20 unique keys across all
//     members. Entries are full kanban-task shapes plus the timestamp
//     annotations (`claimedAt` on inProgress, `completedAt` on done,
//     `dispatchedAt` on inbox-push) that bash adds at write time.
//
// **Asymmetry vs KanbanTask.** Inbox entries carry `dispatchedAt`
// (stamped at the moment of inbox-push by `lib/dispatch.sh:95`,
// `lib/epic.sh:314`, `lib/story.sh:384`, `lib/kanban.sh:679`) but
// `KanbanTask` does NOT — `dispatchedAt` is an inbox-only field.
// whip's stale-min anchor at `lib/whip.sh:283` falls back
// `claimedAt // dispatchedAt // 0`, so a dispatched-but-unclaimed
// task in an inProgress section uses `dispatchedAt` for staleness.
//
// **Shape note — InboxEntry mirrors KanbanTask.** Per ADR-003 §4
// ("Schemas are leaf modules. Imports zod + src/errors only"),
// inbox.ts cannot `import { KanbanTask } from "./kanban.ts"` — schemas
// can't depend on each other. So the entry-level field set is
// duplicated inline below. Keep this in sync if `KanbanTask` in
// `kanban.ts` changes; the reviewer's per-commit gate covers this when
// either schema is touched. Phase 6 schema-redesign (ADR-016) is the
// natural moment to revisit the leaf-only constraint if cross-schema
// reuse becomes load-bearing.

import { z } from "zod";

// ---------- Per-entry shape (mirrors KanbanTask in kanban.ts) ----------

/**
 * One inbox entry. Bash treats inbox entries as KanbanTask copies
 * (`_atmux_inbox_move` does `$task + {claimedAt|completedAt: now}`),
 * so the field set is identical to `KanbanTask`. Semantic invariants
 * per section (e.g. "claimedAt set in inProgress section") are
 * enforced by the writers, not the schema.
 *
 * `.passthrough()` matches the KanbanTask posture — bash may write
 * fields TS hasn't modeled; strict-rejection breaks parity.
 */
export const InboxEntry = z
  .object({
    /** Task ID (`t-XXXXXXXX`). */
    id: z.string().min(1),
    subject: z.string().optional(),
    /** Free-form prose body. May be empty string or null. */
    body: z.string().nullable().optional(),
    /** Lifecycle status; permissive for legacy entries. */
    status: z.string().optional(),
    /** Member name; `null` when unclaimed. */
    owner: z.string().nullable().optional(),
    /** Task IDs this task depends on. */
    deps: z.array(z.string()).optional(),
    priority: z.number().nullable().optional(),
    epic: z.string().nullable().optional(),
    story: z.string().nullable().optional(),
    /** Lane string — usually `KanbanLane` enum at write but read-permissive. */
    lane: z.string().nullable().optional(),
    deliverable: z.string().nullable().optional(),
    staleMin: z.number().nullable().optional(),
    /** ADR-033 driver-only gate. */
    driverOnly: z.boolean().optional(),
    createdAt: z.number().int().optional(),
    /** Set by `_atmux_inbox_move` on `pending->inProgress` transition. */
    claimedAt: z.number().int().nullable().optional(),
    /** Set by `_atmux_inbox_move` on `inProgress->done` transition. */
    completedAt: z.number().int().nullable().optional(),
    /** Set on inbox-push by 4 dispatch sites:
     *    `lib/dispatch.sh:95` (verb dispatch), `lib/epic.sh:314`
     *    (epic dispatch), `lib/story.sh:384` (story dispatch),
     *    `lib/kanban.sh:679` (task move dispatch). NOT present on
     *    `kanban.tasks[]` — inbox-only field. Load-bearing for whip's
     *    stale-min anchor at `lib/whip.sh:283`:
     *      `(.claimedAt // .dispatchedAt // 0) as $base`
     *    whip falls back through them in order, so a dispatched-but-
     *    not-yet-claimed task uses dispatchedAt as the staleness anchor. */
    dispatchedAt: z.number().int().nullable().optional(),
    /** Bounce-back ownership preservation per `kanban.sh::_atmux_task_move`. */
    claimedFrom: z.string().nullable().optional(),
    /** Origin annotation (e.g. `commit`, `dispatch`). */
    createdFrom: z.string().nullable().optional(),
    /** Closing note from `done <id> --note <text>` per `claim.sh`. */
    note: z.string().nullable().optional(),
  })
  .passthrough();
export type InboxEntry = z.infer<typeof InboxEntry>;

// ---------- Top-level inbox.json ----------

/**
 * `<atmuxDir>/inboxes/<member>.json` — three-section state machine.
 * Tasks land in `pending` on dispatch (via `_atmux_kanban_push_inbox`),
 * move to `inProgress` on claim (via `_atmux_inbox_move`), finish in
 * `done`. Empty arrays are guaranteed present after the canonical
 * init at `claim.sh:360` / `kanban.sh:662`:
 *
 *     {"pending":[],"inProgress":[],"done":[]}
 *
 * `.passthrough()` for forward-compat — same posture as `kanban.ts`
 * and `team.ts`.
 */
export const Inbox = z
  .object({
    /** Tasks delivered to this member, awaiting claim. */
    pending: z.array(InboxEntry),
    /** Tasks the member has claimed; mirrors kanban `in-progress` status. */
    inProgress: z.array(InboxEntry),
    /** Completed tasks; durable record across kanban evolutions. */
    done: z.array(InboxEntry),
  })
  .passthrough();
export type Inbox = z.infer<typeof Inbox>;

/** Alias for ergonomic import: `import { InboxSchema } from "./schema/inbox.ts"`. */
export const InboxSchema = Inbox;
