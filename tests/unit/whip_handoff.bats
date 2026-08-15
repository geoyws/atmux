#!/usr/bin/env bats
# Unit tests for whip's autoRotate-gated banner handoff (E2/S3 t-50ca6f09).
# Covers TEST task t-aada3e45.
#
# When AUTO_ROTATE=true and a per-member pane shows a rotation-trigger
# banner (rate-limited / approaching-limit / compacting), whip execs
# `atmux rotate <member>` immediately. Debounce: skip if rotated <5min ago.
#
# Bringing up a sandbox tmux session via `atmux start --no-doctor` with
# shell-tui members so capture-pane sees real text. Banner injection is
# done by `tmux send-keys` of a literal echoed string into the member's
# shell pane — capture-pane then sees it in the scrollback.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "wp",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "autoRotate": true}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  export ATMUX_SESSION="atmux-test-wp-$$-$RANDOM"

  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__wp__worker" && break
    sleep 0.2
  done
}

teardown() {
  atmux_teardown_sandbox
}

# Inject a literal banner string into worker's pane scrollback.
_inject_banner() {
  local text="$1"
  local target="$ATMUX_SESSION:__wp__worker"
  # Use echo so the string appears in the scrollback (capture-pane picks it up).
  tmux send-keys -t "$target" "echo '$text'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo '$text'" Enter
  sleep 1
}

_set_auto_rotate() {
  local val="$1"
  jq --argjson v "$val" '.whip.autoRotate = $v' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
}

# ---------- core branches ----------

@test "handoff: Compacting banner + autoRotate=true ⇒ AUTO-HANDOFF worker + epoch refreshed" {
  _inject_banner "Compacting conversation"
  local before; before=$(date +%s)

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-HANDOFF worker" ]]
  [[ "$output" =~ "compacting" ]]
  # rotate verb must have written a fresh epoch.
  [ -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(cat .atmux/state/worker-rotated.epoch)
  [ "$epoch" -ge "$before" ]
}

@test "handoff: rate-limit banner + autoRotate=true ⇒ AUTO-HANDOFF + banner=rate-limited" {
  _inject_banner "You hit your limit"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-HANDOFF worker" ]]
  [[ "$output" =~ "rate-limited" ]]
}

@test "handoff: approaching-limit banner + autoRotate=true ⇒ AUTO-HANDOFF + banner=approaching-limit" {
  _inject_banner "approaching usage limit"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-HANDOFF worker" ]]
  [[ "$output" =~ "approaching-limit" ]]
}

@test "handoff: autoRotate=false ⇒ banner finding present but no AUTO-HANDOFF + no epoch" {
  _set_auto_rotate false
  _inject_banner "Compacting conversation"

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  # The compacting info finding still surfaces.
  [[ "$output" =~ "compacting" ]]
  # But the rotate execution must NOT fire.
  ! [[ "$output" =~ "AUTO-HANDOFF" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

@test "handoff: no banner + autoRotate=true ⇒ no handoff (silent on healthy panes)" {
  # Don't inject anything. Pane is a fresh shell.
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "AUTO-HANDOFF" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

# ---------- debounce ----------

@test "handoff: rotated <5min ago + banner ⇒ debounce, no re-fire" {
  # Pre-stamp epoch as 60s ago — well under the 300s debounce.
  local now; now=$(date +%s)
  echo $(( now - 60 )) > .atmux/state/worker-rotated.epoch
  _inject_banner "Compacting conversation"

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "AUTO-HANDOFF" ]]
  # Epoch unchanged (debounce held).
  local cur; cur=$(cat .atmux/state/worker-rotated.epoch)
  [ "$cur" = "$(( now - 60 ))" ]
}

@test "handoff: rotated >5min ago + banner ⇒ re-fires (debounce expired)" {
  local now; now=$(date +%s)
  # Stamp 6 minutes ago — past the 300s window.
  echo $(( now - 360 )) > .atmux/state/worker-rotated.epoch
  _inject_banner "Compacting conversation"

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-HANDOFF worker" ]]
  # Epoch refreshed.
  local cur; cur=$(cat .atmux/state/worker-rotated.epoch)
  [ "$cur" -ge "$now" ]
}

# ---------- queued-message banner is NOT a rotation trigger ----------

@test "handoff: queued-messages banner ⇒ info-only finding, no rotation" {
  _inject_banner "Press up to edit queued messages"
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "queued" ]]
  ! [[ "$output" =~ "AUTO-HANDOFF" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}
