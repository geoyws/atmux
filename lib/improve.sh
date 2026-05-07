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

# ---------- T1 constants ----------

readonly _ATMUX_IMPROVE_DEFAULT_SPEC="30%-wk"
readonly _ATMUX_IMPROVE_5H_CAP=5000000        # tokens; ADR-049 default
readonly _ATMUX_IMPROVE_WK_CAP=100000000      # tokens; ADR-049 default
readonly _ATMUX_IMPROVE_STALE_RUN_SEC=86400   # 24h
readonly _ATMUX_IMPROVE_STALE_CYCLE_SEC=21600 # 6h
readonly _ATMUX_IMPROVE_HISTORY_MAX=50

# ---------- T1 paths ----------

_atmux_improve_probe_path() {
  printf '%s/budget-probe-%s.json\n' "$(atmux::state_dir)" "$(atmux::team_name)"
}

# ---------- T1 runId ----------

_atmux_improve_gen_run_id() {
  printf 'ei-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

# ---------- T1 budget spec parser ----------

# _atmux_improve_parse_spec <spec>
# Echoes "<kind> <value>" on success: "raw <int>", "pct-5h <pct>", "pct-wk <pct>".
# Returns 1 on parse failure.
_atmux_improve_parse_spec() {
  local spec="$1"
  if [[ "$spec" =~ ^[0-9]+$ ]]; then
    printf 'raw %s\n' "$spec"
    return 0
  fi
  if [[ "$spec" =~ ^([0-9]+)%(-(5h|wk))?$ ]]; then
    local pct="${BASH_REMATCH[1]}"
    local window="${BASH_REMATCH[3]:-wk}"
    if (( pct < 0 || pct > 100 )); then return 1; fi
    case "$window" in
      5h) printf 'pct-5h %s\n' "$pct" ;;
      wk) printf 'pct-wk %s\n' "$pct" ;;
      *)  return 1 ;;
    esac
    return 0
  fi
  return 1
}

# ---------- T1 budget resolution ----------

# Reads the team's budget-probe file, prints `h5_util` and `wk_util` on
# stdout (space-separated). Status 1 if the probe is missing.
_atmux_improve_read_probe() {
  local p; p="$(_atmux_improve_probe_path)"
  if [[ ! -f "$p" ]]; then return 1; fi
  jq -r '"\(.h5_util // 0) \(.wk_util // 0)"' "$p" 2>/dev/null || return 1
}

# _atmux_improve_resolve_budget <kind> <value>
# Echoes "<total>\t<formula>" on success, returns 1 on no-probe-no-raw.
# Tab separator keeps the formula's spaces intact for the caller's `read`.
_atmux_improve_resolve_budget() {
  local kind="$1" value="$2"
  if [[ "$kind" == "raw" ]]; then
    printf '%s\traw=%s\n' "$value" "$value"
    return 0
  fi
  local probe h5 wk
  if ! probe="$(_atmux_improve_read_probe)"; then return 1; fi
  read -r h5 wk <<<"$probe"
  local cap remain total
  case "$kind" in
    pct-5h)
      cap="$_ATMUX_IMPROVE_5H_CAP"
      remain=$(awk -v c="$cap" -v u="$h5" 'BEGIN{r=(1-u)*c; if(r<0)r=0; printf "%d", r}')
      total=$(awk -v p="$value" -v r="$remain" 'BEGIN{printf "%d", (p/100)*r}')
      printf '%s\t%s%% × (1 − h5_util=%.2f) × cap5h=%s\n' "$total" "$value" "$h5" "$cap"
      ;;
    pct-wk)
      cap="$_ATMUX_IMPROVE_WK_CAP"
      remain=$(awk -v c="$cap" -v u="$wk" 'BEGIN{r=(1-u)*c; if(r<0)r=0; printf "%d", r}')
      total=$(awk -v p="$value" -v r="$remain" 'BEGIN{printf "%d", (p/100)*r}')
      printf '%s\t%s%% × (1 − wk_util=%.2f) × capWk=%s\n' "$total" "$value" "$wk" "$cap"
      ;;
    *) return 1 ;;
  esac
}

