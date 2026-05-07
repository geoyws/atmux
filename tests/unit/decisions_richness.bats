#!/usr/bin/env bats
# Unit tests for the rev-gated richness behaviour of the decisions Discord
# renderer (E9/Sb t-b9dcf15b, ADR-020).
#
# Contract under test (lib/decisions.sh::_decisions_render_discord):
#   rev=='high'   → full multi-section render. context / options / impact /
#                   note inlined, multi-chunk if needed, ~400-char per-field
#                   cap. Truncation marker on last chunk if any cap fired.
#   rev=='medium' → COMPACT render. Required block only (question / default /
#                   decided-by / reversibility / 📍 show-pointer / ↪ override).
#                   Optional sections SKIPPED on the wire. decisions.md still
#                   records full fields via _decisions_append.
#   rev=='low'    → no Discord ping fires at all (gate at lib/decisions.sh:279
#                   matches `^(high|medium)$`). Regression-pin.
#
# Curl is shimmed on PATH (same pattern as decisions.bats /
# decisions_gating.bats) so we can recover exact payload bytes without
# touching the network.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_assert_sandbox
  "$ATMUX_BIN" init --name r >/dev/null

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
# mock curl — record argv NUL-delimited for payload recovery.
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"

  # Force plain {content:<body>} payload shape so .content extraction works
  # without unwrapping the ADR-019 embed envelope. Embed-shape coverage
  # already lives in tests/unit/discord_palette.bats.
  export ATMUX_DISCORD_PLAINTEXT=1
  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
}

teardown() {
  atmux_teardown_sandbox
}

# Recover concatenated .content of every captured curl invocation. Multi-
# chunk renders emit one curl per chunk → one body per chunk in invocation
# order; we join them so cross-chunk substring matches work.
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

# ---------- AC1: rev=high + all fields → multi-section, all 4 sec blocks ----------

@test "richness: rev=high + all fields ⇒ ping carries 🌐 ctx + ⚖️ opts + 💥 imp + 📝 note" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "ship?" \
    --default "OAuth" --reversibility high \
    --decided-by "lead" \
    --context "no IdP yet" \
    --option "OAuth" --option "SAML" --option "JWT" \
    --impact "blocks t-aaa1" \
    --note "soak 1 week"
  [ "$status" -eq 0 ]
  [ "$(_curl_call_count)" -ge 1 ]

  local body; body=$(_curl_all_payloads)
  # Required block — chunk 1 is pinned regardless of overflow shape.
  [[ "$body" =~ "🔵 question: ship?" ]]
  [[ "$body" =~ "✅ default: OAuth" ]]
  [[ "$body" =~ "👤 decided-by: lead" ]]
  [[ "$body" =~ "🔴 reversibility: high" ]]
  [[ "$body" =~ "📍 atmux decisions show d-" ]]
  [[ "$body" =~ atmux\ send\ lead.*override ]]
  # All 4 optional sections inlined under high-rev.
  [[ "$body" =~ "🌐 context: no IdP yet" ]]
  [[ "$body" =~ "⚖️ options:" ]]
  [[ "$body" =~ "  - OAuth" ]]
  [[ "$body" =~ "  - SAML" ]]
  [[ "$body" =~ "  - JWT" ]]
  [[ "$body" =~ "💥 impact: blocks t-aaa1" ]]
  [[ "$body" =~ "📝 note: soak 1 week" ]]
}

# ---------- AC2: rev=high + 500-char --context → truncated + marker ----------

@test "richness: rev=high + 500-char --context ⇒ context truncated to 400 chars + ↳ recovery marker" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  # Build a 500-char marker string. After the 400-char cap fires, exactly
  # 400 X's land in the ping; the trailing 100 are dropped + a `↳ atmux
  # decisions show d-... for full` marker is appended once on the last
  # chunk.
  local five_hundred; five_hundred=$(printf '%.0sX' {1..500})
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "trunc?" \
    --default "y" --reversibility high \
    --context "$five_hundred"
  [ "$status" -eq 0 ]
  [ "$(_curl_call_count)" -ge 1 ]

  local body; body=$(_curl_all_payloads)
  # Recovery marker present somewhere in the wire — single chunk OR last
  # chunk depending on body shape; either is correct, so we don't pin
  # `[N/M]`.
  [[ "$body" =~ "↳ atmux decisions show d-" ]]
  [[ "$body" =~ "for full" ]]

  # Pull the rendered context line and verify it carries exactly 400 X's.
  # Line shape: `🌐 context: XXXX...` (cap stops at 400). 500 X's must
  # never appear; 400 X's must.
  local four_hundred; four_hundred=$(printf '%.0sX' {1..400})
  [[ "$body" =~ "🌐 context: $four_hundred" ]]
  [[ ! "$body" =~ "$five_hundred" ]]
}

