#!/usr/bin/env bash
# atmux doctor [--quiet] [--fix] [--json]
#
# Environment health check. Runs a battery of checks and reports green/red.
# `atmux start` invokes this in --quiet mode as a preflight.
#
# Checks:
#   - required deps: tmux, jq, git
#   - optional deps: curl (discord), bats + shellcheck (dev)
#   - .atmux/team.json exists and is valid JSON with required fields
#   - every member's TUI binary is on PATH (or member.command / tuiCommands[tui] is)
#   - .atmux/ is writable
#   - Discord webhook is reachable (if configured via env or team.json)
#
# Exit codes: 0 = all green, 1 = one or more issues.

main() {
  local quiet=0 fix=0 json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --quiet|-q) quiet=1; shift ;;
      --fix)      fix=1;   shift ;;
      --json)     json=1;  shift ;;
      -h|--help)
        cat <<'EOF'
atmux doctor — check environment health

Usage: atmux doctor [--quiet] [--fix] [--json]

  --quiet    suppress output; exit 0 on green, 1 on red (used by start preflight)
  --fix      interactively remediate fixable issues (re-run wizard on bad team.json etc.)
  --json     emit a JSON report on stdout
EOF
        return 0 ;;
      *) atmux::die "doctor: unknown arg: $1" ;;
    esac
  done

  _doctor_reset
  _doctor_check_deps
  _doctor_check_libs
  _doctor_check_team
  _doctor_check_tuis
  _doctor_check_claude_accounts
  _doctor_check_state_dir
  _doctor_check_tmux_tmpdir
  _doctor_check_webhook
  _doctor_check_crontab
  _doctor_check_cron_orphans
  _doctor_check_orphan_sessions
  _doctor_check_topology_invariant
  _doctor_check_repair_rename_needed
  _doctor_check_whip_hash
  _doctor_check_phantom_inboxes
  _doctor_check_logout_kill
  _doctor_check_supervisor_liveness
  _doctor_check_wedged_bats_exec
  _doctor_check_caged_windows_outside_cage
  _doctor_check_daily_driver_launchers
  _doctor_check_daily_driver_prefix_leak

  if [[ "$json" -eq 1 ]]; then
    _doctor_render_json
  elif [[ "$quiet" -ne 1 ]]; then
    _doctor_render_human
  fi

  if [[ "$fix" -eq 1 && "$quiet" -ne 1 ]]; then
    _doctor_try_fix
  fi

  [[ "$_doctor_red_count" -eq 0 ]]
}

# ---------- state ----------

_doctor_reset() {
  _doctor_rows=()           # "status|label|detail|hint"
  _doctor_red_count=0
  _doctor_yellow_count=0
  _doctor_verify_libs_json=""   # raw `verify-libs --json` output for --json passthrough
}

# status: green | yellow | red
_doctor_row() {
  local status="$1" label="$2" detail="${3:-}" hint="${4:-}"
  _doctor_rows+=("$status|$label|$detail|$hint")
  case "$status" in
    red)    _doctor_red_count=$((_doctor_red_count + 1)) ;;
    yellow) _doctor_yellow_count=$((_doctor_yellow_count + 1)) ;;
  esac
}

# ---------- checks ----------

_doctor_check_deps() {
  local dep path
  for dep in tmux jq git; do
    if path="$(command -v "$dep" 2>/dev/null)"; then
      _doctor_row green "dep:$dep" "$path"
    else
      _doctor_row red "dep:$dep" "NOT on PATH" "install: $(_doctor_install_hint "$dep")"
    fi
  done

  # Optional deps — yellow (warn), not red.
  for dep in curl bats shellcheck; do
    if path="$(command -v "$dep" 2>/dev/null)"; then
      _doctor_row green "dep:$dep" "$path (optional)"
    else
      local why
      case "$dep" in
        curl)       why="needed for discord webhook + update check" ;;
        bats)       why="needed for test suite" ;;
        shellcheck) why="needed for lint pass in CI" ;;
      esac
      _doctor_row yellow "dep:$dep" "not installed (optional)" "$why — $(_doctor_install_hint "$dep")"
    fi
  done
}

# Source-check every lib/*.sh + assert function-presence via `atmux verify-libs`.
# A red here means a lib won't load correctly under strict mode — caught BEFORE
# `atmux start` spawns panes, so members never boot into a broken codebase.
# Stash the raw JSON in `_doctor_verify_libs_json` so --json mode can echo the
# detailed per-lib report alongside the doctor row summary.
_doctor_check_libs() {
  local out
  out="$("$ATMUX_BIN_DIR/atmux" verify-libs --json 2>/dev/null || true)"
  _doctor_verify_libs_json="$out"

  if [[ -z "$out" ]] || ! jq -e . <<<"$out" >/dev/null 2>&1; then
    _doctor_row red "libs" "verify-libs failed to produce JSON" \
      "run \`atmux verify-libs\` directly for details"
    return
  fi

  local total ok source_fail missing_fail
  total=$(jq -r '.summary.total // 0'        <<<"$out")
  ok=$(jq -r '.summary.ok // 0'              <<<"$out")
  source_fail=$(jq -r '.summary.sourceFail // 0'   <<<"$out")
  missing_fail=$(jq -r '.summary.missingFail // 0' <<<"$out")

  if (( source_fail == 0 && missing_fail == 0 )); then
    _doctor_row green "libs" "$ok/$total libs loaded"
  else
    local first
    first=$(jq -r '.libs[] | select(.status != "OK") | "\(.name): \(.detail)"' \
              <<<"$out" | head -1)
    _doctor_row red "libs" \
      "$ok/$total OK ($source_fail source-fail, $missing_fail missing-fn)" \
      "first: ${first:-unknown}"
  fi
}

_doctor_check_team() {
  local tj; tj="$(atmux::team_json)"
  if [[ ! -f "$tj" ]]; then
    _doctor_row red "team.json" "missing at $tj" "run: atmux init --wizard"
    return
  fi
  if ! jq -e . "$tj" >/dev/null 2>&1; then
    _doctor_row red "team.json" "invalid JSON at $tj" "fix by hand or re-run: atmux init --force --wizard"
    return
  fi

  local name members_n
  name="$(jq -r '.name // ""' "$tj")"
  members_n="$(jq -r '.members | length' "$tj" 2>/dev/null || echo 0)"

  if [[ -z "$name" ]]; then
    _doctor_row red "team.json" "missing .name" "add a name field to $tj"
    return
  fi
  if [[ "$members_n" -eq 0 ]]; then
    _doctor_row red "team.json" "no members defined" "run: atmux add-member <name> --role member --tui claude"
    return
  fi

  # Per-member required fields.
  local bad_members
  bad_members="$(jq -r '
    .members[]
    | select(.name == null or .role == null or .tui == null)
    | .name // "(unnamed)"' "$tj")"
  if [[ -n "$bad_members" ]]; then
    _doctor_row red "team.json" "members missing name/role/tui: $(tr "\n" " " <<<"$bad_members")" \
      "edit $tj"
    return
  fi

  _doctor_row green "team.json" "valid — team \"$name\", $members_n members"
}

_doctor_check_tuis() {
  local tj; tj="$(atmux::team_json)"
  [[ -f "$tj" ]] || return 0  # team.json check already red, skip
  # Invalid JSON already caught by _doctor_check_team — don't double-report.
  jq -e . "$tj" >/dev/null 2>&1 || return 0

  # Collect "bin<TAB>member" rows, one per member (skipping shell).
  local rows=""
  local n; n="$(jq -r '.members | length' "$tj" 2>/dev/null || echo 0)"
  local i
  for ((i=0; i<n; i++)); do
    local member tui override prefix bin
    member="$(jq -r ".members[$i].name"     "$tj")"
    tui="$(   jq -r ".members[$i].tui"      "$tj")"
    override="$(jq -r ".members[$i].command // \"\"" "$tj")"
    prefix="$(  jq -r --arg t "$tui" '.tuiCommands[$t] // ""' "$tj")"

    if [[ -n "$override" ]]; then
      bin="$(_doctor_first_bin "$override")"
    elif [[ -n "$prefix" ]]; then
      bin="$(_doctor_first_bin "$prefix")"
    else
      case "$tui" in
        claude)           bin="${ATMUX_CLAUDE_BIN:-claude}" ;;
        opencode)         bin="${ATMUX_OPENCODE_BIN:-opencode}" ;;
        kimi)             bin="${ATMUX_KIMI_BIN:-kimi}" ;;
        cursor)           bin="${ATMUX_CURSOR_BIN:-cursor-agent}" ;;
        shell|bash|zsh)   continue ;;  # user's $SHELL, always present
        *)
          # Unknown tui type without override — start.sh will die on this.
          _doctor_row red "tui:$tui" "unknown tui type used by $member" \
            "register it in team.tuiCommands or use claude/opencode/kimi/cursor/shell"
          continue ;;
      esac
    fi
    rows+="$bin	$member"$'\n'
  done

  # Group rows by binary, then check each binary once.
  local bin users path
  for bin in $(printf '%s' "$rows" | awk -F'\t' 'NF==2 {print $1}' | sort -u); do
    users="$(printf '%s' "$rows" | awk -F'\t' -v b="$bin" '$1==b {print $2}' | tr '\n' ' ')"
    users="${users% }"
    if path="$(command -v "$bin" 2>/dev/null)"; then
      _doctor_row green "tui:$bin" "$path (members: $users)"
    else
      _doctor_row red "tui:$bin" "NOT on PATH (members: $users)" \
        "install: $(_doctor_install_hint "$bin")"
    fi
  done
}

