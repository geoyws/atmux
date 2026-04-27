#!/usr/bin/env bash
# atmux team rename <old> <new> [--session <new-session>] [--migrate-session] [--force]
#
# Atomic team-rename orchestrator + rollback engine. Per ADR-027 §Decision.
#
# Pre-flight refuse-gates (any one → die):
#   - in-progress kanban Task present (--force overrides)
#   - <new> already in registry (NEVER overrideable)
#   - <new> matches !^[a-z0-9_-]+$ (NEVER overrideable)
#
# Orchestration sequence (each step rollback-staged; partial failure invokes
# rollback in reverse order):
#   1. Set rename.lock — cron consumers honor this and silently no-op.
#   2. jq-edit team.json:.name = <new>; backup at team.json.bak.<epoch>.
#   3. tmux rename-window per pane matching __<old>__* → __<new>__*.
#      If --session given AND old != new AND singleSession=false:
#        tmux rename-session.
#   4. Rewrite state/session.txt (singleSession teams) to <newSession>.
#   5. Cron re-install order: install-NEW-then-remove-OLD (per OQ H3 — avoids
#      zero-cron window). Verify new block in `crontab -l` BEFORE removing
#      old; abort+rollback on install failure.
#   6. Registry update: registry_deregister <old> + registry_upsert <new>.
#   7. Clear rename.lock.
#   8. Discord ping if webhook configured.
#
# Rollback log: <projectRoot>/.atmux/state/rename-rollback.log — append-only.
# Best-effort: terminal states (tmux session dies mid-rename) require manual
# recovery; the log informs the operator.

