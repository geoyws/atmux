# ADR-299: Cockpit medic runs OMP on a shell floor

**Status**: accepted (operator-direct — George, 2026-09-28)
**Date**: 2026-09-28
**Driver-ref**: kb atmux t-94a8d6dc
**Relates**: [ADR-077](077-superdoctor-cockpit-role.md) (medic role), [ADR-133](133-medic-rename.md) (medic rename), [ADR-296](296-per-team-superdriver-window-before-driver.md) (two-stage precedent for drivers/superdriver), [ADR-289](289-retire-medic-autostart-sendkeys.md) (no auto-fire into panes), [ADR-279](279-declarative-operator-cockpit-windows.md) (cockpit window order)

## Context

Every agent pane's start command is an interactive login zsh (`shellPaneCommand()` in `src/core/tui-cmd.ts` = `stty sane 2>/dev/null; exec zsh -l -i`); OMP is launched as a child of that shell after the prompt is verified, so when OMP exits the pane returns to its shell prompt. Drivers and superdriver already follow this two-stage pattern via `launchAgentInPane` (`src/core/agent-pane.ts`).

The cockpit `_medic` executor did not. `buildMedicWindowCommand` returned `withShellFloor(<claude …>)` = `zsh -lc '<CLAUDE env> claude …; exec zsh -l'`, so the pane's start command WAS Claude — the one pane in the fleet that violated the standard pane lifecycle, with a bespoke quoting wrapper (`withShellFloor`) no other surface used.

## Decision

### D1 — The `_medic` window starts on the shell floor; the agent arrives as a child

Reconcile creates a missing `_medic` window with `shellPaneCommand()` as its start command and `resolveMedicCwd(medic)` as its cwd, then launches the agent as a child with the existing two-stage helper (`launchAgentInPane`, intent kind `"medic"` — new alongside a matching `"medic"` `SendTarget` variant). A live `_medic` window is never killed/respawned during reconcile (preservation behaviour unchanged); only newly created windows get the new shape. A failed stage-2 launch warns and leaves the live shell (same rule as driver seats in `start.ts`).

### D2 — `tui` selects the child; `cwd` pins the directory

- `tui: "omp"` (default) → the literal `omp`. No per-driver OMP command rules exist to reuse; the child command is the bare word.
- `tui: "claude"` → the legacy Claude invocation (the only path that reads `claudeAccount` / `tuiOverrides`).
- `cwd` (absolute path; schema-refused otherwise) pins the window directory; unset means the operator's HOME (`$HOME`, else `os.homedir()`) — the medic repo is not known to atmux, so there is no project root to pin.

Both fields live on the `medic` top-level block (`CockpitMedic`) and on `type: "medic"` session entries (`MedicSession` leaf only — not the shared session base, so team/superdriver entries keep refusing them); the session-walk synthesis propagates them.

### D3 — Builder honesty + dead-code removal

`buildMedicWindowCommand` now returns the CHILD launch command, not the start command (doc comment says so). `withShellFloor` — used only by the old shape — is deleted. `buildSuperdoctorWindowCommand` (dead alias: only unit-test callers remained) is deleted with its call sites moved to the durable name, per the no-deprecated-leftovers rule; the `buildSuperdoctorCommand` reconcile-deps injection alias stays (existing fixtures inject it).

### D4 — Incidental fix: quote the Claude child command's words

Removing the floor wrapper exposed that the Claude builder never quoted its operator-controlled words (`configDir`, `effortLevel`, `permissionMode`, `pluginDir`) — the pre-existing "quotes … as single shell words" test was red at baseline. The builder now routes all four through `posixQuote` (no-op for safe values, so existing `CLAUDE_CONFIG_DIR=/root/…` assertions stand).

## Consequences

- Quitting OMP/`claude` in `_medic` drops back to the pane's shell instead of killing the window — the same lifecycle as every driver pane.
- `cockpit rotate medic` already used the two-stage shape (shell start + `launchAgentInPane`); reconcile now matches it.
- Configs carrying `medic.tui` / `medic.cwd` parse; a relative `cwd` fails at load naming the absolute-path requirement.
