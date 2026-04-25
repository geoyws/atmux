#!/usr/bin/env bats
# Unit tests for `atmux decisions` (T10.1 + T10.3, ADR-008).
# Scope: validation paths (errors, NOT silent truncation) + add/list/show
# round-trip smoke + Discord webhook payload shape (mocked curl).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name k >/dev/null

  # Mock curl: PATH-prepend a script that records argv to a NUL-delimited file.
  # Lets us recover the exact `-d <payload>` bytes (template has spaces/emoji)
  # without hitting the network. Used by webhook tests below.
  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
# mock curl for decisions.bats — capture argv to $ATMUX_TEST_TMP/curl-args.bin
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"
}

teardown() {
  atmux_teardown_sandbox
}

# Recover the JSON `content` field of the most recent mock-curl invocation.
_curl_payload_content() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"} prev=="-d"{print; exit} {prev=$0}' "$f" | jq -r '.content // empty'
}

@test "decisions: add mints a d-xxxxxxxx id and writes .atmux/decisions.md" {
  run "$ATMUX_BIN" decisions add "Use pg-15?" --default "yes"
  [ "$status" -eq 0 ]
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^d-[0-9a-f]{8}$ ]]
  [ -f .atmux/decisions.md ]
  grep -q "### $id — Use pg-15? \[low\]" .atmux/decisions.md
  grep -q "^- \*\*default\*\*: yes$" .atmux/decisions.md
  grep -q "^- \*\*reversibility\*\*: low$" .atmux/decisions.md
}

@test "decisions: add ERRORS when question exceeds 200 chars (E2/S9 — relaxed cap)" {
  # Pre-S9 cap was 60 (Discord ≤80 budget at the data layer). S9 moves the
  # cap to 200 + delegates the per-line ≤80-char budget to the renderer
  # (chunking + drop-order). ERROR-not-truncate behavior preserved.
  local long; long=$(printf '%.0sX' {1..201})
  run "$ATMUX_BIN" decisions add "$long" --default "yes"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "exceeds 200 chars" ]]
  [ ! -f .atmux/decisions.md ]
}

@test "decisions: add ERRORS when default exceeds 200 chars (E2/S9 — relaxed cap)" {
  local long; long=$(printf '%.0sY' {1..201})
  run "$ATMUX_BIN" decisions add "Use pg-15?" --default "$long"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "exceeds 200 chars" ]]
}

@test "decisions: add accepts question + default at the 200-char boundary (E2/S9)" {
  local two_hundred; two_hundred=$(printf '%.0sZ' {1..200})
  run "$ATMUX_BIN" decisions add "$two_hundred" --default "$two_hundred"
  [ "$status" -eq 0 ]
}

@test "decisions: add ERRORS when --note exceeds 500 chars (E2/S9 — relaxed cap)" {
  # Pre-S9 the note cap was 60 chars (review-followup t-47361a6c). S9 lifts
  # it to 500 — the renderer handles oversize bodies via drop-order
  # truncation (note→impact→options→context).
  local long; long=$(printf '%.0sN' {1..501})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$long"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--note exceeds 500 chars" ]]
}

@test "decisions: add accepts --note at the 500-char boundary (E2/S9)" {
  local five_hundred; five_hundred=$(printf '%.0sN' {1..500})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$five_hundred"
  [ "$status" -eq 0 ]
}

@test "decisions: --note=80 chars is accepted under S9 (was rejected pre-S9)" {
  # Regression-pin: the pre-S9 t-47361a6c case (80-char note rejected at
  # the 60-char cap) is now accepted because S9 lifted the cap to 500.
  # Keep the old length to make the relaxation visible to a future reader
  # who greps for "80 chars" expecting the ban — they land here and learn.
  local eighty; eighty=$(printf '%.0sN' {1..80})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$eighty"
  [ "$status" -eq 0 ]
  grep -q "^- \*\*note\*\*: $eighty\$" .atmux/decisions.md
}

@test "decisions: add rejects invalid --reversibility" {
  run "$ATMUX_BIN" decisions add "q?" --default "y" --reversibility BAD
  [ "$status" -ne 0 ]
  [[ "$output" =~ "low|medium|high" ]]
}

@test "decisions: add is idempotent within 60s for same question + default" {
  run "$ATMUX_BIN" decisions add "Pin nodejs to 20?" --default "yes"
  [ "$status" -eq 0 ]
  local first; first=$(echo "$output" | tail -1)
  run "$ATMUX_BIN" decisions add "Pin nodejs to 20?" --default "yes"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "skipped duplicate of $first" ]]
  # Only one ### entry in the log, not two.
  local count; count=$(grep -c "^### d-" .atmux/decisions.md)
  [ "$count" -eq 1 ]
}

