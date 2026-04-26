#!/usr/bin/env bats
# Concurrency / atomicity coverage for kanban + inbox writes — E6/S1 / t-ea982410.
# Coverage for A1 sweep (6 BE sites that swapped bare `jq … > tmp && mv` for
# atmux::jq_update):
#   t-9d0c0270  lib/dispatch.sh           (1/6)
#   t-0aee1385  lib/claim.sh              (2/6)
#   t-04b79538  lib/cleanup.sh            (3/6)
#   t-8b0fdbb4  lib/epic.sh               (4/6)
#   t-b1b315f1  lib/story.sh              (5/6)
#   t-354a1b6b  lib/kanban.sh × 4 sites   (6/6)
#
# Pre-A1, two concurrent `atmux dispatch` calls could both read the same
# inbox.json snapshot, each compute a one-entry add, and the second writer
# would mv-clobber the first — a phantom inbox entry leak that surfaced in
# B1. Post-A1, atmux::jq_update wraps every kanban / inbox mutation in a
# per-file flock, so the read-modify-write becomes serialized.
#
# Strategy: spawn N≥20 background subshells that hammer the same files
# through public verbs (task add / dispatch / claim / done) and assert the
# final state is internally consistent (every write landed, no duplicates,
# in-progress count matches dispatch count, done count matches done calls).
# `wait` for all subshells — bats nested-job flags are flaky on this builder.
#
# Performance note: 20 forked atmux invocations × 4 verbs is heavy (~10s on
# a warm box). The N=20 number is from AC; do NOT lower it — the test's
# value is in the contention pressure, not the count itself.
#
# Per memory feedback_orphan_test_staging.md: parent A1 BEs all `done` —
# this .bats is safe to git add when worker stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
  "$ATMUX_BIN" add-member worker1 --role member --lane be --tui shell >/dev/null
  "$ATMUX_BIN" add-member worker2 --role member --lane be --tui shell >/dev/null
  # Bump the inbox cap above N so the cap-refusal path doesn't intercept
  # legitimate dispatches (ATMUX_INBOX_CAP=20 default; we push 20 entries
  # to a single inbox in a couple of tests).
  export ATMUX_INBOX_CAP=200
  # Disable auto-dispatch: `atmux done` would otherwise wake gitter via
  # send-keys against a non-existent tmux session per call, slowing each
  # subshell by a tmux-fail timeout. Kanban + inbox transitions still run.
  export ATMUX_NO_AUTO_DISPATCH=1
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- 1. concurrent task adds — kanban writes serialize ----------

@test "atomicity: 20 concurrent 'task add' calls land all 20 entries with unique ids" {
  local i
  for i in $(seq 1 20); do
    ( "$ATMUX_BIN" task add "concurrent-$i" >/dev/null ) &
  done
  wait

  # All 20 tasks present in kanban.tasks.
  local n; n=$(jq -r '.tasks | length' .atmux/kanban.json)
  [ "$n" = "20" ]

  # Subjects all distinct → every add landed (no clobbered writes).
  local subj_n; subj_n=$(jq -r '[.tasks[].subject] | unique | length' .atmux/kanban.json)
  [ "$subj_n" = "20" ]

  # Ids all distinct — atmux::gen_id × 20 over 4-byte random ⇒ collision
  # ~10^-7 per run; we accept the flake tail.
  local id_n; id_n=$(jq -r '[.tasks[].id] | unique | length' .atmux/kanban.json)
  [ "$id_n" = "20" ]
}

# ---------- 2. AC test 1 — concurrent task add + dispatch in the same subshell ----------

@test "atomicity: 20 subshells (task add ⇒ dispatch) ⇒ 20 kanban entries + sum-of-inboxes == 20" {
  local i
  for i in $(seq 1 20); do
    (
      local id
      id=$("$ATMUX_BIN" task add "task-$i" 2>/dev/null | tail -1)
      # Round-robin to worker1 / worker2 to spread inbox load.
      local target=worker1
      (( i % 2 == 0 )) && target=worker2
      "$ATMUX_BIN" dispatch "$target" "$id" >/dev/null 2>&1
    ) &
  done
  wait

  # Kanban: 20 unique tasks all in 'in-progress' status (dispatch flips it).
  local kn; kn=$(jq -r '.tasks | length' .atmux/kanban.json)
  [ "$kn" = "20" ]
  local inprog_k
  inprog_k=$(jq -r '[.tasks[] | select(.status == "in-progress")] | length' .atmux/kanban.json)
  [ "$inprog_k" = "20" ]

  # Inbox sum across both workers == 20 (no lost pushes).
  local w1 w2
  w1=$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)
  w2=$(jq -r '.inProgress | length' .atmux/inboxes/worker2.json)
  [ $((w1 + w2)) -eq 20 ]

  # No duplicate ids across the two inboxes (each task dispatched exactly once).
  local dupe_n
  dupe_n=$(jq -r '[.inProgress[].id]' .atmux/inboxes/worker1.json .atmux/inboxes/worker2.json \
            | jq -s 'add | group_by(.) | map(select(length > 1)) | length')
  [ "$dupe_n" = "0" ]
}

# ---------- 3. AC test 2 — mix of dispatch + claim + done is internally consistent ----------

