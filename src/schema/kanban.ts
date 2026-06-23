// ADR-005 + ADR-003: Zod schema for `<atmuxDir>/kanban.json`.
//
// Bash-shared schema per the carve-out documented in
// `src/schema/README.md` § "Burn-in compatibility: bash-shared schemas".
// This file is read AND written by both `atmux` (bash) and `atmux-bun`
// (TS) during the burn-in window — adding a `schemaVersion` field here
// would write a key bash never reads, breaking parity. Phase 6
// (post-bash-decommission) introduces versioning per ADR-014. Same
// pattern as `paused.ts:8-14` and `team.ts`.
//
// Source-of-truth for shape:
//   - `lib/common.sh::atmux::kanban_normalize` (HEAD `2aadc3f` + live):
//     guarantees `{tasks: []}` top-level.
//   - `lib/kanban.sh::_atmux_task_add` lines 135-148 at HEAD:
//     canonical task-add field set.
//   - Live `.atmux/kanban.json` at the bash main checkout used as
//     cross-check for the actual-on-disk field union.
//
// ADR-264: the Epic / Story tiers are cut — Task is the sole persistent
// work unit. Only `tasks` survives at the top level.
//
// The schema uses `.passthrough()` everywhere so unknown / future-bash
// fields don't fail parse (same posture as `team.ts`). Most fields are
// `nullable().optional()` because bash routinely writes literal `null`
// (e.g. `claimedAt: null` on a freshly-added task per `kanban.sh:147`)
// AND omits fields on legacy entries from before a feature landed.
// Tightening to `.strict()` + non-null fields is a Phase 6 concern.

import { z } from "zod";

// ---------- Enums (write-side validation; read is permissive) ----------

/**
 * Lane enum per `lib/kanban.sh:84` — bash validates at task-add time.
 * Persisted lowercase. Read-side schema accepts any string for legacy
 * entries; this enum is exported for use by core helpers / verbs that
 * validate at the WRITE boundary.
 */
export const KanbanLane = z.enum([
  "fe",
  "be",
  "db",
  "ops",
  "test",
  "review",
  "misc",
  "git",
  "docs",
]);
export type KanbanLane = z.infer<typeof KanbanLane>;

// ---------- Per-task entry ----------

/**
 * One task. Field set derived from the union of:
 *   1. `kanban.sh:_atmux_task_add` canonical writer.
 *   2. `claim.sh::_atmux_inbox_move` claim-time mutations (`claimedAt`).
 *   3. `kanban.sh::_atmux_task_move` bounce-back fields (`claimedFrom`).
 *   4. Live kanban.json field union (adds `note`, `createdFrom`).
 *
 * `.passthrough()` because forward-compat with future bash additions
 * matters more than strict-rejection of unknown keys (the bash side may
 * land a new field before TS catches up; we'd rather parse than fail).
 */
export const KanbanTask = z
  .object({
    /** Bash writes `t-XXXXXXXX` (8 hex chars after `t-`). Schema doesn't
     *  enforce the format — `gen_id`'s prefix could change in Phase 6. */
    id: z.string().min(1),
    subject: z.string().optional(),
    /** Free-form prose body. May be empty string or null. */
    body: z.string().nullable().optional(),
    /** Lifecycle: `todo|in-progress|done|blocked|review` and Phase-2 additions.
     *  Permissive `string()` — bash's set evolves; reading is forgiving. */
    status: z.string().optional(),
    /** Member name; `null` when unclaimed. */
    owner: z.string().nullable().optional(),
    /** Task IDs this task depends on. */
    deps: z.array(z.string()).optional(),
    /** Bash writes `null` or a number; lower = higher priority. */
    priority: z.number().nullable().optional(),
    /** Lane string — usually one of `KanbanLane` but read-permissive
     *  for legacy entries. Bash validates at write time only. */
    lane: z.string().nullable().optional(),
    /** Free-form deliverable description, optional. */
    deliverable: z.string().nullable().optional(),
    /** Per-task stale-minutes override for whip's stale heuristic. */
    staleMin: z.number().nullable().optional(),
    /** ADR-033 driver-only gate. False / absent on pre-ADR-033 tasks. */
    driverOnly: z.boolean().optional(),
    /** Epoch seconds. Bash `date +%s` → integer. */
    createdAt: z.number().int().optional(),
    /** Epoch seconds; `null` while task remains unclaimed. */
    claimedAt: z.number().int().nullable().optional(),
    /** Epoch seconds; `null` until task transitions to `done`. */
    completedAt: z.number().int().nullable().optional(),
    /** Bounce-back ownership preservation per `kanban.sh::_atmux_task_move`
     *  (Bug-2 fix t-04c8b243): when a task is moved back to `todo`, the
     *  prior owner is recorded here for audit. Bash writes either a bare
     *  member-name string OR a structured `{prevOwner, ts}` object on some
     *  paths — accept both shapes. */
    claimedFrom: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .nullable()
      .optional(),
    /** Origin annotation. Bash writes either a string tag (e.g. `commit`,
     *  `dispatch`) OR a structured object like `{parentTaskId, depth}` for
     *  eternal-improvement spawned children — accept both shapes. */
    createdFrom: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .nullable()
      .optional(),
    /** Closing note from `done <id> --note <text>` per `claim.sh`. */
    note: z.string().nullable().optional(),
    /** ADR-263 §D3: git task-source provenance — adapter id of the
     *  external tracker this task was ingested from (`"github"`). `null` /
     *  absent on manually-filed tasks. Pairs with {@link sourceId}. */
    sourceKind: z.string().nullable().optional(),
    /** ADR-263 §D3: canonical external identity (`github:owner/repo#123`).
     *  The dedup key for `atmux issues sync` — re-polls upsert the same
     *  row, never duplicate. Backed by a dedicated `source_id` column +
     *  partial-unique index (sqlite-migrations v16→v17); `null` / absent
     *  on manually-filed tasks. */
    sourceId: z.string().nullable().optional(),
  })
  .passthrough();
export type KanbanTask = z.infer<typeof KanbanTask>;

// ---------- Top-level kanban.json ----------

/**
 * `.atmux/kanban.json` — top-level shape per `kanban_normalize`.
 * The `tasks` array is guaranteed present after normalize; pre-normalize
 * files can omit it (bash hits the `//= []` default on first read).
 *
 * ADR-264: the Epic / Story tiers are gone — `tasks` is the only
 * top-level array. Reads should call `kanban_normalize`-equivalent
 * BEFORE parse so a corrupted on-disk file isn't papered over.
 */
export const Kanban = z
  .object({
    tasks: z.array(KanbanTask),
  })
  .passthrough();
export type Kanban = z.infer<typeof Kanban>;

/** Alias for ergonomic import: `import { KanbanSchema } from "./schema/kanban.ts"`. */
export const KanbanSchema = Kanban;