main() {
  atmux::require jq

  local old="" new="" new_session="" migrate_session=0 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session)         new_session="$2";  shift 2 ;;
      --migrate-session) migrate_session=1; shift ;;
      --force)           force=1;           shift ;;
      --help|-h) _atmux_team_rename_usage; return 0 ;;
      -*) atmux::die "team rename: unknown flag: $1" ;;
      *)
        if [[ -z "$old" ]]; then old="$1"
        elif [[ -z "$new" ]]; then new="$1"
        else atmux::die "team rename: unexpected arg: $1"
        fi
        shift ;;
    esac
  done

  [[ -n "$old" && -n "$new" ]] || { _atmux_team_rename_usage; atmux::die "team rename: <old> <new> required"; }
  [[ -n "$new_session" ]] || new_session="$new"

  atmux::require_team
  local tj; tj="$(atmux::team_json)"
  local current_name; current_name="$(jq -r '.name' "$tj")"
  [[ "$current_name" == "$old" ]] || atmux::die "team rename: team.json:.name='$current_name', not '$old' — wrong --team-dir?"

  # ---- Pre-flight refuse-gates ----

  [[ "$new" =~ ^[a-z0-9_-]+$ ]] \
    || atmux::die "team rename: new name '$new' invalid — must match ^[a-z0-9_-]+\$ (lowercase / digit / underscore / hyphen)"

  if ! declare -F atmux::registry_path >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi
  if ! declare -F atmux::cron_install >/dev/null 2>&1; then
    # shellcheck source=cron.sh
    . "$ATMUX_LIB_DIR/cron.sh"
  fi

  local rpath; rpath="$(atmux::registry_path)"
  if [[ -s "$rpath" ]]; then
    local clash
    clash="$(jq --arg n "$new" '[.[] | select(.name == $n)] | length' "$rpath" 2>/dev/null || echo 0)"
    (( clash == 0 )) || atmux::die "team rename: '$new' already in registry — collision (NEVER overrideable)"
  fi

  local kj; kj="$(atmux::kanban_json)"
  if [[ -f "$kj" ]]; then
    local in_progress
    in_progress="$(jq '[.tasks[]? | select(.status == "in-progress")] | length' "$kj" 2>/dev/null || echo 0)"
    if (( in_progress > 0 )) && (( force == 0 )); then
      atmux::die "team rename: $in_progress in-progress Task(s) — pass --force to override"
    fi
    (( in_progress > 0 && force == 1 )) && atmux::warn "team rename: --force overriding $in_progress in-progress Task(s)"
  fi

  # ---- Capture pre-rename state for rollback ----

  local atmux_dir; atmux_dir="$(atmux::dir)"
  local state_dir; state_dir="$(atmux::state_dir)"
  mkdir -p "$state_dir"
  local lock_file="$state_dir/rename.lock"
  local rollback_log="$state_dir/rename-rollback.log"
  local single_session
  single_session="$(jq -r '.singleSession // false' "$tj")"
  local old_session
  if [[ -f "$state_dir/session.txt" ]]; then
    old_session="$(cat "$state_dir/session.txt")"
  else
    old_session="atmux-$old"
  fi

  # Rollback step stack — each entry is a tag the rollback walker handles.
  ATMUX_RENAME_ROLLBACK_STACK=()

  _atmux_team_rename_log "begin: $old → $new (session: $old_session → $new_session, force=$force)"

  # ---- Step 1: lock ----
  : > "$lock_file"
  ATMUX_RENAME_ROLLBACK_STACK+=("lock")
  _atmux_team_rename_log "step1: lock at $lock_file"

  # ---- Step 1a: --migrate-session post-step (best-effort, pre-rename) ----
  # Per Task t-130ab37a / flag f-5ba51c1c: --migrate-session was a parsed-
  # but-dead flag. The verb's contract (lib/migrate.sh) hardcodes
  # src_session = atmux-$team-name, so the call MUST happen BEFORE
  # team.json:.name flips to $new (otherwise migrate would resolve
  # src=atmux-$new which doesn't exist). Failure does NOT trigger
  # rollback — rename will proceed; operator retries migration manually
  # via 'atmux migrate-to-driver-session $new' once the new name is
  # active. Cron consumers honour the rename.lock so the migrate verb
  # runs alone. $TMUX precondition fails outside driver tmux —
  # operator-facing surface.
  if [[ "$migrate_session" == "1" ]]; then
    if "$ATMUX_BIN_DIR/atmux" migrate-to-driver-session "$old" >&2; then
      _atmux_team_rename_log "step1a: migrate-to-driver-session $old succeeded"
    else
      atmux::warn "team rename: --migrate-session step failed; rename will continue but windows may remain in '$old_session'"
      atmux::warn "  retry once rename completes: atmux migrate-to-driver-session $new"
      _atmux_team_rename_log "step1a: migrate-to-driver-session $old FAILED (best-effort, no rollback)"
    fi
  fi

  # ---- Step 2: team.json rewrite ----
  local backup
  if ! backup="$(_atmux_team_rename_step_team_json "$tj" "$new")"; then
    _atmux_team_rename_rollback "$old" "$new" "$old_session" "$new_session" "$tj" "" "$lock_file"
    atmux::die "team rename: step2 (team.json) failed — rolled back"
  fi
  ATMUX_RENAME_ROLLBACK_STACK+=("team_json:$backup")
  _atmux_team_rename_log "step2: team.json:.name = $new (backup: $backup)"

  # ---- Step 3: tmux windows + (optional) session rename ----
  local rename_session_ok=0
  if [[ "$single_session" != "true" && "$old_session" != "$new_session" ]]; then
    if tmux has-session -t "=$old_session" 2>/dev/null; then
      if tmux rename-session -t "=$old_session" "$new_session" 2>/dev/null; then
        rename_session_ok=1
        ATMUX_RENAME_ROLLBACK_STACK+=("tmux_session:$old_session:$new_session")
        _atmux_team_rename_log "step3a: tmux rename-session $old_session → $new_session"
      else
        _atmux_team_rename_log "step3a: tmux rename-session failed (session may be down)"
      fi
    fi
  fi

  local renamed_windows
  renamed_windows="$(_atmux_team_rename_step_windows "$old" "$new" "$new_session")"
  if [[ -n "$renamed_windows" ]]; then
    ATMUX_RENAME_ROLLBACK_STACK+=("tmux_windows:$renamed_windows:$new_session")
    _atmux_team_rename_log "step3b: tmux rename-window: $renamed_windows"
  fi

  # ---- Step 4: state/session.txt rewrite ----
  if [[ "$single_session" == "true" && -f "$state_dir/session.txt" ]]; then
    cp -p "$state_dir/session.txt" "$state_dir/session.txt.bak.$(atmux::now_epoch)"
    printf '%s\n' "$new_session" > "$state_dir/session.txt"
    ATMUX_RENAME_ROLLBACK_STACK+=("session_txt:$state_dir/session.txt:$old_session")
    _atmux_team_rename_log "step4: state/session.txt rewritten ($old_session → $new_session)"
  fi

  # ---- Step 5: cron re-install (install-new-then-remove-old) ----
  local proj_root="${atmux_dir%/.atmux}"
  if command -v crontab >/dev/null 2>&1 && [[ -z "${ATMUX_NO_CRON:-}" || "${ATMUX_NO_CRON:-}" == "0" ]]; then
    if ! atmux::cron_install "$new" "$atmux_dir"; then
      _atmux_team_rename_log "step5: cron_install $new FAILED — rolling back"
      _atmux_team_rename_rollback "$old" "$new" "$old_session" "$new_session" "$tj" "$proj_root" "$lock_file"
      atmux::die "team rename: cron_install '$new' failed — rolled back"
    fi
    # Verify new block landed before removing old.
    if ! crontab -l 2>/dev/null | grep -q "^# >>> atmux:team=$new"; then
      _atmux_team_rename_log "step5: cron verify new=$new FAILED — rolling back"
      _atmux_team_rename_rollback "$old" "$new" "$old_session" "$new_session" "$tj" "$proj_root" "$lock_file"
      atmux::die "team rename: cron verification for '$new' failed — rolled back"
    fi
    ATMUX_RENAME_ROLLBACK_STACK+=("cron:$new")
    atmux::cron_remove "$old" || _atmux_team_rename_log "step5: cron_remove $old returned non-zero (continuing)"
    _atmux_team_rename_log "step5: cron install-new=$new + remove-old=$old"
  else
    _atmux_team_rename_log "step5: cron skipped (crontab unavailable or ATMUX_NO_CRON set)"
  fi

  # ---- Step 6: registry update ----
  # Preserve OLD entry's createdAt across the rename so the new-name entry
  # carries the original creation epoch (ADR-025 history-preserving semantic
  # — rename is a name-change, not a re-creation). f-159786bb was filed when
  # rename treated the post-deregister upsert as a fresh registration. Empty
  # old_created (legacy / pre-ADR-025 entry) → registry_upsert falls back
  # to now_epoch on its own; we just don't pass --created-at in that case.
  local old_created=""
  if [[ -s "$rpath" ]]; then
    old_created="$(jq -r --arg t "$old" '.[] | select(.name == $t) | .createdAt // empty' "$rpath" 2>/dev/null || true)"
  fi
  atmux::registry_deregister "$old" >/dev/null 2>&1 || true
  local _upsert_rc=0
  if [[ -n "$old_created" ]]; then
    atmux::registry_upsert "$new" "$proj_root" "$new_session" --created-at "$old_created" >/dev/null 2>&1 || _upsert_rc=$?
  else
    atmux::registry_upsert "$new" "$proj_root" "$new_session" >/dev/null 2>&1 || _upsert_rc=$?
  fi
  if (( _upsert_rc != 0 )); then
    _atmux_team_rename_log "step6: registry_upsert FAILED — rolling back"
    _atmux_team_rename_rollback "$old" "$new" "$old_session" "$new_session" "$tj" "$proj_root" "$lock_file"
    atmux::die "team rename: registry_upsert '$new' failed — rolled back"
  fi
  ATMUX_RENAME_ROLLBACK_STACK+=("registry:$old:$new:$proj_root:$new_session")
  _atmux_team_rename_log "step6: registry deregister=$old + upsert=$new"

  # ---- Step 7: clear lock ----
  rm -f "$lock_file"
  _atmux_team_rename_log "step7: lock cleared"

  # ---- Step 8: success summary + Discord ----
  atmux::ok "team rename: '$old' → '$new' (session: $new_session) — committed"
  if declare -F atmux::discord_ping >/dev/null 2>&1; then
    local hook
    hook="${ATMUX_DISCORD_WEBHOOK:-$(jq -r '.discord.webhook // empty' "$tj" 2>/dev/null)}"
    if [[ -n "$hook" && "$hook" != "null" ]]; then
      local ts; ts="$(atmux::now_myt)"
      ATMUX_DISCORD_WEBHOOK="$hook" atmux::discord_ping \
        $'🚀 **[team-rename]** · `'"$new"$'` · '"$ts"$'\n\n'"- ♻️ \`$old\` → \`$new\`"$'\n'"- 📍 session: \`$new_session\`" \
        >/dev/null 2>&1 || true
    fi
  fi
  _atmux_team_rename_log "complete"
}

