#!/usr/bin/env bats
# Unit tests for ADR-027 topology invariant — _doctor_check_topology_invariant
# (lib/doctor.sh) + start/up preflight refuse-on-red gate (lib/start.sh,
# lib/up.sh).
#
# 3 severities the check produces:
#   green  — registry session exists + member count matches.
#   yellow — session exists but window count ≠ team.json:.members | length.
#   red    — wrong session OR superdriver absent.
#
# start/up gate red rows; doctor standalone reports without dying.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/doctor.sh
  . "$ATMUX_LIB_DIR/doctor.sh"
  atmux_assert_sandbox
}

teardown() {
  if [[ -n "${TMUX_TMPDIR:-}" ]]; then
    local socket
    for socket in "$TMUX_TMPDIR"/tmux-*/default "$TMUX_TMPDIR/default"; do
      [[ -S "$socket" ]] || continue
      tmux -S "$socket" kill-server 2>/dev/null || true
    done
  fi
  atmux_teardown_sandbox
}

# Build a project under $1 with team.json declaring $2 named members.
_seed_project() {
  local proj="$1" name="$2"; shift 2
  mkdir -p "$proj/.atmux"
  local mlist=""
  local m
  for m in "$@"; do
    [[ -n "$mlist" ]] && mlist+=","
    mlist+="{\"name\":\"$m\",\"role\":\"member\"}"
  done
  cat > "$proj/.atmux/team.json" <<JSON
{"name":"$name","tmuxTmpdir":"$ATMUX_TEST_TMP/tmux","members":[$mlist]}
JSON
  cat > "$proj/.atmux/kanban.json" <<'JSON'
{"tasks":[],"epics":[],"stories":[]}
JSON
}

# Spawn a tmux session $1 with one window per member name in $2..n, all named
# __<team>__<member> per ADR-030.
_spawn_team_session() {
  local sess="$1" team="$2"; shift 2
  local first="$1"; shift
  tmux new-session -d -s "$sess" -n "__${team}__${first}" -c "$ATMUX_TEST_TMP" 3>&- 4>&-
  local m
  for m in "$@"; do
    tmux new-window -t "$sess" -n "__${team}__${m}" -c "$ATMUX_TEST_TMP" 3>&- 4>&-
  done
}

# Convenience: dump the captured rows for a single label prefix.
_doctor_rows_matching() {
  local prefix="$1"
  local r
  # `${arr[@]:-}` form tolerates empty arrays under set -u (bats default).
  for r in "${_doctor_rows[@]:-}"; do
    [[ -n "$r" && "$r" == *"|topology:${prefix}"* ]] && printf '%s\n' "$r"
  done
  return 0
}

# ---------- 1. green path ----------

@test "topology: green — registry session present with matching member count" {
  local proj="$ATMUX_TEST_TMP/g1"
  _seed_project "$proj" alpha lead be-foo

  atmux::registry_upsert alpha "$proj" "alpha" >/dev/null
  _spawn_team_session alpha alpha lead be-foo

  # Spawn the superdriver session so the post-loop superdriver-presence
  # check renders green, not red — keeps this test focused on the per-team
  # row.
  tmux new-session -d -s atmux-superdriver -n superdriver -c "$HOME" 3>&- 4>&-

  _doctor_reset
  _doctor_check_topology_invariant

  [ "$_doctor_red_count" -eq 0 ]
  [ "$_doctor_yellow_count" -eq 0 ]
  local row; row="$(_doctor_rows_matching alpha)"
  [[ "$row" == "green|topology:alpha"* ]]
}

# ---------- 2. wrong-session red ----------

@test "topology: red — registry session foo but windows live in bar" {
  local proj="$ATMUX_TEST_TMP/r1"
  _seed_project "$proj" beta lead

  # Registry claims session=beta but windows are in 'beta-other' instead.
  atmux::registry_upsert beta "$proj" "beta" >/dev/null
  _spawn_team_session beta-other beta lead

  tmux new-session -d -s atmux-superdriver -n superdriver -c "$HOME" 3>&- 4>&-

  _doctor_reset
  _doctor_check_topology_invariant

  [ "$_doctor_red_count" -ge 1 ]
  local row; row="$(_doctor_rows_matching beta)"
  [[ "$row" == "red|topology:beta"* ]]
  [[ "$row" == *"beta-other"* ]]
  [[ "$row" == *"atmux team rename"* ]]
}

# ---------- 3. window-count yellow ----------

@test "topology: yellow — window count drift from team.json:.members | length" {
  local proj="$ATMUX_TEST_TMP/y1"
  # team.json declares 3 members but we only spawn 2 windows.
  _seed_project "$proj" gamma lead be-foo be-bar
  atmux::registry_upsert gamma "$proj" "gamma" >/dev/null
  _spawn_team_session gamma gamma lead be-foo

  tmux new-session -d -s atmux-superdriver -n superdriver -c "$HOME" 3>&- 4>&-

  _doctor_reset
  _doctor_check_topology_invariant

  [ "$_doctor_yellow_count" -ge 1 ]
  local row; row="$(_doctor_rows_matching gamma)"
  [[ "$row" == "yellow|topology:gamma"* ]]
  [[ "$row" == *"2 windows"* ]]
  [[ "$row" == *"expects 3"* ]]
}

# ---------- 4. superdriver-absent red ----------

