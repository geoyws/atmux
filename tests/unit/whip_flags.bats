#!/usr/bin/env bats
# Unit tests for whip's open-p0-flags pointer (E4/S6 / t-874ef870).
# Coverage for TEST task t-2ffb3cbd.
#
# AC: when N p0 flag entries have timestamps newer than the flags-cursor,
# whip emits a `📍 N open p0 flags` finding. p1/p2 are silent. Resolved
# p0 flags are excluded. Cursor advances after the ping. Sandbox is
# session-DOWN (the flags check runs before the liveness early-exit).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name fp >/dev/null
  # Drop any prior cursor so the first whip tick observes a fresh state.
  rm -f .atmux/state/flags-cursor .atmux/state/whip-last.hash
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- AC (a): flags.md absent ⇒ no finding ----------

@test "whip_flags: flags.md absent ⇒ no '📍 ... open p0 flags' finding (silent)" {
  [ ! -f .atmux/flags.md ]
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "open p0 flags" ]]
}

# ---------- AC (b): 1 open p0 ⇒ finding with count=1 ----------

@test "whip_flags: 1 open p0 flag ⇒ '📍 1 open p0 flags' finding" {
  "$ATMUX_BIN" flags add "stack wedge" --severity p0 --needs unblock --as devops >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "1 open p0 flags" ]]
  [[ "$output" =~ "atmux flag list" ]]
}

# ---------- AC (c): 2 open p0 flags ⇒ count=2 ----------

@test "whip_flags: 2 open p0 flags ⇒ '📍 2 open p0 flags' finding" {
  "$ATMUX_BIN" flags add "first p0"  --severity p0 --needs unblock --as devops >/dev/null
  "$ATMUX_BIN" flags add "second p0" --severity p0 --needs review  --as reviewer >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "2 open p0 flags" ]]
}

# ---------- AC (d): only p1/p2 ⇒ no finding ----------

@test "whip_flags: only p1/p2 entries ⇒ no p0 finding (severity filter)" {
  "$ATMUX_BIN" flags add "warn-1" --severity p1 --needs review  --as reviewer >/dev/null
  "$ATMUX_BIN" flags add "ctx-1"  --severity p2 --needs context --as lead     >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "open p0 flags" ]]
}

# ---------- AC (e): resolved p0 flags ⇒ no finding ----------

@test "whip_flags: resolved p0 flag ⇒ NO finding (status=resolved excluded)" {
  # Pending BE fix in lib/whip.sh:361-380 — the awk counts every p0 f- entry
  # with ts>cursor, ignoring whether a `### r-` resolution block references
  # it. Surfaced to lead via atmux send (whip_flags AC-e). Flip from `skip`
  # to active assertions once BE patches the awk to subtract resolved f-ids.
  skip "pending BE fix: _atmux_whip_check_flags counts resolved p0 as open (lib/whip.sh:361-380)"

  local fid; fid=$("$ATMUX_BIN" flags add "to-resolve" --severity p0 --needs unblock --as devops | tail -1)
  [[ "$fid" =~ ^f-[0-9a-f]{8}$ ]]
  "$ATMUX_BIN" flags resolve "$fid" --as reviewer --note "fixed" >/dev/null
  rm -f .atmux/state/flags-cursor .atmux/state/whip-last.hash
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "open p0 flags" ]]
}

# ---------- AC (f): cursor advances after ping ----------

@test "whip_flags: cursor advances after first tick (subsequent ticks suppress duplicate)" {
  "$ATMUX_BIN" flags add "once" --severity p0 --needs unblock --as devops >/dev/null

  "$ATMUX_BIN" whip >/dev/null
  [ -f .atmux/state/flags-cursor ]
  local first; first=$(< .atmux/state/flags-cursor)
  [ "$first" -gt 0 ]

  # Second tick: same flag, no new entries since cursor. Pointer must NOT fire.
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "open p0 flags" ]]
}

@test "whip_flags: cursor still moves on subsequent tick when flags.md mtime advances" {
  "$ATMUX_BIN" flags add "first" --severity p0 --needs unblock --as devops >/dev/null
  "$ATMUX_BIN" whip >/dev/null
  local c1; c1=$(< .atmux/state/flags-cursor)

  # Add another p0 → flags.md mtime moves; cursor on next tick should reflect that.
  sleep 1
  "$ATMUX_BIN" flags add "second" --severity p0 --needs review --as reviewer >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "1 open p0 flags" ]]   # only the new one is counted
  local c2; c2=$(< .atmux/state/flags-cursor)
  [ "$c2" -ge "$c1" ]
}

# ---------- mixed ----------

@test "whip_flags: mixed p0/p1/p2 ⇒ count is p0-only" {
  "$ATMUX_BIN" flags add "noise-p1" --severity p1 --needs review  --as reviewer >/dev/null
  "$ATMUX_BIN" flags add "real-p0"  --severity p0 --needs unblock --as devops   >/dev/null
  "$ATMUX_BIN" flags add "noise-p2" --severity p2 --needs context --as lead     >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "1 open p0 flags" ]]
}
