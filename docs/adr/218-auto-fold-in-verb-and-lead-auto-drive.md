# ADR-218: `atmux team auto-fold-in` verb + lead-role auto-drive + sweep-epics chaining — closes the SAFE-DISSOLVE-to-merged gap

**Status**: proposed
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 sopx observation — 12-branch backlog of epic-team branches that the [ADR-170](170-sweep-epics-verb.md) classifier had verdict-stamped SAFE-DISSOLVE for hours, but no automation drove the fold-in. Operator had to hand-run merge + dissolve per branch to clear the backlog. Filed via Epic `e-46f7fd64`.
**Cross-refs**: [ADR-091](091-kanban-driven-auto-merge.md) (auto-merge state machine — substrate), [ADR-134](134-in-team-auto-merger.md) (in-team auto-merger — merge primitive this ADR re-uses), [ADR-170](170-sweep-epics-verb.md) (sweep-epics classifier — verdict source that this ADR chains FROM), [ADR-090](090-epic-team-lifecycle.md) §`dissolve-epic` (post-merge teardown — chained INTO), [ADR-137](137-merge-over-rebase.md) (merge convention — `git merge`, never rebase), [ADR-197](197-cron-reaper-teardown-contract.md) (cron-strip inherited via the dissolve-epic teardown hook), [ADR-210](210-eliminate-hold-posture-deadlock-structurally.md) §Tier 1 (lead bootstrap doctrine — same "act on what's already classified" theme).

## Context

`atmux team sweep-epics` (per ADR-170) classifies idle epic-team branches into three buckets:

- **SAFE-DISSOLVE** — all child tasks `done`, working-tree clean, HEAD ahead of `<parentBase>`, `reviewer-trunk-signoff` Task in `done`. The merge would succeed; the dissolve would be clean.
- **RISKY** — partial criteria; one or more invariants fail. Operator review required.
- **DRAIN** — branch has uncommitted work or in-progress kanban Tasks; not a candidate.

`sweep-epics` (read-only) prints the classification; `sweep-epics --apply` (per ADR-170 §"Out of scope" + driver-deferred) is explicitly NOT-auto-cron-fired in v1. That stance is correct for the *cadence* concern, but it conflates two questions:

1. **Should sweep-epics auto-fire periodically?** — ADR-170's deferral applies (operator-judgment, not policy).
2. **Once sweep-epics has SAFE-DISSOLVE-classified a branch, should the fold-in (merge + dissolve) happen without operator-by-operator manual action?** — this ADR's question; orthogonal to #1.

### 2026-05-21 sopx incident

12 epic-team branches accumulated SAFE-DISSOLVE verdicts overnight. Each represented an already-merged-conceptually-but-not-yet-merged-into-trunk Epic. The lead pane saw the verdicts surface in `atmux outbox` / `atmux team sweep-epics` output but had no instruction to act on them; the verdict was a notification, not a command. Operator manually ran the 12-branch merge + dissolve loop in the morning (~30 min of operator-cycles per their note).

The gap: **verdict-without-action**. The classifier did the hard work (the *judgment*); the remaining work is mechanical (the *execution*) but had no owner.

### Why now, not in ADR-170

ADR-170 deliberately scoped to the classifier + manual-apply path. The auto-apply path was punted because:
- The MERGE primitive ([ADR-134](134-in-team-auto-merger.md) in-team auto-merger) was already automation-eligible but stayed manual-trigger in early ADR-091 deployments to build operator confidence.
- The DISSOLVE primitive ([ADR-090](090-epic-team-lifecycle.md) §`dissolve-epic`) was new; chaining auto-dispatch into it carried a "what if dissolve gets it wrong" tail risk.

Both primitives have since stabilized (ADR-134 + ADR-091 fan-in shipped + dogfooded; dissolve-epic shipped + dogfooded). The remaining concern is the chaining policy + the orchestration verb — this ADR's territory.

## Decision

### §D1 — NEW verb `atmux team auto-fold-in <branch>`

```
atmux team auto-fold-in <branch> [--dry-run] [--skip-classifier-recheck]
                                  [--test-gate <auto|skip>]
```

Single-command fold-in for a SAFE-DISSOLVE-classified epic-team branch. Sequence:

