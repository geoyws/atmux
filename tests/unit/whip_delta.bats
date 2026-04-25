#!/usr/bin/env bats
# Unit tests for whip "Since last tick" delta — E2/S7 / t-ac42591e.
#
# AC: append a 📊 block (commits + done tasks) when ≥1 positive event
# happened since mtime(.atmux/state/whip-last.hash). Skip section entirely
# when (a) no baseline (first tick) OR (b) empty window.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Source whip.sh so the helper is callable from tests directly.
_load_whip() {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
}

@test "delta_since: no since arg ⇒ silent (no body)" {
  _load_whip
  run _atmux_whip_delta_since ""
  [ -z "$output" ]
}

@test "delta_since: empty window (no commits, no done tasks) ⇒ silent" {
  _load_whip
  # Use a future epoch so nothing qualifies.
  local future=$(( $(date +%s) + 3600 ))
  run _atmux_whip_delta_since "$future"
  [ -z "$output" ]
}

@test "delta_since: kanban tasks completed in window ⇒ 🏁 bullet emitted" {
  _load_whip
  local before; before=$(date +%s)
  sleep 1
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "tasks done" ]]
  [[ "$output" =~ "$id" ]]
}

@test "delta_since: > 5 done tasks ⇒ shows 5 + '+N more'" {
  _load_whip
  local before; before=$(date +%s)
  sleep 1
  local i
  for i in 1 2 3 4 5 6 7; do
    local id; id=$("$ATMUX_BIN" task add "t$i" | tail -1)
    "$ATMUX_BIN" task move "$id" done >/dev/null
  done
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "7 tasks done" ]]
  [[ "$output" =~ "+2 more" ]]
}

@test "whip end-to-end: no whip-last.hash ⇒ no delta block (first tick has no baseline)" {
  [ ! -f .atmux/state/whip-last.hash ]
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "Since last tick" ]]
}

@test "whip end-to-end: prior tick + new done task ⇒ delta block fires on next tick" {
  # First tick — no findings of interest other than session DOWN; writes hash.
  "$ATMUX_BIN" whip >/dev/null
  [ -f .atmux/state/whip-last.hash ]
  sleep 1
  # Land a done task in the window between the two ticks.
  local id; id=$("$ATMUX_BIN" task add "delta-task" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "$id" ]]
}