_atmux_team_rename_usage() {
  cat >&2 <<'USAGE'
Usage: atmux team rename <old> <new> [--session <new-session>] [--migrate-session] [--force]

Atomic rename of a team across team.json / tmux windows / state/session.txt / cron / registry.
On partial failure, the orchestrator rolls back completed steps in reverse order.

Flags:
  --session <s>        New tmux session name. Default: <new>.
  --migrate-session    Reuse migrate-to-driver-session for legacy dedicated → driver consolidation.
  --force              Override the in-progress-Task pre-flight gate.

Pre-flight gates:
  in-progress Task     refuse (--force overrides)
  <new> in registry    refuse (NEVER overrideable)
  <new> bad shape      refuse (NEVER overrideable; ^[a-z0-9_-]+$)

See ADR-027 for full design.
USAGE
}

# Step 2: jq-edit team.json:.name = <new>. Echoes backup path on success.
_atmux_team_rename_step_team_json() {
  local tj="$1" new="$2"
  local backup="${tj}.bak.$(atmux::now_epoch)"
  cp -p "$tj" "$backup" 2>/dev/null || return 1
  if ! atmux::jq_update "$tj" '.name = $n' --arg n "$new"; then
    return 1
  fi
  printf '%s\n' "$backup"
}

# Step 3b: rename every __<old>__* window in <session> to __<new>__*. Echoes a
# space-separated list of "<window_id>:<old_name>:<new_name>" for rollback use.
_atmux_team_rename_step_windows() {
  local old="$1" new="$2" session="$3"
  command -v tmux >/dev/null 2>&1 || return 0
  tmux has-session -t "=$session" 2>/dev/null || return 0
  local out=""
  while IFS=' ' read -r wid wname; do
    [[ -z "$wid" || -z "$wname" ]] && continue
    if [[ "$wname" == "__${old}__"* ]]; then
      local new_wname="__${new}__${wname#__${old}__}"
      if tmux rename-window -t "$wid" "$new_wname" 2>/dev/null; then
        out+="$wid:$wname:$new_wname "
      fi
    fi
  done < <(tmux list-windows -t "=$session" -F '#{window_id} #{window_name}' 2>/dev/null)
  printf '%s\n' "${out% }"
}

