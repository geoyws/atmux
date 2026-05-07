#!/usr/bin/env bats
# Unit tests for lib/registry.sh — fleet registry CRUD + concurrent-write
# safety per ADR-025 §Decision §Decision.
#
# Coverage matrix per t-8b72ab13 AC:
#   1.  upsert from clean state — assert all 6 schema fields present.
#   2.  upsert idempotence — call twice; single entry; lastSeen advances;
#       createdAt unchanged.
#   3.  realpath canonicalisation — symlinked projectRoot → stored value
#       is the canonical path.
#   4.  touch — bumps lastSeen; other fields untouched.
#   5.  touch on missing name — no-op + return 0.
#   6.  deregister — sets status='stopped'; entry NOT deleted; lastSeen
#       preserved.
#   7.  concurrent writes — 5 parallel upsert calls with different names
#       all land + JSON valid (no torn writes via flock).
#   8.  concurrent same-name upsert — 3 parallel calls; single entry +
#       lastSeen reflects the last successful write.
#   9.  ATMUX_REGISTRY env override — sandbox path; writes go there.
#   10. lib/init.sh hook — atmux init in sandbox → registry has new entry.
#   11. lib/start.sh + lib/stop.sh hooks — start advances lastSeen, stop
#       sets status='stopped'.
#
# Registry is sandboxed via $ATMUX_REGISTRY (atmux_setup_sandbox points it
# at $ATMUX_TEST_TMP/registry.json — protects user's ~/.claude/teams/).

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

# ---------- (9) sandbox env override (foundational — runs first) ----------

@test "registry: ATMUX_REGISTRY env override directs writes to sandbox path" {
  [ -n "$ATMUX_REGISTRY" ]
  [[ "$ATMUX_REGISTRY" == "$ATMUX_TEST_TMP/registry.json" ]]

  atmux::registry_upsert sandbox-team "$ATMUX_TEST_TMP/proj"
  [ -f "$ATMUX_REGISTRY" ]
  # Definitely NOT the user's real path.
  [ "$ATMUX_REGISTRY" != "$HOME/.claude/teams/registry.json" ]
  jq -e 'length == 1' "$ATMUX_REGISTRY" >/dev/null
}

# ---------- (1) upsert from clean state ----------

@test "registry: upsert on empty registry creates entry with all 6 schema fields" {
  atmux::registry_upsert myteam "$ATMUX_TEST_TMP/myteam-proj" mysession

  local entry
  entry="$(jq -c '.[0]' "$ATMUX_REGISTRY")"
  [ "$(jq -r '.name'        <<<"$entry")" = "myteam" ]
  [[ "$(jq -r '.projectRoot' <<<"$entry")" == *"/myteam-proj" ]]
  [ "$(jq -r '.sessionName' <<<"$entry")" = "mysession" ]
  [ "$(jq -r '.status'      <<<"$entry")" = "running" ]
  # createdAt + lastSeen are numeric epochs.
  [ "$(jq -r '.createdAt | type' <<<"$entry")" = "number" ]
  [ "$(jq -r '.lastSeen  | type' <<<"$entry")" = "number" ]
  # members[] starts empty per upsert contract.
  [ "$(jq -r '.members   | type' <<<"$entry")" = "array" ]
}

# ---------- (2) upsert idempotence ----------

@test "registry: upsert twice ⇒ single entry; lastSeen advances; createdAt preserved" {
  atmux::registry_upsert teamX "$ATMUX_TEST_TMP/x" sess1
  local created_1; created_1="$(jq -r '.[0].createdAt' "$ATMUX_REGISTRY")"
  local seen_1;    seen_1="$(jq -r '.[0].lastSeen' "$ATMUX_REGISTRY")"

  # Force a 1-second gap so lastSeen has room to advance.
  sleep 1

  atmux::registry_upsert teamX "$ATMUX_TEST_TMP/x" sess1
  [ "$(jq 'length' "$ATMUX_REGISTRY")" = "1" ]

  local created_2; created_2="$(jq -r '.[0].createdAt' "$ATMUX_REGISTRY")"
  local seen_2;    seen_2="$(jq -r '.[0].lastSeen' "$ATMUX_REGISTRY")"
  [ "$created_2" = "$created_1" ]
  [ "$seen_2" -gt "$seen_1" ]
}

