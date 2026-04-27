#!/usr/bin/env bash
# lib/supervisor.sh — per-team event router (ADR-032 §Supervisor lifecycle).
#
# Runs in the team's `__<team>__supervisor` tmux window via the
# `atmux supervisor-start <team>` verb (verb file: lib/supervisor-start.sh,
# Sb-task-2 — out of scope here). This lib is the bash entry-point that
# verb invokes via atmux::supervisor_run.
#
# Architecture:
#   - One supervisor process per team. It enumerates team.json:.members[]
#     and spawns one atmux::sock_subscribe per member as a bash background.
#   - Each subscribe handler captures the member's pane state, runs the
#     NBSP-aware migrate-grade preflight, and either tmux send-keys's the
#     event-typed nudge or queues the event JSONL to
#     .atmux/state/queues/<member>.jsonl for the next ≤30s sweep.
#   - A heartbeat loop touches .atmux/state/supervisor.heartbeat every
#     ATMUX_SUPERVISOR_HEARTBEAT_SEC. atmux doctor / cron-whip read mtime
#     to detect a dead supervisor.
#   - Outer SIGCHLD trap respawns any sock_subscribe child that exits.
#
# Dependencies sourced here (handler-only — no top-level side effects):
#   - lib/socket-pubsub.sh: atmux::sock_subscribe (the long-running listener).
#   - lib/migrate.sh: _atmux_migrate_detect_blocker (NBSP-aware viewport
#     scan, per feedback_migrate_detector_quirks.md). Re-exported as
#     atmux::send_keys_blocker for cross-lib readability.

# shellcheck source=socket-pubsub.sh
. "$ATMUX_LIB_DIR/socket-pubsub.sh"
# shellcheck source=migrate.sh
. "$ATMUX_LIB_DIR/migrate.sh"
# migrate.sh defines its own main() (it's a verb file). Unset to keep
# our caller's main() namespace clean — the verb-script that sources us
# (lib/supervisor-start.sh) defines its own main after this source.
unset -f main 2>/dev/null || true

atmux::send_keys_blocker() { _atmux_migrate_detect_blocker "$@"; }

ATMUX_SUPERVISOR_HEARTBEAT_SEC="${ATMUX_SUPERVISOR_HEARTBEAT_SEC:-5}"
ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC="${ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC:-30}"
ATMUX_SUPERVISOR_PANE_LINES="${ATMUX_SUPERVISOR_PANE_LINES:-40}"

# Member-name → subscriber-PID. Read by the SIGCHLD trap to identify which
# child died and respawn it. Top-level so the trap (running in the main
# shell) can see it.
declare -gA _atmux_supervisor_pids=()

# Entry point. Verb script (Sb-task-2) calls this from its main().
atmux::supervisor_run() {
  atmux::require jq tmux
  atmux::require_team

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  local heartbeat_file queue_dir
  heartbeat_file="$(atmux::state_dir)/supervisor.heartbeat"
  queue_dir="$(atmux::state_dir)/queues"
  mkdir -p "$queue_dir" "$(dirname "$heartbeat_file")"

  atmux::log "supervisor: starting team='$team' session='$session' queue='$queue_dir'"

  _atmux_supervisor_heartbeat_loop "$heartbeat_file" &
  local hb_pid=$!
  atmux::log "supervisor: heartbeat pid=$hb_pid (every ${ATMUX_SUPERVISOR_HEARTBEAT_SEC}s)"

  _atmux_supervisor_queue_sweep_loop "$queue_dir" &
  local sweep_pid=$!
  atmux::log "supervisor: queue-sweep pid=$sweep_pid (every ${ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC}s)"

  local m
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    _atmux_supervisor_spawn_subscriber "$m" "$queue_dir"
  done < <(jq -r '.members[].name' "$(atmux::team_json)")

  trap "_atmux_supervisor_on_sigchld '$queue_dir'" CHLD

  # Park the foreground. Children do the work; SIGCHLD respawns dead ones.
  while true; do
    sleep 60
  done
}

_atmux_supervisor_heartbeat_loop() {
  local file="$1"
  while true; do
    : > "$file"
    sleep "$ATMUX_SUPERVISOR_HEARTBEAT_SEC"
  done
}

