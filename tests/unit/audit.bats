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

@test "audit: --fix --class a accepted (Sf added pane-idle gate)" {
  # Sandbox has no driver pane → no class A finding → fixer no-op success.
  run "$ATMUX_BIN" audit --fix --class a
  [ "$status" -eq 0 ]
}

@test "audit: --fix --class b refused without driver env" {
  unset ATMUX_AUDIT_DRIVER_FIRED
  run "$ATMUX_BIN" audit --fix --class b
  [ "$status" -ne 0 ]
  [[ "$output" =~ "ATMUX_AUDIT_DRIVER_FIRED=YES" ]]
}

@test "audit: --fix --class b accepted with ATMUX_AUDIT_DRIVER_FIRED=YES" {
  # Sandbox has no class B finding → fixer no-op success.
  ATMUX_AUDIT_DRIVER_FIRED=YES run "$ATMUX_BIN" audit --fix --class b
  [ "$status" -eq 0 ]
}

@test "audit: --fix --class c refused (high-blast surface-only)" {
  run "$ATMUX_BIN" audit --fix --class c
  [ "$status" -ne 0 ]
  [[ "$output" =~ "high-blast" ]] || [[ "$output" =~ "surface-only" ]]
}

@test "audit: --fix --class d on green sandbox is no-op success" {
  run "$ATMUX_BIN" audit --fix --class d
  [ "$status" -eq 0 ]
}

@test "audit: --fix on green sandbox dispatches but no fixers fire" {
  run "$ATMUX_BIN" audit --fix
  [ "$status" -eq 0 ]
}

