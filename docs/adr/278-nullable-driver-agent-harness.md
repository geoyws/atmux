# ADR-278: Nullable driver agent harness

**Status**: Accepted — operator-direct 2026-08-24
**Date**: 2026-08-24
**Driver-ref**: operator-direct — teams must no longer declare which agent harness a driver starts with; the default is `null`, and a driver with no harness starts in zsh. The operator may choose a different harness from that shell for each session.
**Relates**: [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (driver roster and command-mode launch), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (legacy `driverSession` launch fallback removed)

## Context

ADR-239 made `drivers[].tui` required and the fleet consequently persisted a specific agent harness such as `claude`, `codex`, or `codewhale` for every driver pane. That no longer matches how drivers are used: they are operator-interactive workspaces, and the desired harness can change between sessions.

A stale persisted harness also couples a team rebuild to launch behavior that the operator did not choose for that run. In practice this is especially painful while developing tmux topology: a rebuild can start the wrong program on the correctly isolated server, making a socket/session problem harder to distinguish from a harness-selection problem.

## Decision

1. `drivers[].tui` is nullable and optional. A non-empty string remains an explicit request to auto-launch that named TUI through the existing command-mode path.
2. `null` or absence means no agent harness. `atmux start` launches `zsh` as the driver pane's command and does not resolve or launch a TUI alias.
3. New-team defaults set every `drivers[].tui` to `null`.
4. The operator's canonical atmux team configs set every `drivers[].tui` to `null`. The legacy `driverSession.tui` and `driverTui` markers are also normalized to `null`; ADR-266 already removed them from driver launch resolution, so this is configuration clarity rather than a second launch path.
5. Member entries are unchanged. `members[].tui` continues to describe deliberately automated team-member launches.
6. Existing running tmux sessions are not mutated. The new behavior applies when a driver window is next created by `atmux start` or a team rebuild.

The ADR-239 no-send-keys invariant remains unchanged: zsh is supplied as the `new-session` / `new-window` command, never pasted into the pane.

## Consequences

- Drivers open as plain zsh workspaces by default, and the operator chooses Claude, Codex, OpenCode, Kimi, or another harness at the prompt for that session.
- Team configuration no longer encodes an agent-harness preference that can go stale independently of tmux socket/session topology.
- Teams that intentionally want automatic driver-harness launch can still set a non-null TUI alias per driver.
- The schema and start unit suites cover null and omitted values. The start test uses an isolated tmux socket and asserts the actual driver pane command is `zsh`; this is source-level local evidence, not deployment or live-tier evidence.

## Rollback

Set `drivers[].tui` to an explicit alias in the affected team config and revert the schema/start changes. Existing sessions require no rollback because this decision never rewrites a running pane.

## Migration receipt — 2026-08-28

The versioned dotfiles inventory and its `/root/.atmux` mirrors were checked structurally with `jq`, not by grepping every `tui` field (member harnesses remain intentional). Fifteen canonical team files had a non-null legacy `driverTui`; five of those also had non-null `driverSession.tui` and/or `drivers[].tui`. Those driver-only fields now all resolve to null across both inventories. No `atmux start`, cockpit reconcile/rebuild, session rename, socket lookup, send-keys, install, or deployment was run; existing panes and tmux server pointers were untouched.

## References

- [ADR-044](044-driver-session-on-default-socket.md) — retained driver-at-front placement; its singular harness precedence is historical.
- [ADR-128](128-complete-driver-role-port.md) — retained driver-role observability; its `driverSession` assumptions are historical.
- [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) — current driver roster and command-mode launch invariant.
- [ADR-266](266-shim-sunset-policy-and-first-sweep.md) — legacy `driverSession` / `driverTui` launch fallback remains removed.
