# ADR-014: Auto-dispatch depth guard + createdFrom audit trail

**Status**: accepted
**Date**: 2026-04-26

## Context

`atmux::finish_task_done` auto-mints commit-Tasks (gitter) and summary-Tasks (lead) when a parent Task closes. Existing recursion guards:

1. **Subject regex** — `^(commit|merge|persist) ` skips auto-dispatch (E1/S4-followup, t-15226e79).
2. **Assignee+lane gate** — `gitter` owner + `misc` lane skips auto-dispatch (E1/S4-followup-3, t-1ff87709).

Both are heuristics. A future task class that legitimately needs commit-flavored work but escapes both filters (e.g. a planner-authored REVIEW-lane task that itself triggers a commit-Task) would re-enter the dispatch chain indefinitely. Today's chains terminate at depth 1–2 organically; nothing prevents an unbounded chain from accidentally landing.

## Decision

**Defense-in-depth depth counter.** `ATMUX_DISPATCH_DEPTH` env var passes through atmux subprocess invocations. `atmux::finish_task_done`:

1. Reads `ATMUX_DISPATCH_DEPTH` (default `0`).
2. Computes `new_depth = current + 1`.
3. **Refuses** to mint commit/summary Tasks when `new_depth ≥ 3` — `atmux::warn` + Discord notice (rate-limited per parent), kanban write aborts the auto-dispatch branch only (status → done still lands; just no child task).
4. **Mints** with `.createdFrom = {parentTaskId, depth: new_depth}` audit field on each minted task. Field is queryable via `atmux task show <id> --json`.
5. Sets `ATMUX_DISPATCH_DEPTH=new_depth` in env passed to spawned subprocesses (mostly belt-and-suspenders; cross-process chains via tmux send-keys have their own session boundary).

**Threshold = 3.** Depth 1 = direct mint at parent done (commit + summary). Depth 2 = mint-of-mint (e.g. summary-of-commit, abnormal but conceivable). Depth ≥ 3 is genuinely never legitimate; treat as a guarantee.

## Consequences

- **BE (T2.3):** lib/kanban.sh atmux::finish_task_done grows depth read + `.createdFrom` filter clause + refuse-on-cap branch.
- **TEST (T2.4):** tests/unit/dispatch_depth.bats covers depth-0/2 mint, depth-3 refuse, `.createdFrom` round-trip.
- **Existing guards remain.** The subject regex and assignee+lane gate are still the *primary* recursion cutoff; depth is the *backstop*. If depth fires, that's a signal to investigate why the heuristics missed it.
- **Audit trail:** `.createdFrom` makes `atmux task show` self-explaining for auto-dispatched tasks. Future debugging of recursion bugs can follow the parentTaskId chain.
- **Rollback:** trivial — remove the depth read + cap branch + audit field. Existing heuristics still cover the observed cases.

## Open questions

1. **Should `.createdFrom` shape include lane/owner of parent?**
   *Resolved (planner default, low-reversibility):* No — `parentTaskId` is enough for `atmux task show` to follow the chain. Including more denormalises and rots if parent is later edited.

2. **Threshold = 3 or 5?**
   *Resolved (planner default, low-reversibility, see d-?):* 3. Driver-suggested. Depth 3 has never legitimately occurred in the project's history; bumping to 5 just delays detection of a recursion bug. Tune via ADR amendment if a legitimate depth-3 chain ever emerges.
