# ADR-174: `atmux task list` — add `--epic <eid>` and `--story <sid>` filters

**Status**: proposed (deferred: task list `--epic`/`--story` flags rejected by CLI as of 2026-05-22 audit — `atmux task list --epic <eid>` errors with `unknown arg: --epic`; original ratification 2026-05-21 was bookkeeping — see §Amendment 2026-05-22 below.)
**Date**: 2026-05-18
**Driver-ref**: ADR-193 §OQ-4 ("file as a sibling follow-up ADR/task. ADR-193 stays focused on the write-side gap; read-side ergonomics is a separate ADR") + ADR-173 §Related ("`atmux task list --epic` filter remains as a future fast-follow").
**Relates**: ADR-193 (write-side `--epic`/`--story` flags — runtime prerequisite), ADR-173 (`atmux epic show` children enumeration — sibling read-side surface), ADR-007 (Epic/Story/Task hierarchy original spec), ADR-006 (JSON output stability convention).

## Context

`atmux task list` today accepts `[--status S] [--assignee M] [--lane L] [--json]`. Filtering by EPIC parentage or Story parentage is not available; operators must `--json | jq '.[] | select(.epic == "e-xxx")'` to slice the kanban by parent.

Three friction points observed in the planner-decomp loop:

1. **Pull-model claim verification** — workers running `atmux claim --next` want to see the EPIC's eligible-Task slice (filtered by `--epic` + `--lane` + `--status todo`) BEFORE claiming, so they can pre-check deps. Today they list-all + grep on subject prefix, missing tasks whose subject doesn't carry the EPIC slug.
2. **Planner re-decomp confirmation** — after filing T1–Tn under an EPIC, `atmux task list --epic <eid>` is the natural "show me the decomp" command. `atmux epic show <eid>` (ADR-173) covers the *tree* view; `atmux task list --epic <eid>` covers the *flat filtered* view with the same column shape as the rest of the kanban.
3. **Cockpit + reviewer rollup** — `/bau`, `/bruh`, `superdoctor`, and the reviewer brief all consume kanban slices. Per-EPIC slicing via shell pipeline is brittle (jq path drift, JSON-key changes). A first-class filter flag is the durable interface.

ADR-173 chose a *tree* render for `atmux epic show`; ADR-174 keeps the *flat* render of `atmux task list` and just narrows the WHERE clause. Different verbs, different shapes, no overlap.

## Decision

`atmux task list` gains two new optional filter flags:

```
atmux task list [--status S] [--assignee M] [--lane L] [--epic <eid>] [--story <sid>] [--json]
```

- `--epic <eid>` — filter to tasks where `.epic === eid`. `eid` regex-validated as `e-[0-9a-f]{8}` per ADR-193.
- `--story <sid>` — filter to tasks where `.story === sid`. `sid` regex-validated as `s-[0-9a-f]{8}`.
- Combined with existing flags via AND. `atmux task list --epic e-xxx --status todo --lane be` = "todo BE-lane tasks under EPIC e-xxx".
- Combined `--epic` + `--story` is allowed; resolves to AND. Useful when a Story is partway through a multi-EPIC restructure (rare) — but operators usually pass one or the other.
- `--epic ''` / `--story ''` explicitly match tasks with `null` field — i.e. "show me orphan tasks not under any EPIC". Edge case but greppable.

### Output shape

Unchanged. Same columns as today: `ID / STATUS / OWNER / PRIO / F / SUBJECT`. `--json` returns the same per-task shape, just filtered to the matching slice. Per ADR-006, no key removal or rename — pure WHERE-narrowing.

### Sort order

Unchanged. Same default as today (createdAt ASC). Operators wanting priority-sort can pipe through `sort` or use `--json | jq`. **Open question** in OQ-1 below.

### Data path

Trivial: extend the SQL WHERE clause in `src/verbs/task.ts::list`. Both columns (`epic`, `story`) already indexed in state.db schema (or should be after ADR-193 T2 ships).

## Consequences

| Lane    | What changes                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------- |
| **be**  | `src/verbs/task.ts::list` parses two new flags. SQL WHERE gains `AND epic = ?` / `AND story = ?` clauses. |
| **db**  | If `epic` / `story` columns aren't yet indexed, add `CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic)` + same for story. Forward-compatible state.db migration via per-ADR-126/169 pattern. |
| **test**| Unit cases: (i) filter by epic returns N tasks, (ii) filter by story returns M tasks, (iii) combined `--epic` + `--lane` + `--status` AND-narrows correctly, (iv) `--epic ''` returns orphan tasks, (v) invalid eid regex → exit 64, (vi) `--json` snapshot matches filtered slice. |
| **docs**| `templates/briefs/planner.md` + `templates/briefs/member.md` mention `atmux task list` — add the two flags to the documented signature in both. |
| **ops** | None — no cron / verb-signature breakage. Pure additive surface.                                      |

**Forward enablement**:

