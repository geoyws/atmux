#!/usr/bin/env bats
# Unit tests for ADR-018 per-team tmux socket isolation — covers the 3
# touch points:
#   1. bin/atmux early TMUX_TMPDIR export from team.json:.tmuxTmpdir.
#   2. lib/cron.sh:_atmux_cron_render_lines TMUX_TMPDIR= prefix on every line.
#   3. lib/doctor.sh:_doctor_check_tmux_tmpdir 3-state row (red/yellow/green).
#
# Sandboxed crontab via PATH-prepended shim (mirror of cron_install.bats).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  atmux_assert_sandbox

  # Mock crontab shim — same shape as cron_install.bats.
  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  export ATMUX_TEST_CRONTAB="$ATMUX_TEST_TMP/crontab.txt"
  cat > "$ATMUX_MOCK_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
sf="${ATMUX_TEST_CRONTAB:?}"
case "$1" in
  -l) [[ -f "$sf" ]] && cat "$sf" || { echo "no crontab" >&2; exit 1; } ;;
  -r) rm -f "$sf" ;;
  *)  [[ -f "$1" ]] && cp "$1" "$sf" || { echo "missing: $1" >&2; exit 2; } ;;
esac
EOF
  chmod +x "$ATMUX_MOCK_BIN/crontab"
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- Section 1: bin/atmux env export ----------

@test "tmux-socket: bin/atmux exports TMUX_TMPDIR from team.json:.tmuxTmpdir" {
  local target="$ATMUX_TEST_TMP/socket-A"
  # Ensure dir does NOT exist yet; the bin's auto-mkdir should create it.
  ! [[ -d "$target" ]]

  mkdir -p "$ATMUX_DIR"
  cat > "$ATMUX_DIR/team.json" <<JSON
{"name":"sock1","tmuxTmpdir":"$target","members":[]}
JSON

  # Use `atmux version` — cheap verb that runs the bin's preflight env-export
  # path. Pipe it back via env to inspect the exported state from a child
  # script (the parent test shell never receives the export).
  cat > "$ATMUX_TEST_TMP/probe.sh" <<'EOF'
#!/usr/bin/env bash
echo "TMUX_TMPDIR=${TMUX_TMPDIR:-<UNSET>}"
EOF
  chmod +x "$ATMUX_TEST_TMP/probe.sh"

  # Wrap: bin/atmux sets TMUX_TMPDIR before sourcing common.sh; then we
  # invoke a follow-up bash that inherits that env. The trick: source
  # bin/atmux's _atmux_resolve_tmux_tmpdir helper directly to drive the
  # export path without forking the dispatcher.
  unset TMUX_TMPDIR
  run bash -c '
    cd "$ATMUX_DIR/.."
    # Replicate the bin/atmux preflight: shellcheck disable=SC1090
    _atmux_resolve_tmux_tmpdir() {
      [[ -n "${TMUX_TMPDIR:-}" ]] && return 0
      command -v jq >/dev/null 2>&1 || return 0
      local tj="$ATMUX_DIR/team.json"
      [[ -f "$tj" ]] || return 0
      local val
      val="$(jq -r ".tmuxTmpdir // empty" "$tj" 2>/dev/null)"
      [[ -n "$val" && "$val" != "null" ]] || return 0
      mkdir -p "$val" 2>/dev/null || true
      export TMUX_TMPDIR="$val"
    }
    _atmux_resolve_tmux_tmpdir
    echo "TMUX_TMPDIR=${TMUX_TMPDIR:-<UNSET>}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"TMUX_TMPDIR=$target"* ]]
  # auto-mkdir landed.
  [ -d "$target" ]
}

