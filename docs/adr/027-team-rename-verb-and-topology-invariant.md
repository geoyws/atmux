# ADR-027: `atmux team rename` verb + startup topology invariant check

**Status**: shipped 2026-05-20 (EPIC e-1e223687)
**Date**: 2026-04-27
**Related**: [ADR-016](./016-single-session-topology.md) (Phase 1 single-session opt-in), [ADR-025](./025-superdriver-phase-1.md) (registry + super-* verbs — superseded for cockpit primary-key by [ADR-089](./089-recursive-cockpit-sessions.md)), [ADR-026](./026-always-single-session-topology.md) (always-single-session default), [ADR-089](./089-recursive-cockpit-sessions.md) (recursive `sessions[]` schema — registry shape supersession), [ADR-135](./135-cockpit-naming-convention.md) (cockpit window-naming — supersedes the `__<team>__*` per-pane pattern in §Decision step 3), [ADR-103](./103-team-repair-rename.md) (recovery-side sibling verb).

**Implementation**: EPIC e-1e223687 (atmux-bun port). Source surface:
- `src/verbs/team-rename.ts` — T1 helpers + arg parser + T2 dispatcher (post-T6 wires every sibling step directly): commits `c8d2c09` (T1) → `c274453` (T2) → `5d1c934` (T6 dispatcher rework).
- `src/verbs/team-rename-fs.ts` — T3 file-state steps (lock + team.json mutation + session-anchor rewrite + lock release): commits `492f1fa` (T3 content) + `1c2769f` (edge-test cover).
- `src/verbs/team-rename-cockpit.ts` — T4 cockpit registry sync (step 7, ADR-089 `sessions[]` DFS walk): content in commit `37c156d`.
- `src/verbs/team-rename-tmux.ts` — T5 tmux + branch rename (step 4 + step 8 opt-in): content in commit `492f1fa`.
- `src/verbs/team-rename-convergence.ts` — T6 post-rename invariant assertion (step 10): commit `506642b`.

