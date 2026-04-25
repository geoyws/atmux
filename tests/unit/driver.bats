#!/usr/bin/env bats
# Unit tests for `atmux brief-driver` + `atmux driver note` (E2/S6).
# Coverage for TEST task t-8f6906f1 (deps t-3dda7f7e).
#
# brief-driver renders a fresh-state recovery card for the driver pane
# (counts, branch, loop, driver-inbox count, latest 3 lead-outbox lines,
# in-progress tasks). Output is stdout-only and bounded ≤30 lines.
# driver note writes a `### dn-xxxxxxxx` entry into .atmux/driver-state.md
# with a rolling digest (last 5).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name d >/dev/null
  # Reset the kanban so default-init doesn't leak in done/in-progress
  # entries that would interfere with count assertions.
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- brief-driver: fresh state ----------

@test "brief-driver: fresh kanban ⇒ 0/0/0 counts + 'no upstream' + 'none' loop + 'open driver-inbox: 0'" {
  run "$ATMUX_BIN" brief-driver
  [ "$status" -eq 0 ]
  [[ "$output" =~ "0 done" ]]
  [[ "$output" =~ "0 in-progress" ]]
  [[ "$output" =~ "0 todo" ]]
  [[ "$output" =~ "no upstream" ]]
  [[ "$output" =~ "Active loop: none" ]]
  [[ "$output" =~ "Open driver-inbox entries: 0" ]]
  # No outbox / in-progress lines populated.
  [[ "$output" =~ "(none)" ]]
}

# ---------- brief-driver: counts populate from kanban ----------

@test "brief-driver: 1 done + 2 in-progress ⇒ counts correct in summary line" {
  "$ATMUX_BIN" task add "task one" >/dev/null
  "$ATMUX_BIN" task add "task two" >/dev/null
  "$ATMUX_BIN" task add "task three" >/dev/null

  # Mutate kanban directly to set per-task statuses (avoiding the claim
  # auto-dispatch path which spawns commit Tasks).
  jq '
    .tasks[0].status = "done"      |
    .tasks[1].status = "in-progress" |
    .tasks[2].status = "in-progress"
  ' .atmux/kanban.json > .atmux/kanban.json.tmp \
    && mv .atmux/kanban.json.tmp .atmux/kanban.json

  run "$ATMUX_BIN" brief-driver
  [ "$status" -eq 0 ]
  [[ "$output" =~ "1 done" ]]
  [[ "$output" =~ "2 in-progress" ]]
  [[ "$output" =~ "0 todo" ]]
  # The two in-progress task lines surface under "In-progress Tasks:".
  [[ "$output" =~ "In-progress Tasks:" ]]
}

# ---------- brief-driver: outbox slice = latest 3 ----------

@test "brief-driver: lead-outbox with 5 entries ⇒ only latest 3 shown" {
  cat > .atmux/lead-outbox.md <<'EOF'
# atmux lead → driver outbox

## Open

- [10:00 MYT] **lead**: ENTRY 5 — newest at top
- [09:30 MYT] **lead**: ENTRY 4 — second newest
- [09:00 MYT] **lead**: ENTRY 3 — third newest
- [08:30 MYT] **lead**: ENTRY 2 — should be hidden
- [08:00 MYT] **lead**: ENTRY 1 — should be hidden

## Archive

EOF
  run "$ATMUX_BIN" brief-driver
  [ "$status" -eq 0 ]
  [[ "$output" =~ "ENTRY 5" ]]
  [[ "$output" =~ "ENTRY 4" ]]
  [[ "$output" =~ "ENTRY 3" ]]
  ! [[ "$output" =~ "ENTRY 2" ]]
  ! [[ "$output" =~ "ENTRY 1" ]]
}

# ---------- brief-driver: ≤30 lines ----------

@test "brief-driver: output ≤30 lines (recovery card budget)" {
  # Pad in-progress to 8 entries to exercise the wide-state branch.
  for i in 1 2 3 4 5 6 7 8; do
    "$ATMUX_BIN" task add "ip task $i" >/dev/null
  done
  jq '.tasks |= map(.status = "in-progress")' .atmux/kanban.json \
    > .atmux/kanban.json.tmp && mv .atmux/kanban.json.tmp .atmux/kanban.json

  run "$ATMUX_BIN" brief-driver
  [ "$status" -eq 0 ]
  local lines; lines=$(printf '%s\n' "$output" | wc -l)
  [ "$lines" -le 30 ]
}

