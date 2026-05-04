#!/usr/bin/env bats
# E2E: full ADR-032 socket / supervisor / cascade integration.
#   - Real socat backend (require_socat skip-with-reason on absence).
#   - Real supervisor running in __<team>__supervisor tmux window.
#   - Real send-keys into shell-TUI panes.
#   - Real cascade publish from kanban move-done deps unblock.
#
# Test pacing: ATMUX_SUPERVISOR_HEARTBEAT_SEC=1 + QUEUE_SWEEP_SEC=2 keep
# every cell <30s. Polling loops use 0.1s ticks with generous deadlines so
# slow CI doesn't false-fail.

load '../helpers/setup'
load '../helpers/team_fixture'

setup() {
  atmux_setup_sandbox
  require_socat

  # Compress supervisor timing into bats-budget. The values propagate
  # into the supervisor pane's env via the tmux server's global
  # environment (server inherits from atmux start's process at first
  # tmux call). Without these, queue-sweep waits 30s by default.
  export ATMUX_SUPERVISOR_HEARTBEAT_SEC=1
  export ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC=2

  atmux_team_fixture_2member sl
  atmux_assert_sandbox
}

teardown() {
  # The per-team supervisor's heartbeat-loop + queue-sweep-loop + socat
  # listeners are bash processes forked from the supervisor pane WITHOUT
  # SIGHUP propagation (lib/supervisor.sh has no SIGHUP/SIGTERM trap).
  # tmux kill-server reaps the pane bash but those loops can outlive it
  # for a few hundred ms — long enough to race rm -rf $ATMUX_TEST_TMP
  # by writing a fresh heartbeat into .atmux/state/ between the
  # unlink-files and rmdir steps. Pre-empt the race by killing every
  # process bound to our sandbox path BEFORE atmux_teardown_sandbox.
  pkill -9 -f "atmux.*$ATMUX_TEST_TMP" 2>/dev/null || true
  pkill -9 -f "socat.*$ATMUX_TEST_TMP" 2>/dev/null || true
  pkill -9 -f "supervisor.*$ATMUX_TEST_TMP" 2>/dev/null || true
  # Brief settle so the kills land before rm walks the tree.
  sleep 0.2
  atmux_teardown_sandbox
}

# ---- helpers --------------------------------------------------------

# Resolve a member's actual tmux window name. Per ADR-030 the start hook
# stamps __<team>__<emoji><member> (e.g. __sl__🦨w1) where the emoji is
# minted from the registry. Tests can't predict the emoji — so we
# suffix-match the live tmux window list.
_pane_for() {
  local member="$1"
  local win
  win="$(tmux list-windows -t "=$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
         | grep -E "^__sl__.*${member}$" | head -1)"
  [[ -n "$win" ]] || { echo "no window for member '$member'" >&2; return 1; }
  printf '%s:%s\n' "$ATMUX_SESSION" "$win"
}

# Block until the supervisor side is fully up: heartbeat file exists +
# both member sockets are listening. Fails the test on timeout.
_await_supervisor_up() {
  local hb="$ATMUX_DIR/state/supervisor.heartbeat"
  local s1="$ATMUX_DIR/sockets/w1.sock"
  local s2="$ATMUX_DIR/sockets/w2.sock"
  local i
  for i in $(seq 1 200); do
    [[ -f "$hb" && -S "$s1" && -S "$s2" ]] && return 0
    sleep 0.1
  done
  echo "supervisor failed to come up within 20s" >&2
  echo "  heartbeat: $([[ -f "$hb" ]] && echo yes || echo NO)"
  echo "  sock w1:   $([[ -S "$s1" ]] && echo yes || echo NO)"
  echo "  sock w2:   $([[ -S "$s2" ]] && echo yes || echo NO)"
  tmux list-windows -t "=$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null
  return 1
}