**Audit note**: shared-worktree commit-race during the EPIC caused commit-message ↔ content attribution drift across `492f1fa` / `37c156d` / `a108370`. Code content is correct under every SHA; only the commit-message labels are swapped. See [docs/audit/2026-05-20-shared-index-swap.md](../audit/2026-05-20-shared-index-swap.md) for the per-commit content map + the structural lesson (file-split alone doesn't defeat the staging-race).

## Context

Three forces converge:

1. **ADR-026 just inverted the topology default** — every team is now single-session. Driver running 4 teams sees them collapse into one driver tmux session with `__<team>__<member>` window prefixes. Clean.
2. **ADR-025 introduced the registry** — `~/.claude/teams/registry.json` is the single source of truth for "what teams exist + which session they live in." Currently populated only by init/start/stop hooks.
3. **Driver wants to flatten team names** — kill the `atmux-` session prefix that legacy dedicated-session teams accumulated. Maps:
   - `atmux-kanban` (sess `atmux-atmux-kanban`) → `atmux` (sess `atmux`)
   - `myteam-alpha` (sess `atmux-myteam-alpha`) → `myteam-alpha` (sess `myteam-alpha`)
   - `myteam-beta-root` (sess `atmux-myteam-beta-root`) → `myteam-beta` (sess `myteam-beta`)
   - `myteam-c-dev` (sess `atmux-myteam-c-dev`) → `myteam-c` (sess `myteam-c`)

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

- [ADR-025: atmux-superdriver Phase 1 — read-only fleet aggregator](./025-superdriver-phase-1.md) — registry schema this verb mutates (superseded for cockpit primary-key by ADR-089 §B)
- [ADR-026: Always single-session topology](./026-always-single-session-topology.md) — fleet topology default that drives the rename map
- [ADR-016: Single-session topology — opt-in flag + Phase 2 migrate verb](./016-single-session-topology.md) — migrate verb reused by --migrate-session flag
- [ADR-089: Recursive cockpit `sessions[]` schema](./089-recursive-cockpit-sessions.md) — supersedes the flat `teams[]` registry shape used in this ADR's §Decision step 6
- [ADR-135: Cockpit naming convention](./135-cockpit-naming-convention.md) — supersedes the `__<team>__<member>` window-naming literal in §Decision step 3
- [ADR-103: `atmux team repair-rename`](./103-team-repair-rename.md) — recovery-side sibling verb

## §Deviations from spec (added at shipping time, 2026-05-20)

Implementation diverged from the §Decision shape in nine known ways. Each is benign (no semantic regression vs the OQ-resolved spec) but worth surfacing for readers who picked up the ADR mid-shipping.

### 1 — Registry shape (CRITICAL)

**Spec**: §Context line + §Decision step 6 reference `~/.claude/teams/registry.json` (flat) + `atmux::registry_deregister <old>` + `atmux::registry_upsert <new>`.

**Shipped**: superseded by [ADR-089](./089-recursive-cockpit-sessions.md) §B — flat `teams[]` lifted to recursive `cockpit.json::sessions[]` tree. T4 (`syncCockpitRegistry` in `src/verbs/team-rename-cockpit.ts`) DFS-walks `sessions[]` for the `type: "team"` node matching `oldName`; first match wins, mutates `.name = newName` in place. Legacy flat `teams[]` rosters auto-lift to canonical `sessions[]` shape on first rename via `migrateLegacyShape` (one-way migration; legacy top-level `teams` + `superdoctor` + `medic` + `sentinel` keys are stripped per the shim).

### 2 — Window naming (CRITICAL)

**Spec**: §Decision step 3 — "`tmux rename-window` per pane matching `__<old>__*` → `__<new>__*`".

**Shipped**: window-naming convention shifted via [ADR-135](./135-cockpit-naming-convention.md) + [ADR-161](./161-default-member-prefix.md). The `__<team>__<member>` literal prefix is no longer used. Today:
- Cockpit-tier team-viewer windows carry the bare `<team-name>` — T5 (`renameTeamViewerWindow` in `src/verbs/team-rename-tmux.ts`) renames these in place.
- Per-member windows carry `<emoji>-<member>` or `<emoji>_<member>` (default member) — no team-name in the window name; NOT touched by rename.
- Cockpit-role windows carry `_<role>` (`_lead`, `_planner`, …) per ADR-135 — no team-name; NOT touched.
- Epic-viewer windows carry `🌳-<epicId>` — no team-name; NOT touched.

### 3 — Per-team `sessionName` storage

**Spec**: §Decision step 6 implied the registry stores `sessionName` per team.

**Shipped**: ADR-089's `sessions[]` schema does NOT store a per-team `sessionName` field on team nodes. The runtime session-name lives in `<projectRoot>/.atmux/state/session.txt` (T3's `rewriteSessionAnchor` mutates this); cockpit consumers DERIVE the session-name via `src/core/cockpit.ts::cageSessionName(teamName)`. T4's `syncCockpitRegistry` accepts `newSession` for signature symmetry but does NOT mutate the on-disk cockpit.json.

### 4 — Per-member branch rename (step 8)

**Spec**: §Decision steps 1–8 listed 7 orchestration steps; per-member branch rename was not in the original spec.

**Shipped**: T5 (`renamePerMemberBranches` in `src/verbs/team-rename-tmux.ts`) ships step 8 behind a NEW opt-in flag `--force-branches`. Default OFF — most renames within ADR-026 single-session topology don't touch per-member branches; the flag is for the rare full-flatten case (legacy `<old>-<member>` → `<new>-<member>` rewrite + atomic-multi-ref remote push with per-branch fallback).

### 5 — Implementation file split

**Spec**: §Consequences — "`lib/team-rename.sh` (new) — orchestrator + rollback engine + dispatcher entry. ~150 LOC."

**Shipped**: shared-worktree commit-race during EPIC e-1e223687 (sibling Write clobber + outbound index absorption) forced a structural file split:
- `src/verbs/team-rename.ts` — T1 helpers + T2 dispatcher (with T6 wire-in of every sibling step).
- `src/verbs/team-rename-fs.ts` — T3 file-state steps.
- `src/verbs/team-rename-cockpit.ts` — T4 cockpit registry sync.
- `src/verbs/team-rename-tmux.ts` — T5 tmux + branch rename.
- `src/verbs/team-rename-convergence.ts` — T6 post-rename invariant assertion.

Total surface ~1100 LOC across 5 files vs the spec's 150 LOC estimate. Higher than spec because the spec under-counted coverage of refuse-gates + DFS walk + rollback-step composition + integration-test surface.

### 6 — Bash → Bun migration

**Spec**: bash references (`lib/team-rename.sh`, `lib/whip.sh`, `lib/super-status.sh`, `lib/doctor.sh`, `tests/unit/team_rename.bats`).

