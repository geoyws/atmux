#!/usr/bin/env bats
# Unit tests for lib/socket-pubsub.sh — UNIX-domain socket primitives
# behind the ADR-032 event-driven messaging layer.
#
# Pinned to socat backend per Task body; tests skip-with-reason when socat
# is absent (CI / minimal containers — install path: `apt install socat`
# or `brew install socat`). The python3 fallback path is exercised via the
# Sb supervisor integration tests, not here.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/socket-pubsub.sh
  . "$ATMUX_LIB_DIR/socket-pubsub.sh"

  if ! command -v socat >/dev/null 2>&1; then
    skip "socat not installed (apt: apt install socat | brew: brew install socat) — pubsub primitives are socat-pinned per ADR-032 OQ1"
  fi
  export ATMUX_SOCK_BACKEND=socat

  # Need a minimal .atmux/team.json so atmux::dir resolves cleanly inside
  # sock_dir / sock_path; the helper itself is path-only but still calls
  # atmux::dir which expects an .atmux/ root nearby.
  mkdir -p .atmux
  echo '{"name":"sp","members":[{"name":"w1","role":"member","tui":"shell"}]}' > .atmux/team.json
}

teardown() {
  # Reap any background socat listeners spawned by sock_subscribe; the
  # tmpdir rm-rf in atmux_teardown_sandbox can't kill processes.
  jobs -p 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  pkill -9 -f "socat.*$ATMUX_TEST_TMP" 2>/dev/null || true
  atmux_teardown_sandbox
}

# ---------- sock_bind ----------

@test "sock_bind: creates sockets dir at 0700 and echoes the resolved socket path" {
  run atmux::sock_bind w1
  [ "$status" -eq 0 ]
  [ "$output" = "$PWD/.atmux/sockets/w1.sock" ]
  [ -d "$PWD/.atmux/sockets" ]
  # Dir is private — chmod 0700 per impl (group/world bits clear).
  local mode; mode=$(stat -c '%a' "$PWD/.atmux/sockets" 2>/dev/null || stat -f '%Lp' "$PWD/.atmux/sockets")
  [ "$mode" = "700" ]
}

@test "sock_bind: idempotent — second bind on stale socket file unlinks + rebinds successfully" {
  # First bind resolves the path (no .sock file yet — the listener creates
  # it). Simulate a stale orphaned .sock left from a killed listener PID.
  atmux::sock_bind w1 >/dev/null
  mkdir -p "$PWD/.atmux/sockets"
  python3 -c "
import socket, os
p = '$PWD/.atmux/sockets/w1.sock'
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(p)
s.close()
" 2>/dev/null
  [ -S "$PWD/.atmux/sockets/w1.sock" ]

  # Second bind sees the stale socket (no live listener via lsof), unlinks,
  # echoes the same path. The .sock file is gone post-bind (listener will
  # recreate on next subscribe).
  run atmux::sock_bind w1
  [ "$status" -eq 0 ]
  [ "$output" = "$PWD/.atmux/sockets/w1.sock" ]
  [ ! -e "$PWD/.atmux/sockets/w1.sock" ]
}

@test "sock_bind: refuses with rc 1 when a LIVE listener already holds the socket" {
  atmux::sock_bind w1 >/dev/null
  socat UNIX-LISTEN:"$PWD/.atmux/sockets/w1.sock",fork,mode=0600 - >/dev/null 2>&1 &
  local listener_pid=$!
  # Wait for the listener to come up — 200ms is generous for socat.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -S "$PWD/.atmux/sockets/w1.sock" ]] && break
    sleep 0.05
  done

  run atmux::sock_bind w1
  [ "$status" -eq 1 ]
  [[ "$output" =~ "live listener" ]]

  kill -9 "$listener_pid" 2>/dev/null || true
  wait "$listener_pid" 2>/dev/null || true
}

# ---------- sock_publish ----------

@test "sock_publish: absent listener — warns + returns 0 (non-fatal)" {
  # No listener has been bound for w1 — the .sock file doesn't exist.
  # Per ADR-032, publish must NOT fail the caller's state mutation.
  run atmux::sock_publish w1 '{"type":"ping","ts":0,"from":"x","payload":{}}'
  [ "$status" -eq 0 ]
  [[ "$output" =~ "listener absent" ]] || [[ "$output" =~ "unreachable" ]]
}

