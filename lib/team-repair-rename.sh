#!/usr/bin/env bash
# atmux team repair-rename [<team>] [--dry-run] [--force]
#
# Idempotent recovery verb for teams where `atmux team rename` mutated
# declarative names (team.json:.name + registry sessionName) but the
# imperative live world stayed on the old name. ADR-027's atomicity
# contract is incomplete; this verb is the recovery path until planner
# folds it back into rename's main flow (per ADDENDUM 11 / t-36ec8c01).
#
# Migrates 6 fields atomically per team:
#   1. mv <tmpdir> → /tmp/atmux_tmux_<team>     (cage socket dir)
#   2. tmux rename-session <old> → <team>       (cage internal session)
#   3. tmux rename-window __<old>__* → __<team>__*  (per-window prefixes)
#   4. team.json:.tmuxTmpdir                     (declarative)
#   5. cron block — atmux::cron_install replays from team.json
#   6. .atmux/state/session.txt                  (single-session state)
#
# Pane-preserving: cage tmpdir mv keeps the tmux server's socket fd valid
# across rename of the containing dir on Linux (verified). Window-rename
# + session-rename are tmux metadata ops; running TUIs in panes don't
# notice. New `tmux -S <new-path>` connections succeed; old paths fail.
#
# Idempotent: re-running on a converged team is no-op exit 0.
#
# Atomic per team: pre-state captured up front; partial failure rolls
# back in reverse order. Rollback log at .atmux/state/repair-rename-rollback.log.
#
# Convention choice: new tmpdir = /tmp/atmux_tmux_<team> (final form per
# ADDENDUM 11; transitional /tmp/atmux-tmux_<team> hyphen-form is dead).
#
# This verb is REUSED by the convention-wide sweep under the migrate-
# naming epic (t-36ec8c01) — every team where the basename hyphen→
# underscore needs flipping runs through this same code path.

# shellcheck source=registry.sh
. "$ATMUX_LIB_DIR/registry.sh"
# shellcheck source=cron.sh
. "$ATMUX_LIB_DIR/cron.sh"

main() {
  atmux::require jq tmux

  local target="" dry_run=0 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --force)   force=1;   shift ;;
      -h|--help) _atmux_team_repair_rename_usage; return 0 ;;
      -*) atmux::die "team repair-rename: unknown flag: $1" ;;
      *)
        if [[ -z "$target" ]]; then target="$1"; shift
        else atmux::die "team repair-rename: too many args"; fi ;;
    esac
  done

  # Auto-detect target via doctor-scan when no explicit team arg.
  if [[ -z "$target" ]]; then
    local detected; detected="$(_atmux_team_repair_rename_scan)"
    if [[ -z "$detected" ]]; then
      atmux::ok "team repair-rename: no drifted teams detected — fleet converged"
      return 0
    fi
    if [[ "$(wc -l <<<"$detected")" -gt 1 ]] && (( force == 0 )); then
      atmux::warn "team repair-rename: $(wc -l <<<"$detected") drifted teams detected:"
      while IFS= read -r t; do printf '  - %s\n' "$t" >&2; done <<<"$detected"
      atmux::die "team repair-rename: pass an explicit team or --force to repair all"
    fi
    while IFS= read -r t; do
      [[ -z "$t" ]] && continue
      _atmux_team_repair_rename_one "$t" "$dry_run" || return $?
    done <<<"$detected"
    return 0
  fi

  _atmux_team_repair_rename_one "$target" "$dry_run"
}

# Per-team scan: emit each drifted team-name to stdout, one per line.
# Drift signals (ANY one positive): tmpdir basename != team name OR cage
# internal session != team name OR any __OLD__* window prefix in the cage.
_atmux_team_repair_rename_scan() {
  local rj; rj="$(atmux::registry_list --json 2>/dev/null || echo '[]')"
  jq -e . <<<"$rj" >/dev/null 2>&1 || return 0
  local entry name proj
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    name="$(jq -r '.name'        <<<"$entry")"
    proj="$(jq -r '.projectRoot' <<<"$entry")"
    [[ -n "$name" && -n "$proj" ]] || continue
    local tj="$proj/.atmux/team.json"
    [[ -f "$tj" ]] || continue
    local tmpdir; tmpdir="$(jq -r '.tmuxTmpdir // ""' "$tj")"
    [[ -z "$tmpdir" || "$tmpdir" == "null" ]] && continue
    if _atmux_team_repair_rename_drift_check "$name" "$tmpdir"; then
      printf '%s\n' "$name"
    fi
  done < <(jq -c '.[]' <<<"$rj")
}

