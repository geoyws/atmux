#!/usr/bin/env bats
# Unit tests for the ADR-033 driverOnly:bool refuse-gate.
#
# Coverage matrix (per t-98e78f4d AC):
#   - claim --next as non-driver: driverOnly task is NOT selected, stays todo.
#   - claim --next as driver (ATMUX_CALLER_SCOPE=driver): driverOnly task IS selected.
#   - task move <id> in-progress as non-driver: refuse via atmux::die.
#   - task move <id> done       as non-driver: refuse via atmux::die.
#   - task move <id> todo       as non-driver: ALLOWED (bookkeeping path).
#   - task move <id> blocked    as non-driver: ALLOWED.
#   - explicit `atmux claim <id>` as non-driver on driverOnly: refuse.
#   - Window-name defense-in-depth: ATMUX_CALLER_SCOPE=driver set inside a
#     __<team>__<member> pane forces scope=member; the gate still fires.
#   - Pre-ADR-033 Tasks (no driverOnly field) are treated as not-driver-only
#     (the // false coalesce works).
#
# Per CLAUDE.md feedback_orphan_test_staging.md: deps t-3232d50c (E14T1
# schema) + t-cfb4a4d7 (E14T2 refuse-gate) are both already done — this
# .bats is safe to `git add` from the start.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name driveronly >/dev/null
  "$ATMUX_BIN" add-member fe-kanban --role member --lane fe --tui shell >/dev/null
  export ATMUX_INBOX_CAP=200
  export ATMUX_NO_AUTO_DISPATCH=1
  # Defense-in-depth window-name check is tmux-aware. Tests run outside
  # tmux (TMUX env empty), so resolve_caller_scope reads ATMUX_CALLER_SCOPE
  # from process env directly. Each test sets/unsets explicitly.
  unset ATMUX_CALLER_SCOPE
}

teardown() {
  atmux_teardown_sandbox
}

# Add a task and capture its id by parsing the last line of stdout
# (atmux task add prints "✅ atmux added task t-...: ..." then "t-..."
# on stdout — the id is the LAST line).
_add_task() {
  "$ATMUX_BIN" task add "$@" 2>/dev/null | tail -1
}

# ---------- claim --next selection ----------

@test "driver-only: claim --next as non-driver does NOT select driverOnly task" {
  local id_drv id_norm
  id_drv="$(_add_task "driver-only work" --driver-only --lane fe)"
  id_norm="$(_add_task "regular work"     --lane fe)"
  [[ "$id_drv" =~ ^t- ]]
  [[ "$id_norm" =~ ^t- ]]

  run "$ATMUX_BIN" claim --next --as fe-kanban
  [ "$status" -eq 0 ]
  # Expect the regular task picked, not the driver-only one.
  [[ "$output" == *"$id_norm"* ]]
  [[ "$output" != *"$id_drv"* ]]

  # Driver-only task remains in todo with no owner.
  local status_drv owner_drv
  status_drv="$(jq -r --arg id "$id_drv" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  owner_drv="$(jq -r --arg id "$id_drv" '.tasks[] | select(.id == $id) | .owner // ""' .atmux/kanban.json)"
  [ "$status_drv" = "todo" ]
  [ -z "$owner_drv" ]
}

@test "driver-only: claim --next as non-driver returns 'no claimable work' when only driverOnly tasks exist" {
  _add_task "driver-only-1" --driver-only --lane fe >/dev/null
  _add_task "driver-only-2" --driver-only --lane fe >/dev/null

  run "$ATMUX_BIN" claim --next --as fe-kanban
  [ "$status" -eq 0 ]
  [[ "$output" == *"no claimable work"* ]]
}

@test "driver-only: claim --next as driver (ATMUX_CALLER_SCOPE=driver) DOES select driverOnly task" {
  local id_drv
  id_drv="$(_add_task "driver-fires" --driver-only --lane fe)"

  ATMUX_CALLER_SCOPE=driver run "$ATMUX_BIN" claim --next --as fe-kanban
  [ "$status" -eq 0 ]
  [[ "$output" == *"$id_drv"* ]]

  local status_drv
  status_drv="$(jq -r --arg id "$id_drv" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$status_drv" = "in-progress" ]
}

# ---------- task move refuse-gates ----------

@test "driver-only: task move <id> in-progress as non-driver refuses with atmux::die" {
  local id; id="$(_add_task "drv" --driver-only --lane fe)"

  run "$ATMUX_BIN" task move "$id" in-progress
  [ "$status" -ne 0 ]
  [[ "$output" == *"driver-only Task"* ]]
  [[ "$output" == *"in-progress"* ]]

  # Status unchanged — refuse-gate aborted before mutation.
  local s; s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "todo" ]
}

@test "driver-only: task move <id> done as non-driver refuses with atmux::die" {
  local id; id="$(_add_task "drv" --driver-only --lane fe)"

  run "$ATMUX_BIN" task move "$id" done
  [ "$status" -ne 0 ]
  [[ "$output" == *"driver-only Task"* ]]
  [[ "$output" == *"done"* ]]

  local s; s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "todo" ]
}

