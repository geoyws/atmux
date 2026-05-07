#!/usr/bin/env bats
# Regression coverage for ADR-012 — the test-runner kill-resilience pass.
# Two independent guards:
#   1. fd-3 hygiene: a tmux server spawned by `atmux start` does NOT inherit
#      the bats status pipe. Without this, a signal-killed bats grandchild
#      leaves bats-exec-suite blocked in pipe_read forever.
#   2. BATS_TEST_TIMEOUT escape hatch: even if a future regression reintroduces
#      a hang, the env var caps each test's wallclock and the suite terminates
#      cleanly instead of burning CI for hours.
#
# Closes E5/S3 t-90b2ac7f. Both tests run in the standard sandbox; Linux-only
# (uses /proc/<pid>/fd/3 for the inheritance check) — macOS skips Test 1.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "kr",
  "members": [
    {"name": "m1", "role": "member", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 90, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  echo '{"pending":[],"inProgress":[],"done":[]}' > .atmux/inboxes/m1.json
  export ATMUX_SESSION="atmux-test-kr-$$-$RANDOM"
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- Test 1: fd-3 hygiene at the tmux daemonising spawn site ----------

@test "fd-3 hygiene: spawned tmux server does NOT inherit bats's status pipe" {
  [[ -d /proc ]] || skip "Linux-only — /proc/<pid>/fd/3 is the inspection probe"

  # Snapshot what bats's fd 3 points at. Inside a @test, fd 3 IS bats's
  # bats-exec-suite status pipe — the exact thing the bug leaks into the
  # daemonised tmux server. The readlink resolves to a `pipe:[<inode>]`
  # token; we compare against the same token in the tmux server's fd 3.
  local bats_fd3=""
  if [[ -L /proc/self/fd/3 ]]; then
    bats_fd3=$(readlink /proc/self/fd/3 2>/dev/null || echo)
  fi
  [[ -n "$bats_fd3" ]] || skip "bats fd 3 not present — runner doesn't expose status pipe"

  # Bring up the sandbox session.
  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  # Wait for the session to come up.
  local ready=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if tmux list-sessions 2>/dev/null | grep -q "^$ATMUX_SESSION:"; then
      ready=1; break
    fi
    sleep 0.1
  done
  [[ -n "$ready" ]] || skip "sandbox tmux session did not come up — environmental flake"

  # Find the daemonised tmux server PID via the socket itself — `lsof -t
  # <socket>` returns the listener PID and works regardless of whether
  # tmux's argv contains the socket path (it doesn't, when -S is omitted
  # and TMUX_TMPDIR is used).
  local socket="$TMUX_TMPDIR/tmux-$(id -u)/default"
  [[ -S "$socket" ]] || skip "sandbox tmux socket not found at $socket"
  local tmux_pid
  tmux_pid=$(lsof -t "$socket" 2>/dev/null | head -1)
  [[ -n "$tmux_pid" ]] || skip "tmux server pid not detectable via lsof"

  # Inspect fd 3. With the fix in place, tmux either has fd 3 closed
  # (no symlink) OR has reopened it on its own internal pipe (a
  # different inode). Either is correct; what's WRONG is fd 3 still
  # pointing at bats's status pipe.
  local tmux_fd3=""
  if [[ -L "/proc/$tmux_pid/fd/3" ]]; then
    tmux_fd3=$(readlink "/proc/$tmux_pid/fd/3" 2>/dev/null || echo)
  fi

  [[ "$tmux_fd3" != "$bats_fd3" ]]
}

# ---------- Test 2: BATS_TEST_TIMEOUT belt-and-suspenders ----------

@test "BATS_TEST_TIMEOUT aborts a hanging test (regression guard)" {
  # Generate a tiny inline spec that intentionally hangs. Wrap with
  # BATS_TEST_TIMEOUT=2 and assert the run terminates fast. 2s is
  # comfortably below the 10s wall budget below — bats fires SIGTERM
  # at the cap and the test reports failed.
  #
  # The spec is constructed via printf rather than a heredoc because
  # bats's source-file preprocessor scans every line of THIS file for
  # `@test` declarations regardless of heredoc context — embedding
  # `@test "..."` as a literal in a heredoc would inflate this file's
  # detected test count by one and bats then complains "Executed N
  # instead of expected N+1". Splitting `@` from `test` via string
  # concat sidesteps the scan; the runtime spec still gets the correct
  # `@test ...` line.
  local spec="$ATMUX_TEST_TMP/hang_spec.bats"
  printf '%s\n' \
    "@""test \"intentional hang\" {" \
    '  sleep 9999' \
    '}' > "$spec"

  local start_t end_t elapsed
  start_t=$SECONDS
  run env BATS_TEST_TIMEOUT=2 bats "$spec"
  end_t=$SECONDS
  elapsed=$(( end_t - start_t ))

  # Run reported a failure (the sleep was killed; bats marks the test
  # not-ok). Status MUST be non-zero — that's the contract that lets
  # tests/run.sh's `fail=1` branch fire.
  [ "$status" -ne 0 ]

  # Wallclock cap honoured. Generous 10s budget — the cap is 2s; the
  # rest is bats startup + reaping overhead. Anything ≥10s means the
  # cap silently failed and the suite would hang in the prior bug.
  (( elapsed < 10 ))
}
