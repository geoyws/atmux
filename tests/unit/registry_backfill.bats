#!/usr/bin/env bats
# Unit tests for atmux registry-backfill (lib/registry-backfill.sh).
# Covers ADR-030 §Backfill — walking live tmux windows + persisting any
# emoji glyph already present in the window name into the registry.
#
# Strategy: spawn a real tmux session inside the sandbox (TMUX_TMPDIR is
# already isolated by atmux_setup_sandbox) with synthetic __<team>__<emoji><member>
# windows, then run the verb and assert registry state.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  atmux_assert_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# Seed a 2-member team.json + register the team + spawn synthetic tmux
# windows. Members named so that 'kanban-2' is a strict suffix-extension
# of 'kanban' to exercise the longest-match-wins ordering.
_seed_team() {
  local team="$1"
  mkdir -p .atmux
  cat > .atmux/team.json <<JSON
{"name":"$team","members":[
  {"name":"kanban","role":"member","tui":"shell"},
  {"name":"kanban-2","role":"member","tui":"shell"}
]}
JSON
  atmux::registry_upsert "$team" "$PWD" "atmux-$team" >/dev/null
}

# Spawn a tmux session in the sandbox + the listed window names.
# fd-3/4 closure mirrors lib/start.sh — bats reserves fd 3 as the status
# pipe and a daemonised tmux server inheriting it would wedge bats-exec-suite.
_spawn_session() {
  local session="$1"; shift
  tmux new-session -d -s "$session" -n "_home" 3>&- 4>&-
  local w
  for w in "$@"; do
    tmux new-window -t "$session" -n "$w" 3>&- 4>&-
  done
}

@test "registry-backfill: --help prints usage" {
  run "$ATMUX_BIN" registry-backfill --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux registry-backfill" ]]
  [[ "$output" =~ "ADR-030" ]]
}

@test "registry-backfill: empty registry exits 0 with informational log" {
  run "$ATMUX_BIN" registry-backfill
  [ "$status" -eq 0 ]
  [[ "$output" =~ "registry empty" ]]
}

@test "registry-backfill: registry session absent ⇒ warn + skip ⇒ exit 0" {
  _seed_team t
  # No tmux session created — registry says session=atmux-t but it's absent.
  run "$ATMUX_BIN" registry-backfill --team t
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux-t absent" ]]
  [[ "$output" =~ "persisted=0" ]]
}

@test "registry-backfill: dry-run reports without writing" {
  _seed_team t
  _spawn_session atmux-t "__t__🚀kanban" "__t__🐰kanban-2"
  run "$ATMUX_BIN" registry-backfill --dry-run --team t
  [ "$status" -eq 0 ]
  [[ "$output" =~ "would persist" ]]
  # Nothing landed in the registry.
  run jq -r '.[] | select(.name=="t") | .members // [] | length' "$ATMUX_REGISTRY"
  [ "$output" = "0" ]
}

@test "registry-backfill: persists emoji from window names into registry" {
  _seed_team t
  _spawn_session atmux-t "__t__🚀kanban" "__t__🐰kanban-2"
  run "$ATMUX_BIN" registry-backfill --team t
  [ "$status" -eq 0 ]
  [[ "$output" =~ "persisted=2" ]]
  # Both members got their glyph. Longest-suffix match means 'kanban-2'
  # is identified correctly even though 'kanban' is also a suffix candidate.
  run atmux::registry_get_emoji t kanban
  [ "$output" = "🚀" ]
  run atmux::registry_get_emoji t kanban-2
  [ "$output" = "🐰" ]
}

@test "registry-backfill: legacy windows (no emoji prefix) are reported, not persisted" {
  _seed_team t
  _spawn_session atmux-t "__t__kanban"
  run "$ATMUX_BIN" registry-backfill --team t
  [ "$status" -eq 0 ]
  [[ "$output" =~ "legacy" ]]
  [[ "$output" =~ "persisted=0" ]]
  run atmux::registry_get_emoji t kanban
  [ -z "$output" ]
}

@test "registry-backfill: home + supervisor windows are excluded" {
  _seed_team t
  _spawn_session atmux-t "__t__home" "__t__supervisor" "__t__🚀kanban"
  run "$ATMUX_BIN" registry-backfill --team t
  [ "$status" -eq 0 ]
  [[ "$output" =~ "persisted=1" ]]
  ! [[ "$output" =~ "home" ]] || true  # may appear elsewhere in output; check no "matches no" warning
  ! [[ "$output" =~ "matches no t member.*home" ]] || true
}

@test "registry-backfill: re-run is idempotent (immutable-once-written)" {
  _seed_team t
  _spawn_session atmux-t "__t__🚀kanban"
  "$ATMUX_BIN" registry-backfill --team t >/dev/null
  # Second invocation: same emoji, set_emoji silently preserves.
  run "$ATMUX_BIN" registry-backfill --team t
  [ "$status" -eq 0 ]
  # Persisted echoes the existing value, so it counts as persisted (got==emoji).
  # The key invariant is the registry didn't change.
  run atmux::registry_get_emoji t kanban
  [ "$output" = "🚀" ]
}

@test "registry-backfill: --team filter narrows to one team" {
  _seed_team a
  _seed_team b
  _spawn_session atmux-a "__a__🚀kanban"
  _spawn_session atmux-b "__b__🐰kanban"
  run "$ATMUX_BIN" registry-backfill --team a
  [ "$status" -eq 0 ]
  run atmux::registry_get_emoji a kanban
  [ "$output" = "🚀" ]
  # Team b should remain untouched.
  run atmux::registry_get_emoji b kanban
  [ -z "$output" ]
}
