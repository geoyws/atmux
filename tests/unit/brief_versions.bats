#!/usr/bin/env bats
# Unit tests for brief-version drift detection (E3/S3).
# Coverage for TEST task t-dbc22a04 (deps t-de3bdd69 + brief_version helpers
# in lib/common.sh).
#
# Two layers:
#   1. atmux::brief_version helper — direct source-and-call against a
#      sandbox templates dir (override ATMUX_ROOT so brief_path resolves
#      there).
#   2. _atmux_whip_check_brief_versions — exercise via `atmux whip` against
#      hand-crafted .atmux/state/brief-versions.json. Stale versions on
#      disk vs. current template ⇒ finding fires.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name b >/dev/null
  atmux_disable_down_confirm
  rm -f .atmux/state/whip-last.hash .atmux/state/brief-versions.json
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- AC (a) + (b): atmux::brief_version helper ----------

@test "brief_version: v1 marker on first line ⇒ returns 'v1'" {
  # Sandbox a templates tree under our temp ATMUX_ROOT and source the
  # helpers so brief_path resolves there.
  export ATMUX_ROOT="$ATMUX_TEST_TMP/sb-root"
  mkdir -p "$ATMUX_ROOT/templates/briefs"
  cat > "$ATMUX_ROOT/templates/briefs/member.md" <<'EOF'
<!-- brief-version: v1 -->
real brief content here
EOF
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_version member
  [ "$status" -eq 0 ]
  [ "$output" = "v1" ]
}

@test "brief_version: marker absent ⇒ returns 'v0' (legacy graceful)" {
  export ATMUX_ROOT="$ATMUX_TEST_TMP/sb-root"
  mkdir -p "$ATMUX_ROOT/templates/briefs"
  cat > "$ATMUX_ROOT/templates/briefs/member.md" <<'EOF'
no marker on first line
EOF
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_version member
  [ "$status" -eq 0 ]
  [ "$output" = "v0" ]
}

@test "brief_version: brief file missing ⇒ falls back via member.md (still v-marker if present)" {
  export ATMUX_ROOT="$ATMUX_TEST_TMP/sb-root"
  mkdir -p "$ATMUX_ROOT/templates/briefs"
  cat > "$ATMUX_ROOT/templates/briefs/member.md" <<'EOF'
<!-- brief-version: v3 -->
fallback brief
EOF
  # No 'gitter.md' file — brief_path falls back to member.md.
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_version gitter
  [ "$status" -eq 0 ]
  [ "$output" = "v3" ]
}

@test "brief_version: reads only the FIRST line — marker on later lines is ignored" {
  export ATMUX_ROOT="$ATMUX_TEST_TMP/sb-root"
  mkdir -p "$ATMUX_ROOT/templates/briefs"
  cat > "$ATMUX_ROOT/templates/briefs/member.md" <<'EOF'
not the marker line
<!-- brief-version: v9 -->
EOF
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_version member
  [ "$status" -eq 0 ]
  [ "$output" = "v0" ]
}

@test "brief_version: malformed marker ⇒ falls back to v0" {
  export ATMUX_ROOT="$ATMUX_TEST_TMP/sb-root"
  mkdir -p "$ATMUX_ROOT/templates/briefs"
  cat > "$ATMUX_ROOT/templates/briefs/member.md" <<'EOF'
<!-- brief-version: bogus -->
EOF
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_version member
  [ "$status" -eq 0 ]
  [ "$output" = "v0" ]
}

# ---------- AC (c): atmux::record_brief_version writes the JSON record ----------

@test "record_brief_version: writes {role, version, pastedAt} to .atmux/state/brief-versions.json" {
  # Use the real ATMUX_ROOT so the live templates resolve (member.md is v1).
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  local before; before=$(date +%s)
  run atmux::record_brief_version alice member
  [ "$status" -eq 0 ]
  [ -f .atmux/state/brief-versions.json ]
  jq -e '.alice.role == "member"'    .atmux/state/brief-versions.json >/dev/null
  jq -e '.alice.version | test("^v[0-9]+$")' .atmux/state/brief-versions.json >/dev/null
  local pasted; pasted=$(jq -r '.alice.pastedAt' .atmux/state/brief-versions.json)
  [ "$pasted" -ge "$before" ]
}

