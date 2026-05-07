#!/usr/bin/env bats
# E2E: full reload round-trip — verify-libs + brief-reload + brief-version
# drift detection via whip + config-reload pane ping (no /clear).
# Coverage for TEST task t-1e9ef7df (E3/S4).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "rle2e",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  : > .atmux/driver-inbox.md
  export ATMUX_SESSION="atmux-test-rle2e-$$-$RANDOM"
}

teardown() {
  "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
  atmux_teardown_sandbox
}

# ---------- verify-libs healthy ----------

@test "e2e reload: verify-libs against the live tree exits 0 + summary line" {
  run "$ATMUX_BIN" verify-libs
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Summary" ]]
  # Every lib reports OK in a healthy build (no failures expected here).
  ! [[ "$output" =~ "❌" ]]
  ! [[ "$output" =~ "⚠️" ]]
}

# ---------- brief-reload paste + version stamp ----------

@test "e2e reload: brief-reload writes brief-versions.json + 📨 banner in pane scrollback" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # tui=shell members do not get the initial brief paste (start.sh skips
  # the paste path to avoid heredoc-from-backticks wedging the shell), so
  # brief-versions.json starts unpopulated for shell members. brief-reload
  # is the path that records them.
  run "$ATMUX_BIN" reload brief-reload worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "reloaded brief for worker" ]]
  sleep 1

  # File now exists with the worker's record.
  [ -f .atmux/state/brief-versions.json ]
  jq -e '.worker.role == "member"' .atmux/state/brief-versions.json >/dev/null
  jq -e '.worker.version | test("^v[0-9]+$")' .atmux/state/brief-versions.json >/dev/null

  # Pane scrollback shows the BRIEF RELOAD banner.
  local pane; pane=$(tmux capture-pane -p -S -200 -t "$ATMUX_SESSION:__rle2e__worker" 2>/dev/null \
    || tmux capture-pane -p -S -200 -t "$ATMUX_SESSION" 2>/dev/null)
  [[ "$pane" =~ "BRIEF RELOAD" ]]
}

# ---------- brief drift surfaces in whip ----------

@test "e2e reload: stale brief-versions.json ⇒ whip surfaces '📋 brief … available' finding" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # Hand-craft a stale record (shell members don't get auto-recorded).
  echo '{"worker":{"role":"member","version":"v0","pastedAt":1000}}' \
    > .atmux/state/brief-versions.json
  rm -f .atmux/state/whip-last.hash

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "brief member" ]]
  [[ "$output" =~ "available (was v0)" ]]
  [[ "$output" =~ "atmux reload brief-reload worker" ]]
}

# ---------- brief-reload re-stamps; subsequent whip clean ----------

@test "e2e reload: after brief-reload, next whip omits the drift finding (caught up)" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # Phase A: hand-craft stale state ⇒ drift fires.
  echo '{"worker":{"role":"member","version":"v0","pastedAt":1000}}' \
    > .atmux/state/brief-versions.json
  rm -f .atmux/state/whip-last.hash
  run "$ATMUX_BIN" whip
  [[ "$output" =~ "available (was v0)" ]]

  # Phase B: brief-reload re-stamps current version.
  "$ATMUX_BIN" reload brief-reload worker >/dev/null

  # Phase C: next whip — drift finding gone.
  rm -f .atmux/state/whip-last.hash
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "brief member.*available" ]]
}

# ---------- config-reload pings the drifted member's pane (no /clear) ----------

@test "e2e reload: config-reload ⇒ ⚙️ ping in pane scrollback + earlier brief banner preserved (no /clear)" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  # Drop a known marker into worker's pane via brief-reload — its scrollback
  # is what we'll verify is still present after config-reload.
  "$ATMUX_BIN" reload brief-reload worker >/dev/null
  sleep 1
  local pane_pre; pane_pre=$(tmux capture-pane -p -S -300 -t "$ATMUX_SESSION:__rle2e__worker" 2>/dev/null)
  [[ "$pane_pre" =~ "BRIEF RELOAD" ]]

  # Bump worker's lane in team.json post-spawn (drift relative to snapshot).
  jq '(.members[] | select(.name == "worker") | .lane) = "fe"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" reload config-reload
  [ "$status" -eq 0 ]
  [[ "$output" =~ "1 member" ]] || [[ "$output" =~ "notified" ]]
  # `atmux::log` (writes to stderr, captured by `run`) emits the per-
  # member delta line — authoritative evidence the verb fired the ping.
  # (Pane scrollback is shell-state-dependent: send-keys to a live shell
  # collapses the typed line into a "command not found" line that capture-
  # pane may not retain across prompt redraws.)
  [[ "$output" =~ "config-reload: worker" ]]
  [[ "$output" =~ "lane be→fe" ]]

  # The earlier BRIEF RELOAD banner in the pane scrollback is STILL there —
  # no /clear happened.
  sleep 1
  local pane_post; pane_post=$(tmux capture-pane -p -S -500 -t "$ATMUX_SESSION:__rle2e__worker" 2>/dev/null)
  [[ "$pane_post" =~ "BRIEF RELOAD" ]]
}
