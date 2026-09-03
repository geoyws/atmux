# ADR-091: Kanban-driven auto-merge state machine — epic-team → parent fan-in

**Status**: accepted
**Date**: 2026-05-16
**Driver-ref**: `.atmux/driver-inbox.md` 14:03 MYT 2026-05-13 §Pillar 3 + §Open call #3 (auto-merge gitter ownership, resolved: epic-team-scoped gitter) + §Open call #5 resolved (EPIC-done definition).
**Parent Task**: t-e576dd43 (team-of-teams umbrella). **Authored under**: t-4af76f05 (ADR draft, 5/6 in the ADR-085 → ADR-092 batch).
**Numbering shift**: this ADR is the **+1 shift** of driver-inbox's §ADR-090 auto-merge ask, bumped to avoid collision with the live **ADR-086** (atmux-pulse). Full shift documented in [ADR-090](090-epic-team-lifecycle.md) header — `driver-inbox §ADR-086→087, §ADR-087→088, §ADR-088→089, §ADR-089→090, §ADR-090→091 (this), §ADR-091→092`. Future readers MUST cross-reference using the shifted IDs, not the original driver-inbox numbering.
**Reviewer pre-flag**: `.atmux/reviewer-preflag-ADR089-091.md` §ADR-091 (signed 2026-05-13) — 8 §Decision-anchors folded into §Decision below. Post-ship audit `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 1 (signed 2026-05-13) — 3 additional state-machine recommendations folded into §Decision below. All 11 anchors land as numbered §Decision-anchor lines before the prose.

> **Implementation note (impl shipped before draft per planner discretion).** The state machine logic + verb wiring + cron emission landed under `t-04350614` at commit `a34fafa` (2026-05-16); the ADR-090↔ADR-091 dispatch-dissolve wire-up landed under `t-9a8b0e4e` at commit `b502ebe`; the e2e dogfood gate landed under `t-9d22718b` at commit `d79840b`. This ADR documents the canonical design those commits pin to. The impl-first ordering was a deliberate planner-discretion call (the shared state machine `src/core/branch-merge-state.ts` from [ADR-134](134-in-team-auto-merger.md) T2 / `7da4e85` was already on disk; ADR-090 fixed the integration contract; impl could proceed against those two without the draft). Reviewer signoff on this ADR closes the layering deviation; subsequent edits to the impl modules treat this document as canonical.

## Context

### Why this ADR exists now

[ADR-090](090-epic-team-lifecycle.md) ships the epic-team primitive — `spawn-epic` creates an ephemeral, shared-worktree child team that lives at `<parentRoot>-epics/<epicId>/`; `dissolve-epic` tears it down. ADR-090 §Decision-anchor #5 names the EPIC-done definition (all child Tasks `done`, worktree clean, HEAD ahead of `parentBase`, `reviewer-trunk-signoff` Task in `done`) — but stops short of specifying **what runs the merge** when those conditions hold.

That's this ADR's job. Without a defined state machine + trigger + cron + dispatch-dissolve hook, the EPIC's final fan-in lands as a manual operator step — defeating the whole epic-team value proposition (which was: spawn a focused team, let it complete, watch the merge land on its own). The auto-merger is the closing primitive that makes spawn-epic worthwhile.

### Why this is NOT [ADR-134](134-in-team-auto-merger.md)

[ADR-134](134-in-team-auto-merger.md) ships the **intra-team** auto-merger — per-member branch (`<teamBase>-<member>`) fan-in into the team's own base (`<teamBase>`). It operates inside ONE team's git repo + cage; the merger is an expanded gitter role at the team layer. Its state machine, persistence layer (`merger_state` SQLite table), and merge primitive (`mergeMember`) are SHARED with this ADR via the `src/core/branch-merge-state.ts` module (per ADR-134 implementation note + Path A reuse decision in `t-b5f12ab1`).

This ADR addresses **sibling-team scope** — an epic-team's branch (`<parentBase>-epic-<epicId>`) merging UP into its parent team's base (`<parentBase>`). The state machine is the SAME shape (ADR-134's `BranchMergeState` enum covers both scopes verbatim); the SCOPE of the `<base>-<branch>` pair differs:

| ADR | Scope | `<base>` | `<branch>` | Repo | Merger role |
|-----|-------|----------|------------|------|-------------|
| [ADR-134](134-in-team-auto-merger.md) | intra-team | `<teamBase>` (e.g. `geoyws`) | `<teamBase>-<member>` | team's own | team gitter member |
| **ADR-091 (this)** | epic-team → parent | `<parentBase>` (e.g. `sopx-geoyws`) | `<parentBase>-epic-<epicId>` | parent's worktree | epic-team gitter (per ADR-090 §`gitter` extension) |

Both ADRs coexist; the same `MergerStateRepo` table holds rows for both scopes, addressed by branch name (no schema migration — the row's primary key is a string).

### What the auto-merge looks like at the user-facing edge

From the operator's perspective:

1. Operator spawns an epic-team via `atmux team spawn-epic <epicId> --from <parent>` (ADR-090). Child gets its own worktree on `<parentBase>-epic-<epicId>`, its own state.db, its own cage.
2. Epic-team's members work normally — claim Tasks, ship commits to the shared `<parentBase>-epic-<epicId>` branch.
3. Reviewer (a member of the epic-team's roster) confirms test coverage + commit-cadence health, then files a Task with `role: "reviewer-trunk-signoff"` and marks it `done`.
4. The `atmux epic-merge tick` cron (every 5min per epic-team, gated on `team.epicTeam !== undefined`) re-evaluates the gate. When all child Tasks are `done` (including the trunk-signoff Task) AND the worktree is clean AND HEAD is ahead of `<parentBase>` AND `<parentBase>` hasn't moved → the state machine advances `ready_to_merge → merging → merged`.
5. On `merged`, the dispatchDissolve hook auto-fires `atmux team dissolve-epic --auto <epicId>` — prunes the worktree, removes the cockpit entry, marks the parent's EPIC row `done`. The state machine then transitions `merged → dissolved`.

No operator action between steps 3 and 5. The auto-merger is the bridge.

### Why epic-team gitter, not parent gitter

Per ADR-090 §`gitter` extension (resolved-open #3): the epic-team's own gitter (if rostered) owns the auto-merge cron; the parent's gitter only handles merge-result notifications. This matches ADR-134's locality-of-mutation argument applied one level up: the merge happens inside the parent's worktree, but the cron + state-machine ticks fire from the epic-team's cage (where its own `state.db` lives + where `team.epicTeam.parentBase` is defined). Architectural symmetry across nesting levels — same model as ADR-134, just one level up.

## Decision

Eleven §Decision-anchor lines first (8 from reviewer pre-flag + 3 from post-ship audit), then prose around each subsystem. Anchor references map back to the source documents cited in the ADR header.

> **§Decision-anchor #1** — **`BEGIN IMMEDIATE` wraps EVERY state transition** (pre-flag #1). All transitions (`open → in_progress`, `in_progress → ready_to_merge`, `ready_to_merge → merging`, `merging → merged | conflict`, `merged → dissolved`) MUST run as a single `BEGIN IMMEDIATE; <re-read state + UPDATE>; COMMIT;` transaction at the `MergerStateRepo` layer. Race window for `all-tasks-done → ready_to_merge`: a Task creation at BEGIN−1ms would otherwise land in `todo` while the transition fires; `BEGIN IMMEDIATE` blocks the writer. Concrete impl: `src/core/repositories/merger-state-repo.ts::transition()` already wraps `BEGIN IMMEDIATE` via `transactImmediate` (verified in `a34fafa`); this anchor pins the contract so future schema migrations don't downgrade it.
>
> **§Decision-anchor #2** — **Conflict-surface durability — write to parent's state.db FIRST, then tell-lead** (pre-flag #2). Fire-and-forget `tell-lead --team <parent>` can drop silently (socket down, lead pane wedged). The cron MUST write `epic.note = "conflict at <SHA>"` directly to the parent's state.db (durable signal) BEFORE firing tell-lead. DB-write succeeds even if socket-ping fails; parent's planner-near reads `epic.note` on next whip tick. Concrete impl: `src/core/epic-merge.ts::runAutoMerge` writes `merger_state.note` via the repo's transactional path on `conflict` terminal, and the conflict reason carries the `<SHA>` (or first 5 conflict paths) — surfaced to operators via `atmux status` without depending on the cross-team tell-lead path (ADR-092 forward-ref).
>
> **§Decision-anchor #3** — **`reviewer-trunk-signoff` marker — mirror [ADR-090](090-epic-team-lifecycle.md) §Decision-anchor #1 verbatim** (pre-flag #3). The auto-merge trigger reads "reviewer-trunk-signoff Task in done"; the canonical marker is `task.role: "reviewer-trunk-signoff"` on `KanbanTask` per ADR-090 §Decision-anchor #1. Cross-ADR consistency: this ADR does NOT re-litigate the marker shape — it cites ADR-090 verbatim. The schema field landed in [ADR-090 T1](090-epic-team-lifecycle.md) at commit `762716f` (KanbanTask gains optional `role` field, schema-permissive `z.string()` so future role markers land additively). Reviewer rejects this ADR if it picks a different marker.
>
> **§Decision-anchor #4** — **Stale-epic rebase before merge — `ready_to_merge → rebasing → merging`** (pre-flag #4). `git merge --no-ff <epic-branch>` on a long-lived epic-team works but conflict count grows monotonically as `<parentBase>` advances. The cron MUST check `git merge-base --is-ancestor <parent-base> <epic-branch>`; if NOT ancestor (parent moved forward), the state machine routes `ready_to_merge → rebasing` first and fires `git -C <epicRoot> rebase <parent-base>`. On rebase success the state advances back to `ready_to_merge` (next tick re-evaluates with updated base-ancestry). On rebase conflict the state terminals at `conflict`. Concrete impl: `shouldEpicTransitionFromInProgress` already returns `rebasing` when `gate.baseHasMoved === true` (via the shared `shouldTransitionFromInProgress`); the rebase-resolution outer wiring is deferred to a follow-up Task (`src/core/epic-merge.ts` documents the wrapper-stops-here contract, operator manual reset to `in_progress` is the v1 unblock path per §Decision-anchor #7).
>
> **§Decision-anchor #5** — **Adjacent class — wrong-parent merge validation** (pre-flag #5). If `epicTeamRoot` is stale (worktree deleted manually) OR parent's branch changed since spawn-epic, a naive merge fires from wrong-state parent → lands changes on wrong branch silently. The cron MUST validate BEFORE the `ready_to_merge → merging` transition: (a) `parentRoot` exists on disk; (b) `git -C parentRoot rev-parse --is-inside-work-tree` succeeds; (c) `git -C parentRoot branch --show-current` matches `epic.parentBase`. Any failure refuses the transition (stays in `ready_to_merge` with operator-actionable reason in `merger_state.note`). Concrete impl: `mergeMember` in `src/abstractions/branch-merge.ts` runs `git checkout <base>` as its first step + verifies HEAD-after-checkout — checks (b) and (c) are absorbed there. Check (a) is implicit in `parentRoot`-passed-to-spawn (cockpit walk validates `root` exists at lookup time); cron-tick re-validates via the path-exists probe before invoking `mergeMember`.
>
> **§Decision-anchor #6** — **Add `dissolved` terminal state** (pre-flag #6). The original draft state machine ended at `merged | conflict`, but ADR-090 §`dissolve-epic` runs AFTER `merged` (worktree prune + cockpit-entry remove + parent EPIC mark-done). Cockpit walks need a discoverable signal — checking `/tmp` for socket-absence is brittle. So: add `merged → dissolved` terminal transition that fires AFTER dispatchDissolve returns success. Discoverable via `MergerStateRepo.getState(epicBranch)?.state === "dissolved"` instead of inferring from filesystem state. The `BranchMergeState` enum in `src/core/branch-merge-state.ts` does NOT currently include `dissolved` (the shared enum is scope-clean for ADR-134); the dispatch-dissolve wire-up at `b502ebe` shows the transition fires on `merged → merged + dispatched` flag, but a true `dissolved` literal would be additive. **This anchor's full satisfaction lands in a follow-up Task** that adds `dissolved` to the shared enum + extends `MergerStateRepo` to accept the new literal + updates `tryDispatchDissolve` to UPDATE the row to `dissolved` on success.
>
> **§Decision-anchor #7** — **`conflict → in_progress` reverse transition** (pre-flag #7). Once a human resolves a conflict (manual `git rebase --continue` + `git push`), the row must return to `in_progress` so the next cron tick re-evaluates the gate. The mechanism: `atmux epic advance <eid> --to in-progress` from the parent team's planner OR direct SQL via `atmux flag add --task <eid>:state=in_progress` (follow-up Task ships the verb sugar). The shared `branch-merge-state.ts::isValidTransition` already permits `conflict → in_progress` as an operator-driven manual reset (per ADR-134 §state-machine "transition back to in_progress is manual"); the reverse transition is documented here for operators who hit a stuck conflict without knowing the unblock path.
>
> **§Decision-anchor #8** — **`mergeMode: "pr"` is schema-accept-but-runtime-noop in v1** (pre-flag #8 + audit Class 1 §3). Mirrors [ADR-090](090-epic-team-lifecycle.md) §Decision-anchor #6: schema accepts both `"auto"` and `"pr"`; runtime auto-merge only handles `"auto"`. `pr`-mode runtime impl is deferred to a future ADR. The Team schema's superRefine already refuses `mergeMode: "pr"` without `prTarget.base` + `prAuthorUser` (per ADR-090 §Decision-anchor #8/#9), so misconfigurations refuse at schema parse instead of failing silently at the auto-merge transition. Concrete impl: `src/core/epic-merge.ts::performEpicMerge` short-circuits at `ready_to_merge` with a deferred-runtime reason when `ctx.mergeMode === "pr"`.
>
> **§Decision-anchor #9** — **`pr-open` state between `ready_to_merge` and pr-terminal** (audit Class 1 §1, slow-mode runtime — deferred). Pr-mode transitions: `ready_to_merge → pr-open → (pr-merged | pr-closed | pr-conflict)`. Auto-mode keeps the existing chain unchanged (`ready_to_merge → [rebasing →] merging → (merged | conflict) → dissolved`). The pr-mode chain is documented here for forward-compat; the runtime polling logic (`gh pr view <num> --json state,mergeStateStatus` every 5min per epic until terminal) lands in the future pr-mode-runtime ADR. The `BranchMergeState` shared enum does NOT currently include the `pr-*` literals; they're reserved for the pr-mode runtime ADR's schema bump.
>
> **§Decision-anchor #10** — **PR-creation durability — `epic.prNumber` + `epic.prState` written to parent state.db BEFORE the `gh` CLI call returns** (audit Class 1 §2). Idempotent: if `epic.prNumber` is already set on retry, SKIP `gh pr create` and resume polling. Same durable-first pattern as §Decision-anchor #2 (conflict-surface). The `KanbanEpic` schema already carries `prNumber?: number` + `prState?: string` as forward-ref fields per ADR-090 §Schema (landed at commit `762716f`); runtime wire-up deferred to the future pr-mode-runtime ADR.
>
> **§Decision-anchor #11** — **`gh auth switch` process-global concurrency mutex via `cockpit_gh_lock`** (audit Class 1 §3 / mirrors [ADR-090](090-epic-team-lifecycle.md) §Decision-anchor #11). `gh auth switch` mutates `~/.config/gh/hosts.yml::active-user` globally — concurrent multi-epic PR-creation will silently corrupt the active-user state without serialization. Mitigation: a `cockpit_gh_lock` advisory row in the parent's state.db, `BEGIN IMMEDIATE`-acquired before `gh auth switch`, released after `gh pr create` returns. ADR-090 documents the constraint; the runtime impl lives in this ADR's eventual pr-mode follow-up (deferred per §Decision-anchor #8). The `cockpit_gh_lock` migration is reserved for that future ADR's commit.

### §State machine (auto-mode, v1)

**States** (8 — 7 inherit verbatim from the shared `BranchMergeState` enum + 1 new `dissolved` per §Decision-anchor #6):

```
open → in_progress → ready_to_merge → [rebasing →] merging → merged → dissolved
                                                         └─→ conflict
