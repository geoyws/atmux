#!/usr/bin/env bash
# cron-check-lead-rotate.sh — external cron-fired lead-rotation enforcer.
#
# Stopgap shell script implementing ADR-143's check-lead-rotate contract
# while the TypeScript verb (T2 of ADR-143 EPIC t-a6a7afa0) ships.
# Once `atmux check-lead-rotate --all-teams` lands on trunk and is
# released, this script's cron line is replaced with the verb invocation
# and the script can be removed.
#
# Per ADR-143 §Cron line:
#   Runs every 5min via cron. For each enabled team in ~/.atmux/cockpit.json:
#     1. Read ~/.claude/teams/<team>/lead-session-start.txt
#     2. Compute uptime = now - lead-start
#     3. Read leadMaxMin = team.json.whip.leadMaxMin (default 60)
#     4. If uptime > leadMaxMin: fire `atmux rotate-lead --team <name>`
#     5. Append decision to ~/.atmux/state/cron-rotate-lead.log
#
# The rotate is idempotent — `atmux rotate-lead` resets
# lead-session-start.txt to the new spawn epoch so the next tick reads
# fresh uptime.
#
# Origin: 2026-05-14 t-d75c03f0 — operator P0 activation of ADR-143
# because the failure mode (5h+ lead uptime across 3 cockpit teams) is
# happening live. Modeled on ~/.atmux/bin/whip-velocity-gate.sh which
# proved the cockpit-walk + cage-socket pattern works under cron.

set -uo pipefail

NOW_EPOCH="$(date +%s)"
NOW_MYT="$(TZ='Asia/Kuala_Lumpur' date +'%H:%M MYT %Y-%m-%d')"
COCKPIT="${ATMUX_COCKPIT_CONFIG:-$HOME/.atmux/cockpit.json}"
LOG_FILE="${LEAD_ROTATE_LOG:-$HOME/.atmux/state/cron-rotate-lead.log}"
ATMUX_BIN="${ATMUX_BIN:-/usr/local/bin/atmux}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s [%s] %s\n' "$NOW_MYT" "${TEAM:-cockpit}" "$*" >> "$LOG_FILE"
}

if [[ ! -f "$COCKPIT" ]]; then
  log "no cockpit.json at $COCKPIT — abort"
  exit 0  # cron-friendly silent exit
fi

if [[ ! -x "$ATMUX_BIN" ]]; then
  log "atmux binary not executable at $ATMUX_BIN — abort"
  exit 0
fi

# Walk enabled teams; jq emits one compact JSON object per team.
TEAMS_JSON="$(jq -c '.teams[] | select(.enabled == true) | {name, root}' "$COCKPIT" 2>/dev/null)"
if [[ -z "$TEAMS_JSON" ]]; then
  log "no enabled teams in cockpit.json — exit"
  exit 0
fi

while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  TEAM="$(jq -r '.name' <<<"$entry")"
  ROOT="$(jq -r '.root' <<<"$entry")"

  # Per-team lead-session-start.txt under ~/.claude/teams/<team>/.
  LEAD_START_FILE="$HOME/.claude/teams/$TEAM/lead-session-start.txt"
  if [[ ! -f "$LEAD_START_FILE" ]]; then
    log "lead-session-start.txt missing ($LEAD_START_FILE) — skip"
    continue
  fi

  LEAD_START="$(head -1 "$LEAD_START_FILE" 2>/dev/null | tr -d '[:space:]')"
  if [[ ! "$LEAD_START" =~ ^[0-9]+$ ]]; then
    log "lead-session-start.txt has non-numeric content — skip"
    continue
  fi

  UPTIME_SEC=$((NOW_EPOCH - LEAD_START))
  if (( UPTIME_SEC < 0 )); then
    log "negative uptime ($UPTIME_SEC) — clock skew? — skip"
    continue
  fi
  UPTIME_MIN=$((UPTIME_SEC / 60))

  # Read leadMaxMin from team.json::whip.leadMaxMin (default 60).
  TEAM_JSON="$ROOT/.atmux/team.json"
  LEAD_MAX_MIN=60
  if [[ -f "$TEAM_JSON" ]]; then
    raw="$(jq -r '.whip.leadMaxMin // empty' "$TEAM_JSON" 2>/dev/null)"
    if [[ "$raw" =~ ^[0-9]+$ ]] && (( raw > 0 )); then
      LEAD_MAX_MIN="$raw"
    fi
  fi

  if (( UPTIME_MIN <= LEAD_MAX_MIN )); then
    log "uptime ${UPTIME_MIN}min ≤ ${LEAD_MAX_MIN}min — no rotation"
    continue
  fi

  # Over threshold — fire rotate. atmux rotate-lead's `--team-dir`
  # arg is the project root (the dir that CONTAINS `.atmux/`), NOT
  # the `.atmux/` dir itself — rotate.ts plumbs through
  # getAtmuxDir({teamDir}) which appends `.atmux/team.json` to the
  # passed value. Best-effort + log exit code; cron retries next
  # tick on failure.
  log "uptime ${UPTIME_MIN}min > ${LEAD_MAX_MIN}min — firing atmux rotate-lead --team-dir $ROOT"
  if "$ATMUX_BIN" rotate-lead --team-dir "$ROOT" >> "$LOG_FILE" 2>&1; then
    log "rotate-lead OK"
    # rotate.ts does NOT refresh lead-session-start.txt today (gap;
    # follow-up task filed). Without this, the next cron tick reads
    # the same stale uptime and re-rotates — flap loop. Fire
    # `whip --init-lead-marker` which unconditionally rewrites the
    # marker (whip.ts:881-887) so the next tick sees fresh uptime.
    if "$ATMUX_BIN" whip --init-lead-marker --team-dir "$ROOT" >> "$LOG_FILE" 2>&1; then
      log "lead-session-start.txt refreshed via whip --init-lead-marker"
    else
      log "WARN: whip --init-lead-marker failed — next tick may re-rotate"
    fi
  else
    log "rotate-lead exited non-zero (see preceding lines) — will retry next tick"
  fi
done <<<"$TEAMS_JSON"
