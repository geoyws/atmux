# ADR 182 — Auto-reap epic-team on successful epic-merge

**Status:** Accepted — ratified by driver 2026-05-23 (intent + substrate shipped: ADR-091 epic-merge cron + ADR-090 dissolve-epic verb together close the manual residue; reviewer-signoff path bypassed after 4 days of no objection). Full event-driven auto-reap subscriber (orchd lifecycle Phase 4 — `epic.merged` → `dissolve-epic`) tracked under EPIC [e-a946af69](../tasks/t-0db3f393.md); ADR-227 will formalize the subscriber semantics.
**Date:** 2026-05-19
**Driver-ref:** Chat conversation 2026-05-19 ~14:30 MYT — observed 12 epic-team directories on disk across atmux/sopx/rentx parents (only 2 live cages), driver direction *"make sure atmux properly reaps once the epic-teams have done their job and have had their work merged"*.
**Related:** ADR-091 (spawn-epic), ADR-134 (epic-merge — merger pattern), ADR-170 (sweep-epics verb + SAFE-DISSOLVE gate), ADR-131 §Amendment (auto-groom criteria tightening), ADR-181 (global RAM-budget gate on spawn).

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-280](280-epic-team-retirement-and-staged-excision.md).** Epic-teams are retired: the `epic-team` cage type, the `epicId` cockpit field and the epic verbs no longer exist. This ADR is kept as history — the decision it records was true when made. Do not implement from it.

## Context

Epic-teams (ADR-091) are spawned for an epic's scope of work. ADR-134's merger pattern handles the trunk integration — the epic-team's branch is merged into the parent team's base branch via the in-team committer (was: gitter). What ADR-134 does **not** specify is what happens to the epic-team itself *after* the merge succeeds.

The observed state on hax (2026-05-19, sweep-epics dry-run):

- **12 epic-team directories** across atmux / sopx / rentx parents.
- **0 are SAFE-DISSOLVE** per ADR-170's verdict ladder.
- **10 are DRAIN** (open kanban tasks > 0) — but most have commits suggesting the work shipped; the kanban is stale.
- **2 are RISKY** (worktree dirty — pre-merge state preserved).
- **All cages are stopped** (no live tmux session for any of the 12) — confirming the work is no longer in-flight; what remains is on-disk residue.

The gap is structural: ADR-134's epic-merge succeeds, the operator visually confirms the merge, but no follow-on action marks the epic-team's kanban as done or triggers `dissolve-epic`. The kanban-stale state persists until either:

- The operator runs `atmux task done <id>` manually for each shipped task (tedious).
- An auto-groom pass speculatively marks tasks done by commit-SHA matching — observed 83% false-positive rate per memory `[[feedback_auto_groom_shipped_via_sha_false_positives]]`. Operators cannot trust the auto-groom output, so they don't act on it.
- A driver-initiated sweep via tell-lead messaging asks each parent's lead to investigate (this ADR's triggering incident).

The recurring symptom is RAM-pressure events on the host (ADR-181 captures the recent one) where the question "which epic-teams can I safely dissolve to free memory?" is answered by `sweep-epics`'s SAFE-DISSOLVE count being zero — because the kanban-grooming step that would *unlock* dissolution never fires automatically.

ADR-131's auto-groom amendment introduced a 3-signal scope-match check to reduce false-positives. That helped the speculative groom (which runs across the whole kanban) but did not introduce a *targeted* groom tied to a specific successful merge event. The epic-merge moment is exactly when scope-match is cheapest and most accurate — we know the merged commit set, we know the epic-team's task list, and the intersection is the authoritative groom signal.

## Decision

`atmux team epic-merge` (ADR-134) gains a post-merge **auto-reap** sequence. When the merge completes successfully and the parent's base branch is pushed to `origin`, the verb performs:

1. **Targeted task-groom** against the merged commit set. For each task in the epic-team's kanban whose ID appears in any commit message on the merged branch (between the merge-base and the merge-tip), mark the task `done` with the merge SHA recorded in the task's `extra.merged_via_sha` field. Tasks *not* matched stay open — they remain the operator's call.