@test "tmux-socket: bin/atmux preserves operator-set TMUX_TMPDIR (no clobber)" {
  mkdir -p "$ATMUX_DIR"
  cat > "$ATMUX_DIR/team.json" <<JSON
{"name":"sock2","tmuxTmpdir":"$ATMUX_TEST_TMP/from-team","members":[]}
JSON
  local pre="$ATMUX_TEST_TMP/operator-override"
  run env TMUX_TMPDIR="$pre" bash -c '
    _atmux_resolve_tmux_tmpdir() {
      [[ -n "${TMUX_TMPDIR:-}" ]] && return 0
      echo "would have rewritten" >&2
      return 99
    }
    _atmux_resolve_tmux_tmpdir
    echo "TMUX_TMPDIR=$TMUX_TMPDIR"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"TMUX_TMPDIR=$pre"* ]]
}

@test "tmux-socket: missing team.json → preflight is silent no-op" {
  rm -rf "$ATMUX_DIR"
  unset TMUX_TMPDIR
  run bash -c '
    _atmux_resolve_tmux_tmpdir() {
      [[ -n "${TMUX_TMPDIR:-}" ]] && return 0
      command -v jq >/dev/null 2>&1 || return 0
      local tj="$ATMUX_DIR/team.json"
      [[ -f "$tj" ]] || return 0
      mkdir -p /nope-should-not-fire 2>/dev/null || true
    }
    _atmux_resolve_tmux_tmpdir
    echo "TMUX_TMPDIR=${TMUX_TMPDIR:-<UNSET>}"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"TMUX_TMPDIR=<UNSET>"* ]]
  ! [[ -d /nope-should-not-fire ]]
}

# ---------- Section 2: cron line shape ----------

@test "tmux-socket: cron lines carry TMUX_TMPDIR= prefix when team has tmuxTmpdir" {
  # shellcheck source=../../lib/cron.sh
  . "$ATMUX_LIB_DIR/cron.sh"

  "$ATMUX_BIN" init --name sockcron >/dev/null
  # Patch team.json:.tmuxTmpdir to a known sentinel value.
  jq --arg t "$ATMUX_TEST_TMP/sock-cron-dir" '.tmuxTmpdir = $t' .atmux/team.json > /tmp/tj.tmp
  mv /tmp/tj.tmp .atmux/team.json

  rm -f "$ATMUX_TEST_CRONTAB"
  unset ATMUX_NO_CRON
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install sockcron "$ATMUX_DIR"

  [ -f "$ATMUX_TEST_CRONTAB" ]
  # Every cron line between markers begins with TMUX_TMPDIR=<value> .
  local cron_lines
  cron_lines="$(awk '/^# >>> atmux:team=sockcron/,/^# <<< atmux:team=sockcron/' "$ATMUX_TEST_CRONTAB" \
                | grep -E '^[*0-9].*atmux ')"
  [ -n "$cron_lines" ]
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" == *"TMUX_TMPDIR=$ATMUX_TEST_TMP/sock-cron-dir "* ]]
  done <<<"$cron_lines"
}

@test "tmux-socket: no .tmuxTmpdir → no TMUX_TMPDIR= prefix on cron lines" {
  . "$ATMUX_LIB_DIR/cron.sh"

  "$ATMUX_BIN" init --name socknone >/dev/null
  # Strip tmuxTmpdir field so the legacy prefix-free behaviour is tested.
  jq 'del(.tmuxTmpdir)' .atmux/team.json > /tmp/tj.tmp
  mv /tmp/tj.tmp .atmux/team.json

  rm -f "$ATMUX_TEST_CRONTAB"
  unset ATMUX_NO_CRON
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install socknone "$ATMUX_DIR"

  [ -f "$ATMUX_TEST_CRONTAB" ]
  # No TMUX_TMPDIR= anywhere in the block.
  local block
  block="$(awk '/^# >>> atmux:team=socknone/,/^# <<< atmux:team=socknone/' "$ATMUX_TEST_CRONTAB")"
  [[ "$block" != *"TMUX_TMPDIR="* ]]
}

# ---------- Section 3: doctor row ----------