@test "decisions: list --json returns parseable JSON array" {
  "$ATMUX_BIN" decisions add "Q1?" --default "A1" --reversibility low    >/dev/null
  "$ATMUX_BIN" decisions add "Q2?" --default "A2" --reversibility medium >/dev/null
  run "$ATMUX_BIN" decisions list --json
  [ "$status" -eq 0 ]
  # Two entries, sorted DESC by timestamp (Q2 added second → first in output).
  run jq -r 'length' <<<"$output"
  [ "$output" = "2" ]
}

@test "decisions: list --reversibility filters" {
  "$ATMUX_BIN" decisions add "Q-low?"  --default "A1" --reversibility low    >/dev/null
  "$ATMUX_BIN" decisions add "Q-high?" --default "A2" --reversibility high   >/dev/null
  local listed; listed=$("$ATMUX_BIN" decisions list --reversibility high --json)
  [ "$(jq -r 'length' <<<"$listed")" = "1" ]
  [ "$(jq -r '.[0].question' <<<"$listed")" = "Q-high?" ]
}

@test "decisions: show prints the entry; missing id errors out" {
  run "$ATMUX_BIN" decisions add "Q?" --default "A"
  local id; id=$(echo "$output" | tail -1)
  run "$ATMUX_BIN" decisions show "$id"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "### $id" ]]
  [[ "$output" =~ "Q?" ]]
  run "$ATMUX_BIN" decisions show d-deadbeef
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no entry with id" ]]
}

@test "decisions: missing verb errors with usage hint" {
  run "$ATMUX_BIN" decisions
  [ "$status" -ne 0 ]
  [[ "$output" =~ "missing verb" ]]
}

@test "decisions: discord ping is a no-op when no webhook is configured" {
  # No ATMUX_DISCORD_WEBHOOK + no team.discord.webhook → silent skip, exit 0.
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "No-hook smoke?" --default "ok"
  [ "$status" -eq 0 ]
  # Mock curl was on PATH but should never have been invoked.
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]
}

# ---------- discord webhook integration (mocked curl) ----------

@test "decisions: with webhook + reversibility=high, curl is invoked with the [atmux-decisions] template" {
  # Post-t-398bc8a1: only reversibility=high triggers a Discord ping. Use
  # high here so the template assertions still exercise the payload shape;
  # the medium/low gate behaviour is asserted in decisions_gating.bats.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "ship now?" --default "yes" --reversibility high
  [ "$status" -eq 0 ]
  [ -f "$ATMUX_TEST_TMP/curl-args.bin" ]
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "[atmux-decisions]" ]]
  # E2/S9: question line gained a "question: " prefix to match the
  # other field labels (default:/context:/impact:/note:/decided-by:).
  [[ "$body" =~ "🔵 question: ship now?" ]]
  [[ "$body" =~ "default: yes" ]]
  [[ "$body" =~ "reversibility: high" ]]
  [[ "$body" =~ "atmux decisions show d-" ]]
  # Override CTA — the literal `override:` substring went away when the
  # 📍 pointer was split into two bullets to fit the ≤80-char budget;
  # assert the send-lead override command instead, which is format-robust.
  [[ "$body" =~ atmux\ send\ lead.*override ]]
}