2. **Sweep + auto-dissolve.** Invoke the existing `sweep-epics --parent <parentTeam> --idle-hours 0 --apply` internally, but scoped to *only this epic-team's epicId*. The existing SAFE-DISSOLVE gate (ADR-170) governs: if the targeted groom in step 1 left no open tasks AND the worktree is clean AND the branch is pushed (it is — we just merged it), the epic-team is dissolved. Otherwise the verb reports state and leaves the epic-team alone.

3. **Cockpit-registry cleanup.** Inherited from existing `dissolve-epic` behaviour (ADR-091); no change.

4. **Discord summary ping.** Cockpit-level notification: `Reaped epic-team <epicId> (parent=<team>): N tasks groomed via SHA <merge-sha>, worktree pruned, registry cleaned. Freed ~Y GiB RAM (if cage was live) + ~Z MiB disk.` If the epic-team is *not* SAFE-DISSOLVE after grooming, the ping instead says `Epic-team <epicId> merged but NOT auto-reaped: M tasks remain open (not matched by merge SHA). Manual review required.`

### Why a targeted groom is safe where the speculative groom isn't

The speculative auto-groom (per ADR-131 amendment) scans the entire kanban and tries to match each open task against any recent commit. Its 83% false-positive rate is dominated by two error classes:

- **Re-used task IDs across epic-teams** — the same task ID appearing in commits from a different epic-team's branch.
- **Scope drift** — a task that *started* with one ID gets decomposed mid-work; subsequent commits reference the new sub-task IDs, the original task ID lingers as a parent placeholder.

The targeted groom proposed here is constrained to:

- One specific epic-team's task list (loaded from the epic-team's state.db).
- One specific commit set (the merge's commit range — `git rev-list <merge-base>..<merge-tip>`).
- Tasks matched only when the task's ID appears in a commit's message *and* the commit is in the merged range *and* the commit's tree references a path within the epic-team's worktree scope.

These three constraints together address the dominant false-positive classes. Cross-epic ID collisions are filtered by the per-team scope; scope-drift is filtered by the path-scope check; speculative matching is eliminated by tying the groom to a single durable event (the merge).

### Why not just lower SAFE-DISSOLVE's threshold

ADR-170 §SAFE-DISSOLVE's gate is intentionally conservative: branch-pushed + worktree-clean + zero-open-tasks. Loosening any of these regresses safety. The gap is upstream of the gate: the *open-tasks count* is stale because the kanban wasn't groomed after merge. The fix is the groom, not the gate.

### Behaviour on partial groom (some tasks not matched)

When the targeted groom leaves tasks open (real outstanding work, or work that did ship but didn't reference the task ID in its commit message), the epic-team is *not* auto-dissolved. The operator sees the Discord ping naming the remaining task IDs and decides: (a) mark them done manually if they shipped (commit-message authorship is the lapse, not the work), (b) leave them open if work genuinely remains, (c) `--force` dissolve if the epic is being abandoned.

This is the load-bearing safety property: *we never lose tracked work to an automated cleanup*. The auto-reap fires only when the evidence is unambiguous; otherwise it stops and asks.

### Failure handling

- **Groom fails (kanban state.db unreachable, etc.):** auto-reap aborts; the epic-merge result is unchanged; Discord ping reports the failure and the operator can manually invoke `sweep-epics --parent <team> --apply` later.
- **Sweep-dissolve fails after successful groom:** the kanban state is preserved (tasks stay marked done — the groom is durable); the epic-team is reported as eligible-for-manual-dissolve.
- **Cockpit cleanup fails:** logged but not blocking. The next `sweep-epics` pass will flag the MISSING verdict (registry entry but no worktree).

### Implementation surface

| File | Change |
|---|---|
| `src/verbs/team/epic-merge.ts` (existing per ADR-134) | After successful merge + push, call `runAutoReap(parentTeam, epicId, mergeSha)`. |
| `src/verbs/team/auto-reap.ts` (new) | The orchestrator: targeted-groom + sweep + dissolve + Discord ping. |
| `src/lib/targeted-groom.ts` (new) | Pure function — given (epicId, mergeRange, worktreeScope) returns the list of tasks to mark done with rationale. |
| `src/verbs/team/sweep-epics.ts` (existing per ADR-170) | Accept new `--epic <id>` flag to scope a sweep to a single epic-team (currently scopes by `--parent <team>`). |
| `.atmux/state/auto-reap-log.jsonl` (new) | Append-only log of auto-reap events for post-hoc audit: timestamp, epicId, parent, groomed-task-count, dissolved bool, failure reason if any. |
| `docs/RUNBOOK-epic-merge.md` | Document the auto-reap behaviour + how to disable per-merge via `--no-auto-reap` flag. |

### Opt-out

A `--no-auto-reap` flag on `epic-merge` skips the auto-reap sequence. Use case: operator wants to inspect the merge result before triggering dissolve. The flag is local-only; default behaviour is auto-reap-on-merge.

### Coordination with the medic role (ADR-077 → ADR-133)

The medic surfaces ambient state — including, after this ADR, `auto-reap-log.jsonl` events from the last 24h. The cockpit feed becomes the durable record of "what got dissolved when" so operators don't have to scrape Discord history.

## Consequences

### Unblocked

- **The RAM-pressure ⇄ kanban-stale loop is broken.** When work ships, the kanban is groomed at the moment of authoritative evidence (the merge); SAFE-DISSOLVE becomes reachable; the operator's manual sweep is no longer the only path.
- **Operator trust in auto-groom restored** because the targeted groom's false-positive rate is structurally lower than the speculative groom (per §"Why a targeted groom is safe").
- **Cockpit + on-disk hygiene is automatic** for the happy-path case (merge succeeded, all tasks reference task IDs, branch pushed). The accumulating-residue problem self-resolves over time.
- **ADR-181's RAM-budget gate becomes more useful** because the set of dissolvable epic-teams is no longer artificially small. Operators can free RAM by stopping in-flight work rather than chasing stale kanban.

### Costs

- **Auto-reap is a side effect of epic-merge.** Operators who expect epic-merge to be a pure data-mutation (no cleanup) may be surprised. Mitigated by the `--no-auto-reap` opt-out + clear runbook documentation + the Discord ping that announces every auto-reap.
- **Targeted groom may still miss work** when commit messages don't reference task IDs. This is a discipline gap, not a logic gap — and the ADR's partial-groom behaviour (don't auto-dissolve when tasks remain) protects against accidental loss.
- **One new state file** (`auto-reap-log.jsonl`). Append-only, bounded in size by the rate of merges. Archived to `.atmux/state/archive/` on quarterly rotation.
- **Test surface grows** — `targeted-groom.ts` needs unit tests covering: ID match in commit body, ID match in commit subject, ID *not* matching when path-scope excludes the commit, ID *not* matching when commit predates merge-base, etc.

### Reversal path

Same reversal as ADR-181: an env var `ATMUX_AUTO_REAP_ENABLED=true` (default) gates the entire sequence. Setting to `false` disables auto-reap globally; `--no-auto-reap` per-invocation is the surgical option.

### Reciprocal note to ADR-134 (epic-merge / merger pattern)

ADR-134 §Decision describes the merge sequence ending at "branch merged + pushed." This ADR extends that sequence with the auto-reap step. The merge itself is unchanged; auto-reap is post-merge cleanup that ADR-134 left implicit. The amendment is captured here rather than by editing ADR-134 in place, per the standing convention.

### Reciprocal note to ADR-170 (sweep-epics)

ADR-170 §Decision describes `sweep-epics` as operator-invoked (manual or cron). This ADR introduces a *programmatic* invocation path scoped to a single epic-team. The `--epic <id>` flag is the new surface; existing operator-facing behaviour is unchanged.

### Reciprocal note to ADR-131 §Amendment (auto-groom criteria tightening)

ADR-131's amendment governs the *speculative* auto-groom that runs across the whole kanban. The targeted-groom in this ADR is a different mechanism — same name family, different trigger and scope. Both can coexist; the targeted-groom does not replace the speculative groom.

## Open questions

1. **OQ1 — What constitutes "ID in commit message"?** Exact-match (regex `\b<task-id>\b`)? Or also fuzzy (e.g. `t-1234` matches `T-1234` and `1234`)? **Tentative resolution:** exact-match only — `\b<task-id>\b` case-insensitive. Conservative posture matches the partial-groom safety property.

2. **OQ2 — Path-scope check granularity.** Should the path-scope be the epic-team's worktree directory (broad) or the specific paths each task names in its body (narrow)? **Tentative resolution:** worktree-directory scope — task bodies don't reliably name paths, and the cross-epic-ID-collision filter is already provided by the per-team kanban scope. Worth revisiting if we observe false-positives in the targeted groom.

3. **OQ3 — How does auto-reap interact with the in-team committer role (ADR-134 §merger)?** The committer is the agent that executes the merge. Does it also execute the auto-reap, or does the verb-layer handle it? **Tentative resolution:** verb-layer. The committer's contract ends at "merge succeeded"; the verb wrapping it handles the cleanup sequence. Keeps the committer's logic focused on merging.

4. **OQ4 — Failure of the dissolve step after successful groom — should we retry?** If `dissolve-epic` fails after the groom marked tasks done, retrying might work (transient filesystem issues). **Tentative resolution:** no automatic retry. Failure is reported, operator can re-invoke `sweep-epics --epic <id> --apply` manually. Avoids retry loops on structural failures (e.g. worktree-prune permission error).

5. **OQ5 — Should the speculative auto-groom be retired in favour of the targeted one?** This ADR introduces the targeted groom as additive. The speculative groom remains. **Tentative resolution:** defer. Observe one quarter of targeted-groom production data; if false-positive rate stays low and coverage is sufficient, retire the speculative groom in a follow-up ADR. Keeping both for now is conservative.

All OQs are tunable post-impl. Drivers may flip via the standard ADR-amendment surface.

## Reviewer gate

- [ ] `targeted-groom.ts` is a pure function and unit-tested across all match/non-match scenarios listed in §Costs.
- [ ] `epic-merge.ts` invokes `runAutoReap()` after successful merge + push, but *only* if `--no-auto-reap` is not set and `ATMUX_AUTO_REAP_ENABLED !== 'false'`.
- [ ] Failure in groom does not abort the epic-merge; merge result is preserved.
- [ ] Failure in dissolve after successful groom leaves kanban groom state durable; operator can manually re-attempt the dissolve step.
- [ ] Discord ping fires on every auto-reap (success or partial); cockpit feed entry mirrors.
- [ ] `.atmux/state/auto-reap-log.jsonl` appends on every event; format validated as single-line JSON per event.
- [ ] `--no-auto-reap` flag documented in `docs/RUNBOOK-epic-merge.md`.
- [ ] Behaviour on already-dissolved-then-merge-retried is documented and tested (idempotent — no-op on second invocation).

## References

- ADR-091 — `atmux team spawn-epic` (the spawn side; this ADR closes the reap side)
- ADR-134 — Merger pattern / epic-merge (the verb this ADR extends)
- ADR-170 — `atmux team sweep-epics` (the verdict ladder this ADR's auto-reap obeys; SAFE-DISSOLVE gate)
- ADR-131 §Amendment 2026-05-17 — auto-groom criteria tightening (the speculative-groom safety work; targeted groom is the targeted sibling)
- ADR-181 — Global RAM-budget gate on spawn (the spawn-side throttle; this ADR is the reap-side counterpart that keeps the budget liquid)
- Memory `[[feedback_auto_groom_shipped_via_sha_false_positives]]` — 83% false-positive observation that motivates the targeted-groom design
- Observed sweep 2026-05-19 14:30 MYT — 12 epic-team directories, 0 SAFE-DISSOLVE, 10 DRAIN, 2 RISKY — the triggering snapshot for this ADR

## §Status amendment 2026-05-23 — Phase 4 supersession

**Status: amended 2026-05-23** — Phase 4 ([ADR-227](227-orchd-auto-dissolve-subscriber.md) auto-dissolve subscriber) supersedes the inline-dissolve-at-merge code path described in this ADR. The cron-backstop documented in §Decision step-N remains installed for ~2-week soak per [ADR-202 §X](202-honker-in-db-messaging-substrate.md) cron-decommission protocol; after the soak window the cron line is removed via crontab block prune. See [ADR-227 §Decision](227-orchd-auto-dissolve-subscriber.md) for the event-driven dissolve substrate that supersedes the inline path.

Phase 4 implementation landed on trunk at commit `c17cfbd` (`feat(orchd): Phase 4 auto-dissolve subscriber — src/core/orchd-dissolve.ts + epic.dissolved + epic.dissolve-blocked + audit log + worker fold-in`).