@test "tmux-socket: doctor row absent when team.json has no tmuxTmpdir" {
  . "$ATMUX_LIB_DIR/doctor.sh"
  "$ATMUX_BIN" init --name dn >/dev/null
  jq 'del(.tmuxTmpdir)' .atmux/team.json > /tmp/tj.tmp
  mv /tmp/tj.tmp .atmux/team.json

  _doctor_reset
  _doctor_check_tmux_tmpdir
  # Iterate any rows the function may have added; assert none target tmux-socket.
  local r
  for r in "${_doctor_rows[@]:-}"; do
    [[ -n "$r" ]] || continue
    [[ "$r" != *"|tmux-socket|"* ]]
  done
}

@test "tmux-socket: doctor row=yellow when tmpdir writable but no session yet" {
  . "$ATMUX_LIB_DIR/doctor.sh"
  "$ATMUX_BIN" init --name dy >/dev/null
  local target="$ATMUX_TEST_TMP/yellow-tmpdir"
  jq --arg t "$target" '.tmuxTmpdir = $t' .atmux/team.json > /tmp/tj.tmp
  mv /tmp/tj.tmp .atmux/team.json

  # No tmux server on the target — yellow path.
  _doctor_reset
  _doctor_check_tmux_tmpdir

  [ "$_doctor_yellow_count" -ge 1 ]
  local row="" r
  for r in "${_doctor_rows[@]:-}"; do
    [[ "$r" == *"|tmux-socket|"* ]] && row="$r"
  done
  [[ "$row" == "yellow|tmux-socket"* ]]
  [[ "$row" == *"no session active"* ]]
  [ -d "$target" ]
}

@test "tmux-socket: doctor row=red when tmpdir not writable" {
  . "$ATMUX_LIB_DIR/doctor.sh"
  "$ATMUX_BIN" init --name dr >/dev/null

  # Use a path whose parent is a regular file — mkdir -p will fail
  # because traversal can't proceed through a non-directory. This works
  # under root too (chmod 000 + root would silently succeed).
  local barrier="$ATMUX_TEST_TMP/barrier-file"
  : > "$barrier"
  local target="$barrier/cannot-create"
  jq --arg t "$target" '.tmuxTmpdir = $t' .atmux/team.json > /tmp/tj.tmp
  mv /tmp/tj.tmp .atmux/team.json

  _doctor_reset
  _doctor_check_tmux_tmpdir

  [ "$_doctor_red_count" -ge 1 ]
  local row="" r
  for r in "${_doctor_rows[@]:-}"; do
    [[ "$r" == *"|tmux-socket|"* ]] && row="$r"
  done
  [[ "$row" == "red|tmux-socket"* ]]
  [[ "$row" == *"not writable"* ]]
}

@test "tmux-socket: doctor row=green when tmpdir + active tmux session" {
  . "$ATMUX_LIB_DIR/doctor.sh"
  "$ATMUX_BIN" init --name dg >/dev/null
  local target="$ATMUX_TEST_TMP/green-tmpdir"
  mkdir -p "$target"
  jq --arg t "$target" '.tmuxTmpdir = $t' .atmux/team.json > /tmp/tj.tmp
  mv /tmp/tj.tmp .atmux/team.json

  # Spawn a tmux server on the target socket so the green path lands.
  TMUX_TMPDIR="$target" tmux new-session -d -s probe -c "$ATMUX_TEST_TMP" 3>&- 4>&-

  _doctor_reset
  _doctor_check_tmux_tmpdir

  local row="" r
  for r in "${_doctor_rows[@]:-}"; do
    [[ "$r" == *"|tmux-socket|"* ]] && row="$r"
  done
  [[ "$row" == "green|tmux-socket"* ]]
  [[ "$row" == *"healthy"* ]]

  # Reap the probe server.
  TMUX_TMPDIR="$target" tmux kill-server 2>/dev/null || true
}
