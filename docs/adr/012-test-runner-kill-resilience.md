# ADR-012: Test runner kill-resilience — bats fd-3 hygiene + per-test wallclock cap

**Status**: accepted
**Date**: 2026-04-25

## Context

`tests/run.sh` hangs indefinitely if a bats grandchild process is signal-killed mid-run. Concrete repro from 2026-04-25: during a RAM investigation, `pkill -f 'tmux new-session.*atmux-test-'` killed an in-flight `rotation.bats` test's tmux subprocess. The `bats-exec-test` bash exited, but the parent `bats-exec-suite` blocked on `pipe_read` for 19+ min before manual kill — kernel stack `pipe_read → vfs_read → ksys_read`.

Root cause: bats uses **fd 3** as a status-reporting pipe from each test up to `bats-exec-suite`. When `bats-exec-test` exits, fd 3 only fully closes (and `bats-exec-suite` only sees EOF) once **every** process that inherited fd 3 has also closed it.

`atmux start` spawns a tmux server via `tmux new-session -d -s ...` (lib/start.sh:57) and per-member windows via `tmux new-window -d` (lib/start.sh:113). The `tmux` *client* exits quickly, but the tmux *server* it forks daemonises with PPID=1 and inherits all open fds from the client (which inherited them from bats). tmux's daemonisation closes 0/1/2 but does **not** close fd 3+. Result: tmux server holds fd 3 open indefinitely; bats-exec-suite never gets EOF.

## Decision

Two complementary fixes:

1. **fd-3 hygiene at daemonising spawn sites.** Every atmux→tmux invocation that forks a long-lived daemon explicitly closes fd 3+4 in the spawned client: `tmux new-session -d ... 3>&- 4>&-`. The client inherits closed fd 3, the server it forks inherits closed fd 3, bats-exec-suite gets EOF cleanly when bats-exec-test exits. No-op in production (interactive tty has no fd 3 to begin with).

2. **Per-test wallclock cap via `BATS_TEST_TIMEOUT`.** bats 1.10.0+ honours this env var as a per-test wallclock limit; on timeout the test is killed and reported as failed. Set in `tests/run.sh`: 120s for unit, 300s for e2e. Belt-and-suspenders — even if a future fd-3 leak is reintroduced, the suite cannot hang past the cap.

Coverage: regression bats test verifies (a) tmux server's `/proc/<pid>/fd/` does NOT contain fd 3 after `atmux start` from a bats context, and (b) a deliberately-hanging test under `BATS_TEST_TIMEOUT=2` aborts within ~3 wall seconds.

## Consequences

- **BE lane (lib/start.sh):** add `3>&- 4>&-` to two spawn sites — `tmux new-session -d` and `tmux new-window -d`. Trivial diff, prod-safe.
- **OPS lane (tests/run.sh):** export `BATS_TEST_TIMEOUT` per suite invocation. No bats version bump needed (1.10.0 already installed).
- **TEST lane:** new `tests/unit/test_runner_kill_resilience.bats` covering both behaviours.
- **Other tmux invocations** (`tmux send-keys`, `tmux load-buffer`, `tmux paste-buffer`, `tmux kill-window`, etc.) are synchronous client-only — they don't fork daemons, so they don't need fd hygiene. Audited in this Epic; intentionally out of scope.
- **Rollback:** revert the two-line patch in `lib/start.sh` and unset `BATS_TEST_TIMEOUT` in `tests/run.sh`. No schema/state changes.

## Open questions

1. **Should fd hygiene apply to ALL atmux→tmux invocations or just daemonising ones?**
   *Resolved (planner default, low-reversibility):* only daemonising. Synchronous tmux client calls (`send-keys`, `load-buffer`, `paste-buffer`, `kill-window`) exit immediately and don't fork servers; adding `3>&-` is harmless but noise. If a future audit finds another daemonising call, patch it then.

2. **Default `BATS_TEST_TIMEOUT` values?**
   *Resolved (planner default, low-reversibility):* 120s unit, 300s e2e. Current slowest unit test is well under 30s; e2e rotation/lifecycle tests can run 60–90s under load. 4× headroom is enough to flag genuine hangs without false-positive aborts on slow CI.