1. **Classifier recheck** (idempotency guard). Re-runs the ADR-170 classifier against `<branch>` at invocation-time. If the verdict has drifted away from SAFE-DISSOLVE (e.g. a sibling fan-in landed mid-flight, new task spawned), refuse with the drifted verdict in stderr. Skip via `--skip-classifier-recheck` if the operator already has a fresh verdict in hand. Default: recheck (safer).
2. **Test gate** (per ADR-091 §state-machine). Runs the team's `autoMerge.testCommand` against the epic-team's worktree if `--test-gate auto` (default) and the team's `team.json::autoMerge.testGate !== false`. Refuses fold-in on test fail; preserves the worktree + branch for operator triage. `--test-gate skip` bypasses (operator-explicit; logged).
3. **Merge** (per ADR-137 — `git merge`, never rebase). Inherits ADR-091 §state-machine semantics: `ready_to_merge → merging → merged`, durable conflict-surface via `merger_state.note` if conflict, transactional `BEGIN IMMEDIATE` per ADR-091 §Decision-anchor #1.
4. **Dissolve** (per ADR-090 §`dissolve-epic`). Inherits ADR-197 cron-reaper teardown hook → orphan-cron-block strip lands as part of dissolve.
5. **Close-out receipt**. Emits a single Discord pulse per ADR-086:
   ```
   🟢 [auto-fold-in] <team>/<branch> — merged into <parentBase> at <SHA> + dissolved
      tests: <pass/skip/N tests> · merge: clean · dissolve: clean
      cron-strip: <N blocks reaped via ADR-197>
   ```

`--dry-run` walks steps 1-2 and prints the plan + classifier verdict + test-gate disposition without firing the merge/dissolve. Useful for operator preview when running the verb manually.

### §D2 — `sweep-epics --apply` chains into `auto-fold-in`

`atmux team sweep-epics --apply` (per ADR-170) classifies + applies. The current §D explicitly defers the auto-fire cadence (per ADR-170 §"Out of scope"). The CHAINING behavior is independent:

- Today: `sweep-epics --apply` calls `dissolve-epic` directly on each SAFE-DISSOLVE candidate. NO merge step. Lose the merge if upstream operator forgot to merge first.
- Post-this-ADR: `sweep-epics --apply` calls `auto-fold-in <branch>` for each SAFE-DISSOLVE candidate. Merge + dissolve land together. Atomic at the verb-layer; not atomic at the kanban (each branch processed in sequence; failure on branch N stops the chain so operator sees the failure rather than masking it under N+1).

This change makes the existing `sweep-epics --apply` verb significantly more useful for the multi-branch backlog case (the 2026-05-21 sopx 12-branch scenario).

### §D3 — Lead-role auto-drive on SAFE-DISSOLVE

Per ADR-210 §Tier 1 (kanban-first dispatch), the lead bootstrap already shifted from "wait for planner" to "act on what's already classified". This ADR extends the same doctrine to sweep-epic verdicts:

When `atmux outbox` / `atmux team sweep-epics` surfaces SAFE-DISSOLVE branches, the lead's bootstrap loop (templates/briefs/lead.md §Your loop) gains a new sub-step:

```
After step 2 (kanban-first dispatch) but before step 5 (watch shared state):

2.5 SAFE-DISSOLVE fold-in: if `atmux team sweep-epics --json` returns
    SAFE-DISSOLVE candidates, dispatch `atmux team auto-fold-in <branch>`
    per branch (sequential, fail-fast on first error so operator can see
    the failure). One verb call per branch — same idempotency guarantees
    as §D1 (classifier recheck, test-gate, merge, dissolve).
```

