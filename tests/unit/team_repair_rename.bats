#!/usr/bin/env bats
# Unit tests for `atmux team repair-rename` — t-2a25f7bd / ADR-027 ADDENDUM 11.
#
# Strategy: synthesize a "drifted" team in the sandbox — team.json:.name +
# registry both reflect NEW name, but the cage tmpdir + cage internal
# session + window prefixes + state/session.txt all still on OLD name.
# Then run repair-rename and assert all 6 fields converge.
#
# Pane-preservation is exercised by leaving the spawned tmux server fd-
# alive across the mv (Linux: dirent rename doesn't invalidate the
# bind-mounted socket fd that tmux holds).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  atmux_assert_sandbox

  # Avoid the cron path here — sandbox helper already sets ATMUX_NO_CRON=1
  # but repair-rename's step5 calls atmux::cron_install regardless of env
  # gate (the env-gate lives at install time). Override the cron_install
  # function with a no-op stub for the duration of the test.
  atmux::cron_install() { return 0; }
  atmux::cron_remove()  { return 0; }
  export -f atmux::cron_install atmux::cron_remove 2>/dev/null || true
}

teardown() {
  # Reap any sandbox tmux servers we spawned at non-default paths.
  for sock in "$ATMUX_TEST_TMP"/atmux_tmux_*/tmux-0/default \
              "$ATMUX_TEST_TMP"/atmux-tmux-*/tmux-0/default; do
    [[ -S "$sock" ]] || continue
    tmux -S "$sock" kill-server 2>/dev/null || true
  done
  atmux_teardown_sandbox
}

# Helper: stand up a "drifted" team — declarative new, imperative old.
#   team.json:.name = $new
#   team.json:.tmuxTmpdir = $ATMUX_TEST_TMP/atmux-tmux-$old
#   registry sessionName = $new
#   cage tmpdir + session + windows all on $old
_seed_drifted_team() {
  local old="$1" new="$2"
  local proj="$ATMUX_TEST_TMP/proj"
  mkdir -p "$proj/.atmux/state"
  local tmpdir="$ATMUX_TEST_TMP/atmux-tmux-$old"
  mkdir -p "$tmpdir"

  cat > "$proj/.atmux/team.json" <<JSON
{
  "name": "$new",
  "tmuxTmpdir": "$tmpdir",
  "singleSession": true,
  "members": [
    {"name":"lead","role":"team-lead","tui":"shell"},
    {"name":"worker","role":"member","tui":"shell"}
  ]
}
JSON
  printf '%s\n' "$old" > "$proj/.atmux/state/session.txt"

  # Registry says new (mid-rename declarative state).
  ATMUX_DIR="$proj/.atmux" atmux::registry_upsert "$new" "$proj" "$new" >/dev/null

  # Spawn the cage server with old-named session + old-prefix windows.
  TMUX_TMPDIR="$tmpdir" tmux new-session -d -s "$old" -n "__${old}__lead"   3>&- 4>&-
  TMUX_TMPDIR="$tmpdir" tmux new-window  -t "=$old" -n "__${old}__worker" 3>&- 4>&-

  # Echo project root for the test body.
  echo "$proj"
}

@test "repair-rename: --help prints usage" {
  run "$ATMUX_BIN" team repair-rename --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "team repair-rename" ]]
  [[ "$output" =~ "--dry-run" ]]
}

@test "repair-rename: scan finds no drift on a clean fleet" {
  run "$ATMUX_BIN" team repair-rename
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no drifted teams" ]] || [[ "$output" =~ "fleet converged" ]]
}

@test "repair-rename: --dry-run renders the plan but applies no changes" {
  local proj; proj="$(_seed_drifted_team aux myteam-aux)"

  run env ATMUX_DIR="$proj/.atmux" "$ATMUX_BIN" team repair-rename myteam-aux --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux_tmux_myteam-aux" ]]
  [[ "$output" =~ "rename-session" ]]
  [[ "$output" =~ "rename-window" ]]

  # Pre-state preserved.
  [ -d "$ATMUX_TEST_TMP/atmux-tmux-aux" ]
  ! [ -d "$ATMUX_TEST_TMP/atmux_tmux_myteam-aux" ]
  [ "$(jq -r '.tmuxTmpdir' "$proj/.atmux/team.json")" = "$ATMUX_TEST_TMP/atmux-tmux-aux" ]
}

