#!/usr/bin/env bash
# atmux super-tell <team> <member> <msg...>
#
# Cross-team driver-style channel for the superdriver (ADR-025 §super-tell,
# Phase 1). Resolves <team> via the fleet registry, appends the ask to the
# target's .atmux/driver-inbox.md (audit trail — same surface a regular
# driver in that project would write), and tmux send-keys a heads-up to
# <member>'s pane in the target team's session.
#
# <member> is a literal pane name OR the sentinel `lead`, which resolves to
# the team-lead member declared in the target's .atmux/team.json (matches
# atmux::tell-lead's lookup chain: role=team-lead first, name='lead' fall-
# back).
#
# Pane-state preflight (OQ G4): refuse on `thinking with` / `Compacting
# conversation` / `Press up to edit queued messages`. The driver retries
# once the pane clears — queueing risks merging the ask with whatever the
# target was about to submit.
#
# NO bypass — every super-tell flows through the same durable inbox+pane
# chain a regular driver would use inside the target project. The audit
# trail per-team is the load-bearing invariant for cross-team coordination.

main() {
  atmux::require jq tmux

  local team="${1:-}"
  local member="${2:-}"
  if (( $# >= 2 )); then shift 2; else shift "$#"; fi
  local msg="$*"

  [[ -n "$team"   ]] || atmux::die "usage: atmux super-tell <team> <member> <msg...>"
  [[ -n "$member" ]] || atmux::die "usage: atmux super-tell <team> <member> <msg...>"
  [[ -n "$msg"    ]] || atmux::die "empty message — usage: atmux super-tell <team> <member> <msg...>"

  # Lazy-source registry helpers (mirrors super-status.sh pattern).
  if ! declare -F atmux::registry_path >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi

  local entry
  entry="$(atmux::registry_list --json \
    | jq -c --arg name "$team" 'first(.[] | select(.name == $name)) // empty')"
  if [[ -z "$entry" ]]; then
    atmux::die "super-tell: team '$team' not in registry — run 'atmux super-status --prune' to clean stale entries, or 'atmux init' inside the target project"
  fi

  local status; status="$(jq -r '.status // "?"' <<<"$entry")"
  if [[ "$status" != "running" ]]; then
    atmux::die "super-tell: team '$team' status=$status — run 'atmux super-status --prune' (registry needs reconciliation)"
  fi

  local proot; proot="$(jq -r '.projectRoot' <<<"$entry")"
  local sess;  sess="$( jq -r '.sessionName // empty' <<<"$entry")"
  [[ -d "$proot" ]] || atmux::die "super-tell: projectRoot '$proot' missing on disk — run 'atmux super-status --prune'"
  [[ -n "$sess"  ]] || atmux::die "super-tell: team '$team' has no sessionName in registry"

  # Resolve the target member. `lead` is the documented sentinel — read the
  # target's team.json for the team-lead role, falling back to a member
  # literally named 'lead' (matches atmux::tell-lead's lookup chain).
  local target_member="$member"
  if [[ "$member" == "lead" ]]; then
    local tj="$proot/.atmux/team.json"
    [[ -f "$tj" ]] || atmux::die "super-tell: $tj missing (target not initialised?)"
    target_member="$(jq -r '
      first(.members[]? | select(.role == "team-lead") | .name)
      // first(.members[]? | select(.name == "lead") | .name)
      // empty
    ' "$tj")"
    [[ -n "$target_member" ]] || atmux::die "super-tell: no team-lead in $tj (need a member with role=team-lead, or named 'lead')"
  fi

  # Window name follows ADR-030: __<team>__<emoji><member> when registry
  # has a stable emoji for the member, else the bare __<team>__<member>.
  local emoji
  emoji="$(jq -r --arg m "$target_member" '
    .members // [] | (first(.[] | select(.name == $m)) | .emoji // "") // ""
  ' <<<"$entry")"
  local win
  if [[ -n "$emoji" && "$emoji" != "null" ]]; then
    win="__${team}__${emoji}${target_member}"
  else
    win="__${team}__${target_member}"
  fi
  local target="${sess}:${win}"

  # Honor target team's tmuxTmpdir if set (multi-team isolation pattern
  # already used by super-status liveness checks).
  local tmpdir=""
  if [[ -f "$proot/.atmux/team.json" ]]; then
    tmpdir="$(jq -r '.tmuxTmpdir // empty' "$proot/.atmux/team.json" 2>/dev/null)"
  fi
  local _tmux=(tmux)
  if [[ -n "$tmpdir" ]]; then
    _tmux=(env "TMUX_TMPDIR=$tmpdir" tmux)
  fi

  "${_tmux[@]}" has-session -t "=$sess" 2>/dev/null \
    || atmux::die "super-tell: tmux session '$sess' missing for team '$team' — run 'atmux super-status --prune'"

  # Audit trail FIRST — append to target's driver-inbox.md BEFORE any
  # pane-state preflight. README:688 contract: "the ask is never lost".
  # Pre-fix, a busy-pane refuse atmux::die'd before this write, dropping
  # the ask. Now both pane-busy refuses AND send-keys failures leave a
  # durable record (typo'd window names also get logged so the operator
  # can clean up later — see preflight branch below).
  local di="$proot/.atmux/driver-inbox.md"
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
  printf -- '- [%s] (super-tell → %s) %s\n' "$(atmux::now_myt)" "$target_member" "$msg" >> "$di"

  # Pane-state preflight — refuse-don't-queue per OQ G4. Mirrors send.sh's
  # readiness markers but escalates to die rather than warn-then-paste:
  # cross-team channel can't tolerate a merged-with-queued-message edge
  # case (the recipient lacks the local context to spot it).
  local pane_state
  pane_state="$("${_tmux[@]}" capture-pane -p -S -40 -t "$target" 2>/dev/null || true)"
  if [[ -z "$pane_state" ]]; then
    # Empty capture is ambiguous: freshly-spawned windows are bytewise
    # empty for ~100ms before their shell renders a prompt. Distinguish
    # window-exists-but-unrendered (soft path: proceed; send-keys works
    # on empty windows too) from window-truly-missing (hard die).
    local windows
    windows="$("${_tmux[@]}" list-windows -t "=$sess" -F '#{window_name}' 2>/dev/null || true)"
    if ! grep -qx -F -- "$win" <<<"$windows"; then
      atmux::die "super-tell: no such window '$win' in session '$sess' (typo or stale registry — entry left in $di for cleanup)"
    fi
    # Window exists, content unrendered. Skip the busy-pane grep (empty
    # content can't match the markers) and continue to send-keys.
  elif echo "$pane_state" | grep -Eiq 'thinking with|Compacting conversation|Press up to edit queued messages'; then
    atmux::die "super-tell: target '$target_member' pane busy (thinking/compacting/queued) — retry once it clears (audit: $di)"
  fi

  # Heads-up paste. Short by design — the durable detail lives in
  # driver-inbox.md (just appended above); the pane-side message is just
  # the wake signal. Mirrors lib/tell.sh's truncation shape.
  local heads_up truncated=""
  [[ ${#msg} -gt 80 ]] && truncated="…"
  heads_up="📬 super-tell → ${target_member}: ${msg:0:80}${truncated}"
  local tmp; tmp="$(mktemp -t atmux-super-tell.XXXXXX)"
  printf '%s' "$heads_up" > "$tmp"
  local buf="atmux_supertell_$$_${RANDOM}"
  "${_tmux[@]}" load-buffer -b "$buf" "$tmp"
  "${_tmux[@]}" paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
    || "${_tmux[@]}" paste-buffer -b "$buf" -t "$target"
  rm -f "$tmp"
  sleep 0.3
  "${_tmux[@]}" send-keys -t "$target" Enter

  atmux::ok "super-tell → $team/$target_member (audit: $di)"
}
