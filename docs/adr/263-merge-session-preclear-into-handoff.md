# ADR-263: Merge session `preclear` verb into `handoff` (one mode-aware verb, no alias)

**Status**: accepted
**Date**: 2026-06-26
**Driver-ref**: George 2026-06-26 — "let's rename /session preclear to /session handoff" → clarified to **merge** both verbs into one `handoff` (not a collision), **no `preclear` alias** ("don't keep the preclear alias, just make it all handoff"), **"update the adrs"**, **"we want to simplify."**
**Relates**: [ADR-114](114-coordination-runtime-contract.md) (defined the `session` verb set `cont` / `preclear` / `handoff` / `stop` — this ADR collapses it to `cont` / `handoff` / `stop`), [ADR-187](187-coordination-skills-plugin.md) + [ADR-217](217-atmux-skills-plugin-bundled-and-wizard-installed.md) (the bundled `/atmux:session` skill these verbs ship in).

## Context

`/atmux:session` carried two distinct verbs that both write `handoff.md`:

- **`preclear`** — prepare the CURRENT session for `/clear` (save handoff + memory + tasks; never touches the team; mode-aware driver/solo/lead). The high-frequency phase-boundary verb, paired with `cont`.
- **`handoff`** — write a forward-going brief for a *fresh* claude in a new worktree/branch/tmux session; optional spawn.

Two names, one artifact (`handoff.md`), and "preclear" is opaque jargon. The operator wanted a single, intuitive verb.

A pre-change audit confirmed `preclear` is **never a persisted/wire-format identifier** — zero quoted string literals in `src/`; every code occurrence is a comment, the `/preclear` operator prompt, or a verb-list string. So the rename needs **no state/wire migration** (no `state.db` value, no inter-agent message enum changes).

## Decision

1. **Merge into one verb, `handoff`**, with two auto-detected modes:
   - **same-session** (default) — the former `preclear` behavior.
   - **forward** — the former `handoff` behavior; selected by a fresh target (worktree/branch arg, or `--fresh`).
2. **No `preclear` alias.** Hard cutover — `/session preclear` no longer exists. (Operator muscle-memory, briefs, the rotation prompt, and any cron move to `handoff`.)
3. **Rename `preclear` → `handoff` repo-wide**, including docs, this ADR tree (terminology consistency), tests (`whip_preclear.bats` → `whip_handoff.bats`), and code comments (incl. `rust/atmux-orchd/src/main.rs`). `cont`/`stop` cross-refs, `templates/briefs/*`, and `~/.claude/CLAUDE.md` ("handoff at every phase boundary") updated.
4. **`.atmux/` runtime state left untouched** — it is live, regenerating agent state (transcripts/briefs/worktree working copies), not canonical source; running drivers inherit the rename when they sync from the base branch.

## Consequences

- `/atmux:session` is now **`cont` / `handoff` / `stop`** (4 → 3 verbs). SKILL.md presents `handoff` with two modes under one section.
- Anything still typing `/session preclear` (stale handoffs, cron, operator habit) breaks loudly rather than silently aliasing — intentional, per the no-alias directive. Grep-and-fix on first sighting.
- No data migration: `preclear` was never persisted; existing `handoff.md` files and `state.db` are unaffected.
- Bundled-plugin reinstall/sync needed for the SKILL.md change to reach installed copies (per ADR-217).