# ---------- T1 precedence resolver ----------

# _atmux_improve_resolve_spec <cli-budget>
# Echoes the effective spec string per ADR-052 precedence:
#   1. CLI --budget 2. ATMUX_IMPROVE_BUDGET 3. team.improve.defaultBudget 4. default
_atmux_improve_resolve_spec() {
  local cli="$1"
  if [[ -n "$cli" ]]; then printf '%s\n' "$cli"; return 0; fi
  if [[ -n "${ATMUX_IMPROVE_BUDGET:-}" ]]; then
    printf '%s\n' "$ATMUX_IMPROVE_BUDGET"; return 0
  fi
  local from_team
  from_team="$(jq -r '.improve.defaultBudget // empty' "$(atmux::team_json)" 2>/dev/null)"
  if [[ -n "$from_team" && "$from_team" != "null" ]]; then
    printf '%s\n' "$from_team"; return 0
  fi
  printf '%s\n' "$_ATMUX_IMPROVE_DEFAULT_SPEC"
}

# ---------- T1 idempotence ----------

# _atmux_improve_is_active <state-json-string>
# Returns 0 if the file represents an active, non-stale run.
_atmux_improve_is_active() {
  local state="$1"
  local active; active="$(jq -r '.active // false' <<<"$state")"
  if [[ "$active" != "true" ]]; then return 1; fi
  local now started age
  now="$(atmux::now_epoch)"
  started="$(jq -r '.startedAt // 0' <<<"$state")"
  age=$(( now - started ))
  if (( age > _ATMUX_IMPROVE_STALE_RUN_SEC )); then
    local last_cyc
    last_cyc="$(jq -r '.currentCycle.startedAt // 0' <<<"$state")"
    if (( now - last_cyc > _ATMUX_IMPROVE_STALE_CYCLE_SEC )); then return 1; fi
  fi
  return 0
}

# ---------- main ----------

main() {
  atmux::require jq
  atmux::require_team
  atmux::ensure_dirs

  local cli_budget="" status=0 tick=0 dry_run=0 default_budget=0 idle_fallback=0 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --budget)         cli_budget="$2"; shift 2 ;;
      --status)         status=1; shift ;;
      --tick)           tick=1; shift ;;
      --dry-run)        dry_run=1; shift ;;
      --default-budget) default_budget=1; shift ;;
      --idle-fallback)  idle_fallback=1; shift ;;
      --force)          force=1; shift ;;
      *) atmux::die "improve: unknown arg: $1" ;;
    esac
  done

  local state_path; state_path="$(_atmux_improve_state_path)"

  # --status — read existing, emit JSON, exit 0.
  if (( status == 1 )); then
    _atmux_improve_state_read
    return 0
  fi

  # --tick — poll one cycle iteration. ADR-052 T7 §"Loop mechanics".
  # Idempotent; safe to call on a quiescent state.
  if (( tick == 1 )); then
    _atmux_improve_tick "$state_path"
    return 0
  fi

  # Resolve effective spec + parse + resolve to int tokens.
  local spec; spec="$(_atmux_improve_resolve_spec "$cli_budget")"
  local parsed
  if ! parsed="$(_atmux_improve_parse_spec "$spec")"; then
    atmux::die "improve: invalid budget spec: $spec (forms: <int> | <int>% | <int>%-5h | <int>%-wk)"
  fi
  local kind value
  read -r kind value <<<"$parsed"

  local resolved
  if ! resolved="$(_atmux_improve_resolve_budget "$kind" "$value")"; then
    atmux::die "improve: budget cannot be resolved; pass --budget explicitly (no $(_atmux_improve_probe_path) available)"
  fi
  local total formula
  total="$(printf '%s' "$resolved" | cut -f1)"
  formula="$(printf '%s' "$resolved" | cut -f2-)"

  # --dry-run — print + exit, no writes.
  if (( dry_run == 1 )); then
    printf 'improve: dry-run\n'
    printf '  spec:    %s\n' "$spec"
    printf '  formula: %s\n' "$formula"
    printf '  total:   %s tokens\n' "$total"
    printf '  state:   %s\n' "$state_path"
    return 0
  fi

  # Idempotence + arm under the file lock.
  local mode
  if (( idle_fallback == 1 )); then mode="idle-fallback"; else mode="user-invoked"; fi
  local now_epoch run_id
  now_epoch="$(atmux::now_epoch)"
  run_id="$(_atmux_improve_gen_run_id)"

  atmux::with_lock "$state_path" _atmux_improve_arm_locked \
    "$state_path" "$force" "$now_epoch" "$run_id" "$mode" "$spec" "$total"

  # ADR-052 T7: open cycle 1 + arm directive to lead. Skipped when
  # _atmux_improve_arm_locked refused (active-run idempotent skip) —
  # the state file's cycleN remains at the previous run's value, and
  # this open-cycle call would clobber an existing currentCycle.
  # Detect refusal by reading state's runId — if it matches what we
  # just generated, the arm landed; otherwise skip.
  if [[ -s "$state_path" ]] && [[ "$(jq -r '.runId // ""' "$state_path")" == "$run_id" ]]; then
    _atmux_improve_cycle_open "$state_path" "$now_epoch"
    local new_cycle_n; new_cycle_n="$(jq -r '.cycleN // 0' "$state_path")"
    _atmux_improve_arm_directive "$run_id" "$new_cycle_n"
  fi
}

