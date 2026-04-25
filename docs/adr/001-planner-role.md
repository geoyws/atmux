# ADR-001: Separate planner role from team-lead

**Status**: accepted
**Date**: 2026-04-25

## Context

Early atmux had the team-lead doing both coordination AND task decomposition. In practice, the lead ran out of context 30–40 minutes in — it was juggling driver-inbox triage, kanban maintenance, dispatch, Discord messaging, AND decomposing new asks into tasks + ADRs.

The same pattern shows up in the driver's `CLAUDE.md`: *"Team-lead never plans. Task decomposition, ADR authorship, scope shaping belongs to dedicated planner teammates."*

## Decision

Introduce a `planner` role as canonical staff. The pipeline becomes:

```
driver  →  lead  →  planner  →  kanban  →  workers
         (route)   (decompose + ADR)       (execute)
```

The lead routes asks to the planner. The planner decomposes into kanban tasks (with bodies, dependencies, priority), writes ADRs for durable decisions, and replies with task IDs. The lead dispatches from the kanban.

Planner uses the same TUI as the lead (claude, under `perf`/`default`; opencode under `eco`).

## Consequences

### What we gain
- Lead's context budget goes to coordination only. It stays coherent longer.
- Planner's context budget goes to decomposition only. ADRs get written reliably.
- The cognitive split mirrors the human model (director vs stage manager).

### What we give up
- One more tmux pane, one more token budget. For small teams the split may be overkill.
- One more round-trip per driver ask: driver → lead → planner → lead → workers. Fine for non-trivial asks; feels heavy for "fix this typo" asks.

### Mitigation
- Planner is optional (`include_planner [y/n]`, default yes). Teams that don't need it can skip.
- Lead has a fast-path: trivial asks (one-line fixes) dispatch directly without routing to planner.
- Ephemeral specialists (see ADR-004): if the main planner's queue is deep, spin up `planner-<feature>` on demand.
