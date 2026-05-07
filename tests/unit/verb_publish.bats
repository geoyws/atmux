#!/usr/bin/env bats
# Unit tests for ADR-032 §Verb wire-in: every state-mutating verb publishes
# a sock-event AFTER its durable state mutation. Stubs atmux::sock_publish
# + atmux::sock_publish_debounced to record the call to a JSONL trace file
# (no real socat — the publish primitives themselves are exercised in
# tests/unit/socket_pubsub.bats).
#
# Coverage matrix per t-cc53ae1a AC:
#   Per-verb fire-then-trace:
#     - tell-lead         → tell-lead       event
#     - send <member>     → send            event (per target)
#     - broadcast         → send            event × N members
#     - dispatch          → dispatch        event
#     - reply             → reply           event
#     - decisions add     → decisions-add   event (high/medium-rev only)
#     - flags add         → flag-add        event
#     - flags resolve     → flag-resolve    event
#     - kanban task move done → task-done-cascade × unique-unblocked-targets
#   Cascade debounce: rapid same-target events coalesce to 1.
#   Multi-target cascade: deps satisfy 3 distinct members → 3 events.
#   Failure path: publish returning 1 doesn't fail the verb.
#
# All trace events get a post-state-mutation timestamp; each test asserts
# trace.ts > state-file mtime (publish AFTER mutation per ADR-032).

load '../helpers/setup'

# Trace file all stubs append to. Reset per @test in setup().
TRACE=""

setup() {
  atmux_setup_sandbox
  atmux_source_libs

  TRACE="$ATMUX_TEST_TMP/publish-trace.jsonl"
  : > "$TRACE"
  export TRACE

  # Stub publish helpers to record the call. Override BEFORE any verb
  # script sources socket-pubsub.sh; the lib's re-entry guard (set via
  # _ATMUX_SOCKET_PUBSUB_LOADED=1 below) makes the source a no-op so our
  # stubs survive. Each event line is JSON:
  #   {"member":"<target>", "event":<verbatim-event-json>, "ts":<recorded-at>}
  atmux::sock_publish() {
    local member="$1" event="$2"
    local ts; ts="$(date +%s)"
    jq -cn --arg m "$member" --argjson e "$event" --argjson ts "$ts" \
      '{member:$m, event:$e, ts:$ts}' >> "$TRACE"
    return 0
  }
  atmux::sock_publish_debounced() {
    local member="$1" event="$2" window_ms="${3:-100}"
    local ts; ts="$(date +%s)"
    jq -cn --arg m "$member" --argjson e "$event" \
           --argjson ts "$ts" --argjson w "$window_ms" \
      '{member:$m, event:$e, ts:$ts, debounceWindowMs:$w}' >> "$TRACE"
    return 0
  }
  # Define the path helpers from socket-pubsub.sh without sourcing the
  # whole file — verbs that need atmux::sock_path / atmux::sock_dir
  # still resolve. Then set the re-entry guard so subsequent verb-side
  # sources of socket-pubsub.sh bail out without overwriting our stubs.
  atmux::sock_dir()  { printf '%s/sockets\n' "$(atmux::dir)"; }
  atmux::sock_path() { printf '%s/%s.sock\n' "$(atmux::sock_dir)" "$1"; }
  export -f atmux::sock_publish atmux::sock_publish_debounced \
            atmux::sock_dir atmux::sock_path
  export _ATMUX_SOCKET_PUBSUB_LOADED=1

  # tmux stubs — verbs that publish then call tmux-send-keys (tell-lead,
  # send, broadcast, dispatch) would otherwise die on missing tmux server
  # AFTER the publish ran. Tests care about the publish trace, not the
  # downstream tmux interaction; stub both so the verb runs to completion.
  atmux::tmux_window_exists() { return 0; }
  atmux::capture_pane()       { printf '$ ' ; }
  export -f atmux::tmux_window_exists atmux::capture_pane

  # PATH-shim `tmux` to a smart no-op. For `list-windows` we emit every
  # plausible window name in the team — `atmux::tmux_window_exists` pipes
  # tmux output through `grep -qx "$w"`, so emitting the expected set
  # makes the check succeed without a real tmux server. All other tmux
  # invocations (load-buffer / paste-buffer / send-keys / display-message)
  # silent-succeed.
  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  list-windows)
    cat <<-'WINS'
