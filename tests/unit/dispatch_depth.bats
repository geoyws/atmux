#!/usr/bin/env bats
# Unit tests for the auto-dispatch depth guard + .createdFrom audit field —
# E6/S2 / t-b6206be1. Coverage for BE task t-eeb06966 (lib/kanban.sh
# atmux::finish_task_done depth-cap path).
#
# Invariant (per impl line 312): `if (( new_depth >= 3 ))` ⇒ refuse mint.
#   incoming=0 → new=1 ⇒ mint, .createdFrom.depth = 1
#   incoming=1 → new=2 ⇒ mint, .createdFrom.depth = 2 (last allowed)
#   incoming=2 → new=3 ⇒ REFUSE (cap hit)
#   incoming=3 → new=4 ⇒ REFUSE
#
# AC reference: depth=2 case in the AC body says "(or 2, depending on
# chosen invariant — match the impl)". The impl chose `>= 3`, so depth=2
# is the boundary-mint case (incoming=1) and depth=3 is the boundary-
# refuse case (incoming=2 or 3). Both boundary tests below cover the
# transition.
#
# Per memory feedback_orphan_test_staging.md: parent BE (t-eeb06966) is
# done — this .bats is safe to git add when worker stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name d >/dev/null
  "$ATMUX_BIN" add-member worker1 --role member --lane be --tui shell >/dev/null
  # Disable the auto-dispatch SEND-KEYS pings without disabling the mint
  # itself (we need the kanban + inbox writes to land for assertions, but
  # not the noisy send-keys-to-nowhere). Setting NO_AUTO_DISPATCH=1 in env
  # would skip both the inbox push AND the mint's downstream wakes —
  # we want the inbox push to happen so the cap-refusal path is testable
  # later. Instead: leave NO_AUTO_DISPATCH=0 and accept that send-keys
  # against the inert sandbox tmux is a silent no-op (already proven by
  # whip.bats + atomicity.bats running clean under the same condition).

  # Discord webhook mock for test 3 (depth-cap notice). Reused pattern
  # from decisions_gating.bats / whip_dedup.bats.
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

  # Seed an Epic + a parent task for each test to consume. Each test
  # creates its own task to keep state isolated; the Epic stays shared.
  EID=$("$ATMUX_BIN" epic add "depth-test-epic" | tail -1)
  [[ "$EID" =~ ^e- ]]
  export EID
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

# Mint a fresh parent task with the test Epic attached. Echoes the new id.
_mint_parent() {
  local subject="${1:-parent-$RANDOM}"
  local id; id=$("$ATMUX_BIN" task add "$subject" --epic "$EID" | tail -1)
  [[ "$id" =~ ^t- ]] || return 1
  printf '%s\n' "$id"
}

# Find the auto-minted commit-Task whose createdFrom.parentTaskId matches.
_commit_task_for() {
  local parent="$1"
  jq -r --arg p "$parent" \
    '.tasks[] | select(.createdFrom.parentTaskId == $p and (.subject | startswith("commit "))) | .id' \
    .atmux/kanban.json
}

_curl_calls() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

# ---------- AC test 1: depth=0 ⇒ mint with .createdFrom.depth=1 ----------

@test "depth_guard: ATMUX_DISPATCH_DEPTH=0 ⇒ commit-Task minted with .createdFrom={parentTaskId, depth: 1}" {
  local pid; pid=$(_mint_parent "p0")
  ATMUX_DISPATCH_DEPTH=0 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "depth0 done" >/dev/null

  local cid; cid=$(_commit_task_for "$pid")
  [[ "$cid" =~ ^t- ]]
  local depth; depth=$(jq -r --arg id "$cid" \
    '.tasks[] | select(.id == $id) | .createdFrom.depth' .atmux/kanban.json)
  [ "$depth" = "1" ]
  local parent_ref; parent_ref=$(jq -r --arg id "$cid" \
    '.tasks[] | select(.id == $id) | .createdFrom.parentTaskId' .atmux/kanban.json)
  [ "$parent_ref" = "$pid" ]
}

# ---------- AC test 2: last-allowed depth ⇒ mint with depth=2 ----------

@test "depth_guard: ATMUX_DISPATCH_DEPTH=1 ⇒ commit-Task minted with .createdFrom.depth = 2 (last allowed)" {
  # incoming=1 ⇒ new_depth=2; cap is `>= 3`, so depth=2 still mints.
  # This is the boundary-mint case — flips to refuse at incoming=2.
  local pid; pid=$(_mint_parent "p1")
  ATMUX_DISPATCH_DEPTH=1 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "depth1 done" >/dev/null

  local cid; cid=$(_commit_task_for "$pid")
  [[ "$cid" =~ ^t- ]]
  local depth; depth=$(jq -r --arg id "$cid" \
    '.tasks[] | select(.id == $id) | .createdFrom.depth' .atmux/kanban.json)
  [ "$depth" = "2" ]
}

# ---------- AC test 3: depth=3 ⇒ no mint, warn fires, Discord ping fires ----------

