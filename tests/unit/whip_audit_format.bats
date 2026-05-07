#!/usr/bin/env bats
# Unit tests for _atmux_whip_audit_format (lib/discord.sh) — E14/Sd t-361003b9.
#
# Pure JSON-in / string-out formatter. The existing tests/unit/whip_audit.bats
# covers the whip integration (audit verb stub + dispatch + concatenation).
# This file pins the formatter contract on its own:
#
#   - Routing: D/E/F+ok → Auto-corrected · A/B → Surfaced · C → Refused.
#   - Bullet shape: <emoji> class <X> · <detail>[ · fire|manual: <fix_hint>].
#   - Section labels in bold, blank line between sections.
#   - Empty inputs → empty stdout (per ADR-040 empty-tick discipline).
#   - Sections individually omitted when their bucket is empty.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # shellcheck source=../../lib/common.sh
  . "$ATMUX_LIB_DIR/common.sh"
  # shellcheck source=../../lib/discord.sh
  . "$ATMUX_LIB_DIR/discord.sh"
}

teardown() {
  atmux_teardown_sandbox
}

@test "format: empty findings + empty outcomes → empty body (omit row entirely)" {
  run _atmux_whip_audit_format '[]' '[]'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "format: missing args default to empty arrays → empty body" {
  run _atmux_whip_audit_format
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "format: D + E with matching ok outcomes → only Auto-corrected section" {
  local findings='[
    {"class":"D","team":"a","detail":"window stub-d residue","fix_hint":"tmux rename"},
    {"class":"E","team":"a","detail":"stray /tmp/x","fix_hint":"rmdir /tmp/x"}
  ]'
  local outcomes='[
    {"class":"D","result":"ok","action":"renamed","detail":"window stub-d residue"},
    {"class":"E","result":"ok","action":"reaped","detail":"stray /tmp/x"}
  ]'
  run _atmux_whip_audit_format "$findings" "$outcomes"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "🔧 **Auto-corrected** (low-blast):" ]]
  [[ "$output" =~ "🛠️ class D · window stub-d residue" ]]
  [[ "$output" =~ "🛠️ class E · stray /tmp/x" ]]
  ! [[ "$output" =~ "Surfaced" ]]
  ! [[ "$output" =~ "Refused" ]]
}

@test "format: B finding (no outcome) → Surfaced with 'fire:' suffix" {
  local findings='[{"class":"B","team":"a","detail":"hyphen-form tmpdir","fix_hint":"atmux team repair-rename a"}]'
  run _atmux_whip_audit_format "$findings" '[]'
  [ "$status" -eq 0 ]
  [[ "$output" =~ "⚠️ **Surfaced — driver action**:" ]]
  [[ "$output" =~ "⚠️ class B · hyphen-form tmpdir · fire: atmux team repair-rename a" ]]
  ! [[ "$output" =~ "Auto-corrected" ]]
  ! [[ "$output" =~ "Refused" ]]
}

@test "format: C finding → Refused with 'manual:' suffix" {
  local findings='[{"class":"C","team":"a","detail":"window 11 misplaced","fix_hint":"tmux swap-window"}]'
  run _atmux_whip_audit_format "$findings" '[]'
  [ "$status" -eq 0 ]
  [[ "$output" =~ "🛑 **Refused** (high-blast, manual only):" ]]
  [[ "$output" =~ "🛑 class C · window 11 misplaced · manual: tmux swap-window" ]]
  ! [[ "$output" =~ "Surfaced" ]]
}

@test "format: A finding (medium-blast pane-busy surface) → Surfaced" {
  local findings='[{"class":"A","team":"a","detail":"driver pane busy","fix_hint":"atmux audit --fix --class a"}]'
  run _atmux_whip_audit_format "$findings" '[]'
  [ "$status" -eq 0 ]
  [[ "$output" =~ "⚠️ **Surfaced — driver action**:" ]]
  [[ "$output" =~ "⚠️ class A · driver pane busy · fire: atmux audit --fix --class a" ]]
}

@test "format: D + B + C composite → all three sections, blank line separator" {
  local findings='[
    {"class":"D","team":"a","detail":"stub-d","fix_hint":"hint-d"},
    {"class":"B","team":"a","detail":"stub-b","fix_hint":"hint-b"},
    {"class":"C","team":"a","detail":"stub-c","fix_hint":"hint-c"}
  ]'
  local outcomes='[{"class":"D","result":"ok","action":"renamed","detail":"stub-d"}]'
  run _atmux_whip_audit_format "$findings" "$outcomes"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "🔧 **Auto-corrected**" ]]
  [[ "$output" =~ "⚠️ **Surfaced — driver action**" ]]
  [[ "$output" =~ "🛑 **Refused**" ]]
  [[ "$output" =~ "🛠️ class D · stub-d" ]]
  [[ "$output" =~ "⚠️ class B · stub-b · fire: hint-b" ]]
  [[ "$output" =~ "🛑 class C · stub-c · manual: hint-c" ]]
  # Sections separated by exactly one blank line (\n\n).
  [[ "$output" == *$'\n\n'* ]]
}

@test "format: D finding without matching ok outcome → omitted from Auto-corrected" {
  # Defensive: a D finding with no fix_outcome means the auto-fixer didn't
  # fire (yet) — the formatter must NOT claim it as auto-corrected.
  local findings='[{"class":"D","team":"a","detail":"stub-d","fix_hint":"hint-d"}]'
  run _atmux_whip_audit_format "$findings" '[]'
  [ "$status" -eq 0 ]
  # No section emits because D doesn't route to Surfaced/Refused either.
  [ -z "$output" ]
}

@test "format: only auto-corrected populated → no Surfaced / Refused labels" {
  local findings='[{"class":"D","team":"a","detail":"stub-d","fix_hint":"hint-d"}]'
  local outcomes='[{"class":"D","result":"ok","action":"renamed","detail":"stub-d"}]'
  run _atmux_whip_audit_format "$findings" "$outcomes"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Auto-corrected" ]]
  ! [[ "$output" =~ "Surfaced" ]]
  ! [[ "$output" =~ "Refused" ]]
}

@test "format: jq absent → silent return 0 (defensive — never breaks caller)" {
  # Stub PATH so jq is unreachable; helper must short-circuit.
  local saved_path="$PATH"
  PATH="/dev/null"
  run _atmux_whip_audit_format '[{"class":"D","team":"a","detail":"x","fix_hint":"y"}]' '[]'
  PATH="$saved_path"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
