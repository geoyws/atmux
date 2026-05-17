# ADR-146: Kanban auto-files trunk-merge Task on Story-done — supersedes branch-watcher/cron suggestion

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Author**: atmux team (planner / t-f462289a follow-on per lead 23:01 MYT P0 BLAST)
**Driver-ref**: 2026-05-14 23:01 MYT cockpit driver — operator chat-YES auth. *"kanban auto-files trunk-merge Task on Story-done; gitter drains via plain claim cascade. Supersedes branch-watcher/cron suggestion."*
**Relates**: ADR-145 (trunk-merge dispatch template — provides the Task shape this ADR auto-emits), ADR-091 (epic-team auto-merge state machine — sibling pattern at higher nesting level), ADR-134 (in-team auto-merger — provides the state-machine + cron-backstop infra), ADR-088 W1 (`src/abstractions/branch-merge.ts` primitive — gitter calls into).
**Supersedes (proposed only)**: prior branch-watcher / cron-poller suggestion (operator floated earlier; never landed as ADR). The event-driven auto-file model replaces the poll-based watcher.

## Context

### The repeated planner-files-merge-Task pattern

Today's flow when a Story completes:

1. Reviewer advances the Story `review → merging` via `atmux story advance s-xxx --to merging`.
2. Reviewer files a `merge s-xxx` Task for gitter (per existing `templates/briefs/gitter.md` §"merge s-xxx" Task shape).
3. Gitter merges the Story chain commits + advances Story `merging → done`.
4. **Then — separately, manually — planner OR lead OR operator files a `merge t-xxx (branch→trunk)` Task** (per ADR-145 §Trunk-merge dispatch) for gitter to fan-in the per-member branch back to `<base>`.

Step 4 is the repeated manual step. Today's session demonstrated the cost: planner had to file 6 trunk-merge tasks in t-f462289a (Parts B) + 2 fresh-supersede-stale tasks in the lead's 22:59 MYT P0 BLAST + 2 standalone branch-merge tasks. Same shape, same fields, same dispatch — no judgment-class decision in any of them. Planner's role here is being a typist for a deterministic emit.

**Operator's 23:01 MYT framing**: kanban should emit the trunk-merge Task automatically when the Story finishes. No watcher process, no cron poll. Pure event-driven: `task done` → Story remaining-leaf == 0 → Story.status transition → kanban writer emits the `merge t-xxx (branch→trunk)` Task atomically in the same transaction. Gitter drains via the existing ADR-032 socket-pubsub cascade — same claim mechanism gitter already uses for `commit t-xxx` and `merge s-xxx`.

### Why event-driven beats watcher/cron

Operator earlier floated a branch-watcher (cron polls `git branch --list` for branches with commits ahead of trunk, emits merge Tasks for unseen ones). Three structural problems with that approach:

1. **Polling latency** — between commits and next cron tick, trunk-merge Tasks don't exist. Gitter idles even when there's work. Sub-second event-driven beats N-minute polling.
2. **Dedup complexity** — watcher must remember which branches already had open merge Tasks (otherwise files duplicate Tasks every poll). Stateful watcher; persistence layer; per-branch flag table. Adds plumbing for a problem the event hook doesn't have.
3. **Storyless branches** — watcher fires on ANY branch with commits-ahead; doesn't know if those commits are part of a completed Story or in-flight WIP. Event-driven fires precisely when a Story reaches `merging`, so the merge Task is semantically aligned with "this work is ready".

Event-driven hook supersedes watcher/cron for this scope. (Cron-backstop per ADR-134 §Cron backstop still applies as a defense-in-depth for the case where the event-write itself fails — separate concern.)

### Adjacent infrastructure that's already in place