# Per-member claudeAccount sanity — when a member has
# `claudeAccount: "ifca"`, the spawn cmd prepends `CLAUDE_CONFIG_DIR=
# $HOME/.claude-ifca`. If that directory is missing on disk, claude will
# silently re-run its first-time auth flow on next spawn — surprising the
# operator mid-rotation. This check enumerates members with the field
# set + asserts the resolved dir exists and is readable. red on missing
# (load-bearing — claude flow breaks); silent when no member uses the
# field. Mirrors the per-TUI binary check shape from _doctor_check_tuis.
_doctor_check_claude_accounts() {
  local tj; tj="$(atmux::team_json 2>/dev/null || true)"
  [[ -f "$tj" ]] || return 0
  jq -e . "$tj" >/dev/null 2>&1 || return 0

  local rows
  rows="$(jq -r '
    .members[]?
    | select((.claudeAccount // "") != "" and (.claudeAccount // "") != "default" and (.claudeAccount // "") != "null")
    | [.name, .claudeAccount] | @tsv' "$tj" 2>/dev/null || true)"
  [[ -z "$rows" ]] && return 0

  local member account dir
  while IFS=$'\t' read -r member account; do
    [[ -z "$member" || -z "$account" ]] && continue
    dir="$HOME/.claude-${account}"
    if [[ -d "$dir" && -r "$dir" ]]; then
      _doctor_row green "claude-account:$member" "$dir"
    elif [[ ! -e "$dir" ]]; then
      _doctor_row red "claude-account:$member" \
        "$dir missing on disk" \
        "create the dir + auth: CLAUDE_CONFIG_DIR=$dir claude /login"
    else
      _doctor_row red "claude-account:$member" \
        "$dir exists but unreadable" \
        "chown -R \$USER $dir"
    fi
  done <<<"$rows"
}

_doctor_check_state_dir() {
  local d; d="$(atmux::dir)"
  if [[ ! -d "$d" ]]; then
    # Not fatal — init creates it. Check the parent is writable.
    local parent; parent="$(dirname "$d")"
    if [[ -w "$parent" ]]; then
      _doctor_row yellow "state-dir" "not yet created at $d" "will be created on init/start"
    else
      _doctor_row red "state-dir" "parent $parent is not writable" "chown or pick a different cwd"
    fi
    return
  fi
  if [[ ! -w "$d" ]]; then
    _doctor_row red "state-dir" "$d exists but is not writable" "chown -R \$USER $d"
    return
  fi
  _doctor_row green "state-dir" "writable at $d"
}

# atmux::doctor :: tmux-socket — verify the team's isolated tmuxTmpdir is
# writable + reachable. team.json:.tmuxTmpdir set by lib/init.sh as
# /tmp/atmux-tmpdir-<team> (default per ADR-018) so cron-fired whip /
# report / decisions hit the team's own socket instead of the operator's
# default tmux server. Three states:
#   - red   : path not writable (mkdir -p fails OR -w fails)
#   - yellow: writable but no session yet (cold start, server not running)
#   - green : writable + session reachable
# Silent no-op when team.json is missing or .tmuxTmpdir is unset (legacy
# shared-socket teams predate ADR-018; refusing them would break upgrade
# paths). Per ADR-018 §Decision.
_doctor_check_tmux_tmpdir() {
  local tj; tj="$(atmux::team_json 2>/dev/null)"
  [[ -f "$tj" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local tmpdir=""
  tmpdir="$(jq -r '.tmuxTmpdir // empty' "$tj" 2>/dev/null || true)"
  [[ -z "$tmpdir" || "$tmpdir" == "null" ]] && return 0

  if ! mkdir -p "$tmpdir" 2>/dev/null || [[ ! -w "$tmpdir" ]]; then
    _doctor_row red "tmux-socket" "tmuxTmpdir $tmpdir not writable" \
      "mkdir -p $tmpdir && chown -R \$USER $tmpdir"
    return
  fi

  local socket="$tmpdir/tmux-$(id -u)/default"
  if [[ -S "$socket" ]] && TMUX_TMPDIR="$tmpdir" tmux -S "$socket" ls >/dev/null 2>&1; then
    _doctor_row green "tmux-socket" "isolated $tmpdir healthy"
  else
    _doctor_row yellow "tmux-socket" "isolated tmpdir ready, no session active yet" \
      "atmux start to spin up the team"
  fi
}

_doctor_check_webhook() {
  local tj; tj="$(atmux::team_json 2>/dev/null)"
  local hook=""
  if [[ -n "${ATMUX_DISCORD_WEBHOOK:-}" ]]; then
    hook="$ATMUX_DISCORD_WEBHOOK"
  elif [[ -f "$tj" ]]; then
    hook="$(jq -r '.discord.webhook // ""' "$tj" 2>/dev/null || true)"
  fi

  if [[ -z "$hook" ]]; then
    _doctor_row yellow "discord" "no webhook configured" \
      "set ATMUX_DISCORD_WEBHOOK or team.discord.webhook to enable whip/report pings"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    _doctor_row yellow "discord" "webhook configured but curl missing" \
      "install curl to enable reachability check"
    return
  fi

  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$hook" 2>/dev/null || echo 000)"
  # Discord returns 405 on GET — that proves we reached it.
  # 000 means DNS/connection failure.
  if [[ "$code" == "000" ]]; then
    _doctor_row red "discord" "webhook unreachable (DNS or connection failure)" \
      "check network + verify webhook URL"
  elif [[ "$code" =~ ^[23][0-9][0-9]$ || "$code" == "405" ]]; then
    _doctor_row green "discord" "reachable (HTTP $code)"
  elif [[ "$code" == "401" || "$code" == "403" || "$code" == "404" ]]; then
    _doctor_row red "discord" "webhook rejected (HTTP $code) — likely revoked or wrong URL" \
      "regenerate the webhook in Discord and update the config"
  else
    _doctor_row yellow "discord" "unexpected response HTTP $code — reachable but odd"
  fi
}

# Stale-crontab detector. When the project moves on disk (rename, relocation,
# checkout under a new path), cron entries still point at the old absolute
# path; whip / report / cleanup silently fail until someone re-runs `crontab
# -e`. This check reads the current user's crontab, finds atmux invocations
# (any line containing `atmux whip` / `atmux report` / `atmux cleanup`), and
# warns when ATMUX_DIR / --team-dir embedded in the line doesn't resolve to
# this project's actual .atmux dir.
#
# Yellow on mismatch (not red — many users intentionally run cron against a
# different team than their cwd, e.g. central watchdog of multiple teams).
_doctor_check_crontab() {
  if ! command -v crontab >/dev/null 2>&1; then
    return
  fi
  local cron
  cron="$(crontab -l 2>/dev/null || true)"
  if [[ -z "$cron" ]]; then
    return
  fi

  local atmux_lines
  atmux_lines="$(grep -E 'atmux (whip|report|cleanup|decisions)' <<<"$cron" | grep -v '^#' || true)"
  if [[ -z "$atmux_lines" ]]; then
    return
  fi

  local current_atmux_dir; current_atmux_dir="$(atmux::dir 2>/dev/null || echo)"
  [[ -n "$current_atmux_dir" ]] || return

  # Build a set of registered-team .atmux dirs (real paths). Cron entries
  # pointing to ANY registered team are legitimate multi-team scheduling, not
  # stale config. The orphan-cron check (_doctor_check_cron_orphans) already
  # surfaces entries whose ATMUX_DIR is missing on disk — leaving cron-config
  # as a "this project moved" detector, not a multi-team noise generator.
  local registered_dirs=""
  if [[ -f "$ATMUX_LIB_DIR/registry.sh" ]] \
     && ! declare -F atmux::registry_path >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi
  if declare -F atmux::registry_path >/dev/null 2>&1; then
    local reg; reg="$(atmux::registry_path 2>/dev/null || echo)"
    if [[ -n "$reg" && -f "$reg" ]]; then
      registered_dirs="$(jq -r '.[] | .projectRoot | select(. != null and . != "")' "$reg" 2>/dev/null \
                          | while IFS= read -r root; do
                              [[ -n "$root" ]] || continue
                              readlink -f "$root/.atmux" 2>/dev/null || echo "$root/.atmux"
                            done)"
    fi
  fi

  local mismatched=0 matched=0 known_other=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # Pull either ATMUX_DIR=<path> or --team-dir <path> from the cron line.
    # Tolerate quoting variants but keep the regex narrow — false positives
    # here mean a noisy warning, false negatives mean missed staleness.
    local cron_atmux_dir=""
    if [[ "$line" =~ ATMUX_DIR=([^[:space:]]+) ]]; then
      cron_atmux_dir="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ --team-dir[[:space:]]+([^[:space:]]+) ]]; then
      # --team-dir resolves to <path>/.atmux at runtime
      cron_atmux_dir="${BASH_REMATCH[1]}/.atmux"
    fi
    [[ -z "$cron_atmux_dir" ]] && continue

    if [[ "$cron_atmux_dir" == "$current_atmux_dir" ]]; then
      matched=$((matched + 1))
    else
      # Resolve symlinks before comparing — a moved project where the user
      # added a symlink shim shouldn't trip the warning.
      local cron_real curr_real
      cron_real="$(readlink -f "$cron_atmux_dir" 2>/dev/null || echo "$cron_atmux_dir")"
      curr_real="$(readlink -f "$current_atmux_dir" 2>/dev/null || echo "$current_atmux_dir")"
      if [[ "$cron_real" == "$curr_real" ]]; then
        matched=$((matched + 1))
      elif [[ -n "$registered_dirs" ]] \
           && grep -qxF "$cron_real" <<<"$registered_dirs"; then
        # Cron line points to another registered team — legitimate.
        known_other=$((known_other + 1))
      else
        mismatched=$((mismatched + 1))
      fi
    fi
  done <<< "$atmux_lines"

  if [[ "$mismatched" -gt 0 ]]; then
    _doctor_row yellow "cron-config" \
      "$mismatched atmux cron entr$( ((mismatched==1)) && echo y || echo ies ) point to a different ATMUX_DIR than $current_atmux_dir" \
      "if the project moved, run \`crontab -e\` and update ATMUX_DIR / --team-dir"
  elif [[ "$matched" -gt 0 ]]; then
    local msg="$matched atmux cron entr$( ((matched==1)) && echo y || echo ies ) match this project"
    (( known_other > 0 )) && msg="$msg (+$known_other for other registered team$( ((known_other==1)) || echo s ))"
    _doctor_row green "cron-config" "$msg"
  elif (( known_other > 0 )); then
    _doctor_row green "cron-config" \
      "$known_other atmux cron entr$( ((known_other==1)) && echo y || echo ies ) for other registered team$( ((known_other==1)) || echo s )"
  fi
}

# Orphan-session detector (E7/Sa t-a5216115). After a team migrates to
# singleSession=true, the legacy `atmux-<team>` tmux session may still
# exist (left over from pre-migration starts). Surface it so the user
# can run the migrate verb to consolidate. Skipped silently when the
# team isn't single-session — pre-migration teams legitimately use the
# dedicated session.
#
# No --fix auto-action: the migrate verb has its own pre-flight
# (active-work check) that doctor can't safely re-validate; the row
# hint points the user at the verb.
_doctor_check_orphan_sessions() {
  local single
  single=$(jq -r '.singleSession // false' "$(atmux::team_json)" 2>/dev/null || echo false)

  if [[ "$single" == "true" ]]; then
    # 2026-04-30 reversal — singleSession opts out of cage isolation on
    # the daily-driver socket (where every operator already has 10+
    # unrelated sessions). The side-channel pollution class (cage-prefix
    # leak, partial-rename mess, cross-socket spawn) all exploit this.
    # The launcher-session work in 1c1808b restored the at-a-glance UX
    # benefit on top of cage isolation, so the original ADR-026
    # justification no longer applies. Yellow row points the operator
    # at the migration path; doesn't refuse — existing teams transition
    # opportunistically rather than under pressure.
    _doctor_row yellow "single-session-discouraged" \
      "team has singleSession=true — cage isolation (ADR-018) is now the recommended path" \
      "set team.json:.singleSession=false + add tmuxTmpdir; atmux team migrate-to-cage <team> (when verb lands per umbrella t-36ec8c01)"

    local team_session; team_session="atmux-$(atmux::team_name)"
    if tmux has-session -t "=$team_session" 2>/dev/null; then
      _doctor_row yellow "orphan-session" \
        "team is single-session but legacy session '$team_session' still exists" \
        "run 'atmux migrate-to-driver-session $(atmux::team_name)' to consolidate"
    fi
  fi
}

# Logout-kill exposure detector (E8/Sa t-ebb284b1, ADR-017). systemd
# `KillUserProcesses=yes` (default since systemd ≥230) reaps every
# user-owned process on logout — including the team's tmux server.
# `loginctl enable-linger` is the documented escape hatch. The 2026-04-26
# incident lost two team supervisors mid-flight + a 2h27m orphan
# atmux-spawn before whip cron noticed.
#
# Severity matrix:
#   - Linger=yes                                                                            → green (covered)
#   - Linger=no + KillUserProcesses!=yes                                                    → green (no-kill policy)
#   - Linger=no + KillUserProcesses=yes/unset + session=local-tty             → yellow (driver may accept)
#   - Linger=no + KillUserProcesses=yes/unset + session=ssh                   → red (incident shape)
#
# Skipped silently on macOS / non-systemd hosts — `loginctl` absent
# means the policy doesn't apply.
_doctor_check_logout_kill() {
  command -v loginctl >/dev/null 2>&1 || return 0

  local user; user="$(id -un)"
  local linger
  linger="$(loginctl show-user "$user" --property=Linger 2>/dev/null | sed -n 's/^Linger=//p')"
  [[ -z "$linger" ]] && linger="no"

  if [[ "$linger" == "yes" ]]; then
    _doctor_row green "logout-kill" "linger enabled — tmux survives logout"
    return 0
  fi

  # KillUserProcesses: unset/commented = default `yes` on systemd ≥230.
  # We treat any non-`yes` explicit value as no-kill (most distros that
  # carve out exceptions write `KillUserProcesses=no` literally).
  local kup="yes"
  if [[ -r /etc/systemd/logind.conf ]]; then
    local k
    k="$(grep -E '^[[:space:]]*KillUserProcesses=' /etc/systemd/logind.conf 2>/dev/null \
          | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
    [[ -n "$k" ]] && kup="$k"
  fi
  if [[ "$kup" != "yes" ]]; then
    _doctor_row green "logout-kill" "KillUserProcesses=$kup — tmux survives logout"
    return 0
  fi

  # Session-type detection: prefer loginctl on the current XDG session,
  # fall back to $SSH_CONNECTION presence (covers the case where
  # XDG_SESSION_ID isn't exported, e.g. nohup'd shells).
  local session_type="" remote=""
  if [[ -n "${XDG_SESSION_ID:-}" ]]; then
    session_type="$(loginctl show-session "$XDG_SESSION_ID" --property=Type 2>/dev/null \
                      | sed -n 's/^Type=//p')"
    remote="$(loginctl show-session "$XDG_SESSION_ID" --property=Remote 2>/dev/null \
                      | sed -n 's/^Remote=//p')"
  fi
  local is_ssh="no"
  if [[ "$remote" == "yes" || "$session_type" == "ssh" || -n "${SSH_CONNECTION:-}" ]]; then
    is_ssh="yes"
  fi

  local hint="run 'atmux doctor --fix' to enable linger, or: sudo loginctl enable-linger $user"
  if [[ "$is_ssh" == "yes" ]]; then
    _doctor_row red "logout-kill" \
      "ssh session + Linger=no + KillUserProcesses=$kup — tmux server dies on disconnect" \
      "$hint"
  else
    _doctor_row yellow "logout-kill" \
      "local-tty session + Linger=no + KillUserProcesses=$kup — tmux server dies on logout" \
      "$hint"
  fi
}

# Cron-orphan detector (E6/Sc t-d948b6a0). Lazy-source lib/cron.sh
# since most doctor invocations don't need the cron API. Calls
# atmux::cron_orphans (returns JSON [{team, atmux_dir}, ...] for marker
# blocks whose ATMUX_DIR path is missing on disk) and surfaces one
# yellow row per orphan. Empty / crontab-unavailable returns no rows.
# Mirror-shape with _doctor_check_phantom_inboxes (cleanup-needed, not
# breakage — yellow not red).
_doctor_check_cron_orphans() {
  if [[ -f "$ATMUX_LIB_DIR/cron.sh" ]] && ! declare -F atmux::cron_orphans >/dev/null 2>&1; then
    # shellcheck source=cron.sh
    . "$ATMUX_LIB_DIR/cron.sh"
  fi
  if ! declare -F atmux::cron_orphans >/dev/null 2>&1; then
    return 0
  fi

  local orphans_json
  orphans_json="$(atmux::cron_orphans 2>/dev/null || echo '[]')"
  local n
  n=$(jq -r 'length' <<<"$orphans_json" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  (( n == 0 )) && return 0

  while IFS=$'\t' read -r team atmux_dir; do
    [[ -z "$team" ]] && continue
    _doctor_row yellow "cron-orphan" \
      "team '$team' has orphan cron block — ATMUX_DIR '$atmux_dir' missing on disk" \
      "run 'atmux doctor --fix' OR 'crontab -e' to remove"
  done < <(jq -r '.[] | [.team, .atmux_dir] | @tsv' <<<"$orphans_json")
}

# Stale whip-last.hash detector (E6/S3 t-d0c2e85a A5). Whip writes
# .atmux/state/whip-last.hash on every tick that produces findings (or
# resamples on the power-of-2 backoff schedule). If the session is up
# and the hash mtime is > 24h old, cron is almost certainly broken or
# the cron entry was dropped — surface yellow with a probe hint. Skipped
# silently when no tmux session exists (whip can't run anyway) or when
# the hash file has never been written (cold-start: first whip tick will
# create it, no need to nag).
_doctor_check_whip_hash() {
  local hash_file; hash_file="$(atmux::state_dir)/whip-last.hash"
  [[ -f "$hash_file" ]] || return 0

  if ! atmux::tmux_session_exists 2>/dev/null; then
    return 0
  fi

  local mtime now age_h
  mtime=$(stat -c '%Y' "$hash_file" 2>/dev/null || stat -f '%m' "$hash_file" 2>/dev/null || echo 0)
  [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=0
  now=$(atmux::now_epoch)
  age_h=$(( (now - mtime) / 3600 ))

  if (( age_h >= 24 )); then
    _doctor_row yellow "whip-cron" \
      "whip-last.hash stale (${age_h}h old) — cron likely broken" \
      "check crontab; ATMUX_DEBUG=1 atmux whip --once"
  fi
}

# Topology-invariant check (ADR-027 §invariant check). Confirms each
# running registry entry maps to the right tmux session + correct window
# count, and that the canonical `atmux-superdriver` session is up when
# any team is running. Three severity rows + suggested fixes:
#
#   - red    "topology:<team> session-missing"   — registry says session
#            <S> but `tmux has-session -t <S>` fails AND no other session
#            holds the team's `__<team>__*` windows.
#   - red    "topology:<team> wrong-session"     — registry says <S> but
#            the team's windows live in <T> (T != S).
#   - yellow "topology:<team> window-count"      — windows match the
#            registry session but their count != team.json:.members[]
#            length.
#   - red    "topology:superdriver"              — at least one team is
#            running but `atmux-superdriver` session is absent.
#   - green  on full match.
#
# Skipped silently when: tmux unavailable, jq unavailable, registry empty,
# or atmux::registry_list undefined (lazy-source path matches super-status).
_doctor_check_topology_invariant() {
  command -v tmux >/dev/null 2>&1 || return 0
  command -v jq   >/dev/null 2>&1 || return 0

  if ! declare -F atmux::registry_list >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh" 2>/dev/null || return 0
  fi

  local rjson
  rjson="$(atmux::registry_list --json 2>/dev/null || echo '[]')"
  jq -e . <<<"$rjson" >/dev/null 2>&1 || return 0
  [[ "$(jq 'length' <<<"$rjson")" -gt 0 ]] || return 0

  local running
  running="$(jq -c '[.[] | select(.status == "running")]' <<<"$rjson")"
  local n_running; n_running="$(jq 'length' <<<"$running")"

  # All currently-known tmux sessions — used for wrong-session detection
  # when the registry-claimed session is missing or empty for the team.
  local all_sessions
  all_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"

  local entry name proj sess
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    name="$(jq -r '.name'         <<<"$entry")"
    proj="$(jq -r '.projectRoot'  <<<"$entry")"
    sess="$(jq -r '.sessionName // ""' <<<"$entry")"
    [[ -z "$name" || -z "$sess" ]] && continue

    # Expected member count from the team's own team.json. Treat a
    # missing/invalid file as "unknown expected count" — surface that
    # as a yellow row rather than asserting against 0.
    local tj="$proj/.atmux/team.json"
    local expected=-1
    local team_tmpdir=""
    if [[ -f "$tj" ]] && jq -e . "$tj" >/dev/null 2>&1; then
      expected="$(jq -r '.members | length' "$tj" 2>/dev/null || echo -1)"
      [[ "$expected" =~ ^[0-9]+$ ]] || expected=-1
      # ADR-018: each team may declare its own isolated tmux socket via
      # `tmuxTmpdir`. The bare `tmux has-session` calls below would
      # query the operator's CURRENT TMUX_TMPDIR socket — which sees
      # only the cage of whatever team's project dir doctor was invoked
      # from. Other teams' cages are invisible → false-red topology
      # rows. Resolve the team's own socket here + thread it through
      # `tmux -S <socket>` for the per-team queries. Empty/null →
      # bare tmux (default-socket legacy non-cage'd teams).
      team_tmpdir="$(jq -r '.tmuxTmpdir // empty' "$tj" 2>/dev/null || true)"
      [[ "$team_tmpdir" == "null" ]] && team_tmpdir=""
    fi
    local tmux_q=(tmux)
    [[ -n "$team_tmpdir" ]] && tmux_q=(tmux -S "$team_tmpdir/tmux-$(id -u)/default")

    # Window count in the registry-claimed session. Use `=$sess` exact-match
    # form: bare `tmux has-session -t beta` is a PREFIX match and returns
    # true when only "beta-other" exists, which would silently mark a
    # wrong-session drift as green. Per ADR-027 invariant correctness.
    # Exclude `__<team>__supervisor` — it's an infrastructure window, not a
    # team.json member, and counting it would always overshoot expected by 1
    # for every cage'd team that has a supervisor (the default).
    local in_sess=0
    if "${tmux_q[@]}" has-session -t "=$sess" 2>/dev/null; then
      in_sess="$("${tmux_q[@]}" list-windows -t "=$sess" -F '#{window_name}' 2>/dev/null \
                  | grep "^__${name}__" \
                  | grep -cv "^__${name}__supervisor$" || true)"
      [[ "$in_sess" =~ ^[0-9]+$ ]] || in_sess=0
    fi

    if (( in_sess > 0 )); then
      if (( expected >= 0 )) && (( in_sess != expected )); then
        _doctor_row yellow "topology:$name" \
          "session=$sess has $in_sess windows but team.json expects $expected members" \
          "audit member-by-member: tmux list-windows -t $sess | grep '^__${name}__'"
      else
        _doctor_row green "topology:$name" \
          "session=$sess $in_sess members in $sess:*"
      fi
      continue
    fi

    # Registry-claimed session has no team windows. Look for them in any
    # other session ON THIS TEAM'S SOCKET — drift from a rename or
    # hand-moved windows. Cross-socket drift detection is not in scope
    # (would require enumerating sockets — file follow-up if needed).
    local team_all_sessions
    team_all_sessions="$("${tmux_q[@]}" list-sessions -F '#{session_name}' 2>/dev/null || true)"
    local other_sess="" other_n=0 s n
    while IFS= read -r s; do
      [[ -z "$s" || "$s" == "$sess" ]] && continue
      n="$("${tmux_q[@]}" list-windows -t "=$s" -F '#{window_name}' 2>/dev/null \
            | grep "^__${name}__" \
            | grep -cv "^__${name}__supervisor$" || true)"
      [[ "$n" =~ ^[0-9]+$ ]] || n=0
      if (( n > 0 )); then
        other_sess="$s"
        other_n="$n"
        break
      fi
    done <<<"$team_all_sessions"

    if [[ -n "$other_sess" ]]; then
      _doctor_row red "topology:$name" \
        "registry says session=$sess but $other_n windows live in $other_sess" \
        "atmux team rename $name --session $other_sess --migrate-session OR atmux team rename $name --session $sess"
    else
      _doctor_row red "topology:$name" \
        "session=$sess not found and no other session holds __${name}__ windows" \
        "atmux team rename $name --session <actual> --migrate-session OR restart with atmux start"
    fi
  done < <(jq -c '.[]' <<<"$running")

  # Superdriver: when ≥1 team is running, expect the canonical
  # `atmux_superdriver` session to exist (per ADR-025 — fleet aggregator
  # session, underscore separator per 2026-04-30 fleet-wide naming
  # convention). Absent → red row pointing at `atmux super-attach`.
  if (( n_running > 0 )); then
    if tmux has-session -t =atmux_superdriver 2>/dev/null; then
      _doctor_row green "topology:superdriver" "atmux_superdriver session up"
    else
      _doctor_row red "topology:superdriver" \
        "atmux_superdriver session absent — fleet aggregator unavailable" \
        "atmux super-attach"
    fi
  fi
}

# repair-rename-needed detector (t-2a25f7bd / ADR-027 ADDENDUM 11). For
# each registry team, surface a yellow row when declarative state
# (team.json:.name + registry sessionName) outran imperative live state
# (cage tmpdir basename + cage internal session name + window prefixes).
# The fix is `atmux team repair-rename <team>` — also reused by the
# convention-wide tmpdir hyphen→underscore sweep (t-36ec8c01).
#
# Yellow not red: the team is functional (kanban + panes + work continues
# on the old paths); the drift is an audit/coherence issue, not an
# outage. Red would over-trigger preflight refusals.
_doctor_check_repair_rename_needed() {
  command -v tmux >/dev/null 2>&1 || return 0
  command -v jq   >/dev/null 2>&1 || return 0

  if ! declare -F atmux::registry_list >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh" 2>/dev/null || return 0
  fi
  local rj; rj="$(atmux::registry_list --json 2>/dev/null || echo '[]')"
  jq -e . <<<"$rj" >/dev/null 2>&1 || return 0
  [[ "$(jq 'length' <<<"$rj")" -gt 0 ]] || return 0

  local entry name proj tj tmpdir base derived sock sess stale_count
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    name="$(jq -r '.name'        <<<"$entry")"
    proj="$(jq -r '.projectRoot' <<<"$entry")"
    [[ -n "$name" && -n "$proj" && -d "$proj" ]] || continue
    tj="$proj/.atmux/team.json"
    [[ -f "$tj" ]] || continue
    tmpdir="$(jq -r '.tmuxTmpdir // ""' "$tj" 2>/dev/null)"
    [[ -z "$tmpdir" || "$tmpdir" == "null" ]] && continue

    # Indicator 1: tmpdir basename != team name (after stripping known prefixes).
    base="$(basename "$tmpdir")"
    derived="${base#atmux-tmux-}"
    derived="${derived#atmux_tmux_}"
    derived="${derived#atmux-tmux_}"
    if [[ "$derived" != "$name" && "$base" != "atmux-tmux" ]]; then
      _doctor_row yellow "repair-rename-needed:$name" \
        "tmpdir basename '$base' ≠ team name '$name' (drift)" \
        "atmux team repair-rename $name"
      continue
    fi

    # Indicator 2/3: cage live + session-name or window-prefix mismatch.
    sock="$tmpdir/tmux-0/default"
    [[ -S "$sock" ]] || continue
    sess="$(tmux -S "$sock" list-sessions -F '#{session_name}' 2>/dev/null | head -1)"
    if [[ -n "$sess" && "$sess" != "$name" ]]; then
      _doctor_row yellow "repair-rename-needed:$name" \
        "cage internal session '$sess' ≠ team name '$name' (drift)" \
        "atmux team repair-rename $name"
      continue
    fi
    stale_count="$(tmux -S "$sock" list-windows -a -F '#{window_name}' 2>/dev/null \
      | grep -E '^__[a-z0-9_-]+__' | grep -cv "^__${name}__" 2>/dev/null || true)"
    [[ "$stale_count" =~ ^[0-9]+$ ]] || stale_count=0
    if (( stale_count > 0 )); then
      _doctor_row yellow "repair-rename-needed:$name" \
        "$stale_count window(s) with stale __<old>__* prefix in cage" \
        "atmux team repair-rename $name"
    fi
  done < <(jq -c '.[]' <<<"$rj")
}

# Phantom inbox detector (E6/S3 t-d0c2e85a A6). Consumes
# atmux::find_phantom_inbox_ids — for each entry whose id is in some
# inbox.inProgress[] but missing from kanban.tasks[], surface a yellow
# row. The whip auto-prune sweep (t-5a8d148f) handles ongoing pruning
# in production; doctor fills the operator-driven inspection role +
# `--fix` re-runs the prune for the snapshot the operator just saw.
_doctor_check_phantom_inboxes() {
  if ! declare -F atmux::find_phantom_inbox_ids >/dev/null 2>&1; then
    return 0
  fi
  local phantoms_json
  phantoms_json="$(atmux::find_phantom_inbox_ids 2>/dev/null || echo '[]')"
  local n
  n=$(jq -r 'length' <<<"$phantoms_json" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  (( n == 0 )) && return 0

  while IFS=$'\t' read -r member id subject; do
    [[ -z "$id" || -z "$member" ]] && continue
    _doctor_row yellow "phantom-inbox" \
      "$member inbox.inProgress contains phantom $id (\"$subject\")" \
      "atmux doctor --fix prunes; whip auto-prune sweep also handles in-flight"
  done < <(jq -r '.[] | [.member, .id, (.subject // "")] | @tsv' <<<"$phantoms_json")
}

# Supervisor liveness (ADR-032 §Supervisor lifecycle). Two-signal probe:
# heartbeat-file mtime fresh (< 30s) AND the __<team>__supervisor tmux
# window exists. Either signal stale → yellow row pointing operators at
# `atmux supervisor-start` to re-spawn. Skipped entirely when the team
# opted out via team.json:.supervisor=false (legacy single-process teams).
# Skipped silently when the team's tmux session isn't up — no point
# alarming about a sleeping team.
_doctor_check_supervisor_liveness() {
  local tj; tj="$(atmux::team_json)"
  local optout
  optout="$(jq -r '.supervisor // true' "$tj" 2>/dev/null || echo true)"
  [[ "$optout" == "false" ]] && return 0

  # Per-team cage socket (ADR-018). When doctor is invoked from inside the
  # daily-driver tmux ($TMUX is set), bare `tmux` ignores TMUX_TMPDIR and
  # talks to the daily-driver socket — where __<team>__supervisor never
  # lives. Thread the cage socket explicitly via `tmux -S` like the topology
  # check does. Empty/null tmuxTmpdir → bare tmux (legacy non-cage'd teams).
  local team_tmpdir
  team_tmpdir="$(jq -r '.tmuxTmpdir // empty' "$tj" 2>/dev/null || true)"
  [[ "$team_tmpdir" == "null" ]] && team_tmpdir=""
  local tmux_q=(tmux)
  [[ -n "$team_tmpdir" ]] && tmux_q=(tmux -S "$team_tmpdir/tmux-$(id -u)/default")

  local team session win
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"
  win="__${team}__supervisor"

  "${tmux_q[@]}" has-session -t "=$session" 2>/dev/null || return 0

  local hb_file; hb_file="$(atmux::state_dir)/supervisor.heartbeat"
  local hb_age=-1
  if [[ -f "$hb_file" ]]; then
    local hb_mtime now
    hb_mtime=$(stat -c '%Y' "$hb_file" 2>/dev/null || stat -f '%m' "$hb_file" 2>/dev/null || echo 0)
    [[ "$hb_mtime" =~ ^[0-9]+$ ]] || hb_mtime=0
    now=$(atmux::now_epoch)
    hb_age=$(( now - hb_mtime ))
  fi

  # Literal window-name match — don't go through atmux::tmux_window_exists,
  # which re-runs the input through atmux::window_name and double-prefixes
  # an already-prefixed `__<team>__supervisor` to `__<team>____<team>__supervisor`.
  local win_alive=0
  "${tmux_q[@]}" list-windows -t "=$session" -F '#{window_name}' 2>/dev/null \
    | grep -qx "$win" && win_alive=1

  if (( win_alive == 1 )) && (( hb_age >= 0 )) && (( hb_age < 30 )); then
    _doctor_row green "supervisor-liveness" \
      "$win up + heartbeat ${hb_age}s old"
    return 0
  fi

  if (( win_alive == 0 )) && (( hb_age < 0 )); then
    _doctor_row yellow "supervisor-liveness" \
      "$win missing + no heartbeat file" \
      "atmux supervisor-start (or set team.json:.supervisor=false to opt out)"
    return 0
  fi

  if (( win_alive == 0 )); then
    _doctor_row yellow "supervisor-liveness" \
      "$win window missing (heartbeat ${hb_age}s old — process may have died)" \
      "atmux supervisor-start"
    return 0
  fi

  _doctor_row yellow "supervisor-liveness" \
    "$win up but heartbeat stale (${hb_age}s old; alarm threshold 30s)" \
    "atmux supervisor-stop && atmux supervisor-start"
}

# Wedged bats-exec-test detector. A bats-exec-test process alive longer
# than ATMUX_DOCTOR_WEDGED_BATS_THRESHOLD_S (default 1800s = 30min) is
# almost certainly stuck on a `wait` against an orphan-grandchild —
# the exact shape of the 2026-04-30 socket_pubsub.bats wedge that held
# /var/lock/atmux-autopromote.lock for 13h+ before manual SIGKILL.
# Yellow at threshold; red at 2x. --fix offers SIGKILL of the wedged
# process. Mirrors _doctor_check_supervisor_liveness's shape (probe →
# severity-from-age → action hint).
#
# Skipped silently when no bats-exec-test is running (the common case).
_doctor_check_wedged_bats_exec() {
  command -v pgrep >/dev/null 2>&1 || return 0

  local threshold="${ATMUX_DOCTOR_WEDGED_BATS_THRESHOLD_S:-1800}"
  local red_threshold=$(( threshold * 2 ))

  # Match the actual bats-exec-test script invocation (`bash
  # /usr/libexec/bats-core/bats-exec-test …`), not any process whose
  # commandline merely *contains* the literal `bats-exec-test` (e.g.
  # this very pgrep call, or grep/awk searching for the same string).
  # The `^bash ` anchor + trailing space avoids self-match. Also drop
  # our own PID defensively so a re-arranged pgrep flag set can't
  # surface us as wedged.
  local pids
  pids="$(pgrep -f '^bash .*/bats-exec-test ' 2>/dev/null \
            | grep -v "^$$\$" || true)"
  [[ -z "$pids" ]] && return 0

  local pid age_s
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    age_s="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    [[ "$age_s" =~ ^[0-9]+$ ]] || continue
    if (( age_s >= red_threshold )); then
      _doctor_row red "wedged-bats-exec:$pid" \
        "bats-exec-test pid=$pid alive ${age_s}s (>2× threshold ${threshold}s)" \
        "kill -9 $pid (likely orphan-grandchild wait — see ADR-NEW socket-pubsub PGID teardown)"
    elif (( age_s >= threshold )); then
      _doctor_row yellow "wedged-bats-exec:$pid" \
        "bats-exec-test pid=$pid alive ${age_s}s (>threshold ${threshold}s)" \
        "kill -9 $pid if it stays wedged; check 'pgrep -af socat' for orphan grandchildren"
    fi
  done <<<"$pids"
}

# Iterator helper — yields tab-separated `<name>\t<projectRoot>\t<cage_sock>`
# for every registered cage'd team whose cage socket actually has a session
# matching the team's name. Drops registry status from the gating logic
# entirely (stale/running labels lag the actual cage state by hours; the
# tmux probe is authoritative). Skipped silently if the registry helper
# is unavailable.
_doctor_iter_running_caged_teams() {
  if [[ -f "$ATMUX_LIB_DIR/registry.sh" ]] \
     && ! declare -F atmux::registry_path >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi
  declare -F atmux::registry_path >/dev/null 2>&1 || return 0
  local reg; reg="$(atmux::registry_path)"
  [[ -s "$reg" ]] || return 0

  local name root team_tmpdir cage_sock
  while IFS=$'\t' read -r name root; do
    [[ -z "$name" ]] && continue
    [[ -d "$root/.atmux" ]] || continue
    team_tmpdir=$(jq -r '.tmuxTmpdir // empty' "$root/.atmux/team.json" 2>/dev/null)
    [[ -n "$team_tmpdir" && "$team_tmpdir" != "null" ]] || continue
    cage_sock="$team_tmpdir/tmux-$(id -u)/default"
    # Only emit when the cage server is actually up + has the team's session.
    env -u TMUX tmux -S "$cage_sock" has-session -t "=$name" 2>/dev/null \
      && printf '%s\t%s\t%s\n' "$name" "$root" "$cage_sock"
  done < <(jq -r '.[] | [.name, .projectRoot] | @tsv' "$reg" 2>/dev/null)
}

# Stray-cage-window detector. After the start.sh cage-socket safeguard
# (b39d9f4) any new `atmux start` invoked from outside the cage refuses
# instead of spawning member windows on the daily-driver socket — but
# pre-safeguard pollution can still be sitting there from prior bad
# starts. Probe the daily-driver socket for any window matching
# `^__<team>__` for any cage'd team that has a live cage server. RED row
# per find — these are zombie Claude REPLs consuming tokens on the wrong
# server. Skipped silently when $TMUX is unset (cron path).
_doctor_check_caged_windows_outside_cage() {
  [[ -n "${TMUX:-}" ]] || return 0
  local daily_sock="${TMUX%%,*}"

  # Pre-fetch all daily-driver socket window names once — cheaper than
  # one tmux call per team.
  local all_wins
  all_wins=$(env -u TMUX tmux -S "$daily_sock" list-windows -a -F '#{session_name}|#{window_name}' 2>/dev/null || true)
  [[ -n "$all_wins" ]] || return 0

  local name root cage_sock
  while IFS=$'\t' read -r name root cage_sock; do
    # Daily-driver socket IS the cage socket → no concept of "outside".
    [[ "$daily_sock" == "$cage_sock" ]] && continue

    local strays
    strays=$(awk -F'|' -v p="^__${name}__" '$2 ~ p {print $1 ":" $2}' <<<"$all_wins" || true)
    if [[ -n "$strays" ]]; then
      local count; count=$(wc -l <<<"$strays")
      _doctor_row red "stray-cage:$name" \
        "$count window(s) for cage'd team '$name' live on daily-driver socket — should be in cage at $cage_sock" \
        "tmux kill-window -t \"=<session>:<idx>\" for each (e.g. $(head -1 <<<"$strays")); env -u TMUX atmux start re-spawns into the cage"
    fi
  done < <(_doctor_iter_running_caged_teams)
}

# Daily-driver launcher session detector. For every cage'd team with a
# live cage server, ensure a single-window session named `atmux_<team>`
# exists on the operator's daily-driver socket whose pane runs `tmux -S
# <cage-sock> attach -t <team>` — selecting that session in the daily-
# driver's session list (prefix-s) drops the operator into the team's
# cage in one keystroke. Yellow row per missing launcher; `--fix`
# creates them all. Skipped silently when $TMUX is unset (cron path)
# or when the operator IS currently on the cage's socket.
_doctor_check_daily_driver_launchers() {
  [[ -n "${TMUX:-}" ]] || return 0
  local daily_sock="${TMUX%%,*}"

  local name root cage_sock
  while IFS=$'\t' read -r name root cage_sock; do
    [[ "$daily_sock" == "$cage_sock" ]] && continue
    local launch_sess="atmux_${name}"
    if env -u TMUX tmux -S "$daily_sock" has-session -t "=$launch_sess" 2>/dev/null; then
      _doctor_row green "launcher:$name" \
        "session $launch_sess up on daily-driver"
    else
      _doctor_row yellow "launcher:$name" \
        "missing daily-driver launcher session $launch_sess (one-keystroke jump into cage)" \
        "atmux doctor --fix creates it"
    fi
  done < <(_doctor_iter_running_caged_teams)
}

# ---------- helpers ----------

# Extract the first command-like token from a shell command string,
# skipping KEY=value env assignments.
_doctor_first_bin() {
  local cmd="$1" tok
  # shellcheck disable=SC2086
  set -- $cmd
  for tok in "$@"; do
    case "$tok" in
      *=*) continue ;;
      *)   printf '%s\n' "$tok"; return ;;
    esac
  done
}

_doctor_install_hint() {
  local name="$1"
  local os
  case "$(uname -s)" in
    Darwin) os="brew install $name" ;;
    Linux)  os="apt install $name  (or your distro's equivalent)" ;;
    *)      os="see the project's install docs" ;;
  esac
  case "$name" in
    claude)       echo "https://docs.anthropic.com/en/docs/claude-code" ;;
    opencode)     echo "https://opencode.ai" ;;
    kimi)         echo "https://platform.moonshot.ai" ;;
    cursor-agent) echo "https://cursor.com/cli" ;;
    *)            echo "$os" ;;
  esac
}