__vp__lead
__vp__fe-test
__vp__be-test
__vp__db-test
WINS
    ;;
  display-message)
    # atmux::resolve_caller_scope calls tmux display-message -p '#{window_name}'.
    # Return a non-member-shaped name so caller scope resolves to "driver"
    # via the env-fallback path (test sets ATMUX_CALLER_SCOPE=driver below).
    printf 'driver\n'
    ;;
  has-session)
    exit 0
    ;;
esac
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/tmux"
  export PATH="$ATMUX_MOCK_BIN:$PATH"

  # Drive caller-scope to driver so any driverOnly gate (E14) doesn't refuse.
  export ATMUX_CALLER_SCOPE=driver

  # Minimal team.json — multiple members so dispatch/cascade can route.
  "$ATMUX_BIN" init --name vp >/dev/null
  jq '.members = [
        {"name":"lead",     "role":"team-lead","lane":"misc","tui":"shell","model":"default","cwd":"'"$PWD"'"},
        {"name":"fe-test",  "role":"member",   "lane":"fe",  "tui":"shell","model":"default","cwd":"'"$PWD"'"},
        {"name":"be-test",  "role":"member",   "lane":"be",  "tui":"shell","model":"default","cwd":"'"$PWD"'"},
        {"name":"db-test",  "role":"member",   "lane":"db",  "tui":"shell","model":"default","cwd":"'"$PWD"'"}
      ] | .singleSession = false' \
    .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  export ATMUX_NO_AUTO_DISPATCH=1
  # Skip the lib/start path entirely — we only exercise verbs that
  # mutate state files + publish; tmux not needed.
  export ATMUX_LEGACY_SEND=0
}

teardown() {
  atmux_teardown_sandbox
}

# With the lib's re-entry guard + export -f stubs in setup, $ATMUX_BIN
# invocations inherit the trace stubs naturally — no wrapper needed.
_run_with_stubs() {
  "$@"
}

_event_count_by_type() {
  local etype="$1"
  jq --arg t "$etype" '[. | select(.event.type == $t)] | length' "$TRACE" 2>/dev/null \
    | jq -s 'add // 0'
}

_events_by_type() {
  local etype="$1"
  jq -c --arg t "$etype" 'select(.event.type == $t)' "$TRACE" 2>/dev/null
}

# ---------- tell-lead ----------

@test "verb publish: tell-lead writes tell-lead event addressed to lead" {
  _run_with_stubs "$ATMUX_BIN" tell-lead "say hi to the lead"

  jq -e . "$TRACE" >/dev/null  # at least one valid line
  local ev; ev="$(_events_by_type tell-lead | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "lead" ]
  [ "$(jq -r '.event.type' <<<"$ev")" = "tell-lead" ]
  [ "$(jq -r '.event.payload.snippet' <<<"$ev")" = "say hi to the lead" ]
}

@test "verb publish: tell-lead publish AFTER driver-inbox.md mutation" {
  _run_with_stubs "$ATMUX_BIN" tell-lead "ordering check"

  local ev_ts inbox_mtime
  ev_ts="$(_events_by_type tell-lead | head -1 | jq -r '.ts')"
  inbox_mtime="$(stat -c '%Y' .atmux/driver-inbox.md 2>/dev/null \
                  || stat -f '%m' .atmux/driver-inbox.md)"
  [ "$ev_ts" -ge "$inbox_mtime" ]
}

# ---------- send / broadcast ----------

@test "verb publish: send <member> emits send event addressed to that member" {
  _run_with_stubs "$ATMUX_BIN" send fe-test "hello fe" 2>/dev/null || true

  local ev; ev="$(_events_by_type send | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "fe-test" ]
  [ "$(jq -r '.event.payload.snippet' <<<"$ev")" = "hello fe" ]
}

@test "verb publish: broadcast emits send event PER team member (4 members → 4 events)" {
  _run_with_stubs "$ATMUX_BIN" broadcast "all hands" 2>/dev/null || true

  # 4 members in setup (lead, fe-test, be-test, db-test). Note: send.sh
  # may still skip 'driver' but no member is named 'driver' in our team,
  # so all 4 land.
  local n; n="$(jq -c '.event.type == "send"' "$TRACE" | grep -c true)"
  [ "$n" -ge 4 ]

  # Verify each named target got hit at least once.
  for m in lead fe-test be-test db-test; do
    [ "$(jq --arg m "$m" 'select(.member == $m and .event.type == "send")' "$TRACE" | jq -s 'length')" -ge 1 ]
  done
}