@test "decisions: discord template uses the team name from team.json in the header" {
  # Use --reversibility high so the gate (post-t-398bc8a1) lets the ping
  # through. We're only verifying header content here, not gate semantics.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "named?" --default "y" --reversibility high >/dev/null
  local body; body=$(_curl_payload_content)
  # Header format: 📋 **[atmux-decisions]** · `<team>` · HH:MM MYT
  # Team was set via `init --name k` in setup.
  [[ "$body" =~ \`k\` ]]
  [[ "$body" =~ "MYT" ]]
}

@test "decisions: discord template — every body line ≤80 chars per global format spec" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "tight q?" --default "tight a" --reversibility high --note "short ctx" >/dev/null
  local body; body=$(_curl_payload_content)
  # Char count, not byte count — emoji are multi-byte.
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local n=${#line}
    [ "$n" -le 80 ] || { echo "BULLET >80 chars ($n): $line"; false; }
  done <<<"$body"
}

@test "decisions: reversibility=high maps to 🔴 in payload (low/medium gated, no ping)" {
  # Post-t-398bc8a1: only high triggers a Discord ping. Low + medium are
  # silent (logged-only). The emoji map itself still pre-exists in the
  # template renderer; we just can't observe it via curl when the gate
  # blocks the call. Verify high pings with 🔴; assert low/medium don't ping.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "low one?"  --default "a" --reversibility low >/dev/null
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "med one?"  --default "a" --reversibility medium >/dev/null
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "high one?" --default "a" --reversibility high >/dev/null
  [[ "$(_curl_payload_content)" =~ 🔴 ]]
}

@test "decisions: --note appears as 📝 line in discord payload (reversibility=high)" {
  # --note semantics in the payload — needs a ping to fire. Use high so
  # post-gate the curl call goes through.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "noteq?" --default "y" --reversibility high --note "extra context" >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "📝 note: extra context" ]]
}

@test "decisions: no --note ⇒ no 📝 line in payload (reversibility=high)" {
  # Use high so the gate lets the ping through; without it the body would
  # be empty and the assertion would pass vacuously.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "nonote?" --default "y" --reversibility high >/dev/null
  local body; body=$(_curl_payload_content)
  [ -n "$body" ]
  ! [[ "$body" =~ "📝 note:" ]]
}

# ---------- list --since ----------

@test "decisions: list --since 1h includes recent entries" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "fresh?" --default "y" >/dev/null 2>&1
  run "$ATMUX_BIN" decisions list --since 1h --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions: list --since 1d accepts the Nd shorthand" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "qday?" --default "y" >/dev/null 2>&1
  run "$ATMUX_BIN" decisions list --since 1d --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" -ge 1 ]
}

@test "decisions: list --since rejects garbage with non-zero exit" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  run "$ATMUX_BIN" decisions list --since "notatimestamp"
  [ "$status" -ne 0 ]
}

@test "decisions: list with no entries returns the empty marker" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  run "$ATMUX_BIN" decisions list
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no decisions" ]]
}

@test "decisions: list --json with no entries returns []" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  run "$ATMUX_BIN" decisions list --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" = "0" ]
}

# ---------- input sanitization ----------

@test "decisions: newline/tab in question is squashed to space (preserves markdown parser)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add $'multi\nline?' --default "y" >/dev/null 2>&1
  # The literal newline must NOT have leaked into the markdown body; the
  # `### d-...` heading parses one-per-line, so a newline in the question
  # would corrupt show/list parsing.
  run grep -c '^### d-' .atmux/decisions.md
  [ "$output" = "1" ]
}

# ---------- E2/S9 data path: new optional fields ----------

@test "decisions: old 4-field call ⇒ no new bullets in .md (backward compat)" {
  # An entry with only the original flags must be bit-identical to today's
  # format — no `- **context**:`, `- **options**:`, `- **impact**:`, or
  # `- **decided-by**:` lines. External readers/greppers built on the old
  # shape keep working.
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "old shape?" --default "yes" --reversibility low --note "soak" >/dev/null
  # `[[ ! ... ]]`-shaped negation works on every Bats version; `run !`
  # needs `bats_require_minimum_version 1.5.0` to behave consistently.
  [[ ! $(grep -c '^- \*\*context\*\*:'    .atmux/decisions.md) -gt 0 ]]
  [[ ! $(grep -c '^- \*\*options\*\*:'    .atmux/decisions.md) -gt 0 ]]
  [[ ! $(grep -c '^- \*\*impact\*\*:'     .atmux/decisions.md) -gt 0 ]]
  [[ ! $(grep -c '^- \*\*decided-by\*\*:' .atmux/decisions.md) -gt 0 ]]
  grep -q '^- \*\*note\*\*: soak$'   .atmux/decisions.md
}

@test "decisions: full call with all new fields ⇒ all bullets persisted in .md" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "auth?" --default "OAuth" \
    --context "team has no IdP yet" \
    --option "OAuth" --option "SAML" --option "JWT" \
    --impact "blocks t-aaa1" \
    --decided-by "lead" >/dev/null
  grep -q '^- \*\*context\*\*: team has no IdP yet$'    .atmux/decisions.md
  grep -q '^- \*\*options\*\*:$'                         .atmux/decisions.md
  grep -q '^  - OAuth$'                                  .atmux/decisions.md
  grep -q '^  - SAML$'                                   .atmux/decisions.md
  grep -q '^  - JWT$'                                    .atmux/decisions.md
  grep -q '^- \*\*impact\*\*: blocks t-aaa1$'            .atmux/decisions.md
  grep -q '^- \*\*decided-by\*\*: lead$'                 .atmux/decisions.md
}

@test "decisions: options sub-list is recoverable via 'decisions show'" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "pick stack?" --default "node" \
    --option "node" --option "deno" --option "bun" >/dev/null
  local id; id=$(grep '^### d-' .atmux/decisions.md | head -1 | awk '{print $2}')
  run "$ATMUX_BIN" decisions show "$id"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "options" ]]
  [[ "$output" =~ "node" ]]
  [[ "$output" =~ "deno" ]]
  [[ "$output" =~ "bun" ]]
}

