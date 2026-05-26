# ADR-232: orchd cross-cage dispatcher seam — `dispatchEpicMerge` / `dispatchDissolveEpic` / `dispatchGitPush`

**Status**: proposed (deferred: §D2.b transport choice still open per OQ-1; §D2.a routing semantics + naming convention added 2026-05-23 post-fan-in 27924b5 reconcile of reviewer concern on e874291; flips to `accepted` at S0 reviewer trunk-signoff once fix Task lands the §D2.a guard across all three dispatchers + OQ-1 is resolved)
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

### D2 — Routing semantics + transport choice

**D2.a — Routing semantics: parent → child cage only; never self-dispatch.** (Amendment 2026-05-23 post-fan-in 27924b5 reconcile of reviewer concern on e874291.)

Each dispatcher resolves a `targetCage` value — the **NAME** of the cage (= `team.json::name` of the child epic-team that owns the action). Binding rules:

1. **`targetCage` is the child cage's team name**, e.g. `"e-60e16169"`. It is NEVER the epic id (e.g. `"e-1-118d16a9"`). Conflating the two collapses parent's own committer into the dispatch path — a self-dispatch loop in cages whose `team.json::name` happens to equal an epic id (the common case for epic-teams spawned via `atmux team spawn-epic <epicId>` — team-name defaults to the epicId per ADR-090).
2. **Local-cage-skip guard.** If `targetCage === team.json::name` of the running cage, the dispatcher returns `{ localExecuted: false, skipped: 'local-cage-already-owns' }` immediately. Local impl already ran via the in-cage handler before the dispatcher was invoked (or will, via the same handler — see §D3); the dispatcher exists for **parent → child fan-out only**, never to re-fire local logic.
3. **Remote route.** If `targetCage !== team.json::name`, dispatch to the child cage via the transport (D2.b).
4. **Cage-not-found.** If `targetCage` cannot be resolved (cage not in `atmux team list` enumeration), emit `atmux flag add 'orchd: dispatch failed for <action>: cage <targetCage> not found'` + return error.

**Variable-naming convention (BINDING on impl):**

| Variable | Type | Carries |
|---|---|---|
| `targetCage: string` | child team name (matches `team.json::name`) | resolution target for the dispatch |
| `localTeamName: string` | current cage's team name (read from local `team.json::name`) | guard-comparison source |
| `targetEpicId: string` (if needed) | the `e-*` epic id triggering the action | ONLY when you also pass it through; never aliased as `targetCage` |

If an impl needs to derive cage from epicId (because the upstream caller only knows the epicId), introduce an explicit `epicToCage(epicId): string` helper that walks `atmux team list` for the owning epic-team. **Do NOT shortcut by setting `targetCage = epicId`** — that's the anti-pattern reviewer flagged at e874291.

**Anti-pattern (reviewer-flagged at e874291):**

```ts
// WRONG — collapses cage-name and epic-id into one identifier
const targetCage = input.epicId;
if (targetCage !== team.name) { dispatchRemote(...) }
// → parent's committer (team.name = "atmux") ALWAYS sees targetCage !== team.name
//   → always remote-dispatches, never executes locally.
// → child cage (team.name = "e-60e16169") sees targetCage === team.name when
//   the dispatched epicId == its own spawning epicId → SELF-DISPATCH LOOP.
```

```ts
// RIGHT — explicit cage resolution, explicit local-skip guard
const targetCage = await epicToCage(input.epicId);   // returns child team-name
if (targetCage === localTeamName) {
  return { localExecuted: false, skipped: "local-cage-already-owns" };
}
return await dispatchRemote(targetCage, input);
```

**Symmetry across the three dispatchers.** The guard + naming convention applies identically to `dispatchEpicMerge` (c477954), `dispatchDissolveEpic` (e874291), `dispatchGitPush` (41aafa6). Fix Task t-20-<id> sweeps all three for compliance even if only e874291 triggered the reviewer flag — the anti-pattern is structural; assume any dispatcher unsifted carries it.

**D2.b — Cross-cage transport (deferred — design lands post-merge).**

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
