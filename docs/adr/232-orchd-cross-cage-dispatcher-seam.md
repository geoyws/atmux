# ADR-232: orchd cross-cage dispatcher seam — `dispatchEpicMerge` / `dispatchDissolveEpic` / `dispatchGitPush`

**Status**: proposed (deferred: full design lands post-merge of `origin/atmux-geoyws` once parent's ADR-226 'orchd auto-merge subscriber' + ADR-227 'orchd auto-dissolve epic-team subscriber' + ADR-229 'orchd auto-push' consumer-side handlers are visible on this branch; this stub captures the contract + ownership boundary so Story S0 Tasks can land impl against a named decision)
**Date**: 2026-05-23
**Driver-ref**: EPIC e-60e16169 Phase 2 — driver P0 scope-addition 2026-05-23 14:00 MYT (lead-outbox); parent kanban `t-7-5507954b` (cross-cage dispatcher scope-addition). Sibling EPIC e-a946af69 fan-in commit 8d75360 (0.8.13) shipped Phase 3/4/6 handler-side without dispatcher-side glue — local-only handlers return `skipped-not-mine` when the requested action targets a non-local cage; without dispatchers, the orchd dogfood loop fails on cross-cage events. This Epic owns the dispatcher half.
**Cross-refs**: [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) §D6 (Subscription registry seam — dispatchers compose with subscribers but live in `src/core/orchd-dispatch/` not `ORCHD_SUBSCRIPTIONS`), [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D7 (handler-as-data layout — dispatchers mirror the same pattern), parent ADR-226 (auto-merge subscriber — `dispatchEpicMerge` is its cross-cage transport), parent ADR-227 (auto-dissolve subscriber — `dispatchDissolveEpic` is its cross-cage transport), parent ADR-229 (auto-push — `dispatchGitPush` is its cross-cage transport), [ADR-202](202-honker-in-db-messaging-substrate.md) §IX-A (lean-dispatch contract — dispatchers reuse the same Bun-subprocess + tmux send-keys pattern for cross-cage RPC), [ADR-090](090-epic-team-lifecycle.md) §spawn-epic (cage discovery — dispatchers walk parent's cage list to find target).

## Context

Parent trunk shipped Phase 3 (`atmux orchd` auto-merge subscriber, ADR-226), Phase 4 (auto-dissolve epic-team subscriber, ADR-227), Phase 6 (auto-push, ADR-229) at commit 8d75360 (0.8.13 deployed 2026-05-23) via sibling EPIC e-a946af69. Each handler is local-cage-only: when the event's target action belongs to a non-local cage (e.g. Phase 3 merge handler receives a `task.done` for a task that lives in cage B while the handler runs in cage A), the handler returns `skipped-not-mine` and the action is dropped on the floor.

Without a dispatcher half, the orchd dogfood loop fails on the very first cross-cage event — driver cannot drive end-to-end orchestration validation. Phase 2 (this Epic) is now critical path: ship the dispatchers BEFORE the auto-spawn/dissolve loop so the dogfood passes.

Each dispatcher is a thin transport layer:

1. Resolve which cage owns the target action (via parent's cage registry / `atmux team list` walk).
2. If LOCAL — call the local implementation directly (performEpicMerge / dissolveEpic / GitSpawn push). No RPC overhead.
3. If REMOTE — dispatch the action to the target cage via ADR-202 §IX-A lean-dispatch (Bun subprocess + tmux send-keys to that cage's orchd pane, or per ADR-219 cockpit-mirror Rust crate if preferred).
4. Result: success → ack; failure → flag + return.

## Decision (skeleton — refined post-merge)

### D1 — Dispatcher names + source-of-truth files

| Dispatcher | Wraps | Source-of-truth | Consumed by parent ADR |
|---|---|---|---|
| `dispatchEpicMerge` | `performEpicMerge` from `src/core/epic-merge.ts` | local-cage merge logic | ADR-226 §auto-merge subscriber (Phase 3) |
| `dispatchDissolveEpic` | `dissolveEpic` factored from `src/verbs/team/dissolve-epic.ts` | local-cage team-stop pipeline | ADR-227 §auto-dissolve subscriber (Phase 4) |
| `dispatchGitPush` | `git push` via `GitSpawn` (`src/abstractions/git-spawn.ts`) | local-cage git push abstraction | ADR-229 §auto-push (Phase 6) |

`dissolveEpic` is factored OUT of `src/verbs/team/dissolve-epic.ts` (the CLI verb stays as a thin wrapper); the extracted pure function becomes the dispatch target. Same factoring pattern as `performEpicMerge` (already extracted per ADR-091).

### D2 — Cross-cage transport (deferred — design lands post-merge)

Two viable paths, both ADR-202-style:

A. Bun subprocess + tmux send-keys to target cage's orchd pane (mirrors ADR-202 §IX-A lean-dispatch contract verbatim).
B. Direct Rust call into target cage via ADR-219 cockpit-mirror crate (lower latency, requires cockpit-mirror as runtime dep).

Decision deferred to Story S0 impl review once the post-merge code visibility makes the perf trade-off concrete.

### D3 — `skipped-not-mine` is preserved (NOT removed)

Dispatcher does NOT modify parent's handlers. The "skipped-not-mine" branch stays in parent's 226/227/229 handlers as the FALLBACK guard (in case dispatcher fails to route AND local handler still fires). Dispatcher is the PRIMARY route; "skipped-not-mine" is the safety net.

## Consequences

- Three new files: `src/core/orchd-dispatch/epic-merge.ts`, `src/core/orchd-dispatch/dissolve-epic.ts`, `src/core/orchd-dispatch/git-push.ts` (subdirectory keeps cross-cage transport co-located).
- One factoring: `dissolveEpic` extracted from `src/verbs/team/dissolve-epic.ts` into `src/core/dissolve-epic.ts` (pure function; CLI verb becomes wrapper).
- No change to parent's handlers; pure additive layer on top.
- Cage-discovery dep on parent's `atmux team list` enumeration (already exists; no new substrate).
- TEST coverage: unit per dispatcher (local-route / remote-route / route-failure-flag); integration cross-cage smoke via two-cage harness.

## Open questions

1. **OQ-1: Transport choice — Bun subprocess + tmux send-keys (A) vs cockpit-mirror Rust direct (B)?** — deferred to Story S0 impl review (need post-merge perf data + parent ADR-219 maturity context).
2. **OQ-2: Should dispatcher emit observability events (`orchd.dispatch.routed.local` / `orchd.dispatch.routed.remote` / `orchd.dispatch.failed`)?** — deferred per ADR-231 OQ-4 alignment (orchd-domain observability gate — ADR-203 §D2 closed v1 topic set; needs amendment). Lean: yes for failed (operator visibility), no for routed (audit trail in dispatch-log is sufficient).
3. **OQ-3: Should `dispatchGitPush` retry on transient network failure (default ssh / https failures)?** — lean: NO, mirror ADR-231 §D5 anti-retry-storm rationale (flag + operator triage > silent retry). Resolve at impl review.

Resolve OQ-1 before flipping `Status: accepted`. OQ-2 + OQ-3 may flip while deferred.
