# ADR-225: Epic dependencies + isReady toggle — orchd substrate

**Status**: proposed
**Date**: 2026-05-22
**Driver-ref**: EPIC e-cf8a6195 (master design-task `t-802c468b` in parent atmux kanban)
**Sibling EPIC**: e-60e16169 (orchd auto-spawn loop — Phase 2 consumer)

## Context

atmux already has TASK-level `deps` (in-array of task IDs; `claim --next` skips
Tasks with non-`done` deps per `src/core/kanban.ts:129`). There is no equivalent
gate at the EPIC tier. Operators sequence epic work mentally; `team spawn-epic`
will happily fire on an epic whose upstream prerequisite hasn't shipped.

Three forces pushed this:

1. **orchd auto-spawn loop (EPIC e-60e16169).** Sibling EPIC needs a queryable
   "is this epic shippable yet?" predicate. Mentally-held sequencing doesn't
   compose into an automated dispatcher.
2. **Manual decision-support.** Even without orchd, operators benefit from
   `atmux epic list` showing `R=1` (ready) + `D=2/3` (deps done count) — saves a
   `git log` spelunk to know which epic is next.
3. **Drafts vs. ready epics.** Status `planning` covers both "decomposition not
   started" and "decomposition complete, but operator hasn't greenlit pickup."
   The lifecycle enum is overloaded; `is_ready` decouples decomposition state
   from kick-off authorization.

Honker substrate landed on trunk this morning (f376665 fan-in), so event
emission (`epic.unblocked`, `epic.ready`) ships in the same EPIC instead of
deferring to a follow-up — substrate-first not substrate-deferred.

Operator-locked decisions in master task `t-802c468b`:
- `depends_on` is a top-level column (NOT `extra` JSON) — orchd query is
  hot-path; JSON-pull on every spawn-eligibility tick burns CPU.
- `is_ready` defaults to `0` — explicit go-ahead prevents accidental
  auto-spawns on draft epics.
- Cycle detection at add-time (eager), not lazy at spawn-time — typos and
  mistakes surface at the keystroke, not three hours later when orchd refuses.
- Dep on non-existent epic id is refused (typo protection).
- `--force` override exists on `team spawn-epic` for unmet-deps + is_ready=0
  cases — operator escape hatch with structured log.

## Decision

### Schema (SQLite migration v13→v14)

```sql
ALTER TABLE epics ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
ALTER TABLE epics ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0;
-- Backfill: bulk-set is_ready=1 for epics already in_flight or done so the
-- new substrate doesn't retroactively block ongoing work or invite re-spawn:
UPDATE epics SET is_ready = 1
  WHERE status IN ('in-progress', 'review', 'done');
```

Epic B (events-prune) already took v12→v13 (commit f376665 wave). This EPIC
takes v13→v14. Migration ladder is append-only per ADR-060 §D5.

`depends_on` is a JSON-array TEXT column for the same reason `tasks.deps` is —
SQLite has no native array type, JSON serializes cleanly, and the cardinality
per epic stays small (typically ≤3, never more than a handful).

### Zod schema (`src/schema/kanban.ts`)

```ts
export const KanbanEpic = z.object({
  // … existing fields
  dependsOn: z.array(z.string()).default([]),
  isReady: z.boolean().default(false),
}).passthrough();
```

Repo round-trip in `src/core/repositories/kanban-repo.ts` adds `depends_on` +
`is_ready` to `KNOWN_EPIC_FIELDS`. `is_ready` round-trips as INTEGER 0/1 ↔
boolean (coercion in `epicFromRow`/`epicToRow`).

### Validation

At `epic add --depends-on <eid,…>` AND `epic set-depends-on <id> <eid,…>`:

1. **No self-dep**: refuse if target id appears in dep list.
2. **No cycles**: walk transitive deps from each proposed dep; refuse if target
   id appears in any transitive chain.
3. **No non-existent deps**: each dep id must resolve to an existing epic row
   (typo protection).
4. **Dep on already-done epic is allowed**: no-op for orchd (predicate
   considers it satisfied), but accepted so forward-declared chains parse.
5. **Toggle on done epic refused**: `is_ready` on a `status='done'` epic is
   meaningless; refuse to keep the data model honest.
6. **Toggle is operator-scope** (not driver-scope): this is decision-support,
   not destructive; any scope may call `epic ready`/`epic unready`.

### Eligibility predicate

