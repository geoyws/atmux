#!/usr/bin/env bash
# scripts/backfill-driver-only.sh — one-shot: set driverOnly=true on the 9
# known driver-fires Tasks (E14T3 backfill).
#
# Per E14T3 deliverable. Run-once, idempotent. Driver-fired (this script
# rewrites multi-Task schema; auto-claim by a non-driver worker is unsafe,
# which is why E14T3 itself is driverOnly:true via the schema landed in
# E14T1 + the refuse-gate landed in E14T2).
#
# Atomicity: single atmux::jq_update call wraps all 9 mutations under one
# flock + post-write JSON sanity probe (see lib/common.sh F12). Pre-write
# snapshot via atmux::kanban_json_backup makes recovery painless on the
# corruption path.
#
# Usage: scripts/backfill-driver-only.sh [--team-dir <project-root>]
#   --team-dir   pin the project root explicitly (cron-friendly).
#                Defaults to $ATMUX_TEAM_DIR or walk-up from cwd.

set -euo pipefail

# ---- Resolve ATMUX_ROOT + load common.sh (mirrors bin/atmux) ----
_self="${BASH_SOURCE[0]}"
while [[ -L "$_self" ]]; do
  _self_dir="$(cd -P "$(dirname "$_self")" && pwd)"
  _self="$(readlink "$_self")"
  [[ "$_self" != /* ]] && _self="$_self_dir/$_self"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_self")" && pwd)"
ATMUX_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export ATMUX_ROOT
export ATMUX_LIB_DIR="$ATMUX_ROOT/lib"
export ATMUX_TEMPLATES_DIR="$ATMUX_ROOT/templates"
unset _self _self_dir

if [[ "${1:-}" == "--team-dir" ]]; then
  export ATMUX_TEAM_DIR="${2:?--team-dir requires a path}"
  shift 2
fi

# shellcheck source=../lib/common.sh
. "$ATMUX_LIB_DIR/common.sh"

atmux::require jq

# ---- The 9 known driver-fires Task IDs ----
TARGET_IDS=(
  t-dfe8f0df  # E10/Sh registry-backfill
  t-3b8a2f55  # E9 migrate marker
  t-72df5c45  # E6 promote
  t-b7ac1bc5  # E7 promote
  t-66b870d0  # E8 Epic-end deploy
  t-fcd68186  # E9 Epic-end deploy
  t-ef999a93  # E10 Epic-end deploy
  t-14fba59e  # E11 Epic-end deploy
  t-930a74a9  # E13/Sh socket-pubsub promote
)

KJ="$(atmux::kanban_json)"
[[ -f "$KJ" ]] || atmux::die "backfill: kanban.json not found at $KJ"

# Capture before-state per ID. Output is "<value>" (true|false|null) or
# "MISSING" if the task isn't in .tasks at all.
_state_for() {
  local id="$1" file="$2"
  jq -r --arg id "$id" '
    if any(.tasks[]; .id == $id) then
      (.tasks[] | select(.id == $id) | (.driverOnly // false) | tostring)
    else
      "MISSING"
    end
  ' "$file"
}

declare -A BEFORE
for id in "${TARGET_IDS[@]}"; do
  BEFORE[$id]="$(_state_for "$id" "$KJ")"
done

# Snapshot kanban before the multi-Task write. Non-fatal on cp failure
# (atmux::kanban_json_backup degrades gracefully).
BAK="$(atmux::kanban_json_backup || true)"
[[ -n "$BAK" ]] && atmux::log "backfill: kanban snapshot → $BAK"

# Build the jq filter — single atomic write under flock.
ids_json="$(printf '%s\n' "${TARGET_IDS[@]}" | jq -R . | jq -s .)"
filter='
  .tasks |= map(
    if (.id as $i | $ids | index($i)) then
      .driverOnly = true
    else
      .
    end
  )
'

if ! atmux::jq_update "$KJ" "$filter" --argjson ids "$ids_json"; then
  atmux::die "backfill: jq_update failed (kanban left untouched; backup: ${BAK:-none})"
fi

# Re-read after the write and emit a before/after table.
declare -A AFTER
for id in "${TARGET_IDS[@]}"; do
  AFTER[$id]="$(_state_for "$id" "$KJ")"
done

printf '\n'
printf '%-12s  %-7s  %-7s  %s\n' 'task'    'before'  'after'   'note'
printf '%-12s  %-7s  %-7s  %s\n' '----'    '------'  '-----'   '----'

changed=0; noop=0; missing=0
for id in "${TARGET_IDS[@]}"; do
  b="${BEFORE[$id]}"
  a="${AFTER[$id]}"
  if [[ "$a" == "MISSING" ]]; then
    note='not in kanban'
    missing=$((missing + 1))
  elif [[ "$b" == "true" && "$a" == "true" ]]; then
    note='no-op (already true)'
    noop=$((noop + 1))
  elif [[ "$a" == "true" ]]; then
    note='set'
    changed=$((changed + 1))
  else
    note='UNEXPECTED — review'
  fi
  printf '%-12s  %-7s  %-7s  %s\n' "$id" "$b" "$a" "$note"
done

printf '\n'
atmux::log "backfill: target=${#TARGET_IDS[@]} set=${changed} no-op=${noop} missing=${missing}"
[[ "$missing" -eq 0 ]] || atmux::warn "backfill: ${missing} target ID(s) missing from kanban — verify ID list"