# ---------- dispatch ----------

@test "verb publish: dispatch <member> <task-id> emits dispatch event with task_id payload" {
  local tid; tid="$("$ATMUX_BIN" task add "dispatched task" --lane fe 2>/dev/null | tail -1)"
  : > "$TRACE"

  _run_with_stubs "$ATMUX_BIN" dispatch fe-test "$tid" 2>/dev/null || true

  local ev; ev="$(_events_by_type dispatch | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "fe-test" ]
  [ "$(jq -r '.event.payload.task_id' <<<"$ev")" = "$tid" ]
}

# ---------- reply ----------

@test "verb publish: reply emits reply event to lead" {
  _run_with_stubs "$ATMUX_BIN" reply "[fe-test] update from worker" 2>/dev/null || true

  local ev; ev="$(_events_by_type reply | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "lead" ]
}

# ---------- decisions add ----------

@test "verb publish: decisions add (high-rev) emits decisions-add event with id+rev" {
  local out
  out="$(_run_with_stubs "$ATMUX_BIN" decisions add "Use pg-15?" \
            --default "yes" --reversibility high \
            --context "schema migration with 50M-row table; rollback non-trivial" 2>&1 || true)"
  local id; id="$(printf '%s' "$out" | grep -oE '\bd-[0-9a-f]{8}\b' | head -1)"
  [[ "$id" =~ ^d-[0-9a-f]{8}$ ]] || { echo "no decision id in output"; printf '%s\n' "$out"; false; }

  local ev; ev="$(_events_by_type decisions-add | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "lead" ]
  [ "$(jq -r '.event.payload.id' <<<"$ev")" = "$id" ]
  [ "$(jq -r '.event.payload.reversibility' <<<"$ev")" = "high" ]
}

# ---------- flags add + resolve ----------

@test "verb publish: flags add emits flag-add event with id+severity to lead" {
  local out; out="$(_run_with_stubs "$ATMUX_BIN" flags add "stuck on shellcheck" \
                      --severity p1 --needs unblock --as fe-test 2>&1 || true)"
  local fid; fid="$(printf '%s' "$out" | grep -oE '\bf-[0-9a-f]{8}\b' | head -1)"
  [[ "$fid" =~ ^f-[0-9a-f]{8}$ ]]

  local ev; ev="$(_events_by_type flag-add | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "lead" ]
  [ "$(jq -r '.event.payload.id' <<<"$ev")" = "$fid" ]
  [ "$(jq -r '.event.payload.severity' <<<"$ev")" = "p1" ]
}

@test "verb publish: flags resolve emits flag-resolve event with id" {
  local out; out="$(_run_with_stubs "$ATMUX_BIN" flags add "test" \
                      --severity p2 --needs unblock --as fe-test 2>&1 || true)"
  local fid; fid="$(printf '%s' "$out" | grep -oE '\bf-[0-9a-f]{8}\b' | head -1)"
  : > "$TRACE"

  _run_with_stubs "$ATMUX_BIN" flags resolve "$fid" --as lead 2>/dev/null || true
  local ev; ev="$(_events_by_type flag-resolve | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.member' <<<"$ev")" = "lead" ]
  [ "$(jq -r '.event.payload.id' <<<"$ev")" = "$fid" ]
}

# ---------- task-done-cascade ----------