# _atmux_improve_tick <state-file>
# One cycle-loop iteration. Reads state + kanban; pauses on driver
# preempt; closes the cycle when all dispatched tasks are done+committed
# (completedAt non-null); terminates on budget exhaustion; otherwise
# opens the next cycle + arms a new directive.
_atmux_improve_tick() {
  local state_path="$1"
  [[ -s "$state_path" ]] || return 0
  local active; active="$(jq -r '.active // false' "$state_path")"
  [[ "$active" == "true" ]] || return 0
  local has_cycle; has_cycle="$(jq -r '.currentCycle // empty | "yes"' "$state_path")"
  [[ "$has_cycle" == "yes" ]] || return 0

  # Mid-run preemption: driver Task in-progress with foreign epic.
  if _atmux_improve_is_driver_preempt; then
    local already_paused
    already_paused="$(jq -r '.currentCycle.paused // false' "$state_path")"
    if [[ "$already_paused" != "true" ]]; then
      _atmux_improve_state_write_jq '.currentCycle.paused = true'
      atmux::log "improve: driver Task in-flight — pausing cycle"
    fi
    return 0
  fi

  if ! _atmux_improve_is_cycle_closable "$state_path"; then
    return 0
  fi

  local now_epoch; now_epoch="$(atmux::now_epoch)"
  # Snap token-spend delta. Bash side defaults to 0; future T7-bash
  # extension (or T6 whip integration) can pass a non-zero delta via
  # `ATMUX_IMPROVE_TICK_DELTA_TOKENS` env.
  local delta="${ATMUX_IMPROVE_TICK_DELTA_TOKENS:-0}"
  _atmux_improve_cycle_close "$state_path" "$now_epoch" "$delta"

  if _atmux_improve_should_terminate "$state_path"; then
    _atmux_improve_state_write_jq '.active = false'
    atmux::log "improve: budget exhausted — run terminated"
    # Mode B: invoke `atmux stop` directly. Defer to caller for now —
    # terminating bash-side requires its own atmux invocation which adds
    # substantial test surface; T6 whip integration owns that wiring.
    return 0
  fi

  # Re-arm: open next cycle + new directive.
  _atmux_improve_cycle_open "$state_path" "$now_epoch"
  local run_id; run_id="$(jq -r '.runId // ""' "$state_path")"
  local new_cycle_n; new_cycle_n="$(jq -r '.cycleN // 0' "$state_path")"
  _atmux_improve_arm_directive "$run_id" "$new_cycle_n"
}

