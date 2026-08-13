// ADR-228 §D2: orchd spawn-queue row schema.
//
// One row per pressure-refused spawn request awaiting drain. Mirrors the
// v13→v14 `spawn_queue` table in
// `src/abstractions/sqlite-migrations.ts:647` (see also the table-purpose
// docblock above it, and the `TODO_FAN_IN_RENUMBER` marker for the
// sibling-epic slot collision). Field names match the SQL columns modulo
// snake/camel translation in the repo's row↔domain bridge (lands in
// t-2-e666f1fb, SpawnQueue repository).
//
// Reserved namespace + format: `q-<8 lowercase hex>` per ADR-184
// §queueId regex. The branded `SpawnQueueId` type prevents accidental
// mixing with other prefixed IDs (`t-`, `e-`, `s-`) at the TS layer
// without changing runtime serialization.
//
// `state` is the load-bearing CHECK-constrained lifecycle: `queued` →
// `spawning` (transient, set under BEGIN IMMEDIATE) → terminal (row
// deleted on success; row updated to `abandoned` after `MAX_ATTEMPTS`).
// Allowlist mirrored at schema level via `SPAWN_QUEUE_STATES` so verbs
// reject unknown states at write time.
//
// `.passthrough()` mirrors the row-schema convention from sibling files
// (`src/schema/complaints.ts`):
// forward-compat with future column additions matters more than
// strict-rejection. SQLite-row schemas omit `schemaVersion` (the README
// `schemaVersion` rule scopes to JSON-file schemas only — SQLite
// migrations carry their own versioning via
// `src/abstractions/sqlite-migrations.ts`).

import { z } from "zod";

// ---------- Enums (write-side validation) ----------

/**
 * Closed lifecycle states. SQL-side CHECK constraint mirrors this list
 * (`src/abstractions/sqlite-migrations.ts:663`).
 *
 *   - `queued`     — awaiting drain (initial state per SQL DEFAULT).
 *   - `spawning`   — drain tick has dequeued the row under BEGIN
 *                    IMMEDIATE and is executing the spawn. Transient;
 *                    on success the row is deleted, on failure it's
 *                    bounced back to `queued` (with `attempts++` and
 *                    `last_attempt_at_sec` set) or to `abandoned`
 *                    after `MAX_ATTEMPTS`.
 *   - `abandoned`  — terminal failure state. Row persists for operator
 *                    audit; never re-tried by drain.
 */
export const SPAWN_QUEUE_STATES = ["queued", "spawning", "abandoned"] as const;
export type SpawnQueueState = (typeof SPAWN_QUEUE_STATES)[number];

// ---------- Branded ID ----------

/**
 * Format: `q-` + 8 lowercase hex characters. Mirrors ADR-184 §queueId
 * regex. The generator (lands in t-2-e666f1fb SpawnQueue repository)
 * owns format production; this schema validates on the read path.
 */
export const SPAWN_QUEUE_ID_PATTERN = /^q-[0-9a-f]{8}$/;

/**
 * Branded queue ID. Zod `.brand()` adds a nominal TS type ("SpawnQueueId")
 * without changing the runtime shape — a `SpawnQueueId` is still a
 * string at runtime, but cannot be passed where a plain `string` (or a
 * differently-branded ID like a `TaskId`) is expected. Prevents
 * accidental ID-class mixing at call sites.
 */
export const SpawnQueueId = z.string().regex(SPAWN_QUEUE_ID_PATTERN).brand("SpawnQueueId");
export type SpawnQueueId = z.infer<typeof SpawnQueueId>;

// ---------- Row schema ----------

