#!/usr/bin/env bats
# Unit tests for whip's per-member rotated.epoch read + autoRotate gate.
# Covers TEST task t-baad2f91 (deps t-13f8778d).
#
# Complements tests/unit/whip.bats which already covers
# `_atmux_whip_anchor_for` + `_atmux_whip_stale_anchor`. Focus here:
#   - low-level `_atmux_whip_member_rotated_epoch` helper
#   - `team.whip.autoRotate` gate behaviour (ADR-009 D2)
#
# autoRotate-gated branches require a live tmux session because the lead-
# uptime check sits past the session-DOWN early-exit. We bring up a sandbox
# session via `atmux start --no-doctor` with shell-tui members so paste/
# rotate side-effects are deterministic and inert (shell prompt absorbs).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "wr",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  export ATMUX_SESSION="atmux-test-wr-$$-$RANDOM"
}

teardown() {
  atmux_teardown_sandbox
}

# Bring up the sandbox tmux session so whip's per-member loop has windows.
_start_session() {
  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__wr__lead" && return 0
    sleep 0.2
  done
}

# Toggle .atmux/team.json's whip.autoRotate to the given value.
_set_auto_rotate() {
  local val="$1"
  jq --argjson v "$val" '.whip.autoRotate = $v' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
}

# ---------- _atmux_whip_member_rotated_epoch (T2.1) ----------

@test "whip_rotate: member_rotated_epoch returns digits when file has valid epoch" {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"

  echo 1234567890 > .atmux/state/worker-rotated.epoch
  run _atmux_whip_member_rotated_epoch worker
  [ "$status" -eq 0 ]
  [ "$output" = "1234567890" ]
}

@test "whip_rotate: member_rotated_epoch returns 0 when file is absent" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"

  [ ! -f .atmux/state/ghost-rotated.epoch ]
  run _atmux_whip_member_rotated_epoch ghost
  [ "$status" -eq 0 ]
  [ "$output" = "0" ]
}

@test "whip_rotate: member_rotated_epoch returns 0 on non-numeric content" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"

  echo "junk-not-an-epoch" > .atmux/state/worker-rotated.epoch
  run _atmux_whip_member_rotated_epoch worker
  [ "$status" -eq 0 ]
  [ "$output" = "0" ]
}

@test "whip_rotate: member_rotated_epoch returns 0 on empty file" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"

  : > .atmux/state/worker-rotated.epoch
  run _atmux_whip_member_rotated_epoch worker
  [ "$status" -eq 0 ]
  [ "$output" = "0" ]
}

@test "whip_rotate: member_rotated_epoch namespaced per member (no collision)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"

  echo 1000 > .atmux/state/alice-rotated.epoch
  echo 2000 > .atmux/state/bob-rotated.epoch
  run _atmux_whip_member_rotated_epoch alice
  [ "$output" = "1000" ]
  run _atmux_whip_member_rotated_epoch bob
  [ "$output" = "2000" ]
}

@test "whip_rotate: member_rotated_epoch handles trailing newline" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/whip.sh"

  printf '4242\n' > .atmux/state/worker-rotated.epoch
  run _atmux_whip_member_rotated_epoch worker
  [ "$status" -eq 0 ]
  [ "$output" = "4242" ]
}

# ---------- autoRotate gate (T2.2 t-13f8778d) ----------

@test "whip_rotate: autoRotate=false (default) ⇒ recommend-only finding (no rotation)" {
  _set_auto_rotate false
  _start_session
  local now; now=$(date +%s)
  # Stale enough to trigger the threshold check.
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7100 )) > .atmux/state/lead-rotated.epoch

  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  # Recommend-string present, AUTO-ROTATED string absent.
  [[ "$output" =~ "consider" ]] && [[ "$output" =~ "rotate-lead" ]]
  ! [[ "$output" =~ "AUTO-ROTATED" ]]
  # Epoch file unchanged (no rotation occurred).
  local cur; cur=$(cat .atmux/state/lead-rotated.epoch)
  [ "$cur" = "$(( now - 7100 ))" ]
}

@test "whip_rotate: autoRotate missing from team.json ⇒ defaults to false (warn-only)" {
  # Strip the autoRotate key entirely.
  jq 'del(.whip.autoRotate)' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  _start_session
  local now; now=$(date +%s)
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7100 )) > .atmux/state/lead-rotated.epoch

  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "AUTO-ROTATED" ]]
}

@test "whip_rotate: autoRotate=true + uptime over threshold ⇒ executes rotate-lead + emits AUTO-ROTATED finding" {
  _set_auto_rotate true
  _start_session
  local now; now=$(date +%s)
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7100 )) > .atmux/state/lead-rotated.epoch

  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-ROTATED lead" ]]
  # Recommend-only string must NOT also fire (gate is exclusive).
  ! [[ "$output" =~ "consider \`atmux rotate-lead\`" ]]

  # The rotate verb must have refreshed lead-rotated.epoch to ~now.
  local fresh; fresh=$(cat .atmux/state/lead-rotated.epoch)
  [ "$fresh" -ge "$now" ]
}

@test "whip_rotate: autoRotate=true ⇒ second tick within debounce is a no-op (fresh epoch self-debounces)" {
  _set_auto_rotate true
  _start_session
  local now; now=$(date +%s)
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7100 )) > .atmux/state/lead-rotated.epoch

  # First tick: fires the auto-rotation.
  ATMUX_LEAD_MAX_MIN=60 "$ATMUX_BIN" whip >/dev/null 2>&1

  # Second tick: epoch is now fresh ⇒ uptime <60min ⇒ no finding.
  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "AUTO-ROTATED" ]]
  ! [[ "$output" =~ "consider \`atmux rotate-lead\`" ]]
}

@test "whip_rotate: autoRotate=true + uptime BELOW threshold ⇒ no rotation (gate respects threshold)" {
  _set_auto_rotate true
  _start_session
  local now; now=$(date +%s)
  # Fresh: 30s ago — well under 60min.
  echo $(( now - 30 )) > .atmux/state/session-start.txt
  echo $(( now - 30 )) > .atmux/state/lead-rotated.epoch

  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "AUTO-ROTATED" ]]
}