# ---------- output ----------

_doctor_render_human() {
  printf '\n%s🩺 atmux doctor%s — environment check\n\n' "$atmux_c_cyn" "$atmux_c_rst" >&2
  local row status label detail hint glyph color
  for row in "${_doctor_rows[@]}"; do
    IFS='|' read -r status label detail hint <<<"$row"
    case "$status" in
      green)  glyph='✅'; color="$atmux_c_grn" ;;
      yellow) glyph='⚠️ '; color="$atmux_c_yel" ;;
      red)    glyph='❌'; color="$atmux_c_red" ;;
    esac
    printf '  %s %s%-22s%s %s\n' "$glyph" "$color" "$label" "$atmux_c_rst" "$detail" >&2
    if [[ -n "$hint" && "$status" != "green" ]]; then
      printf '     %s→ %s%s\n' "$atmux_c_dim" "$hint" "$atmux_c_rst" >&2
    fi
  done
  echo >&2
  if [[ "$_doctor_red_count" -eq 0 && "$_doctor_yellow_count" -eq 0 ]]; then
    printf '  %s✅ all green%s\n\n' "$atmux_c_grn" "$atmux_c_rst" >&2
  elif [[ "$_doctor_red_count" -eq 0 ]]; then
    printf '  %s⚠️  %d warning(s), no blockers%s\n\n' \
      "$atmux_c_yel" "$_doctor_yellow_count" "$atmux_c_rst" >&2
  else
    printf '  %s❌ %d issue(s)%s — run with %s--fix%s to remediate\n\n' \
      "$atmux_c_red" "$_doctor_red_count" "$atmux_c_rst" "$atmux_c_bld" "$atmux_c_rst" >&2
  fi
}

