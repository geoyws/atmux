#!/usr/bin/env bash
# lib/socket-pubsub.sh — UNIX-domain socket primitives for the atmux
# event-driven messaging layer (per ADR-032).
#
# Three helpers:
#   atmux::sock_bind <member>         — ensure the per-member socket
#                                        path is ready: dir 0700, stale
#                                        socket unlinked, refuses if a
#                                        live listener is already on it.
#                                        Echoes the resolved socket path
#                                        on stdout.
#   atmux::sock_publish <m> <json>    — connect + write one JSONL event
#                                        line. Non-fatal on dead listener
#                                        (atmux::warn + rc 0) so a caller's
#                                        state mutation isn't rolled back
#                                        when the listener is briefly down.
#   atmux::sock_subscribe <m> <fn>    — long-running accept-loop; calls
#                                        fn with each event line as $1.
#                                        Used by the supervisor (Sb) only —
#                                        Sa ships the helper, not the
#                                        consumer.
#
# Backend selection (lazy — only resolved when an actual socket op runs):
#   1. ATMUX_SOCK_BACKEND env override (test-time pin).
#   2. socat (preferred — ubiquitous, fork-mode UNIX-LISTEN well-tested,
#      see ADR-032 OQ1).
#   3. python3 -c socketserver fallback for hosts without socat.
#
# Wire format (JSONL, one event per line):
#   {"type": "<verb>", "ts": <epoch>, "from": "<sender>", "payload": {…}}
#
# Sourced from lib/common.sh so every messaging verb can call
# atmux::sock_publish without an extra `. "$ATMUX_LIB_DIR/..."` line.

# Re-entry guard. Multiple verb scripts (lib/tell.sh, lib/send.sh,
# lib/dispatch.sh, lib/reply.sh, lib/decisions.sh, lib/flags.sh,
# lib/kanban.sh) each `. "$ATMUX_LIB_DIR/socket-pubsub.sh"` at top-of-file
# so atmux::sock_publish is in scope without depending on common.sh's
# transitive source. Without a guard, every re-source RE-DEFINES the
# helpers — which silently overwrites any test-time monkey-patch (test
# setup defines stubs, then the verb's source re-defines and the stubs
# are gone). Tests setting ATMUX_SOCKET_PUBSUB_LOADED=1 before sourcing
# the verb script keep their stubs intact; production use sees no change.
[[ -n "${_ATMUX_SOCKET_PUBSUB_LOADED:-}" ]] && return 0
_ATMUX_SOCKET_PUBSUB_LOADED=1

atmux::sock_dir()  { printf '%s/sockets\n' "$(atmux::dir)"; }
atmux::sock_path() { printf '%s/%s.sock\n' "$(atmux::sock_dir)" "$1"; }

# Pick the socket backend. Honors ATMUX_SOCK_BACKEND for tests; otherwise
# prefers socat, falls back to python3. atmux::die's at first use when
# neither is installed — lazy so a host without either can still source
# this lib for the path helpers.
_atmux_sock_backend() {
  if [[ -n "${ATMUX_SOCK_BACKEND:-}" ]]; then
    printf '%s\n' "$ATMUX_SOCK_BACKEND"
    return 0
  fi
  if command -v socat >/dev/null 2>&1; then
    printf 'socat\n'
  elif command -v python3 >/dev/null 2>&1; then
    printf 'python3\n'
  else
    atmux::die "socket-pubsub: neither socat nor python3 available (install socat — apt: \`apt install socat\` | brew: \`brew install socat\`)"
  fi
}

# Liveness check on a candidate socket file. Returns 0 if a process holds
# the path open (live listener); 1 otherwise. lsof is the canonical probe
# per Task body; absence of lsof falls through to "treat as stale" — the
# safer side of the trade because we'd rather rebind a socket the previous
# owner abandoned than refuse to start because we couldn't tell.
_atmux_sock_alive() {
  local sock="$1"
  [[ -S "$sock" ]] || return 1
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -- "$sock" 2>/dev/null | grep -q .
    return $?
  fi
  return 1
}