@test "depth_guard: ATMUX_DISPATCH_DEPTH=3 ⇒ no commit-Task minted + Discord notice fires" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local pid; pid=$(_mint_parent "p3")
  # Capture stderr too so we can grep for the atmux::warn line. `run`
  # captures stdout+stderr in this bats build.
  run env ATMUX_DISPATCH_DEPTH=3 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "depth3 done"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "auto-dispatch depth limit hit" ]]
  [[ "$output" =~ "depth=4" ]]
  [[ "$output" =~ "$pid" ]]

  # No commit-Task minted (no .createdFrom.parentTaskId == pid in kanban).
  local cid; cid=$(_commit_task_for "$pid")
  [ -z "$cid" ]

  # Parent itself still moved to done.
  local parent_status; parent_status=$(jq -r --arg id "$pid" \
    '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json)
  [ "$parent_status" = "done" ]

  # Discord notice: at least one curl invocation, body contains the
  # canonical depth-cap markers from _atmux_kanban_notify_dispatch_depth_capped.
  [ "$(_curl_calls)" -ge 1 ]
  grep -aq '⛔ refused commit-Task mint' "$ATMUX_TEST_TMP/curl-args.bin"
  grep -aq "$pid" "$ATMUX_TEST_TMP/curl-args.bin"

  # Ledger entry written for rate-limiting (next refusal on same parent
  # within session is silent).
  [ -f .atmux/state/dispatch-depth-seen.json ]
  jq -e --arg p "$pid" '.[$p]' .atmux/state/dispatch-depth-seen.json >/dev/null
}

# Boundary case adjacent to test 3: incoming=2 also refuses (new=3 hits the cap).
@test "depth_guard: ATMUX_DISPATCH_DEPTH=2 ⇒ no commit-Task minted (boundary at new_depth==3)" {
  local pid; pid=$(_mint_parent "p2")
  run env ATMUX_DISPATCH_DEPTH=2 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "depth2 done"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "depth=3" ]]
  local cid; cid=$(_commit_task_for "$pid")
  [ -z "$cid" ]
}

# ---------- AC test 4: .createdFrom round-trips through `task show` ----------

@test "depth_guard: .createdFrom field is queryable via 'atmux task show <id>'" {
  local pid; pid=$(_mint_parent "p_show")
  ATMUX_DISPATCH_DEPTH=0 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "show-test" >/dev/null
  local cid; cid=$(_commit_task_for "$pid")
  [[ "$cid" =~ ^t- ]]

  # `task show` emits the full task JSON; re-parse to confirm the field
  # round-trips end-to-end (jq output, not just the kanban file directly).
  local show_out; show_out=$("$ATMUX_BIN" task show "$cid")
  [ "$(jq -r '.createdFrom.depth' <<<"$show_out")" = "1" ]
  [ "$(jq -r '.createdFrom.parentTaskId' <<<"$show_out")" = "$pid" ]
}

# ---------- supplementary: rate-limit ledger gates duplicate Discord notices ----------

@test "depth_guard: 2nd refusal for the SAME parent within session emits NO additional Discord notice (ledger gate)" {
  # Without a rate-limit gate, a depth=3 refusal followed by a re-fire on
  # the same parent would spam Discord. The ledger pattern (see
  # _atmux_kanban_notify_dispatch_depth_capped) writes once per parent per
  # cron-session and short-circuits subsequent calls.
  local pid; pid=$(_mint_parent "p_rl")
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  ATMUX_DISPATCH_DEPTH=3 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "first refusal" >/dev/null 2>&1
  local first_calls; first_calls=$(_curl_calls)
  [ "$first_calls" -ge 1 ]

  # Reverse the parent back to in-progress + drop the depth-seen entry's
  # CONSUMER counterpart (the `done` mark) so we can re-finalize. Easiest
  # is to seed a separate parent and finalize at depth 3 again — the
  # ledger is keyed on parentTaskId, so a different parent triggers a
  # NEW notice. That's the contract: rate limit per parent, not per
  # session-wide depth event. Mint a fresh parent + verify a NEW notice
  # fires (positive control), then re-fire on the FIRST parent (after
  # resetting status) and verify NO new notice.
  local pid2; pid2=$(_mint_parent "p_rl_2")
  ATMUX_DISPATCH_DEPTH=3 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid2" --as worker1 --note "fresh parent" >/dev/null 2>&1
  local after_fresh; after_fresh=$(_curl_calls)
  (( after_fresh > first_calls ))    # different parent ⇒ new notice fires

  # Now reset pid back to "in-progress" + re-fire — same parent should
  # NOT emit a new notice (ledger short-circuits).
  jq --arg id "$pid" '
    (.tasks[] | select(.id == $id) | .status) = "in-progress"
    | (.tasks[] | select(.id == $id) | .completedAt) = null' \
    .atmux/kanban.json > .atmux/kanban.json.tmp
  mv .atmux/kanban.json.tmp .atmux/kanban.json

  local before_repeat; before_repeat=$(_curl_calls)
  ATMUX_DISPATCH_DEPTH=3 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "repeat refusal" >/dev/null 2>&1
  local after_repeat; after_repeat=$(_curl_calls)
  [ "$after_repeat" = "$before_repeat" ]   # same parent ⇒ no new notice
}

# ---------- defense-in-depth: subject-prefix gate fires before depth gate ----------

@test "depth_guard: subject 'commit ...' parent is suppressed by prefix gate, NOT depth-cap (no warn)" {
  # Per impl ordering (lib/kanban.sh:325): subject gate runs BEFORE depth
  # gate, so a "commit foo" parent never reaches the depth check.  Also
  # never auto-mints a commit-of-commit. atmux::warn for depth-cap must
  # NOT fire — the suppression source is recursion-class, not depth.
  local pid; pid=$("$ATMUX_BIN" task add "commit synthetic" --epic "$EID" | tail -1)
  run env ATMUX_DISPATCH_DEPTH=3 PATH="$ATMUX_MOCK_BIN:$PATH" \
    "$ATMUX_BIN" done "$pid" --as worker1 --note "commit-prefix done"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "auto-dispatch depth limit hit" ]]
  local cid; cid=$(_commit_task_for "$pid")
  [ -z "$cid" ]
}
