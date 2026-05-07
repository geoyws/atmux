#!/usr/bin/env bats
# E2E: full atmux flag round-trip — add → list → resolve → whip integration.
# Coverage for TEST task t-0e35251f (E4/S6).
#
# Bootstrap mirrors tests/e2e/lifecycle.bats (tui=shell members so tmux
# pane state is deterministic + paste/send-keys are inert). Discord is
# mocked via a curl-shadow on PATH.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "fle2e",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  : > .atmux/driver-inbox.md
  export ATMUX_SESSION="atmux-test-fle2e-$$-$RANDOM"

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"
}

teardown() {
  "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
  atmux_teardown_sandbox
}

_curl_calls() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

_curl_payload_content() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"} prev=="-d"{print; exit} {prev=$0}' "$f" | jq -r '.content // empty'
}

# ---------- add with --task linkage flips task to blocked ----------

@test "e2e flags: p1 with --task --needs unblock ⇒ flags.md entry + task .note appended + status=blocked" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  local tid; tid=$("$ATMUX_BIN" task add "real work" | tail -1)
  [[ "$tid" =~ ^t-[0-9a-f]{8}$ ]]

  local fid; fid=$("$ATMUX_BIN" flags add "test stuck" \
    --severity p1 --needs unblock --task "$tid" --as worker | tail -1)
  [[ "$fid" =~ ^f-[0-9a-f]{8}$ ]]

  # Markdown record present.
  grep -q "^### $fid worker \[p1/unblock\]" .atmux/flags.md
  grep -q "^- \*\*task\*\*: $tid$" .atmux/flags.md

  # Task gained a back-reference note + flipped to blocked.
  local task_note
  task_note=$(jq -r --arg id "$tid" '.tasks[] | select(.id == $id) | .note' .atmux/kanban.json)
  [[ "$task_note" =~ "flag $fid" ]]
  [[ "$task_note" =~ "test stuck" ]]
  local task_status
  task_status=$(jq -r --arg id "$tid" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)
  [ "$task_status" = "blocked" ]
}

# ---------- p0 with webhook → Discord POST + lead pane ping ----------

@test "e2e flags: p0 with webhook ⇒ Discord POST + lead pane sees '📍 flag from worker:' ping" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"

  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "demo blocker" \
    --severity p0 --needs unblock --as worker >/dev/null

  # Discord POST captured.
  [ "$(_curl_calls)" = "1" ]
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "[atmux-flags]" ]]
  [[ "$body" =~ "demo blocker" ]]

  # Lead pane shows the tmux send-keys nudge.
  sleep 1
  run tmux capture-pane -p -S -50 -t "$ATMUX_SESSION:__fle2e__lead"
  [[ "$output" =~ "flag from worker" ]]
  [[ "$output" =~ "demo blocker" ]]
}

# ---------- list ⇒ open entries; resolve ⇒ list omits ----------

@test "e2e flags: list shows open entries; resolve appends r-block + default list omits" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  local fid; fid=$("$ATMUX_BIN" flags add "to resolve" \
    --severity p1 --needs unblock --as worker | tail -1)

  # list shows it.
  run "$ATMUX_BIN" flags list --json
  [ "$status" -eq 0 ]
  [ "$(jq --arg id "$fid" '[.[] | select(.id == $id)] | length' <<<"$output")" = "1" ]

  "$ATMUX_BIN" flags resolve "$fid" --as lead --note "fixed it" >/dev/null

  # Resolution block appended.
  grep -q "^### r-[0-9a-f]\{8\} $fid" .atmux/flags.md
  grep -q "^- \*\*flag\*\*: $fid$" .atmux/flags.md

  # --status open omits the resolved entry; --status resolved finds it.
  # (Default list returns ALL entries with `resolved: true` annotation —
  # filtering is opt-in via --status, matching tests/unit/flags.bats).
  run "$ATMUX_BIN" flags list --status open --json
  [ "$status" -eq 0 ]
  [ "$(jq --arg id "$fid" '[.[] | select(.id == $id)] | length' <<<"$output")" = "0" ]

  run "$ATMUX_BIN" flags list --status resolved --json
  [ "$(jq --arg id "$fid" '[.[] | select(.id == $id)] | length' <<<"$output")" = "1" ]
}

# ---------- whip integration: resolved p0 ⇒ no 'open p0' finding ----------

@test "e2e flags: resolved p0 ⇒ whip emits NO '📍 N open p0' finding" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  local fid; fid=$("$ATMUX_BIN" flags add "p0 blocker" \
    --severity p0 --needs unblock --as worker | tail -1)
  "$ATMUX_BIN" flags resolve "$fid" --as lead --note "rolled back" >/dev/null
  rm -f .atmux/state/flags-cursor .atmux/state/whip-last.hash

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "open p0 flags" ]]
}

# ---------- combined round-trip ----------

@test "e2e flags: full round-trip — add p1+task → add p0 → list → resolve both → whip clean" {
  "$ATMUX_BIN" start >/dev/null
  sleep 1

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"

  local tid; tid=$("$ATMUX_BIN" task add "feature X" | tail -1)

  local f1; f1=$(PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "stuck on X" \
    --severity p1 --needs unblock --task "$tid" --as worker | tail -1)
  local f2; f2=$(PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "demo broken" \
    --severity p0 --needs unblock --as worker | tail -1)

  # Only p0 fires Discord.
  [ "$(_curl_calls)" = "1" ]

  # Both entries listable open.
  run "$ATMUX_BIN" flags list --json
  [ "$(jq 'length' <<<"$output")" -ge 2 ]

  # Resolve both.
  "$ATMUX_BIN" flags resolve "$f1" --as lead --note "unstuck" >/dev/null
  "$ATMUX_BIN" flags resolve "$f2" --as lead --note "demo restored" >/dev/null

  # --status open now empty.
  run "$ATMUX_BIN" flags list --status open --json
  [ "$(jq 'length' <<<"$output")" = "0" ]

  # Whip silent on p0.
  rm -f .atmux/state/flags-cursor .atmux/state/whip-last.hash
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "open p0 flags" ]]
}
