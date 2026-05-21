# ADR-176: EPIC-aware lane-drift-revert — skip parents with progressing children

> **Renumbering note**: originally drafted as ADR-171 on the planner branch (63d0b55); renumbered to 176 on merge to trunk because 086c142 had already shipped a different ADR-171 (`tmux-conf-local-override`, carve-out from ADR-163). Append-only/monotonic invariant preserved per ADR-091.

**Status**: Accepted — ratified by driver 2026-05-21 (4th criterion (d) `epic-children-progressing` is additive — only skips reverts; never causes them; §OQ recommendations as-written)
**Date**: 2026-05-17
**Supersedes (in part)**: ADR-127 §OQ5 — the 3-criterion auto-revert algorithm gains a 4th criterion (`epic-children-progressing`). Original 3 criteria remain; this ADR tightens the algorithm, never relaxes it.

## Context

`src/core/lane-drift.ts` (per ADR-127 §OQ5) reverts an `in-progress` Task to `todo` when **all three** of the following hold:

- **(a)** `claimedAt` more than 30 min ago
- **(b)** Claiming worker's pane state is non-`READY`
- **(c)** No commit in the last 30 commits references the Task's id (`t-[0-9a-f]{8}`)

The algorithm has **no EPIC-awareness**. EPIC parents — kanban Tasks whose `.id` is referenced by other Tasks via `.epic = <parent-id>` — are *tracking shells*, not units of execution. The planner claims an EPIC to set status + author the decomp; sub-tasks (T1–Tn) are where the actual commits land. Commit messages reference *sub-task* ids (`t-846e43dd ADR-167 T1: ...`), never the parent EPIC id.

Result: criterion (c) is structurally false-positive for every EPIC parent. Combined with (a) trivially true once decomp is hours old, and (b) effectively true whenever the planner is mid-thought on something else, the auto-revert fires nuisance log entries against EPIC parents that are *correctly* in-progress.

**Observed 2026-05-17** in `.atmux/flags.md` tail — seven EPIC-level Tasks owned by planner flagged:

- `t-eee6769e` (ADR-167 cockpit rotate) — T1 ADR shipped `43c3c8b`; T2–T8 queued in epic-team `e-0b90d6ac`
- `t-db08e5bb` (ADR-144 epic-team test-gate) — T1 ADR shipped `aa3c551`; T2–T5 queued in epic-team `e-03919b3b`
- `t-b9529ea9` (ADR-132 pluggable whip-manager — pre-sentinel-rename)
- `t-51d2c635` (ADR-134 in-team auto-merger)
- `t-dfbf7eb0` (ADR-139 refusal-pattern detection)
- and 2 more sibling EPIC parents

All seven were structurally correct in `in-progress` because sub-tasks were progressing under epic-teams; the auto-revert wrapper logged but should never have evaluated `action: "revert"`.

### Sibling observation (out of scope here — filed as a separate T-investigate)

The flags.md log entries claim `auto-reverted to todo` but `atmux task show t-eee6769e` still reads `status=in-progress / owner=planner`. Either (i) the verb wrapper emits the log without applying the SQL revert, (ii) post-revert re-claims undid it, or (iii) `--dry-run` was on. Whichever, it's a write-discipline bug in the lane-drift *wrapper*, separate from the helper's EPIC-blind algorithm. Filed as **T-INVESTIGATE: lane-drift state-divergence (log says reverted, state.db says in-progress)** with this ADR's EPIC.

## Decision

Add a **fourth criterion (d)** to `checkLaneDrift`:

> **(d)** The Task has **no progressing children**. A child is any kanban Task where `.epic === task.id`. A child is "progressing" iff at least one of:
>
> - status ∈ {`in-progress`, `review`, `testing`, `merging`, `done`}, OR
> - a commit ref to the child's id appears in the same `recentCommitsText` window already fetched for criterion (c).
>
> If the Task has children (i.e., it is an EPIC parent) AND any child is progressing → action `skip` with reason `"epic-children-progressing"`. Non-EPIC Tasks (children map empty) are unaffected.

All four criteria must hold for `action: "revert"`. Criterion (d) is **additive** — it only ever skips reverts, never causes them.

Helper signature gains one field:

