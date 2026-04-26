#!/usr/bin/env bash
# atmux migrate-to-driver-session [<team>]
#
# Phase 2 of single-session topology (ADR-016). Forward-only migration:
# move every team window from the dedicated `atmux-<team>` session into
# the driver's currently-attached tmux session, preserving running TUI
# processes (Claude Code, opencode, etc.) via `tmux move-window`.
#
# Pre-flight pane-state precondition refuses on ANY in-flight signal:
# `thinking with` / `Compacting conversation` / queued-input / rate-limit
# / modal-prompt / non-empty compose buffer. Cleanup gate kills the (now
# empty) source session ONLY after verifying zero windows remain — a
# half-moved state never stamps singleSession=true, so the verb is safe
# to re-run after fixing a refusal.
#
# Idempotent: re-running on an already-migrated team is a no-op success.
# Reverse direction (single → dedicated) is intentionally out of scope —
# scope-defer per ADR-016 Open Question 3. Multi-team batching ('migrate
# ALL') is also out of scope — explicit per-team is safer; users wanting
# to migrate all run the verb per project root with --team-dir.

main() {
  atmux::require jq tmux
  atmux::require_team

  # ---- Arg parse ----
  local team_arg=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -*) atmux::die "migrate-to-driver-session: unknown flag: $1" ;;
      *)
        if [[ -z "$team_arg" ]]; then team_arg="$1"; shift
        else atmux::die "migrate-to-driver-session: too many args"; fi ;;
    esac
  done

  local team; team="$(atmux::team_name)"
  if [[ -n "$team_arg" && "$team_arg" != "$team" ]]; then
    atmux::die "migrate-to-driver-session: <team> arg '$team_arg' does not match resolved team '$team' from $(atmux::team_json) (use --team-dir <dir> to target a different team)"
  fi

  # ---- $TMUX precondition ----
  [[ -n "${TMUX:-}" ]] || atmux::die "migrate-to-driver-session: must run from inside driver tmux (\$TMUX is unset)"

  # ---- Idempotency ----
  local single state_file
  single="$(jq -r '.singleSession // false' "$(atmux::team_json)" 2>/dev/null || echo false)"
  state_file="$(atmux::dir)/state/session.txt"
  if [[ "$single" == "true" && -f "$state_file" ]]; then
    atmux::ok "already migrated: team '$team' is in single-session mode (driver=$(cat "$state_file"))"
    return 0
  fi

  # ---- Resolve source + driver sessions ----
  # IMPORTANT: capture src_session BEFORE writing state/session.txt — once
  # that file exists, atmux::session_name flips to the driver session and
  # we'd lose the handle to the dedicated source.
  local src_session="atmux-$team"

  local driver_session
  driver_session="$(tmux display-message -p '#S' 2>/dev/null || true)"
  [[ -n "$driver_session" ]] || atmux::die "migrate-to-driver-session: tmux display-message returned empty session name"

  if [[ "$src_session" == "$driver_session" ]]; then
    atmux::die "migrate-to-driver-session: source session '$src_session' IS the driver session — already running under single-session topology? Set team.json:.singleSession=true and run 'atmux start' to seed state/session.txt"
  fi

  if ! tmux has-session -t "$src_session" 2>/dev/null; then
    atmux::die "migrate-to-driver-session: source session '$src_session' does not exist — nothing to migrate (was the team ever started?)"
  fi

  # ---- Pre-flight pane-state check (NON-NEGOTIABLE) ----
  # Run across EVERY window in the source session (not just team members),
  # so stragglers from removed members or operator-spawned debug windows
  # also gate the migration. The verify-zero step below depends on us
  # moving every window, so the pre-flight scope must match.
  local src_windows
  src_windows="$(tmux list-windows -t "$src_session" -F '#{window_name}' 2>/dev/null || true)"
  [[ -n "$src_windows" ]] || atmux::die "migrate-to-driver-session: source session '$src_session' has no windows (already empty?) — kill it manually with 'tmux kill-session -t $src_session' if appropriate"

  local refusals=""
  while IFS= read -r win; do
    [[ -z "$win" ]] && continue
    local pane reason
    pane="$(tmux capture-pane -p -S -50 -t "$src_session:$win" 2>/dev/null || true)"
    reason="$(_atmux_migrate_detect_blocker "$pane")"
    if [[ -n "$reason" ]]; then
      refusals+=$'\n'"  · $win: $reason"
    fi
  done <<<"$src_windows"

  if [[ -n "$refusals" ]]; then
    printf '%s\n' "migrate-to-driver-session: refusing — pane(s) not idle:$refusals" >&2
    atmux::die "wait for the pane(s) to clear (turn to land, compaction to finish, queued input to submit, modal to resolve, draft to send), then re-run"
  fi

  # ---- Move per-window ----
  # Window-name mapping:
  #  - `__atmux__home` (legacy buggy literal-prefix from pre-Sa starts) ⇒
  #    rename to `__<team>__home` per Sa's window-naming convention.
  #  - everything else ⇒ keep the name as-is (the `__<team>__*` prefix
  #    already encodes the team, so collisions in the shared driver
  #    session are avoided).
  # On any move-window failure: atmux::die WITHOUT cleaning up the
  # already-moved windows or stamping singleSession — partial state is
  # inspectable + recoverable. The user can either move the stragglers
  # back manually or fix the root cause and re-run (idempotent on the
  # already-moved subset because tmux move-window errors when the dest
  # name collides — but our pre-flight ensures clean source names).
  local target_home; target_home="$(printf '__%s__home' "$team")"
  local moved=0 home_renamed=0
  while IFS= read -r win; do
    [[ -z "$win" ]] && continue
    local dest="$win"
    if [[ "$win" == "__atmux__home" && "$team" != "atmux" ]]; then
      dest="$target_home"
      home_renamed=1
    fi
    if tmux move-window -s "$src_session:$win" -t "$driver_session:$dest" 2>/dev/null; then
      if [[ "$win" != "$dest" ]]; then
        atmux::log "  · moved + renamed: $src_session:$win → $driver_session:$dest"
      else
        atmux::log "  · moved: $src_session:$win → $driver_session:$dest"
      fi
      moved=$((moved + 1))
    else
      atmux::die "migrate-to-driver-session: failed to move '$win' ($src_session → $driver_session) — aborting. $moved window(s) already moved into '$driver_session'; '$src_session' still holds the rest. Inspect with: tmux list-windows -t '$src_session'"
    fi
  done <<<"$src_windows"

  # ---- Verify zero windows remain in src_session ----
  # tmux list-windows on a dead/empty session returns non-zero + empty
  # output. Both cases are "0 remaining" for our purposes; we only refuse
  # when there's a positive count of windows still attached.
  local remaining
  remaining="$(tmux list-windows -t "$src_session" -F '#{window_name}' 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$remaining" =~ ^[0-9]+$ ]] || remaining=0
  if (( remaining != 0 )); then
    atmux::die "migrate-to-driver-session: $remaining window(s) still in source session '$src_session' after move — refusing cleanup. Inspect with: tmux list-windows -t '$src_session'"
  fi

  # ---- Cleanup gate: kill the (verified empty) source session ----
  # tmux auto-destroys sessions when their last window is killed/moved,
  # so kill-session here is often a no-op — that's fine; the warn-level
  # log keeps the output honest about which path landed.
  if tmux has-session -t "$src_session" 2>/dev/null; then
    tmux kill-session -t "$src_session" 2>/dev/null \
      || atmux::warn "migrate-to-driver-session: kill-session '$src_session' returned non-zero (already gone?)"
  fi

  # ---- State update ----
  # Write state/session.txt FIRST: atmux::session_name reads it directly,
  # so once on disk the topology is canonical for every subsequent verb
  # (whip, send, dispatch, etc.). Flip the team.json flag second — it's a
  # documentation/wizard-surface concern, not a runtime gate.
  mkdir -p "$(atmux::state_dir)"
  printf '%s\n' "$driver_session" > "$state_file"
  atmux::jq_update "$(atmux::team_json)" '.singleSession = true'

  local detail="$moved window(s)"
  [[ "$home_renamed" -eq 1 ]] && detail+=" (home renamed __atmux__home → $target_home)"
  atmux::ok "migrated $detail from '$src_session' to '$driver_session'; '$src_session' session removed"
}

