#!/usr/bin/env bash
# atmux tell-lead <msg...>
# Driver convenience:
#   1. Appends the ask to .atmux/driver-inbox.md (durable, greppable, survives /clear).
#   2. tmux send-keys "/heads-up driver-inbox has a new ask" to the lead's pane.
# Pattern mirrors the driver→lead routing in CLAUDE.md (file-based, not SendMessage).

# shellcheck source=send.sh
. "$ATMUX_LIB_DIR/send.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local msg="$*"
  [[ -n "$msg" ]] || atmux::die "usage: atmux tell-lead <msg...>"

  # Determine the "lead" member — the one with role=team-lead, else named 'lead'.
  local lead; lead="$(_atmux_find_lead)"
  [[ -n "$lead" ]] || atmux::die "no lead defined in team.json (need a member with role=team-lead)"

  # 1) Append to driver-inbox.md (create if missing).
  local di; di="$(atmux::driver_inbox)"
  mkdir -p "$(dirname "$di")"
  if [[ ! -f "$di" ]]; then
    cat > "$di" <<'EOF'
# Driver Inbox — driver asks for the lead

Lead reads this at the start of every whip turn. Mark each entry:
  ✅ done  ·  📤 delegated  ·  ⏳ in-progress  ·  ❌ rejected

Keep entries bulleted, terse, and timestamped. Move >24h entries to "## Archive".

## Open
EOF
  fi

  {
    printf -- '- [%s] %s\n' "$(atmux::now_myt)" "$msg"
  } >> "$di"

  # 2) Ping the lead with the heads-up (short, so the lead can still finish in-flight work).
  local heads_up="📬 driver-inbox has a new ask: ${msg:0:80}$([[ ${#msg} -gt 80 ]] && echo "…")"
  atmux::send_to_member "$lead" "$heads_up" 0 0

  atmux::ok "tell-lead → $lead (appended to $di)"
}

_atmux_find_lead() {
  atmux::require_team
  local n
  n="$(jq -r 'first(.members[] | select(.role == "team-lead") | .name) // empty' "$(atmux::team_json)")"
  if [[ -z "$n" ]]; then
    n="$(jq -r 'first(.members[] | select(.name == "lead") | .name) // empty' "$(atmux::team_json)")"
  fi
  printf '%s' "$n"
}