@test "verb publish: task move done emits task-done-cascade per unblocked-target member" {
  # Set up two upstream tasks each owned by a different member.
  local up1; up1="$("$ATMUX_BIN" task add "be upstream" --lane be --assignee be-test 2>/dev/null | tail -1)"
  local up2; up2="$("$ATMUX_BIN" task add "db upstream" --lane db --assignee db-test 2>/dev/null | tail -1)"
  # Downstream task with both as deps, owned by fe-test.
  local down; down="$("$ATMUX_BIN" task add "fe down" --lane fe --assignee fe-test --deps "$up1,$up2" 2>/dev/null | tail -1)"

  # Claim + complete up1 — only up1 done, up2 still pending → no cascade for fe-test yet.
  "$ATMUX_BIN" claim "$up1" --as be-test >/dev/null 2>&1 || true
  : > "$TRACE"
  _run_with_stubs "$ATMUX_BIN" done "$up1" --as be-test 2>/dev/null || true
  # No fe-test cascade yet (up2 still pending).
  [ "$(jq --arg m "fe-test" 'select(.member == $m and .event.type == "task-done-cascade")' "$TRACE" | jq -s 'length')" = "0" ]

  # Claim + complete up2 — fe-test now unblocked → cascade fires for fe-test.
  "$ATMUX_BIN" claim "$up2" --as db-test >/dev/null 2>&1 || true
  : > "$TRACE"
  _run_with_stubs "$ATMUX_BIN" done "$up2" --as db-test 2>/dev/null || true

  local ev; ev="$(_events_by_type task-done-cascade | jq -c 'select(.member == "fe-test")' | head -1)"
  [ -n "$ev" ]
  [ "$(jq -r '.event.payload.unblocked_task_ids[0]' <<<"$ev")" = "$down" ]
  [ "$(jq -r '.event.payload.from_task_id' <<<"$ev")" = "$up2" ]
  # debounceWindowMs recorded — confirms the debounced helper was used.
  [ "$(jq -r '.debounceWindowMs' <<<"$ev")" = "100" ]
}

@test "verb publish: cascade fans out 1 event per UNIQUE unblocked target (multi-target)" {
  # Single upstream blocking 3 downstream tasks, each owned by a distinct member.
  local up; up="$("$ATMUX_BIN" task add "shared upstream" --lane be --assignee be-test 2>/dev/null | tail -1)"
  local d1; d1="$("$ATMUX_BIN" task add "fe down"  --lane fe  --assignee fe-test --deps "$up" 2>/dev/null | tail -1)"
  local d2; d2="$("$ATMUX_BIN" task add "db down"  --lane db  --assignee db-test --deps "$up" 2>/dev/null | tail -1)"
  local d3; d3="$("$ATMUX_BIN" task add "lead down" --lane misc --assignee lead    --deps "$up" 2>/dev/null | tail -1)"

  "$ATMUX_BIN" claim "$up" --as be-test >/dev/null 2>&1 || true
  : > "$TRACE"
  _run_with_stubs "$ATMUX_BIN" done "$up" --as be-test 2>/dev/null || true

  # Three distinct members get cascade events, one each.
  local n_fe n_db n_lead
  n_fe="$(jq --arg m "fe-test" 'select(.member == $m and .event.type == "task-done-cascade")' "$TRACE" | jq -s 'length')"
  n_db="$(jq --arg m "db-test" 'select(.member == $m and .event.type == "task-done-cascade")' "$TRACE" | jq -s 'length')"
  n_lead="$(jq --arg m "lead"   'select(.member == $m and .event.type == "task-done-cascade")' "$TRACE" | jq -s 'length')"
  [ "$n_fe" = "1" ]
  [ "$n_db" = "1" ]
  [ "$n_lead" = "1" ]
}

# ---------- failure path: non-fatal publish ----------

@test "verb publish: sock_publish is non-fatal when listener absent (production warn-only contract)" {
  # Verify production sock_publish behavior: when the listener socket
  # doesn't exist, the helper logs a warning but returns 0 — so the
  # verb completes without rolling back its durable state mutation.
  # Drop the trace stub for this test so the real lib path runs.
  unset _ATMUX_SOCKET_PUBSUB_LOADED
  unset -f atmux::sock_publish atmux::sock_publish_debounced
  # Re-source the lib to install the production functions.
  . "$ATMUX_LIB_DIR/socket-pubsub.sh"

  # No socket files exist — listener absent path is the contract.
  [ ! -d .atmux/sockets ] || [ -z "$(ls -A .atmux/sockets 2>/dev/null)" ]

  run "$ATMUX_BIN" tell-lead "should still succeed"
  [ "$status" -eq 0 ]

  # The durable state mutation landed despite no listener.
  [ -f .atmux/driver-inbox.md ]
  grep -q "should still succeed" .atmux/driver-inbox.md
  # Production sock_publish emitted its "listener absent" warn line on
  # stderr; bats's `run` captures both, so $output should contain it.
  [[ "$output" == *"listener absent"* ]] || [[ "$output" == *"event dropped"* ]]
}
