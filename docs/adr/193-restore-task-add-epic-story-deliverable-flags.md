# ADR-193: Restore documented `atmux task add` flags — `--epic` / `--story` / `--deliverable`

**Status**: Accepted — ratified by driver 2026-05-21 (restore --epic/--story/--deliverable flags + inverse mutations on task update; §OQ recommendations as-written: no add-time existence validation, free-form deliverable string, no auto-backfill, list-filter ADR sibling, routine schema migration)
**Date**: 2026-05-18
**Renumbered 2026-05-20**: originally drafted as ADR-172 (`d7586c4` on `geoyws-planner`). Trunk merge `fe8aea1` shipped `docs/adr/172-stop-github-ci-until-stabilise.md` between drafting and rename. Renumbered per "older keeps the number" heuristic (memory `project_adr_collision_resolutions_2026_05_18`). 193 chosen as next free across trunk + geoyws + planner refs.
**Driver-ref**: ADR-176 §sibling-gap surface 2026-05-17 — criterion (d) in `src/core/lane-drift.ts` requires `.epic` populated on kanban Tasks; at runtime all tasks have `.epic: null` because there is no CLI path to set it.
**Relates**: ADR-127 §OQ5 (lane-drift original spec), ADR-176 (EPIC-aware criterion (d) — DEPENDENT, renumbered from ADR-171), ADR-165 (task-CLI-surface pattern — same shape as `atmux team set/get/unset`), ADR-007 (Epic / Story / Task hierarchy).

## Context

`templates/briefs/planner.md` lines 55-58 document the canonical planner-facing `task add` signature:

```
atmux task add "subject" [--body <text>] [--priority N] [--deps <id,id>] \
                         [--epic <eid>] [--story <sid>] \
                         [--lane fe|be|db|ops|test|review|misc] \
                         [--deliverable <text>]
```

The actual bun-CLI `atmux task add` accepts:

```
atmux task add <subject> [--body T] [--assignee M] [--deps a,b] [--priority N] [--lane L] [--driver-only]
```

Three documented flags are missing: `--epic`, `--story`, `--deliverable`. Schema fields `.epic` and `.story` exist (`atmux task show` renders them as `"epic": null, "story": null` on every task), but no CLI path writes them. `.deliverable` is undocumented in the schema — likely a body-text convention or a dropped schema field.

The gap surfaces in three places:

1. **ADR-176 criterion (d) deployability gap** — the new `epic-children-progressing` check indexes Tasks on `.epic`. With every Task having `.epic: null`, the children map is always empty and criterion (d) is no-op until either (i) `--epic` ships OR (ii) the verb wrapper falls back to subject-pattern parsing (the T3 fallback ADR-171 carved out as defensive scaffolding).
2. **Planner-decomp drift** — every recent EPIC decomp (ADR-167 / ADR-144 / ADR-169 / ADR-171) filed sub-tasks with the parent EPIC reference encoded in subject prefix and body text only. There is no machine-readable link between an EPIC and its T1-Tn children today. `atmux epic show <eid>` cannot enumerate children.
3. **Planner brief is aspirational** — operators reading `templates/briefs/planner.md` paste the documented command shape and get `unknown flag: --epic`. Per global feedback memory `feedback_brief_aspirational_verbs` this is a known surface; ADR-193 closes one slice.

This is a port-regression, not a new design. The bash `lib/task.sh` likely supported these flags (un-audited; legacy bash is archived). The bun port omitted them. Restoring them is faithfulness to the documented contract.

## Decision

Restore the three flags to `atmux task add` and add the inverse mutations to `atmux task update`:

### `atmux task add`

```
atmux task add <subject> [--body T] [--assignee M] [--deps a,b] [--priority N] \
                          [--lane L] [--driver-only] \
                          [--epic <eid>] [--story <sid>] [--deliverable <text>]
```

- `--epic <eid>` — sets `.epic` field on the new task. `eid` is `e-[0-9a-f]{8}` shape; no existence-validation (operators may pre-decompose before filing the epic).
- `--story <sid>` — sets `.story` field. `sid` is `s-[0-9a-f]{8}` shape; same no-validate stance.
- `--deliverable <text>` — sets `.deliverable` field. **Schema decision**: add `.deliverable: string | null` to `KanbanTask` (currently absent). Free-form text — typically a path or artifact reference (`docs/adr/171-...md`, `src/core/lane-drift.ts:113`).

### `atmux task update`

```
atmux task update <id> [--body T] [--deps a,b] [--epic <eid>] [--story <sid>] [--deliverable <text>]
```