```

**Transitions** (priority order — first matching condition wins):

| From | Condition | To | Side effect |
|------|-----------|----|-------------|
| `(no row)` | first cron tick | `open → in_progress` | seed merger_state row |
| `open` | any | `in_progress` | seed transition note |
| `in_progress` | owner has open tasks OR worktree dirty OR not-ahead-of-base OR missing `reviewer-trunk-signoff` Task | `in_progress` | refresh note with blocker |
| `in_progress` | gate-pass + base moved during work | `rebasing` | `git -C epicRoot rebase parentBase` (§Decision-anchor #4) |
| `in_progress` | gate-pass + base stable | `ready_to_merge` | refresh note "all checks pass" |
| `rebasing` | rebase clean | `ready_to_merge` | next tick re-evaluates |
| `rebasing` | rebase conflict | `conflict` | terminal — note carries conflict paths |
| `ready_to_merge` | `mergeMode === "auto"` + parent-validation pass (§Decision-anchor #5) | `merging` | enter merging optimistically (durable signal per §Decision-anchor #2) |
| `ready_to_merge` | `mergeMode === "pr"` | `ready_to_merge` | NO-OP per §Decision-anchor #8; refresh note "pr-mode runtime deferred" |
| `merging` | `mergeMember` returns `{status:"merged",sha}` | `merged` | dispatchDissolve fires (ADR-090↔ADR-091 hook) |
| `merging` | `mergeMember` returns `{status:"no-op"}` (no commits ahead) | `merged` | dispatchDissolve fires; note "no-op" |
| `merging` | `MergeConflictError` | `conflict` | terminal — force-write conflict note bypassing TOCTOU guard |
| `merged` | dispatchDissolve returns `true` | `dissolved` | terminal — cockpit clean, worktree pruned, parent EPIC marked done |
| `merged` | dispatchDissolve returns `false` | `merged` | NO-OP — dispatch gap is operator-recoverable; next cron tick re-attempts |
| `conflict` | operator-driven `atmux epic advance --to in-progress` | `in_progress` | reverse transition per §Decision-anchor #7 |
| `dissolved` | any | `dissolved` | terminal — no-op short-circuit |

### §State machine (pr-mode, slow-mode — deferred per §Decision-anchor #8/#9/#10/#11)

```
open → in_progress → ready_to_merge → pr-open → (pr-merged | pr-closed | pr-conflict) → dissolved
                                                                             └→ in_progress (re-open)