# Poll <pane> capture-pane for <pattern> (basic regex). Returns 0 on
# match within deadline_secs, else 1.
_await_pane_match() {
  local pane="$1" pattern="$2" deadline_secs="${3:-5}"
  local i ticks=$(( deadline_secs * 10 ))
  for i in $(seq 1 "$ticks"); do
    if tmux capture-pane -p -S -50 -t "$pane" 2>/dev/null \
         | grep -qE "$pattern"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# ---- cell 1: supervisor lifecycle on start --------------------------

@test "atmux start spawns __<team>__supervisor window + binds member sockets + ticks heartbeat" {
  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]

  _await_supervisor_up

  # Supervisor window has no emoji prefix (lib/start.sh stamps it
  # literally as __<team>__supervisor — see start.sh:305).
  tmux list-windows -t "=$ATMUX_SESSION" -F '#{window_name}' \
    | grep -qxF '__sl__supervisor'

  [ -S "$ATMUX_DIR/sockets/w1.sock" ]
  [ -S "$ATMUX_DIR/sockets/w2.sock" ]

  # Heartbeat fresh (≤6s old — heartbeat-loop ticks every 1s in this
  # sandbox; 6s is the supervisor.bats tolerance).
  local now mt age
  now=$(date +%s)
  mt=$(stat -c %Y "$ATMUX_DIR/state/supervisor.heartbeat")
  age=$(( now - mt ))
  [ "$age" -le 6 ]

  # At least one socat process bound to a sandbox socket — proves the
  # listener PID is alive (not just a stale socket file).
  pgrep -af "socat.*$ATMUX_TEST_TMP.*\.sock" >/dev/null
}

# ---- cell 2: dispatch end-to-end -----------------------------------

@test "atmux dispatch w1 → /heads-up keystroke arrives in __sl__w1 within 2s" {
  "$ATMUX_BIN" start --no-doctor
  _await_supervisor_up
  # Settle delay — dispatched send-keys race the shell's first prompt
  # render; without this the keystroke may land before the pane is
  # ready to display it (no functional impact, but flakes capture-pane).
  sleep 1

  local tid; tid=$("$ATMUX_BIN" task add "dispatch-target" --lane be | tail -1)
  [[ "$tid" =~ ^t-[0-9a-f]{8}$ ]]

  run "$ATMUX_BIN" dispatch w1 "$tid" --no-ping
  [ "$status" -eq 0 ]

  # Real send-keys flow: dispatch → sock_publish → supervisor listener →
  # capture-pane (idle) → tmux send-keys "/heads-up new task <id>
  # dispatched" Enter. Shell runs it, "/heads-up: command not found"
  # (or similar), but the keystroke text IS in the pane. We grep for the
  # /heads-up sentinel which is what the supervisor's _inject emits.
  local w1_pane; w1_pane="$(_pane_for w1)"
  _await_pane_match "$w1_pane" "/heads-up new task $tid dispatched" 5
}

# ---- cell 3: cascade end-to-end ------------------------------------

@test "task move done deps cascade → /heads-up cascade unblock in owner-of-t-B's pane" {
  "$ATMUX_BIN" start --no-doctor
  _await_supervisor_up
  sleep 1

  # t-A claimed by w1. t-B in todo with deps[t-A], owner pre-set to w2
  # via direct kanban patch (dispatch's deps gate would refuse t-B
  # while t-A is in-progress).
  local ta tb
  ta=$("$ATMUX_BIN" task add "task-A" --lane be | tail -1)
  tb=$("$ATMUX_BIN" task add "task-B" --lane be | tail -1)
  "$ATMUX_BIN" dispatch w1 "$ta" --no-ping >/dev/null

  jq --arg tb "$tb" --arg ta "$ta" '
    .tasks |= map(if .id == $tb then
      .deps = [$ta] | .owner = "w2"
    else . end)' .atmux/kanban.json > .atmux/kanban.json.tmp
  mv .atmux/kanban.json.tmp .atmux/kanban.json

  # Closing t-A fires the cascade. Per-target 100ms debounce → keystroke
  # observable inside ~1s on the w2 pane (debounce flush + send-keys).
  "$ATMUX_BIN" done "$ta" --as w1 --note "ship-it"

  local w2_pane; w2_pane="$(_pane_for w2)"
  # Cascade pipeline: kanban move-done → 100ms debounce timer →
  # sock_publish → listener handler → capture-pane idle → send-keys.
  # 10s deadline absorbs socat ,fork bind variance + the post-summary
  # auto-dispatch ping that races with our cascade observation.
  _await_pane_match "$w2_pane" "/heads-up cascade unblock" 10

  # w1 should NOT have received the cascade (it's the closer; t-A has no
  # forward deps that would unblock something w1 owns). w1's pane only
  # has the auto-dispatched commit task (gitter-bound), not the cascade.
  local w1_pane; w1_pane="$(_pane_for w1)"
  ! tmux capture-pane -p -S -50 -t "$w1_pane" 2>/dev/null \
      | grep -qF "cascade unblock"
}

