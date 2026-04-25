#!/usr/bin/env bash
# atmux whip — 5-minute watchdog. Intended for cron:
#
#   */5 * * * * cd /path/to/project && /usr/local/bin/atmux whip >> .atmux/logs/whip.log 2>&1
#
# Checks performed on each tick:
#   1. tmux session liveness
#   2. per-member pane: is pane running the expected TUI? (zsh/bash = crashed)
#   3. per-member: is the pane idle > $ATMUX_STALE_MIN minutes with in-progress tasks?
#   4. per-member Claude Code: is "Compacting conversation" or "hit your limit" banner visible?
#   5. lead: uptime > $ATMUX_LEAD_MAX_MIN minutes → recommend rotate
#
# Non-interactive; escalates to Discord via $ATMUX_DISCORD_WEBHOOK when findings exist.

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"
# shellcheck source=cost.sh
. "$ATMUX_LIB_DIR/cost.sh"
# shellcheck source=pause.sh
. "$ATMUX_LIB_DIR/pause.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  # Stale-task threshold resolution chain (per ADR-009 §S7 D9):
  #   per-Task .staleMin (applied inline by the jq filter below)
  #   ↳ ATMUX_STALE_MIN env override
  #   ↳ team.json `whip.staleMin`
  #   ↳ default 90 (raised from 30 in E2/S7 — demo-walk Tasks legitimately
  #     run 60–90min and the old default was creating ping fatigue).
  local TEAM_STALE_MIN
  TEAM_STALE_MIN=$(jq -r '.whip.staleMin // 90' \
                    "$(atmux::team_json)" 2>/dev/null || echo 90)
  local STALE_MIN="${ATMUX_STALE_MIN:-$TEAM_STALE_MIN}"
  local LEAD_MAX_MIN="${ATMUX_LEAD_MAX_MIN:-60}"
  # team.whip.autoRotate gates whether whip recommends rotation (false) or
  # executes it (true). Hoisted so the per-member banner-preclear check and
  # the lead-uptime check share one read of team.json.
  local AUTO_ROTATE
  AUTO_ROTATE=$(jq -r '.whip.autoRotate // false' \
                 "$(atmux::team_json)" 2>/dev/null || echo false)
  local findings=()
  local ts; ts="$(atmux::now_myt)"

  # ---- decisions cursor (ADR-008 / T10.2) ----
  # Runs regardless of session liveness — decisions.md is independent state.
  # Sets `dmtime_new` if the file exists; that's used for the post-ping
  # cursor advance below. Appends a flag-only pointer to findings if N > 0.
  local dmtime_new=""
  local fmtime_new=""
  _atmux_whip_check_decisions
  _atmux_whip_check_flags
  _atmux_whip_check_brief_versions

  # ---- "Since last tick" delta (E2/S7 t-ac42591e) ----
  # Computed BEFORE the session-DOWN early-exit so a DOWN tick still surfaces
  # what shipped during the gap (commits + done tasks are kanban / git state,
  # both independent of tmux liveness). Anchor is mtime of whip-last.hash; no
  # baseline ⇒ skip section entirely.
  local hash_file; hash_file="$(atmux::state_dir)/whip-last.hash"
  if [[ -f "$hash_file" ]]; then
    local since_epoch
    since_epoch=$(stat -c '%Y' "$hash_file" 2>/dev/null || stat -f '%m' "$hash_file" 2>/dev/null || echo 0)
    if [[ "$since_epoch" -gt 0 ]]; then
      local delta_block
      delta_block="$(_atmux_whip_delta_since "$since_epoch")"
      [[ -n "$delta_block" ]] && findings+=("$delta_block")
    fi
  fi

  # ---- 1. session liveness ----
  if ! atmux::tmux_session_exists; then
    findings+=("🛑 session $session is DOWN")
    _atmux_report_and_exit "$ts" "$team" "${findings[@]}"
    _atmux_whip_advance_decisions_cursor
    _atmux_whip_advance_flags_cursor
    return 0
  fi

  # ---- per-member checks ----
  local mj; mj="$(jq -c '.members[]' "$(atmux::team_json)")"
  local lead_name=""
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local name role tui
    name=$(jq -r '.name' <<<"$m")
    role=$(jq -r '.role // "member"' <<<"$m")
    tui=$(jq -r '.tui // "claude"' <<<"$m")
    [[ "$role" == "team-lead" ]] && lead_name="$name"

    if ! atmux::tmux_window_exists "$name"; then
      findings+=("🛑 $name: window missing (role=$role)")
      continue
    fi

    local pane_cmd
    pane_cmd=$(tmux list-panes -t "$(atmux::tmux_target "$name")" -F '#{pane_current_command}' 2>/dev/null | head -1)
    local want=""
    case "$tui" in
      claude) want="claude" ;;
      opencode) want="opencode" ;;
      kimi) want="kimi" ;;
      cursor) want="cursor-agent" ;;
    esac
    if [[ -n "$want" && "$pane_cmd" != "$want" ]]; then
      findings+=("🛑 $name: pane is \`$pane_cmd\` not \`$want\` (TUI crashed or not launched)")
      continue
    fi

    # Banner detection. Track `preclear_banner` for the autoRotate-gated
    # auto-preclear: rate-limit / approaching-limit / compacting are all
    # "rotate would help" signals; queued-message banner is informational
    # only (no rotation).
    local state; state=$(atmux::capture_pane "$name" 30)
    local preclear_banner=""
    if echo "$state" | grep -qi 'hit your limit\|rate.?limit'; then
      findings+=("🔴 $name: rate-limited banner visible")
      preclear_banner="rate-limited"
    fi
    if echo "$state" | grep -qi 'approaching usage limit'; then
      findings+=("🟡 $name: approaching usage limit")
      preclear_banner="${preclear_banner:-approaching-limit}"
    fi
    if echo "$state" | grep -qi 'Compacting conversation'; then
      findings+=("⏳ $name: compacting — skip sends until done")
      preclear_banner="${preclear_banner:-compacting}"
    fi
    # Queued-msg flag suppressed when the pane is concurrently BUSY: Claude
    # actively running ('Esc to interrupt' / token counter / 'thinking with')
    # WILL submit the queued text when the current turn ends. Without this
    # suppression, every long tool-using turn produces a false-positive
    # 'messages queued' ping (E2/S7 t-1a5205ea).
    if echo "$state" | grep -qi 'Press up to edit queued messages'; then
      if ! _atmux_whip_pane_busy "$state"; then
        findings+=("📥 $name: messages queued but not submitted")
      fi
    fi

    # AUTO-PRECLEAR (E2/S3 t-50ca6f09): when AUTO_ROTATE=true and a
    # rotation-trigger banner is visible, exec `atmux rotate <member>`
    # immediately. Debounce: skip if the member was rotated <5min ago,
    # since banners can persist across capture-pane scrolls and we don't
    # want to thrash. The rotate verb writes a fresh `<member>-rotated.epoch`
    # so the next tick's debounce check naturally suppresses re-fires.
    if [[ -n "$preclear_banner" && "$AUTO_ROTATE" == "true" ]]; then
      local _now_e; _now_e="$(atmux::now_epoch)"
      local _mrot;  _mrot="$(_atmux_whip_member_rotated_epoch "$name")"
      if (( _now_e - _mrot >= 300 )); then
        if "$ATMUX_BIN_DIR/atmux" rotate "$name" >/dev/null 2>&1; then
          findings+=("♻️ AUTO-PRECLEAR $name (banner=$preclear_banner)")
        else
          findings+=("⚠️ auto-preclear $name attempted but failed")
        fi
      fi
    fi

    # Stale-task heuristic — count inbox entries whose effective anchor is
    # older than STALE_MIN. The anchor is max(claimedAt, dispatchedAt,
    # <member>-rotated.epoch): a recent rotation means the member resumed
    # clean and shouldn't be flagged for tasks that were claimed pre-rotation.
    local ib="$(atmux::inbox_dir)/$name.json"
    if [[ -f "$ib" ]]; then
      local rotated; rotated=$(_atmux_whip_member_rotated_epoch "$name")
      local stale
      stale=$(jq --argjson now "$(atmux::now_epoch)" --argjson default_min "$STALE_MIN" \
                  --argjson rot "$rotated" \
        '[.inProgress[]
          | (.claimedAt // .dispatchedAt // 0) as $base
          | ([$base, $rot] | max) as $anchor
          | ((.staleMin // $default_min) * 60) as $task_s
          | select(($anchor + $task_s) < $now)
         ] | length' "$ib" 2>/dev/null || echo 0)
      if [[ "${stale:-0}" -gt 0 ]]; then
        findings+=("⏰ $name: $stale task(s) in-progress > ${STALE_MIN}min")
      fi
    fi
  done <<< "$mj"

  # ---- budget check ----
  local tj; tj="$(atmux::team_json)"
  local budget_total budget_per_member overrun_policy
  budget_total=$(jq -r '.budget.total // empty' "$tj")
  budget_per_member=$(jq -r '.budget.perMember // empty' "$tj")
  overrun_policy=$(jq -r '.budget.overrunPolicy // "warn"' "$tj")

  if [[ -n "$budget_total" || -n "$budget_per_member" ]]; then
    local sf="$(atmux::state_dir)/session-start.txt"
    local since; since=$(cat "$sf" 2>/dev/null || echo 0)
    local cost_snapshot; cost_snapshot=$(atmux::compute_team_cost "$since")
    local total_usd; total_usd=$(jq -r '.totalUsd' <<<"$cost_snapshot")

    if [[ -n "$budget_total" ]]; then
      if awk "BEGIN{exit !($total_usd >= $budget_total)}"; then
        findings+=("💸 team cost \$$total_usd ≥ total budget \$$budget_total (policy=$overrun_policy)")
      fi
    fi
    if [[ -n "$budget_per_member" ]]; then
      local overs
      overs=$(jq -r --argjson cap "$budget_per_member" \
        '.members[] | select(.usd >= $cap) | "💸 \(.member) cost $\(.usd) ≥ per-member budget $\($cap | tostring)"' <<<"$cost_snapshot")
      if [[ -n "$overs" ]]; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && findings+=("$line")
        done <<< "$overs"

        if [[ "$overrun_policy" == "pause" ]]; then
          local m_over
          while IFS= read -r m_over; do
            [[ -z "$m_over" ]] && continue
            ATMUX_PAUSE_REASON="budget-exhausted" \
              "$ATMUX_BIN_DIR/atmux" pause "$m_over" >/dev/null 2>&1 || true
          done < <(jq -r --argjson cap "$budget_per_member" \
            '.members[] | select(.usd >= $cap) | .member' <<<"$cost_snapshot")
        elif [[ "$overrun_policy" == "failover" ]]; then
          _atmux_whip_attempt_failover "$cost_snapshot" "$budget_per_member"
        fi
      fi
    fi
  fi

  # ---- lead uptime check ----
  # Uptime anchored at max(<lead>-rotated.epoch, session-start.txt) — a recent
  # `atmux rotate-lead` resets the clock so we don't keep re-flagging an
  # already-rotated lead. `_atmux_whip_anchor_for` is shared for T3.1 banner-
  # preclear timing.
  if [[ -n "$lead_name" ]]; then
    local anchor; anchor="$(_atmux_whip_anchor_for "$lead_name")"
    if [[ "$anchor" -gt 0 ]]; then
      local uptime=$(( $(atmux::now_epoch) - anchor ))
      local uptime_min=$(( uptime / 60 ))
      if [[ "$uptime_min" -ge "$LEAD_MAX_MIN" ]]; then
        # AUTO_ROTATE==true → exec `atmux rotate-lead` and append a transparency
        # finding so the Discord ping carries the action. The rotate verb writes
        # a fresh `<lead>-rotated.epoch`, so the next tick reads uptime≈0 and
        # self-debounces — no infinite-loop risk.
        if [[ "$AUTO_ROTATE" == "true" ]]; then
          if "$ATMUX_BIN_DIR/atmux" rotate-lead >/dev/null 2>&1; then
            findings+=("♻️ AUTO-ROTATED lead at $(atmux::now_myt) (uptime=${uptime_min}min)")
          else
            findings+=("⚠️ auto-rotate attempted but failed — check \`atmux rotate-lead\` manually")
          fi
        else
          findings+=("♻️  lead uptime=${uptime_min}min ≥ ${LEAD_MAX_MIN}min — consider \`atmux rotate-lead\`")
        fi
      fi
    fi
  fi

  _atmux_report_and_exit "$ts" "$team" "${findings[@]}"
  _atmux_whip_advance_decisions_cursor
  _atmux_whip_advance_flags_cursor
}

# Detect new decisions since the last whip cursor and append a flag-only
# pointer to the parent's `findings` array. Sets `dmtime_new` (parent local)
# to the file's current mtime if the file exists — used by the cursor-advance
# helper after the ping fires. Silent no-op if decisions.md is absent.
_atmux_whip_check_decisions() {
  local dfile; dfile="$(atmux::dir)/decisions.md"
  [[ -f "$dfile" ]] || return 0

  dmtime_new=$(stat -c '%Y' "$dfile" 2>/dev/null || stat -f '%m' "$dfile" 2>/dev/null || echo 0)

  local dcursor_file; dcursor_file="$(atmux::state_dir)/decisions-cursor"
  local dcursor_old=0
  if [[ -f "$dcursor_file" ]]; then
    dcursor_old=$(cat "$dcursor_file" 2>/dev/null || echo 0)
    [[ "$dcursor_old" =~ ^[0-9]+$ ]] || dcursor_old=0
  fi

  (( dmtime_new > dcursor_old )) || return 0

  local n_new
  n_new=$(awk -v c="$dcursor_old" '
    BEGIN { in_entry=0; count=0 }
    /^### / && $2 ~ /^d-/ { in_entry=1; next }
    /^- \*\*timestamp\*\*:/ {
      v=$0; sub(/^- \*\*timestamp\*\*: */,"",v)
      if (in_entry && (v+0) > c) { count++ }
      in_entry=0
    }
    END { print count }
  ' "$dfile")

  if [[ "${n_new:-0}" -gt 0 ]]; then
    # Inline-preview the latest 3 decisions (E2/S8 t-93993183) so the whip
    # ping carries the gist instead of a flag-only pointer. Decisions list
    # is sorted DESC by timestamp; we pull the top 3 and emit each as its
    # own bullet. Anything beyond 3 collapses into a `+M more — atmux
    # decisions digest` tail pointer.
    local preview_json=""
    if "$ATMUX_BIN_DIR/atmux" decisions list --since "$dcursor_old" --json \
         >"$(atmux::state_dir)/.whip-decisions-preview.tmp" 2>/dev/null; then
      preview_json="$(cat "$(atmux::state_dir)/.whip-decisions-preview.tmp")"
      rm -f "$(atmux::state_dir)/.whip-decisions-preview.tmp"
    fi

    if [[ -n "$preview_json" ]] && jq -e . <<<"$preview_json" >/dev/null 2>&1; then
      findings+=("📋 $n_new new decisions:")
      local emoji_map
      emoji_map='{"low":"🟢","medium":"🟡","high":"🔴"}'
      while IFS= read -r line; do
        [[ -n "$line" ]] && findings+=("  $line")
      done < <(jq -r --argjson em "$emoji_map" \
                 '.[:3] | .[] | "\($em[.reversibility] // "⚪") \(.id) \(.question) → \(.default)"' \
                 <<<"$preview_json")
      if (( n_new > 3 )); then
        findings+=("  +$((n_new - 3)) more — atmux decisions digest")
      fi
    else
      # Fallback to flag-only pointer if list --since fails (e.g. cursor
      # in a strange state, jq malfunction). Better to surface the count
      # than to silently drop the finding.
      findings+=("📋 $n_new new decisions — atmux decisions list")
    fi
  fi
}

# Advance the cursor to the mtime captured by _atmux_whip_check_decisions.
# Runs AFTER report-and-exit so the cursor only moves once the ping has been
# attempted. discord_ping is fire-and-warn (warns on curl failure, swallows
# rc), so we can't distinguish ping-fail from ping-success — the cursor moves
# either way. Real retry-on-failure would need discord_ping to surface its
# rc; out of scope per ADR-008's "do not modify discord.sh" rule.
_atmux_whip_advance_decisions_cursor() {
  [[ -n "${dmtime_new:-}" ]] || return 0
  local dcursor_file; dcursor_file="$(atmux::state_dir)/decisions-cursor"
  mkdir -p "$(dirname "$dcursor_file")"
  echo "$dmtime_new" > "$dcursor_file"
}

# Open p0 flags pointer (E4/S6 t-874ef870). Mirrors the decisions-cursor
# pattern: count p0 flag entries added since the last cursor mtime, append
# a flag-only pointer (no body duplication — `atmux flag list` is the
# authoritative renderer). Sets `fmtime_new` so the post-ping cursor
# advance can move the cursor without us re-stat'ing the file.
_atmux_whip_check_flags() {
  local ffile; ffile="$(atmux::dir)/flags.md"
  [[ -f "$ffile" ]] || return 0

  fmtime_new=$(stat -c '%Y' "$ffile" 2>/dev/null || stat -f '%m' "$ffile" 2>/dev/null || echo 0)

  local fcursor_file; fcursor_file="$(atmux::state_dir)/flags-cursor"
  local fcursor_old=0
  if [[ -f "$fcursor_file" ]]; then
    fcursor_old=$(cat "$fcursor_file" 2>/dev/null || echo 0)
    [[ "$fcursor_old" =~ ^[0-9]+$ ]] || fcursor_old=0
  fi

  (( fmtime_new > fcursor_old )) || return 0

  # Count entries whose `### f-...` heading marks them p0 AND whose
  # timestamp bullet falls after the cursor. Resolution blocks (`### r-`)
  # are ignored — they're separate entries that never carry severity.
  local n_new
  n_new=$(awk -v c="$fcursor_old" '
    BEGIN { sev=""; ts=0; in_entry=0 }
    /^### f-/ {
      # Header shape: `### f-xxxx <member> [<severity>/<needs>] (HH:MM MYT)`
      sev=""
      if (match($0, /\[p[0-2]\//)) {
        sev=substr($0, RSTART+1, RLENGTH-2)  # strip `[` and trailing `/`
      }
      in_entry=1
      ts=0
    }
    /^### r-/ { in_entry=0 }
    /^- \*\*timestamp\*\*:/ && in_entry {
      v=$0; sub(/^- \*\*timestamp\*\*: */,"",v)
      ts=v+0
      if (sev == "p0" && ts > c) { count++ }
      in_entry=0
    }
    END { print count+0 }
  ' "$ffile")

  if [[ "${n_new:-0}" -gt 0 ]]; then
    findings+=("📍 $n_new open p0 flags — atmux flag list")
  fi
}

_atmux_whip_advance_flags_cursor() {
  [[ -n "${fmtime_new:-}" ]] || return 0
  local fcursor_file; fcursor_file="$(atmux::state_dir)/flags-cursor"
  mkdir -p "$(dirname "$fcursor_file")"
  echo "$fmtime_new" > "$fcursor_file"
}

# Brief-version drift detector (E3/S3 t-de3bdd69). For each member, compare
# the brief version they last received (.atmux/state/brief-versions.json,
# stamped by start.sh / rotate.sh / reload.sh) against the current brief
# template version (atmux::brief_version <role>). When they differ, surface
# a one-line nudge naming the reload command. Cold-start safety: silent
# no-op when brief-versions.json is absent (a fresh session before any
# spawn-time recording has happened) — the next start/rotate/reload will
# create the file. Mirrors _atmux_whip_check_decisions in shape.
_atmux_whip_check_brief_versions() {
  local bvfile; bvfile="$(atmux::state_dir)/brief-versions.json"
  [[ -f "$bvfile" ]] || return 0
  local tj; tj="$(atmux::team_json)"
  [[ -f "$tj" ]] || return 0

  local member role pasted current
  while IFS=$'\t' read -r member role; do
    [[ -z "$member" ]] && continue
    pasted="$(jq -r --arg m "$member" '.[$m].version // empty' "$bvfile" 2>/dev/null || true)"
    [[ -z "$pasted" ]] && continue
    current="$(atmux::brief_version "$role" 2>/dev/null || echo v0)"
    if [[ "$current" != "$pasted" ]]; then
      findings+=("📋 brief $role $current available (was $pasted) — atmux reload brief-reload $member")
    fi
  done < <(jq -r '.members[] | [.name, (.role // "member")] | @tsv' "$tj" 2>/dev/null || true)
}

# For the `failover` budget policy: find a peer with the same role that still
# has budget, invoke `atmux handoff <exhausted> <peer>`, pause the exhausted.
_atmux_whip_attempt_failover() {
  local cost_snapshot="$1" cap="$2"
  local exhausted
  while IFS= read -r exhausted; do
    [[ -z "$exhausted" ]] && continue
    local role cwd
    role=$(jq -r --arg n "$exhausted" '.members[] | select(.name == $n) | .role // "member"' "$(atmux::team_json)")
    # Pick any peer with same role, not paused, not exhausted, and usd < cap/2.
    local peer
    peer=$(jq -r --arg role "$role" --arg ex "$exhausted" --argjson cap "$cap" \
      --slurpfile cs <(echo "$cost_snapshot") '
      .members[]
      | select(.role == $role and .name != $ex)
      | .name
      | select(
          ($cs[0].members[] | select(.member == .)  | .usd) as $u
          | ($u // 0) < ($cap / 2)
        )' "$(atmux::team_json)" 2>/dev/null | head -1 || true)

    # jq above can be brittle with nested scope; simpler: just pick first same-role peer.
    if [[ -z "$peer" ]]; then
      peer=$(jq -r --arg role "$role" --arg ex "$exhausted" \
        '[.members[] | select(.role == $role and .name != $ex) | .name][0] // empty' "$(atmux::team_json)")
    fi

    if [[ -n "$peer" ]]; then
      atmux::log "whip: failover $exhausted → $peer"
      "$ATMUX_BIN_DIR/atmux" handoff "$exhausted" "$peer" --reason "budget-exhausted" --pause-from >/dev/null 2>&1 || true
    else
      atmux::log "whip: no failover peer available for $exhausted (role=$role)"
      ATMUX_PAUSE_REASON="budget-exhausted-no-peer" \
        "$ATMUX_BIN_DIR/atmux" pause "$exhausted" >/dev/null 2>&1 || true
    fi
  done < <(jq -r --argjson cap "$cap" \
    '.members[] | select(.usd >= $cap) | .member' <<<"$cost_snapshot")
}

_atmux_report_and_exit() {
  local ts="$1"; shift
  local team="$1"; shift
  local findings=("$@")

  local logf="$(atmux::logs_dir)/whip.log"
  mkdir -p "$(dirname "$logf")"

  if [[ "${#findings[@]}" -eq 0 ]]; then
    echo "[$ts] whip: all clean" >> "$logf"
    atmux::log "whip: all clean"
    return 0
  fi

  local body="💥 **[whip]** · \`$team\` · $ts"
  body+=$'\n'
  for f in "${findings[@]}"; do
    body+=$'\n- '"$f"
  done

  printf '[%s]\n%s\n\n' "$ts" "$body" >> "$logf"
  echo "$body"
  # ---- body-hash dedup (E2/S7 / t-96390734) ----
  # Hash bullet content only — header + timestamp change every tick and would
  # defeat dedup. If the hash matches the last successful ping, the findings
  # haven't changed; skip the Discord post but keep logging + cursor advance.
  local body_hash; body_hash="$(_atmux_whip_body_hash "${findings[@]}")"
  local hash_file; hash_file="$(atmux::state_dir)/whip-last.hash"
  local prev_hash=""
  [[ -f "$hash_file" ]] && prev_hash="$(cat "$hash_file" 2>/dev/null || echo "")"

  if [[ "$body_hash" == "$prev_hash" ]]; then
    atmux::log "whip: body unchanged since last tick — skipping Discord ping (hash=$body_hash)"
    return 0
  fi

  atmux::discord_ping "$body"
  mkdir -p "$(dirname "$hash_file")"
  printf '%s\n' "$body_hash" > "$hash_file"
}

# Hash the findings bullets only (one bullet per line). Excludes the team
# header + timestamp so dedup survives the every-tick header churn.
_atmux_whip_body_hash() {
  local f
  for f in "$@"; do
    printf '%s\n' "$f"
  done | sha256sum | awk '{print $1}'
}

# Build the "Since last tick" body block from positive events that landed
# after $since_epoch — git commits, kanban tasks marked done. Echoes the
# multi-line block (header + indented bullets) when ≥1 event exists, else
# empty. story-advance tracking deferred (no .advancedAt schema field yet).
#
# Caller (whip's main) pushes the block as ONE finding entry; the body
# builder prefixes the first line with `- ` and embedded newlines render
# subsequent lines verbatim — that's why the inner bullets are 2-space
# indented `- ` lines.
_atmux_whip_delta_since() {
  local since="$1"
  [[ "$since" =~ ^[0-9]+$ ]] || return 0
  local now; now=$(atmux::now_epoch)
  local elapsed=$(( now - since ))
  (( elapsed > 0 )) || return 0
  local elapsed_str
  if (( elapsed < 3600 )); then
    elapsed_str=$(( elapsed / 60 ))min
  else
    local h=$(( elapsed / 3600 )) m=$(( (elapsed % 3600) / 60 ))
    if (( m == 0 )); then elapsed_str="${h}h"; else elapsed_str="${h}h${m}m"; fi
  fi

  # Commits since $since via git log (ignore errors when not in a repo).
  # `tformat:` (not `format:`) terminates every entry with a newline — the
  # `format:` variant only puts the format string BETWEEN entries, so the
  # last commit lacks a trailing newline and `read` drops it (1 commit →
  # 0 captured, N → N-1 captured). Self-surfaced as flag f-3229e152.
  local commits=()
  if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && commits+=("$line")
    done < <(git log --since="@$since" --pretty=tformat:'%h' 2>/dev/null || true)
  fi

  # Done tasks since $since — completedAt > since.
  local done_ids=()
  local k; k="$(atmux::kanban_json)"
  if [[ -f "$k" ]]; then
    local id
    while IFS= read -r id; do
      [[ -n "$id" ]] && done_ids+=("$id")
    done < <(jq -r --argjson s "$since" \
        '[.tasks[]? | select((.completedAt // 0) > $s)] | sort_by(.completedAt) | .[].id' \
        "$k" 2>/dev/null || true)
  fi

  # Skip the whole section when both buckets are empty — quiet tick.
  if [[ ${#commits[@]} -eq 0 && ${#done_ids[@]} -eq 0 ]]; then
    return 0
  fi

  local out="📊 **Since last tick** ($elapsed_str ago):"
  if [[ ${#commits[@]} -gt 0 ]]; then
    local n=${#commits[@]}
    local shown=("${commits[@]:0:5}")
    local line; line="$(printf '%s ' "${shown[@]}")"; line="${line% }"
    if (( n > 5 )); then line="$line (+$((n - 5)) more)"; fi
    out+=$'\n  - ✅ '"$n commits: $line"
  fi
  if [[ ${#done_ids[@]} -gt 0 ]]; then
    local n=${#done_ids[@]}
    local shown=("${done_ids[@]:0:5}")
    local line; line="$(printf '%s ' "${shown[@]}")"; line="${line% }"
    if (( n > 5 )); then line="$line (+$((n - 5)) more)"; fi
    out+=$'\n  - 🏁 '"$n tasks done: $line"
  fi
  printf '%s' "$out"
}

# Detect whether a captured pane state is currently mid-turn (Claude
# actively running). Used to suppress false-positive findings (queued-msg)
# while the pane is doing real work. Returns 0 when busy, 1 when idle.
# Caller passes the already-captured pane text — we don't re-capture, both
# to save a tmux call and to keep the busy-check synchronized with the
# state the rest of the per-member loop reasons about.
_atmux_whip_pane_busy() {
  local state="$1"
  if echo "$state" | grep -qi \
       'Esc to interrupt\|tokens · esc to interrupt\|thinking with'; then
    return 0
  fi
  return 1
}

# Read <member>-rotated.epoch as an integer; 0 if absent or non-numeric.
# Used inline by the stale-task jq filter so we don't shell-out per-task.
_atmux_whip_member_rotated_epoch() {
  local member="$1"
  local f; f="$(atmux::state_dir)/${member}-rotated.epoch"
  [[ -f "$f" ]] || { echo 0; return; }
  local v; v=$(cat "$f" 2>/dev/null || echo 0)
  [[ "$v" =~ ^[0-9]+$ ]] || v=0
  echo "$v"
}

# Per AC of t-59ffacfd: returns max(<claimed_or_dispatched>, <member>-rotated.epoch).
# Reusable for any caller that wants the stale-anchor for a single task; the
# whip stale-check inlines this logic inside jq for batch efficiency, but the
# bash entrypoint exists for unit-test + future-reuse callers (T3.1 timing).
_atmux_whip_stale_anchor() {
  local member="$1" claimed="${2:-0}"
  [[ "$claimed" =~ ^[0-9]+$ ]] || claimed=0
  local rotated; rotated=$(_atmux_whip_member_rotated_epoch "$member")
  if (( rotated > claimed )); then
    printf '%s\n' "$rotated"
  else
    printf '%s\n' "$claimed"
  fi
}

# Resolve the "last refresh" anchor for a member as
#   max(<member>-rotated.epoch, session-start.txt).
# A rotation resets the clock; absence of either file falls back to the other;
# absence of both echoes 0 (caller treats as "no signal yet"). Used by the
# lead-uptime check (E2/S2) and reserved for T3.1 banner-preclear timing.
_atmux_whip_anchor_for() {
  local member="$1"
  local sd; sd="$(atmux::state_dir)"
  local rotated=0 sess=0
  if [[ -f "$sd/${member}-rotated.epoch" ]]; then
    rotated=$(cat "$sd/${member}-rotated.epoch" 2>/dev/null || echo 0)
    [[ "$rotated" =~ ^[0-9]+$ ]] || rotated=0
  fi
  if [[ -f "$sd/session-start.txt" ]]; then
    sess=$(cat "$sd/session-start.txt" 2>/dev/null || echo 0)
    [[ "$sess" =~ ^[0-9]+$ ]] || sess=0
  fi
  if (( rotated > sess )); then
    printf '%s\n' "$rotated"
  else
    printf '%s\n' "$sess"
  fi
}
