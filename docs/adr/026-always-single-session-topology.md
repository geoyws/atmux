# ADR-026: Always single-session topology — driver + members share session

**Status**: accepted
**Date**: 2026-04-27
**Supersedes (default policy)**: [ADR-016](./016-single-session-topology.md)

## Context

[ADR-016](./016-single-session-topology.md) introduced single-session topology as **Option A: opt-in flag** (`team.json:.singleSession=true`), with the original default preserving dedicated `atmux-<team>` sessions. The flag was conservative — flipping the default felt aggressive at the time.

Three weeks of fleet operation surfaced the actual pattern:

- Drivers running 4 teams (`atmux-kanban`, `sopx-mvp`, `aix-root`, `geoyws-beads`) accumulated 5 sessions in `tmux ls`. Session-hop via `prefix s` is meaningfully slower than window-hop via `prefix n/p` and `prefix w` — felt every time the driver checks state.
- New users discover dedicated sessions only via `tmux ls` surprise; nothing in `atmux start` output telegraphs that a separate session exists.
- The original concerns about flipping the default — collision risk, accidental `kill-session` of the driver shell — were already mitigated in ADR-016's Phase 1 (window-name prefix `__<team>__<member>`, refuse-gate in `lib/stop.sh:39`). The two-mode complexity outweighs the safety margin.
- Driver feedback 2026-04-27 08:30 MYT: *"we should always have the driver + members all in the same session so that the user can see everything at a glance. usually users are actively going around checking. it's more elegant and simpler this way. separation sessions really pollute the session space."*

## Decision

**Every atmux team defaults to `singleSession=true`.** The opt-in flag from ADR-016 inverts to opt-out:

- `atmux init --wizard` no longer prompts for the topology choice. Single-session is the only mode the wizard creates.
- `team.json:.singleSession=false` is retained as a *declared* (not hidden) escape hatch for the rare case of a non-human-driven team or detached observer setup. Documented in `templates/team.json.tmpl` and README, NOT prompted.
- `lib/init.sh::_atmux_prompt_choice single_session ...` is removed. Wizard writes `singleSession=true` unconditionally.
- All existing dedicated-session teams should be retroactively migrated via `atmux migrate-to-driver-session <team>` during quiet windows. ADR-016 Phase 2's migrate verb already handles the move with pre-flight pane-state safety.
- README pivot: the "single-session is the default" framing replaces "single-session is an opt-in flag". Document `singleSession=false` as the dedicated-session escape hatch.

**Superdriver is a separate concept** (see [ADR-025](./025-superdriver-phase-1.md)). Superdrivers run in their **own** dedicated tmux session `atmux-superdriver` — they aggregate state across team driver-sessions, so they MUST NOT share a session with any single team. The single-session rule applies to team drivers only.

## Consequences

- **Window count in driver session grows linearly** with active team count × member count. Today's fleet collapsed into one driver session = ~31 windows (1 driver + 7 atmux-kanban + 12 sopx-mvp + 5 aix-root + 6 geoyws-beads). Mitigation: window-name prefix `__<team>__<member>` is grep/choose-tree friendly — `prefix w` shows a flat list, `prefix s` (choose-tree) groups visually by name prefix.
- **Backward-compat is soft.** Existing dedicated-session teams continue to work until migrated; no forced flip. Teams created from now on are single-session-only.
- **Refuse-gate at `lib/stop.sh:39` becomes load-bearing for every team**, not just opt-in users. Already present and tested per ADR-016; this just promotes it from per-team to fleet-wide invariant.
- **`atmux doctor` orphan-session detector** (ADR-016 Phase 1) keeps relevance — flags teams with `singleSession=true` whose state has not yet been migrated. With the new default, it becomes the canonical "did you remember to migrate?" surface.
- **Eject path is still missing.** Once a team's windows are in the driver session, removing them is manual `tmux move-window` work. ADR-016 Phase 2 does not ship an `eject-from-driver-session` verb. Acceptable for now (rare op); revisit if it surfaces as pain.
- **Multi-driver scenarios** (one human driving, one observer attaching) become slightly muddier — the observer attaches into a session containing all teams' windows, not just the one they want to watch. Acceptable for single-user hax setups; flag for ADR revision if multi-user becomes real.

## References

- [ADR-016](./016-single-session-topology.md) — original opt-in design (this ADR supersedes the default policy only; implementation surface from ADR-016 stands)
- [ADR-025](./025-superdriver-phase-1.md) — superdriver runs in its own dedicated session, NOT the team driver session
- Driver feedback in driver-inbox @ 2026-04-27 08:30 MYT — "always single-session" pivot