# Returns 0 if drift detected, 1 if converged. Args: <team> <tmpdir>.
_atmux_team_repair_rename_drift_check() {
  local team="$1" tmpdir="$2"
  local base; base="$(basename "$tmpdir")"
  # Convention forms — strip both hyphen-prefix and underscore-prefix
  # variants, leaving the team-derived suffix.
  local derived="${base#atmux-tmux-}"
  derived="${derived#atmux_tmux_}"
  derived="${derived#atmux-tmux_}"
  if [[ "$derived" != "$team" && "$base" != "atmux-tmux" ]]; then
    return 0  # tmpdir basename mismatch
  fi
  # Probe live cage if socket present.
  local sock="$tmpdir/tmux-0/default"
  [[ -S "$sock" ]] || return 1   # no live cage → nothing to repair on tmux side
  local sess
  sess="$(tmux -S "$sock" list-sessions -F '#{session_name}' 2>/dev/null | head -1)"
  if [[ -n "$sess" && "$sess" != "$team" ]]; then
    return 0  # session-name mismatch
  fi
  # Window-prefix scan — any window matching __<X>__* where X != team.
  local stale_count
  stale_count="$(tmux -S "$sock" list-windows -a -F '#{window_name}' 2>/dev/null \
    | grep -E '^__[a-z0-9_-]+__' | grep -v "^__${team}__" | wc -l | tr -d ' ')"
  [[ "$stale_count" =~ ^[0-9]+$ ]] || stale_count=0
  if (( stale_count > 0 )); then
    return 0
  fi
  return 1
}

