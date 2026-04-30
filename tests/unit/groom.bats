#!/usr/bin/env bats
# Unit tests for lib/groom.sh — periodic state hygiene verb.
#
# Coverage:
#   - cold-start (empty .atmux/) is a no-op + exits 0
#   - driver-inbox.md ## Archive section flushes into dated archive
#   - lead-outbox.md same flow
#   - decisions.md old entries (parsed via -**timestamp**: epoch) move
#     into per-month archive; recent entries stay
#   - kanban.json done/cancelled cards >--kanban-days move into
#     archive/kanban-log-YYYY-MM.md and are removed from the live file;
#     in-progress + recent done cards stay
#   - kanban summary handles both epoch and ISO completedAt formats
#   - kanban summary handles subjects starting with `-` (printf option-flag
#     trap)
#   - .bak.* cull keeps newest --keep-bak; deletes the rest
#   - --dry-run touches no files
#   - second run on same state is a no-op (idempotent)
#   - ATMUX_NO_GROOM=1 short-circuits to a no-op

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # Sandbox sets ATMUX_NO_GROOM=1 so other suites' `atmux start` calls
  # don't fork a parallel groom; groom.bats is the one suite that
  # exercises the verb itself, so it explicitly unsets the gate.
  unset ATMUX_NO_GROOM
  "$ATMUX_BIN" init --name g >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Helper: write a kanban.json with mixed-age tasks. Epoch
# 1735689600 = 2025-01-01 (>>30d before 2026-04-30); 1777300000 ≈
# 2026-04-29 (within 30d window).
_seed_kanban() {
  cat > "$ATMUX_DIR/kanban.json" <<'JSON'
{
  "tasks": [
    {"id":"t-stale","subject":"Old card","status":"done","completedAt":1735689600,"owner":"alice"},
    {"id":"t-stale-iso","subject":"ISO date card","status":"done","completedAt":"2025-01-15T12:00:00Z","owner":"bob"},
    {"id":"t-stale-dash","subject":"-leading dash subject","status":"done","completedAt":1735689700,"owner":"alice"},
    {"id":"t-cancelled","subject":"Cancelled old","status":"cancelled","completedAt":1735689800,"owner":"alice"},
    {"id":"t-recent","subject":"Recent card","status":"done","completedAt":1777300000,"owner":"bob"},
    {"id":"t-active","subject":"In flight","status":"in-progress","owner":"alice"}
  ],
  "epics":[],"stories":[]
}
JSON
}

_seed_inbox() {
  cat > "$ATMUX_DIR/driver-inbox.md" <<'MD'
# Driver Inbox

## Open
- live entry @ today

## Archive
- old entry one
- old entry two
MD
}

_seed_outbox() {
  cat > "$ATMUX_DIR/lead-outbox.md" <<'MD'
# Lead Outbox

## Open
- [12:00 MYT] **member**: live message

## Archive
- archived message one
- archived message two
MD
}

_seed_decisions() {
  cat > "$ATMUX_DIR/decisions.md" <<'MD'
# atmux decisions — append-only log

### d-old1 — Old question [low] (12:00 MYT)

- **timestamp**: 1735689600
- **question**: Old?
- **default**: Yes

### d-recent — New question [low] (12:00 MYT)

- **timestamp**: 1777300000
- **question**: Recent?
- **default**: Yes
MD
}

@test "groom: cold-start with empty .atmux/ is a no-op + exits 0" {
  run "$ATMUX_BIN" groom --dry-run
  [ "$status" -eq 0 ]
}

