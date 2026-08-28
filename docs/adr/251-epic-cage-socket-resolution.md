# ADR-251: epic-cage liveness must resolve the socket via `tmuxTmpdir`, not `resolveCageSocket`

**Status**: accepted
**Date**: 2026-06-03
**Driver-ref**: operator session 2026-06-03 — while wiring the ADR-250 reaper's liveness check, the canonical resolver `resolveCageSocket(name, epicRoot)` was found to report **live epic cages as dead**.

> ⚠ **SUPERSEDED 2026-08-27 by [ADR-280](280-epic-team-retirement-and-staged-excision.md).** Epic-teams are retired: the `epic-team` cage type, the `epicId` cockpit field and the epic verbs no longer exist. This ADR is kept as history — the decision it records was true when made. Do not implement from it.

## Context

Epic cages get their own tmux socket. At spawn, `spawn-epic.ts` (§S2) writes the epic's `team.json` with `tmuxTmpdir = /tmp/atmux-<parentTeam>/epics/<epicId>`. The live socket is then `<tmuxTmpdir>/tmux-<uid>/default` — the same scheme every read/write path is required to resolve through `resolveTeamSocket(team)` (`src/core/common.ts`, whose own docs state: *"All sites read AND write MUST use this resolver"*).

But `dissolve-epic.ts::defaultCageTeardown` resolved the cage socket with `resolveCageSocket(teamName, epicRoot)` (`src/core/cockpit.ts`), which only checks two candidates — `cageSocketPath(teamName)` = `/tmp/atmux-<teamName>/sock` and `perTeamCageSocketPath(teamRoot)` = `<teamRoot>/.atmux/tmux/...`. For an epic cage, `teamName` is the epicId, so it guesses `/tmp/atmux-<epicId>/sock` — a path that **never exists**, because the real socket is under the *parent's* `epics/<epicId>` tmpdir.

Empirically verified against 3 known-live sopx epic cages (`624c964b`, `6cadf7a8`, `22-e93e7eb2`):

| resolver | socket | `hasSession` |
|---|---|---|
| `resolveCageSocket(id, epicRoot)` | `/tmp/atmux-624c964b/sock` | **false (WRONG)** |
| `resolveTeamSocket({name, tmuxTmpdir})` | `/tmp/atmux-sopx/epics/624c964b/tmux-0/default` | **true (correct)** |

### Two impacts

1. **`dissolve-epic` teardown bug (latent).** `defaultCageTeardown` probes `hasSession` to "skip teardown when the cage is already down." On a *live* epic cage the wrong socket → `hasSession=false` → `alive=false` → it **skips `softStop` + `killSession`**, then proceeds to prune the worktree + remove the cockpit entry. Net: a running cage (claude TUIs) is **orphaned** — worktree and registration gone, process still live. It hasn't bitten widely only because dissolve is usually called on already-dead cages.
2. **Blocks the ADR-250 reaper.** A reaper using `resolveCageSocket` for its liveness gate would classify **every** epic cage — live ones included — as a dead-cage orphan, auto-reap it, and **destroy live work**. This is precisely the failure ADR-250 §D5 guards against; it is why the reaper shipped with the liveness seam stubbed.

## Decision

Resolve the epic-cage socket from the child team's `tmuxTmpdir` via `resolveTeamSocket(childTeam)` whenever it is set; fall back to `resolveCageSocket(teamName, epicRoot)` only when `tmuxTmpdir` is absent (corrupted/legacy remnant — `defaultCageTeardown` already tolerates a missing socket as "dead").

```ts
const socket =
  typeof deps.childTeam.tmuxTmpdir === "string" && deps.childTeam.tmuxTmpdir.length > 0
    ? resolveTeamSocket(deps.childTeam)
    : await resolveCageSocket(teamName, deps.epicRoot);
```

This is additive — no behaviour change when `tmuxTmpdir` is unset; correct teardown when it is set (the normal spawned-epic case).

### Reaper follow-on (ADR-250 §D2)

The ADR-250 reaper's `isCageAlive` seam can now be wired correctly: read each epic's `team.json` for `tmuxTmpdir` → `resolveTeamSocket` → `hasSession`. **Fail-closed guard:** when an epic's `tmuxTmpdir` is missing/unreadable, liveness returns `true` (treat as alive → never reap), so a corrupted epic is never auto-destroyed. `SpawnedEpicTeam` gains a `cageSocket` field to carry the resolved socket to the probe.

## Consequences

- **Code**: `src/core/dissolve-epic.ts::defaultCageTeardown` uses `resolveTeamSocket` when `tmuxTmpdir` is set. `src/core/orchd-reap.ts`: `SpawnedEpicTeam.cageSocket` added + `isCageAlive(team)` signature (was `(sessionName)`) so the liveness probe has the socket.
- **Tests**: a `defaultCageTeardown` regression test asserts the captured `socketPath` equals `<tmuxTmpdir>/tmux-<uid>/default` when `tmuxTmpdir` is set.
- **Not in this ADR**: changing `resolveCageSocket` itself (other callers may rely on its two-candidate behaviour) — the fix is at the epic-cage call site, which has the authoritative `tmuxTmpdir`. A broader `resolveCageSocket` epic-awareness pass can supersede here if other sites show the same bug.
