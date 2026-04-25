#!/usr/bin/env bats
# Unit tests for `atmux flags` (lib/flags.sh) — E4/S1 / t-b09b3b21.
# Sibling to decisions.bats; same ADR-008 / d-485b965d ≤60-char message gate.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name f >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- add ----------

@test "flags: add mints f-xxxxxxxx and writes .atmux/flags.md" {
  run "$ATMUX_BIN" flags add "build wedge" --severity p1 --needs unblock --as lead
  [ "$status" -eq 0 ]
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^f-[0-9a-f]{8}$ ]]
  [ -f .atmux/flags.md ]
  grep -q "### $id lead \[p1/unblock\]" .atmux/flags.md
  grep -q "^- \*\*severity\*\*: p1$" .atmux/flags.md
  grep -q "^- \*\*needs\*\*: unblock$" .atmux/flags.md
  grep -q "^- \*\*message\*\*: build wedge$" .atmux/flags.md
}

@test "flags: add ERRORS when message exceeds 60 chars (Discord ≤80 budget)" {
  local long; long=$(printf '%.0sX' {1..61})
  run "$ATMUX_BIN" flags add "$long" --severity p0 --needs review --as lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "message exceeds 60 chars" ]]
  [ ! -f .atmux/flags.md ]
}

@test "flags: add accepts message at the 60-char boundary" {
  local sixty; sixty=$(printf '%.0sM' {1..60})
  run "$ATMUX_BIN" flags add "$sixty" --severity p2 --needs context --as lead
  [ "$status" -eq 0 ]
}

@test "flags: add rejects invalid --severity" {
  run "$ATMUX_BIN" flags add "x" --severity bad --needs unblock --as lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "p0" ]] && [[ "$output" =~ "p1" ]] && [[ "$output" =~ "p2" ]]
}

@test "flags: add rejects invalid --needs" {
  run "$ATMUX_BIN" flags add "x" --severity p0 --needs bogus --as lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "decision" ]] && [[ "$output" =~ "rotate" ]]
}

@test "flags: add requires --severity AND --needs" {
  run "$ATMUX_BIN" flags add "x" --as lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "severity" ]]
  run "$ATMUX_BIN" flags add "x" --severity p0 --as lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "needs" ]]
}

@test "flags: add --task persists task id; absent → null" {
  local id; id=$("$ATMUX_BIN" flags add "with task" --severity p1 --needs review --as reviewer --task t-abc12345 | tail -1)
  grep -q "^- \*\*task\*\*: t-abc12345$" .atmux/flags.md
  local id2; id2=$("$ATMUX_BIN" flags add "no task" --severity p2 --needs context --as lead | tail -1)
  grep -q "^- \*\*task\*\*: null$" .atmux/flags.md
  # both ids show up
  [[ "$id" =~ ^f-[0-9a-f]{8}$ ]]
  [[ "$id2" =~ ^f-[0-9a-f]{8}$ ]]
}

@test "flags: add --note persists; absent → null" {
  "$ATMUX_BIN" flags add "with note" --severity p1 --needs unblock --as lead --note "see logs" >/dev/null
  grep -q "^- \*\*note\*\*: see logs$" .atmux/flags.md
}

# ---------- list ----------

@test "flags: list (no filter) sorts by timestamp DESC and renders the LANE-style table" {
  "$ATMUX_BIN" flags add "first"  --severity p1 --needs unblock --as lead    >/dev/null
  "$ATMUX_BIN" flags add "second" --severity p2 --needs review  --as reviewer >/dev/null
  run "$ATMUX_BIN" flags list
  [ "$status" -eq 0 ]
  [[ "$output" =~ "ID" ]]
  [[ "$output" =~ "SEV" ]]
  [[ "$output" =~ "NEEDS" ]]
  [[ "$output" =~ "STATUS" ]]
  [[ "$output" =~ "MEMBER" ]]
  [[ "$output" =~ "MESSAGE" ]]
}

@test "flags: list --severity filters" {
  "$ATMUX_BIN" flags add "low"  --severity p2 --needs context --as lead >/dev/null
  "$ATMUX_BIN" flags add "high" --severity p0 --needs decision --as lead >/dev/null
  run "$ATMUX_BIN" flags list --severity p0 --json
  [ "$(jq -r 'length' <<<"$output")" = "1" ]
  [ "$(jq -r '.[0].message' <<<"$output")" = "high" ]
}