@test "audit: --dry-run without --fix is rejected" {
  run "$ATMUX_BIN" audit --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" =~ "requires --fix" ]]
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

@test "dispatch_action: no-op when fix_mode is off" {
  _source_audit
  _atmux_audit_fix_mode=0
  run _atmux_audit_dispatch_action
  [ "$status" -eq 0 ]
}

# ---- Class D fixer -----------------------------------------------------

@test "class D fix: rename-window strips trailing dash" {
  _source_audit
  _atmux_audit_seed_tmux_session "auFD"
  tmux new-window -d -t "=auFD" -n "__auFD__lead-" 3>&- 4>&-

  _atmux_audit_class_d_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local wins
  wins="$(tmux list-windows -t "=auFD" -F '#{window_name}' 2>/dev/null)"
  _atmux_audit_kill_tmux_session "auFD"

  [[ "$wins" =~ "__auFD__lead" ]]
  [[ ! "$wins" =~ "__auFD__lead-" ]]
}

@test "class D fix: idempotent — second run on clean window is no-op" {
  _source_audit
  _atmux_audit_seed_tmux_session "auFD2"
  tmux new-window -d -t "=auFD2" -n "__auFD2__lead-" 3>&- 4>&-

  _atmux_audit_class_d_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  # Re-detect on the now-clean state should produce no D findings.
  _atmux_audit_findings=()
  _atmux_audit_class_d_detect

  _atmux_audit_kill_tmux_session "auFD2"

  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}

@test "class D fix: --dry-run does not mutate" {
  _source_audit
  _atmux_audit_seed_tmux_session "auFD3"
  tmux new-window -d -t "=auFD3" -n "__auFD3__lead-" 3>&- 4>&-

  _atmux_audit_class_d_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=1
  _atmux_audit_dispatch_action

  local wins
  wins="$(tmux list-windows -t "=auFD3" -F '#{window_name}' 2>/dev/null)"
  _atmux_audit_kill_tmux_session "auFD3"

  # Window still has the trailing dash.
  [[ "$wins" =~ "__auFD3__lead-" ]]
}

# ---- Class E fixer -----------------------------------------------------

@test "class E fix: rmdir reaps stray empty cage dir" {
  _source_audit
  local stray="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_orphan_$$"
  mkdir -p "$stray/tmux-0"

  _atmux_audit_class_e_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  ! [ -d "$stray" ]
}

@test "class E fix: refuses when live socket exists (defensive re-check)" {
  _source_audit
  local livedir="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_live_$$"
  mkdir -p "$livedir/tmux-0"

  # Synthesize a stale finding (detail names this path) — force the
  # fixer to evaluate the 3-clause guard at fix time. After the
  # detector ran in this test, we simulate someone spawning a socket
  # between detect and fix.
  _atmux_audit_findings=("$(jq -nc \
    --arg path "$livedir" \
    '{class:"E", severity:"low", team:"t", detail:("stray cage tmpdir '"'"'" + $path + "'"'"' (stale)"),
      fix_hint:"rmdir", auto_fixable:true, blast_radius:"low"}')")

  python3 -c "
import socket
s = socket.socket(socket.AF_UNIX)
s.bind('$livedir/tmux-0/default')
" 2>/dev/null

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  [ -d "$livedir" ]
  rm -rf "$livedir"
}

@test "class E fix: refuses when path doesn't match /tmp/atmux*tmux* shape" {
  _source_audit
  local outside="$ATMUX_TEST_TMP/random-path"
  mkdir -p "$outside/tmux-0"

  # Stale finding pointing OUTSIDE the allowed shape — fixer must
  # refuse rather than rmdir.
  _atmux_audit_findings=("$(jq -nc \
    --arg path "$outside" \
    '{class:"E", severity:"low", team:"t", detail:("stray cage tmpdir '"'"'" + $path + "'"'"' (stale)"),
      fix_hint:"rmdir", auto_fixable:true, blast_radius:"low"}')")

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  [ -d "$outside" ]
  rm -rf "$outside"
}

@test "class E fix: --dry-run does not mutate" {
  _source_audit
  local stray="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_dry_$$"
  mkdir -p "$stray/tmux-0"

  _atmux_audit_class_e_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=1
  _atmux_audit_dispatch_action

  [ -d "$stray" ]
  rm -rf "$stray"
}

# ---- Class B fixer: cage-path migration (driver-fired) -----------------

@test "class B fix: refuses when ATMUX_AUDIT_DRIVER_FIRED is unset" {
  _source_audit
  unset ATMUX_AUDIT_DRIVER_FIRED
  _atmux_audit_findings=("$(jq -nc \
    '{class:"B", severity:"high", team:"foo",
      detail:"team.json:.tmuxTmpdir uses hyphen-form '"'"'/tmp/atmux-tmux-foo'"'"' (canonical: /tmp/atmux_tmux_foo)",
      fix_hint:"...", auto_fixable:false, blast_radius:"high"}')")
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0

  # Stub repair-rename so the test can't accidentally fire it.
  _atmux_audit_invoke_repair_rename() { echo "STUB INVOKED for $1" >&2; return 99; }

  _atmux_audit_dispatch_action

  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=B.*result=skip.*ATMUX_AUDIT_DRIVER_FIRED' .atmux/logs/audit-fix.log
  # Stub must NOT have fired (the gate refused first).
  ! grep -q 'STUB INVOKED' .atmux/logs/audit-fix.log
}

@test "class B fix: --dry-run with env logs would-invoke without firing" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES
  _atmux_audit_findings=("$(jq -nc \
    '{class:"B", severity:"high", team:"foo",
      detail:"team.json:.tmuxTmpdir uses hyphen-form '"'"'/tmp/atmux-tmux-foo'"'"' (canonical: /tmp/atmux_tmux_foo)",
      fix_hint:"...", auto_fixable:false, blast_radius:"high"}')")
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=1

  local invoked=0
  _atmux_audit_invoke_repair_rename() { invoked=$((invoked + 1)); return 0; }

  _atmux_audit_dispatch_action

  [ "$invoked" -eq 0 ]
  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=B.*result=dry-run.*team repair-rename foo' .atmux/logs/audit-fix.log
}

@test "class B fix: with env + non-dry, invokes repair-rename + logs ok" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES
  _atmux_audit_findings=("$(jq -nc \
    '{class:"B", severity:"high", team:"foo",
      detail:"team.json:.tmuxTmpdir uses hyphen-form '"'"'/tmp/atmux-tmux-foo'"'"' (canonical: /tmp/atmux_tmux_foo)",
      fix_hint:"...", auto_fixable:false, blast_radius:"high"}')")
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0

  _atmux_audit_invoke_repair_rename() {
    [ "$1" = "foo" ] || return 1
    return 0
  }

  _atmux_audit_dispatch_action

  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=B.*result=ok.*repair-rename foo succeeded' .atmux/logs/audit-fix.log
}

