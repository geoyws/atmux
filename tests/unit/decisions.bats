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

  # Force plain {content:<body>} shape so the existing .content-based
  # payload extractors stay valid post-ADR-019 embed switch. Embed-shape
  # coverage lives in tests/unit/discord_palette.bats.
  export ATMUX_DISCORD_PLAINTEXT=1
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

@test "decisions: add accepts long question (E2/S10 — caps dropped, chunker takes over)" {
  # Pre-S10 the question was capped at 200 chars (S9 lifted from 60). S10
  # T1 drops the per-field cap entirely: caller can pass arbitrarily long
  # strings and the chunker (T2) handles overflow into multi-message posts.
  local long; long=$(printf '%.0sX' {1..4000})
  run "$ATMUX_BIN" decisions add "$long" --default "yes"
  [ "$status" -eq 0 ]
  [ -f .atmux/decisions.md ]
  grep -q "^### d-" .atmux/decisions.md
}

@test "decisions: add accepts long default (E2/S10 — caps dropped)" {
  local long; long=$(printf '%.0sY' {1..4000})
  run "$ATMUX_BIN" decisions add "Use pg-15?" --default "$long"
  [ "$status" -eq 0 ]
}

@test "decisions: add accepts question + default at the 200-char boundary (E2/S9)" {
  local two_hundred; two_hundred=$(printf '%.0sZ' {1..200})
  run "$ATMUX_BIN" decisions add "$two_hundred" --default "$two_hundred"
  [ "$status" -eq 0 ]
}

@test "decisions: add accepts long --note (E2/S10 — note cap dropped, chunker handles overflow)" {
  # Pre-S10 the note cap was 500 chars (S9 lifted from 60). T1 of S10
  # drops it entirely; the chunker spreads long notes across multiple
  # Discord posts or drops them per S9 keep-order under the 5-chunk
  # ceiling.
  local long; long=$(printf '%.0sN' {1..8000})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$long"
  [ "$status" -eq 0 ]
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
  "$ATMUX_BIN" decisions add "Q2?" --default "A2" --reversibility medium --context "Q2 ctx" >/dev/null
  run "$ATMUX_BIN" decisions list --json
  [ "$status" -eq 0 ]
  # Two entries, sorted DESC by timestamp (Q2 added second → first in output).
  run jq -r 'length' <<<"$output"
  [ "$output" = "2" ]
}

@test "decisions: list --reversibility filters" {
  "$ATMUX_BIN" decisions add "Q-low?"  --default "A1" --reversibility low    >/dev/null
  "$ATMUX_BIN" decisions add "Q-high?" --default "A2" --reversibility high   --context "Q-high ctx" >/dev/null
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
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "ship now?" --default "yes" --reversibility high --context "ship-now ctx"
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
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "named?" --default "y" --reversibility high --context "named ctx" >/dev/null
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

@test "decisions: reversibility=high maps to 🔴 in payload (low gated silent)" {
  # Post-E6/S1 (t-d0750a1b): high + medium both trigger the rich ping;
  # low stays whip-batched. This test focuses on the high → 🔴 mapping;
  # low/medium gate behaviour is asserted in decisions_gating.bats.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "low one?"  --default "a" --reversibility low >/dev/null
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "high one?" --default "a" --reversibility high --context "high ctx" >/dev/null
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
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "nonote?" --default "y" --reversibility high --context "nonote ctx" >/dev/null
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

@test "decisions: --context accepts long values (E2/S10 — cap dropped)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local big; big=$(printf '%.0sC' {1..2000})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --context "$big"
  [ "$status" -eq 0 ]
}

@test "decisions: --impact accepts long values (E2/S10 — cap dropped)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local big; big=$(printf '%.0sI' {1..2000})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --impact "$big"
  [ "$status" -eq 0 ]
}

@test "decisions: --decided-by accepts long values (E2/S10 — cap dropped)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  local big; big=$(printf '%.0sD' {1..500})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --decided-by "$big"
  [ "$status" -eq 0 ]
}

@test "decisions: --option per-entry cap dropped (E2/S10); 5-occurrence structural cap retained" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  # Per-entry byte cap removed by T1 (lib/decisions.sh).
  local big; big=$(printf '%.0so' {1..600})
  run "$ATMUX_BIN" decisions add "q?" --default "y" --option "$big"
  [ "$status" -eq 0 ]
  # Five entries at the 5-occurrence structural cap → accepted (UX shape limit, not byte cap).
  run "$ATMUX_BIN" decisions add "q2?" --default "y" \
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

@test "decisions: render — minimal call (context only) emits required block + 🌐, no 👤/⚖️/💥/📝" {
  # E6/Sd: --context (or --note) is required for high-rev. Use --context
  # as the minimal optional payload; assert the required block + 🌐 fire,
  # but no other optional emoji (👤/⚖️/💥/📝) appear.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "minimal?" --default "yes" --reversibility high --context "minimal ctx" >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "🔵 question: minimal?" ]]
  [[ "$body" =~ "✅ default: yes" ]]
  [[ "$body" =~ "🔴 reversibility: high" ]]
  [[ "$body" =~ "📍 atmux decisions show d-" ]]
  [[ "$body" =~ "🌐 context: minimal ctx" ]]
  [[ ! "$body" =~ "👤 decided-by:" ]]
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
    --default "A" --reversibility high --context "opts ctx" \
    --option "alpha" --option "beta" >/dev/null
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "⚖️ options:" ]]
  [[ "$body" =~ "  - alpha" ]]
  [[ "$body" =~ "  - beta" ]]
  # Bare lines like `alpha` (without `  - ` prefix) must NOT appear — the
  # renderer always indents.
  [[ ! "$body" =~ ^alpha$ ]]
}

