#!/usr/bin/env bats
# E2E: full lifecycle against a tmux session using tui=shell.
# No AI API calls — we exercise atmux itself end-to-end.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # Use a team.json whose members are all tui=shell so start doesn't try to launch claude/etc.
  cat > /tmp/e2e-team-template.json <<JSON
{
  "name": "e2e",
  "members": [
    {"name": "lead",     "role": "team-lead",     "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "reviewer", "role": "reviewer",      "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "gitter",   "role": "gitter",        "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "w1",       "role": "member",        "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip":   {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "downConfirmTicks": 1},
  "report": {"intervalMins": 30}
}
JSON
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cp /tmp/e2e-team-template.json .atmux/team.json
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
  # Make the session name unique so parallel runs don't collide.
  export ATMUX_SESSION="atmux-test-$$-$RANDOM"
  export ATMUX_TEST_SESSION="$ATMUX_SESSION"
}

teardown() {
  atmux_teardown_sandbox
}

@test "e2e: start creates tmux session + one window per member" {
  run "$ATMUX_BIN" start
  [ "$status" -eq 0 ]
  run tmux has-session -t "$ATMUX_SESSION"
  [ "$status" -eq 0 ]
  # 4 members → 4 windows.
  local n; n=$(tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' | grep -c '^__e2e__' || true)
  [ "$n" = "4" ]
}

@test "e2e: start + send puts text into the pane" {
  "$ATMUX_BIN" start
  sleep 1
  run "$ATMUX_BIN" send w1 "echo HELLO_FROM_ATMUX_E2E"
  [ "$status" -eq 0 ] || true  # send verifier may warn, that's fine
  sleep 2
  run tmux capture-pane -p -S -30 -t "$ATMUX_SESSION:__e2e__w1"
  [[ "$output" =~ HELLO_FROM_ATMUX_E2E ]]
}

@test "e2e: dispatch + claim + done round-trip" {
  "$ATMUX_BIN" start
  local id; id=$("$ATMUX_BIN" task add "e2e-task-1" | tail -1)
  [ -n "$id" ]

  "$ATMUX_BIN" dispatch w1 "$id" --no-ping
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]

  "$ATMUX_BIN" done "$id" --as w1 --note "e2e-ok"
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "done" ]
}

@test "e2e: tell-lead appends to driver-inbox + pings lead pane" {
  "$ATMUX_BIN" start
  sleep 1
  run "$ATMUX_BIN" tell-lead "please implement X"
  [ "$status" -eq 0 ] || true
  run grep -F "please implement X" .atmux/driver-inbox.md
  [ "$status" -eq 0 ]
  # Lead pane should see the ping text.
  sleep 1
  run tmux capture-pane -p -S -30 -t "$ATMUX_SESSION:__e2e__lead"
  [[ "$output" =~ "please implement X" ]]
}

@test "e2e: status reports session=up and correct pane states" {
  "$ATMUX_BIN" start
  run "$ATMUX_BIN" status
  [ "$status" -eq 0 ]
  [[ "$output" =~ "session=$ATMUX_SESSION" ]]
  [[ "$output" =~ \[up\] ]]
}

@test "e2e: whip all-clean when session is up and no stale tasks" {
  "$ATMUX_BIN" start
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "all clean" ]]
}

@test "e2e: whip flags DOWN after stop" {
  "$ATMUX_BIN" start
  "$ATMUX_BIN" stop --force
  run "$ATMUX_BIN" whip
  [[ "$output" =~ DOWN ]] || [[ "$output" =~ down ]]
}

@test "e2e: stop archives state" {
  "$ATMUX_BIN" start
  "$ATMUX_BIN" task add "some-task" >/dev/null
  "$ATMUX_BIN" stop
  run ls .atmux/archive
  [ "$status" -eq 0 ]
  [ -n "$output" ]  # at least one archive dir
}

@test "e2e: report produces a shipped section with a completed task" {
  "$ATMUX_BIN" start
  local id; id=$("$ATMUX_BIN" task add "ship-it" | tail -1)
  "$ATMUX_BIN" dispatch w1 "$id" --no-ping
  "$ATMUX_BIN" done "$id" --as w1 --note "done"
  run "$ATMUX_BIN" report --no-discord
  [[ "$output" =~ "atmux-report" ]]
  [[ "$output" =~ "ship-it" ]]
}

