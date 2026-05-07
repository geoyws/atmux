#!/usr/bin/env bats
# Unit tests for lib/supervisor.sh — per-team event router (ADR-032 §Sb).
#
# Coverage:
#   - supervisor_run spawns one socket-listener per member; sockets up + heartbeat ticking within 6s.
#   - send-keys preflight (per ADR-032 + migrate.sh's NBSP-aware viewport scan):
#     all 7 blocker classes (thinking / compacting / queued-input /
#     approaching-limit / rate-limited / modal-prompt / non-empty-compose)
#     refuse send-keys + queue the event JSONL to .atmux/state/queues/<member>.jsonl.
#   - Idle pane drains the queue + fires send-keys per line.
#   - SIGCHLD-driven respawn: kill a subscriber, _atmux_supervisor_on_sigchld
#     respawns within 5s, post-rebind events deliver end-to-end.
#
# Stubs (all defined POST-source so they shadow lib/common.sh + supervisor.sh):
#   - atmux::capture_pane → echo $STUB_PANE (per-test fixture)
#   - tmux                → recording function for `send-keys`; pass-through for everything else
#
# Note: ATMUX_SOCK_SUBSCRIBE_SETSID is INTENTIONALLY left UNSET. The supervisor's
# closure-shaped handler captures $member + $queue_dir from the enclosing
# subshell; setsid -w bash -c re-execs without those captures. socket-pubsub.sh
# §sock_subscribe documents this trade-off explicitly. Teardown reaps socat
# ,fork orphans by tmpdir-anchored pkill instead of PGID kill.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/socket-pubsub.sh
  . "$ATMUX_LIB_DIR/socket-pubsub.sh"
  # shellcheck source=../../lib/migrate.sh
  . "$ATMUX_LIB_DIR/migrate.sh"
  # shellcheck source=../../lib/supervisor.sh
  . "$ATMUX_LIB_DIR/supervisor.sh"

  require_socat
  # Compress timing so the heartbeat assertion lands inside the per-test
  # budget without padding the whole suite.
  export ATMUX_SUPERVISOR_HEARTBEAT_SEC=1
  export ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC=2
  export ATMUX_SUPERVISOR_PANE_LINES=10

  mkdir -p .atmux/state .atmux/sockets
  # singleSession is intentionally OMITTED — when true, atmux::session_name
  # requires .atmux/state/session.txt (set by `atmux start` in production).
  # The supervisor's handler reach into atmux::tmux_target → session_name
  # would atmux::die in the listener subshell otherwise, masking the
  # behaviour the test cares about.
  cat >.atmux/team.json <<'JSON'
{
  "name":"sp",
  "members":[
    {"name":"w1","role":"member","tui":"shell"},
    {"name":"w2","role":"member","tui":"shell"}
  ]
}
JSON

  STUB_LOG="$ATMUX_TEST_TMP/tmux-calls.log"
  : > "$STUB_LOG"
  export STUB_LOG
  export STUB_PANE=""
}

teardown() {
  # Socat ,fork grandchildren survive a bare kill on the parent subshell.
  # Without SETSID-anchored PGID teardown, the cheapest reliable reap is
  # tmpdir-anchored pkill — every socat the supervisor spawned binds a
  # path under $ATMUX_TEST_TMP, so the regex is sandbox-scoped.
  jobs -p 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  pkill -9 -f "socat.*$ATMUX_TEST_TMP" 2>/dev/null || true
  atmux_teardown_sandbox
}

# ---------- helpers ----------

# Override atmux::capture_pane to echo the per-test STUB_PANE fixture.
# Defined as a function so it propagates to bash (subshell) forks (which
# is how the supervisor's listener wires up the handler).
_stub_capture_pane() {
  STUB_PANE="$1"
  export STUB_PANE
  atmux::capture_pane() { printf '%s' "$STUB_PANE"; }
  export -f atmux::capture_pane
}

# Override tmux to record send-keys calls. Other verbs (capture-pane,
# list-windows, has-session) fall through to the real binary — supervisor
# only hits send-keys here, so per-verb routing keeps assertions tight.
_stub_tmux_send_keys() {
  tmux() {
    if [[ "$1" == "send-keys" ]]; then
      printf 'send-keys %s\n' "$*" >> "$STUB_LOG"
      return 0
    fi
    command tmux "$@"
  }
  export -f tmux
}

# ---------- supervisor lifecycle ----------