_atmux_supervisor_spawn_subscriber() {
  local member="$1" queue_dir="$2"
  (
    # Closure: handler is a per-subshell function that captures $member +
    # $queue_dir from the enclosing scope. atmux::sock_subscribe invokes
    # it via "$handler" "$line" — same shell, function visible.
    _supervisor_handle_event() {
      _atmux_supervisor_handle_event "$member" "$queue_dir" "$1"
    }
    atmux::sock_subscribe "$member" _supervisor_handle_event
  ) &
  local pid=$!
  _atmux_supervisor_pids[$member]="$pid"
  atmux::log "supervisor: subscriber spawned $member pid=$pid"
}

# Per-event dispatch: capture pane, run preflight, inject or queue.
_atmux_supervisor_handle_event() {
  local member="$1" queue_dir="$2" event="$3"

  local state blocker
  state="$(atmux::capture_pane "$member" "$ATMUX_SUPERVISOR_PANE_LINES")"
  blocker="$(atmux::send_keys_blocker "$state")"

  if [[ -n "$blocker" ]]; then
    _atmux_supervisor_queue_append "$queue_dir" "$member" "$event" "$blocker"
    return 0
  fi
  _atmux_supervisor_inject "$member" "$event"
}

_atmux_supervisor_queue_append() {
  local queue_dir="$1" member="$2" event="$3" blocker="$4"
  local f="$queue_dir/$member.jsonl"
  mkdir -p "$queue_dir"
  printf '%s\n' "$event" >> "$f"
  atmux::log "supervisor: deferred event for $member (blocker=$blocker)"
}

# Compose the per-event-type tmux send-keys nudge. Templates follow the
# Task body's examples; unknown types fall back to a generic /heads-up so
# new event types route through without a code change.
_atmux_supervisor_inject() {
  local member="$1" event="$2"

  local etype task_id from
  etype="$(jq -r '.type // "unknown"' <<<"$event" 2>/dev/null || echo unknown)"
  task_id="$(jq -r '.payload.task_id // empty' <<<"$event" 2>/dev/null || true)"
  from="$(jq -r '.from // ""' <<<"$event" 2>/dev/null || true)"

  local msg
  case "$etype" in
    dispatch)
      msg="/heads-up new task ${task_id:-?} dispatched"
      ;;
    task-done-cascade)
      msg="/heads-up cascade unblock — claim --next"
      ;;
    send|broadcast)
      msg="/heads-up message from ${from:-?}"
      ;;
    tell-lead|reply)
      msg="/heads-up new ${etype} from ${from:-?}"
      ;;
    decisions-add|flag-add|flag-resolve)
      msg="/heads-up ${etype}"
      ;;
    *)
      msg="/heads-up ${etype} event"
      ;;
  esac

  local target; target="$(atmux::tmux_target "$member")"
  tmux send-keys -t "$target" "$msg" Enter 2>/dev/null \
    || atmux::warn "supervisor: send-keys to $member failed"
}

# Periodic sweep: re-check each pending queue. If the member's pane is
# now clear, drain the queue (one inject per line) and zero the file.
# Still busy → leave the queue for the next sweep.
_atmux_supervisor_queue_sweep_loop() {
  local queue_dir="$1"
  while true; do
    sleep "$ATMUX_SUPERVISOR_QUEUE_SWEEP_SEC"
    local f
    for f in "$queue_dir"/*.jsonl; do
      [[ -f "$f" ]] || continue
      [[ -s "$f" ]] || continue
      _atmux_supervisor_queue_drain "$f"
    done
  done
}

_atmux_supervisor_queue_drain() {
  local f="$1"
  local member; member="$(basename "$f" .jsonl)"

  local state blocker
  state="$(atmux::capture_pane "$member" "$ATMUX_SUPERVISOR_PANE_LINES")"
  blocker="$(atmux::send_keys_blocker "$state")"

  if [[ -n "$blocker" ]]; then
    return 0
  fi

  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    _atmux_supervisor_inject "$member" "$line"
  done < "$f"
  : > "$f"
  atmux::log "supervisor: drained queue for $member"
}

# SIGCHLD: identify any subscriber whose pid is no longer alive + respawn.
# Heartbeat + sweep loops aren't tracked here — if those die, the missing
# heartbeat file mtime surfaces via doctor; the sweep is best-effort.
_atmux_supervisor_on_sigchld() {
  local queue_dir="$1"
  local m pid
  for m in "${!_atmux_supervisor_pids[@]}"; do
    pid="${_atmux_supervisor_pids[$m]}"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      atmux::warn "supervisor: subscriber for $m (pid=$pid) died — respawning"
      _atmux_supervisor_spawn_subscriber "$m" "$queue_dir"
    fi
  done
}
