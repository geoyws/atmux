#!/usr/bin/env bash
# lib/unblocker.sh — `atmux unblocker tick` per-tick blocker triage.
#
# Cron'd at 2-min cadence (per ADR-021 §Decision OQ C1) by lib/cron.sh
# when a team has a `role: unblocker` member declared. This verb is
# detect+classify+route only — never claims tasks, never auto-mutates
# kanban (no blocked → todo flip), never tmux send-keys '/clear' (lead's
# call), never plans.
#
# Per-tick flow:
#   1. flock guard (.atmux/state/unblocker.lock) — single instance.
#   2. Skip if a team-rename is in flight (.atmux/state/rename.lock).
#   3. Read kanban → enumerate candidate tasks:
#        - status == "blocked"   (any), OR
#        - status == "in-progress" AND claimedAt + 30min < now
#                              AND no commit-Task downstream
#          (downstream = a task with .createdFrom.parentTaskId == $id
#                        AND .subject startswith "commit ").
#   4. For each candidate: tmux capture-pane -p -t <window> -S -50 |
#      tail -30 → classify into one of:
#        - WEDGED                       Compacting / hit your limit /
#                                       queued-msg backbuffer / Now using
#                                       extra usage / permission-prompt.
#        - WEDGED-WITH-DRIVER-NEEDED    auth flow / network-down / 401 /
#                                       ENOTFOUND outside scope.
#        - LEGITIMATELY-SLOW            active build/test/network output
#                                       OR recent commit cited in the pane.
#        - IDLE                         no banner, no error, no progress
#                                       in the captured window.
#   5. Action per classification:
#        - WEDGED                     → atmux reply (lead-outbox) with
#                                       classification + pane paste.
#        - WEDGED-WITH-DRIVER-NEEDED  → atmux reply (lead-outbox) tagged
#                                       'needs driver'.
#        - IDLE                       → atmux send <member> "still on
#                                       $task_id?"; append nudge to
#                                       .atmux/state/unblocker-nudges.log.
#        - LEGITIMATELY-SLOW          → no action.
#   6. Rate-limit each (task_id, classification) action via
#      .atmux/state/unblocker-ledger.json so consecutive ticks don't
#      double-nudge / double-escalate. Suppression: 15min for IDLE
#      nudges, 30min for WEDGED / WEDGED-WITH-DRIVER-NEEDED escalations.
#   7. Roll up findings into a Discord embed via atmux::discord_embed_ping
#      (folds with SA_T1's embed shape — per ADR-019).
#
# Files: lib/unblocker.sh + bin/atmux dispatcher entry. No new state
# schema beyond the two ledger files above; both are JSON, atomic-written
# via atmux::jq_update.
#
# Refs: ADR-021 §Decision (role spec), CLAUDE.md "Always read pane state
# BEFORE tmux send-keys" (we capture-then-classify-then-act).

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"

# ---- tunables (env-overridable) ----------------------------------------
ATMUX_UNBLOCKER_STALE_MIN="${ATMUX_UNBLOCKER_STALE_MIN:-30}"
ATMUX_UNBLOCKER_PANE_LINES="${ATMUX_UNBLOCKER_PANE_LINES:-50}"
ATMUX_UNBLOCKER_PANE_TAIL="${ATMUX_UNBLOCKER_PANE_TAIL:-30}"
ATMUX_UNBLOCKER_NUDGE_DEBOUNCE_SEC="${ATMUX_UNBLOCKER_NUDGE_DEBOUNCE_SEC:-900}"
ATMUX_UNBLOCKER_ESCALATE_DEBOUNCE_SEC="${ATMUX_UNBLOCKER_ESCALATE_DEBOUNCE_SEC:-1800}"

main() {
  local sub="${1:-tick}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    tick)      atmux::unblocker_tick "$@" ;;
    -h|--help) _atmux_unblocker_usage ;;
    *)         atmux::die "unblocker: unknown subverb '$sub' (try: tick)" ;;
  esac
}