@test "atomicity: dispatch + done lifecycle (N=20) leaves kanban + inbox state consistent" {
  # Stage 1 — sequentially seed 20 tasks (we want dispatch contention, not
  # task-add contention; the previous test covers that).
  local ids=()
  local i
  for i in $(seq 1 20); do
    local id; id=$("$ATMUX_BIN" task add "t$i" | tail -1)
    ids+=("$id")
  done

  # Stage 2 — concurrent dispatch round-robin.
  for i in "${!ids[@]}"; do
    local id="${ids[$i]}"
    local target=worker1
    (( i % 2 == 1 )) && target=worker2
    ( "$ATMUX_BIN" dispatch "$target" "$id" >/dev/null 2>&1 ) &
  done
  wait

  # Sanity: post-dispatch every task is in-progress, owners are split.
  [ "$(jq -r '[.tasks[] | select(.status == "in-progress")] | length' .atmux/kanban.json)" = "20" ]

  # Stage 3 — concurrent `atmux done` of the first half (10 tasks). Mix
  # workers so both inboxes' inProgress->done transitions race.
  for i in 0 1 2 3 4 5 6 7 8 9; do
    local id="${ids[$i]}"
    local who; who=$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .owner' .atmux/kanban.json)
    ( "$ATMUX_BIN" done "$id" --as "$who" --note "concurrent done $i" >/dev/null 2>&1 ) &
  done
  wait

  # Final state assertions.
  local done_k inprog_k
  done_k=$(jq -r '[.tasks[] | select(.status == "done")] | length' .atmux/kanban.json)
  inprog_k=$(jq -r '[.tasks[] | select(.status == "in-progress")] | length' .atmux/kanban.json)
  [ "$done_k" = "10" ]
  [ "$inprog_k" = "10" ]

  # Every done task has completedAt set + non-null status invariants.
  local bad_done
  bad_done=$(jq -r '[.tasks[] | select(.status == "done" and (.completedAt == null or .completedAt == 0))] | length' .atmux/kanban.json)
  [ "$bad_done" = "0" ]

  # Inbox-side invariant: sum of (inProgress + done) entries == 20 (no
  # entries vanished mid-transition, which is the canonical bare-jq
  # clobber failure mode).
  local w1_p w1_d w2_p w2_d
  w1_p=$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)
  w1_d=$(jq -r '.done       | length' .atmux/inboxes/worker1.json)
  w2_p=$(jq -r '.inProgress | length' .atmux/inboxes/worker2.json)
  w2_d=$(jq -r '.done       | length' .atmux/inboxes/worker2.json)
  [ $((w1_p + w1_d + w2_p + w2_d)) -eq 20 ]
  # Per-worker: inProgress + done == 10 (5 dispatched, 5 closed each).
  [ $((w1_p + w1_d)) -eq 10 ]
  [ $((w2_p + w2_d)) -eq 10 ]
}

# ---------- 4. inbox-side specific — concurrent dispatches to ONE inbox ----------

@test "atomicity: 20 concurrent dispatches to ONE inbox preserve every push (no clobbered jq writes)" {
  # The pre-A1 fingerprint surfaced as B1: two simultaneous bare-jq
  # writers on the SAME inbox file would each compute one new entry and
  # clobber. Force the contention onto a single file by aiming all 20
  # dispatches at worker1.
  local ids=()
  local i
  for i in $(seq 1 20); do
    local id; id=$("$ATMUX_BIN" task add "single-$i" | tail -1)
    ids+=("$id")
  done

  for id in "${ids[@]}"; do
    ( "$ATMUX_BIN" dispatch worker1 "$id" >/dev/null 2>&1 ) &
  done
  wait

  local n; n=$(jq -r '.inProgress | length' .atmux/inboxes/worker1.json)
  [ "$n" = "20" ]

  # Every dispatched id present + unique.
  local distinct
  distinct=$(jq -r '[.inProgress[].id] | unique | length' .atmux/inboxes/worker1.json)
  [ "$distinct" = "20" ]
}

# ---------- 5. negative-space — no phantom entries (B1 root-cause fingerprint) ----------

@test "atomicity: post-concurrent dispatch, every inbox.inProgress id ∈ kanban.tasks (no phantoms)" {
  # If A1 ever regresses, the pre-A1 failure mode is: kanban write loses
  # its assignment + status flip while the inbox push lands → inbox keeps
  # a claim whose id was rolled back from kanban → phantom. find_phantom_inbox_ids
  # is the production detector; this test wires the same invariant into
  # the atomicity matrix so a regression surfaces as a failed assertion,
  # not just a runtime bullet weeks later.
  atmux_source_libs

  local i
  for i in $(seq 1 20); do
    (
      local id; id=$("$ATMUX_BIN" task add "phantom-check-$i" 2>/dev/null | tail -1)
      local target=worker1; (( i % 2 == 0 )) && target=worker2
      "$ATMUX_BIN" dispatch "$target" "$id" >/dev/null 2>&1
    ) &
  done
  wait

  local phantoms; phantoms=$(atmux::find_phantom_inbox_ids 2>/dev/null)
  [ "$(jq -r 'length' <<<"$phantoms")" = "0" ]
}

# ---------- 6. F12 post-write sanity check ----------

@test "atomicity: jq_update post-write sanity catches truncation (F12 t-dd78c8a5)" {
  # Simulate the disk-full / kernel-truncation failure mode by patching
  # `mv` to leave an empty file at the target — exactly what would
  # happen if write() returned partial bytes and jq's pipe buffer
  # was lost during the rename. Pre-F12 the jq_update happily exited
  # 0 here; post-F12 the jq -e sanity probe rejects the empty file
  # and the helper returns nonzero so callers see the failure.
  atmux_source_libs

  local f="$ATMUX_TEST_TMP/sanity.json"
  echo '{"keep":"original"}' > "$f"

  # Override mv inside this test only — make it truncate-on-rename.
  mv() {
    if [[ "$1" == "$f".* && "$2" == "$f" ]]; then
      command mv "$1" "$2"
      : > "$2"
    else
      command mv "$@"
    fi
  }
  export -f mv

  run atmux::jq_update "$f" '.keep = "patched"'
  [ "$status" -ne 0 ]
  # Cleanup the override so other tests aren't affected.
  unset -f mv
}
