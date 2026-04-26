#!/usr/bin/env bash
# atmux send <member> <msg...>
# atmux broadcast <msg...>   (invoked via --broadcast)
#
# Sends text into a member's TUI pane via tmux send-keys.
# Pattern: capture-pane first (per CLAUDE.md rule: read pane state BEFORE send),
# refuse if pane looks un-ready, else load-buffer + paste + Enter.

main() {
  atmux::require tmux jq
  atmux::require_team

  local broadcast=0
  local skip_driver=1
  local no_submit=0
  local verify=1

  if [[ "${1:-}" == "--broadcast" ]]; then
    broadcast=1
    shift
  fi

  # Parse optional flags.
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --include-driver) skip_driver=0; shift ;;
      --no-submit)      no_submit=1; shift ;;
      --no-verify)      verify=0; shift ;;
      --) shift; break ;;
      -*) atmux::die "send: unknown flag: $1" ;;
      *) break ;;
    esac
  done

  local target_member=""
  if [[ "$broadcast" -ne 1 ]]; then
    target_member="${1:-}"
    shift || true
    [[ -n "$target_member" ]] || atmux::die "usage: atmux send <member> <msg...>"
  fi

  local msg="$*"
  [[ -n "$msg" ]] || atmux::die "empty message — usage: atmux send <member> <msg...>"

  if [[ "$broadcast" -eq 1 ]]; then
    local names; names="$(atmux::members_names)"
    while IFS= read -r m; do
      [[ -z "$m" ]] && continue
      if [[ "$skip_driver" -eq 1 && "$m" == "driver" ]]; then continue; fi
      atmux::send_to_member "$m" "$msg" "$no_submit" "$verify" || atmux::warn "send to $m failed"
    done <<< "$names"
  else
    atmux::send_to_member "$target_member" "$msg" "$no_submit" "$verify"
  fi
}

# atmux::send_to_member <member> <msg> <no_submit:0|1> <verify:0|1>
atmux::send_to_member() {
  local member="$1" msg="$2" no_submit="${3:-0}" verify="${4:-1}"

  atmux::tmux_window_exists "$member" \
    || atmux::die "no tmux window for $member (is the team running?)"

  local target; target="$(atmux::tmux_target "$member")"

  # ---- Read pane state first ----
  local state; state="$(atmux::capture_pane "$member" 40)"
  local last_line; last_line="$(echo "$state" | grep -v '^[[:space:]]*$' | tail -1 || true)"

  # Heuristic not-ready markers — surface a warning but don't hard-refuse.
  # (Hard-refusal is too brittle across TUI prompt styles.)
  if echo "$state" | grep -Eiq 'Compacting conversation|Press up to edit queued messages|Now using extra usage|hit your limit|rate.?limit'; then
    atmux::warn "$member: pane may not be ready — proceeding anyway; re-check after send"
  fi

  # ---- Write msg to tmp file, load-buffer + paste ----
  local tmp; tmp="$(atmux::tmp_path msg)"
  # Single trailing newline after the body; we submit with Enter separately.
  printf '%s' "$msg" > "$tmp"

  local buf="atmux_msg_$$_${RANDOM}"
  tmux load-buffer -b "$buf" "$tmp"
  # -d deletes after paste; some tmux variants don't support it silently.
  tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
    || tmux paste-buffer -b "$buf" -t "$target"
  rm -f "$tmp"

  if [[ "$no_submit" -eq 1 ]]; then
    atmux::ok "send: queued msg in $member (not submitted)"
    return 0
  fi

  # A brief pause, then submit.
  sleep 0.3
  tmux send-keys -t "$target" Enter

  _atmux_log_send "$member" "$msg"

  if [[ "$verify" -eq 1 ]]; then
    sleep 2
    local post; post="$(atmux::capture_pane "$member" 10)"
    # A soft verification: if the pane's last prompt still shows the raw msg
    # snippet, assume not consumed. Best-effort only.
    local snippet; snippet="$(printf '%s' "$msg" | head -c 50)"
    if echo "$post" | tail -3 | grep -qF "$snippet" && echo "$post" | tail -1 | grep -qE '^\s*[❯>›$#]'; then
      atmux::warn "send: $member may not have consumed the message — check the pane"
      return 2
    fi
  fi
  atmux::ok "send → $member"
}

_atmux_log_send() {
  local member="$1" msg="$2"
  local logf; logf="$(atmux::logs_dir)/send-$member.log"
  mkdir -p "$(dirname "$logf")"
  {
    printf '[%s] sent:\n' "$(atmux::now_iso)"
    printf '%s\n' "$msg" | sed 's/^/  | /'
    printf '\n'
  } >> "$logf"
}