# Walk ATMUX_RENAME_ROLLBACK_STACK in reverse, undoing each completed step.
# Best-effort: each step's reverse may itself fail (e.g. tmux session died);
# all outcomes appended to the rollback log.
_atmux_team_rename_rollback() {
  local old="$1" new="$2" old_session="$3" new_session="$4" tj="$5" proj_root="$6" lock_file="$7"
  _atmux_team_rename_log "rollback: BEGIN (stack depth=${#ATMUX_RENAME_ROLLBACK_STACK[@]})"

  local i step tag rest
  for (( i=${#ATMUX_RENAME_ROLLBACK_STACK[@]}-1; i>=0; i-- )); do
    step="${ATMUX_RENAME_ROLLBACK_STACK[$i]}"
    tag="${step%%:*}"
    rest="${step#*:}"
    case "$tag" in
      lock)
        rm -f "$lock_file" 2>/dev/null && _atmux_team_rename_log "rollback: lock cleared"
        ;;
      team_json)
        # rest = backup path
        if [[ -f "$rest" ]]; then
          cp -p "$rest" "$tj" && _atmux_team_rename_log "rollback: team.json restored from $rest"
        fi
        ;;
      tmux_session)
        # rest = "<old_session>:<new_session>"
        local os="${rest%%:*}" ns="${rest#*:}"
        if tmux has-session -t "=$ns" 2>/dev/null; then
          tmux rename-session -t "=$ns" "$os" 2>/dev/null \
            && _atmux_team_rename_log "rollback: tmux session $ns → $os"
        fi
        ;;
      tmux_windows)
        # rest = "<wid:old:new> ... :<session>" — tail field is the session.
        # Format: "wid1:old1:new1 wid2:old2:new2 ... :SESSION"
        # Easier: re-parse step.
        local triples="${step#tmux_windows:}"
        local sess="${triples##*:}"
        local list="${triples%:*}"
        local triple
        for triple in $list; do
          local twid="${triple%%:*}"
          local rest2="${triple#*:}"
          local told="${rest2%%:*}"
          local tnew="${rest2#*:}"
          if tmux has-session -t "=$sess" 2>/dev/null; then
            tmux rename-window -t "$twid" "$told" 2>/dev/null \
              && _atmux_team_rename_log "rollback: tmux window $tnew → $told"
          fi
        done
        ;;
      session_txt)
        # rest = "<path>:<old_session>"
        local sp="${rest%%:*}" os2="${rest#*:}"
        printf '%s\n' "$os2" > "$sp" \
          && _atmux_team_rename_log "rollback: state/session.txt restored to $os2"
        ;;
      cron)
        # rest = "<new>" — remove the new-marker block (old is already gone).
        atmux::cron_remove "$rest" 2>/dev/null \
          && _atmux_team_rename_log "rollback: cron_remove $rest"
        # Re-install old (if proj_root known).
        if [[ -n "$proj_root" ]]; then
          atmux::cron_install "$old" "$proj_root/.atmux" 2>/dev/null \
            && _atmux_team_rename_log "rollback: cron_install $old"
        fi
        ;;
      registry)
        # rest = "<old>:<new>:<proj>:<sess>"
        atmux::registry_deregister "$new" 2>/dev/null \
          && _atmux_team_rename_log "rollback: registry_deregister $new"
        if [[ -n "$proj_root" ]]; then
          atmux::registry_upsert "$old" "$proj_root" "$old_session" 2>/dev/null \
            && _atmux_team_rename_log "rollback: registry_upsert $old"
        fi
        ;;
    esac
  done
  rm -f "$lock_file" 2>/dev/null
  _atmux_team_rename_log "rollback: END"
}

_atmux_team_rename_log() {
  local msg="$*"
  local sd; sd="$(atmux::state_dir)"
  mkdir -p "$sd"
  printf '[%s] %s\n' "$(atmux::now_iso)" "$msg" >> "$sd/rename-rollback.log"
}
