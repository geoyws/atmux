# ADR-044: Driver tmux session on the operator's default socket

**Status**: accepted
**Date**: 2026-05-04
**Driver-ref**: 2026-05-04 session — operator wants `atmux start` to ensure a properly-named driver tmux session exists on the default tmux server alongside the team session, instead of either (a) co-locating a "driver" window inside the team session or (b) requiring `singleSession=true` mode where team windows live inside the driver's daily session.

## Context

`atmux start` already supports two driver topologies:

1. **Default (legacy)**: dedicated `atmux-<team>` session for member panes, plus an auto-spawned in-team `driver` window (since 2026-04-30) where the operator runs their own TUI. Operator attaches with `atmux attach`.
2. **`singleSession=true`** (ADR-016 Phase 2 + ADR-026): member windows live INSIDE the driver's currently-attached tmux session. Operator's daily tmux session IS the team session.

Neither matches the operator's actual workflow. They keep:

- A daily tmux server (default socket) where they have manual sessions running unrelated work (`__main`, `paste`, `ix`, `sb`, etc).
- One **dedicated driver session per project** on that default server (`atmux_unum`, `atmux_ifca_aux`, etc — underscore-separated per their naming convention) where they sit when working on that project.
- Member panes ideally separated, NOT polluting either the daily tmux nor the driver session.

The operator was creating these driver sessions by hand. When they spun up 5 teams, they ended up with 5 phantom 1-pane sessions named `atmux_<team>` on the default server alongside the (separate) `atmux-<team>` team sessions. Atmux never knew about the driver sessions; it just spawned the team sessions.

The fix: make `atmux start` aware of the driver session as a first-class concept and ensure it exists on the default socket, declaratively configured per team.

## Decisions

### D1 — `team.json:.driverSession` config object, default unset

Optional object in `team.json`. Shape:

```json
"driverSession": {
  "name":    "<session-name>",       // optional; default: "atmux_<team>" with - → _
  "cwd":     "<path>",               // optional; default: project root (parent of .atmux/)
  "tui":     "claude|opencode|...",  // optional; default: .driverTui // "claude"
  "command": "<override-cmd>",       // optional; default: derived via atmux::tui_cmd
  "enabled": true                    // optional; default: true (when key present)
}
```

When the key is **absent**, behavior is unchanged: the existing in-team `driver` window auto-spawn (since 2026-04-30) keeps running. When the key is **present and enabled**, atmux start ensures the named tmux session exists on the operator's default socket AND suppresses the in-team driver window auto-spawn (no double-driver-REPL).

**Why opt-in via the field's mere presence**: matches the established `whip.autoStopAfterIdleTicks` (ADR-043) and `whip.autoRotate` (ADR-009) opt-in conventions. OSS users not wanting separate driver sessions ignore the field entirely.

### D2 — Default name = `atmux_<team>` with `-` → `_`

Matches the operator's pre-existing manual convention (`atmux_unum`, `atmux_ifca_aux`) and the global identifier-naming rule (`-` for spaces, `_` for domains; team names with hyphens map to `atmux_team_with_underscores`).

**Why**: zero churn for operators already using that naming pattern; explicit override available via `name` field.

### D3 — Force the default tmux server via `env -u TMUX -u TMUX_TMPDIR`

The driver session creation deliberately drops both `$TMUX` and `$TMUX_TMPDIR` for its `tmux` invocations so the session lands on the operator's default tmux server even when `atmux start` was invoked from inside a per-team cage socket. The driver's home is the daily socket — not the cage. Per `tmux(1)`, `$TMUX` overrides `$TMUX_TMPDIR` for bare `tmux` invocations, so dropping both is needed to be sure.

**Why**: the whole point of the separate driver session is socket separation. The cage holds team panes; the default socket holds the driver. Without this, a start invoked from a cage shell would create the driver session ON the cage, defeating the design.

### D4 — Non-fatal failure path

If the driver-session creation fails (tmux server not available, name collision, command-resolution failure), atmux logs a warning and continues. The team session itself is up; the operator can still attach to it. The driver session is convenience infrastructure, not a precondition for "team is up."

**Why**: matches the established non-fatal pattern for cron auto-install, registry touch, on-activate groom — all convenience layers that don't gate the team being functional.

### D5 — Idempotent on existing session

If the named session already exists on the default server (operator created it manually, or a prior start ran), atmux logs `'<name>' already exists` and skips. It does NOT inspect the session's contents nor try to re-render the TUI.

**Why**: respects the operator's in-flight work. A driver session that exists from yesterday's session may have unsaved REPL state the operator wants to keep.

## Consequences

**What changes**

- `lib/start.sh` gains `_atmux_ensure_driver_session` helper (~50 lines) and one new call site after the supervisor spawn.
- The existing in-team `driver` window auto-spawn is suppressed when `driverSession` is configured (1-line conditional).
- `team.json` schema gains optional `driverSession` object.
- 1 new bats file: `tests/unit/start_driver_session.bats` (6 tests covering: absent, enabled, name-override, enabled=false, idempotency, in-team-suppression).

**What breaks**

- Nothing for teams without `driverSession` set. Pure no-op migration.
- For teams that opt in: the existing in-team `driver` window stops auto-spawning on next `atmux start`. Existing in-team driver windows from prior starts persist (atmux start is idempotent on the team session) until manually killed or `atmux start --force`.

**What we give up**

- Single `atmux attach` to reach both team and driver — operator now has two attach targets (`atmux attach` for team, `tmux attach -t atmux_<team>` for driver). Recoverable later via an `atmux attach --driver` flag if friction surfaces.

## Open questions

- **Should `atmux start` auto-attach to the driver session at the end?** Considered. Auto-attach would block the script in interactive contexts and fail in cron contexts. Deferred — operator attaches manually. If usage data shows everyone attaches immediately, revisit with an `--attach-driver` flag.
- **What about a `--driver-only` start flag** that brings up just the driver session without spawning team panes? Not in this ADR. Useful for "I want to work in this project but don't need agents yet." Defer until the basic feature stabilises.
