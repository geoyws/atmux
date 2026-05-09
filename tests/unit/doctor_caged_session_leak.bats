#!/usr/bin/env bats
# Unit tests for _doctor_check_caged_session_leak (driver-inbox 12:21
# MYT 2026-05-07 Ask 2 follow-up).
#
# Hard contract: any session named `atmux-<X>` (HYPHEN) on the operator's
# daily-driver socket is the post-leak fingerprint of a cron-fired or
# interactive `atmux start` whose cage-socket safeguard didn't fire.
# This is ALWAYS a leak — there's no legitimate reason for `atmux-<team>`
# (the canonical cage session form per atmux::session_name) to live on
# the daily-driver socket.
#
# Sister tests in doctor_orphan_atmux.bats cover the underscore form
# (`atmux_<X>`, ADR-018 launcher convention) which has different
# semantics — those are sometimes legit launchers awaiting a registry
# entry, hence "investigate before killing." This test verifies the
# new check fires for the HYPHEN form independently.
#
# Sandbox strategy mirrors doctor_orphan_atmux.bats — sandbox tmux on
# $ATMUX_TEST_TMP/tmux/tmux-0/default, $TMUX synthesised to point at
# that socket so the gate is exercised.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  _leak_setup_team
}

teardown() {
  _leak_kill_test_sessions
  atmux_teardown_sandbox 2>/dev/null || true
}

_leak_setup_team() {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "host",
  "members": [
    {"name": "w1", "role": "member", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
}

_leak_ensure_socket() {
  local sock="$ATMUX_TEST_TMP/tmux/tmux-0/default"
  mkdir -p "$(dirname "$sock")"
  if ! tmux -S "$sock" has-session 2>/dev/null; then
    tmux -S "$sock" new-session -d -s __bootstrap -c "$ATMUX_TEST_TMP" 3>&- 4>&- || return 1
  fi
  printf '%s\n' "$sock"
}

_leak_spawn_session() {
  local sock="$1" name="$2" winname="${3:-default}"
  tmux -S "$sock" new-session -d -s "$name" -n "$winname" -c "$ATMUX_TEST_TMP" 3>&- 4>&-
}

_leak_kill_test_sessions() {
  local sock="$ATMUX_TEST_TMP/tmux/tmux-0/default"
  [[ -S "$sock" ]] || return 0
  tmux -S "$sock" kill-server 2>/dev/null || true
}

_leak_fake_tmux() {
  local sock="$1"
  printf '%s,%s,%s\n' "$sock" "$$" "0"
}

@test "caged-session-leak: HYPHEN form atmux-<team> on daily socket → yellow row" {
  local sock; sock="$(_leak_ensure_socket)"
  echo '[]' > "$ATMUX_REGISTRY"

  # Spawn the leak fingerprint — atmux-cron with __cron__lead window
  # (mirrors the driver's 2026-05-07 12:21 MYT report).
  _leak_spawn_session "$sock" "atmux-cron" "__cron__lead"

  TMUX="$(_leak_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  [[ "$output" =~ "caged-session-leak:atmux-cron" ]]
  [[ "$output" =~ "daily-driver socket" ]]
  [[ "$output" =~ "tmux kill-session" ]]
}

@test "caged-session-leak: emits window-name fingerprint when present" {
  local sock; sock="$(_leak_ensure_socket)"
  echo '[]' > "$ATMUX_REGISTRY"

  # __<team>__<member> shape window — the canonical leak fingerprint
  # per atmux::window_name convention.
  _leak_spawn_session "$sock" "atmux-sopx" "__sopx__lead"

  TMUX="$(_leak_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  [[ "$output" =~ "__sopx__lead" ]]
}

@test "caged-session-leak: UNDERSCORE form atmux_<team> NOT flagged here" {
  # The orphan-atmux check (sister fn) handles atmux_<X>. This check
  # must stay scoped to the HYPHEN form so the two semantics don't
  # cross-contaminate.
  local sock; sock="$(_leak_ensure_socket)"
  echo '[]' > "$ATMUX_REGISTRY"

  _leak_spawn_session "$sock" "atmux_legitimate"

  TMUX="$(_leak_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "caged-session-leak:atmux_legitimate" ]]
}

@test "caged-session-leak: non-atmux sessions never emit a row" {
  local sock; sock="$(_leak_ensure_socket)"
  echo '[]' > "$ATMUX_REGISTRY"

  for name in __main convoke paste sb settled iconverify; do
    _leak_spawn_session "$sock" "$name"
  done

  TMUX="$(_leak_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "caged-session-leak" ]]
}

@test "caged-session-leak: silent when \$TMUX is unset (cron path)" {
  # No TMUX — gate's `[[ -n "${TMUX:-}" ]] || return 0` filters out.
  # Even with a leaked-shape session present on the would-be daily
  # socket, the check must not fire under cron.
  local sock; sock="$(_leak_ensure_socket)"
  echo '[]' > "$ATMUX_REGISTRY"
  _leak_spawn_session "$sock" "atmux-cron"

  run env -u TMUX "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "caged-session-leak" ]]
}

@test "caged-session-leak: silent when attached to a cage socket" {
  # If $TMUX itself points at a cage socket, the operator IS already
  # inside a cage — the rest of the check would be running in-cage,
  # not on the daily-driver socket. Suppress per the design.
  local cage_sock="/tmp/atmux-tmux_test/tmux-$(id -u)/default"
  TMUX="${cage_sock},42,0" run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "caged-session-leak" ]]
}