@test "groom: driver-inbox ## Archive section flushes into dated archive" {
  _seed_inbox
  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]

  # Active file: header + Open + empty Archive header.
  ! grep -q "old entry one" "$ATMUX_DIR/driver-inbox.md"
  grep -q "live entry @ today" "$ATMUX_DIR/driver-inbox.md"
  grep -q "^## Archive" "$ATMUX_DIR/driver-inbox.md"

  # Archive file: contains the flushed content.
  local stamp; stamp="$(date +%Y-%m)"
  [ -f "$ATMUX_DIR/archive/driver-inbox-${stamp}.md" ]
  grep -q "old entry one" "$ATMUX_DIR/archive/driver-inbox-${stamp}.md"
  grep -q "old entry two" "$ATMUX_DIR/archive/driver-inbox-${stamp}.md"
}

@test "groom: lead-outbox ## Archive section flushes into dated archive" {
  _seed_outbox
  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]

  ! grep -q "archived message one" "$ATMUX_DIR/lead-outbox.md"
  grep -q "live message" "$ATMUX_DIR/lead-outbox.md"

  local stamp; stamp="$(date +%Y-%m)"
  [ -f "$ATMUX_DIR/archive/lead-outbox-${stamp}.md" ]
  grep -q "archived message one" "$ATMUX_DIR/archive/lead-outbox-${stamp}.md"
}

@test "groom: decisions older than --decisions-days move; recent stay" {
  _seed_decisions
  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]

  # d-old1's timestamp 1735689600 = 2025-01 → archive/decisions-2025-01.md.
  [ -f "$ATMUX_DIR/archive/decisions-2025-01.md" ]
  grep -q "d-old1" "$ATMUX_DIR/archive/decisions-2025-01.md"

  # Live file keeps d-recent, drops d-old1.
  grep -q "d-recent" "$ATMUX_DIR/decisions.md"
  ! grep -q "d-old1" "$ATMUX_DIR/decisions.md"
}

@test "groom: kanban summarizes done/cancelled stale cards into kanban-log" {
  _seed_kanban
  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]

  # Live kanban: only t-recent + t-active remain.
  local n; n="$(jq '.tasks | length' "$ATMUX_DIR/kanban.json")"
  [ "$n" -eq 2 ]
  jq -e '.tasks[] | select(.id == "t-recent")' "$ATMUX_DIR/kanban.json" >/dev/null
  jq -e '.tasks[] | select(.id == "t-active")' "$ATMUX_DIR/kanban.json" >/dev/null

  # Archive contains all four stale cards (3 done + 1 cancelled).
  [ -f "$ATMUX_DIR/archive/kanban-log-2025-01.md" ]
  grep -q "t-stale" "$ATMUX_DIR/archive/kanban-log-2025-01.md"
  grep -q "t-stale-iso" "$ATMUX_DIR/archive/kanban-log-2025-01.md"
  grep -q "t-stale-dash" "$ATMUX_DIR/archive/kanban-log-2025-01.md"
  grep -q "t-cancelled" "$ATMUX_DIR/archive/kanban-log-2025-01.md"
  grep -q '\[cancelled\]' "$ATMUX_DIR/archive/kanban-log-2025-01.md"
}

@test "groom: subject starting with '-' doesn't trip printf option parsing" {
  _seed_kanban
  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "invalid option" ]]
  grep -q -- "-leading dash subject" "$ATMUX_DIR/archive/kanban-log-2025-01.md"
}

@test "groom: --keep-bak culls oldest, keeps newest N" {
  for i in 1 2 3 4 5 6 7 8; do
    echo "{}" > "$ATMUX_DIR/kanban.json.bak.$((1000000+i))"
    touch -d "$i hours ago" "$ATMUX_DIR/kanban.json.bak.$((1000000+i))"
  done

  run "$ATMUX_BIN" groom --keep-bak 3
  [ "$status" -eq 0 ]

  # The 3 newest survive (bak.1000001 through bak.1000003).
  [ -f "$ATMUX_DIR/kanban.json.bak.1000001" ]
  [ -f "$ATMUX_DIR/kanban.json.bak.1000002" ]
  [ -f "$ATMUX_DIR/kanban.json.bak.1000003" ]
  ! [ -f "$ATMUX_DIR/kanban.json.bak.1000004" ]
  ! [ -f "$ATMUX_DIR/kanban.json.bak.1000008" ]
}

