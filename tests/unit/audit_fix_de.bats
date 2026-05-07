#!/usr/bin/env bats
# Unit tests for class D + E fixers in lib/audit.sh — depth coverage on
# rename-residue stripping (emoji + multi-dash variants), no-op handling
# of already-clean windows, and the three-clause E-fix safety guards
# (path shape, live socket, registry cross-check) plus the rmdir-not-rm-rf
# fallback when a stray dir turns out to be non-empty (E14/Se, ADR-038).
#
# Existing tests/unit/audit.bats covers the bare-`lead` D-rename + the
# happy/dry-run/socket/path-shape rows for E. This file adds:
#   - D rename PRESERVES the inter-word emoji (🪄) on the way through
#   - D rename collapses a MULTI-DASH run (`lead--` → `lead`)
#   - D dispatch on an already-clean window is a true no-op (no
#     rename-window call hits the wire, audit-fix.log gains no D row)
#   - E fix-time registry cross-check refuses (audit.bats only tests
#     the detector's registry skip, not the fixer's defensive re-check)
#   - E rmdir on a non-empty stray dir fails-safe — the fixer logs a
#     fail and leaves the dir + every byte of its content untouched
#     (verifies no rm -rf escalation path)

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
  atmux_assert_sandbox
  # Sandbox the class-E scan root so the operator's real /tmp dirs
  # don't bleed into our findings.
  export ATMUX_AUDIT_TMP_ROOT="$ATMUX_TEST_TMP/audit_tmp"
  mkdir -p "$ATMUX_AUDIT_TMP_ROOT"
}

