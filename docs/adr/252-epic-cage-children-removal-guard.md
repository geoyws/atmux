# ADR-252: parent-tmpdir removal must never orphan live epic-team children — `hasLiveEpicChildren` structural guard

**Status**: accepted
**Date**: 2026-06-04
**Driver-ref**: P0 kanban task t-65bec10b — a cleanup/probe once wiped `/tmp/atmux-<parent>/` wholesale when the parent team's OWN socket looked dead, taking its live epic-team children with it (2026-05-17 incident).

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-280](280-epic-team-retirement-and-staged-excision.md).** Epic-teams are retired: the `epic-team` cage type, the `epicId` cockpit field and the epic verbs no longer exist. This ADR is kept as history — the decision it records was true when made. Do not implement from it.

## Context

Epic-team cages live on disk at `/tmp/atmux-<parent>/epics/<epicId>/tmux-<uid>/default` (ADR-090 §Disk layout; `spawn-epic.ts` §S2 writes the child `team.json` with `tmuxTmpdir = /tmp/atmux-<parent>/epics/<epicId>`, and the live socket is `<tmuxTmpdir>/tmux-<uid>/default` per ADR-251 / `resolveTeamSocket`). atmux owns this tmux infrastructure end-to-end (ADR-162).

The hazard: the parent directory `/tmp/atmux-<parent>/` can exist **only because of its children** — specifically when the parent team itself uses a legacy project-local socket (its own socket lives elsewhere). A cleanup/probe that asks "is there a live tmux server at the parent's expected socket?" gets a (correct) "no", concludes the whole `/tmp/atmux-<parent>/` directory is an orphan, and `rm -rf`'s it — destroying the live epic-team children nested under `epics/*`. The 2026-05-17 incident orphaned live cages this way: parent socket probed dead ⇒ wholesale removal ⇒ running children (their claude TUIs, worktrees-of-record, registrations) gone.

### The exact 2026-05-17 culprit is NOT in this repo today

Every in-tree removal path was traced; NONE wholesale-`rm` a parent tmpdir on a parent-only-dead signal as of 2026-06-04:

- **`src/core/groom.ts::sweepZombieTmuxSockets`** — its fixture-shape regex `/^atmux-(cockpit-)?[^/]+-[^/]+$/` requires a trailing mkdtemp `-suffix`, which **excludes** the canonical parent dir `/tmp/atmux-atmux` (no trailing-hyphen segment). It cannot reach the canonical parent dir today.
- **`src/core/reap.ts`** — no wholesale parent-tmpdir `rm`.
- **`src/core/orphan-detector.ts`** — only flags ALIVE *unregistered* cages; its reap-hint is `kill-server`, never `rm -rf`.
- **`src/core/cursor-recipes/*`** — no parent-tmpdir wipe.