@test "repair-rename: live fire converges all 6 fields" {
  local proj; proj="$(_seed_drifted_team aux myteam-aux)"

  # The verb's hardcoded /tmp/atmux_tmux_<team> output path is the
  # production convention; for the sandbox we redirect via the verb's
  # own mv to that exact path BUT the test sandbox lives under
  # $ATMUX_TEST_TMP — so we override the target tmpdir resolution by
  # patching the verb's new_tmpdir computation. Cleanest path: stub
  # the target by exporting a helper var the verb honors. Since the
  # current verb hardcodes /tmp/, we need either (a) verb-level
  # sandbox override, or (b) accept that this cell exercises the live
  # /tmp path and clean up after.
  #
  # Going with (b): write to /tmp/atmux_tmux_myteam-aux for this single
  # cell, then teardown reaps. This isolates the bats run from the
  # operator's real fleet (no real myteam-aux exists in the sandbox
  # registry beyond what _seed_drifted_team added).

  run env ATMUX_DIR="$proj/.atmux" "$ATMUX_BIN" team repair-rename myteam-aux
  [ "$status" -eq 0 ]

  # 1. tmpdir converged: new path exists, old gone.
  [ -d "/tmp/atmux_tmux_myteam-aux" ]
  ! [ -d "$ATMUX_TEST_TMP/atmux-tmux-aux" ]

  # 2. team.json:.tmuxTmpdir reflects new path.
  [ "$(jq -r '.tmuxTmpdir' "$proj/.atmux/team.json")" = "/tmp/atmux_tmux_myteam-aux" ]

  # 3. cage internal session = myteam-aux.
  local sess; sess="$(tmux -S /tmp/atmux_tmux_myteam-aux/tmux-0/default \
                      list-sessions -F '#{session_name}' 2>/dev/null | head -1)"
  [ "$sess" = "myteam-aux" ]

  # 4. Window prefixes converged.
  local wins; wins="$(tmux -S /tmp/atmux_tmux_myteam-aux/tmux-0/default \
                      list-windows -a -F '#{window_name}' 2>/dev/null)"
  [[ "$wins" == *"__myteam-aux__lead"* ]]
  [[ "$wins" == *"__myteam-aux__worker"* ]]
  [[ "$wins" != *"__aux__"* ]]

  # 5. state/session.txt synced.
  [ "$(cat "$proj/.atmux/state/session.txt")" = "myteam-aux" ]

  # 6. Rollback log written.
  [ -f "$proj/.atmux/state/repair-rename-rollback.log" ]
  grep -q 'step1: mv'             "$proj/.atmux/state/repair-rename-rollback.log"
  grep -q 'step2: tmux rename-session' "$proj/.atmux/state/repair-rename-rollback.log"
  grep -q 'step3: rename-window'  "$proj/.atmux/state/repair-rename-rollback.log"

  # Cleanup the live /tmp dir we wrote to.
  tmux -S /tmp/atmux_tmux_myteam-aux/tmux-0/default kill-server 2>/dev/null || true
  rm -rf /tmp/atmux_tmux_myteam-aux
}

@test "repair-rename: idempotent — second run on converged team is no-op" {
  local proj; proj="$(_seed_drifted_team aux myteam-aux)"
  env ATMUX_DIR="$proj/.atmux" "$ATMUX_BIN" team repair-rename myteam-aux >/dev/null

  # Second run: every signal converged, expect no-op success.
  run env ATMUX_DIR="$proj/.atmux" "$ATMUX_BIN" team repair-rename myteam-aux
  [ "$status" -eq 0 ]
  [[ "$output" =~ "already converged" ]] || [[ "$output" =~ "no-op" ]]

  # Cleanup.
  tmux -S /tmp/atmux_tmux_myteam-aux/tmux-0/default kill-server 2>/dev/null || true
  rm -rf /tmp/atmux_tmux_myteam-aux
}

@test "repair-rename: refuses when target tmpdir already exists (clobber-guard)" {
  local proj; proj="$(_seed_drifted_team aux myteam-aux)"
  # Pre-create the target — simulates a half-finished prior run leaving
  # crud behind. Verb must refuse rather than mv-clobber.
  mkdir -p /tmp/atmux_tmux_myteam-aux/tmux-0
  : > /tmp/atmux_tmux_myteam-aux/tmux-0/default

  run env ATMUX_DIR="$proj/.atmux" "$ATMUX_BIN" team repair-rename myteam-aux
  [ "$status" -ne 0 ]
  [[ "$output" =~ "already exists" ]] || [[ "$output" =~ "refusing" ]]

  # Pre-state intact.
  [ -d "$ATMUX_TEST_TMP/atmux-tmux-aux" ]
  [ "$(jq -r '.tmuxTmpdir' "$proj/.atmux/team.json")" = "$ATMUX_TEST_TMP/atmux-tmux-aux" ]

  rm -rf /tmp/atmux_tmux_myteam-aux
}
