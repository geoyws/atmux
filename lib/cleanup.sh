#!/usr/bin/env bash
# atmux cleanup <subcommand> [--max-size <bytes>] [--max-age-days <N>] [--dry-run]
#   logs       Rotate large .atmux/logs/*.log files (default: rotate >1MB)
#   inboxes    Prune old .done[] entries from .atmux/inboxes/*.json (default: >7d)
#   all        Both
#
# Idempotent + cron-safe. Default thresholds are conservative; `--dry-run`
# reports what WOULD change without touching anything. State files (kanban,
# team.json, state/*) are NEVER touched — those are authoritative.
#
# Why this exists: whip + report + dispatch logs grow append-only forever.
# After 6 months on hax `report.log` was 750KB+, `be-kanban.json` inbox
# was 108KB (mostly stale `.done[]` entries from completed tasks). Long-
# running teams need a periodic broom; the alternative is operators
# remembering to `>` the files manually, which they don't.

main() {
  atmux::require jq
  atmux::require_team

  local sub="${1:-}"; shift || true
  case "$sub" in
    logs)     _atmux_cleanup_logs    "$@" ;;
    inboxes)  _atmux_cleanup_inboxes "$@" ;;
    all)      _atmux_cleanup_logs "$@"; _atmux_cleanup_inboxes "$@" ;;
    "")       atmux::die "cleanup: missing subcommand (use logs | inboxes | all)" ;;
    *)        atmux::die "cleanup: unknown subcommand: $sub" ;;
  esac
}

# Default: rotate any *.log file >1MB to *.log.1 (one generation only —
# operators who want longer retention should run logrotate). The current
# *.log gets truncated; *.log.1 keeps the snapshot. Repeated runs overwrite
# the .1 snapshot each rotation — log history isn't a durable store.
_atmux_cleanup_logs() {
  local max_bytes=$((1024 * 1024))   # 1MB
  local dry_run=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max-size)    max_bytes="$2"; shift 2 ;;
      --max-age-days) shift 2 ;;     # ignored for logs (size-based only)
      --dry-run)     dry_run=1; shift ;;
      *) atmux::die "cleanup logs: unknown arg: $1" ;;
    esac
  done

  local logs_dir; logs_dir="$(atmux::logs_dir)"
  [[ -d "$logs_dir" ]] || { atmux::log "cleanup logs: $logs_dir absent — nothing to do"; return 0; }

  local rotated=0 skipped=0
  local f size
  for f in "$logs_dir"/*.log; do
    [[ -f "$f" ]] || continue
    size=$(stat -c '%s' "$f" 2>/dev/null || stat -f '%z' "$f" 2>/dev/null || echo 0)
    if (( size > max_bytes )); then
      if [[ "$dry_run" -eq 1 ]]; then
        printf '  [dry-run] would rotate %s (%s bytes)\n' "$f" "$size"
      else
        mv "$f" "$f.1"
        : > "$f"
        atmux::log "cleanup logs: rotated $f → $f.1 ($size bytes)"
      fi
      rotated=$((rotated + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [[ "$dry_run" -eq 1 ]]; then
    atmux::ok "cleanup logs (dry-run): $rotated would rotate, $skipped under cap"
  else
    atmux::ok "cleanup logs: $rotated rotated, $skipped under cap (cap=${max_bytes}B)"
  fi
}

# Default: prune .done[] entries older than 7 days from every member inbox.
# `.completedAt` is the anchor (set by lib/kanban.sh's finish_task_done +
# claim.sh's _atmux_inbox_move). Entries without completedAt are kept (we
# don't know their age). .pending[] and .inProgress[] are untouched —
# those represent live work + active dispatches.
_atmux_cleanup_inboxes() {
  local max_age_days=7
  local dry_run=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --max-age-days) max_age_days="$2"; shift 2 ;;
      --max-size)     shift 2 ;;     # ignored for inboxes (age-based only)
      --dry-run)      dry_run=1; shift ;;
      *) atmux::die "cleanup inboxes: unknown arg: $1" ;;
    esac
  done

  [[ "$max_age_days" =~ ^[1-9][0-9]*$ ]] \
    || atmux::die "cleanup inboxes: --max-age-days must be a positive integer"

  local cutoff; cutoff=$(( $(atmux::now_epoch) - max_age_days * 86400 ))
  local ib_dir; ib_dir="$(atmux::inbox_dir)"
  [[ -d "$ib_dir" ]] || { atmux::log "cleanup inboxes: $ib_dir absent"; return 0; }

  local pruned_total=0 kept_total=0
  local ib
  for ib in "$ib_dir"/*.json; do
    [[ -f "$ib" ]] || continue
    local before after
    before=$(jq '.done | length' "$ib" 2>/dev/null || echo 0)

    if [[ "$dry_run" -eq 1 ]]; then
      after=$(jq --argjson c "$cutoff" \
        '[.done[]? | select((.completedAt // 0) >= $c or (.completedAt // 0) == 0)] | length' \
        "$ib" 2>/dev/null || echo "$before")
    else
      # E6/S1 t-04b79538 (A1 site 3/6) — atmux::jq_update for flock'd
      # atomic write per ADR-013. Filter logic preserved verbatim.
      atmux::jq_update "$ib" \
        '.done = [.done[]? | select((.completedAt // 0) >= $c or (.completedAt // 0) == 0)]' \
        --argjson c "$cutoff"
      after=$(jq '.done | length' "$ib")
    fi

    local pruned=$((before - after))
    pruned_total=$((pruned_total + pruned))
    kept_total=$((kept_total + after))
    if (( pruned > 0 )); then
      if [[ "$dry_run" -eq 1 ]]; then
        printf '  [dry-run] %s: would prune %d done[], keep %d\n' "$(basename "$ib")" "$pruned" "$after"
      else
        atmux::log "cleanup inboxes: $(basename "$ib") pruned=$pruned kept=$after"
      fi
    fi
  done

  if [[ "$dry_run" -eq 1 ]]; then
    atmux::ok "cleanup inboxes (dry-run): would prune $pruned_total entries (>${max_age_days}d), $kept_total recent kept"
  else
    atmux::ok "cleanup inboxes: pruned $pruned_total entries (>${max_age_days}d), $kept_total kept"
  fi
}