@test "e2e: broadcast message lands in every non-driver member pane" {
  "$ATMUX_BIN" start
  sleep 1
  run "$ATMUX_BIN" broadcast "echo BROADCAST_E2E"
  sleep 2
  # At least one member pane should have it.
  local hits=0
  for m in lead reviewer gitter w1; do
    local pane; pane=$(tmux capture-pane -p -S -30 -t "$ATMUX_SESSION:__e2e__$m" 2>/dev/null || true)
    if echo "$pane" | grep -qF "BROADCAST_E2E"; then
      hits=$((hits + 1))
    fi
  done
  (( hits >= 3 ))
}

@test "e2e: rotate stamps .atmux/state/<member>-rotated.epoch on success (E2/S1 t-9d90f3ac)" {
  "$ATMUX_BIN" start
  sleep 1
  # Workers in the e2e roster use tui=shell, which hits the non-claude warning
  # path in lib/rotate.sh — both paths must stamp the epoch per AC.
  local before; before=$(date +%s)
  run "$ATMUX_BIN" rotate w1
  [ "$status" -eq 0 ]
  [ -f .atmux/state/w1-rotated.epoch ]
  local stamp; stamp=$(< .atmux/state/w1-rotated.epoch)
  [[ "$stamp" =~ ^[0-9]+$ ]]
  (( stamp >= before ))

  # Re-rotation overwrites — second call's stamp >= first call's stamp.
  sleep 1
  "$ATMUX_BIN" rotate w1
  local stamp2; stamp2=$(< .atmux/state/w1-rotated.epoch)
  (( stamp2 >= stamp ))
}

@test "e2e: rotate-lead stamps the resolved team-lead's epoch (not literal 'lead')" {
  "$ATMUX_BIN" start
  sleep 1
  # Resolve the team-lead by role so this test still passes if the lead member
  # is renamed in a future roster shuffle.
  local lead_name; lead_name=$(jq -r 'first(.members[] | select(.role=="team-lead") | .name)' .atmux/team.json)
  [ -n "$lead_name" ]
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -eq 0 ]
  [ -f ".atmux/state/${lead_name}-rotated.epoch" ]
}

# ============================================================
# S8 capstone — Epic end-to-end through pull-mode kanban
# ============================================================
# These tests exercise the pull-model end-to-end (epic / story / task /
# claim --next / auto-dispatch / decisions) WITHOUT spawning tmux or any
# TUI. They rebuild .atmux/team.json with lane-stamped workers + a gitter
# member to receive commit-Tasks; everything else is pure kanban verbs.