@test "record_brief_version: second call updates the same member record (idempotent over-write)" {
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  atmux::record_brief_version alice member
  local first; first=$(jq -r '.alice.pastedAt' .atmux/state/brief-versions.json)
  sleep 1
  atmux::record_brief_version alice member
  local second; second=$(jq -r '.alice.pastedAt' .atmux/state/brief-versions.json)
  [ "$second" -ge "$first" ]
  # Still exactly one alice entry.
  [ "$(jq -r '.alice | length' .atmux/state/brief-versions.json)" -ge 3 ]
}

# ---------- AC (d) + (e): whip surfaces drift ----------

@test "whip: stale brief-versions.json (recorded=v0, current=v1) ⇒ '📋 brief member v1 available' finding" {
  # BE fix landed (t-db501123): lib/whip.sh now sources tui.sh so
  # atmux::brief_path is defined when _atmux_whip_check_brief_versions
  # calls atmux::brief_version. Drift fires correctly when versions
  # differ.
  local m; m=$(jq -r '.members[0].name'    .atmux/team.json)
  local r; r=$(jq -r '.members[0].role // "member"' .atmux/team.json)
  [ -n "$m" ] && [ -n "$r" ]

  mkdir -p .atmux/state
  jq -n --arg m "$m" --arg r "$r" \
    '{($m): {role: $r, version: "v0", pastedAt: 1000}}' \
    > .atmux/state/brief-versions.json

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "brief $r" ]]
  [[ "$output" =~ "available (was v0)" ]]
  [[ "$output" =~ "atmux reload brief-reload $m" ]]
}

@test "whip: brief-versions.json matches current ⇒ no drift finding" {
  local m; m=$(jq -r '.members[0].name'    .atmux/team.json)
  local r; r=$(jq -r '.members[0].role // "member"' .atmux/team.json)
  # Stamp the CURRENT version (whatever it is) — drift check should silence.
  local cur
  cur=$( . "$ATMUX_LIB_DIR/common.sh"; . "$ATMUX_LIB_DIR/tui.sh"; atmux::brief_version "$r" )
  [[ "$cur" =~ ^v[0-9]+$ ]]
  mkdir -p .atmux/state
  jq -n --arg m "$m" --arg r "$r" --arg v "$cur" \
    '{($m): {role: $r, version: $v, pastedAt: 1000}}' \
    > .atmux/state/brief-versions.json

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "brief $r .* available" ]]
}

# ---------- AC (f): brief-reload re-stamps; subsequent whip silent ----------

@test "whip: after stamping current version, drift finding goes silent on next tick" {
  # BE fix landed (t-db501123): tui.sh source in whip.sh makes the
  # drift detector functional; this AC(f) test now actively verifies
  # the silent-after-restamp transition.
  local m; m=$(jq -r '.members[0].name'    .atmux/team.json)
  local r; r=$(jq -r '.members[0].role // "member"' .atmux/team.json)

  # Tick 1: stale record ⇒ drift fires.
  mkdir -p .atmux/state
  jq -n --arg m "$m" --arg r "$r" \
    '{($m): {role: $r, version: "v0", pastedAt: 1000}}' \
    > .atmux/state/brief-versions.json
  run "$ATMUX_BIN" whip
  [[ "$output" =~ "available (was v0)" ]]

  # Bump record to current version (simulating brief-reload's record_brief_version).
  local cur
  cur=$( . "$ATMUX_LIB_DIR/common.sh"; . "$ATMUX_LIB_DIR/tui.sh"; atmux::brief_version "$r" )
  jq --arg m "$m" --arg v "$cur" '.[$m].version = $v' \
    .atmux/state/brief-versions.json > .atmux/state/brief-versions.json.tmp \
    && mv .atmux/state/brief-versions.json.tmp .atmux/state/brief-versions.json

  # Tick 2: drift silent.
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "brief $r .* available" ]]
}

# ---------- AC (g): cold-start safety ----------

@test "whip: brief-versions.json absent ⇒ silent (cold-start safety, no drift finding)" {
  [ ! -f .atmux/state/brief-versions.json ]
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "brief .* available" ]]
}

@test "whip: member in team.json with no spawn record ⇒ silent for that member" {
  # team.json has at least one member; brief-versions.json maps a DIFFERENT
  # name. The team.json member has no entry → silent (per impl: pasted=empty
  # ⇒ continue).
  local m; m=$(jq -r '.members[0].name'    .atmux/team.json)
  mkdir -p .atmux/state
  echo '{"unrelated-ghost":{"role":"member","version":"v0","pastedAt":1}}' \
    > .atmux/state/brief-versions.json

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "atmux reload brief-reload $m" ]]
}