@test "groom: --dry-run touches no files" {
  _seed_inbox
  _seed_decisions
  _seed_kanban
  for i in 1 2 3 4 5 6 7; do
    echo "{}" > "$ATMUX_DIR/kanban.json.bak.$((1000000+i))"
  done

  local inbox_before; inbox_before="$(md5sum "$ATMUX_DIR/driver-inbox.md")"
  local decisions_before; decisions_before="$(md5sum "$ATMUX_DIR/decisions.md")"
  local kanban_before; kanban_before="$(md5sum "$ATMUX_DIR/kanban.json")"
  local bak_count_before; bak_count_before="$(ls "$ATMUX_DIR/"kanban.json.bak.* | wc -l)"

  run "$ATMUX_BIN" groom --dry-run
  [ "$status" -eq 0 ]

  [ "$(md5sum "$ATMUX_DIR/driver-inbox.md")" = "$inbox_before" ]
  [ "$(md5sum "$ATMUX_DIR/decisions.md")" = "$decisions_before" ]
  [ "$(md5sum "$ATMUX_DIR/kanban.json")" = "$kanban_before" ]
  [ "$(ls "$ATMUX_DIR/"kanban.json.bak.* | wc -l)" -eq "$bak_count_before" ]

  # No archive files created.
  [ -z "$(ls "$ATMUX_DIR/archive/" 2>/dev/null)" ]
}

@test "groom: idempotent — second run leaves state unchanged" {
  _seed_inbox
  _seed_decisions
  _seed_kanban

  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]

  local kanban_after_first; kanban_after_first="$(md5sum "$ATMUX_DIR/kanban.json")"
  local decisions_after_first; decisions_after_first="$(md5sum "$ATMUX_DIR/decisions.md")"
  local inbox_after_first; inbox_after_first="$(md5sum "$ATMUX_DIR/driver-inbox.md")"

  run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]

  # Live files identical. (kanban gets a fresh .bak.<epoch> from the
  # kanban_json_backup hook even on no-op runs, so we don't compare bak
  # counts here — that's covered by the bak-cull test.)
  [ "$(md5sum "$ATMUX_DIR/kanban.json")" = "$kanban_after_first" ]
  [ "$(md5sum "$ATMUX_DIR/decisions.md")" = "$decisions_after_first" ]
  [ "$(md5sum "$ATMUX_DIR/driver-inbox.md")" = "$inbox_after_first" ]
}

@test "groom: ATMUX_NO_GROOM=1 short-circuits to no-op" {
  _seed_kanban
  local before; before="$(md5sum "$ATMUX_DIR/kanban.json")"
  ATMUX_NO_GROOM=1 run "$ATMUX_BIN" groom
  [ "$status" -eq 0 ]
  [ "$(md5sum "$ATMUX_DIR/kanban.json")" = "$before" ]
}

@test "groom: --kanban-days 9999 spares all cards (cutoff in distant past)" {
  _seed_kanban
  run "$ATMUX_BIN" groom --kanban-days 9999
  [ "$status" -eq 0 ]
  # All 6 cards stay.
  local n; n="$(jq '.tasks | length' "$ATMUX_DIR/kanban.json")"
  [ "$n" -eq 6 ]
}

@test "groom: usage block fires on --help" {
  run "$ATMUX_BIN" groom --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux groom" ]]
  [[ "$output" =~ "--dry-run" ]]
}

@test "groom: cron block includes daily groom line" {
  # Render lines directly (cron.sh public function via _atmux_cron_render_lines).
  atmux_source_libs
  . "$ATMUX_LIB_DIR/cron.sh"
  local lines; lines="$(_atmux_cron_render_lines "$ATMUX_DIR" "/usr/bin/atmux" "")"
  echo "$lines" | grep -qE '^0 4 \* \* \* .*groom --quiet'
}
