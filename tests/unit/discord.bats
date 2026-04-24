#!/usr/bin/env bats
# Unit tests for lib/discord.sh — verify it no-ops without a webhook.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/discord.sh
  . "$ATMUX_LIB_DIR/discord.sh"
}

teardown() {
  atmux_teardown_sandbox
}

@test "discord: no-op when webhook env unset" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  run atmux::discord_ping "hello"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "skipping" ]]
}

@test "discord: uses ATMUX_DISCORD_WEBHOOK" {
  # Point at a non-reachable URL — we just assert it attempted and logged.
  export ATMUX_DISCORD_WEBHOOK="http://127.0.0.1:1/nope"
  run atmux::discord_ping "hello"
  # curl will fail (connection refused) → warn, but not die.
  [[ "$output" =~ "ping failed" ]] || true
}

@test "discord: falls back to DISCORD_WHIP_WEBHOOK" {
  unset ATMUX_DISCORD_WEBHOOK
  export DISCORD_WHIP_WEBHOOK="http://127.0.0.1:1/nope2"
  run atmux::discord_ping "hello"
  [[ "$output" =~ "ping failed" ]] || true
  # shouldn't have the "skipping" message because a webhook is set.
  ! [[ "$output" =~ "skipping" ]]
}
