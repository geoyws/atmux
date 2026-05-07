#!/usr/bin/env bats
# Unit tests for `atmux decisions list --since <epoch>` (E2/S8 bug fix).
#
# Repro: `atmux decisions list --since 1777125613 --json` errored with
# "bad --since format" because lib/decisions.sh::_decisions_parse_since
# fell through bare integers to GNU `date -d` which doesn't accept raw
# epochs without an `@` prefix. Whip's S8 inline-preview path reads the
# cursor file (epoch) and pipes the value via --since, so every cron
# tick was hitting the fallback (count-only pointer) instead of the
# top-3 inline preview format.
#
# Fix: _decisions_parse_since matches `^[0-9]+$` first and echoes the
# value verbatim — no `date -d` round-trip.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "decisions list: --since <epoch> (raw integer) is accepted" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "epoch-q?" --default "y" >/dev/null
  # Pick an epoch comfortably in the past so the recent add qualifies.
  local since=$(( $(date +%s) - 3600 ))
  run "$ATMUX_BIN" decisions list --since "$since" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions list: --since <future epoch> excludes the just-added entry" {
  # Sanity: the parser passes the epoch through verbatim (not silently
  # reinterpreted via `date -d`), so a future epoch yields no matches.
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "fresh-q?" --default "y" >/dev/null
  local future=$(( $(date +%s) + 3600 ))
  run "$ATMUX_BIN" decisions list --since "$future" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" = "0" ]
}

@test "decisions list: --since 0 still works (whip cursor on first tick)" {
  # Pre-fix the cursor=0 case worked accidentally — `date -d 0` parses
  # as midnight today. Post-fix it works deliberately (bare integer
  # path). Pin so a future parser tweak doesn't regress.
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "zero-q?" --default "y" >/dev/null
  run "$ATMUX_BIN" decisions list --since 0 --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions list: --since 1h shorthand still works (no regression)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "rel-q?" --default "y" >/dev/null
  run "$ATMUX_BIN" decisions list --since 1h --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions list: --since 1d shorthand still works (no regression)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "rel-q?" --default "y" >/dev/null
  run "$ATMUX_BIN" decisions list --since 1d --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions list: --since ISO date still works (no regression)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "iso-q?" --default "y" >/dev/null
  run "$ATMUX_BIN" decisions list --since "2020-01-01" --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions list: --since 'garbage' still rejected with helpful hint" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  run "$ATMUX_BIN" decisions list --since "not-a-thing"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "bad --since format" ]]
  # Hint should mention all the accepted shapes (epoch was missing pre-fix).
  [[ "$output" =~ "epoch" ]]
  [[ "$output" =~ "Nh" ]]
}
