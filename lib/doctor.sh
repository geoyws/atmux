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
  _doctor_check_state_dir
  _doctor_check_webhook
  _doctor_check_crontab
  _doctor_check_cron_orphans
  _doctor_check_orphan_sessions
  _doctor_check_whip_hash
  _doctor_check_phantom_inboxes
  _doctor_check_logout_kill

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

  local mismatched=0 matched=0
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
    _doctor_row green "cron-config" "$matched atmux cron entr$( ((matched==1)) && echo y || echo ies ) match this project"
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
  [[ "$single" == "true" ]] || return 0

  local team_session; team_session="atmux-$(atmux::team_name)"
  if tmux has-session -t "$team_session" 2>/dev/null; then
    _doctor_row yellow "orphan-session" \
      "team is single-session but legacy session '$team_session' still exists" \
      "run 'atmux migrate-to-driver-session $(atmux::team_name)' to consolidate"
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
