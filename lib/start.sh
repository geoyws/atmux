#!/usr/bin/env bash
# atmux start [--force] [--doctor] [--no-doctor]
# Creates the team's tmux session and spawns every member's TUI in its own window.
# Driver (the user's own REPL) is NOT spawned — the driver is whoever runs atmux.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"

main() {
  atmux::require jq tmux
  atmux::require_team
  atmux::ensure_dirs

  local force=0
  local doctor_mode="preflight"  # preflight=silent check, verbose=full report, skip=off
  [[ -n "${ATMUX_DOCTOR_ON_START:-}" ]] && doctor_mode="verbose"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force|-f) force=1; shift ;;
      --doctor) doctor_mode="verbose"; shift ;;
      --no-doctor) doctor_mode="skip"; shift ;;
      *) atmux::die "start: unknown arg: $1" ;;
    esac
  done

  # ---- Preflight via doctor. On red, abort with a pointer. ----
  case "$doctor_mode" in
    verbose)
      if ! "$ATMUX_BIN_DIR/atmux" doctor; then
        atmux::die "preflight failed — fix the red items above, then re-run 'atmux start'"
      fi
      ;;
    preflight)
      if ! "$ATMUX_BIN_DIR/atmux" doctor --quiet; then
        atmux::die "preflight failed — run 'atmux doctor' to diagnose, or 'atmux start --no-doctor' to skip"
      fi
      ;;
    skip) : ;;
  esac

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  # ---- Live-lead guard (don't stomp an active session unless --force) ----
  if atmux::tmux_session_exists; then
    if [[ "$force" -ne 1 ]]; then
      atmux::warn "session $session already exists. Running start in incremental mode (existing windows kept)."
    else
      atmux::warn "force: killing existing session $session"
      tmux kill-session -t "$session" 2>/dev/null || true
    fi
  fi

  # ---- Create session if missing. A hidden __home window hosts the session. ----
  if ! atmux::tmux_session_exists; then
    tmux new-session -d -s "$session" -n "__atmux__home" -c "$PWD"
    atmux::ok "created tmux session: $session"
  fi

  # ---- Spawn each member ----
  local names; names="$(atmux::members_names)"
  local any_spawned=0
  while IFS= read -r member; do
    [[ -z "$member" ]] && continue
    if atmux::tmux_window_exists "$member"; then
      atmux::log "  · $member: window exists, skipping (use --force to reset)"
      continue
    fi
    _atmux_spawn_member "$member"
    any_spawned=1
  done <<< "$names"

  # ---- Close the placeholder __home window if members exist ----
  if [[ "$any_spawned" -eq 1 ]] && tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "__atmux__home"; then
    # only close home if there are other windows
    local wc; wc=$(tmux list-windows -t "$session" -F '#{window_name}' | grep -cv '^__atmux__home$' || true)
    if [[ "$wc" -gt 0 ]]; then
      tmux kill-window -t "$session:__atmux__home" 2>/dev/null || true
    fi
  fi

  # ---- Record start timestamp ----
  atmux::now_epoch > "$(atmux::state_dir)/session-start.txt"

  atmux::ok "team '$team' is up. attach with: atmux attach"
}

_atmux_spawn_member() {
  local member="$1"
  local mj; mj="$(atmux::member_json "$member")"
  local tui model cwd role
  tui="$(jq -r '.tui // "claude"' <<<"$mj")"
  model="$(jq -r '.model // "default"' <<<"$mj")"
  cwd="$(jq -r '.cwd // "."' <<<"$mj")"
  role="$(jq -r '.role // "member"' <<<"$mj")"

  local session win target
  session="$(atmux::session_name)"
  win="$(atmux::window_name "$member")"
  target="$session:$win"

  tmux new-window -d -t "$session" -n "$win" -c "$cwd"
  atmux::log "  · $member ($tui, role=$role): spawned window $win"

  # Ensure inbox file exists.
  local inbox="$(atmux::inbox_dir)/$member.json"
  [[ -f "$inbox" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$inbox"

  # Launch the TUI — pass the member JSON so tui.sh can honour per-member .command.
  local cmd; cmd="$(atmux::tui_cmd "$tui" "$model" "$cwd" "$member" "$role" "$mj")"
  tmux send-keys -t "$target" "$cmd" Enter

  # Let it come up (claude welcome screen, opencode load, etc.)
  local wait_s="${ATMUX_SPAWN_WAIT:-6}"
  sleep "$wait_s"

  # Paste the initial brief — but not for tui=shell (shells execute the brief
  # as commands and get wedged in heredoc state from backticks).
  if [[ "$tui" != "shell" ]]; then
    local brief; brief="$(atmux::brief_path "$role")"
    if [[ -f "$brief" ]]; then
      _atmux_paste_brief "$target" "$member" "$role" "$brief"
    fi
  fi
}

_atmux_paste_brief() {
  local target="$1" member="$2" role="$3" brief_path="$4"
  local tmp; tmp="$(mktemp /tmp/atmux-brief-XXXXXX.md)"
  atmux::render_brief "$member" "$role" "$brief_path" > "$tmp"

  local buf="atmux_brief_${member}"
  tmux load-buffer -b "$buf" "$tmp"
  tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null || tmux paste-buffer -b "$buf" -t "$target"
  sleep 1
  tmux send-keys -t "$target" Enter
  rm -f "$tmp"
}