# Pane-state blocker detector — STRICTER than rotate.sh's
# `_atmux_rotate_detect_blocker` (lib/rotate.sh:113) and reload.sh's
# `_atmux_reload_detect_blocker` (lib/reload.sh:39). Migrate is a one-shot
# topology mutation; rotate is the in-place /clear that responds to
# compacting/limit banners, so rotate intentionally treats those as
# rotation-eligible (not blockers). Migrate has no such coupling — it
# refuses on every in-flight signal including those banners, plus modal
# prompts and non-empty compose buffers that the other two skip.
_atmux_migrate_detect_blocker() {
  local state="$1"
  if echo "$state" | grep -qi 'thinking with';                                then echo "thinking";          return; fi
  if echo "$state" | grep -qi 'Compacting conversation';                      then echo "compacting";        return; fi
  if echo "$state" | grep -qi 'Press up to edit queued messages';             then echo "queued-input";      return; fi
  if echo "$state" | grep -qi 'approaching usage limit';                      then echo "approaching-limit"; return; fi
  if echo "$state" | grep -qi 'hit your limit\|rate.\?limit\|limit reached';  then echo "rate-limited";      return; fi
  if echo "$state" | grep -qE 'Do you want to|^[[:space:]]*\[y/n\]:?|Allow this command\?'; then echo "modal-prompt"; return; fi

  # Non-empty compose buffer detection. Claude Code renders the input box
  # as a vertical-bar-bounded line: `│ > <text>          │` (with `│` =
  # U+2502 BOX DRAWINGS LIGHT VERTICAL). An idle box has only whitespace
  # between the `>` and the trailing `│`; any non-whitespace there means
  # an unsubmitted draft. awk isolates the inside-box span per line,
  # checks for non-whitespace, and emits a sentinel on the first hit.
  #
  # Placeholder text (e.g. `Try "fix the bug"`) is intentionally treated
  # AS a draft for refuse-purposes — the operator can dismiss the
  # placeholder by sending an Enter or escape before retrying migration.
  # Erring on the side of refusal is correct here: a false-positive at
  # most prompts a redo, while a false-negative could lose work.
  if awk '
    /│[[:space:]]*>/ {
      line = $0
      sub(/^.*│[[:space:]]*>[[:space:]]*/, "", line)
      sub(/[[:space:]]*│.*$/, "", line)
      if (length(line) > 0) { print "draft"; exit 0 }
    }
  ' <<<"$state" | grep -q draft; then
    echo "non-empty-compose"
    return
  fi

  echo ""
}
