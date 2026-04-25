#!/usr/bin/env bats
# Unit tests for `atmux rotate` / `atmux rotate-lead` epoch-write — T2.S1
# (t-20b4265a, deps t-9d90f3ac). Pre-scaffold per d-485b965d; the file
# stays untracked (`??`) until the parent BE commits.
#
# Per ADR-009 D1: lib/rotate.sh writes .atmux/state/<member>-rotated.epoch
# on every successful rotation (idempotent overwrite). Whip's auto-rotation
# logic (E2/S2) reads this file to anchor uptime.
#
# Testing strategy: rotate.sh requires a live tmux window for the target
# member (atmux::tmux_window_exists check + send-keys / paste-buffer). We
# bring up a minimal sandbox session via `atmux start` with tui=shell
# members so no real TUIs spawn. Same pattern as tests/e2e/lifecycle.bats.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "rot",
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
  export ATMUX_SESSION="atmux-test-rot-$$-$RANDOM"
}

teardown() {
  atmux_teardown_sandbox
}

# Bring up the sandbox tmux session so rotate has windows to address.
_start_session() {
  "$ATMUX_BIN" start >/dev/null 2>&1 || true
  # Best-effort wait for windows to register.
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__rot__lead" && return 0
    sleep 0.2
  done
}

# ---------- AC (a): rotate <member> writes the epoch file with valid digits ----------

@test "rotate: writes .atmux/state/<member>-rotated.epoch with digits-only epoch" {
  _start_session
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [ -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(cat .atmux/state/worker-rotated.epoch)
  [[ "$epoch" =~ ^[0-9]+$ ]]
}

# ---------- AC (b): re-rotate overwrites ----------

@test "rotate: re-rotate overwrites the epoch file (single line, latest value)" {
  _start_session
  "$ATMUX_BIN" rotate worker >/dev/null 2>&1
  local first; first=$(cat .atmux/state/worker-rotated.epoch)
  sleep 1
  "$ATMUX_BIN" rotate worker >/dev/null 2>&1
  local second; second=$(cat .atmux/state/worker-rotated.epoch)
  [[ "$second" =~ ^[0-9]+$ ]]
  [ "$second" -ge "$first" ]
  # File must have exactly one line (no append-mode accumulation).
  local lines; lines=$(wc -l < .atmux/state/worker-rotated.epoch)
  [ "$lines" -le 1 ]
}

# ---------- AC (c): rotate-lead writes lead's epoch under lead's name ----------

@test "rotate-lead: writes .atmux/state/lead-rotated.epoch (resolves team-lead role)" {
  _start_session
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -eq 0 ]
  [ -f .atmux/state/lead-rotated.epoch ]
  # Specifically lead's file, NOT a generic "lead.epoch" or anyone else's.
  [ ! -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(cat .atmux/state/lead-rotated.epoch)
  [[ "$epoch" =~ ^[0-9]+$ ]]
}

@test "rotate-lead: with renamed team-lead member writes under the renamed name" {
  # Per the same role-not-name lookup pattern as the epic-summary fix
  # (review-followup t-53051620 / commit 8e4c303). rotate-lead should
  # follow the role, not hard-code 'lead'.
  jq '(.members[] | select(.role=="team-lead") | .name) = "captain"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  echo '{"pending":[],"inProgress":[],"done":[]}' > .atmux/inboxes/captain.json

  _start_session
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -eq 0 ]
  [ -f .atmux/state/captain-rotated.epoch ]
  [ ! -f .atmux/state/lead-rotated.epoch ]
}

# ---------- AC (d): state dir auto-created if missing ----------

@test "rotate: auto-creates .atmux/state/ when missing" {
  rm -rf .atmux/state
  _start_session
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [ -d .atmux/state ]
  [ -f .atmux/state/worker-rotated.epoch ]
}

# ---------- AC (e): epoch within ~5s of test wall-clock ----------

@test "rotate: epoch value is within 5s of test wall-clock at rotation time" {
  _start_session
  local before; before=$(date +%s)
  "$ATMUX_BIN" rotate worker >/dev/null 2>&1
  local after; after=$(date +%s)
  local epoch; epoch=$(cat .atmux/state/worker-rotated.epoch)
  [ "$epoch" -ge "$before" ]
  [ "$epoch" -le "$after" ]
  # Tighter: within 5s of either bound.
  [ $((epoch - before)) -le 5 ]
  [ $((after - epoch)) -le 5 ]
}

# ---------- error paths ----------

@test "rotate: unknown member errors before writing any epoch file" {
  _start_session
  run "$ATMUX_BIN" rotate ghost
  [ "$status" -ne 0 ]
  [ ! -f .atmux/state/ghost-rotated.epoch ]
}

@test "rotate-lead: errors when team.json has no team-lead role" {
  jq '(.members[] | select(.role=="team-lead") | .role) = "member"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  _start_session
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "team-lead" ]] || [[ "$output" =~ "lead" ]]
}

@test "rotate: no tmux window for member ⇒ errors before writing epoch" {
  # No _start_session — no windows exist. Rotate must refuse.
  run "$ATMUX_BIN" rotate worker
  [ "$status" -ne 0 ]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}
