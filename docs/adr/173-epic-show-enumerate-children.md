# ADR-173: `atmux epic show <eid>` — enumerate child Stories + Tasks

**Status**: accepted (re-promoted 2026-06-06 — impl shipped: Stories+Tasks tree in `src/verbs/epic.ts` per commits 183e4b7/cab723d, story-show Tasks tree in `src/verbs/story.ts`, and the §69 `(none)` empty-section markers landed via `t-8f31b5e6` under impl-EPIC e-290acb54 — see §Amendment 2026-06-06 below. Prior demote context in §Amendment 2026-05-22.)
**Date**: 2026-05-18
**Driver-ref**: ADR-193 §OQ-4 carve-out — read-side ergonomics deferred to a sibling ADR. ADR-176 §Consequences also references the gap implicitly (criterion (d) requires children-indexable data; the operator-facing view of those children is what ADR-173 surfaces).
**Relates**: ADR-007 (Epic/Story/Task hierarchy original spec), ADR-193 (write-side `--epic`/`--story` flags — runtime prerequisite), ADR-176 (criterion (d) — same data path), ADR-165 (CLI-surface pattern reference).

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-280](280-epic-team-retirement-and-staged-excision.md).** Epic-teams are retired: the `epic-team` cage type, the `epicId` cockpit field and the epic verbs no longer exist. This ADR is kept as history — the decision it records was true when made. Do not implement from it.

## Context

`atmux epic show <eid>` today returns:

```
e-4976c457 [planning] — ADR-176 EPIC-aware lane-drift-revert — skip parents ...
  body: <multi-line body>
  ref:  <driver-ref>
```

No children. No Stories. No Tasks. Operators must run a separate `atmux task list` and grep manually to see the EPIC's decomp. Three concrete friction points observed in 2026-05-17→18 planner sessions:

