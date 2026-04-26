#!/usr/bin/env bash
# atmux reload <subcommand> [args]
#   brief-reload  <member> [--force]
#       Re-paste the role brief into <member>'s pane WITHOUT /clear — context
#       is preserved, the brief is appended as new input. A banner header
#       calls out the reload + timestamp so the agent treats it as an
#       authoritative update going forward, not part of the prior conversation.
#
#       Skips members whose pane shows a known blocker state (Compacting, queued
#       input, near-/at-limit, mid-thinking) unless --force is passed; sending
#       text in those states either gets dropped or merges with stale input.
#
#   config-reload
#       Re-read team.json + diff against the spawn-time snapshot
#       (.atmux/state/spawn-snapshot.json, written by `atmux start`). For each
#       member whose role/lane/model/tui changed, send a one-line ping into
#       the pane: `⚙️ CONFIG RELOAD by lead — your <field> <old>→<new>. Apply
#       on next dispatch.` Members with no delta are silent. NO respawn, NO
#       /clear, NO model swap exec — the worker adapts on next dispatch.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local sub="${1:-}"; shift || true
  case "$sub" in
    brief-reload)  _atmux_reload_brief "$@" ;;
    config-reload) _atmux_reload_config "$@" ;;
    "") atmux::die "reload: missing subcommand (use brief-reload <member> | config-reload)" ;;
    *)  atmux::die "reload: unknown subcommand: $sub (use brief-reload | config-reload)" ;;
  esac
}

# Blocker patterns we refuse to paste into without --force.
# Pane-state strings that mean "this agent isn't ready to absorb new input."
_atmux_reload_detect_blocker() {
  local state="$1"
  if echo "$state" | grep -qi 'Compacting conversation';            then echo "compacting"; return; fi
  if echo "$state" | grep -qi 'Press up to edit queued messages';   then echo "queued-input"; return; fi
  if echo "$state" | grep -qi 'approaching usage limit';            then echo "approaching-limit"; return; fi
  if echo "$state" | grep -qi 'hit your limit\|rate.?limit';        then echo "rate-limited"; return; fi
  if echo "$state" | grep -qi 'thinking with';                       then echo "thinking"; return; fi
  echo ""
}

_atmux_reload_brief() {
  local member="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=1; shift ;;
      -*) atmux::die "reload brief-reload: unknown flag: $1" ;;
      *)
        if [[ -z "$member" ]]; then member="$1"; shift
        else atmux::die "reload brief-reload: too many args"; fi ;;
    esac
  done
  [[ -n "$member" ]] || atmux::die "reload brief-reload: <member> required"

  atmux::tmux_window_exists "$member" \
    || atmux::die "reload: no tmux window for $member"

  local state; state="$(atmux::capture_pane "$member" 30)"
  local blocker; blocker="$(_atmux_reload_detect_blocker "$state")"
  if [[ -n "$blocker" && "$force" -ne 1 ]]; then
    atmux::log "reload: skipping $member (state=$blocker) — pass --force to override"
    return 1
  fi

  local mj; mj="$(atmux::member_json "$member")"
  local role; role="$(jq -r '.role // "member"' <<<"$mj")"
  local brief; brief="$(atmux::brief_path "$role")"
  [[ -f "$brief" ]] || atmux::die "reload: no brief at $brief for role=$role"

  local target; target="$(atmux::tmux_target "$member")"
  local tmp; tmp="$(atmux::tmp_path brief-reload md)"
  local hhmm; hhmm="$(atmux::now_myt)"
  {
    printf '📨 BRIEF RELOAD by lead at %s — apply going forward, your context is preserved\n\n' "$hhmm"
    atmux::render_brief "$member" "$role" "$brief"
  } > "$tmp"

  local buf="atmux_brief_reload_${member}"
  tmux load-buffer -b "$buf" "$tmp"
  tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
    || tmux paste-buffer -b "$buf" -t "$target"
  sleep 1
  tmux send-keys -t "$target" Enter
  rm -f "$tmp"

  atmux::record_brief_version "$member" "$role"
  atmux::ok "reloaded brief for $member"
}

# Diff team.json against the spawn-time snapshot (.atmux/state/spawn-snapshot.json,
# written by lib/start.sh) and ping members whose role/lane/model/tui changed.
# Members ADDED post-spawn are silently skipped — atmux start handles their
# initial brief; config-reload only flags drift on already-spawned members.
_atmux_reload_config() {
  [[ $# -eq 0 ]] || atmux::die "reload config-reload: takes no args"

  local snap; snap="$(atmux::state_dir)/spawn-snapshot.json"
  local tj; tj="$(atmux::team_json)"

  # E3/S1-followup t-8cb0f47b: pre-snapshot teams (started before lib/
  # start.sh learned to write spawn-snapshot.json) had no file on disk,
  # so config-reload was unusable without a destructive stop+start.
  # Self-heal: bootstrap the snapshot from the CURRENT team.json on
  # first run — establishing "now" as the baseline. The first call
  # always reports zero drift (since snap == team.json by definition);
  # subsequent edits diff cleanly. One-time '📸' notice marks the
  # bootstrap so a curious operator can grep the log.
  if [[ ! -f "$snap" ]]; then
    mkdir -p "$(dirname "$snap")"
    jq '{members: [.members[] | {name, role: (.role // "member"),
                                  lane: (.lane // "misc"),
                                  model: (.model // "default"),
                                  tui:   (.tui   // "claude")}]}' \
      "$tj" > "$snap"
    atmux::log "📸 spawn-snapshot bootstrapped for legacy team — baseline established at $snap"
  fi

  # Build the per-member delta as TSV: name<tab>delta-message. Empty delta
  # rows skipped at emit time. Fields tracked: role, lane, model, tui.
  local notified=0 unchanged=0
  local m; while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local old; old=$(jq -c --arg n "$m" '.members[]? | select(.name == $n)' "$snap")
    if [[ -z "$old" ]]; then
      # New member added since spawn — start.sh handles their initial brief;
      # nothing to diff against.
      continue
    fi
    local new; new=$(jq -c --arg n "$m" '.members[]? | select(.name == $n)' "$tj")

    local delta=""
    local field
    for field in role lane model tui; do
      local o n
      o=$(jq -r --arg f "$field" '.[$f] // ""' <<<"$old")
      n=$(jq -r --arg f "$field" '.[$f] // ""' <<<"$new")
      if [[ "$o" != "$n" ]]; then
        if [[ -n "$delta" ]]; then
          delta="$delta, $field $o→$n"
        else
          delta="$field $o→$n"
        fi
      fi
    done

    if [[ -z "$delta" ]]; then
      unchanged=$((unchanged + 1))
      continue
    fi

    if atmux::tmux_window_exists "$m"; then
      local target; target="$(atmux::tmux_target "$m")"
      tmux send-keys -t "$target" \
        "⚙️ CONFIG RELOAD by lead — your $delta. Apply on next dispatch." Enter
      notified=$((notified + 1))
      atmux::log "config-reload: $m — $delta"
    fi
  done < <(jq -r '.members[]?.name' "$tj")

  atmux::ok "config-reload: $notified member(s) notified, $unchanged unchanged"
}
