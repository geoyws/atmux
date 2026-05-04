#!/usr/bin/env bash
# atmux start [--force] [--doctor] [--no-doctor]
# Creates the team's tmux session and spawns every member's TUI in its own window.
# Driver (the user's own REPL) is NOT spawned — the driver is whoever runs atmux.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"
# shellcheck source=emoji.sh
. "$ATMUX_LIB_DIR/emoji.sh"

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

  # ---- Single-session resolution (E7/Sa t-8b801474) ----
  # Single-session mode = team windows live INSIDE the driver's existing
  # tmux session instead of a dedicated `atmux-<team>` session. Triggered
  # by team.json:.singleSession=true OR ATMUX_DRIVER_SESSION=1. When set,
  # we capture $TMUX's #S, persist it to state/session.txt (so every
  # subsequent verb's atmux::session_name resolves consistently), and
  # SKIP `tmux new-session -d -s atmux-<team>` below. --force is fatal
  # under single-session — kill-session would nuke the driver shell.
  local single
  single="$(jq -r '.singleSession // false' "$(atmux::team_json)" 2>/dev/null || echo false)"
  [[ -n "${ATMUX_DRIVER_SESSION:-}" ]] && single=true

  # ---- Cage-socket safeguard (ADR-018 §cross-socket) ----
  # When team.json declares a per-team `tmuxTmpdir` (cage isolation), every
  # tmux op in this start invocation MUST land on that cage's socket — not
  # the operator's daily-driver socket. Per tmux(1), a set $TMUX env var
  # silently overrides $TMUX_TMPDIR for bare `tmux` invocations, so a start
  # invoked from inside daily-driver tmux would otherwise spawn the team's
  # member windows in the daily-driver session (10+ orphan Claude REPLs
  # consuming tokens on the wrong server, observed 2026-04-30). The earlier
  # bin/atmux pre-export of TMUX_TMPDIR is necessary but not sufficient —
  # $TMUX wins. Refuse the start with an actionable hint rather than
  # silently corrupt topology. Runs BEFORE the single-session capture
  # below so a doomed start can't rewrite state/session.txt with a
  # daily-driver session name.
  #
  # Allowed shapes:
  #   - $TMUX unset (cron / fresh shell): bare tmux honors TMUX_TMPDIR ✅
  #   - $TMUX set, current socket == cage socket (already attached) ✅
  #   - $TMUX set, current socket == DIFFERENT socket: REFUSE
  if [[ -n "${TMUX_TMPDIR:-}" && "$TMUX_TMPDIR" == */atmux-tmux* && -n "${TMUX:-}" ]]; then
    local _cage_sock="$TMUX_TMPDIR/tmux-$(id -u)/default"
    local _current_sock="${TMUX%%,*}"
    if [[ "$_current_sock" != "$_cage_sock" ]]; then
      atmux::die "cage-socket mismatch: this team is cage-gated to '$_cage_sock' but \$TMUX points to '$_current_sock'. Bare tmux would spawn member windows on the wrong socket and consume tokens orphaned outside the cage. Re-run as: env -u TMUX atmux start  (or attach to the cage first: atmux attach)"
    fi
  fi

  if [[ "$single" == "true" ]]; then
    if [[ "$force" -eq 1 ]]; then
      atmux::die "start --force is unsafe under single-session mode (would kill driver tmux); rerun without --force"
    fi
    [[ -n "${TMUX:-}" ]] || atmux::die "single-session requested but \$TMUX is unset (run from inside driver tmux)"
    local driver_session
    driver_session="$(tmux display-message -p '#S')"
    [[ -n "$driver_session" ]] || atmux::die "single-session: tmux display-message returned empty session name"
    mkdir -p "$(atmux::dir)/state"
    printf '%s\n' "$driver_session" > "$(atmux::dir)/state/session.txt"
    atmux::ok "single-session mode: spawning into driver session '$driver_session'"
    atmux::jq_update "$(atmux::team_json)" '.singleSession = true'
  fi

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

  # ---- Topology invariant gate (ADR-027) ----
  # After the generic preflight, run a targeted topology probe so a
  # session-missing / wrong-session / superdriver-absent drift surfaces
  # the row content + suggested fix verbatim — far more actionable than
  # the generic "preflight failed" message. --force overrides red;
  # --no-doctor skips the entire gate. Yellow rows warn loud but do
  # NOT refuse (window-count drift is degraded-but-functional).
  if [[ "$doctor_mode" != "skip" ]]; then
    # shellcheck source=doctor.sh
    . "$ATMUX_LIB_DIR/doctor.sh"
    _doctor_reset
    _doctor_check_topology_invariant
    if (( _doctor_red_count > 0 )) || (( _doctor_yellow_count > 0 )); then
      local _row
      for _row in "${_doctor_rows[@]}"; do
        case "$_row" in
          red\|topology:*|yellow\|topology:*) atmux::warn "${_row//|/  }" ;;
        esac
      done
      if (( _doctor_red_count > 0 )) && [[ "$force" -ne 1 ]]; then
        atmux::die "topology drift detected (ADR-027) — fix the red row above, rerun with --force to override, or --no-doctor to skip"
      fi
      (( _doctor_red_count > 0 )) && atmux::warn "topology drift overridden by --force; proceeding"
    fi
  fi

  # ---- Logout-kill exposure banner (E8/Sa, ADR-017) ----
  # The generic --quiet preflight swallows row detail. Re-invoke the
  # logout-kill probe so an unmissable warning surfaces every start when
  # the linger/KillUserProcesses+session shape would lose the tmux
  # server on disconnect. Does NOT refuse — driver may legitimately
  # want short-lived runs (ADR-017 OQ5).
  if [[ "$doctor_mode" != "skip" ]]; then
    _doctor_reset
    _doctor_check_logout_kill
    if (( _doctor_red_count > 0 )) || (( _doctor_yellow_count > 0 )); then
      atmux::warn "logout-kill exposure: tmux server will die when this SSH session closes. Run 'atmux doctor --fix' to enable linger."
    fi
  fi

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  # ---- Live-lead guard (don't stomp an active session unless --force) ----
  if atmux::tmux_session_exists; then
    if [[ "$force" -ne 1 ]]; then
      atmux::warn "session $session already exists. Running start in incremental mode (existing windows kept)."
    else
      atmux::warn "force: killing existing session $session"
      tmux kill-session -t "=$session" 2>/dev/null || true
    fi
  fi

  # ---- Create session if missing. A hidden __home window hosts the session. ----
  # `3>&- 4>&-` closes fd 3 and 4 so the daemonised tmux server doesn't
  # inherit them. bats reserves fd 3 as its status pipe; an inherited
  # tmux server keeps that pipe open across the entire test process tree
  # and bats-exec-suite blocks forever in pipe_read after bats-exec-test
  # exits. Production interactive use never has fd 3 open at this point,
  # so the closure is a no-op there. See ADR-012.
  local home_win; home_win="$(printf '__%s__home' "$team")"
  # Sandbox HISTFILE per pane (ADR-018 cage extension): the daemonised
  # tmux server inherits the operator's HISTFILE (~/.zsh_history typically),
  # and every send-keys text — `export ATMUX_MEMBER=… && cd … && claude …` —
  # gets recorded as a history line on the OPERATOR's shell. 132 leaked
  # lines per session observed pre-fix. Pass `-e HISTFILE=<per-pane-path>`
  # to new-session/new-window so the spawned shell's history lands inside
  # .atmux/ instead. tmux 3.2+ supports `-e key=value` on both verbs.
  local sd; sd="$(atmux::state_dir)"
  mkdir -p "$sd"
  local home_histfile="$sd/__home.history"

  # ADR-044: when team.json:.driverSession is configured, the driver lives
  # in the team session as the FIRST window (window 1, before any member),
  # and members get spawned after — preserving the declarative topology
  # `driver → lead → members`. Read the gate early so session creation
  # below can use driver as the initial window in lieu of __home.
  local _has_driver_session
  _has_driver_session="$(jq -r 'has("driverSession")' "$(atmux::team_json)" 2>/dev/null || echo false)"
  local _driver_initial=0

  if [[ "$single" != "true" ]] && ! atmux::tmux_session_exists; then
    if [[ "$_has_driver_session" == "true" ]]; then
      # Resolve driver TUI + command. On any resolution failure we fall
      # through to the legacy __home placeholder so session creation
      # never blocks on driver-spawn issues.
      local _drv_tui _drv_cmd _drv_cwd
      _drv_cwd="$(dirname "$(atmux::dir)")"
      _drv_tui="$(jq -r '.driverSession.tui // .driverTui // "claude"' \
                    "$(atmux::team_json)" 2>/dev/null || echo claude)"
      if declare -f atmux::tui_cmd >/dev/null 2>&1 \
         && [[ -n "$_drv_tui" && "$_drv_tui" != "null" && "$_drv_tui" != "false" ]]; then
        _drv_cmd="$(atmux::tui_cmd "$_drv_tui" "default" "$_drv_cwd" "driver" "driver" "" 2>/dev/null || true)"
      fi
      if [[ -n "${_drv_cmd:-}" ]]; then
        tmux new-session -d -s "$session" -n "driver" -c "$_drv_cwd" \
          -e "HISTFILE=$sd/driver.history" \
          "$_drv_cmd" 3>&- 4>&-
        atmux::ok "created tmux session: $session (driver at window 1, $_drv_tui)"
        _driver_initial=1
      else
        atmux::warn "driver-initial: could not resolve command for tui='$_drv_tui' — falling back to __home placeholder"
      fi
    fi
    if [[ "$_driver_initial" -eq 0 ]]; then
      tmux new-session -d -s "$session" -n "$home_win" -c "$PWD" \
        -e "HISTFILE=$home_histfile" 3>&- 4>&-
      atmux::ok "created tmux session: $session"
    fi
  fi

  # Cage-only tmux prefix override — `C-\` (Ctrl-Backslash). The default
  # `C-b` collides with macOS-tmux for operators running 3-level nested
  # tmux (Mac local C-b → SSH'd remote tmux C-a → cage C-b): the
  # outermost layer eats every cage prefix before the cage sees it. C-\
  # is free of macOS bindings, bash/zsh readline, and emacs/vim habits.
  # Gated on TMUX_TMPDIR being set to the team's cage path — without
  # the cage isolation, this would clobber the operator's default
  # tmux socket prefix (where the daily-driver session lives). Cage
  # tmpdirs all match `*/atmux-tmux*`. Idempotent on every `atmux start`.
  #
  # Cross-socket gotcha (mirrors c5f56ef in lib/attach.sh): when `atmux
  # start` runs from inside daily-driver tmux, $TMUX is set and points to
  # the daily-driver socket. Per tmux(1), $TMUX overrides $TMUX_TMPDIR for
  # bare `tmux` invocations — so a naked `tmux set-option -g prefix 'C-\'`
  # would clobber the OPERATOR'S daily-driver prefix while leaving the
  # cage's prefix at whatever ~/.tmux.conf set on cage server start. Force
  # the explicit cage socket via `-S` AND drop $TMUX with `env -u TMUX` so
  # tmux doesn't second-guess us via the inherited env var.
  if [[ -n "${TMUX_TMPDIR:-}" && "$TMUX_TMPDIR" == */atmux-tmux* ]]; then
    local cage_sock="$TMUX_TMPDIR/tmux-$(id -u)/default"
    env -u TMUX tmux -S "$cage_sock" set-option -g prefix 'C-\' 2>/dev/null || true
    env -u TMUX tmux -S "$cage_sock" unbind-key C-b 2>/dev/null || true
    env -u TMUX tmux -S "$cage_sock" bind-key 'C-\' send-prefix 2>/dev/null || true
  fi

  # ---- Registry touch (E10/Sa t-638f6504, ADR-025 §Decision start hook) ----
  # Bump lastSeen on every successful start so the fleet aggregator
  # (super-status) knows this team is alive. Backfill via upsert when the
  # entry is missing — the common case for teams whose `atmux init`
  # predates SA_T2's registry hook (silent, no atmux::ok). All failures
  # here are non-fatal: the registry is coordination/observability infra,
  # not a precondition for the team being up.
  #
  # Runs BEFORE the spawn loop so the team's registry entry exists in time
  # for atmux::resolve_member_emoji's write-through (ADR-030):
  # registry_set_emoji silently no-ops when the team isn't yet registered,
  # so a post-spawn placement would lose the first-spawn random emoji and
  # break immutability for pre-ADR-025 teams on their first 1-2 starts.
  if [[ -f "$ATMUX_LIB_DIR/registry.sh" ]]; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
    local _atmux_registry _atmux_registered=false
    _atmux_registry="$(atmux::registry_path)"
    if [[ -s "$_atmux_registry" ]] \
       && jq -e --arg n "$team" 'any(.[]?; .name == $n)' "$_atmux_registry" >/dev/null 2>&1; then
      _atmux_registered=true
    fi
    if [[ "$_atmux_registered" == "true" ]]; then
      atmux::registry_touch "$team" \
        || atmux::warn "registry_touch failed for '$team' (non-fatal)"
    else
      local _atmux_root; _atmux_root="$(dirname "$(atmux::dir)")"
      atmux::registry_upsert "$team" "$_atmux_root" "$session" \
        || atmux::warn "registry_upsert backfill failed for '$team' (non-fatal)"
    fi
  else
    atmux::warn "lib/registry.sh missing — skipping registry touch (non-fatal)"
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
  # Per-team prefix (__<team>__home) avoids collision when two teams
  # share the same tmux session under single-session mode.
  if [[ "$any_spawned" -eq 1 ]] && tmux list-windows -t "=$session" -F '#{window_name}' 2>/dev/null | grep -qx "$home_win"; then
    # only close home if there are other windows
    local wc; wc=$(tmux list-windows -t "=$session" -F '#{window_name}' | grep -cv "^${home_win}\$" || true)
    if [[ "$wc" -gt 0 ]]; then
      tmux kill-window -t "$session:$home_win" 2>/dev/null || true
    fi
  fi

  # ---- Legacy at-end driver auto-spawn (pre-ADR-044) ----
  # When team.json has NO `driverSession` configured but DOES set
  # `driverTui`, fall back to the 2026-04-30 behavior: append a `driver`
  # window AFTER all members. Teams using the modern declarative
  # `driverSession` path get their driver as window 1 at session
  # creation (above) — this block is the legacy path, kept for backward
  # compat. Skipped under singleSession=true.
  if [[ "$single" != "true" && "$_has_driver_session" != "true" ]]; then
    local driver_tui driver_cmd driver_win="driver" driver_cwd
    driver_tui="$(jq -r '.driverTui // "claude"' "$(atmux::team_json)" 2>/dev/null || echo claude)"
    [[ "$driver_tui" == "null" || "$driver_tui" == "false" ]] && driver_tui=""
    driver_cwd="$(dirname "$(atmux::dir)")"

    if [[ -n "$driver_tui" ]]; then
      if tmux list-windows -t "=$session" -F '#{window_name}' 2>/dev/null | grep -qx "$driver_win"; then
        atmux::log "driver: window '$driver_win' already up, skipping auto-spawn"
      elif ! declare -f atmux::tui_cmd >/dev/null 2>&1; then
        atmux::warn "driver: atmux::tui_cmd unavailable — skipping auto-spawn"
      else
        driver_cmd="$(atmux::tui_cmd "$driver_tui" "default" "$driver_cwd" "driver" "driver" "" 2>/dev/null || true)"
        if [[ -z "$driver_cmd" ]]; then
          atmux::warn "driver: tui_cmd returned empty for '$driver_tui' — skipping auto-spawn"
        else
          tmux new-window -d -t "$session" -n "$driver_win" \
            -c "$driver_cwd" \
            "$driver_cmd" 3>&- 4>&- \
            && atmux::ok "driver: spawned '$driver_win' running $driver_tui (at end — legacy)" \
            || atmux::warn "driver: failed to spawn '$driver_win' (non-fatal)"
        fi
      fi
    fi
  fi

  # ---- Auto-spawn the supervisor window (ADR-032 §Supervisor lifecycle) ----
  # One __<team>__supervisor window per team runs lib/supervisor.sh, which
  # listens on .atmux/sockets/<member>.sock for events and gates send-keys
  # injection through the migrate-grade NBSP-aware preflight. Idempotent:
  # if the window already exists from a prior `atmux start` (or a crashed
  # window that wasn't reaped), we leave it alone — its own SIGCHLD trap
  # respawns dead subscribers from the inside. team.json:.supervisor=false
  # opts out for legacy / single-process teams.
  local sup_optout sup_win sup_cwd
  sup_optout="$(jq -r '.supervisor // true' "$(atmux::team_json)" 2>/dev/null || echo true)"
  sup_win="__${team}__supervisor"
  sup_cwd="$(dirname "$(atmux::dir)")"
  if [[ "$sup_optout" != "false" ]]; then
    if atmux::tmux_window_exists "$sup_win"; then
      atmux::log "supervisor: window $sup_win already running, skipping spawn"
    else
      tmux new-window -d -t "$session" -n "$sup_win" \
        -c "$sup_cwd" \
        "$ATMUX_BIN_DIR/atmux supervisor-start" 3>&- 4>&- \
        || atmux::warn "supervisor: failed to spawn window $sup_win (non-fatal)"
      atmux::ok "supervisor: spawned $sup_win"
    fi
  fi

  # ---- Record start timestamp ----
  atmux::now_epoch > "$(atmux::state_dir)/session-start.txt"

  # ---- Snapshot the spawned config so `atmux reload config-reload` can
  # ----  diff team.json against it and ping members whose role/lane/model/tui
  # ----  changed. Re-written on every start (including incremental restarts).
  atmux::state_dir >/dev/null && mkdir -p "$(atmux::state_dir)"
  jq '{members: [.members[] | {name, role: (.role // "member"),
                                lane: (.lane // "misc"),
                                model: (.model // "default"),
                                tui:   (.tui   // "claude")}]}' \
    "$(atmux::team_json)" > "$(atmux::state_dir)/spawn-snapshot.json"

  atmux::ok "team '$team' is up. attach with: atmux attach"

  # ---- Cron auto-install (E6/Sc t-ac7197cf) ----
  # Wire whip + report + decisions-digest into the user's crontab unless
  # team.json explicitly opts out via kanban.cronAutoInstall=false. Default
  # = true — most teams want the watchdog. Failures here are non-fatal:
  # cron install is a convenience, not a precondition for `start` to be
  # considered successful.
  local cron_optout
  cron_optout=$(jq -r '.kanban.cronAutoInstall // true' "$(atmux::team_json)" 2>/dev/null || echo true)
  if [[ "$cron_optout" != "false" ]]; then
    # shellcheck source=cron.sh
    . "$ATMUX_LIB_DIR/cron.sh"
    if atmux::cron_install "$team" "$(atmux::dir)"; then
      atmux::ok "installed cron entries (whip */5, report */30, decisions digest 0 */4, groom 0 4)"
      atmux::log "  inspect: crontab -l | grep 'atmux:team=$team'"
    fi
  fi

  # On-activate groom — passive sweep so cron-less hosts (and any team
  # whose crontab line hasn't fired yet today) still get the stale-state
  # archival. Idempotent: most days a no-op. Backgrounded so a slow
  # archive flush on a multi-MB driver-inbox doesn't gate `atmux start`'s
  # return on attach. Failures are non-fatal (groom itself logs warnings;
  # we never want a botched groom to refuse a team start).
  case "${ATMUX_NO_GROOM:-}" in
    ''|0|false|FALSE|False)
      ( ATMUX_DIR="$(atmux::dir)" "$ATMUX_BIN_DIR/atmux" groom --quiet \
          >> "$(atmux::logs_dir)/groom.log" 2>&1 || true ) &
      atmux::log "groom: on-activate sweep dispatched (background; tail .atmux/logs/groom.log)"
      ;;
  esac
}

_atmux_spawn_member() {
  local member="$1"
  local mj; mj="$(atmux::member_json "$member")"
  local tui model cwd role
  tui="$(jq -r '.tui // "claude"' <<<"$mj")"
  # ADR-024: model="default" → claude CLI default model (Opus today via global
  # CLAUDE_CODE_EFFORT_LEVEL=xhigh); explicit IDs (claude-sonnet-4-6, etc)
  # propagate verbatim through atmux::tui_cmd → atmux::tui_claude → `--model <id>`.
  model="$(jq -r '.model // "default"' <<<"$mj")"
  cwd="$(jq -r '.cwd // "."' <<<"$mj")"
  role="$(jq -r '.role // "member"' <<<"$mj")"

  # ADR-030: resolve+persist the member's emoji BEFORE atmux::window_name reads
  # it back. The resolver runs the priority chain (registry → team.json → random
  # fallback via emoji_assign) and write-throughs to the registry on steps 2 + 3
  # — converting the first-spawn random pick into a durable assignment that
  # survives every future restart. Failures are swallowed: emoji is cosmetic,
  # not a precondition for the spawn.
  if declare -f atmux::resolve_member_emoji >/dev/null 2>&1; then
    local _team; _team="$(atmux::team_name)"
    atmux::resolve_member_emoji "$_team" "$member" "$role" >/dev/null 2>&1 || true
  fi

  local session win target
  session="$(atmux::session_name)"
  win="$(atmux::window_name "$member")"
  target="$session:$win"

  # Per-member HISTFILE sandbox (see new-session above for the rationale).
  # Each spawned member-pane gets its own .atmux/state/<member>.history so
  # operator's ~/.zsh_history stays clean of brief content + ATMUX_MEMBER
  # env exports.
  local sd; sd="$(atmux::state_dir)"
  mkdir -p "$sd"
  local member_histfile="$sd/${member}.history"

  # Same fd-3/4 closure as the session-create path above — daemonised
  # tmux servers must not inherit bats's status pipe. ADR-012.
  tmux new-window -d -t "$session" -n "$win" -c "$cwd" \
    -e "HISTFILE=$member_histfile" 3>&- 4>&-
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
  local tmp; tmp="$(atmux::tmp_path brief md)"
  atmux::render_brief "$member" "$role" "$brief_path" > "$tmp"

  local buf="atmux_brief_${member}"
  tmux load-buffer -b "$buf" "$tmp"
  tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null || tmux paste-buffer -b "$buf" -t "$target"
  sleep 1
  tmux send-keys -t "$target" Enter
  rm -f "$tmp"

  atmux::record_brief_version "$member" "$role"
}
