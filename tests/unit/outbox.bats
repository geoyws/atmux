#!/usr/bin/env bats
# atmux reply / outbox — member → driver reply path.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name o >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "outbox: empty when nothing replied" {
  run "$ATMUX_BIN" outbox
  [ "$status" -eq 0 ]
  [[ "$output" =~ "empty" ]]
}

@test "reply: single entry shows up in outbox" {
  "$ATMUX_BIN" reply --from lead "all auth tasks dispatched — expecting results in 2h" >/dev/null
  run "$ATMUX_BIN" outbox
  [ "$status" -eq 0 ]
  [[ "$output" =~ "all auth tasks dispatched" ]]
  [[ "$output" =~ "**lead**" ]]
}

@test "reply: multiple entries accumulate" {
  "$ATMUX_BIN" reply --from lead  "progress 1"   >/dev/null
  "$ATMUX_BIN" reply --from lead  "progress 2"   >/dev/null
  "$ATMUX_BIN" reply --from cursor-1 "ui shipped" >/dev/null
  run "$ATMUX_BIN" outbox
  [[ "$output" =~ "progress 1" ]]
  [[ "$output" =~ "progress 2" ]]
  [[ "$output" =~ "ui shipped" ]]
}

@test "reply: defaults from to ATMUX_MEMBER env var" {
  ATMUX_MEMBER=reviewer "$ATMUX_BIN" reply "looks fine" >/dev/null
  run "$ATMUX_BIN" outbox
  [[ "$output" =~ "**reviewer**" ]]
}

@test "outbox --ack moves entries to Archive" {
  "$ATMUX_BIN" reply --from lead "first message" >/dev/null
  "$ATMUX_BIN" outbox --ack >/dev/null
  run "$ATMUX_BIN" outbox
  ! [[ "$output" =~ "first message" ]]
  run grep "first message" .atmux/lead-outbox.md
  [[ "$output" =~ archived ]]
}

@test "outbox --json returns structured data" {
  "$ATMUX_BIN" reply --from lead "hello" >/dev/null
  run "$ATMUX_BIN" outbox --json
  [ "$status" -eq 0 ]
  echo "$output" | jq . >/dev/null
  run sh -c "'$ATMUX_BIN' outbox --json | jq -r '.open | length'"
  [ "$output" -ge "1" ]
}
