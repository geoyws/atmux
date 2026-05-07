#!/usr/bin/env bats
# Unit tests for ADR-030 spawn-time emoji resolution + registry persist.
# Covers atmux::resolve_member_emoji (lib/emoji.sh) and the direct
# atmux::registry_set_emoji / atmux::registry_get_emoji API (lib/registry.sh).
#
# Lookup priority chain (per ADR-030 §Decision):
#   1. registry hit          — return verbatim, no write.
#   2. team.json fallback    — write through to registry, return.
#   3. random/static/ai pick — write through to registry, return.
#
# Registry is sandboxed via $ATMUX_REGISTRY (atmux_setup_sandbox points it
# at $ATMUX_TEST_TMP/registry.json — incident 2026-04-27 protection).
# ATMUX_EMOJI_MODE=static is the deterministic mock for the random pool:
# member-role pool's first entry (🐝) is the canonical pick.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/emoji.sh
  . "$ATMUX_LIB_DIR/emoji.sh"
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  atmux_assert_sandbox

  # Deterministic random-fallback mock: static mode returns the role pool's
  # first entry (🐝 for member) instead of a RANDOM-driven pick. Lets the
  # random-path assertions pin an exact emoji.
  export ATMUX_EMOJI_MODE=static
}

teardown() {
  atmux_teardown_sandbox
}

# Minimal team.json with a single member; emoji optional.
_team_json() {
  local name="$1" emoji="${2:-}"
  mkdir -p .atmux
  if [[ -n "$emoji" ]]; then
    cat > .atmux/team.json <<JSON
{"name":"t","members":[{"name":"$name","role":"member","tui":"shell","emoji":"$emoji"}]}
JSON
  else
    cat > .atmux/team.json <<JSON
{"name":"t","members":[{"name":"$name","role":"member","tui":"shell"}]}
JSON
  fi
}

# Register the team in $ATMUX_REGISTRY so registry_set_emoji can attach
# members (set_emoji is no-op on absent teams per its docstring).
_seed_team_in_registry() {
  atmux::registry_upsert "$1" "$PWD" "" >/dev/null 2>&1
}

# ---------- AC1: lookup priority — registry wins ----------

@test "registry hit beats team.json — registry 🐰 wins over team.json 🦁" {
  _team_json w1 "🦁"
  _seed_team_in_registry t
  atmux::registry_set_emoji t w1 "🐰" >/dev/null

  run atmux::resolve_member_emoji t w1
  [ "$status" -eq 0 ]
  [ "$output" = "🐰" ]
}

# ---------- AC2: team.json fallback + write-through ----------

@test "team.json fallback — registry empty, team.json 🦁 → resolves 🦁 + persists to registry" {
  _team_json w1 "🦁"
  _seed_team_in_registry t

  run atmux::resolve_member_emoji t w1
  [ "$status" -eq 0 ]
  [ "$output" = "🦁" ]

  # Write-through: registry now carries 🦁 for w1.
  run atmux::registry_get_emoji t w1
  [ "$output" = "🦁" ]
}

# ---------- AC3: random fallback + write-through ----------

@test "random fallback — registry empty + team.json no emoji → static-mode 🐝 + persists" {
  _team_json w1
  _seed_team_in_registry t

  run atmux::resolve_member_emoji t w1
  [ "$status" -eq 0 ]
  # ATMUX_EMOJI_MODE=static: member pool default is 🐝.
  [ "$output" = "🐝" ]

  run atmux::registry_get_emoji t w1
  [ "$output" = "🐝" ]
}

# ---------- AC4: immutable once written ----------

@test "immutable once written — flipping team.json upstream doesn't move the registry value" {
  _team_json w1 "🦁"
  _seed_team_in_registry t
  atmux::registry_set_emoji t w1 "🐰" >/dev/null

  # First resolve hits the registry (🐰).
  [ "$(atmux::resolve_member_emoji t w1)" = "🐰" ]

  # Flip team.json upstream to 🦊 — registry should still win.
  _team_json w1 "🦊"
  [ "$(atmux::resolve_member_emoji t w1)" = "🐰" ]

  # And the persisted value never moved.
  [ "$(atmux::registry_get_emoji t w1)" = "🐰" ]
}

# ---------- AC5: cross-restart stability ----------

@test "cross-restart stability — first random pick survives a simulated restart" {
  _team_json w1
  _seed_team_in_registry t

  # First spawn → static mode picks 🐝 + persists.
  local first; first="$(atmux::resolve_member_emoji t w1)"
  [ "$first" = "🐝" ]

  # Simulate restart: registry file persists across pane death; even if
  # the random source changes (mode flip to ai with no claude → fallback
  # to random), the step-1 registry hit short-circuits.
  ATMUX_EMOJI_MODE=ai
  local second; second="$(atmux::resolve_member_emoji t w1)"
  [ "$second" = "$first" ]
}

# ---------- AC6: concurrent spawn race ----------

@test "concurrent spawn race — 2 parallel resolves yield single registry entry" {
  _team_json w1
  _seed_team_in_registry t

  # Fire 2 parallel resolves; flock (atmux::jq_update) + immutable-once-
  # written guarantees exactly one writes the emoji and the other reads
  # it back.
  atmux::resolve_member_emoji t w1 >/dev/null &
  atmux::resolve_member_emoji t w1 >/dev/null &
  wait

  # Registry must have exactly one members[] entry for w1 (no duplicates).
  local count
  count=$(jq -r '[.[] | select(.name == "t") | (.members // [])[] | select(.name == "w1")] | length' "$ATMUX_REGISTRY")
  [ "$count" = "1" ]

  # And it carries the deterministic static-mode pick.
  [ "$(atmux::registry_get_emoji t w1)" = "🐝" ]
}

# ---------- AC7: backward compat — team without members[] ----------

@test "backward compat — team in registry without members[] field falls through cleanly" {
  _team_json w1 "🦁"

  # Seed registry with a team entry that has NO members[] field at all
  # (legacy shape from before E10/Sa landed members[] tracking).
  printf '%s' '[{"name":"t","projectRoot":"'"$PWD"'"}]' > "$ATMUX_REGISTRY"

  run atmux::resolve_member_emoji t w1
  [ "$status" -eq 0 ]
  [ "$output" = "🦁" ]

  # Write-through created members[] cleanly.
  run atmux::registry_get_emoji t w1
  [ "$output" = "🦁" ]
}

# ---------- AC8: registry_set_emoji direct API ----------

@test "registry_set_emoji direct API — first write persists; second silently no-ops" {
  _seed_team_in_registry t

  local first; first="$(atmux::registry_set_emoji t w1 "🐰")"
  [ "$first" = "🐰" ]

  # Second call with a different emoji must NOT overwrite (immutable).
  local second; second="$(atmux::registry_set_emoji t w1 "🦊")"
  [ "$second" = "🐰" ]

  # Disk-side: persisted value is the first one, not the second.
  [ "$(atmux::registry_get_emoji t w1)" = "🐰" ]
}