_atmux_team_repair_rename_one() {
  local team="$1" dry_run="$2"

  # Resolve registry + project + team.json.
  local rj; rj="$(atmux::registry_list --json 2>/dev/null || echo '[]')"
  local entry; entry="$(jq -c --arg n "$team" 'first(.[] | select(.name == $n)) // empty' <<<"$rj")"
  [[ -n "$entry" ]] || atmux::die "team repair-rename: '$team' not in registry"
  local proj; proj="$(jq -r '.projectRoot' <<<"$entry")"
  [[ -d "$proj" ]] || atmux::die "team repair-rename: projectRoot '$proj' missing on disk"
  local tj="$proj/.atmux/team.json"
  [[ -f "$tj" ]] || atmux::die "team repair-rename: $tj missing"

  local declared; declared="$(jq -r '.name' "$tj")"
  [[ "$declared" == "$team" ]] || atmux::die "team repair-rename: team.json:.name='$declared' but registry says '$team' — fix declarative state first"
  local old_tmpdir; old_tmpdir="$(jq -r '.tmuxTmpdir // ""' "$tj")"
  [[ -n "$old_tmpdir" && "$old_tmpdir" != "null" ]] \
    || atmux::die "team repair-rename: $tj has no .tmuxTmpdir — not a cage-isolated team"

  # Compute target tmpdir per ADDENDUM 11 final form.
  local new_tmpdir="/tmp/atmux_tmux_$team"

  # Probe live cage state.
  local old_sock="$old_tmpdir/tmux-0/default"
  local cage_alive=0 old_sess="" stale_windows=()
  if [[ -S "$old_sock" ]]; then
    cage_alive=1
    old_sess="$(tmux -S "$old_sock" list-sessions -F '#{session_name}' 2>/dev/null | head -1)"
    while IFS= read -r w; do
      [[ -z "$w" ]] && continue
      [[ "$w" == "__${team}__"* ]] && continue   # already converged
      [[ "$w" =~ ^__[a-z0-9_-]+__ ]] && stale_windows+=("$w")
    done < <(tmux -S "$old_sock" list-windows -a -F '#{window_name}' 2>/dev/null)
  fi

  # State files.
  local state_file="$proj/.atmux/state/session.txt"
  local old_state_content=""
  [[ -f "$state_file" ]] && old_state_content="$(cat "$state_file")"

  # Convergence check — idempotent no-op.
  local needs_tmpdir_mv=0 needs_session_rename=0 needs_window_rename=0
  needs_tmpdir_mv=$([[ "$old_tmpdir" != "$new_tmpdir" ]] && echo 1 || echo 0)
  needs_session_rename=$([[ "$cage_alive" -eq 1 && -n "$old_sess" && "$old_sess" != "$team" ]] && echo 1 || echo 0)
  needs_window_rename=$([[ "${#stale_windows[@]}" -gt 0 ]] && echo 1 || echo 0)
  local needs_state_sync=0
  needs_state_sync=$([[ -n "$old_state_content" && "$old_state_content" != "$team" ]] && echo 1 || echo 0)

  if (( needs_tmpdir_mv + needs_session_rename + needs_window_rename + needs_state_sync == 0 )); then
    atmux::ok "team repair-rename: '$team' already converged — no-op"
    return 0
  fi

  # ---- Plan rendering (always; --dry-run stops here) ----
  printf '\n'
  printf '%s🩹 atmux team repair-rename — plan for "%s"%s\n' "$atmux_c_bld" "$team" "$atmux_c_rst" >&2
  printf '\n'
  if (( needs_tmpdir_mv )); then
    printf '  1. mv  %s → %s\n' "$old_tmpdir" "$new_tmpdir" >&2
  else
    printf '  1. tmpdir already at %s ✅\n' "$new_tmpdir" >&2
  fi
  if (( needs_session_rename )); then
    printf '  2. tmux rename-session  %s → %s  (on cage socket)\n' "$old_sess" "$team" >&2
  else
    [[ "$cage_alive" -eq 1 ]] && printf '  2. cage session already "%s" ✅\n' "$team" >&2 \
      || printf '  2. no live cage — session-rename skipped\n' >&2
  fi
  if (( needs_window_rename )); then
    printf '  3. tmux rename-window (%d window(s)):\n' "${#stale_windows[@]}" >&2
    local w new_w
    for w in "${stale_windows[@]}"; do
      new_w="$(_atmux_team_repair_rename_window_target "$w" "$team")"
      printf '       %s → %s\n' "$w" "$new_w" >&2
    done
  else
    printf '  3. no stale __<old>__* windows ✅\n' >&2
  fi
  printf '  4. team.json:.tmuxTmpdir = %s\n' "$new_tmpdir" >&2
  printf '  5. atmux::cron_install (rewrites cron block from team.json)\n' >&2
  if (( needs_state_sync )); then
    printf '  6. .atmux/state/session.txt: %s → %s\n' "$old_state_content" "$team" >&2
  else
    printf '  6. state/session.txt already "%s" ✅\n' "$team" >&2
  fi
  printf '\n'

  if (( dry_run == 1 )); then
    atmux::ok "team repair-rename: --dry-run — no changes applied"
    return 0
  fi

  # ---- Execute with rollback log ----
  local rollback_log="$proj/.atmux/state/repair-rename-rollback.log"
  mkdir -p "$(dirname "$rollback_log")"
  : > "$rollback_log"
  ATMUX_REPAIR_RENAME_ROLLBACK=()

  _atmux_team_repair_rename_log() { printf '[%s] %s\n' "$(atmux::now_iso)" "$*" >> "$rollback_log"; }
  _atmux_team_repair_rename_log "begin: team=$team old_tmpdir=$old_tmpdir new_tmpdir=$new_tmpdir old_sess=$old_sess windows=${#stale_windows[@]}"

  # Step 1: tmpdir mv. Must happen BEFORE tmux ops because tmux ops use
  # the new path. Linux: open fd to socket survives directory rename.
  if (( needs_tmpdir_mv )); then
    if [[ -e "$new_tmpdir" ]]; then
      atmux::die "team repair-rename: target $new_tmpdir already exists — refusing to clobber (manually inspect; --force does NOT override)"
    fi
    if ! mv "$old_tmpdir" "$new_tmpdir"; then
      atmux::die "team repair-rename: mv '$old_tmpdir' → '$new_tmpdir' failed — pre-state preserved"
    fi
    ATMUX_REPAIR_RENAME_ROLLBACK+=("tmpdir:$old_tmpdir:$new_tmpdir")
    _atmux_team_repair_rename_log "step1: mv $old_tmpdir → $new_tmpdir"
    atmux::ok "  · mv tmpdir → $new_tmpdir"
  fi

  local new_sock="$new_tmpdir/tmux-0/default"

  # Step 2: rename cage internal session. Must happen on NEW socket path.
  if (( needs_session_rename )); then
    if ! tmux -S "$new_sock" rename-session -t "=$old_sess" "$team" 2>/dev/null; then
      _atmux_team_repair_rename_rollback "$old_tmpdir" "$new_tmpdir" "$old_sess" "$team"
      atmux::die "team repair-rename: tmux rename-session '$old_sess' → '$team' failed — rolled back"
    fi
    ATMUX_REPAIR_RENAME_ROLLBACK+=("session:$new_sock:$old_sess:$team")
    _atmux_team_repair_rename_log "step2: tmux rename-session $old_sess → $team"
    atmux::ok "  · tmux rename-session $old_sess → $team"
  fi

  # Step 3: per-window rename.
  local renamed_windows=()
  if (( needs_window_rename )); then
    local w new_w wid
    for w in "${stale_windows[@]}"; do
      new_w="$(_atmux_team_repair_rename_window_target "$w" "$team")"
      # Use window-id form to address by literal-name, immune to prefix-match bugs.
      wid="$(tmux -S "$new_sock" list-windows -a -F '#{window_id} #{window_name}' 2>/dev/null \
              | awk -v w="$w" '$2 == w { print $1; exit }')"
      if [[ -z "$wid" ]]; then
        _atmux_team_repair_rename_rollback "$old_tmpdir" "$new_tmpdir" "$old_sess" "$team" "${renamed_windows[@]}"
        atmux::die "team repair-rename: window '$w' vanished mid-rename (cage racing?) — rolled back"
      fi
      if ! tmux -S "$new_sock" rename-window -t "$wid" "$new_w" 2>/dev/null; then
        _atmux_team_repair_rename_rollback "$old_tmpdir" "$new_tmpdir" "$old_sess" "$team" "${renamed_windows[@]}"
        atmux::die "team repair-rename: rename-window '$w' → '$new_w' failed — rolled back"
      fi
      renamed_windows+=("$wid:$w:$new_w")
      ATMUX_REPAIR_RENAME_ROLLBACK+=("window:$new_sock:$wid:$w:$new_w")
      _atmux_team_repair_rename_log "step3: rename-window $w → $new_w (wid=$wid)"
    done
    atmux::ok "  · renamed ${#renamed_windows[@]} windows"
  fi

  # Step 4: team.json:.tmuxTmpdir update. Use atmux::jq_update for flock + sanity.
  if ! ATMUX_DIR="$proj/.atmux" atmux::jq_update "$tj" \
       '.tmuxTmpdir = $p' --arg p "$new_tmpdir"; then
    _atmux_team_repair_rename_rollback "$old_tmpdir" "$new_tmpdir" "$old_sess" "$team" "${renamed_windows[@]}"
    atmux::die "team repair-rename: team.json:.tmuxTmpdir update failed — rolled back"
  fi
  ATMUX_REPAIR_RENAME_ROLLBACK+=("teamjson:$tj:$old_tmpdir")
  _atmux_team_repair_rename_log "step4: team.json:.tmuxTmpdir = $new_tmpdir (was $old_tmpdir)"
  atmux::ok "  · team.json:.tmuxTmpdir = $new_tmpdir"

  # Step 5: cron block re-install (replays from team.json — picks up new tmpdir).
  if [[ -z "${ATMUX_NO_CRON:-}" || "${ATMUX_NO_CRON:-}" == "0" ]]; then
    if command -v crontab >/dev/null 2>&1; then
      if ! atmux::cron_install "$team" "$proj/.atmux"; then
        _atmux_team_repair_rename_log "step5: cron_install $team FAILED (non-fatal — manual: atmux cron-install)"
        atmux::warn "  · cron_install failed — re-run manually with: ATMUX_DIR=$proj/.atmux atmux cron-install"
      else
        _atmux_team_repair_rename_log "step5: cron_install $team succeeded"
        atmux::ok "  · cron block rewritten"
      fi
    fi
  fi

  # Step 6: state/session.txt sync.
  if (( needs_state_sync )); then
    cp -p "$state_file" "$state_file.bak.$(atmux::now_epoch)" 2>/dev/null || true
    printf '%s\n' "$team" > "$state_file"
    ATMUX_REPAIR_RENAME_ROLLBACK+=("statetxt:$state_file:$old_state_content")
    _atmux_team_repair_rename_log "step6: state/session.txt = $team (was $old_state_content)"
    atmux::ok "  · state/session.txt = $team"
  fi

  _atmux_team_repair_rename_log "complete"
  atmux::ok "team repair-rename: '$team' converged"
}