teardown() {
  # Reap any synthetic tmux sessions on the sandbox socket. Silent on
  # missing — the per-test helper only spawns when needed.
  for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^auFDe' || true); do
    tmux kill-session -t "=$s" 2>/dev/null || true
  done
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

# Mirror of audit.bats's tmux-session helper — keeps the two files'
# sandbox shapes aligned without cross-loading.
_seed_tmux_session() {
  local sess="$1"
  printf '%s\n' "$sess" > .atmux/state/session.txt
  jq --arg s "$sess" '.name = $s' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  tmux new-session -d -s "$sess" -n "scratch" 3>&- 4>&-
}

# ---- Class D fix: emoji preservation -----------------------------------

@test "D fix: emoji-bearing window — '__t__🪄lead-' → '__t__🪄lead' (single dash)" {
  _source_audit
  _seed_tmux_session "auFDe1"
  tmux new-window -d -t "=auFDe1" -n "__auFDe1__🪄lead-" 3>&- 4>&-

  _atmux_audit_class_d_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  # Sanity: detector named the canonical target with the emoji preserved.
  [[ "$(jq -r '.detail' <<<"${_atmux_audit_findings[0]}")" =~ \(canonical:\ \'__auFDe1__🪄lead\'\) ]]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local wins
  wins="$(tmux list-windows -t "=auFDe1" -F '#{window_name}' 2>/dev/null)"

  # Renamed target present without trailing dash — emoji intact.
  echo "$wins" | grep -qxF '__auFDe1__🪄lead'
  ! echo "$wins" | grep -qxF '__auFDe1__🪄lead-'

  # log_fix recorded the OK row.
  run cat .atmux/logs/audit-fix.log
  [ "$status" -eq 0 ]
  [[ "$output" =~ class=D ]]
  [[ "$output" =~ result=ok ]]
  [[ "$output" =~ "__auFDe1__🪄lead-" ]]
  [[ "$output" =~ "__auFDe1__🪄lead" ]]
}

# ---- Class D fix: multi-dash collapse ----------------------------------

@test "D fix: multi-dash run — '__t__🪄lead--' → '__t__🪄lead' (collapse all trailing dashes)" {
  _source_audit
  _seed_tmux_session "auFDe2"
  tmux new-window -d -t "=auFDe2" -n "__auFDe2__🪄lead--" 3>&- 4>&-

  _atmux_audit_class_d_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  # Detector's strip loop must have collapsed BOTH dashes — single canonical
  # target, no intermediate `lead-` form.
  [[ "$(jq -r '.detail' <<<"${_atmux_audit_findings[0]}")" =~ \(canonical:\ \'__auFDe2__🪄lead\'\) ]]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local wins
  wins="$(tmux list-windows -t "=auFDe2" -F '#{window_name}' 2>/dev/null)"

  echo "$wins" | grep -qxF '__auFDe2__🪄lead'
  ! echo "$wins" | grep -qxF '__auFDe2__🪄lead-'
  ! echo "$wins" | grep -qxF '__auFDe2__🪄lead--'
}

# ---- Class D fix: clean window is a true no-op -------------------------
#
# Clean window means the detector emits zero D findings → dispatcher
# iterates zero D-class entries → tmux rename-window is never invoked.
# Two assertions: the window name is byte-identical post-dispatch, and
# the audit-fix.log gains no class=D row from this run.

@test "D fix: clean '__t__🪄lead' window — detector emits 0 + dispatch is a strict no-op" {
  _source_audit
  _seed_tmux_session "auFDe3"
  tmux new-window -d -t "=auFDe3" -n "__auFDe3__🪄lead" 3>&- 4>&-

  _atmux_audit_class_d_detect
  [ "${#_atmux_audit_findings[@]}" -eq 0 ]

  # Dispatch with fix mode on. With no findings, dispatcher returns
  # without firing any per-class fixer.
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local wins
  wins="$(tmux list-windows -t "=auFDe3" -F '#{window_name}' 2>/dev/null)"
  echo "$wins" | grep -qxF '__auFDe3__🪄lead'

  # No D row added to the fix log this run.
  if [[ -f .atmux/logs/audit-fix.log ]]; then
    ! grep -q 'class=D' .atmux/logs/audit-fix.log
  fi
}

# ---- Class E fix: empty stray reaped (smoke for body row 4) ------------

@test "E fix: empty stray cage dir reaped via rmdir" {
  _source_audit
  local stray="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_stray_$$"
  mkdir -p "$stray/tmux-0"

  _atmux_audit_class_e_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  [ ! -e "$stray" ]
  [[ -f .atmux/logs/audit-fix.log ]]
  grep -q 'class=E' .atmux/logs/audit-fix.log
  grep -q 'result=ok' .atmux/logs/audit-fix.log
}

# ---- Class E fix: live socket refuses (defensive re-check at fix time) -

@test "E fix: live socket inside ⇒ REFUSED + dir + socket survive fix dispatch" {
  _source_audit
  local livedir="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_live_$$"
  mkdir -p "$livedir/tmux-0"

  # Stale finding pointing at $livedir — the detector would have skipped
  # this dir under normal flow, but a stale finding from an earlier
  # detect-then-fix race must still trip the fix-time guard.
  _atmux_audit_findings=("$(jq -nc \
    --arg path "$livedir" \
    '{class:"E", severity:"low", team:"t",
      detail:("stray cage tmpdir '"'"'" + $path + "'"'"' (stale)"),
      fix_hint:"rmdir", auto_fixable:true, blast_radius:"low"}')")

  python3 -c "
import socket
s = socket.socket(socket.AF_UNIX)
s.bind('$livedir/tmux-0/default')
" 2>/dev/null
  [ -S "$livedir/tmux-0/default" ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  [ -d "$livedir" ]
  [ -S "$livedir/tmux-0/default" ]
  grep -q 'class=E' .atmux/logs/audit-fix.log
  grep -q 'result=fail' .atmux/logs/audit-fix.log
  grep -q 'live socket' .atmux/logs/audit-fix.log

  rm -rf "$livedir"
}

# ---- Class E fix: registry cross-check at fix time ---------------------
#
# audit.bats covers the DETECTOR's registry-skip behavior. This cell
# nails down the FIXER's clause 3 — even if a stale finding arrives at
# the fixer (e.g. detect happened before the team registered, fix
# happens after), the fixer re-reads the registry and refuses. Without
# this guard, a race could rmdir a registered team's cage tmpdir.

@test "E fix: registered team's tmpdir ⇒ REFUSED (defensive registry re-check, no rmdir)" {
  _source_audit
  local regdir="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_reg_$$"
  mkdir -p "$regdir/tmux-0"

  # Stand up the registry entry — fake project root with team.json
  # carrying $regdir as tmuxTmpdir.
  local fake_proj="$ATMUX_TEST_TMP/fake_proj_$$"
  mkdir -p "$fake_proj/.atmux"
  cat > "$fake_proj/.atmux/team.json" <<JSON
{"name":"reg$$","tmuxTmpdir":"$regdir","members":[]}
JSON
  ATMUX_DIR="$fake_proj/.atmux" atmux::registry_upsert "reg$$" "$fake_proj" "reg$$" >/dev/null

  # Stale finding stuffed past the detector's registry filter.
  _atmux_audit_findings=("$(jq -nc \
    --arg path "$regdir" \
    '{class:"E", severity:"low", team:"t",
      detail:("stray cage tmpdir '"'"'" + $path + "'"'"' (stale)"),
      fix_hint:"rmdir", auto_fixable:true, blast_radius:"low"}')")

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  [ -d "$regdir" ]
  [ -d "$regdir/tmux-0" ]
  grep -q 'class=E' .atmux/logs/audit-fix.log
  grep -q 'result=fail' .atmux/logs/audit-fix.log
  grep -q 'registered' .atmux/logs/audit-fix.log
}

# ---- Class E fix: non-empty dir errors safely (no rm -rf escalation) ---
#
# A stray dir that holds a non-tmux-shape regular file (or a non-empty
# tmux-*/ subdir) MUST NOT be force-deleted. The fixer is rmdir-only;
# a non-empty target turns into a logged fail, leaving every byte of
# user data on disk. This is the load-bearing safety guard for the
# class — every other cell in this file would also break under rm -rf,
# but this cell is the explicit pin for "no escalation."

@test "E fix: non-empty stray dir ⇒ rmdir fail, content preserved (no rm -rf escalation)" {
  _source_audit
  local stray="$ATMUX_AUDIT_TMP_ROOT/atmux_tmux_nonempty_$$"
  mkdir -p "$stray"
  # Non-tmux-shape regular file — passes the path/socket/registry guards
  # (no socket, no registered tmpdir), but rmdir refuses non-empty.
  printf 'irreplaceable user data\n' > "$stray/important.txt"

  # Detect → flagged (no socket, no registry).
  _atmux_audit_class_e_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  # Dir + content untouched — the fixer never escalates to rm -rf.
  [ -d "$stray" ]
  [ -f "$stray/important.txt" ]
  run cat "$stray/important.txt"
  [ "$status" -eq 0 ]
  [ "$output" = "irreplaceable user data" ]

  # Log row recorded the failure with a hint about non-empty.
  grep -q 'class=E' .atmux/logs/audit-fix.log
  grep -q 'result=fail' .atmux/logs/audit-fix.log
  grep -q 'non-empty' .atmux/logs/audit-fix.log

  rm -rf "$stray"
}