- **ADR-145 §Trunk-merge dispatch** — defines the `merge t-xxx (branch→trunk)` subject convention + 4 body fields (source-branch / target / owning-lane / conflict-hint). ADR-146 auto-emits Tasks of this exact shape.
- **ADR-032 socket-pubsub** — `atmux task add` cascades a wake-event to subscribed members. Gitter is already subscribed (per ADR-134 §Triggers); no new subscription needed.
- **ADR-007 pull-model kanban** — `atmux task move <id> done` is the event source. The hook is at the existing transition site.
- **ADR-091 epic-team auto-merge** — sibling pattern at the parent-team layer. ADR-091 fires its merge inside the same transaction-wrap (per ADR-091 pre-flag #1 BEGIN IMMEDIATE). ADR-146 reuses that wrap for its own auto-file emit.
- **ADR-088 W1 `src/abstractions/branch-merge.ts`** — the primitive gitter calls into to actually do the merge. ADR-146 only adds the auto-Task-file step; the merge action itself uses W1 unchanged.

## Decision

### (D1) Hook point — kanban transition on Story remaining-leaf == 0

`src/core/kanban.ts::moveTaskDone` (line ~600) gains a post-transition check: after the Task moves to `done` + `completedAt` stamped, walk up to the parent Story (`task.story` field) and count remaining non-done children. If count == 0 AND parent Story has `status === "merging"` (or similar pre-done state), fire the auto-emit (§D2).

The hook lives in the same transaction-wrap as the Task move (per ADR-091 pre-flag #1 BEGIN IMMEDIATE pattern). Either:

- (a) Both `moveTaskDone(t-xxx)` AND `addTask(merge-t-yyy)` commit atomically, OR
- (b) Both roll back atomically on failure.

No partial state. The cascade event (ADR-032) fires after COMMIT, so gitter doesn't wake on a partial state.

### (D2) Auto-emit Task shape — exactly ADR-145 §Trunk-merge dispatch

The kanban writer constructs a Task matching ADR-145 §Trunk-merge dispatch verbatim:

```yaml
subject:       "merge t-{auto-id} (branch→trunk): {source-branch} → trunk"
owner:         "gitter"                  # auto-assigned per §D3
lane:          "misc"
deps:          []                         # head-of-its-own-queue per-Story
body:
  source-branch: "{Story.branch}"        # NEW Story field; see §D4
  target:        "trunk"
  owning-lane:   "{Story.tasks[].owners[0].lane}"  # derived from first task's owner
  conflict-hint: ""                       # empty by default; planner can manually-populate post-emit if known
  parent-story:  "{Story.id}"             # back-reference for audit
  auto-emitted:  true                     # flag for distinguishing from manually-filed merge tasks
  emitted-at:    {epoch-seconds}
```

The `auto-emitted: true` flag distinguishes auto-files from manual filings — useful for audit + for tooling that might want to filter (e.g. "show me all manually-coordinated trunk-merges this week" excludes the auto-emits).

`conflict-hint` is empty by default — the kanban writer doesn't know about conflicts ahead of time. Planner / lead / gitter populates it post-emit if known (e.g. if planner sees a parallel branch also touching the same file).

### (D3) Assignee = gitter; gitter drains via existing cascade

The new Task is created with `owner: "gitter"` (per ADR-145 §D2 single-owner model for atmux-team). For teams without a gitter, the assignee falls back per `team.json::autoMerge.fallbackAssignee` (default `null`, which leaves the Task unassigned for any member to claim).

Gitter's existing claim path (`atmux claim --next --as gitter` OR the ADR-032 socket-pubsub wake) picks up the new Task on the cascade. **No new claim mechanism** — the auto-Task is structurally indistinguishable from a manual filing once it's in the kanban; gitter's brief routes on subject pattern (`merge t-xxx (branch→trunk)`) per ADR-145 §Trunk-merge dispatch §"Gitter brief addendum".

### (D4) KanbanStory schema gains `branch` field

`src/schema/kanban.ts::KanbanStory` (line ~161) gains:

```ts
/** Source branch this Story's work lives on. Used by ADR-146 auto-emit
 *  to populate the trunk-merge Task's source-branch field. For per-member-
 *  branch teams (ADR-082+084), this is typically `<base>-<member>`. For
 *  shared-cwd teams, this is the team's base branch (no fan-in needed; the
 *  auto-emit short-circuits — see §D5 short-circuit rules). */
branch: z.string().nullable().optional(),
```

Backward-compat: existing Stories without `branch` set get the auto-emit short-circuit per §D5 (no source-branch → no auto-Task). Operators backfill `branch` on existing Stories via `atmux story update s-xxx --branch geoyws-up-impl` (verb form deferred; manual SQL OK in v1).

### (D5) Short-circuit rules — when auto-emit does NOT fire

| Condition | Behaviour |
|---|---|
| Story has no `branch` field set | Auto-emit skipped (logged at WARN). Operator must manually file the trunk-merge Task. |
| `Story.branch === <team-base-branch>` (e.g. `geoyws` for atmux) | Auto-emit skipped — there's no fan-in needed; work already on base. |
| Team has `team.json::worktreeIsolation !== true` | Auto-emit skipped — shared-cwd teams don't fan-in per ADR-082 substrate. |
| `team.json::autoEmitTrunkMerge.enabled === false` | Auto-emit globally disabled for the team. Default `true` for worktree-isolated teams; `false` otherwise. |
| Story's last Task is itself a `merge t-xxx (branch→trunk)` | Loop-prevention: the trunk-merge Task IS the last child; don't auto-file another. |

### (D6) Test-gate hook — optional, future-compat

Per ADR-134's 10-state machine including a `tested` state (post-merge bun-test gate), the auto-emit could be CHAINED to test-gate transitions: auto-file the trunk-merge Task only after `tested → merged` transition (i.e. tests pass).

**v1 scope**: ADR-146 auto-emits at Story-done, NOT at tested-passed. Rationale: ADR-134's test-gate runs AFTER the merge happens (test-gate exercises the merged state). The trunk-merge Task is the INPUT to the test-gate, not gated by it.

Test-gate-on-Story-done can be a separate ADR if operators want belt-and-suspenders (e.g. block trunk-merge auto-file unless all child Tasks have green CI). Out of v1 scope.

### (D7) Config — `team.json::autoEmitTrunkMerge`

```json
{
  "autoEmitTrunkMerge": {
    "enabled": true,
    "fallbackAssignee": null,
    "shortCircuitOnSharedBase": true
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` when `worktreeIsolation: true`; `false` otherwise | Master switch. Disable for teams that prefer manual trunk-merge filing. |
| `fallbackAssignee` | `null` | If the team has no gitter, the auto-Task gets this owner. `null` = unassigned. |
| `shortCircuitOnSharedBase` | `true` | If `Story.branch === team-base`, skip auto-emit (per §D5). Disable to force-emit even on no-op cases (debug only). |

Defaults applied when `autoEmitTrunkMerge` block absent.

## Tradeoffs

### Atomic vs eventual consistency

The hook adds a second write (`addTask`) inside the `moveTaskDone` transaction. Two options:

| Choice | Risk shape | Pick? |
|---|---|---|
| Atomic — both writes in same BEGIN IMMEDIATE wrap | **Bounded**: small transaction window growth; both writes succeed-or-fail together; no partial state | ✅ |
| Eventual — `moveTaskDone` commits first, then asynchronously emit `addTask` | **Unbounded**: between the two commits, gitter wakes on `moveTaskDone` cascade but the merge-Task doesn't exist yet → false-positive idle nudge; OR addTask fails silently and the merge never auto-files | ❌ |

Atomic is structurally simpler + safer. Cost is negligible (one extra row insert in same transaction).

### Auto-flag visibility

The `auto-emitted: true` flag in the Task body is a v1-affordance for distinguishing auto-files. Trade-off: it's body-prose rather than a structured column. Reviewer enforcement that "every merge t-xxx (branch→trunk) has auto-emitted in body OR was filed by a recognized human/planner" becomes a string-match check. Acceptable for v1; promote to a structured column if downstream tooling needs to query it.

### Loop prevention complexity

§D5 loop-prevention rule ("Story's last Task is itself a `merge t-xxx (branch→trunk)`") requires the kanban writer to inspect the Story's task chain before emitting. Cost: one SELECT per emit. Acceptable for atmux-scale kanbans (~100s of Tasks); revisit if kanban grows to 10k+.

### Storyless trunk-merges still need manual filing

Per §D5, Stories without `branch` set OR teams without `worktreeIsolation` skip auto-emit. The 4 trunk-merges filed today (Parts 1+2 of this session: atmux-geoyws, geoyws-planner, supersedes-stale up-impl + test-impl) are mostly NOT Story-attached — those will remain manual. Auto-emit only catches the Story-completion path. **This is intentional**: auto-emit is for the recurring Story-done pattern; one-off branches (rebase-conflicts, hot-fixes, planner amendments) still get manual filings.

## Cross-references

- **[ADR-145](145-atmux-adopts-gitter.md) §Trunk-merge dispatch** — provides the Task shape this ADR auto-emits. ADR-146 is a strict superset (auto-emit uses the same fields verbatim).
- **[ADR-091](091-)** — epic-team auto-merge state machine. Same atomic-write-in-transaction pattern (pre-flag #1 BEGIN IMMEDIATE). Sibling at parent-team nesting level.
- **[ADR-134](134-in-team-auto-merger.md)** — in-team auto-merger architecture. Cron-backstop still applies as defense-in-depth (for the case where the auto-emit write itself fails — rare but covered).
- **[ADR-088](088-per-member-branch-fan-in.md) W1** — `src/abstractions/branch-merge.ts` primitive. Gitter calls into this for the actual merge action — unchanged by ADR-146 (ADR-146 only adds the auto-Task-file step).
- **[ADR-032](032-socket-pubsub-messaging-layer.md)** — task-done cascade socket-pubsub. Gitter wakes on the auto-emitted Task via the existing subscription; no new wake mechanism.
- **[ADR-082](082-worktree-isolation-per-member.md) + [ADR-084](084-worktree-per-member-branch-model.md)** — worktree-isolation substrate. Auto-emit short-circuits when worktreeIsolation is false (per §D5).
- **[ADR-007](007-pull-kanban.md)** — pull-model kanban + `atmux task move` semantics. The event source ADR-146 hooks into.
- **CLAUDE.md** "Don't make a dormant team look like a working team" — auto-emit makes the trunk-merge step structural rather than ceremonial; gitter wakes without operator intervention.
- **Prior branch-watcher / cron-poller suggestion** — superseded by §Decision. Cron-backstop in ADR-134 still applies as defense-in-depth.

## Open questions

**OQ-1 — Story.branch backfill verb**

KanbanStory schema gains `branch` field per §D4. Existing Stories on the kanban have NO `branch` set; auto-emit short-circuits per §D5 until backfilled.

Should we ship a `atmux story update s-xxx --branch <branch>` verb in T2, OR document manual SQL backfill OR a one-time migration script?

**Recommended default**: **manual SQL backfill via migration script** in T2. The set of pre-ADR-146 Stories is finite + bounded; one-time `UPDATE stories SET branch = <inferred-branch> WHERE id IN (...)` script suffices. `atmux story update` verb form is a future-compat consideration; v1 doesn't need it.

Driver override via decisions log when concrete demand emerges.

**OQ-2 — Auto-emit on Story state OR Task state?**

Two trigger points possible:

- (A) Trigger on `Story.status === "merging"` transition (the Story explicitly entered merging state)
- (B) Trigger on Task move-to-done causing Story remaining-leaf == 0 (semantic equivalent — last task done implies Story can advance to merging)

**Recommended default**: **(B) Task-state trigger**. (A) requires reviewer to advance Story `review → merging` first, which is a manual step that's prone to omission (today's session has multiple Story-done-without-advancement cases). (B) fires the moment the last child Task lands done; gitter can pick up the trunk-merge immediately without waiting for a separate reviewer-advance. Reviewer's role becomes "verify the chain post-merge", not "gate the auto-emit".

The Story status itself still transitions to `merging` (then `done` once gitter completes the trunk-merge) — that's a separate atomic operation in the same transaction wrap.

Driver override via decisions log when reviewer-gate semantics are needed.

## Implementation plan

This ADR commits the **specification only**. Implementation lands across the EPIC's three sub-tasks (filed in this same session per [[feedback_decomp_same_session_with_deps]]):

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-146 (this ADR) + Story.branch schema addition + autoEmitTrunkMerge config block | — | docs / planner |
| T2 | `src/core/kanban.ts::moveTaskDone` hook — atomic auto-emit + Story.branch backfill migration script + unit tests | T1 | be |
| T3 | e2e — synthetic Story chain → mark last Task done → assert auto-emit fires + Discord template renders + gitter cascade wakes | T2 | test |

Filed alongside this commit per Part 4 of t-f462289a 4-ask scope. Sub-task IDs in commit body.

## Acceptance gates

For T1 specifically (this commit):

- [x] `docs/adr/146-kanban-auto-files-trunk-merge.md` exists with `Status: Proposed`.
- [x] Hook point (D1) + auto-emit Task shape (D2) + assignee policy (D3) documented.
- [x] `KanbanStory.branch` schema addition (D4) + short-circuit rules (D5) + test-gate-out-of-scope rationale (D6) + config block (D7) documented.
- [x] Cross-refs to ADR-145, ADR-091, ADR-134, ADR-088 W1, ADR-032, ADR-082+084, ADR-007, CLAUDE.md.
- [x] 2 OQs with recommended defaults.
- [ ] Single commit; reviewer-gated.

Wider EPIC acceptance gates T2-T3 — those are out of T1's scope.

### T3 (t-51610d4e) — e2e gate landed

`tests/e2e/auto-emit-trunk-merge.test.ts` walks the moveTask verb's `transactImmediate`-wrapped integration with the §D1 hook against a real SQLite state.db fixture. Eight beats:

| Beat | Asserts |
|---|---|
| B1 | Last task done → auto-emit fires; subject + owner + body fields match §D2 / §D3 verbatim |
| B2 | Loop prevention — auto-emit-pattern Task done does NOT re-fire |
| B3 | Short-circuit — Story.branch unset |
| B4 | Short-circuit — Story.branch === team.merger.baseBranch (sharedBase) |
| B5 | Short-circuit — team.worktreeIsolation !== true |
| B6 | Short-circuit — team.autoEmitTrunkMerge.enabled === false |
| B7 | Atomicity (positive direction) — both done-transition + auto-emit rows commit together |
| B8 | ADR-032 cascade observability — auto-emit row queryable by subject pattern (subscriber contract) |

ADR-032 cascade FIRE-AND-SUBSCRIBE is skip-documented in the spec header: the actual pubsub dispatcher (ADR-134 T3 / `t-27b06cda`) is still todo. This e2e asserts the LEDGER side of the cascade (the auto-emit Task is present + queryable after moveTask returns); T3's e2e covers the actual fire-and-cascade. Atomicity NEGATIVE direction (mid-tx throw → both roll back) is SQLite `transactImmediate`'s contract + the kanban unit tests already exercise that throw path; the e2e covers the positive direction.

Result: 8 pass / 0 fail. Typecheck green.

## Out of scope

- **Test-gate-on-Story-done** — §D6 explicitly defers. Auto-emit fires at Story-done; test-gate (ADR-134 tested state) runs AFTER the merge. Separate ADR if operators want belt-and-suspenders.
- **Manual filing of trunk-merges** — auto-emit COMPOSES with manual filings; doesn't replace them. One-off branches (rebase-conflicts, planner amendments, hot-fixes) still get manual filings.
- **Cross-team auto-emit** — ADR-146 fires only on the local team's kanban writer. Cross-team Story-done cascading is the epic-team domain (ADR-091).
- **Auto-emit retry on transient failures** — if the atomic transaction fails, the move-to-done ALSO fails (atomic rollback per §Tradeoffs). Caller retries the `atmux task move` and the auto-emit re-fires with it. No separate retry plumbing.
- **PR-mode auto-emit** — ADR-091 pre-flag #8 PR-mode is schema-accept-but-runtime-noop. ADR-146 auto-emit also short-circuits PR-mode for v1; revisit if PR-mode ships.


## Amendments

### 2026-05-17 — Role-type identifier renamed `gitter` → `committer` (ADR-159)

The role type identified as "gitter" throughout this ADR is renamed to "committer" per [ADR-159](159-gitter-to-committer-rename.md) — SV/Reddit-eng register sweep + OSS-canon vocabulary alignment, supersedes nomenclature only. Design preserved verbatim — the kanban-driven trunk-merge Task auto-emit on Story-done (§Decision atomic-transaction shape, `reviewer-trunk-signoff` marker, kanban-as-source-of-truth invariant) stays canonical. The downstream consumer that picks up the auto-emitted trunk-merge Task is now `committer` (post-rename) instead of `gitter`. ADR-091 §Decision references (epic-merge state machine + auto-merge cron) and §Out of scope deferrals likewise re-point to the new role-type name via cascading interpretation; ADR-091 carries its own ADR-159 §Amendments when authored. See ADR-159 for rename mechanic + rationale.
