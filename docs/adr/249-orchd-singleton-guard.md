# ADR-249: orchd singleton guard — one supervisor per team DB via advisory flock

**Status**: accepted
**Date**: 2026-05-29
**Driver-ref**: operator session 2026-05-29 — RAM-growth triage; operator suspected duplicate orchd ("stop the duplicates in every team"). Investigation found NO live duplicates (the two `atmux-orchd` processes were atmux + sopx on different DBs), but confirmed orchd has **no structural guard** against true duplicates.

## Context

`atmux-orchd` (the Rust event-router supervisor, [ADR-202](202-honker-in-db-messaging-substrate.md) §VII) is launched once per cage in the `__orchd__` tmux window (`src/core/orchd-window.ts`):

```
ATMUX_ORCHD_TEAM_DIR=$(pwd) atmux-orchd .atmux/state.db 2>&1 | tee -a .atmux/logs/orchd.log
```

There is **nothing preventing two orchd from running against the same `state.db`**. If that happens — a respawn racing an orphan that outlived its parent window, a manual relaunch, an `atmux start` re-run before the prior cage fully tore down — both supervisors:

- subscribe to the same Honker `UpdateEvents` channel and both `drain_and_dispatch` every event (at-least-once is the contract, but doubling the spawn rate is not),
- both fire the 5-min sweep / 15-min context+budget scan / 24h housekeep tickers,
- **race the spawn-dedup gate**: `orchd-spawn.ts` checks `epics.spawned_at IS NULL` then later stamps it (`UPDATE epics SET spawned_at = ?`). Two orchd can both pass the check before either stamps → the same epic gets spawned **twice** → duplicate epic-team cages, each with its own claude TUIs.

The `state.db` path passed to orchd is **relative** (`.atmux/state.db`), so a naive `ps`-based duplicate check is fooled — two orchd with the same argv but different CWDs are *different teams*, not duplicates. The only reliable identity is the **canonical absolute DB path**.

## Decision

orchd takes an **exclusive, non-blocking advisory lock** (`flock(LOCK_EX | LOCK_NB)`) on a per-DB lockfile at startup, **before** opening the database. The lockfile path is derived by canonicalizing the DB's parent directory + `<dbname>.orchd.lock`, so relative/absolute argv variants of the same team's DB collide on the same lock; different teams' DBs do not.

- **Lock acquired** → this is the sole supervisor; hold the lock fd for the entire process lifetime. `flock` is released automatically by the kernel on process exit/crash (no stale-lock file to garbage-collect — the lockfile may persist but carries no held lock).
- **Lock busy** → another orchd already supervises this DB. Log a refusal and exit non-zero (`ExitCode 5`). The window shows a dead pane; no thrash because the launch path is one-shot (no respawn loop).

Platform: Linux-only, matching the existing `install_parent_death_signal` (`PR_SET_PDEATHSIG`) pattern — `libc` is already a Linux-gated dependency and `libc::flock` needs no new crate. On non-Linux the guard is a no-op (returns no lock; orchd proceeds), acceptable because the production substrate (hax) is Linux.

This makes duplicate supervisors **structurally impossible per team** rather than relying on launch-site discipline.

## Consequences

- **orchd**: `rust/atmux-orchd/src/main.rs` gains `singleton_lock_path()` + `acquire_singleton_lock()` and a guard block in `main()` before `Database::open`. The held `File` is bound for the lifetime of `main`.
- **Operators**: a second `atmux-orchd` against a live team exits immediately with `🔴 orchd singleton guard · refusing to start`. To intentionally hand off (e.g. restart), kill the incumbent first; the lock releases on its exit and the next start acquires it.
- **Deploy**: takes effect on the next orchd (re)start per cage — `build:install` + restart the `__orchd__` window. Already-running orchd keep the old binary until restarted.
- **Tests**: covered in `rust/atmux-orchd` (lockfile-path derivation is pure; acquire/refuse is an integration check against a tmpdir lockfile).
- Pairs with the spawn-without-reap reaper ([ADR-250](250-orchd-stale-epic-reaper.md)) — the guard stops *new* duplicate spawns; the reaper cleans up *accumulated* epic-team cages.

## Out of scope

- Cross-team coordination (intentional — each team's orchd is independent; the lock is per-DB).
- A pidfile with liveness probing (flock is simpler and self-healing — the kernel releases on death; no PID-reuse race).