# Idempotently prepare a member's socket path. Creates dir 0700, unlinks
# a stale socket file (no live listener), refuses if there's already a
# live listener (rc 1 + warn). Echoes the resolved socket path on stdout
# so callers can pipe it into socat without re-resolving.
atmux::sock_bind() {
  local member="${1:?sock_bind: <member> required}"
  local dir; dir="$(atmux::sock_dir)"
  local sock; sock="$(atmux::sock_path "$member")"

  mkdir -p "$dir"
  chmod 0700 "$dir" 2>/dev/null || true

  if [[ -e "$sock" ]]; then
    if [[ ! -S "$sock" ]]; then
      atmux::die "sock_bind: $sock exists but is not a socket"
    fi
    if _atmux_sock_alive "$sock"; then
      atmux::warn "sock_bind: $member already has a live listener at $sock"
      return 1
    fi
    rm -f "$sock"
  fi

  printf '%s\n' "$sock"
}

# Publish one JSONL event to a member's socket. The event must be a
# single newline-terminated JSON line per the ADR-032 wire format —
# callers compose with jq -c to keep that invariant. SIGPIPE / connect-
# refused / missing-socket → atmux::warn + return 0 (non-fatal so the
# caller's state mutation doesn't roll back; the supervisor's heartbeat
# + cron-whip safety net catches missed events).
atmux::sock_publish() {
  local member="${1:?sock_publish: <member> required}"
  local event_json="${2:?sock_publish: <event-json> required}"
  local sock; sock="$(atmux::sock_path "$member")"

  if [[ ! -S "$sock" ]]; then
    atmux::warn "sock_publish: $member listener absent ($sock); event dropped"
    return 0
  fi

  local backend; backend="$(_atmux_sock_backend)"
  local rc=0
  case "$backend" in
    socat)
      printf '%s\n' "$event_json" \
        | socat -t 2 - UNIX-CONNECT:"$sock" >/dev/null 2>&1 \
        || rc=$?
      ;;
    python3)
      printf '%s\n' "$event_json" \
        | python3 -c '
import socket, sys
sock_path = sys.argv[1]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(sock_path)
    s.sendall(sys.stdin.buffer.read())
    s.close()
except Exception:
    sys.exit(1)
' "$sock" >/dev/null 2>&1 \
        || rc=$?
      ;;
    *)
      atmux::warn "sock_publish: unknown backend '$backend' (set ATMUX_SOCK_BACKEND to socat or python3)"
      return 0
      ;;
  esac

  if (( rc != 0 )); then
    atmux::warn "sock_publish: $member listener unreachable (rc=$rc); event dropped"
    return 0
  fi
  return 0
}

# atmux::sock_publish_debounced <member> <event-json> [window-ms]
#
# Per-target debounce wrapper around atmux::sock_publish. Multiple events
# for the same <member> within <window-ms> coalesce into a single
# downstream sock_publish: the first arrival schedules one background
# flush timer; subsequent arrivals append to a per-member pending file
# and ride the already-scheduled timer. After the window elapses, the
# timer wakes, merges payload.unblocked_task_ids (de-duped) across every
# queued event, stamps a fresh ts, and fires ONE sock_publish.
#
# Default window 100ms per ADR-032 OQ4 (per-target — different members
# contend on different lock/state files, so they publish independently).
#
# State (per member, under .atmux/state/cascade-debounce/):
#   <member>.last_ms — epoch-ms of the most recent published cascade
#   <member>.pending — JSONL of accumulated events awaiting flush
#   <member>.lock    — flock target serialising read/append/schedule
#
# Out-of-window calls bypass the queue and publish synchronously.
# atmux::sock_publish is non-fatal on dead listener so a member with no
# supervisor running silently drops the event; cron-whip's 5 min floor
# is the safety net.
atmux::sock_publish_debounced() {
  local member="${1:?sock_publish_debounced: <member> required}"
  local event_json="${2:?sock_publish_debounced: <event-json> required}"
  local window_ms="${3:-100}"

  local d; d="$(atmux::state_dir)/cascade-debounce"
  mkdir -p "$d"
  local last_f="$d/$member.last_ms"
  local pend_f="$d/$member.pending"
  local lock_f="$d/$member.lock"

  local now_ms; now_ms="$(_atmux_now_ms)"
  local last_ms=0

  local lockfd
  exec {lockfd}>"$lock_f"
  flock "$lockfd"

  if [[ -s "$last_f" ]]; then
    last_ms="$(head -c 32 "$last_f" 2>/dev/null || echo 0)"
    [[ "$last_ms" =~ ^[0-9]+$ ]] || last_ms=0
  fi

  local since=$(( now_ms - last_ms ))
  if (( since < window_ms )); then
    local was_empty=1
    [[ -s "$pend_f" ]] && was_empty=0
    printf '%s\n' "$event_json" >> "$pend_f"
    exec {lockfd}>&-
    if (( was_empty == 1 )); then
      local sleep_ms=$(( window_ms - since ))
      (( sleep_ms < 1 )) && sleep_ms=1
      ( _atmux_sock_debounce_flush "$member" "$sleep_ms" >/dev/null 2>&1 & disown ) 2>/dev/null \
        || _atmux_sock_debounce_flush "$member" "$sleep_ms" >/dev/null 2>&1 &
    fi
    return 0
  fi

  printf '%s' "$now_ms" > "$last_f"
  exec {lockfd}>&-
  atmux::sock_publish "$member" "$event_json"
}

