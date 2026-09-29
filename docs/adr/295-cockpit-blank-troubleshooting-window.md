# ADR-295: `_blank` cockpit troubleshooting window — opt-in plain shell after `_medic`

**Status:** Proposed
**Date:** 2026-09-26
**Deciders:** Team
**Driver-ref:** e-25-f76e9c77 / t-5bc98864 (operator ask: a plain-shell cockpit window for terminal-side troubleshooting)

## Context

Cockpit windows today are role windows (`_superdriver`, `_medic`), team viewers, group embeds, and free-form declarative `windows[]` entries. An operator troubleshooting a wedged cage from inside the cockpit has no canonical plain shell: they hand-open a window, and the next fleet-wide reconcile prunes it as an orphan.

## Decision

1. **Opt-in flag** — top-level `blank` in `cockpit.json` (`z.boolean().optional()`, default off). Absent or false: no `_blank` window, and a leftover `_blank` is an ordinary orphan (pruned by the normal pass).
2. **The window** — named `_blank`, plain shell (no command, operator's default shell via the `zsh` fallback the operator-window flow already uses), cwd = `$HOME`.
3. **Ordering invariant** — `_blank` sits right after `_medic`: superdriver, `_medic`, `_blank`, then team viewers. Implemented by synthesizing the entry into the declarative `windows[]` flow, which already creates after `_medic` and before viewers, preserves from the orphan-prune, and plans identically in the destructive gate. No prune/gate special-casing.
4. **Per-team reconcile does not touch it** — same as every `windows[]` entry.

## Alternatives considered

- **Tell the operator to declare it in `windows[]` manually.** Rejected: the ordering invariant and the toggle deserve a named, testable contract rather than folklore; a hand entry also needs an explicit cwd while the flag derives it.
- **Dedicated creation + preserve-list entries alongside `_medic`.** Rejected: duplicates the operator-window flow for one window; synthesis inherits creation, ordering, preservation, and gate behavior for free.

## Cross-refs

- ADR-077 (cockpit roles — `_blank` is role-adjacent, troubleshooting, not a fleet role)
- ADR-162 (atmux owns tmux infra — window lives on the cockpit socket)
- ADR-240 (cockpit simplification sibling)
- e-25-f76e9c77 (epic), t-5bc98864 (ADR + implementation), t-fd58df45 (tests + docs)
