#!/usr/bin/env bats
# Unit tests for lib/emoji.sh — pools, mode resolution, and assignment.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/emoji.sh
  . "$ATMUX_LIB_DIR/emoji.sh"
}

teardown() {
  atmux_teardown_sandbox
}

@test "emoji: pool returns multiple choices for member role" {
  run atmux::emoji_pool member
  [ "$status" -eq 0 ]
  # Pool must have at least 5 entries.
  local n; n=$(echo "$output" | tr ' ' '\n' | grep -c .)
  [ "$n" -ge 5 ]
}

@test "emoji: default for team-lead is the canonical 🧭" {
  run atmux::emoji_default_for_role team-lead
  [ "$status" -eq 0 ]
  [ "$output" = "🧭" ]
}

@test "emoji: default for member is 🐝" {
  run atmux::emoji_default_for_role member
  [ "$output" = "🐝" ]
}

@test "emoji: planner and dba pools exist with role-appropriate picks" {
  run atmux::emoji_default_for_role planner
  [ "$output" = "🗺️" ]
  run atmux::emoji_default_for_role dba
  [ "$output" = "🗄️" ]
}

@test "emoji: gitter pool uses 🌿 (renamed role from git-committer)" {
  run atmux::emoji_default_for_role gitter
  [ "$output" = "🌿" ]
}

@test "emoji: mode defaults to 'random' when nothing is configured" {
  unset ATMUX_EMOJI_MODE
  # No team.json in fresh sandbox.
  run atmux::emoji_mode
  [ "$output" = "random" ]
}

@test "emoji: ATMUX_EMOJI_MODE env overrides everything" {
  ATMUX_EMOJI_MODE=static run atmux::emoji_mode
  [ "$output" = "static" ]
}

@test "emoji: team.json .emojis.mode is read when env unset" {
  mkdir -p .atmux
  echo '{"name":"t","emojis":{"mode":"static"},"members":[]}' > .atmux/team.json
  unset ATMUX_EMOJI_MODE
  run atmux::emoji_mode
  [ "$output" = "static" ]
}

@test "emoji: random pick avoids the 'seen' list when possible" {
  # Member pool contains 🐝; ask for one with 🐝 in seen — should NOT return 🐝.
  local picks=""
  for i in 1 2 3 4 5; do
    picks+=" $(atmux::emoji_pick_random member '🐝')"
  done
  ! [[ "$picks" =~ "🐝" ]]
}

@test "emoji: ai mode falls back to random when claude is missing" {
  # Force claude lookup to fail by clearing PATH for the lookup.
  ATMUX_EMOJI_MODE=ai
  PATH=/nonexistent run atmux::emoji_assign w1 member
  [ "$status" -eq 0 ]
  # Output must be a non-empty single emoji from the member pool.
  [ -n "$output" ]
  ! [[ "${output:0:1}" =~ [[:ascii:]] ]]
}

@test "emoji: assign in static mode returns canonical role default" {
  ATMUX_EMOJI_MODE=static run atmux::emoji_assign whoever team-lead
  [ "$output" = "🧭" ]
}

@test "emoji: window_name includes emoji prefix when member has one" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{"name":"t","members":[{"name":"w1","role":"member","tui":"shell","emoji":"🐝"}]}
JSON
  run atmux::window_name w1
  [ "$output" = "__t__🐝w1" ]
}

@test "emoji: window_name omits prefix when no emoji is stamped" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{"name":"t","members":[{"name":"w1","role":"member","tui":"shell"}]}
JSON
  run atmux::window_name w1
  [ "$output" = "__t__w1" ]
}
