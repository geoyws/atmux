# ADR-175: `atmux story signoff` verb + `mergeMode` story field for trunk-direct stories

**Status**: accepted
**Accepted**: 2026-05-18
**Date**: 2026-05-18
**Driver-ref**: `.atmux/driver-inbox.md` 09:08 MYT 2026-05-17 (rentx cross-team ask — `atmux story signoff <id>` verb) + 14:22 MYT 2026-05-17 (rentx reviewer 13:55 MYT — 2 verb gaps in atmux v0.8.4 hit during E1 reviewer signoff; SQL bypass authorized as one-off, CLI gap needs to close).
**Relates**: ADR-007 (Epic/Story/Task hierarchy + OQ2 reviewer-signoff gate — origin of the gate ADR-175 makes settable), ADR-091 (epic-team lifecycle + intra-team auto-merge — sibling concept at epic layer), ADR-144 (epic-team test-gate — sibling pattern at epic layer; same shape as story-level signoff gate), ADR-159 (gitter→committer rename — `role=committer` is the canonical name; ADR-175 preserves the legacy `role=gitter` / `name=gitter` shim per ADR-159 TR3).

## Context

Two CLI gaps surfaced during rentx E1 reviewer signoff (2026-05-17 13:55 MYT). Both touch the story-advance state machine at `src/core/story.ts`. The workaround used today was raw `SQL UPDATE stories SET status='done' WHERE id='s-xxx'` — bypass of two gates — authorized in real-time by rentx driver for 4 stories (`s-425249d0` / `s-dc19b96e` / `s-f5797a08` / `s-cb99f131`). The CLI surface needs to close so reviewers don't backdoor SQL.

### GAP 1 — no setter for `stories.review_signoff`

The bit gates `review → merging`:

```
src/core/story.ts:247-253
   if (story.reviewSignoff !== true) {
     throw new UsageError({
       what: `story advance: cannot advance ${id} to merging — ` +
             "reviewer signoff missing (.reviewSignoff != true)",
     });
   }
```

`reviewSignoff` defaults `false` (`src/core/story.ts:116`). The schema field exists (`src/schema/kanban.ts:214`), the SQLite column exists (`src/abstractions/sqlite-migrations.ts:81`), the repo persists it (`src/core/repositories/kanban-repo.ts:230/246/267`). No CLI path writes it. The reviewer brief (`templates/briefs/reviewer.md §6`) assumes the verb exists.

### GAP 2 — `review → merging` synthesizes a gitter merge-Task even for trunk-direct stories

The state transition at `src/core/story.ts:320-349` auto-creates a `merge <story-id>` Task assigned to `role=committer` (or legacy `gitter`):

```
src/core/story.ts:320-349
   } else if (resolved === "merging") {
     const gitter = team?.members.find(
       (m) => m.role === "committer" || m.role === "gitter" || m.name === "gitter",
     );
     if (gitter === undefined) { throw new ConfigError({ ... }); }
     const tid = `t-${randomBytes(4).toString("hex")}`;
     const task: KanbanTask = {
       id: tid, subject: `merge ${id}`, ..., owner: gitter.name, lane: "misc", ...
     };
     repo.addTask(task);
     updatedStory.mergeTaskId = tid;
   }
```

For rentx E1's platform/infra stories (submodule attach, nginx symlink, systemd unit, deploy worktree provision), there is **no feature branch and no merge commit**: code lands on trunk directly + provisioning writes `/etc/*` at deploy time. The synthetic merge-Task is busywork; gitter has nothing to merge; `merging → done` requires gitter to mark the synthetic Task `done` to clear `story.mergeTaskId === 'done'` gate at `src/core/story.ts:254-271`.

The deeper conflation: `merging` state == `gitter dispatch`. For some story shapes, **review signoff IS the completion signal**.

### Sibling observation (NOT in scope for ADR-175)

`atmux epic advance` has neither gate — no signoff bit, no gitter requirement. Operators noted (driver-inbox 14:22 MYT 13:55 MYT entry): *"that asymmetry — epic advance smooth, story advance gated — is worth a planner look too"*. Filed as **OQ-5** below for a future ADR; not bundled here to keep this ADR focused on the two confirmed CLI gaps.

## Decision

Close both gaps in one ADR — they share the `src/core/story.ts` advance code path.

### GAP 1 resolution — primary verb `atmux story signoff` + reversal `atmux story unsignoff`

```
atmux story signoff   <story-id> [--as <reviewer-member>] [--note <text>]
atmux story unsignoff <story-id> [--as <reviewer-member>] [--note <text>]
```

