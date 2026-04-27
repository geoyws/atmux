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

# Long-running accept-loop. Binds (idempotent), then listens with the
# selected backend and invokes <handler> with each received line as $1.
# Used by the supervisor (Sb) only — Sa ships this helper, not the
# consumer wiring.
atmux::sock_subscribe() {
  local member="${1:?sock_subscribe: <member> required}"
  local handler="${2:?sock_subscribe: <handler> required}"

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