1. **Decomp verification after filing** — after `atmux task add` for T1–Tn under an EPIC, `atmux epic show <eid>` cannot confirm the children landed correctly. Operators eyeball `atmux task list` output and pattern-match on subject prefixes. Error-prone — typos in `--epic <eid>` argument silently misfile children under the wrong parent (or no parent, given ADR-193's `.epic: null` runtime).
2. **Cross-cage observability** — when a parent EPIC is filed in one worktree and its sub-tasks ship from epic-team worktrees (per ADR-091 epic-team lifecycle), the parent worktree has no easy way to inspect the sub-task status without SSH into the child cage. `atmux epic show <eid>` in the parent worktree should suffice.
3. **`/bruh` + `/bau` + `superdoctor` observability** — cockpit-level health roles enumerate kanban state to decide whether a team is making progress. EPIC-level rollup is currently impossible without scanning all tasks and grouping client-side.

Once **ADR-193** ships and `.epic` populates organically on new tasks, the underlying data is present — only the render path is missing. ADR-173 is the smallest possible fix: query + sub-list rendering, no schema change, no new verb.

## Decision

`atmux epic show <eid>` gains a `Children` section rendered after `ref`:

```
e-4976c457 [in-progress] — ADR-176 EPIC-aware lane-drift-revert — skip parents ...
  body: ...
  ref:  .atmux/flags.md tail 2026-05-17 + driver chat (planner)

  Stories: (none)

  Tasks:
    t-ee7dd997 [done,      planner, P2] ADR-176 T1: draft ADR — EPIC-aware lane-drift-revert spec
    t-e80410b3 [todo,      up-impl, P2] ADR-176 T2: src/core/lane-drift.ts criterion (d) impl  ← deps: t-ee7dd997
    t-c3865ff0 [todo,      up-impl, P2] ADR-176 T3: verb wrapper passes childrenByParentId to checkLaneDrift  ← deps: t-e80410b3
    t-a3c31d12 [todo,      up-impl, P3] ADR-176 T-INVESTIGATE: lane-drift state-divergence  ← deps: t-ee7dd997
    t-7b8d444f [todo,      docs,    P3] ADR-176 T5: docs sweep + accept flip  ← deps: t-e80410b3,t-c3865ff0
```

When Stories exist, render them as a nested tree:

```
  Stories:
    s-abcdef01 [in-progress] — Story title
      Tasks:
        t-...... [...] ...
    s-abcdef02 [ready] — Other story
      Tasks: (none)

  Tasks (no story):
    t-...... [...] ...
```

### Render rules

- **Status colourmap**: `done` green, `in-progress` yellow, `todo` plain, `review/testing/merging` cyan (only when TTY; plain text in pipes / non-TTY contexts per existing atmux render-mode convention).
- **Status column width**: padded to longest status name + 1 space. Common case: `[done,      ` / `[in-progress,` / `[todo,      ` aligned.
- **Owner column**: assignee or `-` when null.
- **Priority column**: `P<n>` where n is the priority field; `P-` when null.
- **Subject truncation**: terminal-width-aware; truncate with `…` at `tput cols` minus the prefix overhead. Full subject available via `atmux task show <id>`.
- **Deps rendering**: `← deps: t-aaa,t-bbb` appended only when `deps[]` non-empty. Truncation: up to 3 ids inline + `(+N more)` overflow.
- **Stories block omitted entirely** when the EPIC has no stories AND no tasks reference any story under this EPIC. Avoids visual clutter for small EPICs that skipped the Story tier (per ADR-007 "Stories are OPTIONAL").
- **Tasks (no story) header** only when Stories block is present AND there are epic-direct tasks. Plain `Tasks:` otherwise.
- **`(none)` when empty** — explicit empty markers, not silent omission, when the section header appears.

### JSON mode

`atmux epic show <eid> --json` extends to include children. New keys:

```jsonc
{
  "id": "e-4976c457",
  "status": "in-progress",
  "subject": "...",
  "body": "...",
  "driverRef": "...",
  "stories": [
    {
      "id": "s-...",
      "status": "...",
      "subject": "...",
      "tasks": [ { "id": "t-...", "status": "...", "owner": "...", "priority": 2, "subject": "...", "deps": [...] } ]
    }
  ],
  "tasks": [
    { "id": "t-...", "status": "...", "owner": "...", "priority": 2, "subject": "...", "deps": [...] }
    // — epic-direct tasks (no .story set), OR all tasks under the epic if no stories
  ]
}
```

`tasks` in JSON mode contains epic-direct-only Tasks; tasks under Stories live nested under `stories[].tasks` to mirror the tree. Consumers that want a flat list filter Story-tasks themselves.

### Data path

Query: `SELECT * FROM tasks WHERE epic = ? ORDER BY priority ASC NULLS LAST, createdAt ASC`. Group client-side by `.story` for the nested tree. Similar for `SELECT * FROM stories WHERE epic = ?`.

Reuse existing kanban-render helpers (`src/core/render-task.ts` or wherever per-task rendering currently lives — implementer call).

## Consequences

| Lane    | What changes                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------- |
| **be**  | `src/verbs/epic.ts::show` adds the children query + render block. Reuses existing render helpers.     |
| **be**  | `--json` shape extends with `stories[]` + `tasks[]` keys. Existing keys unchanged (backward compat).  |
| **test**| Unit test for render: EPIC with 0 stories + N tasks (current state); EPIC with 2 stories + tasks under each; EPIC with stories AND epic-direct tasks (mixed tree). Plus JSON-mode snapshot test. |
| **docs**| No brief edit — `templates/briefs/planner.md` already references `atmux epic show <eid>` and operators will discover the new section organically. Optional one-liner cross-reference in `docs/RUNBOOK-*` if any runbook references the old shape. |
| **ops** | None — no cron / verb-signature breakage. Pure additive surface.                                      |

**Forward enablement**:

- **Decomp verification** — `atmux task add ... --epic <eid>` followed by `atmux epic show <eid>` becomes the canonical decomp-confirm pattern.
- **Cross-cage observability** — parent worktree's `atmux epic show <eid>` shows the child-cage progress without SSH (assuming kanban is shared per ADR-091 epic-team lifecycle, which stores child Tasks in the parent state.db).
- **`/bruh` + `/bau` + `superdoctor`** — JSON mode gives cockpit-level health roles a clean per-EPIC rollup primitive. Consumers like `atmux complaints` already use similar nested-JSON patterns.

**What we give up**: nothing. Pure additive output.

**Rollback path**: revert this ADR's T2. Both text and JSON output contract back. Backward-compatible API stance — existing scripts parsing `atmux epic show --json` get extra keys they can ignore (per ADR-006 "JSON output: additive keys are non-breaking").

## Open questions

1. **Should we render children's child-EPICs recursively** (e.g., if a Task under this EPIC is itself an EPIC parent in disguise)? **Default**: NO — `atmux epic show <eid>` shows ONE level. Recursive EPIC-of-EPICs is rare; operators run `atmux epic show <child-eid>` for the next layer. Avoids infinite-loop edge cases on misfiled `.epic` cycles.
2. **Should `atmux story show <sid>` get the sibling treatment** (enumerate its Tasks)? **Default**: YES — file as a separate fast-follow Task under this EPIC, not its own ADR. Same query pattern, same render helpers, trivial impl alongside T2.
3. **Group tasks by lane within the Tasks block?** **Default**: NO. Sort by priority then createdAt (operator-relevance order). Lane grouping is an `atmux task list --epic <eid> --by-lane` ergonomic, separate scope (could absorb into the read-side ADR-193 §OQ-4 sibling).
4. **Closed-EPIC display — hide done tasks behind `--all` flag?** **Default**: NO — show all by default. Done tasks are usually a few; rolling up history is a feature, not noise. Operators with very large EPICs can pipe `| less`. Reconsider if a 30+ task EPIC surfaces as a real ergonomics pain.
5. **Should the `body:` field be truncated to N lines when children block is present** (to keep the screen readable)? **Default**: NO — body stays full. Operators reading `atmux epic show` already accept multi-line scroll; truncation hides context that's often load-bearing. `--brief` flag is a future ergonomic if needed.

## Reversibility

`low`. Pure additive output to one verb's render path + one JSON-key extension. Zero schema changes, zero state-mutation changes. No data invalidation.

## Related

- **ADR-193** — PREREQUISITE: `.epic` field needs to be CLI-writable for `atmux epic show` to have non-empty children at runtime. ADR-173's T2 should soft-gate on T2 of ADR-193 shipping (or absorb gracefully when `.epic: null` — query returns empty, "Stories: (none) / Tasks: (none)" renders cleanly).
- **ADR-176** — sibling consumer of the same `.epic` indexing pattern. Criterion (d)'s `childrenByParentId` map and `atmux epic show` children block are different views of the same underlying query.
- **ADR-007** — original Epic/Story/Task hierarchy. ADR-173 implements the missing read-side affordance documented but never built.
- **ADR-006** — JSON output stability convention (additive keys are non-breaking).
- **ADR-165** — CLI-surface pattern reference (atmux team set/get/unset is read-side-friendly; ADR-173 extends that ergonomics philosophy to the epic verb).


## §Amendment 2026-05-22 — Status demoted to `proposed (deferred:)` after surface-vs-impl audit

Demoted from `Accepted — ratified by driver 2026-05-21` → `proposed (deferred: impl not yet shipped)` per CLAUDE.md §Source-of-truth chain escape hatch ("Intentionally-held → `Status: proposed (deferred: <reason>)` so ADR-085 surfacer doesn't ping").

**Why the demote**: the 2026-05-21 operator ratification batch (commit `b6d634f` "30 ADRs flipped proposed→accepted") was bookkeeping — clearing the `proposed` marker for ADRs whose impl was understood-to-have-shipped. That sweep folded in ADR-173 + sibling ADRs whose impl was still pending. 2026-05-22 docs audit (via Task `t-b1bd0f9c`, lead-routed `d-7b8d444f-batch` decision) confirms `atmux epic show <eid>` still renders only id/status/subject/body/ref — the Stories+Tasks tree block specified by §Decision is not in `src/verbs/epic.ts`. The decision contract (1-level children, story-show fast-follow, no lane grouping, show all by default, no body truncation) is intact + still the right shape; only the impl is pending.

**Why deferred (not retracted)**: the ADR's substance — read-side affordance for the Epic/Story/Task hierarchy first documented in ADR-007 — is the right answer to the cross-cage observability gap. The proposal stands; the schedule slipped. A future impl-EPIC will close the gap; flipping back to `accepted` happens THEN, not before.

**Original ratification context preserved**: `Accepted — ratified by driver 2026-05-21 (read-side atmux epic show <eid> enumerates children; §OQ recommendations as-written: 1-level only, story-show fast-follow YES, no lane grouping, show all by default, no body truncation)`. The §OQ recommendations in §Decision below remain as-ratified; the demote is a *schedule* signal, not a substance reversal.

**Cross-refs**: `t-b1bd0f9c` (Status-vs-Impl drift audit — this ADR is one of 5 in the Path B cluster; siblings ADR-174/178/183/193); `d-7b8d444f-batch` (lead-recorded decision authorizing close-or-§Amendment per gap-class); CLAUDE.md §Source-of-truth chain (deferred-status escape hatch); `b6d634f` (the originating bookkeeping batch).

**Filed as part of Path B cluster per d-7b8d444f-batch + t-b1bd0f9c (Status-vs-Impl audit).**

## §Amendment 2026-06-06 — re-promoted to `accepted` after impl shipped (impl-EPIC e-290acb54)

Re-promoted from `proposed (deferred: impl not yet shipped)` → `accepted`. The 2026-05-22 demote (above) said "A future impl-EPIC will close the gap; flipping back to `accepted` happens THEN, not before." That impl-EPIC is **e-290acb54**, and the gap is now closed:

- **Stories + Direct-tasks tree** renders on `atmux epic show <eid>` (`src/verbs/epic.ts`), per commits `183e4b7` / `cab723d` (inline owner/priority/deps on task rows).
- **Tasks tree** renders on `atmux story show <sid>` (`src/verbs/story.ts`) — the story-show fast-follow §OQ recommendation.
- **`(none)` empty-section markers** (§69 "explicit empty markers, not silent omission") landed via `t-8f31b5e6`: `epic show` emits `Stories:\n  (none)` / `Direct tasks:\n  (none)` and `story show` emits `Tasks:\n  (none)` when the respective arrays are empty, replacing the prior silent omission. This also satisfies §139's `.epic: null` absorption — a child-less epic (the runtime when ADR-193's `.epic` write-side is unused) renders cleanly with explicit markers rather than a bare body/ref view.
- **JSON mode** (`--json`) carries the additive children keys (`stories`, `tasks`) on both verbs; the internal `storyRows` alias is stripped on the epic-show JSON output to match the bash `--json` shape.

Coverage: `tests/unit/verbs/epic.show.children.test.ts` + `tests/unit/verbs/story.show.children.test.ts` (this commit) assert the `(none)` markers on empty parents, the nested tree on populated parents, the additive JSON keys, and the `.epic: null` non-leak. The §68 nuance (`Tasks (no story):` header when a Stories block is present vs plain `Tasks:` otherwise) is a follow-up render-polish item — current impl uses the stable `Direct tasks:` header unconditionally — and does not block this re-promotion; the substantive children-enumeration contract is satisfied.

**Cross-refs**: `t-8f31b5e6` (§69 `(none)` markers — this commit); e-290acb54 (impl-EPIC); commits `183e4b7` / `cab723d` (tree render); §Amendment 2026-05-22 (the demote this reverses).