_doctor_render_json() {
  local row status label detail hint first=1
  printf '{"red":%d,"yellow":%d,"checks":[' \
    "$_doctor_red_count" "$_doctor_yellow_count"
  for row in "${_doctor_rows[@]}"; do
    IFS='|' read -r status label detail hint <<<"$row"
    [[ "$first" -eq 0 ]] && printf ','
    first=0
    jq -cn \
      --arg s "$status" --arg l "$label" --arg d "$detail" --arg h "$hint" \
      '{status:$s, label:$l, detail:$d, hint:$h}'
  done
  # Include the verify-libs detailed report for downstream tooling that
  # wants to surface per-lib status (`null` when the check didn't run or
  # produced unparseable output — distinct from "no libs found").
  if [[ -n "$_doctor_verify_libs_json" ]] \
     && jq -e . <<<"$_doctor_verify_libs_json" >/dev/null 2>&1; then
    printf '],"libs":%s}\n' "$_doctor_verify_libs_json"
  else
    printf '],"libs":null}\n'
  fi
}

_doctor_try_fix() {
  # Three fix paths: the existing team.json wizard (only on red), the
  # cleanup-driven log/inbox sweep, and the phantom-inbox pruner. All of
  # the safe ones run whenever --fix is passed, regardless of red/yellow
  # status — operator opted in.
  _doctor_try_fix_cleanup
  _doctor_try_fix_phantom_inboxes
  _doctor_try_fix_cron_orphans
  _doctor_try_fix_logout_kill
  _doctor_try_fix_daily_driver_launchers
  _doctor_try_fix_daily_driver_prefix_leak

  [[ "$_doctor_red_count" -eq 0 ]] && return 0

  # The one failure we CAN auto-remediate is missing / invalid team.json — offer the wizard.
  local row status label detail
  for row in "${_doctor_rows[@]}"; do
    IFS='|' read -r status label detail _ <<<"$row"
    [[ "$status" == "red" ]] || continue
    if [[ "$label" == "team.json" ]]; then
      printf '\n%s🧙 atmux%s  team.json is the fixable issue — re-run wizard? %s[Y/n]%s: ' \
        "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_dim" "$atmux_c_rst" >&2
      local ans; IFS= read -r ans || ans=""
      case "$ans" in
        ""|y|Y|yes|YES)
          local tj; tj="$(atmux::team_json)"
          if [[ -f "$tj" ]]; then
            cp "$tj" "$tj.broken.$(date +%s)"
            atmux::warn "backed up existing team.json before overwrite"
          fi
          exec "$ATMUX_BIN_DIR/atmux" init --force --wizard ;;
        *) : ;;
      esac
    fi
  done

  atmux::warn "remaining issues need manual remediation — see hints above"
}