# Background flush worker scheduled by sock_publish_debounced. Sleeps for
# the remaining debounce window, then merges every queued event for
# <member> into a single coalesced sock_publish. Idempotent on empty
# pending file (returns silently) so racing schedulers don't double-fire.
_atmux_sock_debounce_flush() {
  local member="$1" sleep_ms="${2:-100}"

  local secs
  if (( sleep_ms >= 1000 )); then
    secs="$(awk "BEGIN { printf \"%.3f\", $sleep_ms/1000 }")"
  else
    secs="0.$(printf '%03d' "$sleep_ms")"
  fi
  sleep "$secs" 2>/dev/null || sleep 1

  local d; d="$(atmux::state_dir)/cascade-debounce"
  local last_f="$d/$member.last_ms"
  local pend_f="$d/$member.pending"
  local lock_f="$d/$member.lock"

  local lockfd
  exec {lockfd}>"$lock_f"
  flock "$lockfd"

  if [[ ! -s "$pend_f" ]]; then
    exec {lockfd}>&-
    return 0
  fi

  local merged
  merged="$(jq -s -c '
    . as $events
    | {
        type: "task-done-cascade",
        ts:   (now | floor),
        from: ($events[0].from // ""),
        payload: {
          unblocked_task_ids: ([ $events[].payload.unblocked_task_ids[]? ] | unique),
          from_task_ids:      ([ $events[].payload.from_task_id?       ] | map(select(. != null)) | unique)
        }
      }' "$pend_f" 2>/dev/null || true)"

  : > "$pend_f"
  local now_ms; now_ms="$(_atmux_now_ms)"
  printf '%s' "$now_ms" > "$last_f"
  exec {lockfd}>&-

  [[ -n "$merged" ]] && atmux::sock_publish "$member" "$merged"
}

# Epoch milliseconds. GNU date supports %3N on Linux/cloud; falls back
# to python3 for hosts without nanosecond date (older macOS / busybox),
# and ultimately to second-precision×1000 if neither is reachable so a
# missing dep can't wedge the debounce path entirely.
_atmux_now_ms() {
  local ms
  ms="$(date +%s%3N 2>/dev/null)"
  if [[ "$ms" =~ ^[0-9]{13,}$ ]]; then
    printf '%s\n' "$ms"
    return 0
  fi
  python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null \
    || printf '%s000\n' "$(date +%s)"
}

# Long-running accept-loop. Binds (idempotent), then listens with the
# selected backend and invokes <handler> with each received line as $1.
# Used by the supervisor (Sb) only — Sa ships this helper, not the
# consumer wiring.
#
# Process-group hygiene (ADR-NEW: socat ,fork orphan-grandchild leak).
# When ATMUX_SOCK_SUBSCRIBE_SETSID=1, the listener tree is wrapped in
# `setsid -w bash -c …` so children form their own session/PGID. The
# session-leader PID is recorded to .atmux/state/socksub-<member>.pgid
# and atmux::sock_subscribe_teardown <member> kills the whole group via
# `kill -- -$pgid`. Without this, a `kill -9 $sub_pid; wait $sub_pid`
# pattern leaves orphan socat ,fork children that re-bind the socket,
# wedging callers (bats-exec-test wedged 13h+ on 2026-04-30 holding
# /var/lock/atmux-autopromote.lock).
#
# Default OFF so the supervisor (which uses a closure-shaped handler
# the setsid'd bash can't see without explicit `export -f`) keeps
# working. Tests opt-in via export ATMUX_SOCK_SUBSCRIBE_SETSID=1 in
# their setup, which means handlers must be `export -f`'d (the test
# pattern already does this for `_record_race`). Supervisor adopts
# the env var + export pattern in its own follow-up.
atmux::sock_subscribe() {
  local member="${1:?sock_subscribe: <member> required}"
  local handler="${2:?sock_subscribe: <handler> required}"

  # Re-exec under setsid when opted in AND we're not already a session
  # leader. The detection compares our PID to our SID — equality means
  # we're already leading a session, so the re-exec already happened
  # (or someone else made us leader for free). Stash PGID-as-PID to
  # the per-member file before sourcing libs so teardown finds us even
  # if the lib-source step trips.
  if [[ -n "${ATMUX_SOCK_SUBSCRIBE_SETSID:-}" ]] \
     && [[ "$(ps -o sid= -p $$ 2>/dev/null | tr -d ' ')" != "$$" ]]; then
    local _pgid_file; _pgid_file="$(atmux::state_dir)/socksub-${member}.pgid"
    mkdir -p "$(dirname "$_pgid_file")"
    # setsid -w forks a session leader, runs the body, waits for it to
    # exit. From the caller's pov, atmux::sock_subscribe still blocks
    # until the listener returns — preserving the existing call shape
    # `atmux::sock_subscribe & sub_pid=$!`.
    setsid -w bash -c '
      echo $$ > "$1"
      ATMUX_SOCK_SUBSCRIBE_SETSID="" \
        . "$2/common.sh"
      . "$2/socket-pubsub.sh"
      atmux::sock_subscribe "$3" "$4"
    ' _ "$_pgid_file" "$ATMUX_LIB_DIR" "$member" "$handler"
    return $?
  fi

  local sock
  sock="$(atmux::sock_bind "$member")" || return 1

  local backend; backend="$(_atmux_sock_backend)"
  case "$backend" in
    socat)
      # ,fork forks a child per accepted connection; child copies socket
      # bytes to socat's stdout. Aggregate stdout through `while read`
      # to call the handler per JSONL line.
      socat UNIX-LISTEN:"$sock",fork,mode=0600 - 2>/dev/null \
        | while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            "$handler" "$line"
          done
      ;;
    python3)
      python3 -c '
