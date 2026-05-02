#!/usr/bin/env bats
# Unit tests for atmux audit (E14/Sb, t-476a9a3f, ADR-038).
#
# Sb scope: detect-only. Class A–F detectors. Class F is a stub returning
# clean — Sk lands the real detection logic.
#
# Strategy:
#   - Verb-level: smoke `atmux audit`, --json, --quiet exit codes,
#     unsupported-flag errors.
#   - Function-level: source lib/audit.sh + lib/common.sh + registry.sh,
#     synthesize team.json + tmux state, call each
#     _atmux_audit_class_<x>_detect, assert findings array shape.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
  atmux_assert_sandbox
  # Class E walks $ATMUX_AUDIT_TMP_ROOT (defaults to /tmp). Sandbox the
  # scan to the per-test tmpdir so the operator's real /tmp dirs don't
  # leak into the test assertions.
  export ATMUX_AUDIT_TMP_ROOT="$ATMUX_TEST_TMP/audit_tmp"
  mkdir -p "$ATMUX_AUDIT_TMP_ROOT"
}

teardown() {
  atmux_teardown_sandbox
}

_source_audit() {
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/audit.sh
  . "$ATMUX_LIB_DIR/audit.sh"
  _atmux_audit_findings=()
}

# ---- verb surface smoke ------------------------------------------------

@test "audit: --help prints usage with class taxonomy" {
  run "$ATMUX_BIN" audit --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux audit" ]]
  [[ "$output" =~ "driver-window naming" ]]
  [[ "$output" =~ "cage path separator" ]]
  [[ "$output" =~ "rename residue" ]]
}

@test "audit: clean sandbox exits 0 with 'no drift' message" {
  run "$ATMUX_BIN" audit
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no drift" ]]
}

