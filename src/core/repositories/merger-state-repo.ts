// ADR-134 §state-machine / t-6a959e02: merger state repository.
//
// Wraps the `merger_state` table (migration v5→v6 in
// `src/abstractions/sqlite-migrations.ts`). One row per
// `<base>-<member>` branch tracked by the team's gitter loop;
// PRIMARY KEY is the branch name itself (operator-visible, unique
// within the team's state.db scope per ADR-134 §state-machine).
//
// Caller surface — `src/core/intra-team-merge.ts` (ADR-134 T2,
// in-flight on whip-impl) consumes:
//
//   1. `getState(memberBranch)` — read current state + note before
//      computing the next transition.
//   2. `transition({ memberBranch, next, note?, by?, baseSha?,
//      conflictSha? })` — atomic write of a state transition wrapped
//      in BEGIN IMMEDIATE (per the ADR-091 reviewer pre-flag audit §3
//      + ADR-134 §state-machine race-protection guarantee). Insert on
//      first transition for a new branch; update on subsequent ones.
//   3. `listByState(state)` — cron sweep input. Hits the v6 index
//      `idx_merger_state_state`.
//   4. `listAll()` — diagnostic / doctor sweep over every tracked
//      branch.
//
// Zod validation runs at the function boundary: callers pass an
// unvalidated `MergerStateTransition` and the repo parses it before
// any SQL fires. This catches state-string typos (e.g. `merged ` with
// trailing space) at the boundary rather than persisting them.

import { z } from "zod";
import {
  type BranchMergeState,
  BRANCH_MERGE_STATES,
} from "../branch-merge-state.ts";
import { type Database, transactImmediate } from "../../abstractions/sqlite.ts";

/** Zod enum of every valid state literal. Mirrors
 *  {@link BRANCH_MERGE_STATES}; the cast asserts the const tuple
 *  shape Zod's `z.enum` requires. */
const StateEnum = z.enum(
  BRANCH_MERGE_STATES as unknown as readonly [string, ...string[]],
);

/** Caller identity for `transitioned_by`. Permissive — accepts the
 *  three canonical triggers plus an arbitrary string (typically a
 *  member name for operator-driven manual transitions). */
const TransitionByEnum = z.union([
  z.literal("event"),
  z.literal("cron"),
  z.literal("operator"),
  z.string().min(1),
]);

/** Input to {@link MergerStateRepo.transition}. Validated at the
 *  function boundary so callers can pass loosely-typed data and trust
 *  the repo to surface a `ZodError` with the offending field path
 *  before any SQL fires. */
export const MergerStateTransition = z.object({
  /** The `<base>-<member>` branch name. Primary key in the
   *  `merger_state` table — `geoyws-fe-1`, `geoyws-up-impl`, etc. */
  memberBranch: z.string().min(1),
  /** Next state. Must be one of {@link BRANCH_MERGE_STATES}. */
  next: StateEnum,
  /** Operator-facing reason for the transition. Lands in
   *  `merger_state.note`. Optional — terminal-state transitions
   *  typically carry an explanation (`"conflict at <SHA>"`,
   *  `"test suite failed"`); cron-tick self-loops at `in_progress`
   *  may set this to `null` or a stale reason. */
  note: z.string().nullable().optional(),
  /** Caller identity. `event` for the socket-pubsub fast path;
   *  `cron` for the backstop sweep; `operator` for manual `atmux`
   *  resets from a terminal state; any other string for member-driven
   *  transitions. */
  by: TransitionByEnum.optional(),
  /** Optional commit SHA at the time of the transition. Useful for
   *  `merging`/`tested`/`merged` — records the merge target SHA. */
  baseSha: z.string().nullable().optional(),
  /** Optional conflict SHA. Set on `conflict` transitions (the SHA
   *  where the merge failed) so the operator-facing flag can surface
   *  the location without re-running `git`. */
  conflictSha: z.string().nullable().optional(),
  /** Epoch seconds for the transition timestamp. Caller-provided so
   *  tests can pin time; production callers pass `Math.floor(Date.now()
   *  / 1000)`. */
  transitionedAt: z.number().int(),
});
export type MergerStateTransition = z.infer<typeof MergerStateTransition>;

/** Persisted shape of one merger_state row — repo-ergonomic field
 *  names (camelCase) over the SQL column names (snake_case). State
 *  strings are passed through unchanged from SQL; the
 *  {@link BranchMergeState} type tightens the static typing at the
 *  TypeScript boundary. */
