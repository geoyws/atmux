// ADR-134 §state-machine: branch-merge state repository.
//
// Reads / writes the v5→v6 `merger_state` table (one row per
// `(team, branch_key)`). The primary contract is `transition()`:
// it advances a branch from a known `fromState` to a new `toState`
// inside a `BEGIN IMMEDIATE` SQLite transaction per ADR-091 audit
// pre-flag #1. Concurrent event-driven dispatcher + cron-backstop
// fires that race the same row both reach the writer lock; the
// later one observes the post-transition state via its `fromState`
// guard and short-circuits (returns `applied: false`) instead of
// double-applying the transition.
//
// `BEGIN IMMEDIATE` vs default `BEGIN DEFERRED`: deferred upgrades
// the read-locked transaction on first write, allowing two
// concurrent writers to think they own the row until SQLITE_BUSY
// surfaces at write time. IMMEDIATE acquires the writer lock at
// `BEGIN` — only one transaction enters; the other waits or
// retries. Matches the audit invariant in the ADR-091 reviewer
// pre-flag.
//
// Reads use a plain prepared SELECT (no transaction wrap); the
// dispatcher's per-tick sweep is `loadAll(team)` ordered by
// `updated_at DESC` which uses the `idx_merger_state_team_updated`
// covering index.

import type { Database } from "bun:sqlite";
import { type BranchMergeState, BRANCH_MERGE_STATES } from "../branch-merge-state.ts";
import type { MergerStateRow } from "../../schema/merger-state.ts";

// ---------- Row shape (SQL columns; raw bun:sqlite output) ----------

interface DbRow {
  team: string;
  branch_key: string;
  state: string;
  note: string | null;
  updated_at: number;
}

const STATE_SET: ReadonlySet<string> = new Set(BRANCH_MERGE_STATES);