@test "class B fix: failed repair-rename logs fail with truncated stderr" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES
  _atmux_audit_findings=("$(jq -nc \
    '{class:"B", severity:"high", team:"foo",
      detail:"team.json:.tmuxTmpdir uses hyphen-form '"'"'/tmp/atmux-tmux-foo'"'"' (canonical: /tmp/atmux_tmux_foo)",
      fix_hint:"...", auto_fixable:false, blast_radius:"high"}')")
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0

  _atmux_audit_invoke_repair_rename() {
    printf 'repair-rename: target tmpdir already exists\nadditional context line\n'
    return 1
  }

  _atmux_audit_dispatch_action

  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=B.*result=fail.*target tmpdir already exists' .atmux/logs/audit-fix.log
  # Second line of stderr should NOT make it into the log row (truncated to first).
  ! grep -q 'class=B.*additional context line' .atmux/logs/audit-fix.log
}

@test "class B fix: empty team field logs fail (cannot resolve target)" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES
  _atmux_audit_findings=("$(jq -nc \
    '{class:"B", severity:"high", team:"",
      detail:"hyphen-form drift", fix_hint:"...",
      auto_fixable:false, blast_radius:"high"}')")
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0

  local invoked=0
  _atmux_audit_invoke_repair_rename() { invoked=$((invoked + 1)); return 0; }

  _atmux_audit_dispatch_action

  [ "$invoked" -eq 0 ]
  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=B.*result=fail.*no team in finding' .atmux/logs/audit-fix.log
}

# ---- Class A fixer: pane-idle gate -------------------------------------

@test "pane-idle: accepts bare bash prompt" {
  _source_audit
  local state='~/foo $ '
  run _atmux_audit_pane_idle_reason "$state"
  [ "$status" -eq 0 ]
  [ "$output" = "ok" ]
}

@test "pane-idle: accepts starship/powerline ❯ prompt" {
  _source_audit
  local state='~/foo ❯ '
  run _atmux_audit_pane_idle_reason "$state"
  [ "$output" = "ok" ]
}

@test "pane-idle: accepts » prompt" {
  _source_audit
  local state='~/foo » '
  run _atmux_audit_pane_idle_reason "$state"
  [ "$output" = "ok" ]
}

@test "pane-idle: refuses on 'Compacting conversation' banner" {
  _source_audit
  local state='✻ Compacting conversation… (4k tokens)
~/foo $ '
  run _atmux_audit_pane_idle_reason "$state"
  [[ "$output" =~ "TUI banner detected" ]]
}

@test "pane-idle: refuses on 'Press up to edit queued messages'" {
  _source_audit
  local state='Press up to edit queued messages
~/foo $ '
  run _atmux_audit_pane_idle_reason "$state"
  [[ "$output" =~ "TUI banner detected" ]]
}

@test "pane-idle: refuses on 'hit your limit' rate-limit modal" {
  _source_audit
  local state='You hit your limit — try again in 1h
~/foo $ '
  run _atmux_audit_pane_idle_reason "$state"
  [[ "$output" =~ "TUI banner detected" ]]
}

@test "pane-idle: refuses on 'thinking with' mid-turn signal" {
  _source_audit
  local state='✶ thinking with extended reasoning…'
  run _atmux_audit_pane_idle_reason "$state"
  [[ "$output" =~ "TUI banner detected" ]]
}

@test "pane-idle: refuses on 'Esc to interrupt' token counter" {
  _source_audit
  local state='1.2k tokens · esc to interrupt'
  run _atmux_audit_pane_idle_reason "$state"
  [[ "$output" =~ "TUI banner detected" ]]
}

