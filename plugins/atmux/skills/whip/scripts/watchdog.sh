#!/usr/bin/env bash
# Driver-side watchdog for the team-lead's /whip loop + teammate/lead interactive-blockers.
# Runs from cron every 10min. Zero Claude tokens per tick.
#
# Invoke: bash watchdog.sh <team-name>
#   cwd must be the git repo for the team (lead-stall carve-out 2b uses `git log --since`).
#
# Four independent checks per tick:
#   1. Lead-stall — is /whip's Discord flush-file >30min stale? (with carve-outs)
#   2. Teammate-blockers — are any teammate panes stuck on interactive prompts?
#   3. Lead-blocker — is the lead pane itself stuck on an interactive prompt?
#      (Tight rate-limit — lead-blocked = whole team blocked, and /whip can't fire
#       from a blocked lead, so the normal flush-stall path takes 30min which is
#       too slow for a prompt user can answer in seconds.)
#   4. Teammate-uptime-nag — any teammate process up >ROTATE_THRESHOLD_MIN
#      (default 90) AND idle-at-prompt. Rotation itself is manual (/team
#      rotate-member); this check just pings Discord when rotation is overdue,
#      so teammates' context doesn't quietly rot into auto-compaction.
#
# All four run every tick regardless of each other's outcome. Each has its own
# rate-limit file so they don't spam on repeated ticks.
#
# Sibling to the /whip-watchdog SKILL.md. See SKILL.md for rationale.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:/root/.local/bin:${PATH:-}"

TEAM="${1:?usage: watchdog.sh <team-name>}"

FLUSH_FILE="$HOME/.claude/teams/${TEAM}/last-discord-flush.txt"
LEAD_ALERT_FILE="$HOME/.claude/teams/${TEAM}/last-watchdog-alert.txt"
SESSION_START="$HOME/.claude/teams/${TEAM}/lead-session-start.txt"
LOCK_FILE="$HOME/.claude/teams/${TEAM}/watchdog.lock"
NOW=$(date +%s)
LEAD_WIN="__${TEAM}__team-lead"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

# Format duration in minutes as compact human-readable per global CLAUDE.md:
#   <60   → "Nmin"    (e.g. 47min)
#   ≥60   → "HhMm"    (e.g. 6h45m, 25h49m) or "Hh" when minutes==0
# No day units. Used in user-facing Discord output, not internal log lines.
fmt_dur_min() {
  local total=$1
  if [ "$total" -lt 60 ]; then
    echo "${total}min"
    return
  fi
  local h=$((total / 60))
  local m=$((total % 60))
  if [ "$m" -eq 0 ]; then
    echo "${h}h"
  else
    echo "${h}h${m}m"
  fi
}

# Read an epoch timestamp from a file. Canonical format is epoch seconds,
# but accept ISO8601 (whip sometimes writes that — see feedback_team_lead_driver_mode.md).
# Prints epoch to stdout; returns 1 on parse failure or missing file.
read_epoch_ts() {
  local val
  val=$(cat "$1" 2>/dev/null) || return 1
  [ -z "$val" ] && return 1
  # All-digits → epoch
  if [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "$val"
    return 0
  fi
  # Try ISO8601 via GNU date
  date -d "$val" +%s 2>/dev/null
}

# Prevent overlapping runs on clock skew / slow ticks.
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "already running — skipping tick"; exit 0; }

# Lead window alive? No window = team not started, no-op everything.
if ! tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -q "^${LEAD_WIN}$"; then
  log "no ${LEAD_WIN} tmux window — no-op"
  exit 0
fi

# ==========================================================================
# Check 1 — lead-stall detection (original watchdog scope)
# ==========================================================================