function rowFromDb(row: DbRow): MergerStateRow {
  if (!STATE_SET.has(row.state)) {
    // The CHECK constraint at the table level guarantees this in
    // production; defensive throw guards against migrations that
    // race the read or hand-edited rows.
    throw new Error(`merger_state: invalid state literal '${row.state}'`);
  }
  return {
    team: row.team,
    branchKey: row.branch_key,
    state: row.state as BranchMergeState,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

// ---------- Input shapes ----------

/** Inputs to {@link MergerStateRepo.upsertOpen} — used by the
 *  dispatcher's "task done event arrived; seed an `open` row if
 *  none exists for this branch" path. Idempotent: existing rows
 *  for the same key short-circuit. */
export interface UpsertOpenInput {
  team: string;
  branchKey: string;
  now: number;
}

/** Inputs to {@link MergerStateRepo.transition} — explicit `from →
 *  to` shape required by the audit invariant (the guard checks the
 *  row's current state against `fromState` before applying `toState`;
 *  a mismatch surfaces as `applied: false` so the caller can decide
 *  to retry or accept the post-write state). */
export interface TransitionInput {
  team: string;
  branchKey: string;
  fromState: BranchMergeState;
  toState: BranchMergeState;
  note: string | null;
  now: number;
}

export interface TransitionResult {
  /** True when the transition was applied (row.state was `fromState`
   *  on entry; now `toState`). False when the row was missing OR its
   *  current state didn't match `fromState` (e.g. another writer
   *  already advanced it). */
  applied: boolean;
  /** The row state on entry. `null` when no row existed. Used by the
   *  caller's no-op log line. */
  observedFrom: BranchMergeState | null;
}

// ---------- Repository ----------

export class MergerStateRepo {
  constructor(private readonly db: Database) {}

  /** Load a single row by `(team, branchKey)`. Returns `null` when
   *  absent — the dispatcher's `task done` event seeds via
   *  {@link upsertOpen} on null. */
  load(team: string, branchKey: string): MergerStateRow | null {
    const row = this.db
      .prepare("SELECT team, branch_key, state, note, updated_at FROM merger_state WHERE team = ? AND branch_key = ?")
      .get(team, branchKey) as DbRow | null;
    return row === null ? null : rowFromDb(row);
  }

  /** Load every row for a team, ordered most-recently-touched first.
   *  Used by the dispatcher's per-tick sweep + the auditor's
   *  staleness probe. */
  loadAll(team: string): MergerStateRow[] {
    const rows = this.db
      .prepare(
        "SELECT team, branch_key, state, note, updated_at FROM merger_state WHERE team = ? ORDER BY updated_at DESC",
      )
      .all(team) as DbRow[];
    return rows.map(rowFromDb);
  }

  /** Load only non-terminal rows for a team. Backed by the partial
   *  index `idx_merger_state_open`; cheap per-tick read. */
  loadOpen(team: string): MergerStateRow[] {
    const rows = this.db
      .prepare(
        "SELECT team, branch_key, state, note, updated_at FROM merger_state WHERE team = ? AND state NOT IN ('merged','conflict','reverted') ORDER BY updated_at DESC",
      )
      .all(team) as DbRow[];
    return rows.map(rowFromDb);
  }

  /** Idempotent insert: seed an `open` row when none exists. Used
   *  by the dispatcher on the first task-done event for a branch.
   *  Pure no-op when a row already exists — does NOT bump
   *  `updated_at` (the existing state is the source of truth). */
  upsertOpen(input: UpsertOpenInput): boolean {
    const r = this.db
      .prepare(
        "INSERT INTO merger_state (team, branch_key, state, note, updated_at) VALUES (?, ?, 'open', NULL, ?) ON CONFLICT(team, branch_key) DO NOTHING",
      )
      .run(input.team, input.branchKey, input.now);
    return r.changes > 0;
  }

  /** Apply a state transition under a `BEGIN IMMEDIATE` transaction
   *  per ADR-091 audit pre-flag #1.
   *
   *  Guard: the row's current state MUST equal `fromState`; otherwise
   *  the transition is a no-op (returns `{ applied: false }`). This
   *  is the load-bearing concurrency property — two writers racing
   *  the same row will both reach the writer lock; the second one
   *  sees the post-transition state in its guarded read and
   *  short-circuits without overwriting.
   *
   *  Caller MUST NOT wrap this in `transact()` — `BEGIN IMMEDIATE`
   *  is incompatible with bun:sqlite's `db.transaction()` default-
   *  deferred wrapper. */
  transition(input: TransitionInput): TransitionResult {
    // Manual `BEGIN IMMEDIATE` so we get the writer-lock invariant
    // ADR-091 audit pre-flag #1 demands. bun:sqlite's
    // `db.transaction()` uses `BEGIN DEFERRED` which would let two
    // concurrent dispatchers race past their guarded reads before
    // either has committed; IMMEDIATE serializes them at BEGIN time.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cur = this.db
        .prepare("SELECT state FROM merger_state WHERE team = ? AND branch_key = ?")
        .get(input.team, input.branchKey) as { state: string } | null;
      if (cur === null) {
        this.db.exec("ROLLBACK");
        return { applied: false, observedFrom: null };
      }
      if (cur.state !== input.fromState) {
        this.db.exec("ROLLBACK");
        return { applied: false, observedFrom: cur.state as BranchMergeState };
      }
      this.db
        .prepare(
          "UPDATE merger_state SET state = ?, note = ?, updated_at = ? WHERE team = ? AND branch_key = ?",
        )
        .run(input.toState, input.note, input.now, input.team, input.branchKey);
      this.db.exec("COMMIT");
      return { applied: true, observedFrom: input.fromState };
    } catch (e) {
      // ROLLBACK is safe on a failed BEGIN/UPDATE; the SQLite
      // writer lock is released regardless of which step threw.
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // expected: ROLLBACK on an already-rolled-back transaction
        // throws; we swallow because we're already in an error path.
      }
      throw e;
    }
  }
}
