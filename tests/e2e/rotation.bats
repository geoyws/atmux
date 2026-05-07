#!/usr/bin/env bats
# E2E: rotation infrastructure round-trip — manual rotate-lead + autoRotate
# gate + banner-preclear all firing against a live tmux session.
# Coverage for TEST task t-011f3b03 (E2/S5).
#
# No AI API calls — every member is tui=shell so paste/send-keys side-
# effects are deterministic and inert.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "rote2e",
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
  : > .atmux/driver-inbox.md
  export ATMUX_SESSION="atmux-test-rote2e-$$-$RANDOM"
}

teardown() {
  "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
  atmux_teardown_sandbox
}

# ---------- step 1+2: bootstrap + rotate-lead writes epoch ----------

@test "e2e rotation: rotate-lead writes lead-rotated.epoch + uptime resets on next whip" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # Force the lead's anchor to look stale so rotate-lead has work to undo.
  local now; now=$(date +%s)
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7000 )) > .atmux/state/lead-rotated.epoch
  rm -f .atmux/state/whip-last.hash

  # Tick 1: pre-rotation, lead uptime is over threshold ⇒ recommend-only
  # finding fires (autoRotate stays false in this team.json).
  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "consider" ]] && [[ "$output" =~ "rotate-lead" ]]

  # Manual rotation refreshes the epoch.
  "$ATMUX_BIN" rotate-lead >/dev/null
  local fresh; fresh=$(< .atmux/state/lead-rotated.epoch)
  [ "$fresh" -ge "$now" ]

  # Tick 2: epoch fresh ⇒ uptime≈0 ⇒ no rotate-lead finding.
  rm -f .atmux/state/whip-last.hash
  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "consider \`atmux rotate-lead\`" ]]
}

# ---------- step 3: autoRotate=true exec path ----------

@test "e2e rotation: autoRotate=true + uptime over threshold ⇒ AUTO-ROTATED finding + epoch refreshed" {
  jq '.whip.autoRotate = true' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  "$ATMUX_BIN" start >/dev/null
  sleep 1

  local now; now=$(date +%s)
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7100 )) > .atmux/state/lead-rotated.epoch
  rm -f .atmux/state/whip-last.hash

  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-ROTATED lead" ]]
  ! [[ "$output" =~ "consider \`atmux rotate-lead\`" ]]
  # Epoch refreshed by the rotate-lead exec.
  local refreshed; refreshed=$(< .atmux/state/lead-rotated.epoch)
  [ "$refreshed" -ge "$now" ]
}

# ---------- step 4: banner-preclear ----------

@test "e2e rotation: Compacting banner + autoRotate=true ⇒ AUTO-PRECLEAR fires + worker epoch written" {
  jq '.whip.autoRotate = true' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # Inject a Compacting banner into worker's pane scrollback.
  local target="$ATMUX_SESSION:__rote2e__worker"
  tmux send-keys -t "$target" "echo 'Compacting conversation'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo 'Compacting conversation'" Enter
  sleep 1

  rm -f .atmux/state/worker-rotated.epoch .atmux/state/whip-last.hash
  local before; before=$(date +%s)
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-PRECLEAR worker" ]]
  [[ "$output" =~ "compacting" ]]
  [ -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(< .atmux/state/worker-rotated.epoch)
  [ "$epoch" -ge "$before" ]
}

# ---------- combined: rotation+preclear in one round-trip ----------

@test "e2e rotation: full round-trip — rotate-lead + autoRotate gate + banner preclear in one session" {
  jq '.whip.autoRotate = true' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # Phase A: manual rotate-lead.
  "$ATMUX_BIN" rotate-lead >/dev/null
  [ -f .atmux/state/lead-rotated.epoch ]

  # Phase B: stale lead under autoRotate=true ⇒ exec rotate-lead. Both
  # session-start.txt and lead-rotated.epoch must be older than the
  # threshold for the anchor (= max of the two) to register stale.
  local now; now=$(date +%s)
  echo $(( now - 7200 )) > .atmux/state/session-start.txt
  echo $(( now - 7100 )) > .atmux/state/lead-rotated.epoch
  rm -f .atmux/state/whip-last.hash
  ATMUX_LEAD_MAX_MIN=60 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-ROTATED lead" ]]

  # Phase C: inject banner on worker, run again ⇒ preclear fires.
  local target="$ATMUX_SESSION:__rote2e__worker"
  tmux send-keys -t "$target" "echo 'Compacting conversation'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo 'Compacting conversation'" Enter
  sleep 1
  rm -f .atmux/state/worker-rotated.epoch .atmux/state/whip-last.hash
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-PRECLEAR worker" ]]
}
