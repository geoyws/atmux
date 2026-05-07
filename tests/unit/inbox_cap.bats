#!/usr/bin/env bats
# Unit tests for the inbox-overflow cap + rate-limited Discord warn —
# E6/S2 / t-fbea604f. Coverage for BE task t-a27f217b
# (lib/common.sh atmux::inbox_push_guard + atmux::inbox_cap_warn,
# wired into lib/dispatch.sh:62 + lib/kanban.sh _atmux_kanban_push_inbox).
#
# AC:
#   1. Dispatch 20 tasks → all 20 land in inbox.inProgress.
#   2. Dispatch 21st → push refused; atmux::warn fires; Discord webhook
#      (mocked) called once with the cap marker; kanban.tasks still
#      contains the new task (only the inbox copy is denied — kanban-side
#      assignment + status flip still land).
#   3. Dispatch 22nd within ledger TTL → Discord NOT called again
#      (rate-limited via .atmux/state/inbox-cap-warned.json, 1h TTL).
#   4. ATMUX_INBOX_CAP=5 caps at 5 instead.
#
# Test layering note: the inbox_cap_warn helper sits behind a runtime
# `declare -F atmux::discord_ping` guard (lib/common.sh:356) — common.sh
# stays free of a hard dep on lib/discord.sh, so callers MUST source
# discord.sh themselves to enable the ping. lib/kanban.sh + lib/whip.sh
# + lib/decisions.sh + lib/flags.sh do; lib/dispatch.sh currently does
# NOT. The Discord-ping AC therefore tests against:
#   - direct invocation of atmux::inbox_cap_warn with discord.sh sourced
#     (the function's contract — true unit test), OR
#   - the kanban.sh auto-dispatch path (`atmux done` on an epic'd parent)
#     which mints a commit-Task and pushes to gitter's inbox; if gitter's
#     inbox is at cap, kanban.sh's _atmux_kanban_push_inbox fires
#     inbox_cap_warn from a context that DOES have discord_ping.
# E2E push-refusal + kanban-mint behavior is verified through `atmux
# dispatch` (no Discord assertion on that path).
#
# Per memory feedback_orphan_test_staging.md: parent BE (t-a27f217b) is
# done — this .bats is safe to git add when worker stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name c >/dev/null
  "$ATMUX_BIN" add-member worker1 --role member --lane be --tui shell >/dev/null

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

# Mint N tasks + sequentially dispatch each to the named member via
# `dispatch --no-ping` (bypasses the send-keys-to-nowhere atmux::die
# that fires when no team `start`-ed). Echoes the list of minted ids.
_seed_dispatches() {
  local member="$1" n="$2"
  local i
  for i in $(seq 1 "$n"); do
    local id; id=$("$ATMUX_BIN" task add "load-$member-$i" | tail -1)
    PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" dispatch --no-ping "$member" "$id" >/dev/null 2>&1
    printf '%s\n' "$id"
  done
}

_curl_calls() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

_curl_cap_calls() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /atmux-inbox-cap/{n++} END{print n+0}' "$f"
}

# Source enough of lib/ to call atmux::inbox_cap_warn directly.
_load_full_libs() {
  atmux_source_libs
  # shellcheck source=../../lib/discord.sh
  . "$ATMUX_LIB_DIR/discord.sh"
}

# ---------- AC test 1: under cap (20 tasks) ⇒ all land ----------

@test "inbox_cap: 20 dispatches under cap (default 20) ⇒ all 20 land in inProgress; no warn" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  _seed_dispatches worker1 20 >/dev/null

  local n; n=$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)
  [ "$n" = "20" ]
  # No cap-warn Discord notice — under cap throughout.
  [ "$(_curl_cap_calls)" = "0" ]
  # Ledger file must not exist (warn never fired).
  [ ! -f .atmux/state/inbox-cap-warned.json ]
}

# ---------- AC test 2: 21st dispatch ⇒ push refused, warn, kanban-side mint lands ----------