@test "pane-idle: refuses when last line is non-prompt output" {
  _source_audit
  local state='running build...'
  run _atmux_audit_pane_idle_reason "$state"
  [[ "$output" =~ "not at bare prompt" ]]
}

@test "class A fix: idle pane → renames driver → '__<team>__driver'" {
  _source_audit
  _atmux_audit_seed_tmux_session "auFA"
  tmux new-window -d -t "=auFA" -n "driver" 3>&- 4>&-

  # Force the preflight to accept regardless of the actual pane state.
  # The spawned bash's prompt depends on operator config and may not
  # match the canonical [$❯»] regex — but we're testing the fixer's
  # rename path, not the regex (covered by the pane-idle: tests above).
  _atmux_audit_pane_idle_reason() { printf 'ok\n'; }

  _atmux_audit_class_a_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local renamed bare
  renamed="$(tmux list-windows -t "=auFA" -F '#{window_name}' 2>/dev/null \
              | grep -cxF '__auFA__driver' || true)"
  bare="$(tmux list-windows -t "=auFA" -F '#{window_name}' 2>/dev/null \
              | grep -cxF 'driver' || true)"
  _atmux_audit_kill_tmux_session "auFA"

  [ "$renamed" = "1" ]
  [ "$bare" = "0" ]
  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=A.*result=ok' .atmux/logs/audit-fix.log
}

@test "class A fix: --dry-run on idle pane logs would-rename + skips mutation" {
  _source_audit
  _atmux_audit_seed_tmux_session "auFAd"
  tmux new-window -d -t "=auFAd" -n "driver" 3>&- 4>&-

  _atmux_audit_pane_idle_reason() { printf 'ok\n'; }

  _atmux_audit_class_a_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=1
  _atmux_audit_dispatch_action

  local bare
  bare="$(tmux list-windows -t "=auFAd" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  _atmux_audit_kill_tmux_session "auFAd"

  # Bare 'driver' window untouched.
  [ "$bare" = "1" ]
  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=A.*result=dry-run' .atmux/logs/audit-fix.log
}

@test "class A fix: refuses on busy pane (banner detected) — logs skip" {
  _source_audit
  _atmux_audit_seed_tmux_session "auFAb"
  tmux new-window -d -t "=auFAb" -n "driver" 3>&- 4>&-

  # Force preflight to refuse with a banner reason.
  _atmux_audit_pane_idle_reason() {
    printf 'claude TUI banner detected — refusing rename\n'
  }

  _atmux_audit_class_a_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local bare
  bare="$(tmux list-windows -t "=auFAb" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  _atmux_audit_kill_tmux_session "auFAb"

  # No rename happened.
  [ "$bare" = "1" ]
  [ -f .atmux/logs/audit-fix.log ]
  grep -q 'class=A.*result=skip.*banner' .atmux/logs/audit-fix.log
}

@test "class A fix: refuses when no team context is available" {
  _source_audit
  _atmux_audit_findings=("$(jq -nc \
    '{class:"A", severity:"medium", team:"", detail:"window driver test",
      fix_hint:"...", auto_fixable:false, blast_radius:"medium"}')")
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0

  # Override atmux::dir to fail — simulates running outside a team dir.
  # log_fix's fallback path writes to $ATMUX_AUDIT_FIX_LOG; pin it under
  # the sandbox so we can assert.
  export ATMUX_AUDIT_FIX_LOG="$ATMUX_TEST_TMP/audit-fix.log"
  atmux::dir() { return 1; }

  _atmux_audit_dispatch_action

  [ -f "$ATMUX_AUDIT_FIX_LOG" ]
  grep -q 'class=A.*result=fail' "$ATMUX_AUDIT_FIX_LOG"
}

# ---- log_fix -----------------------------------------------------------

@test "log_fix: appends a result line under .atmux/logs/audit-fix.log" {
  _source_audit
  _atmux_audit_log_fix D ok "renamed window" "test detail"
  [ -f .atmux/logs/audit-fix.log ]
  run cat .atmux/logs/audit-fix.log
  [[ "$output" =~ class=D ]]
  [[ "$output" =~ result=ok ]]
  [[ "$output" =~ "renamed window" ]]
}