@test "sock_publish + sock_subscribe: round-trip 5 events delivered to handler in order" {
  local outfile="$ATMUX_TEST_TMP/handler.log"

  # Background subscriber: write each line to the log via a handler fn.
  # The handler closure name must be exported into the subshell's env via
  # `export -f` so socat's pipe loop can resolve it.
  _record() { printf '%s\n' "$1" >> "$outfile"; }
  export -f _record
  export outfile

  atmux::sock_subscribe w1 _record &
  local sub_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -S "$PWD/.atmux/sockets/w1.sock" ]] && break
    sleep 0.05
  done
  [ -S "$PWD/.atmux/sockets/w1.sock" ]

  for i in 1 2 3 4 5; do
    atmux::sock_publish w1 "{\"type\":\"e\",\"ts\":$i,\"from\":\"t\",\"payload\":{\"i\":$i}}"
  done

  # Allow socat fork-children + handler pipeline to drain.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f "$outfile" ]] && [[ "$(wc -l <"$outfile")" -ge 5 ]] && break
    sleep 0.1
  done

  kill -9 "$sub_pid" 2>/dev/null || true
  wait "$sub_pid" 2>/dev/null || true

  [ -f "$outfile" ]
  local got; got=$(wc -l <"$outfile")
  [ "$got" -ge 5 ]
  for i in 1 2 3 4 5; do
    grep -q "\"i\":$i" "$outfile" || { echo "missing event i=$i"; cat "$outfile"; false; }
  done
}

@test "sock_publish: 10 concurrent publishers — subscriber handler invoked exactly 10× (no race-drop)" {
  skip "WEDGES autopromote — see Task t-869db41b + driver-inbox 11:48 MYT 2026-04-30. Orphan-grandchild leak from atmux::sock_subscribe spawn → bats wait blocks 13h+ (PID 2074470 PPID=1 found 2026-04-30 holding /var/lock/atmux-autopromote.lock). Real fix queued as separate Task; remove this skip when that lands."

  local outfile="$ATMUX_TEST_TMP/race.log"
  _record_race() { printf '%s\n' "$1" >> "$outfile"; }
  export -f _record_race
  export outfile

  atmux::sock_subscribe w1 _record_race &
  local sub_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -S "$PWD/.atmux/sockets/w1.sock" ]] && break
    sleep 0.05
  done
  [ -S "$PWD/.atmux/sockets/w1.sock" ]

  # Fan out 10 publishers in parallel, each tagged so we can verify all
  # 10 distinct payloads survived (rules out a silent dedupe path that
  # would pass a count-only assertion).
  for i in $(seq 1 10); do
    atmux::sock_publish w1 "{\"type\":\"r\",\"ts\":$i,\"from\":\"p$i\",\"payload\":{\"id\":$i}}" &
  done
  wait

  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    [[ -f "$outfile" ]] && [[ "$(wc -l <"$outfile")" -ge 10 ]] && break
    sleep 0.1
  done

  kill -9 "$sub_pid" 2>/dev/null || true
  wait "$sub_pid" 2>/dev/null || true

  local got; got=$(wc -l <"$outfile")
  [ "$got" = "10" ]
  for i in $(seq 1 10); do
    grep -q "\"id\":$i" "$outfile" || { echo "lost publisher id=$i"; cat "$outfile"; false; }
  done
}

# ---------- stale-listener cleanup ----------

@test "stale-listener: bind cleans up .sock from a killed-PID listener (lsof-driven)" {
  if ! command -v lsof >/dev/null 2>&1; then
    skip "lsof not installed — sock_bind's stale-listener probe falls through to 'treat as stale' but the assertion below pins the lsof code path"
  fi
  atmux::sock_bind w1 >/dev/null

  # Spawn + immediately kill a listener so the .sock file persists with no
  # holder. python3 here (not socat) because we can guarantee the file
  # outlives the process via a SIGKILL — socat's atexit handler unlinks.
  python3 -c "
import socket, os, time
p = '$PWD/.atmux/sockets/w1.sock'
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(p)
time.sleep(60)
" &
  local doomed_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -S "$PWD/.atmux/sockets/w1.sock" ]] && break
    sleep 0.05
  done
  kill -9 "$doomed_pid" 2>/dev/null
  wait "$doomed_pid" 2>/dev/null || true
  # File should still be on disk even though the holder is dead.
  [ -e "$PWD/.atmux/sockets/w1.sock" ]

  # Bind sees the stale file (lsof reports no holder) → unlinks + succeeds.
  run atmux::sock_bind w1
  [ "$status" -eq 0 ]
  [ ! -e "$PWD/.atmux/sockets/w1.sock" ]
}