```ts
epicIsEligible(atmuxDir, id): { eligible: boolean, blockers: string[] }
```

Returns `eligible=true` IFF:
- `is_ready=1`, AND
- every id in `depends_on` resolves to an epic with `status='done'`.

`blockers` enumerates the human-readable reasons (`"is_ready=0"`,
`"depends_on e-XXX not done (status=in-progress)"`, etc.) so callers can
render an actionable refusal message.

`status='done'` is the bar (not `review`) because review can roll back via
`unsignoff`; only `done` is terminal.

### Eligibility consumers

- `team spawn-epic <eid>` — refuses on `eligible=false` with the blockers list;
  `--force` overrides + writes structured log to
  `~/.atmux/state/spawn-overrides.log` (`{ts, epic_id, blockers, caller}`) +
  emits Discord `[spawn-force]` ping (parallel to ADR-144 test-gate-bypass).
- orchd (sibling EPIC e-60e16169) Phase 2 — reads the predicate on every
  spawn-tick.

### CLI surface (`src/verbs/epic.ts`)

| Verb | Behavior |
|------|----------|
| `atmux epic add … [--depends-on e-XXX,e-YYY]` | Comma-split, validated (4 rules above). |
| `atmux epic ready <eid>` | `is_ready := 1`; emit `epic.ready` event on 0→1 transition. |
| `atmux epic unready <eid>` | `is_ready := 0`; no event (downgrade is silent). |
| `atmux epic set-depends-on <eid> <eid,…>` | Replace dep list; same validation. |
| `atmux epic deps <eid>` | Render transitive dep graph as a text tree (status per node). |
| `atmux epic show <eid>` | Existing output + dep chain + `is_ready` state. |
| `atmux epic list` | Existing output + `R` column (0/1) + `D=k/n` column (k of n deps done). |

### Events (`src/schema/events.ts`)

Two new discriminated topics added to the closed v1 set per ADR-203 §D2 (this
ADR is the amendment that authorizes the addition):

```ts
// payload for both: { epicId, transitionedAt }
// epic.unblocked also carries: byEpicId — the dep whose status:done cleared
//                              the last blocker.
"epic.unblocked"
"epic.ready"
```

Emission points:

- **`epic.unblocked`** — fires in `advanceEpic(id, 'done')`. After the row's
  status flips to done, scan epics where `id` appears in `depends_on`; for each
  such epic A, recompute `epicIsEligible(A)`. If A's last unmet dep was this
  transition (i.e. before the flip, A had ≥1 non-done dep including `id`; after
  the flip A has all deps done), emit `epic.unblocked` for A with
  `byEpicId=id`. Note: `epic.unblocked` fires regardless of `is_ready` —
  it's the dep-graph event, not the eligibility event. A consumer (orchd or
  cockpit-mirror) that wants the combined predicate joins `epic.unblocked`
  with `is_ready=1` at read time.

- **`epic.ready`** — fires in `setEpicReady(id, true)` on the 0→1 transition.
  No event on 1→0 (downgrades are silent; orchd polls vs. event-driven for the
  is_ready=0 case is the simpler design).

`epic.unblocked` is team-scope (consumed by orchd and cockpit-mirror for
parent-team awareness — same routing as `epic.merge-ready` per ADR-203 §D4).
`epic.ready` is team-scope.

## Consequences

**Wins**:

- Operators get a queryable epic-dependency graph + an explicit kick-off bit.
- `atmux epic list` becomes a single-pane substitute for the "which epic do I
  spawn next?" git-log spelunk.
- orchd (sibling EPIC) becomes a thin consumer of a validated substrate —
  it doesn't carry the cycle-detection / dep-walking burden.
- Event emission gives downstream consumers (cockpit-mirror, orchd, Discord
  digest) a real-time signal without polling.

**Costs**:

- `epic add` runtime gains a cycle-walk + existence-check pass — O(N) where N
  is the size of the proposed transitive dep set. Negligible at current
  cardinality (≤3 deps × ≤4 transitive hops in observed practice).
- Migration ladder grows by one step. v13→v14 is additive-only (per ADR-126
  invariant); existing rows backfill via `DEFAULT '[]'` + `DEFAULT 0`, plus
  the targeted `UPDATE` for in-flight epics.
- Two new topics enter the closed v1 set per ADR-203 §D2. This is the planned
  amendment slot — ADR-203 §D2 explicitly says adding a topic requires an ADR;
  this is that ADR.