@test "driver-only: task move <id> todo as non-driver is ALLOWED (bookkeeping path)" {
  local id; id="$(_add_task "drv" --driver-only --lane fe)"

  # Move to blocked first (also allowed) so we can bounce back to todo
  # and observe the gate stays open for both bookkeeping transitions.
  run "$ATMUX_BIN" task move "$id" blocked
  [ "$status" -eq 0 ]
  local s; s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "blocked" ]

  run "$ATMUX_BIN" task move "$id" todo
  [ "$status" -eq 0 ]
  s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "todo" ]
}

@test "driver-only: task move <id> blocked as non-driver is ALLOWED (bookkeeping path)" {
  local id; id="$(_add_task "drv" --driver-only --lane fe)"

  run "$ATMUX_BIN" task move "$id" blocked
  [ "$status" -eq 0 ]
  local s; s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "blocked" ]
}

# ---------- explicit-id claim refuse ----------

@test "driver-only: explicit 'atmux claim <id>' as non-driver refuses" {
  local id; id="$(_add_task "drv" --driver-only --lane fe)"

  run "$ATMUX_BIN" claim "$id" --as fe-kanban
  [ "$status" -ne 0 ]
  [[ "$output" == *"driver-only Task"* ]]

  local s; s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "todo" ]
}

@test "driver-only: explicit 'atmux claim <id>' as driver succeeds" {
  local id; id="$(_add_task "drv" --driver-only --lane fe)"

  ATMUX_CALLER_SCOPE=driver run "$ATMUX_BIN" claim "$id" --as fe-kanban
  [ "$status" -eq 0 ]
  local s; s="$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)"
  [ "$s" = "in-progress" ]
}

# ---------- legacy / pre-ADR-033 tasks ----------

@test "driver-only: pre-ADR-033 task without driverOnly field reads as not-driver-only (// false coalesce)" {
  local id; id="$(_add_task "regular work" --lane fe)"
  # Strip the field as if this entry was created before E14T1 landed.
  jq --arg id "$id" '.tasks |= map(if .id == $id then del(.driverOnly) else . end)' \
    .atmux/kanban.json > .atmux/kanban.json.tmp
  mv .atmux/kanban.json.tmp .atmux/kanban.json

  # Confirm field is genuinely absent now.
  local has_field
  has_field="$(jq --arg id "$id" '.tasks[] | select(.id == $id) | has("driverOnly")' .atmux/kanban.json)"
  [ "$has_field" = "false" ]

  # Non-driver caller should still claim it cleanly — gate must read absent
  # field as `false`, not block.
  run "$ATMUX_BIN" claim --next --as fe-kanban
  [ "$status" -eq 0 ]
  [[ "$output" == *"$id"* ]]
}

# ---------- defense-in-depth: window-name override ----------

@test "driver-only: window-name __<team>__* forces scope=member even when ATMUX_CALLER_SCOPE=driver is set" {
  # The tmux-window-name check at the head of atmux::resolve_caller_scope
  # only fires when $TMUX is set AND the current window matches the
  # member-spawn convention. Test by sourcing common.sh in a subshell with
  # both signals stubbed, then asserting the helper returns "member"
  # despite ATMUX_CALLER_SCOPE=driver in the env.
  local scope
  scope="$(
    bash -c '
      . "$ATMUX_LIB_DIR/common.sh"
      # Fake-tmux: set $TMUX so the helper enters the tmux branch, then
      # override the `tmux` command so display-message returns the
      # spawn-pattern window name. show-environment returns nothing
      # (confirms the env path is bypassed by the window-name short-circuit).
      tmux() {
        case "$1" in
          display-message) printf "__driveronly__fe-kanban\n" ;;
          show-environment) return 1 ;;
          *) return 0 ;;
        esac
      }
      export -f tmux
      TMUX="/tmp/fake-tmux-socket,1234,0" \
      ATMUX_CALLER_SCOPE=driver \
        atmux::resolve_caller_scope
    '
  )"
  [ "$scope" = "member" ]
}

@test "driver-only: window-name 'driver' (driver pane) does NOT force scope=member; env path resolves driver" {
  local scope
  scope="$(
    bash -c '
      . "$ATMUX_LIB_DIR/common.sh"
      tmux() {
        case "$1" in
          display-message)  printf "driver\n" ;;
          show-environment) printf "ATMUX_CALLER_SCOPE=driver\n" ;;
          *) return 0 ;;
        esac
      }
      export -f tmux
      TMUX="/tmp/fake-tmux-socket,1234,0" \
        atmux::resolve_caller_scope
    '
  )"
  [ "$scope" = "driver" ]
}

@test "driver-only: env-only path (no tmux) — ATMUX_CALLER_SCOPE=driver resolves driver" {
  local scope
  scope="$(unset TMUX; ATMUX_CALLER_SCOPE=driver bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    atmux::resolve_caller_scope
  ')"
  [ "$scope" = "driver" ]
}

@test "driver-only: env-only path default fallback — unset → member (fail-secure)" {
  local scope
  scope="$(unset TMUX ATMUX_CALLER_SCOPE; bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    atmux::resolve_caller_scope
  ')"
  [ "$scope" = "member" ]
}