- Same three flags. `update --epic ''` clears the field (sets to null). Same for `--story`, `--deliverable`.
- Re-parenting an `in-progress` task is **allowed** (no gate) — fires the existing kanban-audit-log entry. Operators occasionally need to re-parent when decomp restructuring lands.

### Validation

- `eid` / `sid` regex-validated on input (`e-[0-9a-f]{8}` / `s-[0-9a-f]{8}`); non-conforming → exit 64 with verb-help.
- **No existence check** — the eid/sid may reference an epic/story not yet filed (or filed in another worktree). Operators who want a check use `atmux epic show <eid>` before/after.
- `--deliverable` accepts any string up to 256 chars; over that → exit 64 (matches body-field policy).

## Consequences

| Lane    | What changes                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------- |
| **be**  | `src/verbs/task.ts::add` parses 3 new flags; `update` parses same 3 flags + the existing two.         |
| **be**  | `src/schema/kanban.ts::KanbanTask` gains `deliverable: z.string().max(256).nullable().default(null)`. |
| **db**  | Migration: existing rows get `deliverable: null`. SQLite migration via state.db Zod ↔ SQL pattern.    |
| **test**| Unit tests for parse + write per flag; integration test exercising add + update + epic show.          |
| **docs**| Planner brief `templates/briefs/planner.md` already documents these flags — no doc edit needed. CLAUDE.md mentions of EPIC-task linkage gap (none directly) can stay as-is. |
| **ops** | None — no cron / verb-signature breakage. Pure addition.                                              |

**Forward enablement**:

- **ADR-176 criterion (d)** can drop the T3 subject-pattern fallback once ADR-193 ships and existing tasks are backfilled. Verb wrapper indexes purely on `.epic` (clean path).
- **`atmux epic show <eid>`** can list children by querying `tasks WHERE epic = eid` (separate fast-follow ADR if not already there).
- **Planner-decomp ergonomics** — `atmux task add "T2: impl" --epic e-4976c457 --deps t-ee7dd997` becomes the canonical decomp pattern, replacing subject-prefix conventions.

**What we give up**: nothing. Pure additive surface.

**Rollback path**: revert this ADR's T2 (verb + schema). The schema field is nullable-default-null, so existing data is unaffected; CLI surface contracts back to current shape.

## Open questions

1. **Should `--epic` / `--story` validate existence at add-time?** **Default**: NO — write-without-existence is intentional for cross-worktree decomp workflows where the EPIC is filed in a sibling session. Operators run `atmux epic show <eid>` if they want a check.
2. **What is `.deliverable` exactly — a free-form string, a structured `path:line` reference, or a file-path?** **Default**: free-form `string` (max 256 chars). Operators use the convention they want — `docs/adr/171-...md` or `src/core/lane-drift.ts:113` or `EPIC e-XXX merged to main`. Structured shapes are over-design for current usage.
3. **Should we backfill existing tasks' `.epic` from subject-pattern parsing?** **Default**: NO — backfill is a separate verb (`atmux task backfill-epic` or similar), out of scope for ADR-193. Tasks filed before ADR-193 ships keep `.epic: null`; new tasks use `--epic`. Operators who need backfill use `atmux task update <id> --epic <eid>` per-task.
4. **`atmux task list --epic <eid>` filter?** **Default**: file as a sibling follow-up ADR/task. ADR-193 stays focused on the write-side gap; read-side ergonomics is a separate ADR.
5. **Schema migration cost for `.deliverable`?** **Default**: minimal — SQLite `ALTER TABLE tasks ADD COLUMN deliverable TEXT` is forward-compatible; existing rows get NULL. Per ADR-126 / ADR-169 state.db migration patterns this is a routine schema-version bump.

## Reversibility

`low`. Pure additive CLI surface + one nullable schema field. Schema migration is forward-only but trivially reversible (drop the column or ignore it). Zero existing kanban data invalidated.

## Related

- **ADR-171** — DEPENDENT downstream consumer. Criterion (d) deployability gradient-tracked by `.epic` population rate.
- **ADR-165** — sibling CLI-surface pattern (`atmux team set/get/unset` closes operator-hand-edit gap on `team.json`; ADR-193 closes the same class for `task.epic` / `task.story` / `task.deliverable`).
- **ADR-007** — original Epic / Story / Task hierarchy spec; ADR-193 restores the documented CLI affordances.
- **ADR-126** / **ADR-169** — state.db schema-migration patterns ADR-193's `.deliverable` column addition follows.
- **`feedback_brief_aspirational_verbs`** (planner-memory 2026-05-17) — surfaces this class of port-regression broadly. ADR-193 closes one slice.