@test "audit: --quiet returns 0 on green" {
  run "$ATMUX_BIN" audit --quiet
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "audit: --json on clean sandbox emits []" {
  run "$ATMUX_BIN" audit --json
  [ "$status" -eq 0 ]
  [[ "$output" =~ "[]" ]]
}

@test "audit: --fix errors out as not-yet-implemented" {
  run "$ATMUX_BIN" audit --fix
  [ "$status" -ne 0 ]
  [[ "$output" =~ "not yet implemented" ]]
}

@test "audit: --dry-run errors out as paired with --fix" {
  run "$ATMUX_BIN" audit --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" =~ "not yet implemented" ]]
}

@test "audit: --class with bogus value rejected" {
  run "$ATMUX_BIN" audit --class z
  [ "$status" -ne 0 ]
  [[ "$output" =~ "must be one of" ]]
}

@test "audit: --class accepts a|b|c|d|e|f|all" {
  run "$ATMUX_BIN" audit --class a
  [ "$status" -eq 0 ]
  run "$ATMUX_BIN" audit --class all
  [ "$status" -eq 0 ]
}

@test "audit: unknown flag rejected" {
  run "$ATMUX_BIN" audit --bogus
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown arg" ]]
}

# ---- emit + render -----------------------------------------------------

@test "emit: appends a schema-shaped finding object" {
  _source_audit
  _atmux_audit_emit A "test detail" "test fix"
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  local f="${_atmux_audit_findings[0]}"
  [ "$(jq -r '.class'         <<<"$f")" = "A" ]
  [ "$(jq -r '.severity'      <<<"$f")" = "medium" ]
  [ "$(jq -r '.detail'        <<<"$f")" = "test detail" ]
  [ "$(jq -r '.fix_hint'      <<<"$f")" = "test fix" ]
  [ "$(jq -r '.auto_fixable'  <<<"$f")" = "false" ]
  [ "$(jq -r '.blast_radius'  <<<"$f")" = "medium" ]
}

@test "emit: per-class severity / blast / auto_fixable map correctly" {
  _source_audit
  _atmux_audit_emit B "b" "b-fix"
  _atmux_audit_emit D "d" "d-fix"
  _atmux_audit_emit E "e" "e-fix"
  [ "$(jq -r '.severity'     <<<"${_atmux_audit_findings[0]}")" = "high"   ]
  [ "$(jq -r '.auto_fixable' <<<"${_atmux_audit_findings[0]}")" = "false"  ]
  [ "$(jq -r '.severity'     <<<"${_atmux_audit_findings[1]}")" = "low"    ]
  [ "$(jq -r '.auto_fixable' <<<"${_atmux_audit_findings[1]}")" = "true"   ]
  [ "$(jq -r '.severity'     <<<"${_atmux_audit_findings[2]}")" = "low"    ]
  [ "$(jq -r '.auto_fixable' <<<"${_atmux_audit_findings[2]}")" = "true"   ]
}

@test "render_json: empty array on no findings" {
  _source_audit
  run _atmux_audit_render_json
  [ "$status" -eq 0 ]
  [[ "$output" =~ "[]" ]]
}

@test "render_json: emits one object per finding under jq -s" {
  _source_audit
  _atmux_audit_emit A "a-detail" "a-fix"
  _atmux_audit_emit D "d-detail" "d-fix"
  run _atmux_audit_render_json
  [ "$status" -eq 0 ]
  local n; n="$(jq -r 'length' <<<"$output")"
  [ "$n" = "2" ]
  [ "$(jq -r '.[0].class' <<<"$output")" = "A" ]
  [ "$(jq -r '.[1].class' <<<"$output")" = "D" ]
}

@test "render_human: green message on no findings" {
  _source_audit
  run _atmux_audit_render_human
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no drift" ]]
}

# ---- Class B (team.json regex — no tmux needed) ------------------------

@test "class B: detects /tmp/atmux-tmux-<team> hyphen form" {
  _source_audit
  jq '.tmuxTmpdir = "/tmp/atmux-tmux-foo"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _atmux_audit_class_b_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  [ "$(jq -r '.class'    <<<"${_atmux_audit_findings[0]}")" = "B" ]
  [ "$(jq -r '.severity' <<<"${_atmux_audit_findings[0]}")" = "high" ]
  [[ "$(jq -r '.detail' <<<"${_atmux_audit_findings[0]}")" =~ "atmux-tmux-foo" ]]
}

@test "class B: clean on /tmp/atmux_tmux_<team> underscore form" {
  _source_audit
  jq '.tmuxTmpdir = "/tmp/atmux_tmux_foo"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _atmux_audit_class_b_detect
  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class B: skips when tmuxTmpdir absent" {
  _source_audit
  # The init helper may or may not have set tmuxTmpdir; force-clear it.
  jq 'del(.tmuxTmpdir)' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _atmux_audit_class_b_detect
  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class B: bare /tmp/atmux-tmux (no team suffix) is NOT flagged" {
  # The regex requires a trailing -<something>. Operators with the
  # daily-driver default-socket setup at bare /tmp/atmux-tmux shouldn't
  # be flagged (out of scope for class B).
  _source_audit
  jq '.tmuxTmpdir = "/tmp/atmux-tmux"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _atmux_audit_class_b_detect
  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

# ---- Class E (filesystem — no tmux needed) -----------------------------

@test "class E: flags empty cage dir with no socket and no registry entry" {
  _source_audit
  # Drop a stray empty cage dir into the sandboxed scan root.
  local stray="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_orphan_$$"
  mkdir -p "$stray/tmux-0"

  _atmux_audit_class_e_detect || true

  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  local f="${_atmux_audit_findings[0]}"
  [ "$(jq -r '.class'    <<<"$f")" = "E" ]
  [ "$(jq -r '.severity' <<<"$f")" = "low" ]
  [[ "$(jq -r '.detail' <<<"$f")" =~ "atmux_tmux_orphan_$$" ]]
}

@test "class E: skips dir with a live socket inside" {
  _source_audit
  # A real unix socket file is the simplest signal — we don't need a
  # tmux server, just a `default` file of socket type so the [[ -S ]]
  # test fires.
  local livedir="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_live_$$"
  mkdir -p "$livedir/tmux-0"
  python3 -c "
import socket
s = socket.socket(socket.AF_UNIX)
s.bind('$livedir/tmux-0/default')
" 2>/dev/null

  _atmux_audit_class_e_detect

  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class E: skips dir whose path matches a registered team's tmuxTmpdir" {
  _source_audit
  # Stand up a "registered" empty tmpdir under the sandboxed scan root.
  local regdir="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_reg_$$"
  mkdir -p "$regdir/tmux-0"

  # Synthesize a registry entry pointing to a fake project root that
  # carries .atmux/team.json with this regdir as tmuxTmpdir.
  local fake_proj="$ATMUX_TEST_TMP/fake_proj_$$"
  mkdir -p "$fake_proj/.atmux"
  cat > "$fake_proj/.atmux/team.json" <<JSON
{"name":"reg$$","tmuxTmpdir":"$regdir","members":[]}
JSON
  ATMUX_DIR="$fake_proj/.atmux" atmux::registry_upsert "reg$$" "$fake_proj" "reg$$" >/dev/null

  _atmux_audit_class_e_detect

  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

# ---- Class F stub ------------------------------------------------------

# ---- Class A / C / D (tmux-backed sandbox sessions) -------------------

# Helper: set the team's session.txt + tmux-tmpdir state to a synthetic
# sandbox session, spawn it via the sandbox tmux socket, then echo the
# session name. Caller is responsible for window setup.
_atmux_audit_seed_tmux_session() {
  local sess="$1"
  printf '%s\n' "$sess" > .atmux/state/session.txt
  jq --arg s "$sess" '.name = $s' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  tmux new-session -d -s "$sess" -n "scratch" 3>&- 4>&-
}

_atmux_audit_kill_tmux_session() {
  local sess="$1"
  tmux kill-session -t "=$sess" 2>/dev/null || true
}

@test "class A: flags bare 'driver' window without team prefix" {
  _source_audit
  _atmux_audit_seed_tmux_session "audtA"
  tmux new-window -d -t "=audtA" -n "driver" 3>&- 4>&-

  _atmux_audit_class_a_detect || true
  _atmux_audit_kill_tmux_session "audtA"

  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  [ "$(jq -r '.class'    <<<"${_atmux_audit_findings[0]}")" = "A" ]
  [ "$(jq -r '.severity' <<<"${_atmux_audit_findings[0]}")" = "medium" ]
  [[ "$(jq -r '.detail' <<<"${_atmux_audit_findings[0]}")" =~ "audtA__driver" ]]
}

@test "class A: clean when only '__<team>__driver' window exists" {
  _source_audit
  _atmux_audit_seed_tmux_session "audtA2"
  tmux new-window -d -t "=audtA2" -n "__audtA2__driver" 3>&- 4>&-

  _atmux_audit_class_a_detect
  _atmux_audit_kill_tmux_session "audtA2"

  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class C: flags driver pane not at position 1" {
  _source_audit
  _atmux_audit_seed_tmux_session "audtC"
  # Position 1 is the seeded 'scratch' window (not a driver / lead).
  # That trips class C's idx1 check.
  _atmux_audit_class_c_detect || true
  _atmux_audit_kill_tmux_session "audtC"

  # Two findings expected: idx1 wrong + idx2 missing-or-not-lead.
  # We only assert the idx1 one to keep the test focused.
  local idx1_found=0 f
  for f in "${_atmux_audit_findings[@]}"; do
    [ "$(jq -r '.class' <<<"$f")" = "C" ]
    if [[ "$(jq -r '.detail' <<<"$f")" =~ "window-position 1" ]]; then
      idx1_found=1
    fi
  done
  [ "$idx1_found" -eq 1 ]
}

@test "class C: clean when driver at idx1 and lead at idx2" {
  _source_audit
  _atmux_audit_seed_tmux_session "audtC2"
  # Rename the seeded idx1 'scratch' to 'driver' (rename-window
  # preserves position), then add the lead at idx2. Avoids killing the
  # last window — that would tear down the session.
  tmux rename-window -t "=audtC2:scratch" "driver"
  tmux new-window -d -t "=audtC2" -n "__audtC2__🧭lead" 3>&- 4>&-

  _atmux_audit_class_c_detect
  _atmux_audit_kill_tmux_session "audtC2"

  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class D: flags window with trailing dash residue" {
  _source_audit
  _atmux_audit_seed_tmux_session "audtD"
  tmux new-window -d -t "=audtD" -n "__audtD__lead-" 3>&- 4>&-

  _atmux_audit_class_d_detect || true
  _atmux_audit_kill_tmux_session "audtD"

  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  [ "$(jq -r '.class' <<<"${_atmux_audit_findings[0]}")" = "D" ]
  [[ "$(jq -r '.detail' <<<"${_atmux_audit_findings[0]}")" =~ "trailing punctuation" ]]
  # detail names the canonical rename target — no trailing dash.
  [[ "$(jq -r '.detail' <<<"${_atmux_audit_findings[0]}")" =~ \(canonical:\ \'__audtD__lead\'\) ]]
}

@test "class D: clean when no trailing-punct windows" {
  _source_audit
  _atmux_audit_seed_tmux_session "audtD2"
  tmux new-window -d -t "=audtD2" -n "__audtD2__lead" 3>&- 4>&-

  _atmux_audit_class_d_detect
  _atmux_audit_kill_tmux_session "audtD2"

  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class F: stub returns clean (deferred to Sk)" {
  _source_audit
  run _atmux_audit_class_f_detect
  [ "$status" -eq 0 ]
  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

# ---- Dispatcher hook ---------------------------------------------------

@test "dispatch_action: no-op stub returns 0" {
  _source_audit
  run _atmux_audit_dispatch_action
  [ "$status" -eq 0 ]
}