import os, socket, sys, threading
sock_path = sys.argv[1]
try:
    os.unlink(sock_path)
except FileNotFoundError:
    pass
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sock_path)
os.chmod(sock_path, 0o600)
srv.listen(8)

def handle(conn):
    buf = b""
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    for line in buf.splitlines():
        if line:
            sys.stdout.buffer.write(line + b"\n")
            sys.stdout.buffer.flush()
    conn.close()

while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
' "$sock" 2>/dev/null \
        | while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            "$handler" "$line"
          done
      ;;
    *)
      atmux::die "sock_subscribe: unknown backend '$backend' (set ATMUX_SOCK_BACKEND to socat or python3)"
      ;;
  esac
}


# atmux::sock_subscribe_teardown <member>
#
# Counterpart to atmux::sock_subscribe under ATMUX_SOCK_SUBSCRIBE_SETSID=1.
# Reads the recorded session-leader PID from
# .atmux/state/socksub-<member>.pgid and kills the entire process
# group via `kill -- -$pgid`. Idempotent: missing pgid file ⇒ no-op
# return 0. Two-stage shutdown: SIGTERM first (gives socat ,fork
# children a clean exit), 100ms grace, then SIGKILL.
#
# Use this in bats teardown to reliably reap socat ,fork orphans:
#   teardown() { atmux::sock_subscribe_teardown w1; atmux_teardown_sandbox; }
atmux::sock_subscribe_teardown() {
  local member="${1:?sock_subscribe_teardown: <member> required}"
  local pgid_file; pgid_file="$(atmux::state_dir)/socksub-${member}.pgid"
  [[ -f "$pgid_file" ]] || return 0

  local pgid; pgid="$(cat "$pgid_file" 2>/dev/null | tr -d ' ')"
  if [[ ! "$pgid" =~ ^[0-9]+$ ]] || [[ "$pgid" -le 1 ]]; then
    rm -f "$pgid_file"
    return 0
  fi

  # SIGTERM the group; sleep 100ms; then SIGKILL anything that didn't
  # exit. `kill -- -$pgid` addresses the process group; the leading
  # `--` keeps `-` from being interpreted as a flag.
  kill -TERM -- -"$pgid" 2>/dev/null || true
  sleep 0.1
  kill -KILL -- -"$pgid" 2>/dev/null || true

  rm -f "$pgid_file"
  return 0
}
