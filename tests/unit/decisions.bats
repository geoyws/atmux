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

@test "decisions: add ERRORS when question exceeds 60 chars (no silent truncation)" {
  # Reviewer flag on ADR-008: prefer error over truncation so context isn't
  # silently dropped from the Discord ping.
  local long; long=$(printf '%.0sX' {1..61})
  run "$ATMUX_BIN" decisions add "$long" --default "yes"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "exceeds 60 chars" ]]
  [[ "$output" =~ "Discord ≤80 budget" ]]
  [ ! -f .atmux/decisions.md ]
}

@test "decisions: add ERRORS when default exceeds 60 chars (no silent truncation)" {
  local long; long=$(printf '%.0sY' {1..61})
  run "$ATMUX_BIN" decisions add "Use pg-15?" --default "$long"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "exceeds 60 chars" ]]
}

@test "decisions: add accepts question + default at the 60-char boundary" {
  local sixty; sixty=$(printf '%.0sZ' {1..60})
  run "$ATMUX_BIN" decisions add "$sixty" --default "$sixty"
  [ "$status" -eq 0 ]
}

@test "decisions: add ERRORS when --note exceeds 60 chars (review-followup t-47361a6c)" {
  # Per ADR-008 reviewer-flag pattern: note bullet was previously soft-truncated
  # at 80 chars, then prefixed with '📝 note: ' (~9 chars) → bullet up to 89 chars,
  # violating ≤80-char Discord template. Switched to ERROR-not-truncate at 60
  # for consistency with question/default validators.
  local long; long=$(printf '%.0sN' {1..61})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$long"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "note exceeds 60 chars" ]]
  [[ "$output" =~ "Discord ≤80 budget" ]]
}

@test "decisions: add accepts --note at the 60-char boundary" {
  local sixty; sixty=$(printf '%.0sN' {1..60})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$sixty"
  [ "$status" -eq 0 ]
}

@test "decisions: --note=80 chars (the AC's repro case) ⇒ rejected, not truncated" {
  # Repro from t-47361a6c: pre-fix, an 80-char note + '📝 note: ' prefix
  # rendered an 89-char bullet. Post-fix, the validator stops it at the door.
  local eighty; eighty=$(printf '%.0sN' {1..80})
  run "$ATMUX_BIN" decisions add "Q?" --default "y" --note "$eighty"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "note exceeds 60 chars" ]]
  # Log file should not have been written — validation happens before the
  # mutex-protected append.
  [ ! -f .atmux/decisions.md ]
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
  [[ "$body" =~ "🔵 ship now?" ]]
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
