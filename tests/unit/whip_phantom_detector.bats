#!/usr/bin/env bats
# Unit tests for phantom-inbox detector + auto-prune sweep — E6/S1 / t-60e7b2b9.
# Coverage for BE task t-5a8d148f (lib/common.sh + lib/whip.sh).
#
# AC:
#   1. Seed kanban with 1 task t-aaa11111 (status done). Seed gitter inbox
#      with [t-aaa11111, t-phantom1] in inProgress. Run sweep. Assert:
#      gitter inbox.inProgress contains only t-aaa11111;
#      .atmux/state/whip-phantom-seen.json contains t-phantom1.
#   2. Re-run sweep. Assert no Discord notice fired (rate-limited via
#      seen-ledger); inbox unchanged.
#   3. Helper atmux::find_phantom_inbox_ids() returns [] on a clean fixture.
#
# Tests source lib/{common,whip}.sh directly + invoke
# `_atmux_whip_phantom_sweep` against a hand-built `findings=()` array — the
# sweep reaches into its caller's array via dynamic scoping (matches the
# pattern of _atmux_whip_check_decisions / _check_flags). No live tmux
# session needed: `atmux whip` early-exits on session-DOWN before phantom
# sweep, so a direct-call layer is the cheapest path to AC coverage.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # Default-team init seeds .atmux/inboxes/gitter.json (+ lead, planner,
  # reviewer, devops, dba, fe-auth, be-auth, db-auth). The other inbox
  # files have empty inProgress arrays — they contribute zero phantoms,
  # so the AC fixture remains a clean isolation of t-aaa11111 + t-phantom1
  # against the gitter inbox.
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

# Seed kanban + gitter inbox per AC test-1 fixture.
_seed_phantom_fixture() {
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{
  "tasks": [
    {"id":"t-aaa11111","subject":"real task","status":"done","owner":"gitter","createdAt":$now,"completedAt":$now}
  ],
  "epics": [],
  "stories": []
}
EOF
  cat > .atmux/inboxes/gitter.json <<EOF
{
  "pending": [],
  "inProgress": [
    {"id":"t-aaa11111","subject":"real task","claimedAt":$now},
    {"id":"t-phantom1","subject":"ghost claim","claimedAt":$now}
  ],
  "done": []
}
EOF
}

# ---------- 1. helper purity / clean fixture ----------

