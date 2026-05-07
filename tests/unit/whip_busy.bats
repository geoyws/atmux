#!/usr/bin/env bats
# Unit tests for whip's queued-msg / busy suppression — E2/S7 / t-1a5205ea.
# Coverage for TEST task t-d371bfba.
#
# AC: when a pane shows BOTH "Press up to edit queued messages" AND any
# busy indicator (Esc-to-interrupt / token counter / thinking with), the
# queued-msg finding is suppressed. Without a busy indicator, queued-msg
# fires. Busy alone emits no queued-msg finding (no false-create).
# Compacting is independent — busy-suppress does NOT gate the ⏳ finding.
#
# Two layers of coverage:
#   1. Direct `_atmux_whip_pane_busy` helper unit-test via source-and-call
#      (canned strings, no tmux). Same pattern as whip.bats.
#   2. End-to-end: sandbox tmux session, inject pane state via send-keys,
#      run whip, assert findings. Same pattern as whip_preclear.bats.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "wb",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  export ATMUX_SESSION="atmux-test-wb-$$-$RANDOM"
}

teardown() {
  atmux_teardown_sandbox
}

_start_session() {
  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__wb__worker" && return 0
    sleep 0.2
  done
}

_inject() {
  local text="$1"
  local target="$ATMUX_SESSION:__wb__worker"
  tmux send-keys -t "$target" "echo '$text'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo '$text'" Enter
  sleep 1
}

# ---------- _atmux_whip_pane_busy direct ----------

@test "pane_busy: 'Esc to interrupt' ⇒ rc=0 (busy)" {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
  run _atmux_whip_pane_busy "Press up to edit queued messages
Esc to interrupt"
  [ "$status" -eq 0 ]
}

@test "pane_busy: 'tokens · esc to interrupt' ⇒ rc=0 (busy)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"
  run _atmux_whip_pane_busy "1234 tokens · esc to interrupt"
  [ "$status" -eq 0 ]
}

@test "pane_busy: 'thinking with' ⇒ rc=0 (busy)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"
  run _atmux_whip_pane_busy "thinking with sonnet…"
  [ "$status" -eq 0 ]
}

@test "pane_busy: pane idle (queued only, no busy markers) ⇒ rc=1" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"
  run _atmux_whip_pane_busy "Press up to edit queued messages"
  [ "$status" -eq 1 ]
}

@test "pane_busy: empty / unrelated text ⇒ rc=1" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"
  run _atmux_whip_pane_busy ""
  [ "$status" -eq 1 ]
  run _atmux_whip_pane_busy "Some shell prompt $"
  [ "$status" -eq 1 ]
}

# ---------- end-to-end via live session ----------

@test "whip_busy: queued + busy (Esc to interrupt) ⇒ queued-msg SUPPRESSED" {
  _start_session
  _inject "Press up to edit queued messages — Esc to interrupt"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "messages queued but not submitted" ]]
}

@test "whip_busy: queued alone (no busy markers) ⇒ queued-msg finding fires" {
  _start_session
  _inject "Press up to edit queued messages"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "messages queued but not submitted" ]]
}

@test "whip_busy: 'tokens · esc to interrupt' alone (busy, no queued) ⇒ no queued-msg finding" {
  _start_session
  _inject "5432 tokens · esc to interrupt"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "messages queued but not submitted" ]]
}

@test "whip_busy: 'thinking with' alone ⇒ no queued-msg finding" {
  _start_session
  _inject "thinking with claude…"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "messages queued but not submitted" ]]
}

@test "whip_busy: 'Compacting conversation' ⇒ ⏳ finding still emitted (busy-suppress doesn't gate it)" {
  _start_session
  _inject "Compacting conversation"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "compacting" ]]
}

@test "whip_busy: queued + Compacting (banner doubles as busy via different rule) ⇒ both findings handled per their own gates" {
  # Compacting is NOT in the busy-marker set (per _atmux_whip_pane_busy), so
  # queued + Compacting should still fire the queued-msg finding alongside
  # the ⏳ compacting one. Pin this so future busy-set widening is conscious.
  _start_session
  _inject "Press up to edit queued messages
Compacting conversation"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "compacting" ]]
  [[ "$output" =~ "messages queued but not submitted" ]]
}
