#!/usr/bin/env bats
# Unit tests for lib/cron.sh — atmux::cron_install + atmux::cron_remove + the
# atmux start/stop wire-up that lands the marker block on team start and
# strips it on team stop (E6/Sc — t-7dab9a96 + t-ac7197cf).
#
# Sandboxed crontab via PATH-prepended shim
# -----------------------------------------
# Real `crontab` mutates the test runner's actual user crontab — non-starter
# for unit tests. Pattern: setup() prepends $ATMUX_TEST_TMP/mock-bin to PATH
# with a `crontab` script that read/writes a file at $ATMUX_TEST_TMP/crontab.txt
# instead of crond. Supports the two invocations cron.sh issues:
#   - `crontab -l`  → cat sandbox file (exit 1 if absent — matches real crond
#                                       behavior when no entries)
#   - `crontab <f>` → copy <f> contents into sandbox file (atomic write)
# Also handles `crontab -r` (remove) for completeness, though cron.sh doesn't
# call it. The shim is *active for the entire test* via PATH= prefix on each
# atmux invocation.
#
# Orphan-detection cases (cron-orphan doctor finding) are folded into
# tests/unit/doctor_audit.bats per the task body — not duplicated here.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name g >/dev/null

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  export ATMUX_TEST_CRONTAB="$ATMUX_TEST_TMP/crontab.txt"

  cat > "$ATMUX_MOCK_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
# Sandbox crontab shim — reads/writes $ATMUX_TEST_CRONTAB instead of crond.
sf="${ATMUX_TEST_CRONTAB:?ATMUX_TEST_CRONTAB unset}"
case "$1" in
  -l)
    if [[ -f "$sf" ]]; then cat "$sf"; exit 0
    else echo "no crontab for $USER" >&2; exit 1; fi
    ;;
  -r)
    rm -f "$sf"; exit 0 ;;
  -*)
    echo "mock-crontab: unsupported flag: $1" >&2; exit 2 ;;
  *)
    if [[ -f "$1" ]]; then cp "$1" "$sf"; exit 0
    else echo "mock-crontab: file not found: $1" >&2; exit 2; fi
    ;;
esac
EOF
  chmod +x "$ATMUX_MOCK_BIN/crontab"
}

teardown() {
  atmux_teardown_sandbox
}

# Source lib/common.sh + lib/cron.sh in the current shell so we can call the
# atmux::cron_install / atmux::cron_remove primitives directly.
_load_cron() {
  atmux_source_libs
  # shellcheck source=../../lib/cron.sh
  . "$ATMUX_LIB_DIR/cron.sh"
}

# Convenience: run a block with the mock crontab shim on PATH.
_with_mock_crontab() {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$@"
}

# ---------- cases 1-6: install/remove primitives ----------

@test "cron_install: empty crontab ⇒ marker block + 3 cron lines land" {
  _load_cron
  rm -f "$ATMUX_TEST_CRONTAB"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/sandbox-x"
  [ -f "$ATMUX_TEST_CRONTAB" ]
  grep -q '^# >>> atmux:team=team-x — managed by atmux start' "$ATMUX_TEST_CRONTAB"
  grep -q '^# <<< atmux:team=team-x$' "$ATMUX_TEST_CRONTAB"
  # 3 atmux invocations between markers — whip @ */5, report @ */30, decisions digest @ 0 */4.
  [ "$(grep -c 'ATMUX_DIR=.* whip ' "$ATMUX_TEST_CRONTAB")"  = "1" ]
  [ "$(grep -c 'ATMUX_DIR=.* report ' "$ATMUX_TEST_CRONTAB")"  = "1" ]
  [ "$(grep -c 'ATMUX_DIR=.* decisions digest ' "$ATMUX_TEST_CRONTAB")" = "1" ]
}

@test "cron_install: idempotent — re-running yields byte-identical crontab" {
  _load_cron
  rm -f "$ATMUX_TEST_CRONTAB"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/sandbox-x"
  local first; first=$(cat "$ATMUX_TEST_CRONTAB")
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/sandbox-x"
  local second; second=$(cat "$ATMUX_TEST_CRONTAB")
  [ "$first" = "$second" ]
  # And exactly ONE marker block — not duplicated on re-run.
  [ "$(grep -c '^# >>> atmux:team=team-x' "$ATMUX_TEST_CRONTAB")" = "1" ]
}

