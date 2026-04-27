# ADR-027: `atmux team rename` verb + startup topology invariant check

**Status**: accepted
**Date**: 2026-04-27
**Related**: [ADR-016](./016-single-session-topology.md) (Phase 1 single-session opt-in), [ADR-025](./025-superdriver-phase-1.md) (registry + super-* verbs), [ADR-026](./026-always-single-session-topology.md) (always-single-session default).

## Context

Three forces converge:

1. **ADR-026 just inverted the topology default** — every team is now single-session. Driver running 4 teams sees them collapse into one driver tmux session with `__<team>__<member>` window prefixes. Clean.
2. **ADR-025 introduced the registry** — `~/.claude/teams/registry.json` is the single source of truth for "what teams exist + which session they live in." Currently populated only by init/start/stop hooks.
3. **Driver wants to flatten team names** — kill the `atmux-` session prefix that legacy dedicated-session teams accumulated. Maps:
   - `atmux-kanban` (sess `atmux-atmux-kanban`) → `atmux` (sess `atmux`)
   - `sopx-mvp` (sess `atmux-sopx-mvp`) → `ifca_sopx` (sess `ifca_sopx`)
   - `aix-root` (sess `atmux-aix-root`) → `ifca_aix` (sess `ifca_aix`)
   - `geoyws-beads` (sess `atmux-geoyws-beads`) → `unum_beads` (sess `unum_beads`)

Today there is no atomic team-rename surface. Doing the rename by hand requires:

- jq-edit `team.json:.name`
- `tmux rename-window` per pane matching `__<old>__*`
- rewrite `state/session.txt` for singleSession teams
- re-install crontab block under new marker `# atmux:team=<new>` and remove old
- update registry primary key (`atmux::registry_deregister <old>` + `atmux::registry_upsert <new>`)
- chase down any other team-name reference (Discord webhook header — actually computed dynamically from team.json:.name, so this falls out for free)