@test "find_phantom_inbox_ids: clean fixture (every inbox id ∈ kanban.tasks) returns []" {
  atmux_source_libs
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{"tasks":[{"id":"t-real","subject":"x","status":"done","createdAt":$now}],"epics":[],"stories":[]}
EOF
  cat > .atmux/inboxes/gitter.json <<EOF
{"pending":[],"inProgress":[{"id":"t-real","claimedAt":$now}],"done":[]}
EOF
  run atmux::find_phantom_inbox_ids
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "find_phantom_inbox_ids: missing kanban.json ⇒ [] (cold-start safety)" {
  atmux_source_libs
  rm -f .atmux/kanban.json
  run atmux::find_phantom_inbox_ids
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "find_phantom_inbox_ids: phantom in inbox ⇒ {member,id,subject} entry" {
  atmux_source_libs
  _seed_phantom_fixture
  run atmux::find_phantom_inbox_ids
  [ "$status" -eq 0 ]
  # Exactly one phantom — t-phantom1 from gitter.
  local n; n=$(jq -r 'length' <<<"$output")
  [ "$n" = "1" ]
  local id;     id=$(jq -r '.[0].id'      <<<"$output")
  local member; member=$(jq -r '.[0].member' <<<"$output")
  local subject; subject=$(jq -r '.[0].subject' <<<"$output")
  [ "$id" = "t-phantom1" ]
  [ "$member" = "gitter" ]
  [ "$subject" = "ghost claim" ]
}

# ---------- 2. AC test 1 — first sweep prunes + writes ledger ----------

@test "phantom_sweep: first run prunes phantom from inbox + records ledger entry + emits finding" {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
  _seed_phantom_fixture

  local findings=()
  _atmux_whip_phantom_sweep

  # Inbox.inProgress now has only t-aaa11111.
  local inprog_ids
  inprog_ids=$(jq -r '[.inProgress[].id] | sort | join(",")' .atmux/inboxes/gitter.json)
  [ "$inprog_ids" = "t-aaa11111" ]

  # Ledger contains t-phantom1 with a numeric epoch.
  [ -f .atmux/state/whip-phantom-seen.json ]
  local seen; seen=$(jq -r '."t-phantom1" // empty' .atmux/state/whip-phantom-seen.json)
  [[ "$seen" =~ ^[0-9]+$ ]]

  # findings array carries the phantom bullet (gitter + id, per AC bullet shape).
  local hit=0
  local f
  for f in "${findings[@]}"; do
    [[ "$f" =~ phantom.*t-phantom1.*gitter ]] && hit=1
  done
  [ "$hit" -eq 1 ]
}

# ---------- 3. AC test 2 — second sweep is a no-op (rate-limited) ----------

@test "phantom_sweep: second sweep on clean inbox is silent + idempotent (no findings, inbox unchanged)" {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
  _seed_phantom_fixture

  # First sweep — prunes + writes ledger. Discard its findings.
  local findings=()
  _atmux_whip_phantom_sweep

  # Snapshot post-prune state.
  local inprog_before; inprog_before=$(jq -c '.inProgress' .atmux/inboxes/gitter.json)
  local ledger_before; ledger_before=$(jq -cS . .atmux/state/whip-phantom-seen.json)

  # Second sweep — same fixture is now clean, no phantoms remain.
  findings=()
  _atmux_whip_phantom_sweep

  # No new findings.
  [ "${#findings[@]}" -eq 0 ]

  # Inbox unchanged.
  local inprog_after; inprog_after=$(jq -c '.inProgress' .atmux/inboxes/gitter.json)
  [ "$inprog_before" = "$inprog_after" ]

  # Ledger unchanged (no new ids written, no GC churn this tick).
  local ledger_after; ledger_after=$(jq -cS . .atmux/state/whip-phantom-seen.json)
  [ "$ledger_before" = "$ledger_after" ]
}

# ---------- 4. rate-limit gate (seen-ledger suppresses re-emit) ----------

@test "phantom_sweep: re-introduced phantom is pruned again but emits NO bullet (ledger gates)" {
  # Defends the "rate-limited via seen-ledger" half of AC test 2 — the
  # interesting case is when the phantom RE-APPEARS (e.g. an A1 regression
  # re-clobbers the inbox with the same stale id). Inbox prune is
  # unconditional; the bullet is gated on ledger-miss. This pin keeps the
  # gate from regressing into a chatty re-emit on every tick.
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
  _seed_phantom_fixture

  # First sweep populates the ledger.
  local findings=()
  _atmux_whip_phantom_sweep
  [ -f .atmux/state/whip-phantom-seen.json ]
  jq -e '."t-phantom1"' .atmux/state/whip-phantom-seen.json >/dev/null

  # Re-add t-phantom1 to the inbox (simulate regression).
  local now; now=$(date +%s)
  jq --argjson now "$now" \
     '.inProgress += [{"id":"t-phantom1","subject":"ghost claim","claimedAt":$now}]' \
     .atmux/inboxes/gitter.json > .atmux/inboxes/gitter.json.tmp
  mv .atmux/inboxes/gitter.json.tmp .atmux/inboxes/gitter.json

  # Sanity: detector sees the re-added phantom.
  run atmux::find_phantom_inbox_ids
  [ "$(jq -r 'length' <<<"$output")" = "1" ]

  # Second sweep — should prune again but emit no bullet.
  findings=()
  _atmux_whip_phantom_sweep

  # Inbox: phantom pruned again (only t-aaa11111 remains).
  local inprog_ids
  inprog_ids=$(jq -r '[.inProgress[].id] | sort | join(",")' .atmux/inboxes/gitter.json)
  [ "$inprog_ids" = "t-aaa11111" ]

  # No phantom bullet emitted (rate-limited via ledger).
  local hit=0
  local f
  for f in "${findings[@]}"; do
    [[ "$f" =~ phantom ]] && hit=1
  done
  [ "$hit" -eq 0 ]
}

# ---------- 5. multi-member coverage ----------

@test "find_phantom_inbox_ids: phantoms in two different members both surface (member field per entry)" {
  atmux_source_libs
  "$ATMUX_BIN" add-member worker --role member --lane be --tui shell >/dev/null
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{"tasks":[{"id":"t-real","subject":"x","status":"done","createdAt":$now}],"epics":[],"stories":[]}
EOF
  cat > .atmux/inboxes/gitter.json <<EOF
{"pending":[],"inProgress":[{"id":"t-ghost-g","claimedAt":$now}],"done":[]}
EOF
  cat > .atmux/inboxes/worker.json <<EOF
{"pending":[],"inProgress":[{"id":"t-ghost-w","claimedAt":$now}],"done":[]}
EOF
  run atmux::find_phantom_inbox_ids
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" = "2" ]
  # Each phantom carries its owning member tag.
  local g_member; g_member=$(jq -r '.[] | select(.id == "t-ghost-g") | .member' <<<"$output")
  local w_member; w_member=$(jq -r '.[] | select(.id == "t-ghost-w") | .member' <<<"$output")
  [ "$g_member" = "gitter" ]
  [ "$w_member" = "worker" ]
}

# ---------- 6. ledger GC TTL ----------

@test "phantom_sweep: ledger GC prunes entries older than 7d on next sweep (with marker reset)" {
  # The GC fires at most once per 24h via .atmux/state/whip-phantom-gc.epoch
  # marker. Force a stale marker (>24h ago) + a stale ledger entry (>7d
  # ago) so the next sweep prunes the entry. Defends the 7d TTL contract.
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
  mkdir -p .atmux/state
  local now; now=$(date +%s)
  local stale_epoch=$(( now - 8*86400 ))     # 8 days ago — past 7d TTL
  local marker_epoch=$(( now - 2*86400 ))    # 2 days ago — past 24h GC debounce
  cat > .atmux/state/whip-phantom-seen.json <<EOF
{"t-old":$stale_epoch,"t-new":$now}
EOF
  echo "$marker_epoch" > .atmux/state/whip-phantom-gc.epoch
  # Ensure no phantoms in inboxes — sweep enters the n==0 branch which
  # calls the GC unconditionally before returning.
  cat > .atmux/kanban.json <<EOF
{"tasks":[],"epics":[],"stories":[]}
EOF
  cat > .atmux/inboxes/gitter.json <<EOF
{"pending":[],"inProgress":[],"done":[]}
EOF

  local findings=()
  _atmux_whip_phantom_sweep

  # t-old pruned; t-new retained.
  jq -e '."t-old" == null' .atmux/state/whip-phantom-seen.json >/dev/null
  jq -e '."t-new" != null' .atmux/state/whip-phantom-seen.json >/dev/null
  # GC marker advanced to (approx) now — at least past the prior 2-day-old marker.
  local marker_after; marker_after=$(< .atmux/state/whip-phantom-gc.epoch)
  (( marker_after > marker_epoch ))
}
