# ADR-257: Eternal-improvement = backlog-burndown-first + worktree-isolated, deferred verified merge

**Status**: accepted
**Date**: 2026-06-05
**Driver-ref**: George 2026-06-05 — "make eternal-improvement always address longstanding issues first, then improvements that need tackling; work should sit neatly in worktrees or nested worktrees branched from worktrees, awaiting a merge into trunk later when verified. This way time and tokens are not wasted (tokens are pre-paid and expire every week)."
**Relates**: [ADR-052](052-eternal-improvement-loop.md) (the substrate this reframes), [ADR-149](149-eternal-improvement-gating.md) (its backlog-defer gate, superseded here), [ADR-090](090-epic-team-lifecycle.md) (spawn-epic worktree isolation reused), [ADR-134](134-in-team-auto-merger.md) / [ADR-091](091-kanban-driven-auto-merge.md) (verified fan-in to trunk), [ADR-082](082-worktree-isolation-per-member.md) / [ADR-084](084-worktree-per-member-branch-model.md) (long-lived worktree branches), [ADR-126](126-sqlite-state-store.md) (kanban store read by the selector).

## Context

ADR-052's loop is **prompt-driven**: `armCycle` appends a directive to `<atmuxDir>/improve-directives.md`; the lead reads it each whip turn and routes to the planner, who lands Tasks the members then work. The original directive asks each lane member for their **top net-new improvement candidate** — so a cycle *generates more work*.

Two problems with that under the operator's economics (pre-paid, weekly-expiring tokens — idle capacity is a use-it-or-lose-it resource):

1. **It amplifies the backlog instead of burning it down.** [ADR-149](149-eternal-improvement-gating.md) recognised this (its "Issue 2") and *accepted* a gate to DEFER the loop when the team has a non-empty backlog. But that backlog gate was **never implemented in the TS path** — the `atmux improve` arm path (`budget → idempotence → openCycle → armCycle`, `src/verbs/improve.ts`) opens a cycle unconditionally, and `tickCycle` has no backlog check. So in practice the loop neither defers on backlog nor works it; it just generates net-new work.
2. **Cycle work lands wherever the member happens to be working** — there is no structural guarantee it is isolated or that unverified work stays off trunk.

The operator's directive resolves both: spend idle capacity **burning down the longstanding backlog first**, then net-new improvements; and capture all of it in **isolated worktrees** that reach trunk only when **verified**.

## Decision

### (D1) Burndown-first work selection

`selectLongstandingIssues(tasks, nowSec, opts)` (`src/core/improve-cycle.ts`, pure) ranks the team's OPEN backlog (`status: 'todo'`) **oldest-first** (longstanding = smallest `createdAt`), tie-breaking by priority (lower number = higher priority per the kanban schema). It excludes:

- the improvement loop's OWN net-new Tasks (`epic === IMPROVEMENT_EPIC_ID`) — so the loop burns down the *real* backlog, never its own output;
- `driverOnly` Tasks — members working the cycle can't claim driver-scoped work.

The top `limit` (default 3, matching ADR-052's "top 1-3") are named in the arm directive. **Net-new improvement candidates are solicited only when the longstanding backlog is dry** (selection returns empty).

### (D2) Supersede ADR-149's backlog-defer gate

The loop no longer **defers** on a non-empty backlog — it **works** it (D1). ADR-149's backlog-defer intent is superseded (and was never live in the TS path anyway). ADR-149's *other* lever — the per-team `eternalImprovement.enabled` master toggle (its §D1) — is unaffected and out of scope here. ADR-052's **driver-preemption** (`isDriverPreempt` → pause when a non-improvement Task is in-progress) is retained: real driver work still preempts the loop.

### (D3) Worktree isolation + deferred verified merge

All cycle work happens in an **isolated improvement epic-team worktree** (reuse `atmux team spawn-epic`, ADR-090 — one live improvement epic, reused across cycles; **large items get nested worktrees branched from the epic base**, the "nested worktrees branched from worktrees" the operator asked for). Work is committed to the epic branch; the [ADR-134](134-in-team-auto-merger.md) / [ADR-091](091-kanban-driven-auto-merge.md) committer fans it into trunk **LATER, only when verified green**. Unverified work never lands on trunk; idle-time work is never lost (it lives durably in the worktree until verified).

Cycle-close mechanics are unchanged (`isCycleClosable` over the epic-team's kanban; `tasksDone` recorded at close); the trunk-merge is **asynchronous** via the committer, so a cycle's tokens are never blocked waiting on merge.

### (D4) The directive is the mechanism

Per ADR-052 §"Loop mechanics", the change is delivered through the **directive**, not new orchestration code: `buildArmMessage(cycleN, longstanding)` emits (a) the named longstanding Task ids to resolve first (oldest→newest), or the net-new fallback when the backlog is dry, plus (b) the standing isolation contract (spawn-epic worktree + nested worktrees + verified-committer-merge). The lead/planner execute it with existing verbs. `armCycle`'s caller (the arm path + `tickCycle`, both of which have the loaded kanban) computes the selection and passes it via `ArmCycleOpts.longstanding`.

## Consequences

- Idle, pre-paid token capacity burns down the **real longstanding backlog** before generating new work — directly serving the operator's "don't waste tokens" goal.
- Unverified improvement work is structurally kept off trunk (committer-gated), and durably captured in worktrees so nothing is lost between cycles.
- **Out of scope / deferred**: (a) deterministic auto-spawn of the improvement epic from `improve.ts` — today the planner spawns/reuses it per the directive; a future hardening could make `improve.ts` ensure-spawn it. (b) `blocked`-status backlog handling — selection targets workable `todo`; unblocking stale `blocked` items is a separate action. (c) The verified-merge itself is the committer's existing job (no change here).

## Implementation

- `src/core/improve-cycle.ts`: `LongstandingIssue` + `selectLongstandingIssues()` + `buildArmMessage(cycleN, longstanding)` + `ArmCycleOpts.longstanding`.
- `src/verbs/improve.ts`: arm path + `tickCycle` load the kanban and pass `selectLongstandingIssues(...)` to `armCycle`.
- Tests: `tests/unit/core/improve-cycle.test.ts` (selection ranking/exclusions/limit + directive content with and without longstanding items).