check_lead_stall() {
  # Stage 1 — flush-file staleness
  local lead_age_min=-1
  local lead_start_epoch
  if lead_start_epoch=$(read_epoch_ts "$SESSION_START"); then
    lead_age_min=$(( (NOW - lead_start_epoch) / 60 ))
  fi

  local stale_min=0
  local reason=""
  if [ ! -f "$FLUSH_FILE" ]; then
    if [ "$lead_age_min" -ge 45 ]; then
      stale_min=$lead_age_min
      reason="flush-file missing and lead has been up $(fmt_dur_min "$lead_age_min") — whip never seeded"
    elif [ "$lead_age_min" -ge 0 ]; then
      log "flush-file missing but lead only ${lead_age_min}min old — warming up"
      return 0
    else
      log "no session-start marker, no flush-file — lead likely not running whip yet"
      return 0
    fi
  else
    stale_min=$(( (NOW - $(stat -c %Y "$FLUSH_FILE")) / 60 ))
    if [ "$stale_min" -lt 30 ]; then
      log "flush ${stale_min}min stale — within 30min threshold"
      return 0
    fi
    reason="Discord flush-file $(fmt_dur_min "$stale_min") stale — /whip heartbeat should have fired at 30min, did not"
  fi

  # Stage 2 — carve-outs
  # 2a: pre-rotation staleness
  if [ "$lead_age_min" -ge 0 ] && [ "$stale_min" -gt "$lead_age_min" ] && [ "$lead_age_min" -lt 45 ]; then
    log "carve-out 2a: flush ${stale_min}min stale, lead ${lead_age_min}min old — pre-rotation warm-up"
    return 0
  fi

  local lead_pane_tail
  lead_pane_tail=$(tmux capture-pane -t "$LEAD_WIN" -p -S -5 2>/dev/null | grep -v '^[[:space:]]*$' | tail -3)
  local lead_state="unknown"
  if echo "$lead_pane_tail" | grep -qE "(thinking|Compacting|Cogitating|…)"; then
    lead_state="mid-turn (thinking/compacting)"
  elif echo "$lead_pane_tail" | grep -q "❯"; then
    lead_state="idle at prompt"
  fi

  # 2b: design-correct idle silence
  local commit_count_30m=0
  if git rev-parse --git-dir >/dev/null 2>&1; then
    commit_count_30m=$(git log --since='30 minutes ago' --oneline 2>/dev/null | wc -l)
  fi

  if [ "$commit_count_30m" -eq 0 ] && [ "$lead_state" = "idle at prompt" ]; then
    log "carve-out 2b: flush ${stale_min}min stale BUT 0 commits in 30min AND lead idle — healthy"
    return 0
  fi

  # Stage 3 — rate-limit (1 alert / hour)
  if [ -f "$LEAD_ALERT_FILE" ]; then
    local min_since_alert
    min_since_alert=$(( (NOW - $(cat "$LEAD_ALERT_FILE")) / 60 ))
    if [ "$min_since_alert" -lt 60 ]; then
      log "lead-stall: would alert (${reason}) but last alert ${min_since_alert}min ago — rate-limited"
      return 0
    fi
  fi

  # Stage 4 — fire alert
  local last_flush_ts="<never>"
  [ -f "$FLUSH_FILE" ] && last_flush_ts=$(stat -c %y "$FLUSH_FILE" | awk '{print $1, $2}' | cut -d. -f1)

  local msg="🚨 **whip-watchdog** · \`${TEAM}\` · $(TZ='${user_config.COORDINATION_TZ}' date +'%H:%M ${user_config.COORDINATION_TZ_SUFFIX}')

**Lead may be silently stalled.** ${reason}

- Last flush: ${last_flush_ts}
- Lead pane state: ${lead_state}
- Commits in last 30min: ${commit_count_30m}
- Lead window: \`${LEAD_WIN}\` (tmux position 2)

Driver should check the pane and consider /team rotate-lead if wedged."

  bash "$HOME/.claude/skills/whip/scripts/ping-discord.sh" "$msg" || log "ping-discord.sh exit $?"
  echo "$NOW" > "$LEAD_ALERT_FILE"
  log "lead-stall: alert fired — ${reason}"
}

# ==========================================================================
# Check 2 — teammate interactive-blocker detection (Stage 5, new)
# ==========================================================================
# Parallel to whip §1c: scan every non-lead teammate pane for interactive-
# prompt patterns. If any match, ping Discord with pane tail so user knows
# which teammate needs input. Rate-limited per-member (1 hour).
#
# Shares the rate-limit file naming convention with whip §1c:
#   ~/.claude/teams/<team>/last-block-alert-<member>.txt
# So whip and watchdog don't double-fire on the same blocker within an hour.

check_teammate_blockers() {
  local windows
  windows=$(tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep "^__${TEAM}__" | grep -v "^${LEAD_WIN}$" || true)
  [ -z "$windows" ] && return 0

  local w member tail blocked alert_file last min_since_alert msg
  for w in $windows; do
    member="${w#__${TEAM}__}"
    tail=$(tmux capture-pane -t "$w" -p -S -20 2>/dev/null | grep -v '^[[:space:]]*$' | tail -12)
    blocked=0

    # Pattern A — explicit interactive prompts (Claude Code, npm, apt, etc.)
    if echo "$tail" | grep -qE "(Do you want to (proceed|allow|continue)|\(y/n\)|\[y/N\]|\(yes/no\)|Press (enter|Enter|any key) to|Select (an option|\[1-9\])|Continue\?|Overwrite\?)"; then
      blocked=1
    # Pattern B — numbered options menu
    elif echo "$tail" | grep -qE "^\s*1\." && echo "$tail" | grep -qE "^\s*2\."; then
      blocked=1
    # Pattern C — trailing "? " with no content after (heuristic for custom confirms)
    elif echo "$tail" | tail -1 | grep -qE "\?\s*$"; then
      blocked=1
    # Pattern D — Claude Code 2.x permission/plan prompts
    elif echo "$tail" | grep -qE "(Please review (my |the )?plan|Grant (this )?permission|Approve (this )?plan|Allow this (tool|command|operation)|Trust this|Would you like|I need your (input|permission|approval|confirmation))"; then
      blocked=1
    # Pattern E — selection UI with ❯ marker plus action verbs
    elif echo "$tail" | grep -qE "^\s*❯\s+\S+.{2,}" && echo "$tail" | grep -qiE "(approve|reject|allow|deny|proceed|skip|abort|retry|bypass|confirm|cancel)"; then
      blocked=1
    # Pattern F — keyboard-hint footer (picker UI)
    elif echo "$tail" | grep -qiE "(enter to (confirm|submit|select)|esc to (cancel|dismiss)|tab to (toggle|switch)|↑/↓ to navigate|↑ ↓ to)"; then
      blocked=1
    # Pattern G — explicit "waiting for input" indicators
    elif echo "$tail" | grep -qiE "(waiting for (input|confirmation|approval|response)|awaiting (your )?(input|decision|review))"; then
      blocked=1
    fi

    [ "$blocked" = "1" ] || continue

    # Rate-limit — 1 alert per member per 5min (tightened from 60min to surface stalls faster;
    # The user prefers fast Discord pages over babysitting panes for routine permission prompts)
    alert_file="$HOME/.claude/teams/${TEAM}/last-block-alert-${member}.txt"
    if [ -f "$alert_file" ]; then
      last=$(cat "$alert_file")
      min_since_alert=$(( (NOW - last) / 60 ))
      if [ "$min_since_alert" -lt 5 ]; then
        log "teammate-block: ${member} blocked but last alert ${min_since_alert}min ago — rate-limited"
        continue
      fi
    fi

    msg="🛑 **teammate blocked** (cron-detected) · \`${TEAM}\` · \`${member}\` · $(TZ='${user_config.COORDINATION_TZ}' date +'%H:%M ${user_config.COORDINATION_TZ_SUFFIX}')

Teammate is waiting on an interactive prompt. Whip cannot answer — user input needed.

Pane tail:
\`\`\`
$(echo "$tail" | tail -8)
\`\`\`

Attach: \`Ctrl-b <N>\` on the pane (or \`tmux select-window -t ${w}\`)."

    bash "$HOME/.claude/skills/whip/scripts/ping-discord.sh" "$msg" || log "ping-discord.sh exit $?"
    echo "$NOW" > "$alert_file"
    log "teammate-block: alert fired — ${member} blocked on interactive prompt"
  done
}

# ==========================================================================
# Check 3 — lead interactive-blocker detection
# ==========================================================================
# Lead hitting an interactive prompt (auto-mode permission denial, merge
# conflict, pnpm confirm, etc.) blocks the ENTIRE team — /whip can't fire
# from a blocked lead, so the normal flush-stall path (Check 1) takes 30min
# to notice. That's way too slow for a prompt the user can answer in seconds.
#
# This check runs the same A/B/C pattern matchers as check_teammate_blockers
# but against the lead window, with a tighter rate-limit (15min) because
# lead-blocked is higher priority than a single teammate blocked.

check_lead_blocker() {
  local tail blocked alert_file last min_since_alert msg reason
  tail=$(tmux capture-pane -t "$LEAD_WIN" -p -S -30 2>/dev/null | grep -v '^[[:space:]]*$' | tail -15)
  blocked=0
  reason=""

  # Pattern A — explicit interactive prompts (Claude Code, npm, apt, etc.)
  if echo "$tail" | grep -qE "(Do you want to (proceed|allow|continue)|\(y/n\)|\[y/N\]|\(yes/no\)|Press (enter|Enter|any key) to|Select (an option|\[1-9\])|Continue\?|Overwrite\?)"; then
    blocked=1; reason="pattern-A (y/n or continue)"
  # Pattern B — numbered options menu (most common for Claude Code auto-mode denials)
  elif echo "$tail" | grep -qE "^\s*❯?\s*1\." && echo "$tail" | grep -qE "^\s*2\."; then
    blocked=1; reason="pattern-B (1./2. menu)"
  # Pattern C — Claude Code 2.x permission/plan prompts. Matches phrasings seen
  # in claude v2.1.x: "Please review my plan", "Grant permission", "Approve plan",
  # and the arrow-selection UI using ❯/▲/▼ markers inline with action verbs.
  elif echo "$tail" | grep -qE "(Please review (my |the )?plan|Grant (this )?permission|Approve (this )?plan|Allow this (tool|command|operation)|Trust this|Would you like|I need your (input|permission|approval|confirmation))"; then
    blocked=1; reason="pattern-C (plan/permission prompt)"
  # Pattern D — selection UI with ❯ marker plus action verbs on same tail.
  # Claude Code's picker shows "❯ <option>" as the highlighted choice — distinguish
  # from plain idle prompt (empty `❯ $`) by requiring a word after the marker.
  elif echo "$tail" | grep -qE "^\s*❯\s+\S+.{2,}" && echo "$tail" | grep -qiE "(approve|reject|allow|deny|proceed|skip|abort|retry|bypass|confirm|cancel)"; then
    blocked=1; reason="pattern-D (❯ + action verbs)"
  # Pattern E — keyboard-hint footer (Claude Code shows "enter to confirm ·
  # esc to cancel · tab to toggle" at bottom of pickers).
  elif echo "$tail" | grep -qiE "(enter to (confirm|submit|select)|esc to (cancel|dismiss)|tab to (toggle|switch)|↑/↓ to navigate|↑ ↓ to)"; then
    blocked=1; reason="pattern-E (keyboard-hint footer)"
  # Pattern F — explicit "waiting for input" indicators.
  elif echo "$tail" | grep -qiE "(waiting for (input|confirmation|approval|response)|awaiting (your )?(input|decision|review))"; then
    blocked=1; reason="pattern-F (waiting indicator)"
  fi

  [ "$blocked" = "1" ] || return 0
  log "lead-block: matched ${reason}"

  # Rate-limit — 1 alert per 2min. Lead-blocked = whole team blocked, demands fast user
  # response. With cron at 1min cadence this means every 2 ticks max if still unresolved.
  # Tightened from 15min (2026-04-19): Preference: Discord-fast-page over 90min stalls.
  alert_file="$HOME/.claude/teams/${TEAM}/last-lead-block-alert.txt"
  if [ -f "$alert_file" ]; then
    last=$(cat "$alert_file")
    min_since_alert=$(( (NOW - last) / 60 ))
    if [ "$min_since_alert" -lt 2 ]; then
      log "lead-block: blocked but last alert ${min_since_alert}min ago — rate-limited"
      return 0
    fi
  fi

  msg="🛑 **lead blocked** (cron-detected) · \`${TEAM}\` · $(TZ='${user_config.COORDINATION_TZ}' date +'%H:%M ${user_config.COORDINATION_TZ_SUFFIX}')

Team-lead is waiting on an interactive prompt — whole team is blocked, user input needed.

Pane tail:
\`\`\`
$(echo "$tail" | tail -10)
\`\`\`

Attach: \`tmux select-window -t ${LEAD_WIN}\`"

  bash "$HOME/.claude/skills/whip/scripts/ping-discord.sh" "$msg" || log "ping-discord.sh exit $?"
  echo "$NOW" > "$alert_file"
  log "lead-block: alert fired"
}

# ==========================================================================
# Check 4 — teammate-uptime-nag (rotation-overdue visibility)
# ==========================================================================
# Teammates have no self-rotation (unlike lead's /whip §0.3 at ≥60min). Their
# context accumulates until Claude's auto-compact kicks in, which is lossy +
# unpredictable. This check surfaces overdue rotations by pinging Discord
# when a teammate process has been up past ROTATE_THRESHOLD_MIN AND the pane
# is idle (rotating mid-turn would eat in-flight state).
#
# Rotation itself is manual — `/team rotate-member <name>`. That's the human-
# gated action; this check is the forcing function that makes sure you hear
# about it.

ROTATE_THRESHOLD_MIN="${ROTATE_THRESHOLD_MIN:-90}"

# Context age = time since last /clear (preferred, via clear-member.sh marker)
# or process uptime (fallback, when marker missing — e.g. never cleared).
# Marker takes precedence; sanity-cap to process uptime so corrupt marker
# can't produce age > process age.
get_member_context_age_min() {
  local member="$1" pid="$2"
  local marker="$HOME/.claude/teams/${TEAM}/member-clear-${member}.txt"
  local etimes_min
  etimes_min=$(ps -p "$pid" -o etimes= 2>/dev/null | awk '{print int($1/60)}')
  [ -z "$etimes_min" ] && return 1

  if [ -f "$marker" ]; then
    local mts
    mts=$(cat "$marker" 2>/dev/null)
    if [[ "$mts" =~ ^[0-9]+$ ]]; then
      local age_min=$(( (NOW - mts) / 60 ))
      # Sanity cap — marker newer than process start shouldn't claim bigger age
      [ "$age_min" -gt "$etimes_min" ] && age_min=$etimes_min
      echo "$age_min"
      return 0
    fi
  fi
  echo "$etimes_min"
}

check_teammate_uptime() {
  local procs
  procs=$(pgrep -af "agent-id .*@${TEAM}" 2>/dev/null | grep -v "agent-id team-lead@" || true)
  [ -z "$procs" ] && return 0

  local overdue=()
  local pid member age_min w tail

  while IFS= read -r line; do
    pid=$(echo "$line" | awk '{print $1}')
    member=$(echo "$line" | grep -oE "agent-id [^ ]+" | head -1 | awk '{print $2}' | cut -d@ -f1)
    [ -z "$member" ] || [ -z "$pid" ] && continue

    age_min=$(get_member_context_age_min "$member" "$pid") || continue
    [ "$age_min" -lt "$ROTATE_THRESHOLD_MIN" ] && continue

    # Only nag when idle — rotating mid-turn would eat in-flight state
    w="__${TEAM}__${member}"
    tail=$(tmux capture-pane -t "$w" -p -S -20 2>/dev/null | grep -v '^[[:space:]]*$' | tail -12)
    if echo "$tail" | grep -qE "(thinking with|thought for|Compacting|Cogitating|Press up to edit queued|…)"; then
      log "uptime-nag: ${member} ${age_min}min but mid-turn — skip"
      continue
    fi

    overdue+=("${member} ($(fmt_dur_min "$age_min"))")
  done <<< "$procs"

  [ "${#overdue[@]}" -eq 0 ] && return 0

  # Team-level rate-limit (single consolidated ping per 2h regardless of
  # how many teammates are overdue — avoids Discord spam on N-member teams).
  local alert_file="$HOME/.claude/teams/${TEAM}/last-uptime-nag.txt"
  if [ -f "$alert_file" ]; then
    local last=$(cat "$alert_file")
    local min_since_alert=$(( (NOW - last) / 60 ))
    if [ "$min_since_alert" -lt 120 ]; then
      log "uptime-nag: ${#overdue[@]} overdue but last nag ${min_since_alert}min ago — rate-limited"
      return 0
    fi
  fi

  local list
  list=$(printf -- "- %s\n" "${overdue[@]}")
  local msg="⏰ **rotations overdue** · \`${TEAM}\` · $(TZ='${user_config.COORDINATION_TZ}' date +'%H:%M ${user_config.COORDINATION_TZ_SUFFIX}')

${#overdue[@]} teammate(s) idle and past the $(fmt_dur_min "$ROTATE_THRESHOLD_MIN") rotation threshold — context is accumulating toward auto-compact.

${list}
Run from driver or lead: \`/team rotate-member <name>\`
(Checkpoints in-flight state, \`/clear\`s pane, re-briefs with the checkpoint.)"

  bash "$HOME/.claude/skills/whip/scripts/ping-discord.sh" "$msg" || log "ping-discord.sh exit $?"
  echo "$NOW" > "$alert_file"
  log "uptime-nag: alert fired — ${#overdue[@]} overdue"
}

# All four checks run every tick. Independent rate-limits.
check_lead_stall
check_teammate_blockers
check_lead_blocker
check_teammate_uptime
