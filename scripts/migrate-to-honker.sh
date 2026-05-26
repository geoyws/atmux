#!/usr/bin/env bash
# scripts/migrate-to-honker.sh — post-restart Honker substrate verifier.
#
# Per ADR-217 §Half B + ADR-202 (Honker substrate) + ADR-212 §D2
# (lead-gated). Operator runs this AFTER each team has been migrated
# to the Honker substrate (i.e. the team's cage restarted with the
# binary at ~/.atmux/extensions/honker.so present). Verifies the
# post-restart state without touching anything: READ-ONLY.
#
# Interface:
#   scripts/migrate-to-honker.sh <team-name>          # single-team
#   scripts/migrate-to-honker.sh --all                # iterate 5 teams
#   scripts/migrate-to-honker.sh --all --json         # machine-parseable
#   scripts/migrate-to-honker.sh <team> --json        # single + JSON
#
# Active teams (per ADR-217 §Half B): atmux, unum, sopx, rentx, ifca-docs.
# atmux is the LAST team to migrate (driver lives inside) — this script
# does NOT enforce ordering; that's the playbook's job at
# docs/RUNBOOK-migrate-to-honker.md.
#
# Per-team checks (each independently scored — all-green = team passes):
#   1. atmux doctor --json → atmux-honker check is "green" status
#   2. atmux status --json → sessionState=up + at least one member has
#      cageState in {active, bootstrapping} (live pane present)
#   3. .atmux/logs/honker.log contains a "loaded" marker (best-effort —
#      missing log file does NOT fail the check on its own; the doctor
#      probe at check 1 is the source of truth)
#   4. atmux event tail | head -1 succeeds (event substrate alive — info
#      only; missing event verb on older atmux does NOT fail)
#
# Exit codes:
#   0  all teams green (or single team green)
#   1  any team failed any check
#   2  usage error (bad args, unknown team, no cage)
#
# CRITICAL — destructive guardrails:
#   This script issues NO mutating atmux verbs (no soft-stop, no
#   hard-stop, no member-clear, no signal-sending). Per ADR-212 §D2,
#   teardown is lead-gated and NOT operator-tool-automated. The
#   verifier is strictly read-only. The paired test (t-b2051762) greps
#   this file body for the obvious destructive verb tokens and exits
#   non-zero if any appear.

set -euo pipefail

# ---------- Active teams (per ADR-217 §Half B) ----------

ACTIVE_TEAMS=(atmux unum sopx rentx ifca-docs)

# ---------- Team-cage resolution ----------
#
# Operator convention: each team lives at /root/work/src/<team-name> with
# .atmux/ at the root. Override the base via ATMUX_TEAMS_BASE (test
# injection). For non-standard layouts, the script falls back to reading
# ~/.atmux/cockpit.json for an explicit `cwd` field per session entry.

resolve_team_dir() {
  local team=$1
  local base=${ATMUX_TEAMS_BASE:-/root/work/src}
  local cwd="${base}/${team}"

  if [[ -d "${cwd}/.atmux" ]]; then
    printf '%s\n' "${cwd}"
    return 0
  fi

  # Fallback: cockpit.json may carry an explicit cwd override.
  local cockpit_json=${ATMUX_COCKPIT_CONFIG:-${HOME}/.atmux/cockpit.json}
  if [[ -f "${cockpit_json}" ]]; then
    local from_cockpit
    from_cockpit=$(jq -r --arg t "${team}" \
      '.sessions[]? | select(.name == $t) | .cwd // empty' \
      "${cockpit_json}" 2>/dev/null || true)
    if [[ -n "${from_cockpit}" ]] && [[ -d "${from_cockpit}/.atmux" ]]; then
      printf '%s\n' "${from_cockpit}"
      return 0
    fi
  fi

  return 1
}

# ---------- Per-check helpers ----------

check_doctor_honker() {
  local team_dir=$1
  local row
  row=$(cd "${team_dir}" && atmux doctor --json 2>/dev/null \
    | jq -c '.checks[]? | select(.label == "honker")' 2>/dev/null || true)
  if [[ -z "${row}" ]]; then
    printf 'fail|doctor probe absent (atmux build pre-ADR-202 §D11?)\n'
    return 1
  fi
  local status
  status=$(printf '%s' "${row}" | jq -r '.status // "unknown"')
  if [[ "${status}" == "green" ]]; then
    printf 'pass|doctor honker=green\n'
    return 0
  fi
  printf 'fail|doctor honker=%s\n' "${status}"
  return 1
}

check_status_session_up() {
  local team_dir=$1
  local out
  out=$(cd "${team_dir}" && atmux status --json 2>/dev/null || true)
  if [[ -z "${out}" ]]; then
    printf 'fail|status verb returned no output\n'
    return 1
  fi
  local session_state
  session_state=$(printf '%s' "${out}" | jq -r '.sessionState // "unknown"')
  if [[ "${session_state}" != "up" ]]; then
    printf 'fail|sessionState=%s (expected up)\n' "${session_state}"
    return 1
  fi
  local live_count
  live_count=$(printf '%s' "${out}" \
    | jq '[.members[]? | select(.cageState == "active" or .cageState == "bootstrapping")] | length')
  if [[ "${live_count}" -lt 1 ]]; then
    printf 'fail|no member panes in active/bootstrapping state\n'
    return 1
  fi
  printf 'pass|sessionState=up + %s live member pane(s)\n' "${live_count}"
}