- **`signoff`**: flips `stories.review_signoff = 1`. Refuses if `story.status !== 'review'` (caller is signing off the wrong state). Refuses if caller's role per `team.json` lookup is not `reviewer` AND `--as <member>` is not passed (operator override allowed for cross-cage workflows; logs `signed-off-by: <member>` regardless).
- **`unsignoff`**: flips back to `0`. Useful for "reviewer changed their mind before merging started." Refuses if `story.mergeTaskId !== null` (signoff already consumed by a gitter dispatch — at that point use the merge-task abort flow).
- **Audit trail**: append `{ signedOffBy: <member>, signedOffAt: <epoch>, note: <text|null> }` to `stories.extra.signoffAudit[]` per ADR-091-style extra-JSON-append pattern. Reversal appends a counter-entry `{ unsignedBy, unsignedAt, note }` — append-only, no deletes.
- **No composite (`--signoff` flag on `story advance`)**: option (b) from the driver-inbox surface was considered; chose primary single-purpose verb for ergonomic clarity. Composite can layer on as a future convenience flag without breaking the primary surface.
- **No `atmux done --signoff` (option c)**: conflates Task completion with Story state-machine advance; less discoverable; reviewer-brief vocabulary uses "approve" / "signoff" semantics, not "done".

### GAP 2 resolution — `mergeMode` field on `KanbanStory`

```
KanbanStory.mergeMode: 'feature-branch' | 'trunk-direct'    // default 'feature-branch'
```

