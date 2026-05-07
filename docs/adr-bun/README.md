# adr-bun — Architecture Decision Records for the Bun port

This directory holds ADRs specific to the TypeScript-on-Bun rewrite of atmux.

**Why a separate dir?** Numbering is independent so the bash codebase can keep adding ADRs to `docs/adr/` (next at 007+) without colliding with port-specific decisions (which start at 001 here). When the cutover completes (PLAN.md Phase 4) and the bash binary is decommissioned, this directory is renamed back to `docs/adr/` and the bash ADRs move to `docs/adr-legacy/`.

## Backlog

See `PLAN.md §7` for the full backlog. Architect owns 001–006, foundation owns 007–008, tester owns 009, lead owns 011/013, architect+lead split 010/012.

| # | Status | Title |
|---|---|---|
| 001 | accepted | Why TypeScript on Bun (vs Go, Zig, staying in bash) |
| 002 | accepted | Project layout |
| 003 | accepted | Module taxonomy |
| 004 | accepted (amended 2026-05-05) | tmux abstraction interface |
| 005 | accepted | JSON + locking model |
| 006 | accepted | Error handling discipline |
| 007 | accepted | Subprocess spawn pattern |
| 008 | accepted | Discord webhook + chunking |
| 009 | accepted | Test strategy |
| 010 | accepted | CLI dispatcher |
| 011 | accepted | Side-by-side cutover protocol |
| 012 | accepted | Time + timezone handling |
| 013 | accepted | WIP-bash deferral |
| 014 | accepted | Verb design debt — deferred v2 redesign (Phase 6) |
| **015** | **proposed** | **Team members work in isolated git worktrees by default (Phase 6 / v2)** |
| 016 | accepted | Schema-version rollout deferred to Phase 6 |
| 017+ | — | Per-verb ADRs as needs surface |

## Format

Each ADR follows the lightweight template:

```markdown
# ADR-NNN: <title>

**Status:** proposed | accepted | superseded by ADR-XXX
**Date:** YYYY-MM-DD
**Owner:** <role>

## Context
<problem statement, constraints>

## Decision
<what we're doing>

## Consequences
<positives, negatives, follow-up tickets>

## Alternatives considered
<what we rejected and why>
```