# Map __OLD__<rest> → __<team>__<rest>. Preserves emoji + member name.
_atmux_team_repair_rename_window_target() {
  local win="$1" team="$2"
  # Strip leading __OLD__ (any [a-z0-9_-]+).
  local rest="${win#__*__}"
  printf '__%s__%s\n' "$team" "$rest"
}

# Reverse-walk the rollback stack. Best-effort — log every step.
_atmux_team_repair_rename_rollback() {
  local old_tmpdir="$1" new_tmpdir="$2" old_sess="$3" new_sess="$4"
  shift 4
  local renamed_windows=("$@")
  local i step tag rest
  for (( i=${#ATMUX_REPAIR_RENAME_ROLLBACK[@]}-1; i>=0; i-- )); do
    step="${ATMUX_REPAIR_RENAME_ROLLBACK[$i]}"
    tag="${step%%:*}"
    rest="${step#*:}"
    case "$tag" in
      tmpdir)
        local oldp="${rest%%:*}" newp="${rest#*:}"
        [[ -e "$newp" && ! -e "$oldp" ]] && mv "$newp" "$oldp" 2>/dev/null
        ;;
      session)
        local sock_part="${rest%%:*}" rest2="${rest#*:}"
        local op="${rest2%%:*}" np="${rest2#*:}"
        tmux -S "$sock_part" rename-session -t "=$np" "$op" 2>/dev/null || true
        ;;
      window)
        local sock_part="${rest%%:*}" rest2="${rest#*:}"
        local wid_part="${rest2%%:*}" rest3="${rest2#*:}"
        local oldn="${rest3%%:*}"
        tmux -S "$sock_part" rename-window -t "$wid_part" "$oldn" 2>/dev/null || true
        ;;
      teamjson)
        local tj_path="${rest%%:*}" old_tmpdir_val="${rest#*:}"
        ATMUX_DIR="$(dirname "$tj_path")" atmux::jq_update "$tj_path" \
          '.tmuxTmpdir = $p' --arg p "$old_tmpdir_val" 2>/dev/null || true
        ;;
      statetxt)
        local sf_path="${rest%%:*}" old_content="${rest#*:}"
        printf '%s\n' "$old_content" > "$sf_path" 2>/dev/null || true
        ;;
    esac
  done
}

_atmux_team_repair_rename_usage() {
  cat >&2 <<'USAGE'
Usage: atmux team repair-rename [<team>] [--dry-run] [--force]

Idempotent recovery for teams where `atmux team rename` left declarative
state (team.json:.name + registry) ahead of imperative live state (cage
tmpdir + cage internal session + window prefixes + cron).

  <team>        Target a single team. If omitted, doctor-scans the fleet
                and reports drifted teams (use --force to repair them all).
  --dry-run     Print plan, no changes.
  --force       Repair all detected drifted teams in one pass.

Per ADR-027 ADDENDUM 11. Output cage path: /tmp/atmux_tmux_<team>.
USAGE
}