@test "supervisor_run: spawns one listener per member + heartbeat ticks within 6s" {
  ( atmux::supervisor_run >/dev/null 2>&1 ) &
  local sup_pid=$!

  local hb="$ATMUX_DIR/state/supervisor.heartbeat"
  local sock1="$ATMUX_DIR/sockets/w1.sock"
  local sock2="$ATMUX_DIR/sockets/w2.sock"
  for _ in $(seq 1 60); do
    [[ -S "$sock1" ]] && [[ -S "$sock2" ]] && [[ -f "$hb" ]] && break
    sleep 0.1
  done

  [ -S "$sock1" ]
  [ -S "$sock2" ]
  [ -f "$hb" ]
  local now mt age
  now=$(date +%s)
  mt=$(stat -c %Y "$hb" 2>/dev/null || stat -f %m "$hb")
  age=$(( now - mt ))
  [ "$age" -le 6 ]

  kill -9 "$sup_pid" 2>/dev/null || true
  wait "$sup_pid" 2>/dev/null || true
}

# ---------- handle_event preflight (per-event dispatch path) ----------

@test "handle_event: 'Compacting conversation' → no send-keys + event queued to .atmux/state/queues/<m>.jsonl" {
  _stub_capture_pane $'\nCompacting conversation (esc to interrupt)\n'
  _stub_tmux_send_keys

  local queue_dir="$ATMUX_DIR/state/queues"
  mkdir -p "$queue_dir"
  local event='{"type":"dispatch","ts":1,"from":"lead","payload":{"task_id":"t-aaa"}}'

  _atmux_supervisor_handle_event "w1" "$queue_dir" "$event"

  # send-keys recorder must be empty.
  [ ! -s "$STUB_LOG" ]
  # Event must land in the queue.
  [ -s "$queue_dir/w1.jsonl" ]
  grep -q '"task_id":"t-aaa"' "$queue_dir/w1.jsonl"
}

@test "handle_event: idle pane → tmux send-keys fires + queue stays empty" {
  _stub_capture_pane ""
  _stub_tmux_send_keys

  local queue_dir="$ATMUX_DIR/state/queues"
  mkdir -p "$queue_dir"
  local event='{"type":"dispatch","ts":2,"from":"lead","payload":{"task_id":"t-bbb"}}'

  _atmux_supervisor_handle_event "w1" "$queue_dir" "$event"

  [ -s "$STUB_LOG" ]
  grep -q '/heads-up new task t-bbb dispatched' "$STUB_LOG"
  [ ! -e "$queue_dir/w1.jsonl" ] || [ ! -s "$queue_dir/w1.jsonl" ]
}

# ---------- 7 blocker classes ----------

@test "preflight: all 7 blocker classes refuse send-keys + queue the event" {
  _stub_tmux_send_keys
  local queue_dir="$ATMUX_DIR/state/queues"
  mkdir -p "$queue_dir"

  # Each pane fixture below is the smallest snippet the migrate detector
  # matches for that class (per lib/migrate.sh:184–215). The non-empty-
  # compose case uses U+2502 BOX DRAWINGS LIGHT VERTICAL — the awk pass
  # pulls draft text from inside that bar pair.
  local -a classes=(thinking compacting queued-input approaching-limit rate-limited modal-prompt non-empty-compose)
  local -a panes=(
    $'thinking with bat 12345\n'
    $'Compacting conversation (esc to interrupt)\n'
    $'Press up to edit queued messages\n'
    $'approaching usage limit · resets at 9pm\n'
    $'You\'ve hit your limit. Try again later.\n'
    $'Do you want to overwrite this file?\n  [y/n]:\n'
    $'\xe2\x94\x82 > some draft text                       \xe2\x94\x82\n'
  )

  local i cls pane event
  for i in 0 1 2 3 4 5 6; do
    cls="${classes[$i]}"
    pane="${panes[$i]}"
    : > "$STUB_LOG"
    rm -f "$queue_dir/w1.jsonl"
    _stub_capture_pane "$pane"
    event="{\"type\":\"dispatch\",\"ts\":3,\"from\":\"lead\",\"payload\":{\"task_id\":\"t-$cls\"}}"

    _atmux_supervisor_handle_event "w1" "$queue_dir" "$event"

    if [ -s "$STUB_LOG" ]; then
      echo "blocker class '$cls' leaked send-keys: $(cat "$STUB_LOG")" >&2
      false
    fi
    if [ ! -s "$queue_dir/w1.jsonl" ]; then
      echo "blocker class '$cls' did not queue event" >&2
      false
    fi
    grep -q "\"task_id\":\"t-$cls\"" "$queue_dir/w1.jsonl" \
      || { echo "blocker class '$cls' queue content wrong: $(cat "$queue_dir/w1.jsonl")" >&2; false; }
  done
}