check_honker_log_loaded() {
  local team_dir=$1
  local log="${team_dir}/.atmux/logs/honker.log"
  if [[ ! -f "${log}" ]]; then
    # Best-effort: not finding the log file is INFO (doctor probe is the
    # authoritative signal), not a hard fail.
    printf 'info|.atmux/logs/honker.log absent (doctor probe is the source of truth)\n'
    return 0
  fi
  if grep -q 'loaded' "${log}" 2>/dev/null; then
    printf 'pass|honker.log contains "loaded" marker\n'
    return 0
  fi
  printf 'fail|honker.log present but no "loaded" marker found\n'
  return 1
}

check_event_substrate() {
  local team_dir=$1
  # Optional probe — older atmux releases pre-ADR-203 won't have
  # `atmux event tail`. A missing verb is INFO, not a fail.
  if ! (cd "${team_dir}" && atmux event tail 2>/dev/null | head -1 >/dev/null); then
    printf 'info|atmux event tail not available (pre-ADR-203 release?)\n'
    return 0
  fi
  printf 'pass|event substrate responsive\n'
}

# ---------- Per-team driver ----------

verify_team() {
  local team=$1
  local team_dir
  if ! team_dir=$(resolve_team_dir "${team}" 2>/dev/null); then
    printf 'TEAM=%s STATUS=skip REASON=no_cage_at_/root/work/src/%s_or_cockpit_cwd\n' \
      "${team}" "${team}"
    return 2
  fi

  local team_result=0
  local doctor_result status_result log_result event_result

  doctor_result=$(check_doctor_honker "${team_dir}") || team_result=1
  status_result=$(check_status_session_up "${team_dir}") || team_result=1
  log_result=$(check_honker_log_loaded "${team_dir}") || team_result=1
  event_result=$(check_event_substrate "${team_dir}") || true # info-only

  if [[ "${MIGRATE_HONKER_JSON:-}" == "1" ]]; then
    jq -nc \
      --arg team "${team}" \
      --arg team_dir "${team_dir}" \
      --arg doctor "${doctor_result}" \
      --arg status "${status_result}" \
      --arg log "${log_result}" \
      --arg event "${event_result}" \
      --argjson passed "$( [[ ${team_result} -eq 0 ]] && echo true || echo false )" \
      '{team: $team, team_dir: $team_dir, passed: $passed,
        checks: {doctor_honker: $doctor, status_up: $status,
                 honker_log: $log, event_substrate: $event}}'
  else
    if [[ ${team_result} -eq 0 ]]; then
      printf '🟢 %s (%s) — all checks pass\n' "${team}" "${team_dir}"
    else
      printf '🔴 %s (%s) — failed\n' "${team}" "${team_dir}"
    fi
    printf '   doctor : %s\n' "${doctor_result}"
    printf '   status : %s\n' "${status_result}"
    printf '   log    : %s\n' "${log_result}"
    printf '   event  : %s\n' "${event_result}"
  fi

  return "${team_result}"
}

# ---------- Arg parsing ----------

usage() {
  cat >&2 <<EOF
usage: scripts/migrate-to-honker.sh <team-name> [--json]
       scripts/migrate-to-honker.sh --all [--json]

Verify post-restart Honker substrate state for an atmux team or all 5
active teams (atmux, unum, sopx, rentx, ifca-docs).

Per ADR-217 §Half B + ADR-202 + ADR-212 §D2. READ-ONLY: this script
never stops, kills, or otherwise mutates team state.

Options:
  --all        iterate all 5 active teams
  --json       emit machine-parseable JSON (one object per team)

Exit codes:
  0  all checked teams green
  1  any team failed any required check
  2  usage error (bad args, unknown team, no cage)

Environment overrides:
  ATMUX_TEAMS_BASE       base dir to resolve team cages (default: /root/work/src)
  ATMUX_COCKPIT_CONFIG   alternate cockpit.json path
EOF
}

main() {
  local mode=""
  local team=""
  local json=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)
        mode="all"
        shift
        ;;
      --json)
        json=1
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      -*)
        printf 'unknown flag: %s\n' "$1" >&2
        usage
        return 2
        ;;
      *)
        if [[ -n "${team}" ]]; then
          printf 'too many positional args (already have team=%s, got %s)\n' \
            "${team}" "$1" >&2
          return 2
        fi
        team="$1"
        shift
        ;;
    esac
  done

  if [[ -z "${mode}" ]] && [[ -z "${team}" ]]; then
    usage
    return 2
  fi
  if [[ "${mode}" == "all" ]] && [[ -n "${team}" ]]; then
    printf 'cannot combine --all with a positional team name\n' >&2
    return 2
  fi

  export MIGRATE_HONKER_JSON="${json}"

  local overall=0
  if [[ "${mode}" == "all" ]]; then
    for t in "${ACTIVE_TEAMS[@]}"; do
      verify_team "${t}" || overall=1
    done
  else
    verify_team "${team}" || overall=$?
    # verify_team returns 2 for "no cage" → propagate as usage-like signal
    # but typically operators see the per-team `skip` line + exit 1.
    if [[ ${overall} -eq 2 ]]; then
      overall=1
    fi
  fi

  return "${overall}"
}

main "$@"
