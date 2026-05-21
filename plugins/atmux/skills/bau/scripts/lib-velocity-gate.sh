#!/usr/bin/env bash
# Cross-cuts the bau verdict ladder against whip-velocity-gate.log (per
# t-0a4fc7f6 / driver-inbox 2026-05-14 driver-inbox entry).
#
# Extracted to its own lib so the bats suite at tests/bau.bats can source +
# unit-test the function in isolation. Sourced into bau.sh; no executable
# top-level code beyond the function declaration.
#
# The function's contract is documented inline above its declaration.

# Returns 0 (success / OK) iff ANY of the team's last 3 velocity-readings
# in whip-velocity-gate.log shows `velocity=OK`. Returns 1 otherwise.
#
# Reads from $WHIP_VG_LOG (test override) or canonical
# $HOME/.atmux/logs/whip-velocity-gate.log.
#
# Log line shape (canonical, matches the live writer):
#   HH:MM <TZ> YYYY-MM-DD [<team>] velocity=OK commits-30min=N last-sha=... ...
#   HH:MM <TZ> YYYY-MM-DD [<team>] velocity=BAD commits-30min=0 ...
# Action lines (e.g. `BAD — menu injected, strike 1`) do NOT carry the
# `velocity=` token and are correctly skipped by the grep below.
team_recent_velocity_ok() {
  local team="$1"
  local log="${WHIP_VG_LOG:-$HOME/.atmux/logs/whip-velocity-gate.log}"
  [[ -f "$log" ]] || return 1
  # Pull last 3 velocity-readings for this team (newest-first), then
  # any-OK fires success.
  tac "$log" 2>/dev/null \
    | grep -E "\[${team}\] velocity=" \
    | head -3 \
    | grep -q "velocity=OK"
}