# ---------- E2/S10 render path: drop-caps + multi-message split ----------

# Pull every captured curl --data-raw / -d JSON body. Multi-message renders
# emit one curl per chunk → one body per chunk in invocation order.
_curl_all_payloads() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"; pick=0} {
    if (pick) { print; pick=0; next }
    if ($0=="--data-raw" || $0=="-d" || $0=="--data") pick=1
  }' "$f" | jq -r '.content // empty' 2>/dev/null
}

_curl_call_count() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

@test "decisions: 4 capped fields ⇒ ≥2 chunks; chunk1 has required fields; chunks carry [N/M]" {
  # ad23a89 (E9/Sb t-b9dcf15b) added a 400-char per-field cap applied
  # BEFORE chunker assembly — so the pre-Sb "2 × 1500-char fields → 2
  # chunks" pattern collapses into 1 chunk after capping (2 × 400 + req
  # ≈ 1050 chars, well under the 1900-char single-message budget).
  #
  # New trigger: pass 4 capped sections (context/options/impact/note)
  # all just over the cap. Single-message budget (~1900) overflows
  # because 4 × ~415 + req + hdr ≈ 2000; multi-chunk path packs all 4
  # capped sections into chunks[1], yielding 2 chunks total. Each
  # individual capped section still fits a fresh chunk's body_budget
  # (~1820), so none get dropped under the S9 keep-order rule.
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local cap_plus; cap_plus=$(printf '%.0sN' {1..401})
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "spill?" \
    --default "yes" --reversibility high \
    --context "$cap_plus" --option "$cap_plus" --option "$cap_plus" \
    --impact "$cap_plus" --note "$cap_plus" >/dev/null
  local calls; calls=$(_curl_call_count)
  [ "$calls" -ge 2 ]

  local body; body=$(_curl_all_payloads)
  # Chunk 1 must contain the required fields (renderer pinned).
  [[ "$body" =~ "🔵 question: spill?" ]]
  [[ "$body" =~ "default: yes" ]]
  [[ "$body" =~ "reversibility: high" ]]
  # Multi-chunk path: each chunk carries [N/M] header.
  [[ "$body" =~ \[1/$calls\] ]]
  [[ "$body" =~ \[$calls/$calls\] ]]
}

@test "decisions: all-fields-max (~10k total) ⇒ ≤5 chunks; keep-order across overflow" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local fld; fld=$(printf '%.0sX' {1..1700})
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "all-fields?" \
    --default "yes" --reversibility high \
    --decided-by "lead" \
    --context "$fld" --impact "$fld" --note "$fld" \
    --option "$fld" --option "$fld" >/dev/null
  local calls; calls=$(_curl_call_count)
  [ "$calls" -ge 1 ]
  [ "$calls" -le 5 ]
}

@test "decisions: beyond 5-chunk ceiling (~15k) ⇒ truncation marker on last chunk" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local huge; huge=$(printf '%.0sH' {1..3500})
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "huge-body?" \
    --default "yes" --reversibility high \
    --context "$huge" --impact "$huge" --note "$huge" \
    --option "$huge" --option "$huge" >/dev/null

  local calls; calls=$(_curl_call_count)
  [ "$calls" -le 5 ]
  local body; body=$(_curl_all_payloads)
  # Truncation marker fires when at least one optional section was dropped.
  [[ "$body" =~ "atmux decisions show d-" ]]
}

@test "decisions: low-reversibility + long body ⇒ NO ping fired (S8 gate still applies); .md still records full content" {
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local long; long=$(printf '%.0sL' {1..3000})
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "low-rev?" \
    --default "yes" --reversibility low \
    --context "$long" --note "$long" >/dev/null
  # S8 gate: reversibility=low ⇒ no Discord ping.
  [ "$(_curl_call_count)" = "0" ]
  # But the markdown log still captures the full content.
  [ -f .atmux/decisions.md ]
  grep -q "low-rev?" .atmux/decisions.md
  grep -q "^- \*\*context\*\*:" .atmux/decisions.md
  grep -q "^- \*\*note\*\*:" .atmux/decisions.md
}

@test "decisions: long single field stays in chunk1 when it fits; only spillover migrates to chunk N" {
  # Chunk 1 is the required-fields anchor — required content must always
  # land in it. A medium-sized body (~1500 chars context only) should fit
  # in a single chunk with no [N/M] tagging (single-message path).
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  local mid; mid=$(printf '%.0sM' {1..1500})
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "mid-body?" \
    --default "yes" --reversibility high --context "$mid" >/dev/null
  local calls; calls=$(_curl_call_count)
  [ "$calls" = "1" ]
  local body; body=$(_curl_all_payloads)
  ! [[ "$body" =~ \[1/ ]]   # no multi-chunk tag
}