Each step has failure-mode windows (mid-rename pane prefix mismatch; cron orphan if old marker not removed; concurrent whip tick writing to old name's outbox during the window). A verb wraps the whole thing in a refuse-gate + atomic staging + rollback script.

Topology invariant check is the natural complement: now that registry tracks `sessionName` and the fleet expects every team to live in its registered session, drift becomes detectable. `atmux doctor` surfaces drift; `atmux start` / `atmux up` refuse to spawn on hard mismatch.

## Decision

### `atmux team rename <old> <new> [--session <new-session>] [--migrate-session] [--force]`

**Pre-flight refuse-gate** (any one of these → refuse with clear error):

- Any kanban Task with `status=="in-progress"` → refuse (mid-flight work would land in indeterminate naming state).
- `<new>` already exists in registry → refuse (collision).
- `<new>` invalid (non-`[a-z0-9_-]+`) → refuse.
- `--force` overrides the in-progress refuse only (collision + invalid stay hard refuse).

**Orchestration sequence** (each step rollback-staged; partial failure invokes rollback in reverse order):

1. **Set `ATMUX_RENAME_IN_PROGRESS=1`** in a state file (`<projectRoot>/.atmux/state/rename.lock`). All cron'd consumers (whip, super-status, decisions digest) check this at entry and return 0 silently. Per OQ H4 — env-gate is simpler than per-process flock.
2. **jq-edit team.json:.name** = new. Backup at `team.json.bak.<epoch>`.
3. **tmux rename-window** per pane matching `__<old>__*` → `__<new>__*`. Single batched script via `tmux list-windows -t <session> -F '#{window_id} #{window_name}'` + per-match rename. If session itself needs rename (`<new-session>` differs from current sessionName), do `tmux rename-session -t <old-session> <new-session>` first.
4. **state/session.txt rewrite** if file present (singleSession teams) — write new sessionName.
5. **Cron re-install** with NEW marker (per OQ H3 — install-new-then-remove-old order; avoids zero-cron window). Calls `atmux::cron_install <new> <projectRoot>` first; verifies new block present in `crontab -l`; THEN calls `atmux::cron_remove <old>`. If install-new fails, abort + rollback (don't leave team with no cron).
6. **Registry update** — `atmux::registry_deregister <old>` + `atmux::registry_upsert <new> <projectRoot> <new-session>`. createdAt is preserved on the new entry (rename, not re-init).
7. **Clear `ATMUX_RENAME_IN_PROGRESS`** state file.
8. Return success.

**Rollback** (on partial failure at any step ≥2):

- Reverse the completed steps in order: cron re-remove → state/session.txt restore → tmux rename-window back → tmux rename-session back → team.json restore from backup → registry rollback → clear lock file.
- Rollback log written to `<projectRoot>/.atmux/state/rename-rollback.log` for operator inspection.

**`--migrate-session` flag** — when set AND `--session <new-session>` differs from current session, AND we want to MOVE windows (not just rename current session). Invokes the existing `atmux migrate-to-driver-session` verb path (ADR-016 Phase 2) for the per-window move. Needed for legacy dedicated-session → driver-session consolidation case.

**Historical entries NOT rewritten** — kanban.json, lead-outbox.md, driver-inbox.md, decisions.md retain old team-name references in archived entries. Archive-don't-rewrite. New entries use new name. Operator can grep for old name in archive layer if needed.

**`.atmux/` directory NOT moved** — pinned to projectRoot, not team name. Team rename does not touch the filesystem layout.

### Startup topology invariant check

**`lib/doctor.sh`** gains `_doctor_check_topology_invariant`. For each registry entry with `status="running"`:

- Assert `tmux has-session -t <registry.sessionName>` succeeds.
- Assert `tmux list-windows -t <session> -F '#{window_name}' | grep -c "^__<team>__"` matches expected member count (read from `<projectRoot>/.atmux/team.json:.members | length`).
- For superdriver: if `registry` has a `superdriver` entry (or canonical `atmux-superdriver` session expected), assert it exists.

Drift severity:
- **Wrong session-name match** (members live in different session than registry says) → red row + suggest `atmux team rename <team> --session <actual> --migrate-session` OR `atmux team rename <team> --session <registry.sessionName>`.
- **Window count mismatch** (members[] count ≠ matched windows) → yellow row + suggest member-by-member audit.
- **Superdriver expected but absent** → red row + suggest `atmux super-attach`.

**`lib/start.sh` + `lib/up.sh` preflight** — invoke topology invariant check; if `red` (hard mismatch) → refuse with the doctor row content + suggestion. `--force` overrides. Standalone `atmux doctor` invocation does NOT refuse (just reports the row); refuse-gate applies only to start/up.

### Bulk-rename Story (Sg) — operational application

Four sequential rename Tasks (driver-fire), one per team in the rename map. Each is an OPS Task using the verb shipped in Se. Pattern:

```bash
atmux --team-dir /root/work/src/atmux team rename atmux-kanban atmux --session atmux
```

Sequence per Task: stop ambient activity (driver judgment) → fire rename → verify new state via `atmux doctor` + `tmux list-windows` → resume.

## Consequences

- **`lib/team-rename.sh`** (new) — orchestrator + rollback engine + dispatcher entry. ~150 LOC.
- **`lib/whip.sh` + `lib/super-status.sh` + `lib/cron.sh` (orphan-detect path) + `lib/decisions.sh` (digest path)** — add `[[ -f "$(atmux::state_dir)/rename.lock" ]] && return 0` guard at entry. ~3 LOC each.
- **`lib/doctor.sh`** — new check function + main wiring. ~40 LOC.
- **`lib/start.sh` + `lib/up.sh`** — invoke invariant check in preflight + refuse-on-red unless `--force`. ~6 LOC each.
- **`tests/unit/team_rename.bats`** (new) — full rename + refuse-gate (in-progress + collision + invalid) + cron migration order + registry update + rollback + window-rename atomicity.
- **`tests/unit/topology_invariant.bats`** (new) — drift detection (3 severities) + start/up refuse + --force override.
- **`README`** — `atmux team rename` section + topology invariant section + sample doctor output + bulk-rename runbook.
- **No impact on E9** — no shared code surface.
- **Cron-rename safety preserved**: install-new-then-remove-old (per OQ H3) means there's no window where the team has zero cron coverage. Worst case: brief overlap where both old + new markers are live; operator-tolerable (whip is single-instance flock-guarded so duplicate fires no-op).
- **Registry primary-key update is destructive** — old entry deregistered (status='stopped' per ADR-025 history-preserving discipline), new entry created. Old entry NOT deleted — history preserved.
- **Rollback completeness**: rollback log captures attempted steps for operator inspection. Rollback is best-effort; some terminal states (e.g. tmux session dies mid-rename) require manual recovery — log informs operator.

## Open questions

1. **OQ H1 (low): letter mapping — append Se/Sf/Sg or renumber to align with driver's letters?** Resolved: APPEND. Keep Sa-Sd intact (no kanban subject churn). New Stories: Se (rename verb), Sf (invariant check), Sg (bulk-rename one-shot).
2. **OQ H2 (low): bulk-rename ordering — 4 separate Tasks under Sg or one batch Task?** Resolved: 4 separate Tasks (1 per team in the rename map). Each pre-flight + auditable; driver fires sequentially. Plus 1 Sg REVIEW Task that verifies post-rename state across all 4 teams.
3. **OQ H3 (medium): cron marker change order — install-new-then-remove-old vs remove-old-then-install-new?** Resolved: install-new-then-remove-old. Avoids zero-cron-coverage window. Worst case: brief overlap (both markers live for ~ms); whip is flock-guarded so duplicate fires no-op.
4. **OQ H4 (low): whip pause during rename — flock vs ATMUX_RENAME_IN_PROGRESS env-gate?** Resolved: file-based lock at `<projectRoot>/.atmux/state/rename.lock`. Cron'd consumers (whip, super-status, decisions digest, lib/cron orphan-detect) check at entry and return 0. Simpler than per-process flock; no contention because consumers are read-only on the lock file.
5. **OQ H5 (low): Sg REVIEW Task — needed for OPS-only Story?** Resolved: yes. Single REVIEW Task verifies post-rename state across all 4 teams (registry consistency, doctor green, no orphan cron blocks, kanban grep for old name only in archived entries).
6. **OQ H6 (medium): --migrate-session flag default behavior?** Resolved: opt-in (must be explicitly passed). Most renames within ADR-026 single-session topology don't need to move windows between sessions — just rename in place. The migrate path is for legacy dedicated-session → driver-session consolidation. Safer to require explicit opt-in than auto-migrate on every rename.

All resolutions logged to `.atmux/decisions.md`.

## References

- [ADR-025: atmux-superdriver Phase 1 — read-only fleet aggregator](./025-superdriver-phase-1.md) — registry schema this verb mutates
- [ADR-026: Always single-session topology](./026-always-single-session-topology.md) — fleet topology default that drives the rename map
- [ADR-016: Single-session topology — opt-in flag + Phase 2 migrate verb](./016-single-session-topology.md) — migrate verb reused by --migrate-session flag
