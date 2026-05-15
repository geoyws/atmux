// ADR-134 §state-machine: Zod schema for the `merger_state` SQLite
// table row. Application-layer mirror of the v5→v6 migration in
// `src/abstractions/sqlite-migrations.ts`; the CHECK constraint on
// `state` is the database-layer mirror.
//
// Used by `src/core/repositories/merger-state-repo.ts` for row↔domain
// bridging — bun:sqlite's `.get()` returns `unknown` for typed-CRUD
// purposes, and this schema gates every read against the closed
// `BranchMergeState` literal union. Writes flow through the repo's
// typed input shape (no schema parse on the way in — the closed
// union is already enforced at compile time by the caller).

import { z } from "zod";
import { type BranchMergeState, BRANCH_MERGE_STATES } from "../core/branch-merge-state.ts";

/** Closed Zod enum mirroring {@link BRANCH_MERGE_STATES}. The cast
 *  preserves the literal union — the runtime values come from
 *  `BRANCH_MERGE_STATES` (the single source of truth in
 *  `branch-merge-state.ts`); the type-system narrows back to the
 *  `BranchMergeState` union so callers see `row.state: BranchMergeState`
 *  not `string`. */
export const BranchMergeStateEnum = z.enum(
  BRANCH_MERGE_STATES as unknown as readonly [BranchMergeState, ...BranchMergeState[]],
);

/** Branch-merge state ledger row.
 *
 * Primary key is the composite `(team, branchKey)` — one row per
 * `<team>:<base>-<member>` pair. `branchKey` is the per-member branch
 * name verbatim (e.g. `geoyws-whip-impl`) and is the only addressable
 * handle the auto-merger uses; the team-name field disambiguates
 * across multi-team cockpit hosts.
 *
 * `note` is operator-facing — surfaces in `atmux status` collisions,
 * Discord conflict pings, and the auditor's staleness probe. Set by
 * `shouldTransitionFromInProgress.reason` on every transition; the
 * conflict-surface path writes `conflict at <SHA>` per ADR-134
 * §Conflict surface §1.
 *
 * `updatedAt` is unix-seconds epoch; the repo refreshes it on every
 * transition. The hot-path `loadAll(team)` query orders by it DESC
 * so the dispatcher sees most-recently-touched branches first.
 */
export const MergerStateRow = z
  .object({
    team: z.string().min(1),
    branchKey: z.string().min(1),
    state: BranchMergeStateEnum,
    note: z.string().nullable(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MergerStateRow = z.infer<typeof MergerStateRow>;