# ---------- AC3: rev=medium + all fields → compact, optional secs absent ----------

@test "richness: rev=medium + all fields ⇒ COMPACT ping (no 🌐/⚖️/💥/📝); req block intact" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "tweak?" \
    --default "B" --reversibility medium \
    --decided-by "lead" \
    --context "narrow scope" \
    --option "A" --option "B" --option "C" \
    --impact "no migration" \
    --note "soak 24h"
  [ "$status" -eq 0 ]
  # Compact mode is single-chunk — exactly one curl call regardless of
  # how many optional fields were passed.
  [ "$(_curl_call_count)" = "1" ]

  local body; body=$(_curl_all_payloads)
  # Required block present.
  [[ "$body" =~ "🔵 question: tweak?" ]]
  [[ "$body" =~ "✅ default: B" ]]
  [[ "$body" =~ "👤 decided-by: lead" ]]
  [[ "$body" =~ "🟡 reversibility: medium" ]]
  [[ "$body" =~ "📍 atmux decisions show d-" ]]
  [[ "$body" =~ atmux\ send\ lead.*override ]]
  # Optional sections SKIPPED on the wire — show-pointer is the recovery
  # surface for compact-mode pings.
  [[ ! "$body" =~ "🌐 context:" ]]
  [[ ! "$body" =~ "⚖️ options:" ]]
  [[ ! "$body" =~ "💥 impact:" ]]
  [[ ! "$body" =~ "📝 note:" ]]
  # And the option values themselves must not leak via the bullet shape.
  [[ ! "$body" =~ "  - A" ]]
  [[ ! "$body" =~ "  - B" ]]
  [[ ! "$body" =~ "  - C" ]]
  # Compact path emits no [N/M] tag — single message.
  [[ ! "$body" =~ \[1/ ]]
}

# ---------- AC4: rev=low → no Discord ping (regression pin on S8 gate) ----------

@test "richness: rev=low ⇒ NO ping fires (gate-level skip; regression pin)" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "tiny?" \
    --default "ok" --reversibility low
  [ "$status" -eq 0 ]
  # Gate at lib/decisions.sh:279 (`^(high|medium)$`) skips low entirely —
  # mock curl tmpfile must never have been created.
  [ "$(_curl_call_count)" = "0" ]
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]
  # decisions.md still records the entry — gate is on the ping path only.
  grep -q "tiny?" .atmux/decisions.md
  grep -q "reversibility.*low" .atmux/decisions.md
}

# ---------- AC5: medium-rev compact ping ⇒ decisions.md still has full fields ----------

@test "richness: rev=medium compact ping ⇒ decisions.md persists ALL fields (ping/disk asymmetry)" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "auth?" \
    --default "OAuth" --reversibility medium \
    --decided-by "lead" \
    --context "team has no IdP yet" \
    --option "OAuth" --option "SAML" --option "JWT" \
    --impact "blocks t-aaa1" \
    --note "revisit post-launch"
  [ "$status" -eq 0 ]

  # Ping was compact — confirms the asymmetry actually happened.
  local body; body=$(_curl_all_payloads)
  [[ ! "$body" =~ "🌐 context:" ]]
  [[ ! "$body" =~ "💥 impact:" ]]

  # decisions.md recorded the FULL set of fields — _decisions_append is
  # rev-agnostic. show-pointer is the recovery surface; this asserts the
  # surface still has the data.
  [ -f .atmux/decisions.md ]
  grep -q "^- \*\*context\*\*: team has no IdP yet$"  .atmux/decisions.md
  grep -q "^- \*\*options\*\*:$"                       .atmux/decisions.md
  grep -q "^  - OAuth$"                                .atmux/decisions.md
  grep -q "^  - SAML$"                                 .atmux/decisions.md
  grep -q "^  - JWT$"                                  .atmux/decisions.md
  grep -q "^- \*\*impact\*\*: blocks t-aaa1$"          .atmux/decisions.md
  grep -q "^- \*\*decided-by\*\*: lead$"               .atmux/decisions.md
  grep -q "^- \*\*note\*\*: revisit post-launch$"      .atmux/decisions.md

  # And `decisions show <id>` recovers them too — the documented driver-
  # side recovery path when the compact ping leaves them off the wire.
  local id; id=$("$ATMUX_BIN" decisions list --json | jq -r '.[0].id')
  [[ "$id" =~ ^d-[0-9a-f]{8}$ ]]
  run "$ATMUX_BIN" decisions show "$id"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "team has no IdP yet" ]]
  [[ "$output" =~ "OAuth" ]]
  [[ "$output" =~ "SAML" ]]
  [[ "$output" =~ "JWT" ]]
  [[ "$output" =~ "blocks t-aaa1" ]]
  [[ "$output" =~ "revisit post-launch" ]]
}
