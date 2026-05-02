# ADR-013: Kanban write atomicity — flock protocol enforcement

**Status**: accepted
**Date**: 2026-04-26

## Context

2026-04-26 17:46 MYT: driver flagged a phantom commit-Task `t-b29b5322` sitting in gitter's `inProgress` for 222 min. The Task did not exist in `kanban.tasks[]`. Whip's stale-task heuristic flagged it every 5 min indefinitely. Pre-existing recursion gates (commit/merge/persist subject regex; gitter+misc lane) did not catch it because it WAS a legitimate commit-Task — just one whose kanban entry had been clobbered.

Root cause discovered during decomp: `atmux::jq_update` (lib/common.sh:310) acquires an `flock` on `<file>.lock` for atomic JSON mutation. But ten call sites across `lib/dispatch.sh`, `lib/claim.sh`, `lib/cleanup.sh`, `lib/epic.sh`, `lib/story.sh`, `lib/kanban.sh` use the bare `jq … > tmp && mv tmp file` idiom **without** the lock. Race scenario:

1. Process A: `atmux::finish_task_done` calls `atmux::jq_update` → acquires flock, appends commit-Task to `kanban.tasks[]`, releases flock.
2. Process B: a bare `jq … > tmp && mv tmp kanban.json` (e.g. `_atmux_task_rm`, `_atmux_task_assign`) had already read kanban.json *before* step 1 wrote, then `mv`s its stale tmp on top → A's commit-Task evaporates.
3. Process A then calls `_atmux_kanban_push_inbox` → reads the (now clobbered) kanban, `task_json` lookup returns empty, BUT — pre-fix — the inbox push had already happened in some legacy paths *before* the kanban-side mutation, leaving the inbox entry with no kanban backing.

(The exact A/B interleaving that produced `t-b29b5322` is not reconstructable from logs, but the family of races is the issue. The phantom is a sentinel; the bug class is broader.)

## Decision

**Every mutation of shared JSON state in `lib/` routes through `atmux::jq_update` (or `atmux::with_lock`).** Bare `jq … > tmp && mv` patterns are forbidden on shared files. The forbidden set is enumerated as **6 per-file Tasks in S1** (one commit per site for fast bisect, per driver constraint 2026-04-26 18:?? MYT addendum): lib/dispatch.sh, lib/claim.sh, lib/cleanup.sh, lib/epic.sh, lib/story.sh, lib/kanban.sh. The reviewer's signoff (S1 REVIEW Task) verifies post-sweep coverage via independent grep + negative-space proof.

**Atomicity ships in S1, not S2.** Re-shaped from initial decomp per driver: S1 = bug-fix-now-please for myteam-alpha exposure (atomicity + B1/B2/B3); S2 = broader refactor (depth guard + jq --arg + inbox cap). Both Stories ship in the same Epic-end promote bundle.

**Per-file flock granularity is sufficient.** Cross-file transactional writes (e.g. updating `kanban.json` and `inbox/<member>.json` atomically together) are explicitly out of scope. atmux's load profile (single-host, ~10 concurrent processes max) does not justify a global lock. Per-file locks at every site close the observed leak.

**Phantom cleanup safety net** lives in two places: `lib/whip.sh` per-tick auto-prune (T1.1) and `lib/doctor.sh --fix` (T3.1). The shared definition (`atmux::find_phantom_inbox_ids`) is in `lib/common.sh` so both consumers agree on what counts as a phantom.

## Consequences

- **BE (T2.1):** ten call sites grow `atmux::jq_update` invocations. Mechanical diff; no semantic change.
- **BE (T1.1):** new helper `atmux::find_phantom_inbox_ids()` in `lib/common.sh` — pure function, returns JSON array.
- **TEST (T2.2):** `tests/unit/atomicity.bats` exercises 20 concurrent writers — proves no lost writes.
- **REVIEW (T2.8):** signoff verifies zero remaining bare `jq+mv` on shared state via independent grep.
- **Performance:** flock acquisition adds ~µs per write. Negligible vs jq parse cost.
- **Rollback:** revert T2.1 commit. The bug class returns; phantom-detector safety net (T1.1, T3.1) still mops up damage.

## Open questions

1. **Should atmux mutate any other shared state besides JSON?**
   *Resolved (planner default, low-reversibility):* in scope for THIS ADR — JSON only (kanban.json, inbox/*.json). Adjacent classes (decisions.md ledger, *.epoch cursor files, MD inboxes) are NOT in scope here; reviewer T2.8 enumerates them but doesn't gate on them. Folloup ADR if any of those classes show contention symptoms.

2. **Cross-file atomicity (kanban + inbox written together)?**
   *Resolved (planner default, low-reversibility):* deferred. Per-file flock closes the observed bug. Cross-file transactions would need a top-level `atmux::with_lock kanban.json _do_dispatch …` pattern at every multi-file boundary; high-cost-per-call-site, low-incremental-safety. Revisit if a future bug requires it.