export interface MergerStateRow {
  memberBranch: string;
  state: BranchMergeState;
  note: string | null;
  transitionedAt: number;
  transitionedBy: string | null;
  baseSha: string | null;
  conflictSha: string | null;
}

interface MergerStateRawRow {
  member_branch: string;
  state: string;
  note: string | null;
  transitioned_at: number;
  transitioned_by: string | null;
  base_sha: string | null;
  conflict_sha: string | null;
}

function rowFromRaw(raw: MergerStateRawRow): MergerStateRow {
  return {
    memberBranch: raw.member_branch,
    state: raw.state as BranchMergeState,
    note: raw.note,
    transitionedAt: raw.transitioned_at,
    transitionedBy: raw.transitioned_by,
    baseSha: raw.base_sha,
    conflictSha: raw.conflict_sha,
  };
}

export class MergerStateRepo {
  constructor(private db: Database) {}

  /** Read the current row for a member branch. Returns `null` when
   *  the branch has never transitioned (callers treat null as
   *  implicit `open` per ADR-134 §state-machine "initial state of
   *  every per-member branch is `open`"). */
  getState(memberBranch: string): MergerStateRow | null {
    const raw = this.db
      .query(
        `SELECT * FROM merger_state
         WHERE member_branch = $member_branch`,
      )
      .get({ $member_branch: memberBranch }) as MergerStateRawRow | null;
    return raw === null ? null : rowFromRaw(raw);
  }

  /** Apply a state transition atomically. BEGIN IMMEDIATE so
   *  concurrent event-driven + cron-backstop firings on the same
   *  branch serialize correctly. UPSERT semantics — first call for a
   *  given `memberBranch` inserts; subsequent calls update.
   *
   *  Validation: input runs through {@link MergerStateTransition}
   *  parsing before any SQL — invalid state literals / empty strings
   *  surface as `ZodError` (with field path) at the call site rather
   *  than persisting bad data. */
  transition(input: MergerStateTransition): MergerStateRow {
    const parsed = MergerStateTransition.parse(input);
    return transactImmediate(this.db, () => {
      this.db
        .query(
          `INSERT INTO merger_state (
            member_branch, state, note, transitioned_at, transitioned_by,
            base_sha, conflict_sha
          )
          VALUES ($member_branch, $state, $note, $transitioned_at, $transitioned_by,
                  $base_sha, $conflict_sha)
          ON CONFLICT(member_branch) DO UPDATE SET
            state = excluded.state,
            note = excluded.note,
            transitioned_at = excluded.transitioned_at,
            transitioned_by = excluded.transitioned_by,
            base_sha = excluded.base_sha,
            conflict_sha = excluded.conflict_sha`,
        )
        .run({
          $member_branch: parsed.memberBranch,
          $state: parsed.next,
          $note: parsed.note ?? null,
          $transitioned_at: parsed.transitionedAt,
          $transitioned_by: parsed.by ?? null,
          $base_sha: parsed.baseSha ?? null,
          $conflict_sha: parsed.conflictSha ?? null,
        });
      // Read-back inside the same transaction so the returned row
      // reflects exactly what landed (defensive — guards against the
      // UPSERT returning the pre-update row on some SQLite versions).
      const raw = this.db
        .query(
          `SELECT * FROM merger_state
           WHERE member_branch = $member_branch`,
        )
        .get({ $member_branch: parsed.memberBranch }) as MergerStateRawRow;
      return rowFromRaw(raw);
    });
  }

  /** List every row currently in the given state. Cron-sweep entry
   *  point — pairs with the v6 `idx_merger_state_state` index. */
  listByState(state: BranchMergeState): MergerStateRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM merger_state
         WHERE state = $state
         ORDER BY transitioned_at ASC`,
      )
      .all({ $state: state }) as MergerStateRawRow[];
    return rows.map(rowFromRaw);
  }

  /** List every tracked branch, most-recently-transitioned first.
   *  Diagnostic surface for doctor / status verbs. */
  listAll(): MergerStateRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM merger_state
         ORDER BY transitioned_at DESC`,
      )
      .all() as MergerStateRawRow[];
    return rows.map(rowFromRaw);
  }

  /** Delete a row by branch — used by `atmux stop --prune-branch`
   *  (ADR-084 OQ-2 follow-up) when the operator removes a merged
   *  member branch and the state-row should follow. No-op when the
   *  row doesn't exist. */
  deleteState(memberBranch: string): void {
    this.db
      .query("DELETE FROM merger_state WHERE member_branch = $member_branch")
      .run({ $member_branch: memberBranch });
  }
}