@test "inbox_cap: 21st dispatch ⇒ push refused; atmux::warn fires; kanban-side mint still lands" {
  _seed_dispatches worker1 20 >/dev/null

  local overflow_id; overflow_id=$("$ATMUX_BIN" task add "overflow-1" | tail -1)
  run env PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" dispatch --no-ping worker1 "$overflow_id"
  [ "$status" -eq 0 ]
  # atmux::warn line on stderr (run captures both streams).
  [[ "$output" =~ "inbox full: worker1" ]]
  [[ "$output" =~ "cap=20" ]]

  # Inbox stayed at 20 (push refused).
  local n; n=$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)
  [ "$n" = "20" ]

  # Kanban-side mint still landed — owner + status assigned per
  # dispatch.sh's pre-cap write.
  local owner status
  owner=$(jq -r --arg id "$overflow_id" '.tasks[] | select(.id == $id) | .owner' .atmux/kanban.json)
  status=$(jq -r --arg id "$overflow_id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)
  [ "$owner" = "worker1" ]
  [ "$status" = "in-progress" ]

  # Ledger file written with the member's last-warn epoch.
  [ -f .atmux/state/inbox-cap-warned.json ]
  local ts; ts=$(jq -r '.worker1' .atmux/state/inbox-cap-warned.json)
  [[ "$ts" =~ ^[0-9]+$ ]]
}

# ---------- AC test 2 (Discord): direct inbox_cap_warn invocation fires ping once ----------

@test "inbox_cap (Discord): direct atmux::inbox_cap_warn fires Discord notice with cap marker" {
  _load_full_libs
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::inbox_cap_warn worker1 2>/dev/null

  [ "$(_curl_cap_calls)" -ge 1 ]
  # Body carries the canonical fingerprint.
  grep -aq 'atmux-inbox-cap' "$ATMUX_TEST_TMP/curl-args.bin"
  grep -aq 'worker1' "$ATMUX_TEST_TMP/curl-args.bin"
  grep -aq 'inbox at cap' "$ATMUX_TEST_TMP/curl-args.bin"

  # Ledger entry written with the member's epoch.
  [ -f .atmux/state/inbox-cap-warned.json ]
  local ts; ts=$(jq -r '.worker1' .atmux/state/inbox-cap-warned.json)
  [[ "$ts" =~ ^[0-9]+$ ]]
}

# ---------- AC test 3: rate-limit ledger gates duplicate Discord notices ----------

@test "inbox_cap (Discord): 2nd inbox_cap_warn within 1h ⇒ NO additional ping (ledger gate)" {
  _load_full_libs
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::inbox_cap_warn worker1 2>/dev/null
  local first; first=$(_curl_cap_calls)
  [ "$first" -ge 1 ]

  # Second call within ledger TTL (1h) for the SAME member ⇒ atmux::warn
  # still fires (it's unconditional), but the Discord ping is gated.
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::inbox_cap_warn worker1 2>/dev/null
  [ "$(_curl_cap_calls)" = "$first" ]

  # Different member ⇒ new ledger entry ⇒ new ping fires (positive control).
  "$ATMUX_BIN" add-member worker2 --role member --lane be --tui shell >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::inbox_cap_warn worker2 2>/dev/null
  [ "$(_curl_cap_calls)" -gt "$first" ]
}

@test "inbox_cap (Discord): expired ledger entry (>1h) ⇒ ping re-fires" {
  _load_full_libs
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  # Manually seed the ledger with a >1h-old timestamp for worker1.
  mkdir -p .atmux/state
  local now; now=$(date +%s)
  local long_ago=$(( now - 7200 ))   # 2h ago
  cat > .atmux/state/inbox-cap-warned.json <<EOF
{"worker1": $long_ago}
EOF

  PATH="$ATMUX_MOCK_BIN:$PATH" atmux::inbox_cap_warn worker1 2>/dev/null
  [ "$(_curl_cap_calls)" -ge 1 ]
  # Ledger updated to the fresh epoch (no longer matches the seeded value).
  local fresh; fresh=$(jq -r '.worker1' .atmux/state/inbox-cap-warned.json)
  (( fresh > long_ago ))
}

# ---------- AC test 4: ATMUX_INBOX_CAP=5 caps at 5 ----------

@test "inbox_cap: ATMUX_INBOX_CAP=5 caps the 6th push (override of default 20)" {
  export ATMUX_INBOX_CAP=5
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  # Seed 5 — all land.
  local i
  for i in 1 2 3 4 5; do
    local id; id=$("$ATMUX_BIN" task add "five-$i" | tail -1)
    PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" dispatch --no-ping worker1 "$id" >/dev/null 2>&1
  done
  [ "$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)" = "5" ]

  # 6th push — refused. Inbox stays at 5.
  local oid; oid=$("$ATMUX_BIN" task add "five-overflow" | tail -1)
  run env PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" dispatch --no-ping worker1 "$oid"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "cap=5" ]]
  [ "$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)" = "5" ]
}

