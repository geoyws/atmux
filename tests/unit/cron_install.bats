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

# Tests in this file exercise the install path, which the ATMUX_NO_CRON
# gate (t-7223951b — lib/cron.sh:78-89) short-circuits to a no-op. The
# atmux_setup_sandbox helper exports ATMUX_NO_CRON=1 by default to keep
# OTHER suites' tests from leaking cron lines into the host's crontab —
# which means an install-path test must explicitly unset it to actually
# exercise the install. Tests that target the gate itself (cases 9-10)
# manage the env directly and do NOT call this helper.
_force_install_path() {
  unset ATMUX_NO_CRON
}

# ---------- cases 1-6: install/remove primitives ----------

@test "cron_install: empty crontab ⇒ marker block + 3 cron lines land" {
  _load_cron
  _force_install_path
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
  _force_install_path
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
  _force_install_path
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
  _force_install_path
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
  _force_install_path
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
  _force_install_path
  rm -f "$ATMUX_TEST_CRONTAB"

  # Live start with sandbox crontab on PATH. Inherit the unset gate into
  # the child via env -u so the subprocess actually exercises the install.
  env -u ATMUX_NO_CRON PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true

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

# ---------- cases 9-10: ATMUX_NO_CRON env gate + teardown sweep (E8/Sb) ----------
#
# The ATMUX_NO_CRON env gate (t-7223951b — lib/cron.sh:78-89) lets test
# sandboxes opt out of cron writes at the source: atmux::cron_install
# returns 0 immediately when the var is non-empty/non-0/non-false, with
# no crontab swap. atmux_setup_sandbox exports ATMUX_NO_CRON=1 by default
# so every sandboxed test gets this protection without remembering it.
#
# The teardown sweep (_atmux_teardown_cron_sweep — tests/helpers/setup.bash)
# is the belt-and-suspenders catch: any test that overrides the gate, or
# any code path that misses it, would leak cron lines past the rm-rf of
# the sandbox dir. The sweep walks every team.json under ATMUX_TEST_TMP
# and calls atmux::cron_remove so orphan blocks never escape into the
# host's crontab.

@test "cron_install: ATMUX_NO_CRON=1 ⇒ no crontab swap (env gate honoured)" {
  atmux_assert_sandbox
  _load_cron

  # Pre-seed a baseline so we can prove "unchanged" by content equality
  # rather than mere absence of our markers.
  printf '# user-line\n0 0 * * * /bin/echo hello\n' > "$ATMUX_TEST_CRONTAB"
  local before; before=$(cat "$ATMUX_TEST_CRONTAB")

  # ATMUX_NO_CRON=1 is exported by atmux_setup_sandbox. Reassert here so
  # the test reads as self-contained — future setup-helper edits won't
  # silently invalidate the gate-under-test.
  export ATMUX_NO_CRON=1

  # Call install. The early-return at lib/cron.sh:78-89 should fire
  # before any crontab read/write. Suppress stderr so the optional
  # ATMUX_DEBUG message (gated separately, default off) doesn't leak.
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install foo "$ATMUX_TEST_TMP/sandbox-foo" 2>/dev/null

  # Crontab must be byte-identical to the baseline — no swap, no marker
  # block appended, no stripping of the user line.
  local after; after=$(cat "$ATMUX_TEST_CRONTAB")
  [ "$before" = "$after" ]
  ! grep -q '^# >>> atmux:team=foo' "$ATMUX_TEST_CRONTAB"
}

@test "teardown sweep: cron block leaked past env gate is removed by atmux_teardown_sandbox" {
  atmux_assert_sandbox
  _load_cron

  # Force the install path: the setup helper exports ATMUX_NO_CRON=1, so
  # we unset it here to simulate either a rogue test override or a pre-gate
  # binary path that bypasses the env check. The sweep is the safety net
  # exactly for this scenario.
  unset ATMUX_NO_CRON
  rm -f "$ATMUX_TEST_CRONTAB"

  # Install for team "g" (matches the .atmux/team.json from setup's
  # `atmux init --name g` invocation). The teardown sweep finds team.json
  # by walking $ATMUX_TEST_TMP and calls cron_remove with the .name field.
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install g "$ATMUX_TEST_TMP/sandbox-g"
  grep -q '^# >>> atmux:team=g' "$ATMUX_TEST_CRONTAB"

  # Invoke the sweep with the mock on PATH so the inner cron_remove call
  # writes to the sandbox crontab file rather than the host's crond.
  PATH="$ATMUX_MOCK_BIN:$PATH" _atmux_teardown_cron_sweep

  # Block must be gone — sweep has reached every team.json under the
  # sandbox + called cron_remove for each .name. Either the file is
  # absent (cron_remove stripped the only block) or it contains no
  # marker for team "g".
  if [[ -f "$ATMUX_TEST_CRONTAB" ]]; then
    ! grep -q '^# >>> atmux:team=g' "$ATMUX_TEST_CRONTAB"
    ! grep -q "ATMUX_DIR=$ATMUX_TEST_TMP/sandbox-g" "$ATMUX_TEST_CRONTAB"
  fi
}

# ---------- E9/Sc t-be778e9e: per-team unblocker cron line ----------
#
# Render-time check on team.json:.members[] | select(.role=="unblocker").
# Helpers below seed a real $ATMUX_DIR/team.json (the install helper ignores
# the absent-team-json case in earlier tests because the path is synthetic);
# the new line emits ONLY when an unblocker member is declared.

# Seed a team.json at $1 with the listed roles ($2..). Used by the
# unblocker-cron tests below to drive the role-list gate inside
# _atmux_cron_render_lines without spinning up the wizard.
_seed_team_json_with_roles() {
  local atmux_dir="$1"; shift
  mkdir -p "$atmux_dir"
  local members='[]' role
  for role in "$@"; do
    members=$(jq -c --arg r "$role" --arg n "m-$role" \
      '. + [{name:$n, role:$r, lane:"misc", tui:"shell"}]' <<<"$members")
  done
  jq -n --arg name "team-x" --argjson members "$members" \
    '{name:$name, members:$members}' > "$atmux_dir/team.json"
}

@test "cron_install: team WITHOUT unblocker member ⇒ no unblocker cron line" {
  _load_cron
  _force_install_path
  rm -f "$ATMUX_TEST_CRONTAB"

  local d="$ATMUX_TEST_TMP/sandbox-no-unblocker"
  _seed_team_json_with_roles "$d" team-lead reviewer gitter
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"

  ! grep -q 'unblocker tick' "$ATMUX_TEST_CRONTAB"
  # Existing 4 lines still present.
  grep -q 'whip ' "$ATMUX_TEST_CRONTAB"
  grep -q 'report ' "$ATMUX_TEST_CRONTAB"
  grep -q 'decisions digest ' "$ATMUX_TEST_CRONTAB"
  grep -q 'groom --quiet' "$ATMUX_TEST_CRONTAB"
}

@test "cron_install: team WITH unblocker member ⇒ 2-min unblocker tick line emitted" {
  _load_cron
  _force_install_path
  rm -f "$ATMUX_TEST_CRONTAB"

  local d="$ATMUX_TEST_TMP/sandbox-unblocker"
  _seed_team_json_with_roles "$d" team-lead reviewer gitter unblocker
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"

  # Single emission of the unblocker line — 2-min schedule + tick subverb +
  # log redirect into <atmux_dir>/logs/unblocker.log per ADR-021.
  [ "$(grep -c 'unblocker tick' "$ATMUX_TEST_CRONTAB")" = "1" ]
  grep -qE '^\*/2 \* \* \* \* .*ATMUX_DIR='"$d"' .*unblocker tick' "$ATMUX_TEST_CRONTAB"
  grep -qE 'unblocker tick >> '"$d"'/logs/unblocker.log 2>&1' "$ATMUX_TEST_CRONTAB"
}

@test "cron_install: team WITH unblocker — re-run yields byte-identical crontab (idempotent)" {
  _load_cron
  _force_install_path
  rm -f "$ATMUX_TEST_CRONTAB"

  local d="$ATMUX_TEST_TMP/sandbox-idem"
  _seed_team_json_with_roles "$d" team-lead unblocker
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"
  local first; first=$(cat "$ATMUX_TEST_CRONTAB")
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"
  local second; second=$(cat "$ATMUX_TEST_CRONTAB")
  [ "$first" = "$second" ]
  [ "$(grep -c 'unblocker tick' "$ATMUX_TEST_CRONTAB")" = "1" ]
}

@test "cron_install: team WITH unblocker + tmuxTmpdir ⇒ unblocker line carries TMUX_TMPDIR prefix" {
  _load_cron
  _force_install_path
  rm -f "$ATMUX_TEST_CRONTAB"

  local d="$ATMUX_TEST_TMP/sandbox-tmpdir"
  _seed_team_json_with_roles "$d" team-lead unblocker
  # Add the tmuxTmpdir field so the same conditional that prefixes whip /
  # report / digest / groom also prefixes the unblocker line (E8/Sc shape).
  jq '.tmuxTmpdir = "/tmp/atmux_tmux_team_x"' "$d/team.json" > "$d/team.json.tmp"
  mv "$d/team.json.tmp" "$d/team.json"

  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"

  grep -qE '^\*/2 \* \* \* \* TMUX_TMPDIR=/tmp/atmux_tmux_team_x ATMUX_DIR='"$d"' .* unblocker tick' \
    "$ATMUX_TEST_CRONTAB"
}

@test "cron_install: removing unblocker member from team.json drops the line on next install" {
  _load_cron
  _force_install_path
  rm -f "$ATMUX_TEST_CRONTAB"

  local d="$ATMUX_TEST_TMP/sandbox-toggle"
  _seed_team_json_with_roles "$d" team-lead unblocker
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"
  grep -q 'unblocker tick' "$ATMUX_TEST_CRONTAB"

  # Remove the unblocker member, re-install — line must disappear.
  jq '.members |= map(select(.role != "unblocker"))' "$d/team.json" > "$d/team.json.tmp"
  mv "$d/team.json.tmp" "$d/team.json"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::cron_install team-x "$d"

  ! grep -q 'unblocker tick' "$ATMUX_TEST_CRONTAB"
}
