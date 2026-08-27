# ADR-250: orchd stale-epic-team reaper — close the spawn-without-reap leak

**Status**: accepted
**Date**: 2026-05-29
**Driver-ref**: operator session 2026-05-29 — "orchd is leaking, growing RAM". Triage found orchd's own RSS steady at ~4MB; the growth was **136 `claude` TUIs ≈ 43.6 GB** across accumulated epic-team cages (sopx ×17, mx ×7, unum ×3, …) that were spawned but never dissolved.

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-280](280-epic-team-retirement-and-staged-excision.md).** Epic-teams are retired: the `epic-team` cage type, the `epicId` cockpit field and the epic verbs no longer exist. This ADR is kept as history — the decision it records was true when made. Do not implement from it.

## Context

orchd spawns epic-teams on `epic.ready` / `epic.unblocked` (`src/core/orchd-spawn.ts`), and the 5-min `--sweep` backstop (`src/core/orchd-sweep.ts`) re-spawns missed ones. **Dissolution only fires on the happy path**: `task.done → … → epic.merged → epic.pushed →` the `atmux:orchd:auto-dissolve` consumer. An epic-team that is spawned but **never reaches merge** — stuck, idle, abandoned, never-started — is **never reaped**. Its tmux cage (driver + members, each a `claude` TUI) lives forever.

Two aggravating facts:

1. The Rust supervisor (`rust/atmux-orchd/src/main.rs`) fires `--sweep-merges`, `--scan-context`, `--scan-budget`, `--housekeep` on timers but **never fires `--sweep`** — so even the backstop walker (`orchdSweep`) isn't scheduled. Nothing systematically looks at spawned-but-unfinished epic-teams.
2. `--housekeep` (`orchd-housekeep.ts`) prunes *DB rows* (old events, stale offsets, terminal merger_state, rotated logs) — it does **not** touch tmux cages, worktrees, or cockpit registrations.

Net: spawn is automatic and continuous; reap is conditional on a clean finish. The asymmetry is the leak.

## Decision

Add a **stale-epic-team reaper** (`src/core/orchd-reap.ts::reapStaleEpicTeams`) that walks spawned epic-teams and classifies each by **cage liveness**, then acts per class. Reusing `performDissolveEpic` ([ADR-090](090-epic-team-lifecycle.md) / [ADR-219](219-dissolve-epic-completeness.md)) for the actual teardown — the reaper does NOT re-implement dissolve.

### (D1) Two classes, two actions

| Class | Condition | Action | Why safe |
|---|---|---|---|
| **dead-cage orphan** | `spawned_at` set + cockpit epic-team entry present + **no live tmux session** on the epic's cage socket | **auto-reap** via `performDissolveEpic({ epicId })` | the cage is already gone → no live work to destroy; this is pure cleanup (cockpit entry + worktree prune + merged-branch delete + epic row marked) |
| **live-but-idle** | `spawned_at` set + cockpit entry + **live tmux session** + no progress ≥ `staleThresholdSec` | **escalate only** (emit to lead via the injected `escalate` seam) — NEVER auto-kill | killing a live cage can destroy in-progress work; the lead decides. Doctrine: escalate, don't auto-destroy. |
| live + active | live session + recent progress | skip | — |

Auto-killing the **live-idle** class is gated behind an explicit opt-in (`ATMUX_ORCHD_REAP_LIVE_IDLE=1`, default OFF) and is **not wired in this ADR** — it ships only after the operator sets a staleness threshold they trust. Until then, live-idle is escalate-only.

### (D2) Invocation — phased

- **Now (this ADR)**: the tested, dep-injected core `reapStaleEpicTeams` + its conservative safe defaults (see §D5). No operator-facing surface is wired yet — deliberately. A CLI backed by a *stub* enumerator would be a misleading no-op, and a CLI backed by a *hand-rolled* per-epic-socket liveness check risks misclassifying a live cage as dead and **destroying live work** — the one failure this whole design exists to prevent.
- **Next wire**: `atmux orchd --reap-stale [--team-dir <p>] [--dry-run]` together with the real enumerator (`listSpawnedEpicTeams`) + liveness (`isCageAlive`). NOTE ([ADR-251](251-epic-cage-socket-resolution.md)): the liveness probe MUST resolve the socket via `resolveTeamSocket(childTeam)` from the epic's `team.json` `tmuxTmpdir` — `resolveCageSocket(epicId, epicRoot)` reports **live** epic cages as dead and would auto-reap them. Fail-closed when `tmuxTmpdir` is missing (treat alive). `SpawnedEpicTeam.cageSocket` carries the resolved socket; `isCageAlive(team)` takes the team. `--dry-run` prints the classification without acting.
- **Automatic / final phase**: a Rust supervisor tick (`spawn_reap_stale`) on the sweep cadence, mirroring `spawn_sweep_merges`. Deferred until the dead-cage class has run clean via the manual CLI for a cycle (destructive-adjacent timers earn their place).

### (D5) Safe defaults — fail closed