# ---------- supplementary: drain re-enables push ----------

@test "inbox_cap: drain inbox below cap ⇒ next dispatch lands again (guard re-allows)" {
  _seed_dispatches worker1 20 >/dev/null

  # Move 5 inProgress entries to done so length drops to 15.
  jq '
    (.done) += (.inProgress[0:5] | map(. + {completedAt: 1}))
    | (.inProgress) |= .[5:]
  ' .atmux/inboxes/worker1.json > .atmux/inboxes/worker1.json.tmp
  mv .atmux/inboxes/worker1.json.tmp .atmux/inboxes/worker1.json
  [ "$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)" = "15" ]

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local id; id=$("$ATMUX_BIN" task add "after-drain" | tail -1)
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" dispatch --no-ping worker1 "$id" >/dev/null 2>&1
  [ "$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)" = "16" ]
  [ "$(_curl_cap_calls)" = "0" ]
}

# ---------- inbox_push_guard direct unit test ----------

@test "inbox_push_guard: returns 0 (allow) below cap, 1 (refuse) at-or-above cap" {
  atmux_source_libs
  cat > .atmux/inboxes/probe.json <<'EOF'
{"pending":[],"inProgress":[],"done":[]}
EOF
  ATMUX_INBOX_CAP=3 run atmux::inbox_push_guard .atmux/inboxes/probe.json
  [ "$status" -eq 0 ]   # 0 entries < 3 ⇒ allow

  jq '.inProgress = [{"id":"a"},{"id":"b"},{"id":"c"}]' .atmux/inboxes/probe.json > .atmux/inboxes/probe.json.tmp
  mv .atmux/inboxes/probe.json.tmp .atmux/inboxes/probe.json
  ATMUX_INBOX_CAP=3 run atmux::inbox_push_guard .atmux/inboxes/probe.json
  [ "$status" -eq 1 ]   # 3 entries == cap ⇒ refuse

  ATMUX_INBOX_CAP=4 run atmux::inbox_push_guard .atmux/inboxes/probe.json
  [ "$status" -eq 0 ]   # 3 entries < 4 ⇒ allow

  # Garbage cap value falls back to default 20; 3 entries < 20 ⇒ allow.
  ATMUX_INBOX_CAP=garbage run atmux::inbox_push_guard .atmux/inboxes/probe.json
  [ "$status" -eq 0 ]
}

@test "inbox_push_guard: missing inbox file ⇒ allow (length 0 cold-start)" {
  atmux_source_libs
  ATMUX_INBOX_CAP=20 run atmux::inbox_push_guard .atmux/inboxes/does-not-exist.json
  [ "$status" -eq 0 ]
}

# ---------- e2e via kanban.sh path (sources discord.sh) ----------

@test "inbox_cap (kanban auto-dispatch): commit-Task push to capped gitter inbox fires Discord" {
  # Fills gitter's inbox to 20 directly via dispatch --no-ping (under cap
  # so no warn fires here). Then triggers `atmux done` on an epic'd
  # worker1-owned task — finish_task_done mints a commit-Task and calls
  # _atmux_kanban_push_inbox "gitter" ..., which hits the cap. kanban.sh
  # sources discord.sh, so the ping fires from this path.
  local i
  for i in $(seq 1 20); do
    local id; id=$("$ATMUX_BIN" task add "fill-$i" | tail -1)
    PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" dispatch --no-ping gitter "$id" >/dev/null 2>&1
  done
  [ "$(jq -r '.inProgress | length' .atmux/inboxes/gitter.json)" = "20" ]

  local eid; eid=$("$ATMUX_BIN" epic add "cap-trigger-epic" | tail -1)
  local pid; pid=$("$ATMUX_BIN" task add "parent" --epic "$eid" | tail -1)
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  PATH="$ATMUX_MOCK_BIN:$PATH" ATMUX_NO_AUTO_DISPATCH=0 \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "trigger" >/dev/null 2>&1

  [ "$(_curl_cap_calls)" -ge 1 ]
  grep -aq 'gitter' "$ATMUX_TEST_TMP/curl-args.bin"
  # Gitter's inbox is still at 20 (commit-Task push refused).
  [ "$(jq -r '.inProgress | length' .atmux/inboxes/gitter.json)" = "20" ]
}