# ---------- (3) realpath canonicalisation ----------

@test "registry: upsert canonicalises projectRoot via realpath (symlink → target)" {
  if ! command -v realpath >/dev/null 2>&1; then
    skip "realpath not available — canonicalisation falls back to raw value (documented in upsert)"
  fi
  mkdir -p "$ATMUX_TEST_TMP/real"
  ln -s "$ATMUX_TEST_TMP/real" "$ATMUX_TEST_TMP/symlink"

  atmux::registry_upsert symteam "$ATMUX_TEST_TMP/symlink"

  local stored; stored="$(jq -r '.[0].projectRoot' "$ATMUX_REGISTRY")"
  local expected; expected="$(realpath "$ATMUX_TEST_TMP/real")"
  [ "$stored" = "$expected" ]
  [[ "$stored" != *"/symlink" ]]
}

# ---------- (4) + (5) touch ----------

@test "registry: touch bumps lastSeen on existing entry; other fields untouched" {
  atmux::registry_upsert touchteam "$ATMUX_TEST_TMP/tt" sess
  local seen_before; seen_before="$(jq -r '.[0].lastSeen' "$ATMUX_REGISTRY")"
  local proj_before; proj_before="$(jq -r '.[0].projectRoot' "$ATMUX_REGISTRY")"
  local created_before; created_before="$(jq -r '.[0].createdAt' "$ATMUX_REGISTRY")"
  local status_before; status_before="$(jq -r '.[0].status' "$ATMUX_REGISTRY")"

  sleep 1
  atmux::registry_touch touchteam

  [ "$(jq -r '.[0].lastSeen'   "$ATMUX_REGISTRY")" -gt "$seen_before" ]
  [ "$(jq -r '.[0].projectRoot' "$ATMUX_REGISTRY")" = "$proj_before" ]
  [ "$(jq -r '.[0].createdAt'   "$ATMUX_REGISTRY")" = "$created_before" ]
  [ "$(jq -r '.[0].status'      "$ATMUX_REGISTRY")" = "$status_before" ]
}

@test "registry: touch on missing name is a no-op + returns 0 (no auto-create)" {
  atmux::registry_upsert real-team "$ATMUX_TEST_TMP/r"
  run atmux::registry_touch nonexistent
  [ "$status" -eq 0 ]
  # Single entry remains — touch did NOT auto-create the missing name.
  [ "$(jq 'length' "$ATMUX_REGISTRY")" = "1" ]
  [ "$(jq -r '.[0].name' "$ATMUX_REGISTRY")" = "real-team" ]
}

# ---------- (6) deregister ----------

@test "registry: deregister sets status='stopped' WITHOUT deleting entry; lastSeen preserved" {
  atmux::registry_upsert dereg-team "$ATMUX_TEST_TMP/d"
  local seen_before; seen_before="$(jq -r '.[0].lastSeen' "$ATMUX_REGISTRY")"

  atmux::registry_deregister dereg-team

  # Entry still present + lastSeen frozen at upsert-time value.
  [ "$(jq 'length' "$ATMUX_REGISTRY")" = "1" ]
  [ "$(jq -r '.[0].name'     "$ATMUX_REGISTRY")" = "dereg-team" ]
  [ "$(jq -r '.[0].status'   "$ATMUX_REGISTRY")" = "stopped" ]
  [ "$(jq -r '.[0].lastSeen' "$ATMUX_REGISTRY")" = "$seen_before" ]
}

@test "registry: deregister on missing name is a no-op + returns 0" {
  atmux::registry_upsert keep-team "$ATMUX_TEST_TMP/k"
  run atmux::registry_deregister nonexistent
  [ "$status" -eq 0 ]
  [ "$(jq -r '.[0].status' "$ATMUX_REGISTRY")" = "running" ]
}

# ---------- (7) concurrent writes — different names ----------