@test "decisions: list --json exposes new fields (context/impact/decided-by/options)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "auth?" --default "OAuth" \
    --context "ctx text" --impact "imp text" --decided-by "lead" \
    --option "A" --option "B" >/dev/null
  local json; json=$("$ATMUX_BIN" decisions list --json)
  [ "$(jq -r '.[0].context'      <<<"$json")" = "ctx text" ]
  [ "$(jq -r '.[0].impact'       <<<"$json")" = "imp text" ]
  [ "$(jq -r '.[0]."decided-by"' <<<"$json")" = "lead" ]
  [ "$(jq -r '.[0].options | length' <<<"$json")" = "2" ]
  [ "$(jq -r '.[0].options[0]'   <<<"$json")" = "A" ]
  [ "$(jq -r '.[0].options[1]'   <<<"$json")" = "B" ]
}

@test "decisions: list --json returns null/[] for absent new fields (backward compat)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  "$ATMUX_BIN" decisions add "old shape?" --default "yes" >/dev/null
  local json; json=$("$ATMUX_BIN" decisions list --json)
  [ "$(jq -r '.[0].context // "NULL"'      <<<"$json")" = "NULL" ]
  [ "$(jq -r '.[0].impact // "NULL"'       <<<"$json")" = "NULL" ]
  [ "$(jq -r '.[0]."decided-by" // "NULL"' <<<"$json")" = "NULL" ]
  [ "$(jq -r '.[0].options | length'       <<<"$json")" = "0" ]
}

@test "decisions: --context >500 chars ERRORS; 500 chars at boundary accepted" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local cap;  cap=$(printf '%.0sC' {1..500})
  local over; over=$(printf '%.0sC' {1..501})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --context "$over"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--context exceeds 500 chars" ]]
  run "$ATMUX_BIN" decisions add "q?" --default "y" --context "$cap"
  [ "$status" -eq 0 ]
}

@test "decisions: --impact >500 chars ERRORS; 500 chars at boundary accepted" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local cap;  cap=$(printf '%.0sI' {1..500})
  local over; over=$(printf '%.0sI' {1..501})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --impact "$over"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--impact exceeds 500 chars" ]]
  run "$ATMUX_BIN" decisions add "q?" --default "y" --impact "$cap"
  [ "$status" -eq 0 ]
}

@test "decisions: --decided-by >80 chars ERRORS; 80 chars at boundary accepted" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local cap;  cap=$(printf '%.0sD' {1..80})
  local over; over=$(printf '%.0sD' {1..81})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --decided-by "$over"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--decided-by exceeds 80 chars" ]]
  run "$ATMUX_BIN" decisions add "q?" --default "y" --decided-by "$cap"
  [ "$status" -eq 0 ]
}

@test "decisions: --option entry >200 chars ERRORS; 5 options at max-count accepted" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local big; big=$(printf '%.0so' {1..201})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --option "$big"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--option entry exceeds 200 chars" ]]
  # Five entries at the 5-occurrence cap → accepted.
  run "$ATMUX_BIN" decisions add "q?" --default "y" \
    --option a --option b --option c --option d --option e
  [ "$status" -eq 0 ]
}

@test "decisions: 6th --option ERRORS (max 5 occurrences)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  run "$ATMUX_BIN" decisions add "q?" --default "y" \
    --option a --option b --option c --option d --option e --option f
  [ "$status" -ne 0 ]
  [[ "$output" =~ "max 5 occurrences" ]]
}