```

**Pr-mode runtime impl is deferred** to a future ADR. Schema accepts `mergeMode: "pr"` + the forward-ref `epic.prNumber` / `epic.prState` / `epic.note` fields land in ADR-090 (already shipped at `762716f`). Runtime polling cron, `gh pr create` idempotency, `cockpit_gh_lock` mutex impl all live in that future ADR.

### §Triggers — per-epic-team cron

**Primary** (event-driven, NOT shipped in v1): a `task-done` event on the epic-team's kanban fires an immediate epic-merge tick (via `src/core/socket-pubsub.ts` cascade — forward-ref to socket-pubsub-driven dispatch, currently parked).

**Secondary** (cron-backstop, v1): `atmux epic-merge tick` fires every 5min per epic-team. Cron-line emission lives in `src/core/cron.ts::renderCronLines` — gated on `team.epicTeam !== undefined`. Default cadence is `DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS = 5`; override via `cron-install --template epic-merge --interval <N>`.

The verb itself (`src/verbs/epic-merge.ts::epicMergeTickVerb`) resolves gate facts (kanban open-task count, reviewer-trunk-signoff presence, worktree clean, ahead-of-base, base-moved) from kanban + git probes, composes `EpicMergeContext`, and dispatches `performEpicMerge`. The dispatchDissolve hook lands `dissolveEpic([epicId], {callerScope: () => "driver"})` automatically on terminal `merged`.

### §Gitter ownership

Per ADR-090 §`gitter` extension + resolved-open #3: **the epic-team's own gitter** (if rostered) is the human-facing owner of the auto-merge cron. Operationally:

- Each epic-team's roster MAY include a `gitter` member (default roster does not — operators add one for high-commit-frequency epics).
- The gitter operates EXCLUSIVELY within the epic-team's cage:
  1. Commits child Tasks per the standing gitter pattern ([ADR-145](145-atmux-adopts-gitter.md)).
  2. Pushes to `<parentBase>-epic-<epicId>` on `origin` per the standing push policy.
  3. **Does NOT run the trunk-merge** — that's `atmux epic-merge tick`'s job (this ADR's state machine).
- Parent-team's gitter is OUT OF SCOPE — it only receives merge-result notifications (via ADR-092's tell-lead surface forward-ref).

The gitter brief at `templates/briefs/gitter.md` documents the EPIC-TEAM CARVE-OUT rule (shipped at `a34fafa`).

### §EPIC-done definition (canonical)

Mirrors ADR-090 §Decision-anchor #5 verbatim. EPIC completes (`merger_state.state = "merged"` then `"dissolved"`) when ALL of:

1. Every child Task in the epic-team's `state.db` is `status IN ('done', 'wontfix')`.
2. The epic-team's worktree is clean: `git -C <epicRoot> status --porcelain` returns empty.
3. HEAD is ahead of `<parentBase>`: `git -C <epicRoot> rev-list --count <parentBase>..HEAD > 0`.
4. A Task with `role: "reviewer-trunk-signoff"` exists in `done` state (§Decision-anchor #3).

The `reviewer-trunk-signoff` Task is filed by the reviewer ONLY AFTER:
- Every code-shipping child Task landed paired tests (per project [CLAUDE.md](../../CLAUDE.md) §Testing Discipline).
- The commit-cadence gate ([ADR-148](148-commit-cadence-truth-signal.md)) shows the epic-team shipping (not pane-alive-but-dormant).

A `role: "reviewer-trunk-signoff"` Task with no test-citation in the body is a reviewer-flag failure mode in its own right.

### §Reverse transition — conflict unblock path (per §Decision-anchor #7)

When the epic-team's branch terminals at `conflict`:

1. Operator (or parent team's planner-near, prompted by `epic.note` durable signal per §Decision-anchor #2) inspects the conflict: `git -C <epicRoot> status` shows conflicted paths.
2. Manual resolution: `git mergetool` OR `git rebase --continue` OR hand-edit + `git add . && git commit`.
3. Push the resolved branch: `git -C <epicRoot> push origin <parentBase>-epic-<epicId>`.
4. Reset the state machine row: `atmux epic advance <epicId> --to in-progress` (verb sugar to be shipped in a follow-up Task — for v1, direct SQL: `UPDATE merger_state SET state = 'in_progress', note = 'operator-resolved conflict', transitioned_at = strftime('%s','now') WHERE member_branch = '<epicBranch>'`).
5. Next cron tick re-evaluates the gate; if all conditions hold, `in_progress → ready_to_merge → ...` resumes.

The `branch-merge-state.ts::isValidTransition` already permits `conflict → in_progress` per ADR-134 §state-machine "transition back to in_progress is manual" — the rule applies verbatim to epic-team rows.

## Consequences

### What this ADR enables

- **End-to-end epic-team lifecycle**: `spawn-epic` → child team works → reviewer files signoff → auto-merge fires → dissolve cleans up. No operator action between signoff and dissolved.
- **Reusable substrate**: every primitive (`branch-merge-state.ts`, `mergeMember`, `MergerStateRepo`, `softStop`, `pruneWorktree`, `provisionWorktree`) was already on disk. This ADR composes them; ADR-090 ships the schema scaffolding (`team.epicTeam` block, `KanbanEpic.epicTeamName/Root/prNumber/prState/note`, `KanbanTask.role`) that the composition reads.
- **Cross-nesting-level symmetry**: ADR-091 is to epic-team scope what [ADR-134](134-in-team-auto-merger.md) is to intra-team scope. Operators learn one mental model — "gitter auto-merge cron driven by the same state machine" — and apply it at both nesting levels.

### What this ADR does NOT cover

- **Cross-team `tell-lead`** from epic-team's auto-merge cron to parent's planner-near on `conflict`. The durable signal lives in `epic.note` per §Decision-anchor #2 (operator-readable via `atmux status`); the lossy fire-and-forget tell-lead surface is the SECOND-line escalation, gated on ADR-092 caller-scope-gate landing. Forward-ref.
- **PR mode runtime** (§Decision-anchor #8/#9/#10/#11). Schema is forward-compat; runtime ships in a future ADR.
- **Auto-cage-spawn** for the freshly-spawned epic-team. ADR-090 §`spawn-epic` notes the operator runs `atmux cockpit rebuild` after spawn-epic to bring the child cage up; auto-spawn lands as a follow-up Task.
- **Multi-epic resource contention** (Class 3 audit carve-out). Deferred to post-dogfood t-77ae2baa.

### Reuse statement

Per ADR-090 §Reuse statement pattern — ZERO new abstractions:

- State machine: `src/core/branch-merge-state.ts` (ADR-091 + ADR-134 shared, landed `7da4e85`).
- Merge primitive: `src/abstractions/branch-merge.ts::mergeMember` (ADR-179 W1, landed in `a37dacc`).
- Persistence: `src/core/repositories/merger-state-repo.ts` (ADR-134 T2, landed `a636dc6`).
- Caller wrapper: `src/core/epic-merge.ts::performEpicMerge` (this ADR's impl, landed `a34fafa`).
- Verb: `src/verbs/epic-merge.ts::epicMergeTickVerb` (this ADR's impl, landed `a34fafa`).
- DispatchDissolve hook: `src/verbs/epic-merge.ts::defaultDispatchDissolve` (ADR-090↔ADR-091 wire-up, landed `b502ebe`).
- E2E dogfood: `tests/e2e/epic-auto-merge.test.ts` (landed `d79840b`).

Schema additions reside entirely in ADR-090 (KanbanTask.role; KanbanEpic.epicTeamName/Root/prNumber/prState/note; Team.epicTeam block + superRefine). This ADR introduces no new schema fields.

### What breaks (nothing in v1)

Every change is additive. Existing teams (no `epicTeam` block) skip the cron line entirely (gated per §Triggers). Existing `merger_state` rows from ADR-134 intra-team scope coexist with epic-team rows in the same table — same string primary key namespace; no migration required.

The `dissolved` terminal state (§Decision-anchor #6) is NOT yet in the shared `BranchMergeState` enum at file-time of this ADR; until the enum extension lands, the wire-up at `b502ebe` reaches `merged + dispatchDissolved: true` and stops there. The follow-up Task that extends the enum + updates `MergerStateRepo` to accept the new literal lands as the §Decision-anchor #6 satisfaction commit.

### Rollback path

- Disable cron emission: set `team.epicTeam = undefined` in `team.json`; the cron-renderer skips the line on next install. Cron-install cleans up via the existing per-team block-rewrite path.
- Roll back the verb: uninstall the binary shipping `atmux epic-merge`; existing rows in `merger_state` survive (operators can SELECT them) but stop progressing. The schema fields (`KanbanEpic.epicTeamName/Root/...`, `KanbanTask.role`) shipped at ADR-090 T1 — they keep round-tripping cleanly.
- No data migration required either direction.

## Open questions

**Two carve-outs from §Out of scope (post-ship Tasks):**

- **§Decision-anchor #6 enum extension** — adding `dissolved` to `BranchMergeState` is additive but cross-cuts ADR-134's intra-team scope. The intra-team scope has NO `dissolved` terminal (the merger leaves rows in `merged` until the next member iteration). Decision: scope `dissolved` to epic-team rows only (via a runtime gate in `MergerStateRepo.transition` that refuses `merged → dissolved` for branch-names matching the `<base>-<member>` pattern, accepts for `<parentBase>-epic-<epicId>`). Alternative: introduce a per-row `scope` discriminator. Follow-up Task to decide.
- **§Decision-anchor #7 verb sugar** — `atmux epic advance <eid> --to in-progress` is the documented operator unblock path; verb sugar for the reverse transition lands in a follow-up Task.

**Class 3 audit carve-out** (per `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 3): multi-epic resource contention (N parallel epic-teams with concurrent auto-merge cron firing). Pre-shipped audit recommendation is the `cockpit_gh_lock` advisory row (§Decision-anchor #11) — for v1 auto-mode this is moot (no `gh` calls); for pr-mode runtime it's the load-bearing primitive. Stress test deferred to t-77ae2baa.

## Out of scope

- **Auto-merge impl** — shipped at `a34fafa` (t-04350614). ADR-091 documents the design those modules pin to.
- **ADR-090↔ADR-091 dispatch wire-up** — shipped at `b502ebe` (t-9a8b0e4e).
- **E2E dogfood gate** — shipped at `d79840b` (t-9d22718b).
- **`dissolve-epic` / `spawn-epic` verbs** — ADR-090 territory; shipped at `aac4ee1` (t-b430b185).
- **Cross-team `tell-lead`** — ADR-092 territory; forward-ref.
- **PR-mode runtime impl** — future ADR.
- **Auto-cage-spawn on spawn-epic** — operator-manual `cockpit rebuild` in v1; follow-up Task.
- **`atmux epic advance` reverse-transition verb sugar** — follow-up Task.
- **Multi-epic resource stress test (Class 3)** — post-dogfood, tracked at t-77ae2baa.

## §Amendment 2026-05-19 — Test-trust principle (fan-in trusts L1 verdict)

Driver finding 2026-05-19 06:30 MYT (operator: "make sure committers/gitters don't deploy… make sure they understand that if they are merging that means tests are already passing because the epic-team has already done the merge earlier and has run tests"). The test-gate-once doctrine was implicit in this ADR's design — the `dispatchDissolve` hook fires on `merging → merged` straight from the merge step, never running a parent-side test gate. Making it **explicit** in the ADR body prevents future drift where a parent fan-in tick grows its own `bun test` invocation.

**Doctrine** — tests run **once** at the layer they're authoritative for; the parent fan-in (this ADR's scope) **trusts the epic-team's intra-team test verdict** rather than re-running:

1. **Layer 1 — intra-team merger** ([ADR-134](134-in-team-auto-merger.md)): when an epic-team member's branch merges back to the epic-team's own `<parentBase>-epic-<epicId>` trunk, the `team.json::autoMerge.testCommand` (default `bun test`) fires at `merging → tested`. This is the SOURCE-of-truth test layer for that branch's content — the merge state machine refuses `tested → merged` until the test outcome is recorded.
2. **Layer 2 — epic-team fan-in** (THIS ADR's `performEpicMerge`): when the epic-team's trunk fans into the parent's base, the default `team.json::epicTeam.testGateMode = "skip"` (per [ADR-144](144-epic-team-test-gate.md) §Amendment 2026-05-19) means the state machine transitions `ready_to_merge → merging → merged` directly, **without invoking a test hook**. Tests already passed at L1; re-running would be wasteful (same suite, same SHA) and flake-prone (a flake passes once at L1 + fails on retry at L2 → false-fail revert wedge).
3. **Escape hatch** — `testGateMode: "cage"` or `"deployed"` (config-flip in `team.json::epicTeam`) opts in to a parent-side re-test for the rare case where the epic-team's L1 tests were knowingly incomplete (e.g. skipped flake, partial coverage on a fast-moving epic). Operator-driven, not auto-fired.

**Reviewer surface** — if a committer or epic-merge code path is observed re-running tests on a default fan-in (no `testGateMode` override in `team.json`), file `atmux flag add --severity high --subject "[committer/epic-merge] re-test on default fan-in violates ADR-091 §Amendment 2026-05-19 + ADR-144 §Amendment 2026-05-19"`. Brief carrier: [`templates/briefs/committer.md`](../../templates/briefs/committer.md) §Test-trust principle + §Hard rules (both modes).

**Filed via** t-afcc71af (P1 doctrine clarification, 2026-05-19).

## Cross-references

- [ADR-018](018-per-team-tmux-socket-isolation.md) — per-team tmpdir; epic-team's nested `/tmp/atmux-<parent>/epics/<epicId>/` re-uses this primitive (ADR-089 §Pillar 1).
- [ADR-032](032-socket-pubsub-messaging-layer.md) — socket-pubsub; primary event-driven trigger is forward-ref to this layer (cron-backstop ships v1).
- historical decision number 076 (no surviving ADR file) — state.db is canonical; `merger_state` table lives here.
- [ADR-082](082-worktree-isolation-per-member.md) — per-member worktree primitive; HARD CONFLICT carve-out at epic-team scope per ADR-090 §Decision-anchor #3.
- [ADR-084](084-worktree-per-member-branch-model.md) — per-member-branch model; per-member intra-team is ADR-134's scope, epic-team is THIS ADR's scope.
- [ADR-087](087-atmux-stop-soft.md) — soft-stop primitive; consumed by `dissolve-epic` (ADR-090) which this ADR's dispatchDissolve hook invokes.
- [ADR-179](179-per-member-branch-fan-in.md) — per-member-branch fan-in; sibling pattern at intra-team scope, primitives shared.
- [ADR-089](089-hierarchical-cockpit.md) — recursive `Cockpit.sessions[]`; the cron emission ground-truth depends on the cockpit walk finding the epic-team session entry.
- [ADR-090](090-epic-team-lifecycle.md) — epic-team lifecycle (TeamEpic schema + roster + spawn-epic + dissolve-epic verbs). This ADR consumes ADR-090's schema fields verbatim; ADR-090's §Decision-anchor #5 defines the EPIC-done gate THIS ADR fires on.
- [ADR-092](092-cross-team-tell-lead.md) — cross-team tell-lead + caller-scope gate; the SECOND-line conflict surface ships when ADR-092 lands.
- [ADR-134](134-in-team-auto-merger.md) — intra-team auto-merger; SIBLING pattern at one nesting level lower. Shared `branch-merge-state.ts` module + shared `MergerStateRepo` table.
- [ADR-145](145-atmux-adopts-gitter.md) — gitter pattern; the epic-team's gitter operates the same way at smaller scope, with the trunk-merge step delegated to this ADR's auto-merge cron.
- [ADR-148](148-commit-cadence-truth-signal.md) — commit-cadence ground-truth signal; the `reviewer-trunk-signoff` filing references this for the epic-team's velocity check.
- Driver-inbox 14:03 MYT 2026-05-13 §Pillar 3 + §Open call #3 (resolved: epic-team-scoped gitter) + §Open call #5 (resolved: fast-mode EPIC-done).
- `.atmux/reviewer-preflag-ADR089-091.md` §ADR-091 (8 anchors).
- `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 1 (3 state-machine recs) + §Class 3 carve-out (multi-epic stress).
- Impl commits: `7da4e85` (t-b5f12ab1 — shared state machine), `a34fafa` (t-04350614 — caller wrapper + verb + cron), `b502ebe` (t-9a8b0e4e — dispatchDissolve wire-up), `d79840b` (t-9d22718b — e2e dogfood).
- Project [CLAUDE.md](../../CLAUDE.md) §Testing Discipline (trunk-signoff test-coverage gate per §EPIC-done definition) + §Docs Discipline (same-commit doc updates) + §Push Policy (epic-team `<parentBase>-epic-<epicId>` branches fall under `<dev>-staging` shape).


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
