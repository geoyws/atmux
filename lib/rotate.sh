#!/usr/bin/env bash
# atmux rotate <member> [--force]    — send /clear to member, re-paste brief
# atmux rotate-lead [--force]         — routes here via `--lead` flag
#
# For Claude Code panes: uses its `/clear` slash-command. For other TUIs,
# this is a best-effort — most OpenCode/Kimi/Cursor setups don't expose an
# equivalent mid-session reset, so we warn and exit non-fatally.
#
# Pre-flight: read the pane state and abort if a blocker banner is
# visible (mid-turn / queued input / compacting / rate-limited). Sending
# `/clear` into any of those states either: drops the in-flight work
# silently, merges with stale queued input, or no-ops while still
# stamping rotated.epoch (so whip's auto-rotation thinks the rotation
# succeeded and re-fires next tick). --force overrides for operators
# who know what they're doing.
#
# Per CLAUDE.md "Always read pane state BEFORE `tmux send-keys`" —
# rotate.sh historically violated this for the lead-uptime auto-rotate
# path, leading to mid-turn /clear surprises and race-y interactions
# with banner-driven AUTO-PRECLEAR (which DOES check banners).

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local target_kind=""
  local member=""
  local force=0
  if [[ "${1:-}" == "--lead" ]]; then
    target_kind="lead"
    shift
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=1; shift ;;
      -*) atmux::die "rotate: unknown flag: $1" ;;
      *)
        if [[ -z "$member" ]]; then member="$1"; shift
        else atmux::die "rotate: too many args"; fi ;;
    esac
  done

  if [[ "$target_kind" == "lead" ]]; then
    member="$(atmux::find_lead_member)"
    [[ -n "$member" ]] || atmux::die "rotate-lead: no team-lead defined in team.json"
  fi
  [[ -n "$member" ]] || atmux::die "usage: atmux rotate <member> [--force]  |  atmux rotate-lead [--force]"

  local mj; mj="$(atmux::member_json "$member")"
  local tui role cwd
  tui="$(jq -r '.tui // "claude"' <<<"$mj")"
  role="$(jq -r '.role // "member"' <<<"$mj")"
  cwd="$(jq -r '.cwd // "."' <<<"$mj")"

  atmux::tmux_window_exists "$member" \
    || atmux::die "no tmux window for $member"

  local target; target="$(atmux::tmux_target "$member")"

  # Pre-flight pane-state check. Runs for ALL TUIs — the blocker
  # patterns (`thinking with`, `Press up to edit queued messages`) are
  # specific enough that they don't appear in legitimate non-claude
  # scrollback, so the check is a safe no-op for shell/opencode/kimi
  # panes. --force overrides unconditionally.
  if [[ "$force" -ne 1 ]]; then
    local state blocker
    state="$(atmux::capture_pane "$member" 30)"
    blocker="$(_atmux_rotate_detect_blocker "$state")"
    if [[ -n "$blocker" ]]; then
      atmux::warn "rotate: $member has $blocker — skipping (use --force to rotate anyway)"
      # Exit non-zero so whip's autoRotate gate records this as a failed
      # rotation attempt and emits the "auto-rotate attempted but failed"
      # finding rather than the success finding. The rotated.epoch is
      # NOT stamped, so the next tick will re-attempt — debounce on the
      # caller's side handles cooldown if needed.
      return 1
    fi
  fi

  case "$tui" in
    claude)
      tmux send-keys -t "$target" "/clear" Enter
      sleep 2
      ;;
    *)
      atmux::warn "rotate: tui=$tui has no /clear equivalent — will re-paste brief only"
      ;;
  esac

  local brief; brief="$(atmux::brief_path "$role")"
  if [[ -f "$brief" ]]; then
    local tmp; tmp="$(mktemp /tmp/atmux-brief-XXXXXX.md)"
    atmux::render_brief "$member" "$role" "$brief" > "$tmp"
    local buf="atmux_brief_rot_${member}"
    tmux load-buffer -b "$buf" "$tmp"
    tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
      || tmux paste-buffer -b "$buf" -t "$target"
    sleep 1
    tmux send-keys -t "$target" Enter
    rm -f "$tmp"
    atmux::record_brief_version "$member" "$role"
  fi

  atmux::ok "rotated $member (role=$role, tui=$tui)"

  # Stamp rotation epoch — whip's auto-rotation logic (E2/S2) reads this to
  # decide when next to rotate. Both the claude /clear path and the non-claude
  # warning path land here, so a successful warn-and-rebrief still updates the
  # epoch (the rotate verb succeeded; auto-rotation should respect it).
  # Format mirrors session-start.txt: single epoch integer + trailing newline.
  local state_dir; state_dir="$(atmux::state_dir)"
  mkdir -p "$state_dir"
  atmux::now_epoch > "$state_dir/${member}-rotated.epoch"
}

# Pane-state blocker detector. NARROWER than reload.sh's equivalent —
# the rate-limit / approaching-limit / compacting banners are REASONS
# whip's AUTO-PRECLEAR path triggers rotation in the first place
# (lib/whip.sh:157), so blocking on those would break the very feature
# the rotation supports. We block only on states where rotation would
# DESTROY user-visible work:
#
#   - mid-turn   — Claude is actively running a tool / thinking; /clear
#                  drops the in-flight turn + any partial output.
#   - queued-input — operator typed text but hasn't submitted yet;
#                  /clear discards the pending message.
#
# rate-limit / approaching-limit / compacting banners are intentionally
# rotation-eligible (the whole point is to start a fresh window). This
# split is the difference between "would rotation help?" (yes for
# limit/compaction banners) and "would rotation lose work?" (yes for
# mid-turn / queued).
_atmux_rotate_detect_blocker() {
  local state="$1"
  if echo "$state" | grep -qi 'Press up to edit queued messages';        then echo "queued-input"; return; fi
  if echo "$state" | grep -qi 'Esc to interrupt\|tokens · esc to interrupt\|thinking with'; then echo "mid-turn"; return; fi
  echo ""
}