# Run cleanup as part of `doctor --fix`. Idempotent — running it on a
# clean tree is a no-op + a "0 rotated, 0 pruned" status line. Doesn't
# count as a fixable item in _doctor_red_count tally; it's preventative
# maintenance rather than red-state remediation. Skipped silently if
# cleanup verb isn't available (defensive — bin/atmux always routes it,
# but let's keep doctor robust if a future refactor moves it).
_doctor_try_fix_cleanup() {
  if [[ ! -f "$ATMUX_LIB_DIR/cleanup.sh" ]]; then
    return 0
  fi
  printf '\n%s🧹 atmux%s  doctor --fix: running cleanup all\n' \
    "$atmux_c_cyn" "$atmux_c_rst" >&2
  "$ATMUX_BIN_DIR/atmux" cleanup all >&2 || true
}

# Prune phantom inProgress[] entries detected by
# _doctor_check_phantom_inboxes. Re-runs find_phantom_inbox_ids so the
# fix is independent of the row state captured during the check pass —
# matters when --fix runs after a slow check that another writer might
# have raced. atmux::jq_update for the prune (ADR-013). Idempotent: a
# clean tree exits silently with a "0 pruned" line.
_doctor_try_fix_phantom_inboxes() {
  if ! declare -F atmux::find_phantom_inbox_ids >/dev/null 2>&1; then
    return 0
  fi
  local phantoms_json
  phantoms_json="$(atmux::find_phantom_inbox_ids 2>/dev/null || echo '[]')"
  local n
  n=$(jq -r 'length' <<<"$phantoms_json" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  if (( n == 0 )); then
    printf '%s🩹 atmux%s  doctor --fix: 0 phantom inbox entries\n' \
      "$atmux_c_cyn" "$atmux_c_rst" >&2
    return 0
  fi

  printf '\n%s🩹 atmux%s  doctor --fix: pruning %d phantom inbox entr%s\n' \
    "$atmux_c_cyn" "$atmux_c_rst" "$n" "$( ((n==1)) && echo y || echo ies )" >&2

  local member id subject ib
  while IFS=$'\t' read -r member id subject; do
    [[ -z "$id" || -z "$member" ]] && continue
    ib="$(atmux::inbox_dir)/$member.json"
    if [[ -f "$ib" ]]; then
      atmux::jq_update "$ib" \
        '.inProgress = ((.inProgress // []) | map(select(.id != $id)))' \
        --arg id "$id"
      printf '  ✅ pruned phantom %s from %s ("%s")\n' "$id" "$member" "$subject" >&2
    fi
  done < <(jq -r '.[] | [.member, .id, (.subject // "")] | @tsv' <<<"$phantoms_json")
}

# Prune orphan cron blocks detected by _doctor_check_cron_orphans
# (E6/Sc t-d948b6a0). Re-runs atmux::cron_orphans so the fix is
# independent of the row state captured during the check pass — matters
# under concurrent crontab edits. atmux::cron_remove handles the actual
# block deletion (idempotent — a clean tree exits silently with the
# "0 orphan blocks" line below). Skipped silently if cron.sh isn't
# loadable (cron API missing on this host).
_doctor_try_fix_cron_orphans() {
  if [[ -f "$ATMUX_LIB_DIR/cron.sh" ]] && ! declare -F atmux::cron_orphans >/dev/null 2>&1; then
    # shellcheck source=cron.sh
    . "$ATMUX_LIB_DIR/cron.sh"
  fi
  if ! declare -F atmux::cron_orphans >/dev/null 2>&1; then
    return 0
  fi

  local orphans_json
  orphans_json="$(atmux::cron_orphans 2>/dev/null || echo '[]')"
  local n
  n=$(jq -r 'length' <<<"$orphans_json" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  if (( n == 0 )); then
    printf '%s🧹 atmux%s  doctor --fix: 0 orphan cron blocks\n' \
      "$atmux_c_cyn" "$atmux_c_rst" >&2
    return 0
  fi

  printf '\n%s🧹 atmux%s  doctor --fix: pruning %d orphan cron block%s\n' \
    "$atmux_c_cyn" "$atmux_c_rst" "$n" "$( ((n==1)) && echo "" || echo "s" )" >&2

  local team atmux_dir
  while IFS=$'\t' read -r team atmux_dir; do
    [[ -z "$team" ]] && continue
    if atmux::cron_remove "$team"; then
      atmux::ok "pruned orphan cron block for team $team (was → $atmux_dir)"
    fi
  done < <(jq -r '.[] | [.team, .atmux_dir] | @tsv' <<<"$orphans_json")
}

# Enable linger for the current user (E8/Sa t-ebb284b1, ADR-017 OQ1).
# Idempotent: if Linger=yes already, no-op + return 0. On EPERM (typical
# for non-root users without polkit auth), prints the sudo invocation
# hint and returns non-zero — automatic sudo elevation is intentionally
# off (operator must opt in by re-running with sudo). Skipped silently
# on macOS / non-systemd hosts where loginctl is absent.
_doctor_try_fix_logout_kill() {
  command -v loginctl >/dev/null 2>&1 || return 0

  local user; user="$(id -un)"
  local linger
  linger="$(loginctl show-user "$user" --property=Linger 2>/dev/null | sed -n 's/^Linger=//p')"
  if [[ "$linger" == "yes" ]]; then
    return 0
  fi

  printf '\n%s🛡️  atmux%s  doctor --fix: enabling linger for %s\n' \
    "$atmux_c_cyn" "$atmux_c_rst" "$user" >&2

  if loginctl enable-linger "$user" 2>/dev/null; then
    atmux::ok "linger enabled for $user — tmux server now survives logout"
    return 0
  fi

  printf '%s⚠️  atmux%s  loginctl enable-linger refused (likely EPERM). Run manually:\n' \
    "$atmux_c_cyn" "$atmux_c_rst" >&2
  printf '    sudo loginctl enable-linger %s\n' "$user" >&2
  return 1
}

# Create daily-driver launcher sessions for every running cage'd team
# that doesn't already have one. Each launcher = single-window session
# `atmux_<team>` whose pane execs `tmux -S <cage-sock> attach -t <team>`,
# so prefix-s in daily-driver lists every team and one keystroke jumps
# into the cage. Idempotent — already-present launchers are silent.
# Skipped silently when $TMUX is unset (no daily-driver to populate;
# cron path) or when registry is unavailable.
# Cage-prefix-leak detector. The cage convention is `C-\` (set on every
# cage server by start.sh — gated to TMUX_TMPDIR=*/atmux-tmux*). Any
# daily-driver server reporting `C-\` strongly suggests it was clobbered
# by a pre-b39d9f4 `atmux start` invoked with $TMUX pointing at the
# daily-driver socket — the bare `tmux set-option -g prefix 'C-\'` ran
# on the wrong server because $TMUX overrides $TMUX_TMPDIR. The
# safeguard at start.sh:54-79 prevents new occurrences but pre-existing
# pollution sticks until restored. Yellow row + `--fix` re-sources
# ~/.tmux.conf to put back whatever the operator's config defines (no
# baked-in default value — the operator might use C-a, C-b, C-Space,
# etc., and we don't want doctor to know better than .tmux.conf).
#
# Skipped silently when:
#   - $TMUX is unset (no daily-driver to inspect)
#   - the daily-driver socket IS a cage socket (operator inside cage)
#   - daily-driver prefix is anything other than C-\ (no leak signal)
_doctor_check_daily_driver_prefix_leak() {
  [[ -n "${TMUX:-}" ]] || return 0
  local daily_sock="${TMUX%%,*}"

  # If we ARE on a cage socket, C-\ is the expected value, not a leak.
  case "$daily_sock" in
    */atmux-tmux*/tmux-*/default) return 0 ;;
  esac

  local current
  current="$(env -u TMUX tmux -S "$daily_sock" show-options -gv prefix 2>/dev/null || true)"
  [[ "$current" == 'C-\' ]] || return 0

  local hint="atmux doctor --fix re-sources ~/.tmux.conf"
  [[ -f "$HOME/.tmux.conf" ]] || hint="set the prefix back manually: tmux set-option -g prefix <YourKey>"

  _doctor_row yellow "daily-driver-prefix-leak" \
    "daily-driver prefix is C-\\ (cage convention) — likely clobbered by a pre-b39d9f4 atmux start" \
    "$hint"
}

_doctor_try_fix_daily_driver_launchers() {
  [[ -n "${TMUX:-}" ]] || return 0
  local daily_sock="${TMUX%%,*}"

  printf '\n%s🚀 atmux%s  doctor --fix: ensuring daily-driver launchers\n' \
    "$atmux_c_cyn" "$atmux_c_rst" >&2

  local created=0 skipped=0
  local name root cage_sock
  while IFS=$'\t' read -r name root cage_sock; do
    [[ "$daily_sock" == "$cage_sock" ]] && continue

    local launch_sess="atmux_${name}"
    if env -u TMUX tmux -S "$daily_sock" has-session -t "=$launch_sess" 2>/dev/null; then
      skipped=$((skipped + 1))
      continue
    fi

    if env -u TMUX tmux -S "$daily_sock" new-session -d -s "$launch_sess" \
        -n "$name" \
        "exec env -u TMUX tmux -S '$cage_sock' attach-session -t '$name'" 2>/dev/null; then
      created=$((created + 1))
      printf '  ✅ created %s → %s\n' "$launch_sess" "$cage_sock" >&2
    else
      printf '  ❌ failed to create %s\n' "$launch_sess" >&2
    fi
  done < <(_doctor_iter_running_caged_teams)

  printf '%s🚀 atmux%s  doctor --fix: %d launcher(s) created, %d already up\n' \
    "$atmux_c_cyn" "$atmux_c_rst" "$created" "$skipped" >&2
}

# Re-source ~/.tmux.conf on the daily-driver socket to restore the
# operator's intended prefix when a cage-prefix leak was detected.
# Idempotent — no-op when ~/.tmux.conf is missing or when the prefix
# isn't currently the cage value.
_doctor_try_fix_daily_driver_prefix_leak() {
  [[ -n "${TMUX:-}" ]] || return 0
  local daily_sock="${TMUX%%,*}"
  case "$daily_sock" in
    */atmux-tmux*/tmux-*/default) return 0 ;;
  esac

  local current
  current="$(env -u TMUX tmux -S "$daily_sock" show-options -gv prefix 2>/dev/null || true)"
  [[ "$current" == 'C-\' ]] || return 0

  if [[ ! -f "$HOME/.tmux.conf" ]]; then
    printf '\n%s🛠️  atmux%s  doctor --fix: ~/.tmux.conf missing — restore prefix manually\n' \
      "$atmux_c_cyn" "$atmux_c_rst" >&2
    return 1
  fi

  printf '\n%s🛠️  atmux%s  doctor --fix: re-sourcing ~/.tmux.conf to restore daily-driver prefix\n' \
    "$atmux_c_cyn" "$atmux_c_rst" >&2

  if env -u TMUX tmux -S "$daily_sock" source-file "$HOME/.tmux.conf" 2>/dev/null; then
    local after
    after="$(env -u TMUX tmux -S "$daily_sock" show-options -gv prefix 2>/dev/null || true)"
    if [[ "$after" == 'C-\' ]]; then
      printf '  %s⚠️%s  prefix still C-\\ after source-file — your config explicitly sets C-\\?\n' \
        "$atmux_c_cyn" "$atmux_c_rst" >&2
    else
      atmux::ok "daily-driver prefix restored to $after"
    fi
  else
    printf '  ❌ source-file failed — restore manually: tmux source-file ~/.tmux.conf\n' >&2
  fi
}