The lead is the orchestrator (per CLAUDE.md role split — lead doesn't write code, but it DOES route mechanical work). `auto-fold-in` is mechanical; the classifier already did the judgment. Lead dispatches without operator approval per SAFE-DISSOLVE branch, but emits the §D1 close-out receipt to Discord so operator-visibility is preserved.

If the lead is offline / rate-limited / in budget-pause, the chain doesn't run. That's a feature, not a bug — operator's manual `sweep-epics --apply` path still works via §D2.

### §D4 — Safe-skip — when auto-fold-in REFUSES

`auto-fold-in` refuses (exit 1) on any of:

1. Classifier recheck flips away from SAFE-DISSOLVE — verdict drifted; surface the new verdict; let operator decide.
2. Test gate fail — `autoMerge.testCommand` returned non-zero; preserve the worktree for triage.
3. Merge conflict — durable conflict-surface per ADR-091 §Decision-anchor #2; `merger_state.note` carries the SHA + first-N conflict paths.
4. Dissolve precondition fail — e.g. cockpit-state-vs-disk-state mismatch from a partial earlier teardown; surfaces the dissolve-epic error verbatim.
5. Concurrent fold-in in flight against the same branch — per-branch advisory lock at `~/.atmux/state/auto-fold-in-<branch>.lock` (atomic write per ADR-005); refuse if lock present.

Refusals never partial-mutate. Step 3 (merge) only fires after steps 1+2 pass; step 4 (dissolve) only fires after step 3 returns merged. If step 3 conflicts, step 4 doesn't fire. If step 4 fails after step 3 succeeded, the merge stays (trunk has the work; operator can re-run `dissolve-epic` manually).

### What we give up

- **Per-branch operator pause for review.** The §D3 lead auto-drive fires per-branch without operator approval (SAFE-DISSOLVE is the approval gate). Mitigation: §OQ1 default-opt-in for v1; configurable to default-opt-out via `team.json::autoFoldIn.enabled = false`. Operator who wants the old "verdict-without-action" posture sets the flag.
- **Test-gate cost on every fold-in.** Step 2 runs the team's testCommand per fold-in — for a 12-branch backlog, that's 12 test runs. Mitigation: `--test-gate skip` for operator manual sweeps when they've already verified the test suite on the parent base. Lead auto-drive (§D3) never skips the gate.
- **Discord pulse cardinality.** §D1 close-out receipt fires per fold-in. A 12-branch sweep emits 12 pulses. Acceptable — operator observability of the auto-drive is the explicit goal; rate-limiting batcher (ADR-019 / ADR-086) absorbs the burst.

### Rollback path

If auto-fold-in proves too aggressive:

1. **Per-team disable**: `team.json::autoFoldIn.enabled = false` skips §D3 lead auto-drive. `sweep-epics --apply` chaining (§D2) stays on (operator explicitly opts in by passing `--apply`).
2. **Per-call disable**: `auto-fold-in --dry-run` is the safer manual path.
3. **§D2 revert**: file ADR-218a to revert `sweep-epics --apply` to call `dissolve-epic` directly (no merge step). Loses the value of this ADR but restores ADR-170's exact pre-change semantics.

## Sub-tasks (decomposed by planner; impl Tasks land downstream)

- **T1** — ADR-218 draft (this file). Lane=`misc`, deps=none, priority=1. (← *this Task is t-c9e5a86f*)
- **T2** — `src/verbs/team/auto-fold-in.ts` — verb impl per §D1. Same-commit unit tests covering classifier-recheck refuse, test-gate refuse, merge-conflict refuse, dissolve-error path, lock-contention refuse. Lane=`be`, deps=T1, priority=1.
- **T3** — Chain `sweep-epics --apply` into `auto-fold-in` per §D2. Same-commit unit test for the multi-branch sequential fail-fast behavior. Lane=`be`, deps=T2, priority=1.
- **T4** — Lead bootstrap auto-drive per §D3 (templates/briefs/lead.md new step 2.5). Same pattern as ADR-210 Tier 1 — brief edit only; the verb does the work. Lane=`misc` (docs), deps=T2, priority=2.
- **T5** — Discord template + close-out receipt format per §D1 step 5 + §D4 refuse paths. Lane=`be`, deps=T2, priority=2.
- **T6** — Per-branch advisory lock (`~/.atmux/state/auto-fold-in-<branch>.lock`) atomic-write + cleanup-on-exit. Same-commit unit test for concurrent-call refuse. Lane=`be`, deps=T2, priority=2.
- **T7** — e2e integration — synthetic 3-branch backlog fixture walks classifier → auto-fold-in chain → trunk-state assertion. Lane=`test`, deps=T2+T3, priority=2.
- **T8** — Docs sweep: CHANGELOG entry, RUNBOOK-epic-teams.md update (auto-fold-in section), ADR-170 cross-link + §Amendment noting §D2 chaining, ADR-091 §Amendment if state-machine semantics shift. Status flip to `accepted` lands here once T2-T7 ship. Lane=`misc` (docs), deps=T2+T3+T4+T5+T6+T7, priority=3.

## Open questions

1. **(LOW reversibility) Default-enabled vs opt-in for §D3 lead auto-drive**: enable-by-default OR require operator opt-in via `team.json::autoFoldIn.enabled = true`? Recommend **default-enabled** in v1. Reasoning: SAFE-DISSOLVE is by definition the safest classification; if the operator didn't want auto-drive on safe-by-construction branches, they wouldn't be running `sweep-epics` in the first place. Operators with conservative tolerance can flip to opt-out via the flag. If the empirical false-positive rate (auto-drive on a branch that operator wanted to inspect first) exceeds 1% in observation, flip the default in a follow-up ADR-amendment.

2. **(MEDIUM reversibility) Test-gate integration honoring ADR-091**: should `auto-fold-in` always re-run the test gate, or trust ADR-091's per-Task `reviewer-trunk-signoff` Task as the gate-of-record? Recommend re-run by default + skip via `--test-gate skip`. Reasoning: ADR-091's reviewer-trunk-signoff is a *historical* gate (verified at the time of signoff); `auto-fold-in` is a *current* gate (re-verifies against the current code state). The current gate catches drift between signoff and fold-in (e.g. a sibling fan-in landed mid-flight that broke an invariant). Cost is one test run per fold-in; acceptable. Operator who trusts the signoff alone sets `team.json::autoMerge.testGate: "trust-signoff"` (new config; v2 if needed).

3. **(LOW reversibility) Per-branch advisory lock storage**: `~/.atmux/state/auto-fold-in-<branch>.lock` OR `merger_state.lock_holder` column in the team's state.db? Recommend filesystem lock per ADR-005 atomic-write convention. Sibling pattern to other atmux short-lived locks; SQLite advisory locks are overkill for a single-process-at-a-time invariant.

4. **(LOW reversibility) Fail-fast vs continue-on-error in §D2 multi-branch chain**: `sweep-epics --apply` against a 12-branch backlog hits a conflict on branch 5 — stop the chain OR continue with branches 6-12? Recommend stop the chain. Reasoning: conflicts are operator-judgment events; cascading 7 more pulses while operator is debugging the first one is noise. Operator re-runs `sweep-epics --apply` after triaging branch 5. The `--continue-on-error` flag is reserved for future use if empirical operator preference flips.

5. **(MEDIUM reversibility) Interaction with ADR-091's auto-merger cron**: ADR-091's auto-merger cron (`atmux committer --sweep`) already does merge-on-Task-done within a single epic-team's per-member branches. This ADR's `auto-fold-in` operates one level UP — merging the epic-team-base branch into the PARENT team's trunk. No overlap in scope; the two verbs operate on different layers. Document this in T8 docs sweep to prevent operator confusion.

## Cross-refs

- [ADR-091](091-kanban-driven-auto-merge.md) (auto-merge state machine — substrate; §Decision-anchor #1 + #2 + #4 inherited).
- [ADR-134](134-in-team-auto-merger.md) (in-team auto-merger — merge primitive this ADR re-uses at the parent-trunk layer).
- [ADR-170](170-sweep-epics-verb.md) (sweep-epics classifier — verdict source; §D2 chains FROM `--apply`).
- [ADR-090](090-epic-team-lifecycle.md) §`dissolve-epic` (post-merge teardown — chained INTO).
- [ADR-137](137-merge-over-rebase.md) (merge convention — `git merge --no-edit`, never rebase).
- [ADR-197](197-cron-reaper-teardown-contract.md) (cron-strip inherited via the dissolve-epic teardown hook).
- [ADR-210](210-eliminate-hold-posture-deadlock-structurally.md) §Tier 1 (same "act on what's already classified" doctrine; this ADR extends to sweep-epic verdicts).
- [ADR-086](086-atmux-pulse.SUPERSEDED.md) (Discord template vocabulary — `[auto-fold-in]` follows the verdict-first pattern from §D1 step 5).
- Epic `e-46f7fd64` (parent — this ADR is its T1 anchor; T2-T8 above).
- 2026-05-21 sopx 12-branch backlog incident (driver-ref).