# Body of the locked arm. Receives positional args because with_lock + bash
# function dispatch is awkward with closures.
_atmux_improve_arm_locked() {
  local state_path="$1" force="$2" now_epoch="$3" run_id="$4" mode="$5" spec="$6" total="$7"
  local existing="" history="[]" last_cycle_closed_at="null"

  if [[ -s "$state_path" ]]; then
    existing="$(cat "$state_path")"
    if [[ "$force" != "1" ]] && _atmux_improve_is_active "$existing"; then
      local prev_run prev_cyc
      prev_run="$(jq -r '.runId // ""' <<<"$existing")"
      prev_cyc="$(jq -r '.cycleN // 0' <<<"$existing")"
      printf '🌱 eternal-improvement: already active (runId=%s, cycle=%s) — pass --force to start a parallel run\n' \
        "$prev_run" "$prev_cyc" >&2
      return 0
    fi
    history="$(jq -c '.history // []' <<<"$existing")"
    last_cycle_closed_at="$(jq -c '.lastCycleClosedAt // null' <<<"$existing")"
  fi

  # Cap history at HISTORY_RING_MAX (oldest dropped).
  history="$(jq -c --argjson n "$_ATMUX_IMPROVE_HISTORY_MAX" '.[(- $n):]' <<<"$history")"

  local tmp; tmp="$(mktemp "${state_path}.XXXXXX")"
  jq -n \
    --arg run_id "$run_id" \
    --argjson started "$now_epoch" \
    --arg mode "$mode" \
    --arg spec "$spec" \
    --argjson total "$total" \
    --argjson history "$history" \
    --argjson last "$last_cycle_closed_at" \
    '{
      active: true,
      runId: $run_id,
      startedAt: $started,
      mode: $mode,
      budgetSpec: $spec,
      budgetTotal: $total,
      budgetRemaining: $total,
      cycleN: 0,
      currentCycle: null,
      lastCycleClosedAt: $last,
      history: $history
    }' >"$tmp"
  mv "$tmp" "$state_path"

  # Discord 🌱 start ping (T3 owns templates). T1 stays a no-op gated on
  # env to keep behaviour predictable until the named template exists.
  if [[ "${ATMUX_DISCORD_TRIGGER:-}" == "eternal-improvement-start" ]]; then
    : # T3 fills in atmux::discord_ping with the typed body.
  fi

  return 0
}

# ---------- T7 cycle mechanics ----------

readonly _ATMUX_IMPROVE_EPIC_ID="e-a25968cc"
readonly _ATMUX_IMPROVE_DIRECTIVES_FILE="improve-directives.md"

_atmux_improve_directives_path() {
  printf '%s/%s\n' "$(atmux::dir)" "$_ATMUX_IMPROVE_DIRECTIVES_FILE"
}

# _atmux_improve_build_arm_message <cycleN>
# Print the lead prompt body per ADR-052 §"Loop mechanics" step 1.
_atmux_improve_build_arm_message() {
  local cycle_n="$1"
  printf '🌱 eternal-improvement cycle %s requested. Route to planner with: ask each lane member their top improvement candidate; score by impact-vs-cost; land top 1-3 Tasks; dispatch normally.\n' "$cycle_n"
}

# _atmux_improve_arm_directive <runId> <cycleN>
# Append a timestamped entry to improve-directives.md (creating the
# file with a header on first write). Mirrors src/core/improve-cycle.ts
# armCycle. Returns 0 always — directives are durable; even if the
# subsequent ping fails the lead can still pick up the entry.
_atmux_improve_arm_directive() {
  local run_id="$1" cycle_n="$2"
  local f; f="$(_atmux_improve_directives_path)"
  mkdir -p "$(dirname "$f")"
  if [[ ! -f "$f" ]]; then
    cat > "$f" <<'EOF'
# Improve Directives — eternal-improvement cycle prompts

Lead reads this file at the start of every whip turn to pick up
fresh `atmux improve` cycle prompts. Each entry is timestamped
and references the run's `runId` for cross-correlation with
`.atmux/state/eternal-improvement.json`.

## Open
EOF
  fi
  local body; body="$(_atmux_improve_build_arm_message "$cycle_n")"
  printf -- '- [%s] runId=%s cycle=%s — %s\n' \
    "$(atmux::now_myt)" "$run_id" "$cycle_n" "$body" >> "$f"
}

