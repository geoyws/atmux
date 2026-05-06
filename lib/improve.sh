#!/usr/bin/env bash
# atmux improve — eternal-improvement loop arming verb (ADR-052).
#
# T2 shipped: state-file path/read/write primitives + --status read.
# T1 ships: args parser, budget spec/resolver, idempotence guard, state
# writer that ARMS the loop. T7 lands the cycle mechanics on top.
#
# State file: <atmuxDir>/state/eternal-improvement.json
# Lock file:  <atmuxDir>/state/eternal-improvement.json.lock
#
# Burn-in compat: shape matches `src/schema/eternal-improvement.ts`
# byte-for-byte (per `src/schema/README.md` §"Burn-in compatibility").
# Bash never writes `schemaVersion` per ADR-016.

# ---------- T2 primitives ----------

# _atmux_improve_state_path — print the state-file path on stdout.
_atmux_improve_state_path() {
  printf '%s/eternal-improvement.json\n' "$(atmux::state_dir)"
}

# _atmux_improve_state_read — print the state file's contents on stdout.
# On missing file, prints `{}` (matches the `atmux improve --status` contract:
# "On missing file → '{}' (not error)"). Locking is unnecessary on the read
# path — atomic-rename writes guarantee the reader sees pre- or post-write
# state, never a torn write.
_atmux_improve_state_read() {
  local file; file="$(_atmux_improve_state_path)"
  if [[ -s "$file" ]]; then
    cat "$file"
  else
    printf '{}\n'
  fi
}

# _atmux_improve_state_write_jq <jq-filter> [jq args...]
# Atomic jq-driven update of the state file under a NON-BLOCKING flock.
# On contention the write is skipped with a non-fatal log line — matches
# the `whip-idle-state.json.lock` posture per ADR-052 §State-file-schema
# (mid-cycle accounting writes would rather lose a tick than wedge whip).
# Returns 0 always (skip is non-fatal).
_atmux_improve_state_write_jq() {
  local filter="$1"; shift
  local file; file="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$file")"
  local lockfd
  exec {lockfd}>"${file}.lock"
  if ! flock -n "$lockfd"; then
    atmux::log "improve: state-file locked, skipping (non-fatal)"
    exec {lockfd}>&-
    return 0
  fi
  local tmp; tmp="$(mktemp "${file}.XXXXXX")"
  if [[ -s "$file" ]]; then
    jq "$@" "$filter" "$file" >"$tmp"
  else
    jq -n "$@" "$filter" >"$tmp"
  fi
  mv "$tmp" "$file"
  exec {lockfd}>&-
}
