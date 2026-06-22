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
//     guarantees `{tasks: [], epics: [], stories: []}` top-level.
//   - `lib/kanban.sh::_atmux_task_add` lines 135-148 at HEAD:
//     canonical task-add field set.
//   - `lib/epic.sh:11` docstring: epic shape contract.
//   - `lib/story.sh:21-23` docstring: story shape contract.
//   - Live `.atmux/kanban.json` at the bash main checkout used as
//     cross-check for the actual-on-disk field union.
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
    /** Parent epic ID (`e-XXXXXXXX`) or `null`. */
    epic: z.string().nullable().optional(),
    /** Parent story ID (`s-XXXXXXXX`) or `null`. */
    story: z.string().nullable().optional(),
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
    /** ADR-090 §Decision-anchor #1: canonical marker for the EPIC-done
     *  trunk-signoff gate consumed by ADR-091's auto-merge state machine.
     *  The reserved value `"reviewer-trunk-signoff"` names the Task that
     *  reviewer files AFTER verifying every code-shipping child Task has
     *  paired tests (per project CLAUDE.md §Testing Discipline) AND the
     *  commit-cadence gate (ADR-148) shows the epic-team shipping. The
     *  field is `nullable().optional()` because legacy Tasks pre-ADR-090
     *  don't carry it; only ADR-091's state-machine reads it. Schema-
     *  permissive `z.string()` so future role-markers land additively
     *  without schema churn. */
    role: z.string().nullable().optional(),
  })
  .passthrough();
export type KanbanTask = z.infer<typeof KanbanTask>;

// ---------- Per-epic entry ----------

/**
 * One epic. Per `lib/epic.sh:11` schema docstring + live kanban.json.
 *
 * State machine (ADR-007): `planning → ready → in-progress → done`.
 * Children: stories belong to an epic via `story.epic == epic.id`;
 * tasks belong via `task.epic == epic.id` (or via `task.story` whose
 * story belongs to the epic). The `epics[].stories[]` field is a
 * lazily-initialized list of child story IDs (NOT the source of truth
 * — that's the top-level `stories[]` array).
 */