**Rollback path**:

The migration is additive; rollback is "leave the columns in place, stop
reading them." The CLI verbs (`ready`/`unready`/`deps`) become no-op stubs.
The events (`epic.unblocked`/`epic.ready`) remain emitted but go un-consumed;
no harm. No data loss.

**What breaks**:

Nothing on existing rows — the backfill `UPDATE` ensures in-flight epics stay
spawnable. New `epic add` calls without `--depends-on` produce the same row
shape as before (empty dep list, is_ready=0 — caller toggles via `epic ready`
once decomposition lands).

`team spawn-epic` on a draft epic (`is_ready=0`) now refuses by default.
Operator workflow change: after `epic add` + decomposition, call `epic ready`
explicitly OR pass `--force` to spawn-epic. The first time this surfaces it
will look like a regression; the refusal message names the fix. Documented
in PRD + planner brief.

## Open questions

None remaining at decomposition time — operator locked the major calls in
master task `t-802c468b`. The following are kept as planner-level decision
records for the audit trail:

1. **`atmux epic claim --next` mentioned in the master task** — interpreted as
   the `team spawn-epic` eligibility gate (no new verb). Master task lists
   seven CLI surfaces; this one folds into spawn-epic. **Resolved:** spawn-epic
   gate; no separate verb. (Reversibility: low — operator can ask for a
   stand-alone verb later as an additive surface.)

2. **`status='done'` vs. `status='review'` as the eligibility bar** —
   master task says `status='done'`. **Resolved:** `done` only. Review can
   roll back via `unsignoff`; only `done` is terminal. (Reversibility: low.)

3. **Single ADR vs. ADR-225 + ADR-226 split** — master task said "may split if
   body is too long; planner's call." **Resolved:** single ADR-225. Body fits;
   the decisions are tightly coupled (deps + is_ready compose into one
   eligibility predicate). (Reversibility: low — can extract is_ready
   semantics into ADR-226 later if needed.)

4. **`epic.unblocked` semantics — fire on every dep transition or only the
   last?** — **Resolved:** fire only on the transition that clears the LAST
   unmet dep (per master task wording: "When the LAST unmet dep of an epic
   transitions to `done`"). Consumers can subscribe and assume the event means
   "all deps done now." Per-dep transitions are still individually observable
   via the `epic.advance` chain (which advances the dep itself), so no
   information is lost — just deduplicated. (Reversibility: medium — could
   amend to fire-on-every if a future consumer wants the partial-clear
   signal.)

5. **Should `epic.ready` event fire only on 0→1 OR also on `epic add` when
   the caller passes a hypothetical `--ready` flag?** — Master task doesn't
   mention an `--ready` flag on `epic add`. **Resolved:** no `--ready` flag on
   `epic add`; callers `epic ready <id>` post-add. Keeps the 0→1 transition
   the sole `epic.ready` emission point. (Reversibility: low — additive flag
   could land later.)

## Linked artifacts

- **Master design**: parent atmux kanban task `t-802c468b`.
- **Schema files**: `src/abstractions/sqlite-migrations.ts` (v13→v14),
  `src/schema/kanban.ts` (KanbanEpic), `src/core/repositories/kanban-repo.ts`
  (KNOWN_EPIC_FIELDS).
- **Core**: `src/core/epic.ts` (addEpic / setEpicReady / setEpicDependsOn /
  epicIsEligible / epicTransitiveDeps / cycle-detect).
- **CLI**: `src/verbs/epic.ts` (add --depends-on, ready, unready, deps,
  show + list enrichment).
- **Gate consumer**: `src/verbs/team.ts` or wherever `spawn-epic` lives — gate
  + `--force` override.
- **Event emission**: `src/abstractions/events.ts::emit()` calls from
  `advanceEpic` (epic.unblocked) and `setEpicReady` (epic.ready).
- **Topic registration**: `src/schema/events.ts::TOPICS` (add the two new
  topics; per-ADR-203 §D2 closed-set amendment).
- **Sibling EPIC**: e-60e16169 (orchd auto-spawn — Phase 2 consumer of this
  substrate).
- **ADR-126**: single-migration-ladder invariant (cross-check on
  atmux/unum/sopx/rentx/ifca-docs state.db).
- **ADR-203 §D2**: closed v1 topic set — this ADR is the amendment slot.