# ---------- queue drain when pane clears ----------

@test "queue drain: clear pane consumes queue + fires send-keys per line, then zeros the file" {
  _stub_capture_pane ""
  _stub_tmux_send_keys

  local queue_dir="$ATMUX_DIR/state/queues"
  mkdir -p "$queue_dir"
  local f="$queue_dir/w1.jsonl"
  cat > "$f" <<'JSONL'
{"type":"dispatch","ts":1,"from":"lead","payload":{"task_id":"t-aa"}}
{"type":"dispatch","ts":2,"from":"lead","payload":{"task_id":"t-bb"}}
JSONL

  _atmux_supervisor_queue_drain "$f"

  local n; n=$(wc -l <"$STUB_LOG")
  [ "$n" -ge 2 ]
  grep -q 't-aa' "$STUB_LOG"
  grep -q 't-bb' "$STUB_LOG"
  [ ! -s "$f" ]
}

@test "queue drain: still-blocked pane leaves queue intact for next sweep" {
  _stub_capture_pane $'thinking with bat 99999\n'
  _stub_tmux_send_keys

  local queue_dir="$ATMUX_DIR/state/queues"
  mkdir -p "$queue_dir"
  local f="$queue_dir/w1.jsonl"
  printf '%s\n' '{"type":"dispatch","ts":1,"from":"lead","payload":{"task_id":"t-stuck"}}' > "$f"

  _atmux_supervisor_queue_drain "$f"

  # No send-keys, queue file untouched.
  [ ! -s "$STUB_LOG" ]
  [ -s "$f" ]
  grep -q 't-stuck' "$f"
}

# ---------- crash recovery ----------

@test "crash recovery: kill subscriber → SIGCHLD handler respawns + post-rebind events deliver" {
  _stub_capture_pane ""
  _stub_tmux_send_keys

  local queue_dir="$ATMUX_DIR/state/queues"
  mkdir -p "$queue_dir"

  _atmux_supervisor_spawn_subscriber "w1" "$queue_dir"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -S "$ATMUX_DIR/sockets/w1.sock" ]] && break
    sleep 0.1
  done
  [ -S "$ATMUX_DIR/sockets/w1.sock" ]
  local pid1="${_atmux_supervisor_pids[w1]}"
  [ -n "$pid1" ]
  kill -0 "$pid1" 2>/dev/null

  # Smoke: pre-crash event lands.
  : > "$STUB_LOG"
  atmux::sock_publish "w1" '{"type":"dispatch","ts":8,"from":"lead","payload":{"task_id":"t-pre"}}'
  for _ in $(seq 1 30); do
    grep -q 't-pre' "$STUB_LOG" 2>/dev/null && break
    sleep 0.1
  done
  grep -q 't-pre' "$STUB_LOG"

  # Crash the subscriber + reap socat children that held the socket.
  # kill -9 doesn't trigger socat's atexit unlink, so explicitly rm the
  # stale .sock file before the rebind probe — otherwise "wait for sock
  # to appear" matches the leftover file before the new socat has actually
  # bound, and the publish fires into a zombie listener path (rc=1).
  kill -9 "$pid1" 2>/dev/null || true
  wait "$pid1" 2>/dev/null || true
  pkill -9 -f "socat.*$ATMUX_TEST_TMP/.*/sockets/w1.sock" 2>/dev/null || true
  rm -f "$ATMUX_DIR/sockets/w1.sock"

  # Drive the SIGCHLD handler synchronously — bats's job-control surface is
  # noisy for trap CHLD, but the handler logic is the unit under test. The
  # 5s budget below covers the rebind window the body documents.
  _atmux_supervisor_on_sigchld "$queue_dir"
  for _ in $(seq 1 50); do
    [[ -S "$ATMUX_DIR/sockets/w1.sock" ]] && break
    sleep 0.1
  done
  local pid2="${_atmux_supervisor_pids[w1]}"
  [ -n "$pid2" ]
  [ "$pid1" != "$pid2" ]
  [ -S "$ATMUX_DIR/sockets/w1.sock" ]

  # Post-rebind event delivers end-to-end.
  : > "$STUB_LOG"
  atmux::sock_publish "w1" '{"type":"dispatch","ts":9,"from":"lead","payload":{"task_id":"t-rebound"}}'
  for _ in $(seq 1 30); do
    grep -q 't-rebound' "$STUB_LOG" 2>/dev/null && break
    sleep 0.1
  done
  grep -q 't-rebound' "$STUB_LOG"
}