@test "topology: red — superdriver session absent with ≥1 running team" {
  local proj="$ATMUX_TEST_TMP/sd1"
  _seed_project "$proj" delta lead
  atmux::registry_upsert delta "$proj" "delta" >/dev/null
  _spawn_team_session delta delta lead
  # Deliberately do NOT spawn atmux-superdriver.

  _doctor_reset
  _doctor_check_topology_invariant

  [ "$_doctor_red_count" -ge 1 ]
  local row; row="$(_doctor_rows_matching superdriver)"
  [[ "$row" == "red|topology:superdriver"* ]]
  [[ "$row" == *"super-attach"* ]]
}

# ---------- 5. start refuse on red ----------

@test "topology: atmux start refuses on red drift; team.json untouched" {
  # Build a sandbox project at $PWD/.atmux/ (sandbox cwd is the project dir).
  local proj="$ATMUX_TEST_TMP/project"
  _seed_project "$proj" eps lead
  atmux::registry_upsert eps "$proj" "wrong-session" >/dev/null
  _spawn_team_session some-other-sess eps lead
  # Don't spawn the registry-claimed session 'wrong-session' — that's the
  # red drift trigger.

  # Snapshot team.json to verify start did NOT mutate it.
  cp -p "$proj/.atmux/team.json" "$proj/.atmux/team.json.snapshot"

  # Either the topology gate refuses, OR the prior doctor-preflight refuses
  # (both surface the same drift, just one layer up). Either way: refuse +
  # team.json untouched is the contract.
  ATMUX_DIR="$proj/.atmux" run "$ATMUX_BIN" start
  [ "$status" -ne 0 ]
  [[ "$output" =~ "topology" || "$output" =~ "preflight failed" || "$output" =~ "drift" ]]

  cmp -s "$proj/.atmux/team.json" "$proj/.atmux/team.json.snapshot"
}

# ---------- 6. start --force override ----------

@test "topology: atmux start --force proceeds despite red drift" {
  local proj="$ATMUX_TEST_TMP/project"
  _seed_project "$proj" zeta lead
  atmux::registry_upsert zeta "$proj" "wrong-session" >/dev/null
  _spawn_team_session decoy zeta lead

  # --force overrides the topology gate. The downstream start path may
  # still fail (no real TUI / etc.), but the topology die() must NOT fire.
  ATMUX_DIR="$proj/.atmux" run "$ATMUX_BIN" start --force --no-doctor
  # Whether start fully succeeds depends on TUI mocks; what matters is
  # the topology gate didn't refuse with its specific die-message.
  [[ "$output" != *"topology drift detected (ADR-027)"* ]]
}

# ---------- 7. up refuse on red ----------

@test "topology: atmux up refuses on red drift" {
  local proj="$ATMUX_TEST_TMP/project"
  _seed_project "$proj" eta lead
  atmux::registry_upsert eta "$proj" "wrong-session" >/dev/null
  _spawn_team_session decoy eta lead

  ATMUX_DIR="$proj/.atmux" run "$ATMUX_BIN" up
  [ "$status" -ne 0 ]
  [[ "$output" =~ "topology" || "$output" =~ "drift" ]]
}

# ---------- 8. doctor standalone does NOT die on red ----------

@test "topology: atmux doctor on red drift renders row but does not die" {
  local proj="$ATMUX_TEST_TMP/project"
  _seed_project "$proj" theta lead
  atmux::registry_upsert theta "$proj" "wrong-session" >/dev/null
  _spawn_team_session decoy theta lead

  ATMUX_DIR="$proj/.atmux" run "$ATMUX_BIN" doctor
  # doctor exits non-zero on red (per main()'s `[[ red_count -eq 0 ]]`),
  # but it does NOT atmux::die — the run completes the full check loop
  # and emits the row content.
  [[ "$output" =~ "topology:" || "$output" =~ "topology" ]]
  # Crucially, the start/up-specific die message is NOT present.
  [[ "$output" != *"topology drift detected (ADR-027)"* ]]
}

# ---------- 9. empty registry → silent ----------

@test "topology: empty registry → check returns silently (no rows)" {
  rm -f "$ATMUX_REGISTRY"

  _doctor_reset
  _doctor_check_topology_invariant

  [ "$_doctor_red_count" -eq 0 ]
  [ "$_doctor_yellow_count" -eq 0 ]
  [ "${#_doctor_rows[@]}" -eq 0 ]
}

# ---------- 10. tmux unavailable → silent ----------

@test "topology: tmux unavailable → check returns silently" {
  local proj="$ATMUX_TEST_TMP/project"
  _seed_project "$proj" iota lead
  atmux::registry_upsert iota "$proj" "iota" >/dev/null

  # Stub `command` so its `command -v tmux` lookup returns failure inside
  # the check, while bash builtins + everything else stay reachable. Doing
  # this via PATH masking would also lose `bash` itself.
  command() {
    if [[ "$1" == "-v" && "$2" == "tmux" ]]; then
      return 1
    fi
    builtin command "$@"
  }
  export -f command 2>/dev/null || true

  _doctor_reset
  _doctor_check_topology_invariant

  [ "${#_doctor_rows[@]}" -eq 0 ]
  [ "$_doctor_red_count" -eq 0 ]
  [ "$_doctor_yellow_count" -eq 0 ]

  unset -f command
}

# ---------- bonus: deregistered (status=stopped) team is NOT checked ----------

@test "topology: status=stopped teams are skipped (no rows emitted)" {
  local proj="$ATMUX_TEST_TMP/skip"
  _seed_project "$proj" kappa lead
  atmux::registry_upsert kappa "$proj" "kappa" >/dev/null
  atmux::registry_deregister kappa >/dev/null

  _doctor_reset
  _doctor_check_topology_invariant

  # No per-team row for a stopped entry, regardless of session presence.
  local row; row="$(_doctor_rows_matching kappa)"
  [ -z "$row" ]
}