- **Cockpit consumers** (`/bau`, `/bruh`, `superdoctor`, reviewer) can switch from `--json | jq '.[] | select(.epic == ...)'` to first-class `--epic <eid>` flag. Reduces shell-pipeline brittleness.
- **Worker pre-claim checks** — `atmux task list --epic <eid> --lane <my-lane> --status todo` becomes the canonical "what's pullable for me under this EPIC" probe.
- **Closes the three-ADR EPIC-task-CLI arc** with ADR-193 (write-side flags) + ADR-173 (epic show children tree) + ADR-174 (task list filters). Together they restore the full CLI affordance set ADR-007 originally documented.

**What we give up**: nothing. Pure additive WHERE narrowing.

**Rollback path**: revert this ADR's T2. CLI surface contracts back to current shape; index drops are optional (idempotent `IF EXISTS`).

## Open questions

1. **Sort order — keep createdAt ASC, or default to priority ASC for filtered queries?** **Default**: keep createdAt ASC (current behavior, predictable). Operators wanting priority-sort pipe through `sort` or add a future `--sort priority` flag. Reconsider if user friction surfaces. *Why*: filtering ≠ sorting; bundling them is scope creep.
2. **`--epic ''` for orphan tasks — should empty-string explicitly match null, or be a syntax error?** **Default**: empty-string matches null. Useful for `atmux task list --epic ''` = "show me orphan tasks" — discoverable through experimentation. *Why*: SQL `epic = ''` would never match (null comparison semantics); the verb-side treats `''` as a sentinel for "WHERE epic IS NULL".
3. **Should we add `--priority N` while we're here?** **Default**: NO — different OQ-class, separate fast-follow if surface demand grows. ADR-174 stays focused on EPIC/Story parentage filters. *Why*: bundling unrelated flags blurs the ADR's surface decision.
4. **Validate eid/sid exists at filter-time?** **Default**: NO — same stance as ADR-193. Filter against any well-formed id; empty result if nothing matches. Operators run `atmux epic show <eid>` if they want existence-check. *Why*: filter-with-empty-result is unambiguous; validation adds latency + an error case for the cross-worktree-decomp workflow.

## Reversibility

`low`. Pure additive CLI surface narrowing existing query. Zero schema changes (indexes are optional + idempotent). Zero data invalidation.

## Related

- **ADR-193** — PREREQUISITE: `.epic` / `.story` need to be CLI-writable for the filter to have non-empty results at runtime. ADR-174 absorbs `.epic: null` gracefully — empty result, no error.
- **ADR-173** — sibling read-side ergonomics. `atmux epic show <eid>` renders the tree; `atmux task list --epic <eid>` renders the flat slice. Complementary, not overlapping.
- **ADR-007** — original Epic/Story/Task hierarchy. ADR-174 implements the third (and final) of the documented read-side affordances. With ADR-193/173/174 together, the three-ADR arc closes the CLI round-trip on EPIC-task linkage.
- **ADR-006** — JSON output stability. ADR-174 narrows the slice without changing keys; additive-keys-non-breaking convention preserved.


## §Amendment 2026-05-22 — Status demoted to `proposed (deferred:)` after surface-vs-impl audit

Demoted from `Accepted — ratified by driver 2026-05-21` → `proposed (deferred: impl not yet shipped)` per CLAUDE.md §Source-of-truth chain escape hatch ("Intentionally-held → `Status: proposed (deferred: <reason>)` so ADR-085 surfacer doesn't ping").

**Why the demote**: the 2026-05-21 operator ratification batch (commit `b6d634f` "30 ADRs flipped proposed→accepted") was bookkeeping — clearing the `proposed` marker for ADRs whose impl was understood-to-have-shipped. That sweep folded in ADR-174 + sibling ADRs whose impl was still pending. 2026-05-22 docs audit (via Task `t-b1bd0f9c`, lead-routed `d-7b8d444f-batch` decision) confirms `atmux task list --epic <eid>` and `--story <sid>` flags are not in the CLI surface — invocation errors with `unknown arg: --epic`. The decision contract (createdAt-ASC sort preserved, empty-string matches null, no `--priority` bundling, no filter-time eid/sid validation) is intact + still the right shape; only the impl is pending.

**Why deferred (not retracted)**: the ADR's substance — the third arm of the ADR-193/173/174 trio closing the CLI round-trip on EPIC-task linkage — remains the right answer to the read-side ergonomics gap. The proposal stands; the schedule slipped. A future impl-EPIC will close the gap (likely bundled with the ADR-193 task-add-flag impl since both touch the same `src/verbs/task.ts` arg parser); flipping back to `accepted` happens THEN, not before.

**Original ratification context preserved**: `Accepted — ratified by driver 2026-05-21 (--epic and --story filters; §OQ recommendations as-written: createdAt-ASC sort preserved, empty-string matches null, no --priority bundling, no filter-time eid/sid validation)`. The §OQ recommendations in §Decision below remain as-ratified; the demote is a *schedule* signal, not a substance reversal.

**Cross-refs**: `t-b1bd0f9c` (Status-vs-Impl drift audit — this ADR is one of 5 in the Path B cluster; siblings ADR-173/178/183/193); `d-7b8d444f-batch` (lead-recorded decision authorizing close-or-§Amendment per gap-class); CLAUDE.md §Source-of-truth chain (deferred-status escape hatch); `b6d634f` (the originating bookkeeping batch).

**Filed as part of Path B cluster per d-7b8d444f-batch + t-b1bd0f9c (Status-vs-Impl audit).**