The shipped core's enumerator/liveness seams default to conservative no-ops so the un-wired default can never destroy anything: `listSpawnedEpicTeams → []` (considers nothing), `isCageAlive → true` (unknown liveness ⇒ treated ALIVE ⇒ never reaped), `isCageStaleIdle → false` (never escalates). Only the *action* seams are real defaults (`dissolve → performDissolveEpic`, `escalate → log-only`). Tests inject all five seams to exercise every branch.

### (D3) Safety gates (inherited, not re-implemented)

The dead-cage reap calls `performDissolveEpic` with default checks. For a dead cage `childTeam` resolves to null → its all-tasks-done + clean-worktree gates auto-skip (the cage DB is unreachable); worktree prune is `skip`-on-dirty by default, so a dead-cage orphan with an uncommitted worktree is **refused, not force-pruned** — surfaced to the operator, never silently destroyed. `--force-prune` stays an explicit operator escalation.

### (D4) Dep-injection seam

`reapStaleEpicTeams(atmuxDir, deps)` takes every cross-module call as an injectable: `listSpawnedEpicTeams`, `isCageAlive`, `isCageStaleIdle`, `dissolve`, `escalate`. Production passes real impls; tests pin each for deterministic counter assertions — the same pattern as `orchdSweep` (`OrchdSweepDeps`). Failure isolation matches `orchdSweep`: a thrown per-epic action is caught + counted, never halts the walk, never retries (anti-retry-storm, [ADR-231](231-orchd-rust-dispatcher.md)).

## Consequences

- **Closes the leak's structural cause**: dead-cage orphans no longer accumulate. Pairs with the singleton guard ([ADR-249](249-orchd-singleton-guard.md)) which stops *duplicate* spawns at the source.
- **Does NOT, by itself, free the live-idle RAM** (e.g. the 2026-05-29 sopx/mx/unum cages): those cages are alive, so the reaper escalates rather than kills. Immediate relief for already-accumulated live-idle cages is an operator-driven `atmux team dissolve-epic` per cage (cross-team → ping first).
- **Code**: new `src/core/orchd-reap.ts` + `tests/unit/core/orchd-reap.test.ts`; new `--reap-stale` branch in `src/verbs/orchd.ts`. Rust supervisor tick deferred (D2).
- **Out of scope**: auto-killing live cages (gated, off, future); reaping non-epic teams (regular-team decommission is [ADR-248](248-atmux-team-remove-verb.md)'s `atmux team remove`); cross-cage reaping ([ADR-232](232-cross-cage-dispatch.md) dispatcher territory).

## Amendment 2026-06-04 — §D2 "Next wire" phase shipped (`--reap-stale` + real enumerator/liveness)

The §D2 "Next wire" phase is now implemented (unblocked by [ADR-251](251-epic-cage-socket-resolution.md)'s socket-resolution fix):

- **`atmux orchd --reap-stale [--team-dir <p>] [--dry-run]`** (`src/verbs/orchd.ts::orchdReapStaleCli`) — injects the production enumerator + liveness into `reapStaleEpicTeams`; `dissolve`/`escalate` keep the core defaults (`performDissolveEpic` / stderr-log).
- **Production enumerator + liveness** (`src/core/orchd-reap-enum.ts`):
  - `listSpawnedEpicTeamsForTeam(atmuxDir)` — derives the team's repo root from `atmuxDir`, walks the cockpit `sessions[]` for `type:"epic-team"` nodes whose nearest-ancestor team root matches, reads each child's `team.json` (`<root>-epics/<epicId>/.atmux/team.json`), and resolves `cageSocket` via `resolveTeamSocket(tmuxTmpdir)` (NEVER `resolveCageSocket` — ADR-251). `epicId` = cockpit node name (the id `performDissolveEpic` matches on). Absent/`tmuxTmpdir`-less team.json ⇒ `cageSocket = ""`.
  - `isCageAliveForTeam(team)` — fail-closed: empty `cageSocket` ⇒ ALIVE (tmux never probed); a resolvable socket with no live session (`has-session` exits 1) ⇒ `false` (dead-cage); probe throw ⇒ ALIVE. The exact-match `=` prefix mirrors `defaultCageTeardown`.
- **`--dry-run` validated live** (2026-06-04): atmux 0 (already clean), sopx 5 considered → 4 `live-active` (incl. the 3 ADR-251 cages the old resolver mis-reported dead) + 1 dead-cage orphan (`e-c632065e`), unum 3 + mx 2 all `live-active`, `errors=0`. Confirms the liveness verdict is correct against real cockpit + real sockets.
- **Still deferred** (unchanged): the automatic Rust-supervisor `spawn_reap_stale` tick (§D2 final phase) — earns its place only after the manual CLI's dead-cage class has run clean for a cycle; and live-idle auto-kill (§D1, `ATMUX_ORCHD_REAP_LIVE_IDLE`, off).
- **Tests**: `tests/unit/core/orchd-reap-enum.test.ts` (enumerator walk/filter/socket-resolution + fail-closed liveness, all IO seams injected); `--reap-stale`/`--dry-run` parser cases in `tests/unit/verbs/orchd.test.ts`.