@test "cron_install: replaces existing block when atmux_dir changes (no stale entries)" {
  _load_cron
  rm -f "$ATMUX_TEST_CRONTAB"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/path-a"
  grep -q "ATMUX_DIR=$ATMUX_TEST_TMP/path-a" "$ATMUX_TEST_CRONTAB"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/path-b"
  # Old path is gone, new path is in.
  ! grep -q "ATMUX_DIR=$ATMUX_TEST_TMP/path-a" "$ATMUX_TEST_CRONTAB"
  grep -q "ATMUX_DIR=$ATMUX_TEST_TMP/path-b" "$ATMUX_TEST_CRONTAB"
  # Still exactly one block.
  [ "$(grep -c '^# >>> atmux:team=team-x' "$ATMUX_TEST_CRONTAB")" = "1" ]
}

@test "cron_remove: drops marker block + cron lines (back to clean crontab)" {
  _load_cron
  rm -f "$ATMUX_TEST_CRONTAB"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/sandbox-x"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_remove team-x
  # Either file gone or contains no atmux markers / lines.
  if [[ -f "$ATMUX_TEST_CRONTAB" ]]; then
    ! grep -q '^# >>> atmux:team=' "$ATMUX_TEST_CRONTAB"
    ! grep -q 'ATMUX_DIR=' "$ATMUX_TEST_CRONTAB"
  fi
}

@test "cron_remove: idempotent on missing marker (no-op, exit 0, crontab unchanged)" {
  _load_cron
  # Pre-seed a non-atmux line so we can assert "unchanged" meaningfully.
  printf '# user-managed\n0 3 * * * /usr/local/bin/backup\n' > "$ATMUX_TEST_CRONTAB"
  local before; before=$(cat "$ATMUX_TEST_CRONTAB")
  run _with_mock_crontab atmux::cron_remove team-never-installed
  [ "$status" -eq 0 ]
  local after; after=$(cat "$ATMUX_TEST_CRONTAB")
  [ "$before" = "$after" ]
}

@test "cron_install: multiple teams coexist — install x + y; remove x leaves y intact" {
  _load_cron
  rm -f "$ATMUX_TEST_CRONTAB"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$ATMUX_TEST_TMP/path-x"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-y "$ATMUX_TEST_TMP/path-y"
  # Both blocks present.
  grep -q '^# >>> atmux:team=team-x' "$ATMUX_TEST_CRONTAB"
  grep -q '^# >>> atmux:team=team-y' "$ATMUX_TEST_CRONTAB"

  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_remove team-x
  # team-x gone, team-y intact.
  ! grep -q '^# >>> atmux:team=team-x' "$ATMUX_TEST_CRONTAB"
  grep -q '^# >>> atmux:team=team-y' "$ATMUX_TEST_CRONTAB"
  grep -q "ATMUX_DIR=$ATMUX_TEST_TMP/path-y" "$ATMUX_TEST_CRONTAB"
}

# ---------- cases 7-8: wire-up via atmux start / atmux stop ----------

# Minimal team for live start/stop: one shell-tui member so spawn is
# instant + no AI binaries are required. --no-doctor short-circuits the
# preflight (which would surface unrelated yellows in the sandbox).
_seed_min_team() {
  cat > .atmux/team.json <<EOF
{
  "name": "g",
  "members": [
    {"name": "lead", "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
EOF
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
}

@test "atmux start: installs cron block; atmux stop: removes it" {
  _seed_min_team
  rm -f "$ATMUX_TEST_CRONTAB"

  # Live start with sandbox crontab on PATH.
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true

  # Marker block landed.
  [ -f "$ATMUX_TEST_CRONTAB" ]
  grep -q '^# >>> atmux:team=g' "$ATMUX_TEST_CRONTAB"
  grep -q 'ATMUX_DIR=.* whip ' "$ATMUX_TEST_CRONTAB"

  # Live stop strips the block.
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
  if [[ -f "$ATMUX_TEST_CRONTAB" ]]; then
    ! grep -q '^# >>> atmux:team=g' "$ATMUX_TEST_CRONTAB"
  fi
}

@test "atmux start: kanban.cronAutoInstall=false skips install (opt-out honoured)" {
  _seed_min_team
  # Flip the opt-out before starting.
  jq '.kanban = {cronAutoInstall: false}' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  rm -f "$ATMUX_TEST_CRONTAB"

  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true

  # Sandbox crontab either absent OR present-but-no-marker — opt-out means
  # cron_install was never reached.
  if [[ -f "$ATMUX_TEST_CRONTAB" ]]; then
    ! grep -q '^# >>> atmux:team=g' "$ATMUX_TEST_CRONTAB"
  fi

  # Cleanup any spawned tmux state.
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
}