So the exact culprit lives in an older path or in operator dotfiles (out of this repo's tree). This ADR therefore targets **structural prevention of the CLASS**, regardless of which path is the culprit: any current or future removal path that could wipe a parent tmpdir must first refuse when a live epic child exists under it.

## Decision

Add a pure, dependency-injected guard `hasLiveEpicChildren(parentTmpdir, deps)` in a focused new module `src/core/epic-cage-children.ts`. It:

1. Lists `<parentTmpdir>/epics/*` (each entry is an epicId dir).
2. For each child, resolves the cage socket `<parentTmpdir>/epics/<epicId>/tmux-<uid>/default` — the same `<tmuxTmpdir>/tmux-<uid>/default` scheme `resolveTeamSocket` builds (ADR-251), since an epic cage's `tmuxTmpdir` IS `<parentTmpdir>/epics/<epicId>`. `uid` defaults to `process.getuid?.() ?? 0`, injectable via `deps`.
3. Probes liveness via `createTmux({ socketPath }).session.listSessions()` and treats `length > 0` as a live cage. A cage tmux server is single-purpose by ADR-018 (one cage = one server), so a non-empty session list IS a live cage. tmux returns `[]` (not a throw) for a down server, so a genuinely-dead cage reads as zero sessions.
4. Returns `true` if ANY child cage is live.

### Liveness-signal choice (`listSessions().length > 0`, not exact `has-session`)

`isCageAliveForTeam` (ADR-250/251) and `defaultCageTeardown` (ADR-090) probe an EXACT session name with `has-session(=<name>)` because they hold the child's authoritative cage session name (from the child `team.json`). This guard deliberately does NOT — a wholesale-removal probe may not have loaded each child `team.json`, and a remnant may lack one. "Any session alive on this cage socket" is the simplest correct signal for the question this guard answers — *"would removing this parent dir orphan a running cage?"* — and is sound given one-cage-one-server (ADR-018).

### FAIL-SAFE direction (mirror of the reaper, same safety direction)

The ADR-250 reaper's `isCageAliveForTeam` is **fail-closed-to-ALIVE**: on any uncertainty (unknown `tmuxTmpdir`, probe throws) it returns ALIVE so it never reaps a cage it couldn't honestly probe. This guard is the **mirror image — fail-SAFE-to-TRUE**: on genuine uncertainty (the `epics` dir exists but cannot be listed — permission denied, a file where a dir was expected — or a per-child probe throws) it returns `true` ("has live children") so the caller REFUSES removal. Both err in the SAME direction: toward NOT destroying. The reaper protects an individual cage; this guard protects the shared parent tmpdir that hosts a cage's siblings.

**ENOENT carve-out (NOT uncertainty):** a *missing* `<parentTmpdir>/epics` directory is the definitive "this team has no epic children" signal — the common case for an ordinary (non-epic-hosting) team tmpdir. That yields `false` (removal may proceed). Folding absent-epics-dir into the fail-safe branch would skip EVERY non-epic tmpdir and defeat the zombie sweep's purpose. Only an epics dir that exists-but-cannot-be-honestly-listed is uncertainty.

### Wiring into `sweepZombieTmuxSockets`

`groom.ts::sweepZombieTmuxSockets` consults the guard BEFORE its `rm(full, {recursive,force})`: if `hasLiveEpicChildren(full)` is `true`, it SKIPS removal (no kill, no rm), bumps a new `ZombieSweepResult.skippedLiveChildren` counter, and continues. The guard is exposed as a `SweepZombieSocketsOpts.hasLiveChildren` seam (default = the real `hasLiveEpicChildren`) so tests stay fs/tmux-free.

Belt-and-suspenders: the fixture-shape regex already excludes `/tmp/atmux-atmux`, so this sweep cannot reach the canonical parent dir today — but the guard protects ANY team whose tmpdir DOES match the fixture pattern AND hosts epics, and it hardens this removal path against future regressions. The rationale is captured inline at the call site.

## Consequences

- **Code**: new `src/core/epic-cage-children.ts::hasLiveEpicChildren` (+ `HasLiveEpicChildrenDeps`). `groom.ts`: `ZombieSweepResult` gains `skippedLiveChildren: number`; `SweepZombieSocketsOpts` gains the `hasLiveChildren` seam; the sweep skips + counts live-children dirs before kill/rm.
- **Tests**: `tests/unit/core/epic-cage-children.test.ts` (live-child=true, no-epics-dir=false, all-dead=false, fail-safe on list-error=true, fail-safe on probe-throw=true, uid injection, first-live short-circuit, real-default-lister ENOENT/ENOTDIR/empty) at 100% coverage; `tests/unit/core/groom-zombie-sweep.test.ts` extended (guard-true ⇒ skip + bump; guard-false ⇒ normal kill+rm; dryRun never consults guard; real default guard removes a plain fixture dir).
- **Not in this ADR**: hunting down the older/dotfiles culprit path (out of tree). When found, it adopts the same guard before any parent-tmpdir removal.

## Cross-refs

- [[ADR-251]] — epic-cage socket resolution via `tmuxTmpdir` (same socket-resolution theme this guard mirrors).
- ADR-250 — orchd stale-epic-team reaper (the fail-closed-to-ALIVE liveness this guard's fail-safe-to-TRUE mirrors).
- ADR-090 — epic-team disk layout `/tmp/atmux-<parent>/epics/<eid>` (the cage path this guard probes).
- ADR-162 — atmux owns its tmux infrastructure.
- ADR-018 — one cage = one tmux server (the invariant that makes "any session alive" a sound cage-liveness signal).
- Task: t-65bec10b (P0).