# _atmux_improve_cycle_open <state-file> <nowEpoch>
# Increment cycleN and initialize a fresh currentCycle in the state
# file (under the file's flock via _atmux_improve_state_write_jq).
_atmux_improve_cycle_open() {
  local _state_file="$1" now_epoch="$2"
  _atmux_improve_state_write_jq \
    '. + {
      cycleN: ((.cycleN // 0) + 1),
      currentCycle: {
        startedAt: $now,
        tasksLanded: [],
        tasksDispatched: [],
        tasksDone: [],
        tokensSpent: 0
      }
    }' --argjson now "$now_epoch"
}

# _atmux_improve_cycle_close <state-file> <nowEpoch> <tokensSpentDelta>
# Move currentCycle to history (capped at HISTORY_RING_MAX), clear it,
# decrement budgetRemaining by tokensSpent + delta, set lastCycleClosedAt.
# No-op if currentCycle is null.
_atmux_improve_cycle_close() {
  local _state_file="$1" now_epoch="$2" delta="$3"
  _atmux_improve_state_write_jq \
    'if .currentCycle == null then . else
      .currentCycle.tokensSpent = (.currentCycle.tokensSpent + $delta)
      | .history = ((.history // []) + [{
          cycleN: .cycleN,
          startedAt: .currentCycle.startedAt,
          closedAt: $now,
          tasksLanded: (.currentCycle.tasksLanded | length),
          tasksDone: (.currentCycle.tasksDone | length),
          tokensSpent: .currentCycle.tokensSpent
        }] | .[(- $cap):])
      | .budgetRemaining = (.budgetRemaining - .currentCycle.tokensSpent)
      | .lastCycleClosedAt = $now
      | .currentCycle = null
    end' --argjson now "$now_epoch" --argjson delta "$delta" --argjson cap "$_ATMUX_IMPROVE_HISTORY_MAX"
}

# _atmux_improve_is_cycle_closable <state-file>
# Returns 0 if all currentCycle.tasksDispatched are status:'done' AND
# completedAt is non-null. Returns 1 otherwise (also when no current
# cycle / no dispatched tasks).
_atmux_improve_is_cycle_closable() {
  local state_file="$1"
  local kanban_file; kanban_file="$(atmux::dir)/kanban.json"
  [[ -s "$state_file" && -s "$kanban_file" ]] || return 1
  local result
  result=$(jq -nr --slurpfile s "$state_file" --slurpfile k "$kanban_file" '
    ($s[0].currentCycle // null) as $cur
    | if $cur == null or ($cur.tasksDispatched // [] | length) == 0 then "false"
      else
        ($k[0].tasks // []) as $tasks
        | $cur.tasksDispatched
        | all(. as $id |
            ($tasks[] | select(.id == $id)) as $t
            | $t.status == "done" and ($t.completedAt // null) != null)
        | tostring
      end
  ')
  [[ "$result" == "true" ]]
}

# _atmux_improve_should_terminate <state-file>
# Returns 0 if budgetRemaining ≤ 0.
_atmux_improve_should_terminate() {
  local state_file="$1"
  [[ -s "$state_file" ]] || return 1
  local rem; rem="$(jq -r '.budgetRemaining // 0' "$state_file")"
  (( rem <= 0 ))
}

# _atmux_improve_is_driver_preempt
# Returns 0 if any kanban task is status:'in-progress' AND epic !== improvement.
_atmux_improve_is_driver_preempt() {
  local kanban_file; kanban_file="$(atmux::dir)/kanban.json"
  [[ -s "$kanban_file" ]] || return 1
  local result
  result=$(jq -r --arg eid "$_ATMUX_IMPROVE_EPIC_ID" '
    (.tasks // [])
    | any(.status == "in-progress" and ((.epic // null) != $eid))
    | tostring
  ' "$kanban_file")
  [[ "$result" == "true" ]]
}