@test "flags: list --needs filters" {
  "$ATMUX_BIN" flags add "rev-thing" --severity p1 --needs review  --as lead >/dev/null
  "$ATMUX_BIN" flags add "rot-thing" --severity p1 --needs rotate  --as lead >/dev/null
  run "$ATMUX_BIN" flags list --needs review --json
  [ "$(jq -r '[.[] | .needs] | unique | join(",")' <<<"$output")" = "review" ]
}

@test "flags: list --member filters" {
  "$ATMUX_BIN" flags add "by-lead"   --severity p1 --needs unblock --as lead     >/dev/null
  "$ATMUX_BIN" flags add "by-reviewer" --severity p1 --needs review  --as reviewer >/dev/null
  run "$ATMUX_BIN" flags list --member reviewer --json
  [ "$(jq -r 'length' <<<"$output")" = "1" ]
  [ "$(jq -r '.[0].member' <<<"$output")" = "reviewer" ]
}

@test "flags: list --since 1h includes recent entries" {
  "$ATMUX_BIN" flags add "fresh" --severity p2 --needs context --as lead >/dev/null
  run "$ATMUX_BIN" flags list --since 1h --json
  [ "$(jq -r 'length' <<<"$output")" = "1" ]
}

@test "flags: list --status open vs resolved partitions correctly" {
  local id; id=$("$ATMUX_BIN" flags add "to-resolve" --severity p1 --needs unblock --as lead | tail -1)
  "$ATMUX_BIN" flags add "stays-open" --severity p2 --needs context --as lead >/dev/null
  "$ATMUX_BIN" flags resolve "$id" --as devops >/dev/null
  run "$ATMUX_BIN" flags list --status open --json
  [ "$(jq -r 'length' <<<"$output")" = "1" ]
  [ "$(jq -r '.[0].message' <<<"$output")" = "stays-open" ]
  run "$ATMUX_BIN" flags list --status resolved --json
  [ "$(jq -r 'length' <<<"$output")" = "1" ]
  [ "$(jq -r '.[0].message' <<<"$output")" = "to-resolve" ]
}

@test "flags: list with no entries returns the empty marker" {
  run "$ATMUX_BIN" flags list
  [[ "$output" =~ "no flags" ]]
}

# ---------- show ----------

@test "flags: show prints the entry; missing id errors out" {
  local id; id=$("$ATMUX_BIN" flags add "showme" --severity p1 --needs review --as reviewer --note "ctx here" | tail -1)
  run "$ATMUX_BIN" flags show "$id"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$id" ]]
  [[ "$output" =~ "showme" ]]
  [[ "$output" =~ "ctx here" ]]
  run "$ATMUX_BIN" flags show f-deadbeef
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no entry" ]]
}

@test "flags: show on a resolved flag includes its resolution block" {
  local id; id=$("$ATMUX_BIN" flags add "with-res" --severity p0 --needs decision --as lead | tail -1)
  "$ATMUX_BIN" flags resolve "$id" --as reviewer --note "decided" >/dev/null
  run "$ATMUX_BIN" flags show "$id"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$id" ]]
  [[ "$output" =~ "### r-" ]]
  [[ "$output" =~ "by**: reviewer" ]]
  [[ "$output" =~ "decided" ]]
}

# ---------- resolve ----------

@test "flags: resolve mints r-xxxxxxxx and links to the flag id" {
  local fid; fid=$("$ATMUX_BIN" flags add "x" --severity p1 --needs unblock --as lead | tail -1)
  run "$ATMUX_BIN" flags resolve "$fid" --as devops --note "fixed"
  [ "$status" -eq 0 ]
  local rid; rid=$(echo "$output" | tail -1)
  [[ "$rid" =~ ^r-[0-9a-f]{8}$ ]]
  grep -q "### $rid $fid" .atmux/flags.md
  grep -q "^- \*\*flag\*\*: $fid$" .atmux/flags.md
}

@test "flags: resolve on missing id ⇒ non-zero" {
  run "$ATMUX_BIN" flags resolve f-deadbeef --as devops
  [ "$status" -ne 0 ]
}

@test "flags: missing verb errors with usage hint" {
  run "$ATMUX_BIN" flags
  [ "$status" -ne 0 ]
  [[ "$output" =~ "missing verb" ]]
}

@test "flags: newline/tab in message is squashed (preserves markdown parser)" {
  printf -v multiline 'one\ntwo'
  "$ATMUX_BIN" flags add "$multiline" --severity p2 --needs context --as lead >/dev/null
  # Single-line bullet — no embedded newline.
  run grep -c "^- \*\*message\*\*: one two$" .atmux/flags.md
  [ "$output" = "1" ]
}