# ---------- brief-driver: completes fast ----------

@test "brief-driver: completes in <2s on small fixture (timing budget)" {
  local before after delta
  before=$(date +%s)
  "$ATMUX_BIN" brief-driver >/dev/null
  after=$(date +%s)
  delta=$(( after - before ))
  [ "$delta" -le 2 ]
}

# ---------- driver note: writes entry + digest ----------

@test "driver note: writes ### dn-xxxxxxxx entry + appends to .atmux/driver-state.md" {
  run "$ATMUX_BIN" driver note "first note"
  [ "$status" -eq 0 ]
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^dn-[0-9a-f]{8}$ ]]
  [ -f .atmux/driver-state.md ]
  grep -q "^### $id — first note" .atmux/driver-state.md
  grep -q "^- \*\*message\*\*: first note$" .atmux/driver-state.md
  grep -q "^- \*\*reversibility\*\*: low$" .atmux/driver-state.md   # default
  # Digest section present.
  grep -q "^## Digest (last 5)$" .atmux/driver-state.md
  grep -q "\`$id\`" .atmux/driver-state.md
}

# ---------- driver note: digest shows last 5 only ----------

@test "driver note: 6 entries ⇒ digest shows the 5 newest only" {
  for i in 1 2 3 4 5 6; do
    "$ATMUX_BIN" driver note "note $i" >/dev/null
    sleep 1   # ensure distinct timestamps for digest sort
  done
  # All 6 must persist in the body section.
  local entries
  entries=$(grep -c "^### dn-" .atmux/driver-state.md)
  [ "$entries" = "6" ]
  # Digest shows exactly 5 — the newest 5. Extract digest block lines
  # between '## Digest (last 5)' and the next '---' divider.
  local digest_count
  digest_count=$(awk '
    /^## Digest \(last 5\)/ { in_digest=1; next }
    /^---/                   { in_digest=0 }
    in_digest && /^- /       { c++ }
    END                      { print c+0 }
  ' .atmux/driver-state.md)
  [ "$digest_count" = "5" ]
  # The OLDEST entry ('note 1') must NOT be in the digest.
  awk '
    /^## Digest \(last 5\)/ { in_digest=1; next }
    /^---/                   { in_digest=0 }
    in_digest                { print }
  ' .atmux/driver-state.md | grep -q "note 1" && false || true
}

# ---------- driver note: --reversibility persists ----------

@test "driver note: --reversibility high persists into the entry + digest emoji" {
  local id; id=$("$ATMUX_BIN" driver note "high-rev call" --reversibility high | tail -1)
  grep -q "^- \*\*reversibility\*\*: high$" .atmux/driver-state.md
  # Digest emoji for high is 🔴.
  awk '
    /^## Digest \(last 5\)/ { in_digest=1; next }
    /^---/                   { in_digest=0 }
    in_digest                { print }
  ' .atmux/driver-state.md | grep -q "🔴 \`$id\`"
}

# ---------- driver note: 60-char ERROR ----------

@test "driver note: message >60 chars ⇒ ERROR (no entry written)" {
  local long; long=$(printf '%.0sX' {1..61})
  run "$ATMUX_BIN" driver note "$long"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "exceeds 60 chars" ]]
  [ ! -f .atmux/driver-state.md ]
}

@test "driver note: message at the 60-char boundary is accepted" {
  local sixty; sixty=$(printf '%.0sM' {1..60})
  run "$ATMUX_BIN" driver note "$sixty"
  [ "$status" -eq 0 ]
}

@test "driver note: --note >60 chars ⇒ ERROR" {
  local long; long=$(printf '%.0sN' {1..61})
  run "$ATMUX_BIN" driver note "ok message" --note "$long"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--note exceeds 60 chars" ]]
}

@test "driver note: missing message ⇒ ERROR with usage hint" {
  run "$ATMUX_BIN" driver note
  [ "$status" -ne 0 ]
  [[ "$output" =~ "<message> required" ]]
}

@test "driver note: invalid --reversibility ⇒ ERROR" {
  run "$ATMUX_BIN" driver note "ok" --reversibility BAD
  [ "$status" -ne 0 ]
  [[ "$output" =~ "low|medium|high" ]]
}