# Rebuild team.json with the AC-required pull-mode roster: lead + gitter +
# 3 lane-stamped workers (fe-test / be-test / db-test). Tui=shell so a
# subsequent atmux start (if any) won't spawn real TUIs.
_e2e_rebuild_pullmode_team() {
  cat > .atmux/team.json <<JSON
{
  "name": "e2e",
  "members": [
    {"name": "lead",    "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "gitter",  "role": "gitter",    "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "fe-test", "role": "member",    "lane": "fe",   "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "be-test", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "db-test", "role": "member",    "lane": "db",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "kanban": {"crossLaneClaim": true},
  "whip":   {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "downConfirmTicks": 1},
  "report": {"intervalMins": 30}
}
JSON
  for m in lead gitter fe-test be-test db-test; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
}

@test "e2e: Epic→Story→Tasks pull-mode lifecycle (claim --next + auto-dispatch + state machine)" {
  _e2e_rebuild_pullmode_team

  # Planner-side: scaffold an Epic + Story in `ready` and add two be-lane Tasks.
  local eid; eid=$("$ATMUX_BIN" epic add "ship feature X" --body "e2e capstone" | tail -1)
  [[ "$eid" =~ ^e-[0-9a-f]{8}$ ]]
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  local sid; sid=$("$ATMUX_BIN" story add "auth flow" --epic "$eid" --ac "must do auth" | tail -1)
  [[ "$sid" =~ ^s-[0-9a-f]{8}$ ]]

  local t1; t1=$("$ATMUX_BIN" task add "backend handler"    --story "$sid" --epic "$eid" --lane be --deliverable "lib/handler.sh"     | tail -1)
  local t2; t2=$("$ATMUX_BIN" task add "backend validators" --story "$sid" --epic "$eid" --lane be --deliverable "lib/validators.sh"  | tail -1)
  [[ "$t1" =~ ^t-[0-9a-f]{8}$ ]]
  [[ "$t2" =~ ^t-[0-9a-f]{8}$ ]]

  # be-test pulls via claim --next — should grab a be-lane task.
  run "$ATMUX_BIN" claim --next --as be-test
  [ "$status" -eq 0 ]
  local claimed1; claimed1=$(jq -r '[.tasks[] | select(.owner=="be-test" and .status=="in-progress")] | .[0].id' .atmux/kanban.json)
  [[ "$claimed1" = "$t1" || "$claimed1" = "$t2" ]]

  # Mark done — auto-dispatch should append a commit-Task to gitter inbox.
  "$ATMUX_BIN" done "$claimed1" --as be-test --note "shipped"

  local commit_count
  commit_count=$(jq '[.pending[]?, .inProgress[]? | select(.subject | test("^commit "))] | length' .atmux/inboxes/gitter.json)
  [ "$commit_count" -ge 1 ]

  # be-test pulls again, picks the OTHER be-lane task.
  run "$ATMUX_BIN" claim --next --as be-test
  [ "$status" -eq 0 ]
  local claimed2; claimed2=$(jq -r '[.tasks[] | select(.owner=="be-test" and .status=="in-progress")] | .[0].id' .atmux/kanban.json)
  [ -n "$claimed2" ]
  [ "$claimed2" != "$claimed1" ]

  "$ATMUX_BIN" done "$claimed2" --as be-test --note "shipped"

  # Two commit-Tasks now (one per BE Task done).
  commit_count=$(jq '[.pending[]?, .inProgress[]? | select(.subject | test("^commit "))] | length' .atmux/inboxes/gitter.json)
  [ "$commit_count" -ge 2 ]

  # Each commit-Task has .epic=null, .lane=misc (no recursion per ADR-007 OQ4).
  run jq -r '[.tasks[] | select(.subject | test("^commit "))] | map([.epic // "null", .lane] | join(",")) | unique | join(";")' .atmux/kanban.json
  [ "$output" = "null,misc" ]

  # Story / Epic state machine: closing all be-lane Tasks does NOT auto-flip
  # the Story (auto-flip only fires testing→review on a test-lane task per
  # T4.2 AC). Since we never manually advanced the Story past `planning`,
  # both Story and Epic remain in pre-completion states. Assert NOT in any
  # terminal state — the natural stop where a planner/reviewer would step in.
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .status' .atmux/kanban.json
  [[ "$output" =~ ^(planning|ready|in-progress|testing)$ ]]
  run jq -r --arg eid "$eid" '.epics[] | select(.id==$eid) | .status' .atmux/kanban.json
  [[ "$output" =~ ^(planning|ready|in-progress)$ ]]
}

@test "e2e: cross-lane claim --next (be-test pulls fe-lane task when be-lane empty)" {
  _e2e_rebuild_pullmode_team
  local eid; eid=$("$ATMUX_BIN" epic add "cross-lane" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  local fe_id; fe_id=$("$ATMUX_BIN" task add "fe-only" --epic "$eid" --lane fe | tail -1)

  # be-test has no be-lane work; crossLaneClaim=true → falls back.
  run "$ATMUX_BIN" claim --next --as be-test
  [ "$status" -eq 0 ]
  run jq -r --arg id "$fe_id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "be-test" ]
}

@test "e2e: decisions add (high reversibility) fires Discord webhook + persists to .atmux/decisions.md" {
  _e2e_rebuild_pullmode_team

  # Mock curl — capture argv NUL-separated so we can recover the JSON payload.
  local mockbin="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$mockbin"
  cat > "$mockbin/curl" <<EOF
#!/usr/bin/env bash
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$mockbin/curl"
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"

  # Use --reversibility high — per ADR-008 §S8 (gating) only `high`
  # triggers a per-add Discord ping. low/medium write to decisions.md
  # but skip the webhook (covered by unit tests in decisions_gating.bats).
  # Pre-gating this test used `medium` and silently failed once the gate
  # landed; the assertion was stale relative to the contract.
  PATH="$mockbin:$PATH" run "$ATMUX_BIN" decisions add "ship pull-mode now?" --default "yes" --reversibility high
  [ "$status" -eq 0 ]
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^d-[0-9a-f]{8}$ ]]

  # Persisted to disk.
  [ -f .atmux/decisions.md ]
  grep -qF "ship pull-mode now?" .atmux/decisions.md
  grep -qF "$id" .atmux/decisions.md

  # Webhook fired (mock-curl wrote args).
  [ -f "$ATMUX_TEST_TMP/curl-args.bin" ]
  local payload
  payload=$(awk 'BEGIN{RS="\0"} prev=="-d"{print; exit} {prev=$0}' "$ATMUX_TEST_TMP/curl-args.bin" | jq -r '.content // empty')
  [[ "$payload" =~ "[atmux-decisions]" ]]
  [[ "$payload" =~ "ship pull-mode now?" ]]
  [[ "$payload" =~ "reversibility: high" ]]
}