@test "decisions: legacy .md (no S9 fields) parses cleanly via _decisions_to_json_array" {
  # Backward-compat parser regression — synthesize an entry in the old
  # 4-field shape (no context/options/impact/decided-by bullets), then
  # confirm `decisions list --json` returns it with null/[] for the new
  # fields. Catches an awk regression where adding the new bullets
  # breaks the old shape.
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  cat > .atmux/decisions.md <<'LEGACY_EOF'
# atmux decisions — append-only log

### d-deadbeef — legacy shape? [low] (10:00 MYT)

- **timestamp**: 1700000000
- **question**: legacy shape?
- **default**: yes
- **reversibility**: low
- **override**: `atmux send lead "override d-deadbeef: <new>"`
LEGACY_EOF
  local json; json=$("$ATMUX_BIN" decisions list --json)
  [ "$(jq -r '.[0].id'                     <<<"$json")" = "d-deadbeef" ]
  [ "$(jq -r '.[0].question'               <<<"$json")" = "legacy shape?" ]
  [ "$(jq -r '.[0].context // "NULL"'      <<<"$json")" = "NULL" ]
  [ "$(jq -r '.[0].options | length'       <<<"$json")" = "0" ]
  [ "$(jq -r '.[0]."decided-by" // "NULL"' <<<"$json")" = "NULL" ]
}

# ---------- E2/S9 render path: new fields in Discord template ----------

@test "decisions: render — minimal call (no new fields) keeps required-only emoji" {
  # Backward-compat: a high-rev decision with no new fields renders just
  # the question/default/reversibility/show/override block (plus no
  # 👤/🌐/⚖️/💥 lines) — bit-identical to today's body shape modulo the
  # 'question:' prefix added in T2.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "minimal?" --default "yes" --reversibility high >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "🔵 question: minimal?" ]]
  [[ "$body" =~ "✅ default: yes" ]]
  [[ "$body" =~ "🔴 reversibility: high" ]]
  [[ "$body" =~ "📍 atmux decisions show d-" ]]
  [[ ! "$body" =~ "👤 decided-by:" ]]
  [[ ! "$body" =~ "🌐 context:" ]]
  [[ ! "$body" =~ "⚖️ options:" ]]
  [[ ! "$body" =~ "💥 impact:" ]]
  [[ ! "$body" =~ "📝 note:" ]]
}

@test "decisions: render — full call emits 👤 🌐 ⚖️ 💥 in documented order" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "full?" \
    --default "OAuth" --reversibility high \
    --decided-by "lead" \
    --context "no IdP yet" \
    --option "OAuth" --option "SAML" --option "JWT" \
    --impact "blocks t-aaa1" \
    --note "soak 1 week" >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "👤 decided-by: lead" ]]
  [[ "$body" =~ "🌐 context: no IdP yet" ]]
  [[ "$body" =~ "⚖️ options:" ]]
  [[ "$body" =~ "  - OAuth" ]]
  [[ "$body" =~ "  - SAML" ]]
  [[ "$body" =~ "  - JWT" ]]
  [[ "$body" =~ "💥 impact: blocks t-aaa1" ]]
  [[ "$body" =~ "📝 note: soak 1 week" ]]
  # AC order: question · default · decided-by · context · options · impact · note · reversibility
  # Verify decided-by appears before context, options before impact, etc.
  local pos_dby; pos_dby=$(awk '/decided-by/{print NR; exit}' <<<"$body")
  local pos_ctx; pos_ctx=$(awk '/context:/{print NR; exit}'    <<<"$body")
  local pos_opt; pos_opt=$(awk '/options:/{print NR; exit}'    <<<"$body")
  local pos_imp; pos_imp=$(awk '/impact:/{print NR; exit}'     <<<"$body")
  local pos_nte; pos_nte=$(awk '/note:/{print NR; exit}'       <<<"$body")
  (( pos_dby < pos_ctx ))
  (( pos_ctx < pos_opt ))
  (( pos_opt < pos_imp ))
  (( pos_imp < pos_nte ))
}

@test "decisions: render — partial (--context only) ⇒ only 🌐 added" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "ctxonly?" \
    --default "yes" --reversibility high --context "narrow scope" >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "🌐 context: narrow scope" ]]
  [[ ! "$body" =~ "👤 decided-by:" ]]
  [[ ! "$body" =~ "⚖️ options:" ]]
  [[ ! "$body" =~ "💥 impact:" ]]
}

@test "decisions: render — options sub-list emits indented '  - <opt>' bullets" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "options?" \
    --default "A" --reversibility high \
    --option "alpha" --option "beta" >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "⚖️ options:" ]]
  [[ "$body" =~ "  - alpha" ]]
  [[ "$body" =~ "  - beta" ]]
  # Bare lines like `alpha` (without `  - ` prefix) must NOT appear — the
  # renderer always indents.
  [[ ! "$body" =~ ^alpha$ ]]
}
