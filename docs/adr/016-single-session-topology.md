# ADR-016: Single-session topology — opt-in flag + Phase 2 migrate verb

**Status**: superseded by [ADR-026](./026-always-single-session-topology.md) (default policy only — Phase 1 implementation surface and Phase 2 migrate verb stand)
**Date**: 2026-04-26

> **Note 2026-04-27**: ADR-026 inverts the default — single-session becomes the *only* mode the wizard creates; `team.json:.singleSession=false` retained as a declared escape hatch. The opt-in flag, refuse-gate, window-name normalisation, and migrate verb described below remain in force. See [ADR-026](./026-always-single-session-topology.md) for the policy pivot.

## Context

`atmux start <team>` today creates a dedicated tmux session named `atmux-<team>` (lib/common.sh:175 — `atmux::session_name`). Production the-host has accumulated three sessions for three teams: driver `atmux` (7 windows) + `atmux-atmux-kanban` (7) + `atmux-myteam-alpha` (12) = 26 windows across 3 sessions. Symptoms:

- `tmux ls` is polluted with `atmux-*` entries that aren't user-attachable.
- Team-switch is a session-hop (Ctrl+B s) instead of a window-hop (Ctrl+B w) — disrupts driver flow.
- New users discover the dedicated session model only after `tmux ls` surprises them.

Driver request 2026-04-26 23:21 MYT: support spawning members into the driver's existing tmux session. Three options:

- **Option A (chosen):** opt-in flag — `team.json:.singleSession=true` OR `ATMUX_DRIVER_SESSION=1` env at start. New teams w/ flag spawn into driver session. Existing teams untouched.
- **Option B (rejected):** flip default — every new team is single-session unless opted out. Too aggressive; breaks every existing user's mental model.
- **Option C (rejected):** dual-permanent — both modes always supported with neither as default. Doubles maintenance surface; documents nothing.

## Decision

**Phase 1 (Story Sa):** opt-in flag. The architectural pivot lives in `atmux::session_name` (lib/common.sh:175):

```bash
atmux::session_name() {
  local stored="$(atmux::dir)/state/session.txt"
  [[ -f "$stored" ]] && { cat "$stored"; return; }
  local single="$(jq -r '.singleSession // false' "$(atmux::team_json)" 2>/dev/null || echo false)"
  [[ "$single" == "true" || -n "${ATMUX_DRIVER_SESSION:-}" ]] && \
    atmux::die "single-session enabled but no .atmux/state/session.txt — run 'atmux start' to seed"
  echo "atmux-$(atmux::team_name)"
}
```

Modify ONE helper; 14+ callers (`atmux::tmux_target`, `atmux::tmux_session_exists`, lib/start.sh, lib/stop.sh, lib/send.sh, lib/rotate.sh, lib/dispatch.sh, lib/whip.sh, lib/reload.sh, lib/attach.sh, lib/status.sh, lib/up.sh, lib/add-member.sh) propagate without code change.

`atmux start` writes `.atmux/state/session.txt` from `tmux display-message -p '#S'` capture when single-session is active. `atmux stop` kill-windows per member (NOT kill-session) — with hard refuse-gate aborting if computed kill target == driver's `$TMUX` session.

Window-name placeholder `__atmux__home` → `__<team>__home` to prevent cross-team collision in shared session.

`atmux init --wizard` surfaces the flag at team-create time (default false; preserves legacy behavior). `atmux doctor` detects orphan `atmux-<team>` sessions when `team.json:.singleSession=true` and suggests Phase 2's migrate verb.

**Phase 2 (Story Sb):** `atmux migrate-to-driver-session <team>` verb. Driver runs manually during quiet windows. Pre-flight pane-state precondition refuses on `thinking with` / `Compacting conversation` / `Press up to edit queued messages` / rate-limit banner / modal prompt / non-empty compose buffer. `tmux move-window` per member preserves running Claude processes. Cleanup gate kills the (now empty) `atmux-<team>` session ONLY after verifying zero windows remain.

## Consequences

- **Backward compat HARD.** Teams without the flag and without the state file behave identically to today. Test 1 in `tests/unit/single_session.bats` is the regression guard.
- **One refactor surface** at `atmux::session_name`. All 14+ callers transparently flip topology — no duplicate session-resolution logic.
- **Refuse-gate at stop is non-negotiable.** A bug that resolves the stop target to the driver's session would kill the driver shell. `atmux::die` short-circuits before any kill operation.
- **Window-name normalisation** is a one-time convention change. Per-team prefix `__<team>__home` is the canonical placeholder name post-merge.
- **Phase 2 ships in the same Epic** but driver runs the verb manually per team during quiet windows — atmux-kanban + myteam-alpha will NOT live-migrate from this Epic's promote.
- **Rollback:** revert Phase 1's atmux::session_name branch; teams resolve back to literal `atmux-<team>` names. State files become inert; new starts use legacy topology. Phase 2 verb is additive; revert is `git rm lib/migrate.sh`.

### Risk register (from driver's body)

1. **Killing driver shell** → hard refuse-gate at lib/stop.sh.
2. **Window-name collisions** → per-team prefix on all `__<team>__*` names.
3. **Pos-number assumptions** → audited; no literal `:0`/`:1` targeting found in lib/whip.sh or briefs (windows are name-keyed throughout).
4. **Active-work migration** → Phase 2 pane-state precondition non-negotiable.
5. **Multi-driver scenarios** → `.atmux/state/session.txt` is canonical; later attaches read-only via `tmux switch-client -t <stored>`. Out of scope for this Epic.

## Open questions

1. **Should `atmux start --force` work under single-session?**
   *Resolved (planner default, low-reversibility):* No — refuse with `atmux::die`. `--force` today does `tmux kill-session` first, which would nuke driver shell. Revisit if a per-team window-clear `--force-windows` mode is requested.

2. **Window-name placeholder: per-team prefix or drop the placeholder?**
   *Resolved (planner default, low-reversibility):* keep with per-team prefix (`__<team>__home`). Removing the placeholder would break new-session creation flow under legacy topology (tmux requires at least one window). Per-team prefix is the minimal change.

3. **Migrate verb: support reverse direction (single → dedicated)?**
   *Resolved (planner default, low-reversibility):* No. Defer to a separate verb if requested. The forward direction (dedicated → single) covers the surfaced UX gap; reverse would only matter if a user accidentally migrated.