/**
 * One `spawn_queue` row, domain shape. Field-by-field mirror of
 * `src/abstractions/sqlite-migrations.ts:651-665`:
 *
 * | SQL column            | Domain field         | Default (SQL)  | Default (Zod) |
 * |-----------------------|----------------------|----------------|---------------|
 * | queue_id              | queueId              | —              | —             |
 * | epic_id               | epicId               | —              | —             |
 * | spawn_args            | spawnArgs            | —              | —             |
 * | queued_at_sec         | queuedAtSec          | —              | —             |
 * | queued_by             | queuedBy             | —              | —             |
 * | priority              | priority             | 5              | 5             |
 * | attempts              | attempts             | 0              | 0             |
 * | last_attempt_at_sec   | lastAttemptAtSec     | NULL           | null          |
 * | last_failure_reason   | lastFailureReason    | NULL           | null          |
 * | state                 | state                | 'queued'       | 'queued'      |
 *
 * `.passthrough()` for forward-compat (sibling-pattern with
 * `Complaint`).
 */
export const SpawnQueueRow = z
  .object({
    /** PK; `q-<8 hex>` per `SPAWN_QUEUE_ID_PATTERN`. */
    queueId: SpawnQueueId,
    /** The epic-id this spawn request targets (`e-<id>`). Not branded
     *  here — the project doesn't yet expose an `EpicId` brand and
     *  introducing one is out-of-scope for this Task. */
    epicId: z.string().min(1),
    /** JSON-encoded full argv to replay on dequeue. Stored as TEXT in
     *  SQL; parsed by the drain tick (lands in t-8-da5f290e). Kept as
     *  `string` here to avoid double-encoding through the schema —
     *  callers JSON.stringify the argv array before insert and the
     *  drain tick JSON.parse it on dequeue. */
    spawnArgs: z.string(),
    /** Epoch seconds when the request was queued. Integer; test clocks
     *  inject via fixed values. */
    queuedAtSec: z.number().int().nonnegative(),
    /** Requester identity — member name (e.g. `fe-1`), `driver`, or a
     *  daemon label. Free-form at schema level. */
    queuedBy: z.string().min(1),
    /** 1-5 priority (1 = highest); FIFO within the same priority. SQL
     *  DEFAULT is 5 — most spawns are lowest-priority and yield to
     *  explicit operator-bumped requests. */
    priority: z.number().int().min(1).max(5).default(5),
    /** Drain re-attempt counter. Incremented on each failed drain;
     *  row flips to `abandoned` after `MAX_ATTEMPTS` (constant lives
     *  with the drain tick). SQL DEFAULT is 0. */
    attempts: z.number().int().nonnegative().default(0),
    /** Epoch seconds of the most recent drain attempt. `null` until
     *  the first attempt — distinguishes "never tried" from "tried
     *  and failed at t=0". */
    lastAttemptAtSec: z.number().int().nonnegative().nullable().default(null),
    /** Free-form one-line failure reason from the most recent failed
     *  drain attempt (e.g. `host-pressure-still-high`,
     *  `spawn-handler-exit-1`). Surfaces in the operator-visible
     *  `atmux orchd queue list` output (lands in t-3-306e935d). */
    lastFailureReason: z.string().nullable().default(null),
    /** Lifecycle. SQL DEFAULT is `queued`; SQL CHECK constraint
     *  pins the allowed set to `SPAWN_QUEUE_STATES`. */
    state: z.enum(SPAWN_QUEUE_STATES).default("queued"),
  })
  .passthrough();
export type SpawnQueueRow = z.infer<typeof SpawnQueueRow>;

// ---------- Insert / Update partials ----------

/**
 * Insert-side schema — identical to `SpawnQueueRow` because every
 * column with a SQL DEFAULT also has a Zod `.default()`, so callers
 * MAY omit `priority`, `attempts`, `lastAttemptAtSec`,
 * `lastFailureReason`, and `state`. Exported as a distinct alias so
 * the repo's insert method has a self-documenting parameter type.
 */
export const SpawnQueueInsert = SpawnQueueRow;
export type SpawnQueueInsert = z.infer<typeof SpawnQueueInsert>;

/**
 * Update-side schema — every field optional. The repo's
 * partial-update method (e.g. `incrementAttempts`,
 * `markAbandoned`, `dequeueHead`'s state flip) passes only the
 * fields it touches; the rest stay as-is in the row.
 */
export const SpawnQueueUpdate = SpawnQueueRow.partial();
export type SpawnQueueUpdate = z.infer<typeof SpawnQueueUpdate>;
