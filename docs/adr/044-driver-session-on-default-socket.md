# ADR-044: Driver as window 1 of the team session

**Status**: accepted (replaces an earlier transient design — see Iteration history)
**Date**: 2026-05-04
**Driver-ref**: 2026-05-04 session — operator wants `atmux start` to spawn the driver pane *inside* the team session as window 1, before the lead, with members following in `team.json` declarative order. Single-session topology (driver's daily tmux session hosting team windows) is explicitly forbidden.

## Context

`atmux start` historically supported two driver topologies before this ADR:

1. **Default (since 2026-04-30)**: dedicated `atmux-<team>` session for member panes plus an in-team `driver` window auto-spawned AFTER all members (window N+1).
2. **`singleSession=true`** (ADR-016 Phase 2 + ADR-026): member windows live INSIDE the operator's currently-attached tmux session. Operator's daily tmux session IS the team session.

Neither matched the operator's stated workflow: they want the team's dedicated session, with the driver as the FIRST window — declarative topology `driver → lead → members`. Visiting the team session lands on the driver tab (where the operator works); members are tabs 2..N in `team.json` order. Single-session is rejected because it merges team windows into the operator's daily tmux, polluting the daily tab list with team panes.

## Iteration history (transparency note)

An earlier, same-day iteration of this ADR shipped a **separate-session** model: `team.json:.driverSession` would create a distinct `atmux_<team>` session on the default tmux server, alongside the `atmux-<team>` team session. That iteration was deployed (commits `b528610` + `c1053ab`), then immediately rejected by the operator: having two separate sessions per team requires switching sessions to bounce between driver and team panes, which felt wrong. The current ADR replaces that design before it accumulated dependents.

## Decisions

### D1 — `team.json:.driverSession` config object, default unset

Optional object in `team.json`. Shape (all fields optional):

```json
"driverSession": {
  "tui":     "claude|opencode|shell|...",  // default: .driverTui // "claude"
  "command": "<override-cmd>"              // default: derived via atmux::tui_cmd
}
```

When present, `atmux start` creates the team session with `driver` as the **initial window** (window 1) running the configured TUI. Members are spawned by the existing loop and append after — windows 2, 3, ..., N+1.

When absent, behavior is unchanged: the legacy at-end driver auto-spawn (post-2026-04-30) appends a `driver` window AFTER members.

**Why opt-in via the field's mere presence**: matches the established `whip.autoStopAfterIdleTicks` (ADR-043) opt-in convention. Existing OSS deployments without the field keep the legacy at-end behavior, no surprise migration.

### D2 — Driver replaces `__home` placeholder at session creation

Today, `atmux start` creates the team session with a placeholder `__<team>__home` window (line 167 of start.sh), spawns members (each as a new window appended after), then kills `__home`. With `driverSession` configured, the placeholder step is replaced: `tmux new-session -d -s <session> -n driver -c <project-root> <driver-tui-cmd>`. Members append after as windows 2..N+1. No `__home` placeholder is ever created when driver is the initial window.

**Why**: this is the cleanest path to "driver at window 1" without inserting + shifting member windows post-spawn (which would race against the operator attaching mid-spawn). The driver window IS the placeholder.

### D3 — Existing-session, no-driver case is left alone

If `atmux start` runs against an already-existing team session that does NOT have a `driver` window, atmux does NOT retroactively insert one and shift member indices. That would disrupt operator state on attached sessions.

The operator can manually arrange this with `tmux move-window` (proven workable: 2026-05-04 unum migration moved an existing driver into window 1 via reverse-loop shift + move-window in ~5 commands) or restart the team via `atmux start --force`.

**Why**: idempotency on running teams matters more than enforcing topology on legacy state. The new topology applies at session creation; operators upgrade existing teams when they choose to.

### D4 — Legacy `driverTui` field still honored when `driverSession` is absent

The pre-existing `team.json:.driverTui` field continues to drive the legacy at-end auto-spawn block. Teams that set only `driverTui` get unchanged behavior. Teams that set `driverSession` get the new at-front behavior. Teams that set both get `driverSession`'s placement (at-front), with `driverSession.tui` falling back to `driverTui` if not specified.

**Why**: backward compatibility for teams created before this ADR.

## Consequences

**What changes**

- `lib/start.sh`: session-creation block conditionally spawns driver as the initial window when `driverSession` is configured (~30 lines added).
- `lib/start.sh`: the previously-shipped `_atmux_ensure_driver_session` helper (separate-session model) is removed (~50 lines deleted).
- `lib/start.sh`: legacy at-end driver auto-spawn block is preserved but only runs when `driverSession` is absent.
- `team.json` schema: `driverSession.name` / `.cwd` / `.enabled` fields from the prior iteration are removed (no longer meaningful when there's no separate session).
- 1 bats file: `tests/unit/start_driver_session.bats` rewritten — 5 tests covering the new topology (driver-at-window-1, member ordering, idempotency, no-separate-session-leak, legacy-fallback-at-end).

**What breaks**

- Nothing for teams without `driverSession` set — legacy at-end driver auto-spawn unchanged.
- For teams that opt in: the team session is created with `driver` as window 1 instead of `__home`. Operators upgrading from pre-ADR-044 in-team-driver-at-end placement see the driver move to the front on next fresh `atmux start --force`.
- The earlier same-day separate-session iteration (`atmux_<team>` on the default socket) is rolled back. Anyone who attached to a separate driver session in the brief window between the prior deploy and this commit will need to reattach to `atmux-<team>:driver`.

**What we give up**

- Nothing structural. The earlier "operator's daily socket holds the driver" framing was attractive in theory but failed the workflow test in practice — switching sessions to reach the team is more friction than tabbing through windows in one session.

## Open questions

- **Should `atmux start --force` on an existing session auto-migrate the driver to window 1 (move + shift)?** Not in this ADR. The 2026-05-04 unum migration showed it's mechanically straightforward via tmux primitives, but bundling that into start would surprise operators who don't expect their tab indices to shift mid-attach. Consider a dedicated `atmux team migrate-driver-front` verb if usage data shows operators commonly need it.