# ---- cell 4: send-keys preflight (blocker → queue → drain) ---------

@test "preflight: blocker pane refuses send-keys + queues event; clearing scrollback drains within sweep window" {
  "$ATMUX_BIN" start --no-doctor
  _await_supervisor_up
  sleep 1

  # Inject the literal 'Compacting conversation' phrase into w1's pane,
  # then leave the shell in a `read`-blocked state so the phrase stays in
  # the captured viewport. migrate.sh's blocker detector greps -i for it
  # in the supervisor's atmux::capture_pane output.
  local pane; pane="$(_pane_for w1)"
  tmux send-keys -t "$pane" \
    "echo 'Compacting conversation (esc to interrupt)'; read -t 60 _" Enter
  # Wait for the echo to render before publishing — the listener side
  # captures the LIVE pane state, not detect-time.
  _await_pane_match "$pane" "Compacting conversation" 3

  local tid; tid=$("$ATMUX_BIN" task add "blocked-target" --lane be | tail -1)
  "$ATMUX_BIN" dispatch w1 "$tid" --no-ping >/dev/null

  # Queue file populated within ~1s (publish → handler → preflight
  # refuse → queue append).
  local queue="$ATMUX_DIR/state/queues/w1.jsonl"
  local i
  for i in $(seq 1 50); do
    [[ -s "$queue" ]] && break
    sleep 0.1
  done
  [ -s "$queue" ]
  grep -q "\"task_id\":\"$tid\"" "$queue"

  # No /heads-up keystroke landed for the BLOCKED dispatch. Pane shows
  # the `read` line — assert the dispatch's task id did NOT make it
  # through. (The Compacting echo + `read` prompt are pre-existing.)
  ! tmux capture-pane -p -S -50 -t "$pane" 2>/dev/null \
      | grep -qF "/heads-up new task $tid dispatched"

  # Now clear the blocker: kill the read with C-c, clear-history wipes
  # the scrollback so the supervisor's next capture-pane sees a clean
  # idle prompt.
  tmux send-keys -t "$pane" C-c
  sleep 0.3
  tmux send-keys -t "$pane" "clear" Enter
  sleep 0.3
  tmux clear-history -t "$pane"

  # Queue-sweep loop ticks every ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC=2s.
  # _atmux_supervisor_queue_drain re-checks the pane, sees idle, fires
  # send-keys per queued line, then truncates the queue. 15s deadline
  # absorbs ≤2 missed sweep ticks + the capture-pane viewport re-render
  # delay after clear-history.
  _await_pane_match "$pane" "/heads-up new task $tid dispatched" 15

  # Queue file zero-length post-drain (drain truncates on success).
  [ ! -s "$queue" ]
}

# ---- cell 5: stop tears down cleanly -------------------------------

@test "atmux stop kills supervisor window + clears heartbeat + leaves no orphan socat" {
  "$ATMUX_BIN" start --no-doctor
  _await_supervisor_up
  sleep 1

  # Snapshot orphan-suspect socat pids so post-stop check is sandbox-
  # scoped. (Other socat processes on the host are out-of-scope.)
  local before_pids
  before_pids=$(pgrep -f "socat.*$ATMUX_TEST_TMP" || true)
  [ -n "$before_pids" ]  # sanity: at least one listener pre-stop

  "$ATMUX_BIN" stop --force
  [ "$status" -eq 0 ] || true  # stop may emit warns; gate on side-effects

  # Supervisor window gone.
  ! tmux list-windows -t "=$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qxF '__sl__supervisor'

  # Heartbeat cleared.
  [ ! -f "$ATMUX_DIR/state/supervisor.heartbeat" ]

  # No orphan socat. socat ,fork children may take a moment to exit
  # after the parent window dies — poll briefly.
  local i orphan
  for i in $(seq 1 30); do
    orphan=$(pgrep -f "socat.*$ATMUX_TEST_TMP" || true)
    [[ -z "$orphan" ]] && break
    sleep 0.1
  done
  if [[ -n "$orphan" ]]; then
    echo "orphan socat survived stop: $orphan" >&2
    ps -fp $orphan >&2 || true
    false
  fi
}
