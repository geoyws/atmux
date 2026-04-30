#!/usr/bin/env bats
# Unit tests for _doctor_check_orphan_atmux_sessions per ADR-037.
#
# Hard safety property: non-atmux sessions on the operator socket
# (`__main`, `convoke`, `paste`, etc.) MUST NEVER be iterated. The
# namespace gate (`^atmux(_|$)`) is the first filter; everything else
# follows.
#
# Sandbox strategy
# ----------------
# atmux_setup_sandbox unsets $TMUX. The orphan-atmux check early-returns
# when $TMUX is unset, so each test sets TMUX explicitly to a sandbox
# tmux socket that does NOT match the cage-path regex
# (`*/atmux-tmux*` / `*/atmux_tmux_*`). $ATMUX_TEST_TMP/tmux/tmux-0/default
# satisfies that — it's the sandbox's TMUX_TMPDIR-derived socket,
# completely outside both atmux launcher and cage namespaces.
#
# Sessions are created via `tmux -S <socket> new-session -d -s <name>`
# and torn down per-test. Registry contents come from $ATMUX_REGISTRY
# which the sandbox already isolates to $ATMUX_TEST_TMP/registry.json.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  _orphan_atmux_setup_team
}

teardown() {
  _orphan_atmux_kill_test_sessions
  atmux_teardown_sandbox
}

# Minimal team.json so doctor's other checks pass and we can isolate
# the orphan-atmux row in output assertions. Same shape as doctor.bats's
# `_write_shell_team`.
_orphan_atmux_setup_team() {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "host",
  "members": [
    {"name": "w1", "role": "member", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
}

# Spin up the sandbox tmux daemon (idempotent — `has-session` probe
# avoids duplicate servers across tests in the same file). Explicit
# mkdir of the socket's containing dir because tmux -S doesn't always
# create $TMUX_TMPDIR/tmux-$UID/ when bypassed.
_orphan_atmux_ensure_socket() {
  local sock="$ATMUX_TEST_TMP/tmux/tmux-0/default"
  mkdir -p "$(dirname "$sock")"
  if ! tmux -S "$sock" has-session 2>/dev/null; then
    tmux -S "$sock" new-session -d -s __bootstrap -c "$ATMUX_TEST_TMP" 3>&- 4>&- || return 1
  fi
  printf '%s\n' "$sock"
}

_orphan_atmux_spawn_session() {
  local sock="$1" name="$2"
  tmux -S "$sock" new-session -d -s "$name" -c "$ATMUX_TEST_TMP" 3>&- 4>&-
}

_orphan_atmux_kill_test_sessions() {
  local sock="$ATMUX_TEST_TMP/tmux/tmux-0/default"
  [[ -S "$sock" ]] || return 0
  tmux -S "$sock" kill-server 2>/dev/null || true
}

# Build a registry with the named teams, projectRoot anchored under the
# sandbox to keep registry validation happy.
_orphan_atmux_seed_registry() {
  local entries=()
  for name in "$@"; do
    entries+=("$(jq -n --arg n "$name" --arg pr "$ATMUX_TEST_TMP/$n" \
      '{name: $n, projectRoot: $pr, sessionName: $n, createdAt: 0, lastSeen: 0, status: "running", members: []}')")
  done
  printf '['
  local i=0
  for entry in "${entries[@]}"; do
    [[ $i -gt 0 ]] && printf ','
    printf '%s' "$entry"
    i=$((i + 1))
  done
  printf ']\n'
}

# Compose a fake $TMUX value that points at the sandbox socket — the
# pid + session-id components are arbitrary; doctor only parses
# `${TMUX%%,*}` for the socket path.
_orphan_atmux_fake_tmux() {
  local sock="$1"
  printf '%s,%s,%s\n' "$sock" "$$" "0"
}

@test "orphan-atmux: green when registry-aligned launchers + non-atmux peers" {
  local sock; sock="$(_orphan_atmux_ensure_socket)"
  _orphan_atmux_seed_registry alpha beta > "$ATMUX_REGISTRY"

  # Allowlist sessions — should NOT emit rows.
  _orphan_atmux_spawn_session "$sock" atmux
  _orphan_atmux_spawn_session "$sock" atmux_superdriver
  _orphan_atmux_spawn_session "$sock" atmux_alpha
  _orphan_atmux_spawn_session "$sock" atmux_beta

  # Daily-driver project sessions (NON-atmux) — must stay invisible.
  _orphan_atmux_spawn_session "$sock" __main
  _orphan_atmux_spawn_session "$sock" convoke
  _orphan_atmux_spawn_session "$sock" paste
  _orphan_atmux_spawn_session "$sock" sb

  TMUX="$(_orphan_atmux_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "orphan-atmux-session" ]]
}

@test "orphan-atmux: yellow row when atmux_<X> session has no registry entry" {
  local sock; sock="$(_orphan_atmux_ensure_socket)"
  _orphan_atmux_seed_registry alpha > "$ATMUX_REGISTRY"

  _orphan_atmux_spawn_session "$sock" atmux_alpha    # registered → silent
  _orphan_atmux_spawn_session "$sock" atmux_ghost    # NOT registered → yellow

  TMUX="$(_orphan_atmux_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  [[ "$output" =~ "orphan-atmux-session:atmux_ghost" ]]
  [[ "$output" =~ "no registry entry" ]]
  ! [[ "$output" =~ "orphan-atmux-session:atmux_alpha" ]]
}

@test "orphan-atmux: namespace gate — non-atmux sessions never emit a row" {
  local sock; sock="$(_orphan_atmux_ensure_socket)"
  : > "$ATMUX_REGISTRY"
  echo '[]' > "$ATMUX_REGISTRY"

  # Names that resemble the user's daily-driver project sessions — none
  # match `^atmux(_|$)`. Even with an empty registry, NONE of these
  # should surface a row. This is the user's "don't clobber tmux-land"
  # safety contract.
  for name in __main convoke paste sb snap ix 26 icontest iconverify settled; do
    _orphan_atmux_spawn_session "$sock" "$name"
  done

  TMUX="$(_orphan_atmux_fake_tmux "$sock")" run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "orphan-atmux-session" ]]
}

@test "orphan-atmux: silent when \$TMUX is unset (cron path)" {
  local sock; sock="$(_orphan_atmux_ensure_socket)"
  : > "$ATMUX_REGISTRY"
  echo '[]' > "$ATMUX_REGISTRY"
  _orphan_atmux_spawn_session "$sock" atmux_ghost

  unset TMUX
  run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "orphan-atmux-session" ]]
}

@test "orphan-atmux: silent when attached to a cage socket" {
  local cage_sock="$ATMUX_TEST_TMP/atmux-tmux-fake/tmux-0/default"
  mkdir -p "$(dirname "$cage_sock")"
  tmux -S "$cage_sock" new-session -d -s __cage -c "$ATMUX_TEST_TMP" 3>&- 4>&-
  echo '[]' > "$ATMUX_REGISTRY"
  # Spawn a would-be orphan on the cage — but the check should refuse to
  # iterate cage-socket sessions regardless. The cage path matches
  # `*/atmux-tmux*/tmux-*/default` and we early-return.
  tmux -S "$cage_sock" new-session -d -s atmux_ghost -c "$ATMUX_TEST_TMP" 3>&- 4>&-

  TMUX="$(_orphan_atmux_fake_tmux "$cage_sock")" run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "orphan-atmux-session" ]]

  tmux -S "$cage_sock" kill-server 2>/dev/null || true
}
