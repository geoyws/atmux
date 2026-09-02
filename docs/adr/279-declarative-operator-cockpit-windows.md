# ADR-279: Declarative operator cockpit windows and literal session names

**Status**: Accepted — operator-direct 2026-08-24
**Date**: 2026-08-24
**Driver-ref**: operator-direct — inspect the current cockpit and persist its setup wisely with the existing atmux codebase, without disturbing tmux server pointers.
**Relates**: [ADR-135](135-cockpit-naming-convention.md) (cockpit window roles and ordering), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (dedicated cockpit socket), [ADR-235](235-cockpit-verb-surface-rationalization.md) (reconcile safety), [ADR-264](264-cockpit-session-atx-rename.md) (default session name)

## Context

The live cockpit on 2026-08-24 is a healthy, attached tmux server at `/tmp/tmux-0/atmux-cockpit`, session `atmux_cockpit`. Its window order is `_superdriver`, `_medic`, `_misc`, then the enabled team viewers in `cockpit.json` order. `_misc` is an operator-owned zsh workspace rooted at `/root/work`; it is not a team cage.

Two parts of that working topology were not safely reproducible:

1. `cockpit.json` explicitly persisted `cockpitSession: "atmux_cockpit"`, but the ADR-264 load shim silently changed it to `atx`. A reconcile would therefore rename the live session before reaching the destructive-operation gate. The operator's pinned `aca` target could break even when reconcile later refused for an unrelated window.
2. `_misc` had no declarative representation. Fleet reconcile classified it as an orphan, and a confirmed reconcile would remove it and shift the team windows forward. Simply exempting underscore-prefixed windows from pruning would preserve the current process but would not recreate `_misc` after a genuine server loss.

The canonical cockpit config is already durable: `/root/.atmux/cockpit.json` and the dotfiles path are the same inode. The missing layer is faithful interpretation and recreation, not another state store.

## Decision

1. `cockpitSession` is literal operator intent when present. `atx` remains the default for a new config or omitted field, but the loader no longer coerces explicitly persisted historical literals. The existing in-place rename shim remains available only when the resolved target is actually `atx`.
2. Add top-level `windows[]` for operator-owned cockpit windows with shape `{ name, enabled?, cwd, command? }`. These windows have no team cage and do not participate in cage start, health, prefix, or harness auto-launch phases.
3. A null or omitted `command` starts `zsh`. Existing panes are never restarted merely because their declarative command or cwd differs; those fields apply only when a missing window is created.
4. Fleet ordering is `_superdriver`, optional `_medic`, enabled `windows[]` in declaration order, then enabled top-level team viewers in declaration order. Configured operator windows are included in the wanted set and the pre-mutation safety calculation, so they are neither pruned nor treated as destructive drift.
5. Per-team reconcile remains additive and team-scoped. It does not create, reorder, or remove operator windows.
6. The current fleet config declares `_misc` with `cwd: "/root/work"` and `command: null`.
7. This change does not run cockpit reconcile, rename a session, move a window, switch a client, rebuild a cage, or deploy. The live setup is the observation target and must remain untouched while persistence support lands.

## Consequences

- A fresh cockpit can reproduce `_misc` rather than relying on an immortal pane.
- The checked-in source respects the attach target that the operator explicitly persisted, avoiding config-driven pointer drift.
- The live 22-window layout becomes an idempotent desired state once source and config are installed; until then, the existing installed binary and live server remain unchanged.
- Operator windows deliberately do not model arbitrary pane layouts or process checkpointing. They recreate one tmux window with one cwd and one command; application state and scrollback remain properties of the live server.
- Duplicate/reserved names are rejected so an operator window cannot impersonate `_superdriver`, `_medic`, or a team viewer.

## Rollback

Remove the `windows[]` entry and revert the schema/reconcile changes. Keep `cockpitSession` pinned to the currently live literal; do not attempt rollback by renaming a running tmux session.

## References

- Live receipt, 2026-08-24: `atmux_cockpit`, 22 windows, two attached clients, zero dead panes.
- [ADR-278](278-nullable-driver-agent-harness.md) — analogous null-means-zsh policy for driver workspaces.

## Amendments

### 2026-09-02 — reserved-name set follows ADR-288; `_sdN` superdriver lanes are operator windows

[ADR-288](288-superdriver-lane-shortform-and-multi-lane-cockpit.md) renames cockpit window 1 `_superdriver` → `_sd` (§D1), so the reserved set that `validateOperatorWindowNames` enforces (this ADR's §Consequences "duplicate/reserved names are rejected") is now `_sd`, `_superdriver` (legacy, deprecation window), `superdriver` (legacy), `_medic`, `medic`, `superdoctor`, `_superbot`, plus team and group names. Fleet ordering in §4 now reads `_sd`, then the `windows[]` entries named `_sdN` (superdriver lanes, ADR-288 §D5) in declaration order, optional `_medic`, enabled `_superbot`, the remaining `windows[]` entries in declaration order, then team viewers; lanes are the only operator windows placed ahead of the role windows. ADR-288 §D2 uses this ADR's `windows[]` mechanism unchanged for the additional superdriver lanes `_sd2` / `_sd3`: they are ordinary operator windows — accepted by the validator (which now rejects the malformed spellings `_sd0` / `_sd1` / zero-padded `_sd01` with a `ConfigError` citing ADR-288 §D2, so an obsolete lane name fails loudly instead of degrading into a plain workspace), wanted by reconcile, never pruned, recreated after server loss — whose canonical `command` launches Claude directly with the lane identity baked in (`ATMUX_MEMBER=sd2 CLAUDE_CONFIG_DIR=… CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=… --permission-mode auto; exec zsh -i`, cwd `/Users/geoyws/work/src/atmux`; see ADR-288 §D2 for the full entry). `command: null` (bare `zsh`, §3 of this ADR) remains the alternative when the operator prefers to start Claude by hand. Either way this ADR's §3 rule holds: an existing pane is never restarted because its declared command differs.