_atmux_unblocker_usage() {
  cat <<'EOF'
atmux unblocker tick

  Per-tick blocker triage (cron'd at 2-min cadence). Read-only on kanban;
  classifies wedged / idle / legitimately-slow / wedged-with-driver-needed
  panes and routes via atmux send (member nudge) or atmux reply (lead-outbox).

  Never claims tasks, never auto-mutates kanban, never tmux send-keys '/clear'.
EOF
}

atmux::unblocker_tick() {
  atmux::require jq tmux flock
  atmux::require_team

  # Skip the tick during a team-rename window — mirrors whip's same-shape
  # guard. Reading a half-renamed kanban / tmux topology produces phantom
  # findings that would all flip back next tick. Cleared by team-rename's
  # step 7 (or by rollback). Read-only file-test; no flock needed.
  if [[ -f "$(atmux::state_dir)/rename.lock" ]]; then
    atmux::log "unblocker: rename in progress — skipping tick"
    return 0
  fi

  # Single-instance flock — mirrors lib/whip.sh:53–59. Non-blocking; a
  # contended lock skips this tick rather than queueing on the next cron
  # tick. Releases automatically on exit.
  local _ub_lock; _ub_lock="$(atmux::state_dir)/unblocker.lock"
  mkdir -p "$(dirname "$_ub_lock")"
  exec 9>"$_ub_lock"
  if ! flock -n 9; then
    atmux::log "unblocker: another instance is running — skipping this tick"
    return 0
  fi

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  if ! atmux::tmux_session_exists; then
    atmux::log "unblocker: session $session is DOWN — skipping tick"
    return 0
  fi

  local now; now="$(atmux::now_epoch)"
  local ts;  ts="$(atmux::now_myt)"
  local k;   k="$(atmux::kanban_json)"
  if [[ ! -f "$k" ]]; then
    atmux::log "unblocker: no kanban — skipping tick"
    return 0
  fi

  local stale_sec=$(( ATMUX_UNBLOCKER_STALE_MIN * 60 ))

  # Candidates as TSV: id<TAB>owner<TAB>status<TAB>subject
  #
  # Commit-Tasks (subject starts with "commit ") are excluded from the
  # candidate set: they're gitter's auto-minted downstream work, and
  # their staleness is a different signal class (gitter wedged on a
  # commit, not the parent worker stuck on a feature). A future
  # `gitter-stale` detector can pick those up; v1 unblocker focuses on
  # the parent worker queue.
  local candidates_tsv
  candidates_tsv="$(jq -r --argjson now "$now" --argjson stale "$stale_sec" '
    .tasks as $all
    | .tasks[]?
    | . as $t
    | select(((.subject // "") | startswith("commit ")) | not)
    | select(
        .status == "blocked"
        or (
          .status == "in-progress"
          and (.claimedAt // 0) > 0
          and ((.claimedAt // 0) + $stale) < $now
          and ([
                $all[]?
                | select(.createdFrom.parentTaskId == $t.id
                         and ((.subject // "") | startswith("commit ")))
               ] | length == 0)
        )
      )
    | [.id, (.owner // ""), .status, (.subject // "")]
    | @tsv
  ' "$k" 2>/dev/null || true)"

  local findings=()
  local nudge_log; nudge_log="$(atmux::state_dir)/unblocker-nudges.log"
  mkdir -p "$(dirname "$nudge_log")"

  if [[ -z "$candidates_tsv" ]]; then
    atmux::log "unblocker: no candidates — all clean"
    _atmux_unblocker_log_tick "$ts" "$team" 0 0 0 0
    return 0
  fi

  local n_wedged=0 n_driver=0 n_idle=0 n_slow=0

  local id owner _status subject
  while IFS=$'\t' read -r id owner _status subject; do
    [[ -z "$id" ]] && continue
    [[ -z "$owner" ]] && {
      atmux::log "unblocker: $id has no owner — skipping (kanban may be mid-mutation)"
      continue
    }

    if ! atmux::tmux_window_exists "$owner"; then
      findings+=("🛑 \`$id\` owner \`$owner\`: window missing — surface to lead")
      _atmux_unblocker_escalate "$id" "$owner" "WEDGED" \
        "(window missing for owner \`$owner\` — possible crash; tasks: $subject)"
      n_wedged=$((n_wedged + 1))
      continue
    fi

    # TUI-crash gate: per `feedback_atmux_send_zsh_state` memory, a pane
    # that's dropped to zsh/bash will accept `atmux send` text as a shell
    # command — `still on t-foo?` then errors out as command-not-found
    # AND glob-expansion on the `?`. Treat any pane whose current_command
    # mismatches the declared TUI as a WEDGED case; surface to lead with a
    # 'TUI crashed' hint instead of silently nudging into a shell.
    if ! _atmux_unblocker_pane_running_tui "$owner"; then
      if _atmux_unblocker_should_act "$id" "WEDGED" "$ATMUX_UNBLOCKER_ESCALATE_DEBOUNCE_SEC" "$now"; then
        local crashed_state
        crashed_state="$(_atmux_unblocker_capture "$owner")"
        _atmux_unblocker_escalate "$id" "$owner" "WEDGED" \
          "(pane current_command != declared TUI — likely crashed)
$crashed_state"
        findings+=("🛑 \`$id\` (\`$owner\`): pane dropped to shell — surfaced to lead")
        n_wedged=$((n_wedged + 1))
      else
        atmux::log "unblocker: $id pane=shell debounced"
      fi
      continue
    fi

    local state; state="$(_atmux_unblocker_capture "$owner")"
    local cls;   cls="$(_atmux_unblocker_classify "$state" "$id" "$owner")"

    case "$cls" in
      WEDGED)
        if _atmux_unblocker_should_act "$id" "$cls" "$ATMUX_UNBLOCKER_ESCALATE_DEBOUNCE_SEC" "$now"; then
          _atmux_unblocker_escalate "$id" "$owner" "$cls" "$state"
          findings+=("🛑 \`$id\` (\`$owner\`): WEDGED — surfaced to lead-outbox")
          n_wedged=$((n_wedged + 1))
        else
          atmux::log "unblocker: $id WEDGED debounced (within ${ATMUX_UNBLOCKER_ESCALATE_DEBOUNCE_SEC}s)"
        fi
        ;;
      WEDGED-WITH-DRIVER-NEEDED)
        if _atmux_unblocker_should_act "$id" "$cls" "$ATMUX_UNBLOCKER_ESCALATE_DEBOUNCE_SEC" "$now"; then
          _atmux_unblocker_escalate "$id" "$owner" "$cls" "$state"
          findings+=("🚨 \`$id\` (\`$owner\`): needs driver — surfaced to lead-outbox")
          n_driver=$((n_driver + 1))
        else
          atmux::log "unblocker: $id WEDGED-WITH-DRIVER-NEEDED debounced"
        fi
        ;;
      IDLE)
        if _atmux_unblocker_should_act "$id" "$cls" "$ATMUX_UNBLOCKER_NUDGE_DEBOUNCE_SEC" "$now"; then
          _atmux_unblocker_nudge "$id" "$owner" "$nudge_log" "$now"
          findings+=("⏰ \`$id\` (\`$owner\`): IDLE — nudged")
          n_idle=$((n_idle + 1))
        else
          atmux::log "unblocker: $id IDLE debounced (within ${ATMUX_UNBLOCKER_NUDGE_DEBOUNCE_SEC}s)"
        fi
        ;;
      LEGITIMATELY-SLOW)
        # No action — pane shows real progress. Logged for the tick log so
        # operators can see why a stale task wasn't escalated.
        atmux::log "unblocker: $id (\`$owner\`) LEGITIMATELY-SLOW — no action"
        n_slow=$((n_slow + 1))
        ;;
    esac
  done <<< "$candidates_tsv"

  _atmux_unblocker_log_tick "$ts" "$team" "$n_wedged" "$n_driver" "$n_idle" "$n_slow"

  if [[ "${#findings[@]}" -gt 0 ]]; then
    local body="🩹 **[unblocker]** · \`$team\` · $ts"
    body+=$'\n'
    local f
    for f in "${findings[@]}"; do
      body+=$'\n- '"$f"
    done
    ATMUX_DISCORD_TRIGGER="${ATMUX_DISCORD_TRIGGER:-unblocker}" \
      atmux::discord_embed_ping "$body"
  fi
}

# True when the owner's pane is running the team-declared TUI (claude /
# opencode / kimi / cursor-agent). False when the pane has dropped to a
# shell — typically because the TUI crashed or the user manually quit
# it. Mirrors lib/whip.sh:152-164's pane-command detector. The list of
# accepted commands per TUI is intentionally narrow: a `claude` TUI pane
# whose current_command is `node` (CC-spawned subshell) is the only
# common false-positive, and `node` is allowlisted.
_atmux_unblocker_pane_running_tui() {
  local member="$1"
  local target; target="$(atmux::tmux_target "$member")"
  local pane_cmd
  pane_cmd="$(tmux list-panes -t "$target" -F '#{pane_current_command}' 2>/dev/null \
              | head -1 || true)"
  [[ -z "$pane_cmd" ]] && return 1

  local tui
  tui="$(jq -r --arg m "$member" \
          '.members[] | select(.name == $m) | .tui // "claude"' \
          "$(atmux::team_json)" 2>/dev/null || echo claude)"

  case "$tui" in
    claude)   [[ "$pane_cmd" == "claude"   || "$pane_cmd" == "node" ]] ;;
    opencode) [[ "$pane_cmd" == "opencode" || "$pane_cmd" == "node" ]] ;;
    kimi)     [[ "$pane_cmd" == "kimi"     || "$pane_cmd" == "node" ]] ;;
    cursor)   [[ "$pane_cmd" == "cursor-agent" || "$pane_cmd" == "node" ]] ;;
    shell)    return 0 ;;  # `tui:shell` panes are intentionally bare; never WEDGED on this gate.
    *)        return 0 ;;  # Unknown TUI declarations stay permissive.
  esac
}

# Capture pane via the AC-prescribed shape: -S -50 | tail -30. We don't
# reuse atmux::capture_pane directly because the AC explicitly names the
# 50-line scrollback + 30-line tail pair (longer scrollback so a queued-
# msg banner that was scrolled up but is still the active state remains
# in the captured window).
_atmux_unblocker_capture() {
  local member="$1"
  local target; target="$(atmux::tmux_target "$member")"
  tmux capture-pane -p -t "$target" -S "-$ATMUX_UNBLOCKER_PANE_LINES" 2>/dev/null \
    | tail -n "$ATMUX_UNBLOCKER_PANE_TAIL" || true
}

# Classify pane state. Order matters: most specific first. Returns one of
# WEDGED | WEDGED-WITH-DRIVER-NEEDED | LEGITIMATELY-SLOW | IDLE on stdout.
_atmux_unblocker_classify() {
  local state="$1" id="$2" owner="$3"

  # WEDGED-WITH-DRIVER-NEEDED — auth / network classes outside the
  # member's autonomous scope. Surfaced ahead of WEDGED so a 401-on-clear
  # routes to driver instead of looping the lead through /clear theater.
  if echo "$state" | grep -qiE \
       'gh auth login|please authenticate|401 unauthorized|403 forbidden|invalid_grant|ENOTFOUND|ECONNREFUSED|getaddrinfo|network is unreachable|EAI_AGAIN|ssl handshake failed'; then
    printf 'WEDGED-WITH-DRIVER-NEEDED\n'
    return 0
  fi

  # WEDGED — Claude Code modal / rate-limit / queued-message backbuffer.
  # Mirrors lib/whip.sh's banner detectors so a tick that wedges past
  # whip's 5-min cadence still gets seen here at 2-min.
  if echo "$state" | grep -qiE \
       'Compacting conversation|hit your limit|Press up to edit queued messages|Now using extra usage|Context cleared\.[[:space:]]*Ready for|Do you want to (proceed|allow)|Permission required'; then
    printf 'WEDGED\n'
    return 0
  fi

  # LEGITIMATELY-SLOW — pane is mid-turn (Claude actively running) OR a
  # commit citing $id has landed since the claim. The first signal is
  # cheap (regex on captured state); the second requires a git log shell-
  # out, gated on the cheap check failing.
  if echo "$state" | grep -qiE \
       'Esc to interrupt|tokens · esc to interrupt|thinking with|Building |Compiling |Running tests|Test Files|PASS|FAIL'; then
    printf 'LEGITIMATELY-SLOW\n'
    return 0
  fi
  if _atmux_unblocker_has_recent_commit "$id" "$owner"; then
    printf 'LEGITIMATELY-SLOW\n'
    return 0
  fi

  printf 'IDLE\n'
}

# True when there's a git commit referencing $id in the last STALE_MIN
# minutes. Matches the literal task id in the commit subject — gitter's
# convention is to include `[<task-id>]` in commit subjects so this is
# the cheapest correctness check. Best-effort; any git failure (not in a
# repo, etc) returns false → we fall through to IDLE classification.
_atmux_unblocker_has_recent_commit() {
  local id="$1" owner="$2"
  command -v git >/dev/null 2>&1 || return 1
  git rev-parse --git-dir >/dev/null 2>&1 || return 1
  local since=$(( ATMUX_UNBLOCKER_STALE_MIN * 60 ))
  local now; now="$(atmux::now_epoch)"
  local cutoff=$(( now - since ))
  local hits
  hits="$(git log --since="@$cutoff" --grep="$id" --pretty=format:%h 2>/dev/null \
          | head -1 || true)"
  [[ -n "$hits" ]]
}

# Surface to lead-outbox via `atmux reply`. The reply body carries the
# classification tag, the task pointer, the owner, and a 20-line pane
# paste (fenced) so the lead has enough context to decide /clear vs nudge
# vs escalate-to-driver. WEDGED-WITH-DRIVER-NEEDED prepends "needs
# driver" so the lead's triage glance sees the routing.
_atmux_unblocker_escalate() {
  local id="$1" owner="$2" cls="$3" state="$4"

  local tag="$cls"
  [[ "$cls" == "WEDGED-WITH-DRIVER-NEEDED" ]] && tag="WEDGED — needs driver"

  # Fenced pane paste keeps the markdown rendering clean in lead-outbox.
  # Truncate to 20 lines — enough to identify the modal/banner without
  # dumping the entire 30-line capture (most modals are 3–8 lines).
  local snippet
  snippet="$(printf '%s' "$state" | tail -n 20)"

  local msg
  msg="$(printf '🛑 unblocker classification: **%s**\nTask: \`%s\`\nOwner: \`%s\`\n\nPane snippet:\n\`\`\`\n%s\n\`\`\`' \
                "$tag" "$id" "$owner" "$snippet")"

  # `--from unblocker` pins the lead-outbox attribution regardless of the
  # caller's env (cron may not export ATMUX_MEMBER). The `from` field on
  # the reply is the audit trail for which role surfaced the issue.
  "$ATMUX_BIN_DIR/atmux" reply --from "${ATMUX_MEMBER:-unblocker}" "$msg" \
      >/dev/null 2>&1 \
      || atmux::warn "unblocker: reply to lead-outbox failed for $id"

  _atmux_unblocker_ledger_record "$id" "$cls"
}

# Nudge the owner. atmux send is the canonical pane writer (capture-then-
# paste pattern). Append a structured line to unblocker-nudges.log for
# operator forensics — same shape as whip.log's per-tick lines.
_atmux_unblocker_nudge() {
  local id="$1" owner="$2" log="$3" now="$4"

  "$ATMUX_BIN_DIR/atmux" send "$owner" "still on $id?" >/dev/null 2>&1 \
      || atmux::warn "unblocker: send to $owner failed for $id"

  printf '[%s] nudge id=%s owner=%s reason=IDLE\n' \
    "$(atmux::now_myt)" "$id" "$owner" >> "$log"

  _atmux_unblocker_ledger_record "$id" "IDLE"
}

# Per-(task,classification) debounce ledger. Returns 0 when caller should
# act (no prior record OR record older than $debounce_sec), 1 otherwise.
_atmux_unblocker_should_act() {
  local id="$1" cls="$2" debounce_sec="$3" now="$4"

  local ledger; ledger="$(atmux::state_dir)/unblocker-ledger.json"
  [[ -f "$ledger" ]] || return 0

  local key="${id}:${cls}"
  local last
  last="$(jq -r --arg k "$key" '.[$k] // 0' "$ledger" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0

  (( now - last >= debounce_sec ))
}

_atmux_unblocker_ledger_record() {
  local id="$1" cls="$2"
  local ledger; ledger="$(atmux::state_dir)/unblocker-ledger.json"
  mkdir -p "$(dirname "$ledger")"
  [[ -s "$ledger" ]] || echo '{}' > "$ledger"
  local now; now="$(atmux::now_epoch)"
  atmux::jq_update "$ledger" \
    '. + {($k): ($t | tonumber)}' \
    --arg k "${id}:${cls}" --arg t "$now"
}

_atmux_unblocker_log_tick() {
  local ts="$1" team="$2"
  local n_wedged="$3" n_driver="$4" n_idle="$5" n_slow="$6"
  local logf; logf="$(atmux::logs_dir)/unblocker.log"
  mkdir -p "$(dirname "$logf")"
  printf '[%s] tick team=%s wedged=%d driver=%d idle=%d slow=%d\n' \
    "$ts" "$team" "$n_wedged" "$n_driver" "$n_idle" "$n_slow" >> "$logf"
}