Two values only (deliberately constrained):
- **`feature-branch`** (DEFAULT) — current behaviour. `review → merging` synthesizes the gitter merge-Task; `merging → done` requires merge-Task done.
- **`trunk-direct`** — code lands on trunk without a feature branch / merge commit. `review → merging` is **SKIPPED**; `review → done` becomes legal directly. Signoff bit STILL required (review gate intact; we're bypassing the merge phase, not the review phase).

**Why not 3 values (`feature-branch` / `trunk-direct` / `no-merge`)?** The "no-merge" case from the driver-inbox surface (operator-only configuration recorded for audit) is rare enough to carry via story body convention or a future extension. Two values cover the observed shapes; YAGNI tightens scope.

**Set via**: `atmux story add "<title>" --epic <eid> --merge-mode <m>` (flag added). Default omitted = `feature-branch`. Settable post-hoc via `atmux story update <id> --merge-mode <m>` if the property exists (out of scope here; see OQ-2 below).

**`review → done` transition rule for `trunk-direct`**:
- Refuses if `story.reviewSignoff !== true` (signoff still required).
- Skips merge-Task synthesis. `story.mergeTaskId` stays null. `story.completedAt = now`. Done.
- Auto-advances parent epic to `done` per existing parent-flip logic (no change there).

**State machine update** (`docs/adr/007-*.md §OQ2 amendment header — see T5`):

```
feature-branch:  planning → ready → in-progress → testing → review → merging → done
trunk-direct:    planning → ready → in-progress → testing → review → done       (skips merging)
```

## Consequences

| Lane    | What changes                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------- |
| **be**  | `src/verbs/story.ts` gains `signoff` + `unsignoff` subverbs (parse + dispatch). `src/core/story.ts` gains `storySignoff` + `storyUnsignoff` functions with role/status gates + extra-JSON audit append. |
| **be**  | `src/core/story.ts::storyAdvance` consumes `mergeMode`: when `trunk-direct`, treat `review → done` as the legal transition (replacing `review → merging`); skip the synthetic merge-Task; require signoff bit. |
| **be**  | `src/verbs/story.ts::storyAdd` parses `--merge-mode <m>` flag; validates enum. |
| **db**  | `src/schema/kanban.ts::KanbanStory` gains `mergeMode: z.enum(['feature-branch', 'trunk-direct']).default('feature-branch')`. SQLite migration: `ALTER TABLE stories ADD COLUMN merge_mode TEXT DEFAULT 'feature-branch'` per ADR-126/169 pattern. Forward-compatible — existing rows get the default. |
| **test**| Unit: signoff bit flip + role-gate + status-gate refusal + audit append; unsignoff reversal + mergeTaskId-set refusal. Integration: feature-branch story full state-machine; trunk-direct story `review → done` skips merging. Repro the 4 rentx E1 stories' shape end-to-end. |
| **docs**| `templates/briefs/reviewer.md §6 'Decide'` — update verb references from assumed `atmux story signoff` to confirmed signature. `templates/briefs/planner.md` — `atmux story add` signature gains `--merge-mode`. `docs/adr/007-*.md` — `§OQ2` amendment header (append-only) noting ADR-175 surfaces the signoff CLI + adds `mergeMode` branching. |
| **ops** | None — no cron / verb-signature breakage for existing single-mode flow. Pure additive surface.        |

**Forward enablement**:
- **Reviewer ergonomics** — single canonical verb path matches `templates/briefs/reviewer.md` vocabulary; no more "verb assumed but missing" gap.
- **Trunk-direct stories first-class** — rentx-shape infra stories (and SOPX equivalents likely too) get a clean state-machine path without SQL-bypass authorization.
- **Audit trail** — `stories.extra.signoffAudit[]` is greppable + persisted; SQL-bypass loses that record.
- **Closes the rentx-driver SQL-bypass class** — no more "operator confidence" authorizations on `UPDATE stories SET status='done'`.

**What we give up**: a small surface increase. Two new subverbs (signoff/unsignoff) + one schema field + one `--merge-mode` flag. All additive; no existing flow breaks.

**Rollback path**: revert this ADR's T2/T3/T4. Schema migration is forward-only but trivially reversible (drop the column or ignore it; default-`feature-branch` preserves behavior). Existing kanban data is unaffected.

## Open questions

1. **`signoff` role gate — strict reviewer-only, or operator override with `--as <member>`?** **Default**: operator override allowed via `--as`. *Why*: cross-cage / off-hours workflows where the reviewer pane is dormant. Audit trail (`signedOffBy`) captures the real signer. Strict role gate would block the rentx-shape workflow we just observed.
2. **Should `mergeMode` be settable post-hoc via `atmux story update`?** **Default**: YES — file as a sibling fast-follow Task under this EPIC, not its own ADR. Rare but operationally useful when an in-flight story changes shape (e.g. "we'll land this trunk-direct after all"). Out of scope for T2-T5; surfaces as a T6 if demand grows.
3. **Should we add the third `mergeMode` value `'no-merge'` for audit-only / config-only stories?** **Default**: NO — YAGNI. Two values cover observed shapes. Reconsider if a real story comes up that fits neither.
4. **Should `atmux done <task-id>` from a reviewer on a review-lane Task auto-fire signoff?** **Default**: NO — option (c) from the driver-inbox surface was considered and rejected. Conflates Task lifecycle with Story state machine; less discoverable. The two verbs stay orthogonal.
5. **Should `atmux epic advance` get the same gates** (`reviewSignoff` + dispatch logic)? *Sibling observation from driver-inbox*: "epic advance is asymmetrically smoother than story advance — worth a planner look." **Default for ADR-175**: NOT IN SCOPE. Epic-layer signoff is a real design question with broader blast radius (epic state machine, dispatch authority). File as a separate planner-routed ADR if demand surfaces. ADR-175 stays focused on the two confirmed CLI gaps.
6. **Audit-trail location — `stories.extra.signoffAudit[]` or a new `signoffs` table?** **Default**: extra-JSON-append per ADR-091 pattern. *Why*: low-frequency event; querying-from-SQL is rare; JSON append matches existing patterns. Reconsider if signoff-querying becomes a use case.

## Reversibility

`medium`. Two new verbs (additive — low) + one schema field (additive with `feature-branch` default — low) + one state-machine semantic change (`review → done` becomes legal for `trunk-direct` — this is the medium-reversibility bit; rollback means reverting the advance-logic change and re-introducing the signoff bypass).

## Related

- **ADR-007** §OQ2 — origin of the reviewer-signoff gate ADR-175 makes settable. Append-only amendment header to be added in T5.
- **ADR-091** — epic-team lifecycle; intra-team auto-merge sibling at the epic layer. ADR-175's mergeMode is a story-layer counterpart but does NOT introduce auto-merge dispatch logic; we just skip the dispatch when trunk-direct.
- **ADR-144** — epic-team test-gate; sibling shape (gate at state-machine transition, requires explicit bit flip). ADR-175's signoff gate has the same shape at the story layer.
- **ADR-159** TR3 — `gitter → committer` rename grace shim. ADR-175 preserves both lookups (`role === 'committer' || role === 'gitter' || name === 'gitter'`) for the trunk-direct skip path's role check.
- **ADR-172** (sibling planner-session ADR) — `atmux task add --epic` flag. ADR-175 ships independently; once ADR-172 T2 lands, `atmux story add --epic <eid> --merge-mode trunk-direct` becomes the canonical filing pattern. Gracefully degrades to body-text convention until then.
- **ADR-126** / **ADR-169** — state.db migration patterns ADR-175's `merge_mode` column follows.