**Shipped**: atmux-bun port complete ([ADR-060](./060-sqlite-state.md) + [ADR-076](./076-inbox-on-sqlite.md) + cluster). TypeScript with Bun runtime; Zod schemas; `bun:test`. `lib/super-status.sh` → `src/verbs/sentinel.ts` (renamed via [ADR-158](./158-martinet-to-sentinel-rename.md)). `lib/whip.sh` + `lib/decisions.sh` were CONSOLIDATED into sentinel + other verbs during the port and don't exist as standalone bun files — see §Deviation 8 for the implication for cron-consumer guards.

### 7 — OQ resolutions

All six §Open questions were resolved in spec. Shipped impl honors each resolution except where noted:
- **OQ H1**: APPENDED Se/Sf/Sg letters — impl collapsed to T1–T7 under single EPIC e-1e223687 (Story-letter mapping dropped during planner decomposition; not load-bearing).
- **OQ H2**: 4 separate Tasks for bulk-rename — out of scope for this EPIC; deferred to a follow-up operational sweep.
- **OQ H3**: install-new-then-remove-old cron order — T2 honors via `installCronBlock`'s `stripByAtmuxDir` pass.
- **OQ H4**: file-based `<projectRoot>/.atmux/state/rename.lock` — T3 creates the lock; consumer-side honor is **complete** (see §Deviation 8 for the file:line refs).
- **OQ H5**: Sg REVIEW Task — out of scope (bulk-rename deferred per OQ H2).
- **OQ H6**: `--migrate-session` opt-in — out of scope for v1; not implemented. Deferred to a follow-up Task.

### 8 — Cron-consumer rename-lock guards (COMPLETE)

**Spec**: §Consequences — every cron'd consumer (whip / super-status / cron orphan-detect / decisions digest) adds `[[ -f rename.lock ]] && return 0` at entry. ~3 LOC each.

**Shipped**: T3 (`team-rename-fs.ts::acquireRenameLock`) creates the lock file; ADR-027 follow-up Task t-f0adc3bc (2026-05-20) wired the consumer-side guards via a shared `isRenameInProgress(atmuxDir)` helper exported from `src/verbs/team-rename-fs.ts`:

- **`src/verbs/sentinel.ts` perTeamTick** (formerly `lib/super-status.sh`) — checks `team.root + "/.atmux"` per team iteration; skip-and-log returns a `skipped-rename-in-flight` state row so `allSettled` gather treats it as fulfilled.
- **`src/verbs/cron-orphans.ts` verb entry** (orphan-detect path) — cwd-walks via `hasTeam()` + `getAtmuxDir()`; emits `[]` and returns 0 when the resolved team is mid-rename. Null cwd (cockpit-wide invocation) falls through to the regular scan.
- **`src/verbs/pulse.ts` per-team loop** (consolidated whip-verdict path post bun port) — checks `team.root + "/.atmux"` per team; skip-and-log + `continue` excludes the team from this tick's observations.
- **`src/verbs/discorder.ts` verb entry** (consolidated decisions-digest path post bun port) — checks the resolved `atmuxDir` after pre-flight; logs and returns 0 before the per-subverb single-instance lock is acquired.

Race risk eliminated: sentinel ticks / cron orphan-detect / pulse verdicts / discorder digests now skip silently during an in-flight rename — matching the bash `[[ -f rename.lock ]] && return 0` semantics across every consolidated post-port consumer. T6's convergence helper continues to assert post-rename hygiene (lock cleaned up); the consumer guards close the mid-rename window.

Notes:
- `src/verbs/whip.ts` + `src/verbs/decisions.ts` remain absent in the bun port — see §Deviation 6. `pulse` + `discorder` are the consolidated heirs; both are now guarded.
- The `isRenameInProgress` helper is fail-open (returns `false` on fs errors) — the read-side guard never blocks a tick on a misread; worst case is the pre-ADR-027 baseline.

### 9 — Topology invariant check (deferred)

**Spec**: §Decision second half — startup topology invariant check in `lib/doctor.sh` + `lib/start.sh` + `lib/up.sh` preflight.

**Shipped**: NOT in this EPIC. T6's `verifyConvergence` (`src/verbs/team-rename-convergence.ts`) covers POST-rename invariant assertion — drift detection at `atmux doctor` time + the verb-internal post-rename check — but the `lib/start.sh` + `lib/up.sh` preflight refuse-on-red gate was deferred. Adjacent: [ADR-186](./186-wedge-clearing-mechanism.md) covers some overlapping drift-detection surface via doctor probes; the full preflight-refuse pattern remains an open follow-up.