export const KanbanEpic = z
  .object({
    /** Bash writes `e-XXXXXXXX` (8 hex chars after `e-`). */
    id: z.string().min(1),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    /** Epic state per ADR-007. */
    status: z.string().optional(),
    /** Optional reference to a driver-side artifact (URL / path / name). */
    driverRef: z.string().nullable().optional(),
    createdAt: z.number().int().optional(),
    completedAt: z.number().int().nullable().optional(),
    /** Lazy-init array of child story IDs (//= [] on first append per
     *  `lib/story.sh:23`). Source of truth is top-level `stories[]`. */
    stories: z.array(z.string()).optional(),
    /** ADR-090 §Schema: name of the child epic-team this Epic row was
     *  spawned into (filled by `spawn-epic` step 9, cleared by
     *  `dissolve-epic` step 7). Lets the parent identify which child
     *  cage owns the EPIC's execution + read the child's `state.db` for
     *  cross-team progress rendering. `null` for normal Epics that did
     *  NOT spawn an epic-team (the legacy / shared-team path). */
    epicTeamName: z.string().nullable().optional(),
    /** ADR-090 §Schema: absolute path to the child epic-team's project
     *  root (`<projectRoot>-epics/<epicId>/` per §Decision-anchor #2).
     *  Paired with `epicTeamName`; both move together on
     *  spawn-epic / dissolve-epic. `null` when no epic-team is attached. */
    epicTeamRoot: z.string().nullable().optional(),
    /** ADR-090 §Decision-anchor #6 forward-ref: pr-mode runtime number.
     *  Schema-reserved for future pr-mode impl (deferred). `null` in
     *  v1 — auto-mode never sets it; pr-mode runtime ships in a future
     *  ADR. */
    prNumber: z.number().int().nullable().optional(),
    /** ADR-090 §Decision-anchor #6 forward-ref: pr-mode runtime state
     *  (e.g. `"open"`, `"merged"`, `"closed"`). Schema-reserved; pr-mode
     *  runtime ships in a future ADR. `null` in v1. */
    prState: z.string().nullable().optional(),
    /** ADR-090 §Schema: free-form annotation. ADR-091's auto-merge state
     *  machine writes `"conflict at <SHA>"` here on `merging → conflict`
     *  transitions; operators tail this field via `atmux status` to
     *  triage stuck epics. `null` for clean / not-yet-merged Epics. */
    note: z.string().nullable().optional(),
    /** ADR-225 §Schema (sqlite-migrations v13→v14): IDs of upstream
     *  epics this epic depends on. Cardinality stays small (≤3 in
     *  observed practice). Storage column is `epics.depends_on`
     *  (TEXT NOT NULL DEFAULT '[]') — repo round-trips JSON ↔ string[].
     *  Eligibility (`epicIsEligible`, T3) requires every id here to
     *  resolve to a `status='done'` epic; cycle / self / existence
     *  validation lives in `addEpic` + `setEpicDependsOn` (T3). */
    dependsOn: z.array(z.string()).default([]),
    /** ADR-225 §Schema (sqlite-migrations v13→v14): explicit
     *  decomposition-complete + operator-greenlit bit. Decouples draft
     *  vs. ready-for-kick-off from the lifecycle `status`. Storage
     *  column `epics.is_ready` (INTEGER NOT NULL DEFAULT 0); repo
     *  coerces 0/1 ↔ boolean. Backfill at migration time flips
     *  in-progress / review / done epics to `true` so the new substrate
     *  doesn't retroactively block in-flight work (see migration body
     *  for the UPDATE). `epic.ready` event fires on 0→1; no event on
     *  1→0. */
    isReady: z.boolean().default(false),
    /** ADR-231 §D2 §Schema (sqlite-migrations v15→v16, t-6-8db78adf):
     *  Unix-epoch timestamp set when orchd auto-spawns this epic-team
     *  via `atmux team spawn-epic`. Drives the at-least-once dedup
     *  gate — orchd's spawn handler skips epics where `IS NOT NULL`.
     *  Storage column `epics.spawned_at` (INTEGER, nullable, no
     *  DEFAULT); `null` (or missing) means "not yet spawned". Set
     *  exactly once per epic by orchd's spawn-success path; operators
     *  may backfill in-flight rows manually post-migration via
     *  `UPDATE epics SET spawned_at = unixepoch() WHERE id = ?`. */
    spawnedAt: z.number().int().nullable().optional(),
    /** ADR-231 §D3 §Schema (per-epic config home): typed sub-shape
     *  inside `extra` for orchd auto-spawn configuration. `extra`
     *  itself stays `.passthrough()` so unknown sibling keys flow
     *  through (forward-compat with future per-epic config classes).
     *
     *  - `autoSpawn.enabled` — operator authorization for orchd to
     *    issue `atmux team spawn-epic` automatically once ADR-225's
     *    eligibility predicate flips. ADR-225's `is_ready=1` says
     *    "allowed to spawn at all"; `enabled=true` says "let orchd
     *    do it without manual keystroke". Both gates must pass.
     *  - `autoSpawn.roster` — roster name (e.g. `'solo'`,
     *    `'backend-heavy'`); falls back to per-team default
     *    (`team.json::autoSpawn.defaults[]`, T-S1.3) then the
     *    `'default'` literal.
     *  - `autoSpawn.forceSpawn` — pass `--force` to `atmux team
     *    spawn-epic`; bypasses ADR-225's eligibility predicate.
     *    Operator escape hatch — defaults `false`. */
    extra: z
      .object({
        autoSpawn: z
          .object({
            enabled: z.boolean(),
            roster: z.string().optional(),
            forceSpawn: z.boolean().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type KanbanEpic = z.infer<typeof KanbanEpic>;

// ---------- Per-story entry ----------

/**
 * One story. Per `lib/story.sh:21-23` schema docstring + live kanban.json.
 *
 * State machine (ADR-007):
 *   `planning → ready → in-progress → testing → review → merging → done`.
 */
export const KanbanStory = z
  .object({
    /** Bash writes `s-XXXXXXXX` (8 hex chars after `s-`). */
    id: z.string().min(1),
    /** Parent epic ID; nullable for orphaned / pre-epic stories. */
    epic: z.string().nullable().optional(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    /** Free-form acceptance criteria prose. */
    acceptanceCriteria: z.string().nullable().optional(),
    status: z.string().optional(),
    createdAt: z.number().int().optional(),
    completedAt: z.number().int().nullable().optional(),
    /** Last-state-transition timestamp. */
    advancedAt: z.number().int().nullable().optional(),
    /** True once reviewer has approved the story (gate for review→merging). */
    reviewSignoff: z.boolean().optional(),
    /** Task ID created by the auto-dispatched merge step. */
    mergeTaskId: z.string().nullable().optional(),
    /** ADR-146 §D4: source branch this Story's work lives on. Used by
     *  ADR-146 auto-emit (T2) to populate the trunk-merge Task's
     *  source-branch field. For per-member-branch teams
     *  (ADR-082+084), this is typically `<base>-<member>` (e.g.
     *  `atmux-geoyws-whip-impl`). For shared-cwd teams, this is the team's
     *  base branch (no fan-in needed; auto-emit short-circuits per
     *  ADR-146 §D5). Backward-compat: existing Stories without
     *  `branch` set get the auto-emit short-circuit (no source-
     *  branch → no auto-Task).
     *
     *  Storage note: rides through `extra` JSON column on the
     *  `stories` table — `branch` is NOT in `KNOWN_STORY_FIELDS`
     *  inside `src/core/repositories/kanban-repo.ts`, so the field
     *  serializes to `extra` on write and re-emerges via `...extra`
     *  spread on read. Zero-migration roll-out per ADR-146 backfill-
     *  via-script (T2 ships `scripts/backfill-story-branch.ts`). */
    branch: z.string().nullable().optional(),
    /** ADR-175 GAP 1: append-only audit trail for `atmux story signoff`
     *  + `atmux story unsignoff`. Each `signoff` call appends a
     *  `{ signedOffBy, signedOffAt, note }` entry; each `unsignoff`
     *  appends a `{ unsignedBy, unsignedAt, note }` counter-entry.
     *  Timestamps are epoch-ms (`Date.now()`) per ADR-175 §Decision —
     *  finer granularity than the seconds-resolution fields elsewhere
     *  on the row so back-to-back signoff/unsignoff pairs preserve
     *  ordering.
     *
     *  Storage note: rides through `extra` JSON column — NOT in
     *  `KNOWN_STORY_FIELDS` per ADR-091's extra-JSON-append pattern.
     *  Field schema kept permissive (`z.array(z.record)`) so future
     *  audit-entry additions don't churn the schema. */
    signoffAudit: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    /** ADR-175 GAP 2: how this Story integrates onto trunk.
     *
     *   - `'feature-branch'` (DEFAULT) — current behaviour.
     *     `review → merging` synthesizes a gitter/committer merge-Task
     *     per `src/core/story.ts:320-349`; `merging → done` waits on
     *     that Task. Suits the "branch off, PR-merge back" shape.
     *
     *   - `'trunk-direct'` — code lands on trunk without a feature
     *     branch / merge commit. `review → done` becomes legal
     *     (skipping `merging`); the synthetic merge-Task is NOT
     *     created. Reviewer signoff is still required (we bypass the
     *     merge phase, not the review phase). Suits platform / infra
     *     stories (submodule attach, nginx symlink, systemd unit,
     *     deploy provisioning) where there is no merge artifact.
     *
     *  Persisted as a dedicated `merge_mode` SQLite column (added in
     *  migration v9→v10 — see `src/abstractions/sqlite-migrations.ts`)
     *  and round-tripped via `KNOWN_STORY_FIELDS` in
     *  `src/core/repositories/kanban-repo.ts`. Default `'feature-branch'`
     *  applies to both legacy rows (NULL column) and rows where the
     *  caller omitted the field — `storyFromRow` passes the NULL through
     *  as `undefined` and Zod's `.default()` backfills.
     *
     *  Two values only (per ADR-175 §Decision GAP 2 — YAGNI tightens
     *  scope). A future third mode (e.g. `'no-merge'` per ADR-175
     *  OQ-3) lands additively without schema churn. */
    mergeMode: z.enum(["feature-branch", "trunk-direct"]).default("feature-branch"),
  })
  .passthrough();
export type KanbanStory = z.infer<typeof KanbanStory>;

// ---------- Top-level kanban.json ----------

/**
 * `.atmux/kanban.json` — top-level shape per `kanban_normalize`.
 * Three arrays guaranteed present after normalize; pre-normalize files
 * can be missing fields (bash hits the `//= []` defaults on first read).
 *
 * Reads should call `kanban_normalize`-equivalent BEFORE parse, OR use
 * `KanbanSafe` (Phase 2 follow-up) which makes the arrays optional and
 * defaults them to `[]`. v1 mandates the arrays present so we don't
 * paper-over a corrupted on-disk file.
 */
export const Kanban = z
  .object({
    tasks: z.array(KanbanTask),
    epics: z.array(KanbanEpic),
    stories: z.array(KanbanStory),
  })
  .passthrough();
export type Kanban = z.infer<typeof Kanban>;

/** Alias for ergonomic import: `import { KanbanSchema } from "./schema/kanban.ts"`. */
export const KanbanSchema = Kanban;
