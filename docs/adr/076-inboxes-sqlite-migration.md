# ADR-076: Eliminate `.atmux/inboxes/<m>.json` — member inboxes migrate to `state.db` tasks table

**Status**: Accepted — Phase 3 complete 2026-05-21
**Date**: 2026-04 (Phase 1 initial) · 2026-05-21 (Phase 3 completion + post-hoc authorship)
**Relates**: [ADR-060](./060-kanban-sqlite-canonical.md) (kanban SQLite canonical store — origin pattern), [ADR-154](./154-driver-inbox-lead-outbox-sqlite-migration.md) (sibling driver-inbox/lead-outbox migration — cites this ADR), [ADR-076 phantom-reference](memory `project_inbox_migration_done`) (eliminated `.atmux/inboxes/<m>.json` per atmux 0.5.0+).

## Context

Pre-ADR-076 (atmux ≤0.4.x), each member's inbox lived at `.atmux/inboxes/<member>.json` — a per-member JSON file with `pending` / `inProgress` / `done` arrays of Task references. Two paths existed for every inbox operation: `loadInbox(member)` (read from disk JSON) and `writeText(inboxPathFor(member), …)` (write back).

ADR-060 made `state.db` the canonical kanban store. Tasks live in the SQLite `tasks` table with `assignee` + `status` columns; per-member inbox views are a SQL projection (`SELECT … WHERE assignee = ? AND status IN (…)`). The legacy JSON files became a redundant mirror that drifted from SQL truth under any concurrent write — observable bug pattern (memory `feedback_residue_use_cm_not_enter` lineage).

ADR-076 retires the JSON files entirely. Three phases:

- **Phase 1** (atmux 0.5.0, ~2026-04): SQLite writes added in parallel; JSON files frozen post-cutover (status verb shows "🟡 active 📌 todo" from SQL, not "📨 pending" from JSON).
- **Phase 2** (atmux 0.5.0–0.8.x): Read paths progressively switched from `loadInbox(member)` to SQL `SELECT`. Legacy JSON readers retained as fallback.
- **Phase 3** (this commit, 2026-05-21): Fully drop the read+write paths. `inboxPathFor`, `emptyInbox`, JSON-based `loadInbox`/`writeText` calls removed from src/. Brief templates lose all `{{ATMUX_DIR}}/inboxes/{{MEMBER}}.json` vocabulary in favor of `atmux inbox {{MEMBER}}` verb references. 33 files touched, +749/-1805.

## Decision

The canonical and ONLY source of member-inbox state is `state.db` tasks table, queried via `loadInbox(member)` (SQL-backed) or surfaced via `atmux inbox <member>` verb. The `.atmux/inboxes/<m>.json` path is no longer read, no longer written, no longer mentioned in operator-facing docs.

## Out of scope

- Driver-inbox + lead-outbox migration — sibling ADR-154 (still uses markdown for those surfaces; their migration is a separate pattern).
- Auto-promotion of inbox→flag at 12h aging — ADR-153 territory.
- Inbox semantics changes (the projection shape stays `pending`/`inProgress`/`done`) — ADR-076 is purely a storage-mechanism migration, not a semantics shift.

## Phase 3 file inventory

- **Code (16 src/ files)**: `src/abstractions/sqlite-migrations.ts`, `src/core/{cleanup,common,inbox}.ts`, `src/core/repositories/kanban-repo.ts`, `src/verbs/{add-member,claim,cleanup,dispatch,doctor,epic-merge,handoff,help,inbox,init,task}.ts`.
- **Tests (11 files)**: matching `tests/unit/{core,verbs}/*.test.ts` — assertions on legacy JSON paths removed; SQL projection assertions kept.
- **Briefs (6 templates)**: `templates/briefs/{dba,discorder,enforcer,merger,reviewer,unblocker}.md` — operator-facing inbox-path references replaced with `atmux inbox <member>` verb references.
- **ADR (this file)**: post-hoc authorship — Phase 3 commit fills the dangling reference from ADR-154 + memory snapshots.

## Acceptance

- `rg -n 'inboxes/.*\.json\|inboxPathFor\|emptyInbox' src/ templates/briefs/` returns zero hits.
- `atmux inbox <member>` continues to render pending/inProgress/done sections from SQL.
- All unit tests pass against state.db-only paths.
- Reviewer signoff per the standard ADR write-flow (CLAUDE.md §Discipline #4).