```ts
interface CheckLaneDriftOpts {
  // ... existing fields
  /** Map of parentTaskId → child-tasks for EPIC-awareness. Verb
   *  pre-builds by indexing all tasks on `.epic`. Empty / unset map
   *  preserves legacy behavior — criterion (d) is a no-op. */
  childrenByParentId?: ReadonlyMap<string, ReadonlyArray<KanbanTask>>;
}
```

The verb wrapper (caller — likely `src/verbs/groom.ts` or the lane-tick handler) is responsible for:

1. Loading all kanban Tasks (not just `in-progress`).
2. Building `childrenByParentId` via `Map<parentId, child[]>` keyed on each Task's `.epic` field.
3. Passing it to `checkLaneDrift`.

New `DriftDecision.reason` enum value: `"epic-children-progressing"`. Surfaced unconditionally in evidence so `--dry-run` callers can grep what was skipped and why.

## Consequences

| Lane    | What changes                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------- |
| **be**  | `src/core/lane-drift.ts` gains criterion (d) + `childrenByParentId` opt field. Pure, no IO.             |
| **be**  | Verb wrapper (lane-tick / groom call site) pre-builds the children map from all-tasks.                  |
| **test**| New unit cases: (1) EPIC parent with one in-progress child → skip; (2) EPIC parent with all-todo children → revert (todo doesn't count); (3) non-EPIC Task (no children entry) → behavior unchanged; (4) EPIC parent with `done` child but `claimedAgoMin` past threshold → skip (done child still counts as progressing — the EPIC isn't dead). |
| **ops** | None — the cron line is unchanged; the verb internals tighten.                                          |
| **docs**| `docs/adr/127-lane-claim-auto-pickup.md` §OQ5 gains an amendment header pointing to ADR-176.            |

**What we give up**: a stuck-EPIC-with-stuck-children case won't auto-revert (children also stuck, none "progressing"). **Mitigation**: leaf-Task drift reverts cascade — once each child is reverted to `todo`, parent becomes eligible on the next tick (children no longer progressing). The cascade is the correct order anyway: revert leaves first, parents only after the structural reason for staying claimed is gone.

**Rollback path**: revert this ADR's TR2; helper signature is additive (callers passing no `childrenByParentId` get original behavior).

## Open questions

1. **Should `todo` children count as "progressing"?** **Default**: NO. A stuck EPIC with all-todo children is exactly the case operators want flagged ("decomp landed but nothing's moved"). *Why*: progress requires evidence of motion (status flip or commit), not just decomp existence.
2. **Should criterion (d) apply to any Task with `deps[]` dependents, not just EPIC parents?** **Default**: NO — ONLY EPIC-parent relationships (children with `.epic === task.id`). *Why*: `deps[]` expresses ordering between leaf Tasks; EPIC parentage expresses tracking-shell-with-execution-children. They are different semantics; bundling them risks false-skips on legitimately stuck leaves.
3. **What about Stories?** Stories are EPIC children themselves. If a Story is claimed and has its own Tasks under it (`.story = <sid>`), should it qualify for criterion (d)? **Default**: YES — extend the check transitively. A Story-claim with progressing leaf-Tasks under it is the same shape as an EPIC-claim with progressing T1-Tn. Verb-side: index on both `.epic` AND `.story` when building the children map.

## Reversibility

`medium`. Helper signature is additive; callers can roll back by passing an empty children map. Production impact is "fewer reverts" — no new mutations introduced. If criterion (d) over-skips and a real stuck-EPIC sits in-progress indefinitely, the cascade-then-revert behavior described above provides natural drainage once the children fall back to todo via their own drift checks.

## Related

- **ADR-127** (`lane-claim-auto-pickup-cron-and-universal-supervision`) §OQ5 — the original 3-criterion specification this ADR amends.
- **ADR-131** (`superdoctor-kanban-hygiene-auto-fix-loop`) §Amendment 2026-05-17 — sibling tightening on the auto-CLOSE path ("shipped via SHA" 5/6 false-positive rate). ADR-176 addresses the auto-REVERT path with the same scope-match discipline.
- **ADR-091** (`epic-team-lifecycle-and-trunk-merge-gate`) — EPIC parents in atmux dogfooding are typically claimed by `planner` for decomp + tracking, while sub-tasks execute under spawned epic-teams. ADR-176's criterion (d) reflects that two-tier topology.
