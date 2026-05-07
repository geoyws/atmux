#!/usr/bin/env bats
# Unit tests for lib/report.sh chunker integration (Bug#1 fix).
#
# `atmux report` MUST split bodies bigger than ~4KB into ≤4096-char Discord
# embed messages via lib/discord.sh _atmux_chunk_for_embed. Pre-fix, a
# 28KB report body produced one curl call with HTTP 400
# BASE_TYPE_MAX_LENGTH; post-fix, the same input fans out across 1..10
# curl calls each carrying a payload under the embed-description cap.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name r >/dev/null

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
# Capture every arg of every invocation, NUL-separated. Append-mode so
# multi-call (chunked) reports leave one record per call.
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
echo 200          # mock --write-out '%{http_code}'
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"

  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

# Count distinct curl invocations (one per chunk).
_curl_call_count() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

# Pull every embed description string from captured curl payloads.
_curl_all_descriptions() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"; pick=0} {
    if (pick) { print; pick=0; next }
    if ($0=="--data-raw" || $0=="-d" || $0=="--data") pick=1
  }' "$f" | jq -r '.embeds[0].description // empty' 2>/dev/null
}

# Seed N done tasks under the team's kanban so the report body grows past
# the 4096-byte embed cap. Each row is ~80 chars (atmux task subject).
_seed_done_tasks() {
  local n="$1"
  local k=".atmux/kanban.json"
  local i
  for (( i=1; i<=n; i++ )); do
    "$ATMUX_BIN" task add "BIG_BODY_TASK_$i — $(printf '%.0sX' {1..40})" >/dev/null
  done
  # Flip them all done so they appear in shipped_rows.
  jq '.tasks |= map(.status="done" | .completedAt=(now|floor) | .owner="be-kanban")' \
    "$k" > "$k.tmp" && mv "$k.tmp" "$k"
  # State file: last-report.epoch=0 → all tasks count as "since last report".
  printf 0 > .atmux/state/last-report.epoch
  mkdir -p .atmux/state && printf 0 > .atmux/state/last-report.epoch
}

# ---------- single-chunk path (preserves existing behavior) ----------

@test "report: small body → single chunk → 1 curl call, no [N/M] tag" {
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" report
  [ "$status" -eq 0 ]
  [ "$(_curl_call_count)" = "1" ]
  local desc; desc=$(_curl_all_descriptions)
  [[ "$desc" =~ "📊 **[atmux-report]**" ]]
  ! [[ "$desc" =~ \[1/ ]]
}

@test "report: --no-discord → echoes body but no curl calls" {
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" report --no-discord
  [ "$status" -eq 0 ]
  [[ "$output" =~ "📊 **[atmux-report]**" ]]
  [ "$(_curl_call_count)" = "0" ]
}

# ---------- multi-chunk path (the Bug#1 fix) ----------

@test "report: large body (~28KB) → multi-chunk → N curl calls, each ≤4096 chars" {
  _seed_done_tasks 250
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" report
  [ "$status" -eq 0 ]
  local n; n=$(_curl_call_count)
  [ "$n" -ge 2 ]
  [ "$n" -le 10 ]
  # Each captured embed description must fit Discord's 4096-byte cap.
  local desc len
  while IFS= read -r desc; do
    [[ -n "$desc" ]] || continue
    len="${#desc}"
    [ "$len" -le 4096 ]
  done <<< "$(_curl_all_descriptions)"
}

@test "report: large body → every chunk carries [N/M] tag in header" {
  _seed_done_tasks 250
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" report
  [ "$status" -eq 0 ]
  local n; n=$(_curl_call_count)
  [ "$n" -ge 2 ]
  local descs; descs=$(_curl_all_descriptions)
  # Each emitted chunk header is `📊 **[atmux-report]** [i/n] · ...`.
  [[ "$descs" =~ \[1/$n\] ]]
  [[ "$descs" =~ \[$n/$n\] ]]
}

@test "report: large body → required-block (Shipped section) lands in chunk 1" {
  _seed_done_tasks 250
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" report
  [ "$status" -eq 0 ]
  # Extract just the first chunk's description (multi-line). awk over the
  # NUL-separated curl args, take the first --data-raw payload, jq the
  # description field which preserves the chunk's full body.
  local first
  first=$(awk 'BEGIN{RS="\0"; pick=0; got=0} {
    if (got) exit
    if (pick) { print; got=1; exit }
    if ($0=="--data-raw" || $0=="-d" || $0=="--data") pick=1
  }' "$ATMUX_TEST_TMP/curl-args.bin" | jq -r '.embeds[0].description // empty')
  # Header (📊) is line 1; section header (🏗️) follows on line 3 of chunk 1.
  [[ "$first" =~ "📊 **[atmux-report]" ]]
  [[ "$first" =~ "🏗️ **Shipped**" ]]
}