@test "registry: 5 parallel upserts with distinct names all land + JSON valid (no torn writes)" {
  local pids=()
  for i in 1 2 3 4 5; do
    ( atmux::registry_upsert "para-$i" "$ATMUX_TEST_TMP/p$i" "sess$i" ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done

  # File still parses — no torn writes.
  jq -e . "$ATMUX_REGISTRY" >/dev/null

  # All 5 names present.
  [ "$(jq 'length' "$ATMUX_REGISTRY")" = "5" ]
  for i in 1 2 3 4 5; do
    [ "$(jq --arg n "para-$i" '[.[] | select(.name == $n)] | length' "$ATMUX_REGISTRY")" = "1" ]
  done
}

# ---------- (8) concurrent writes — same name ----------

@test "registry: 3 parallel upserts with SAME name ⇒ single entry; JSON valid; status running" {
  local pids=()
  for i in 1 2 3; do
    ( atmux::registry_upsert same-team "$ATMUX_TEST_TMP/s$i" "sess$i" ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done

  jq -e . "$ATMUX_REGISTRY" >/dev/null
  [ "$(jq 'length' "$ATMUX_REGISTRY")" = "1" ]
  [ "$(jq -r '.[0].name'   "$ATMUX_REGISTRY")" = "same-team" ]
  [ "$(jq -r '.[0].status' "$ATMUX_REGISTRY")" = "running" ]
}

# ---------- (10) atmux init hook ----------

@test "registry: lib/init.sh hook — 'atmux init' creates a new registry entry" {
  # Sanity: registry empty pre-init.
  [ ! -s "$ATMUX_REGISTRY" ] || [ "$(jq 'length' "$ATMUX_REGISTRY")" = "0" ]

  "$ATMUX_BIN" init --name init-hook-team >/dev/null

  # Entry landed.
  jq -e . "$ATMUX_REGISTRY" >/dev/null
  [ "$(jq --arg n "init-hook-team" '[.[] | select(.name == $n)] | length' "$ATMUX_REGISTRY")" = "1" ]
}

# ---------- (11) start + stop hooks ----------
#
# `atmux start` would normally spawn real tmux panes; that's heavy + flaky
# under parallel test contention. The registry-touch hook on start is what
# we actually care about, and it fires regardless of whether spawn
# succeeds. Use ATMUX_NO_DOCTOR=1 + a tiny shell-tui team to keep spawn
# minimal; if spawn fails the registry-touch already happened earlier in
# the start path.

@test "registry: lib/start.sh advances lastSeen on start; lib/stop.sh sets status='stopped'" {
  "$ATMUX_BIN" init --name lifecycle >/dev/null
  # Force shell-tui members so the spawn doesn't depend on `claude`.
  jq '.members |= [{"name":"lead","role":"team-lead","lane":"misc","tui":"shell","model":"default","cwd":"'"$PWD"'"}]
      | .singleSession = false' \
    .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  local seen_after_init; seen_after_init="$(jq --arg n "lifecycle" '[.[] | select(.name == $n)][0].lastSeen' "$ATMUX_REGISTRY")"
  sleep 1

  ATMUX_NO_DOCTOR=1 ATMUX_SPAWN_WAIT=0 \
    "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true

  # lastSeen advanced — start's registry-touch hook fired.
  local seen_after_start; seen_after_start="$(jq --arg n "lifecycle" '[.[] | select(.name == $n)][0].lastSeen' "$ATMUX_REGISTRY")"
  [ "$seen_after_start" -gt "$seen_after_init" ]

  # status still 'running' (start didn't deregister anything).
  [ "$(jq --arg n "lifecycle" '[.[] | select(.name == $n)][0].status' "$ATMUX_REGISTRY")" = '"running"' ]

  # Stop the team.
  "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true

  # Status flips to 'stopped'; entry preserved.
  [ "$(jq --arg n "lifecycle" '[.[] | select(.name == $n)][0].status' "$ATMUX_REGISTRY")" = '"stopped"' ]
  [ "$(jq --arg n "lifecycle" '[.[] | select(.name == $n)] | length' "$ATMUX_REGISTRY")" = "1" ]
}
