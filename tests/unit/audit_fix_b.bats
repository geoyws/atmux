#!/usr/bin/env bats
# Unit tests for class B fixer in lib/audit.sh — t-9b197c0f (E14/Sg).
#
# Class B = team.json:.tmuxTmpdir uses the legacy hyphen form
# (`/tmp/atmux-tmux-<team>`) instead of the canonical underscore form
# (`/tmp/atmux_tmux_<team>`). Migration is high-blast: an in-flight cage
# tmpdir mv-while-panes-are-running needs the `atmux team repair-rename`
# verb's atomic flow with rollback. Hard rules per ADR-038 §gating:
#
#   - Detect-only emits the finding with `auto_fixable: false`.
#   - --fix --class b WITHOUT `ATMUX_AUDIT_DRIVER_FIRED=YES` → main()
#     refuses + dies before reaching the dispatcher.
#   - --fix --class b WITH `ATMUX_AUDIT_DRIVER_FIRED=YES` → invokes
#     `atmux team repair-rename <team>` per drifted team.
#   - --dry-run prints the would-fire plan, no repair-rename invocation.
#   - whip auto-pass NEVER auto-fires (verified at the whip layer in
#     tests/unit/whip_audit.bats; here we only assert that the audit
#     finding's `fix_hint` carries the ready-to-fire command shape so
#     the whip ⚠️ Surfaced bullet has actionable copy).
#
# `_atmux_audit_invoke_repair_rename` is the test-facing stub seam — the
# real impl shells out to `bin/atmux team repair-rename` which would
# require a live cage tmpdir + tmux server + flock-coordinated mv. The
# fixer dispatches through this indirection so we can assert the verb
# is/isn't invoked at the right moment without spinning up real state.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
  atmux_assert_sandbox
  # Plant the hyphen-form tmuxTmpdir that class B's detector targets.
  jq '.tmuxTmpdir = "/tmp/atmux-tmux-a"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  unset ATMUX_AUDIT_DRIVER_FIRED   # tests opt in explicitly
}

teardown() {
  atmux_teardown_sandbox
}

_source_audit() {
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/audit.sh
  . "$ATMUX_LIB_DIR/audit.sh"
  _atmux_audit_findings=()
}

# ---- 1. detect-only — auto_fixable=false in the JSON output ----------

@test "audit class B detect-only: hyphen-form tmuxTmpdir emits finding with auto_fixable=false" {
  run "$ATMUX_BIN" audit --json
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]   # 1 if other classes also drift; either is fine
  # Find the B row in the JSON array — the test sandbox might have
  # other class findings (E from /tmp leftovers), so filter not assume.
  local b; b=$(jq '[.[] | select(.class == "B")]' <<<"$output")
  [ "$(jq 'length' <<<"$b")" = "1" ]
  [ "$(jq -r '.[0].auto_fixable' <<<"$b")" = "false" ]
  [ "$(jq -r '.[0].blast_radius' <<<"$b")" = "high" ]
  [ "$(jq -r '.[0].severity' <<<"$b")" = "high" ]
  [ "$(jq -r '.[0].team' <<<"$b")" = "a" ]
  [[ "$(jq -r '.[0].detail' <<<"$b")" =~ "hyphen-form" ]]
  [[ "$(jq -r '.[0].fix_hint' <<<"$b")" =~ "atmux team repair-rename a" ]]
}

@test "audit class B detect-only: canonical underscore-form tmuxTmpdir emits zero findings" {
  jq '.tmuxTmpdir = "/tmp/atmux_tmux_a"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" audit --json
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
  [ "$(jq '[.[] | select(.class == "B")] | length' <<<"$output")" = "0" ]
}

# ---- 2. --fix --class b without env opt-in → REFUSED at main parser --

@test "audit --fix --class b without ATMUX_AUDIT_DRIVER_FIRED → main parser dies (ADR-038 §gating)" {
  run "$ATMUX_BIN" audit --fix --class b
  [ "$status" -ne 0 ]
  [[ "$output" =~ "high-blast" ]]
  [[ "$output" =~ "ATMUX_AUDIT_DRIVER_FIRED=YES" ]]
  [[ "$output" =~ "driver authorization" ]]
}

@test "audit class B fixer: re-entry guard refuses when env var unset (defense-in-depth)" {
  # The function-level re-check (lib/audit.sh:598-601) protects against
  # direct callers bypassing main()'s flag-parser via the dispatch_action
  # path — fleet walkers / future cron paths could otherwise sneak past.
  _source_audit
  unset ATMUX_AUDIT_DRIVER_FIRED
  local f
  f=$(jq -nc '{class:"B", severity:"high", team:"a",
               detail:"hyphen-form", fix_hint:"atmux team repair-rename a",
               auto_fixable:false, blast_radius:"high"}')
  run _atmux_audit_class_b_fix "$f"
  [ "$status" -eq 1 ]   # function returns 1 on the env-gate skip
  [ -f "$ATMUX_DIR/logs/audit-fix.log" ]
  grep -q 'class=B result=skip' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'ATMUX_AUDIT_DRIVER_FIRED=YES not set' "$ATMUX_DIR/logs/audit-fix.log"
}

# ---- 3. --fix --class b with env opt-in → invokes repair-rename ------

@test "audit --fix --class b with ATMUX_AUDIT_DRIVER_FIRED=YES → calls _atmux_audit_invoke_repair_rename for drifted team" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES

  # Stub the repair-rename invocation seam so the fixer doesn't actually
  # mv a live cage tmpdir. Capture the team arg + return ok.
  local stub_record="$ATMUX_TEST_TMP/repair-rename-invocations.txt"
  : > "$stub_record"
  _atmux_audit_invoke_repair_rename() {
    printf 'invoked team=%s\n' "$1" >> "$stub_record"
    return 0
  }

  local f
  f=$(jq -nc '{class:"B", severity:"high", team:"a",
               detail:"hyphen-form '\''/tmp/atmux-tmux-a'\''",
               fix_hint:"atmux team repair-rename a",
               auto_fixable:false, blast_radius:"high"}')
  _atmux_audit_dry_run=0
  run _atmux_audit_class_b_fix "$f"
  [ "$status" -eq 0 ]
  [ -s "$stub_record" ]
  grep -q 'invoked team=a' "$stub_record"
  grep -q 'class=B result=ok' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'repair-rename a succeeded' "$ATMUX_DIR/logs/audit-fix.log"
}

@test "audit --fix --class b: repair-rename failure → result=fail row with first stderr line" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES

  # Stub returns rc=2 with multi-line stderr; fixer should capture the
  # first line into audit-fix.log and surface as fail.
  _atmux_audit_invoke_repair_rename() {
    printf 'cage tmpdir is occupied\nstack trace line 2\nfinal line 3\n' >&2
    return 2
  }

  local f
  f=$(jq -nc '{class:"B", severity:"high", team:"a",
               detail:"hyphen-form", fix_hint:"atmux team repair-rename a",
               auto_fixable:false, blast_radius:"high"}')
  _atmux_audit_dry_run=0
  run _atmux_audit_class_b_fix "$f"
  [ "$status" -eq 1 ]
  grep -q 'class=B result=fail' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'rc=2' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'cage tmpdir is occupied' "$ATMUX_DIR/logs/audit-fix.log"
  # Multi-line stderr truncated to the first useful pointer.
  ! grep -q 'stack trace line 2' "$ATMUX_DIR/logs/audit-fix.log"
}

# ---- 4. --dry-run path — plan emitted, no invocation -----------------

@test "audit --fix --class b --dry-run → logs would-invoke, NO repair-rename call" {
  _source_audit
  export ATMUX_AUDIT_DRIVER_FIRED=YES

  local stub_record="$ATMUX_TEST_TMP/repair-rename-invocations.txt"
  : > "$stub_record"
  _atmux_audit_invoke_repair_rename() {
    printf 'SHOULD NOT BE CALLED team=%s\n' "$1" >> "$stub_record"
    return 0
  }

  local f
  f=$(jq -nc '{class:"B", severity:"high", team:"a",
               detail:"hyphen-form", fix_hint:"atmux team repair-rename a",
               auto_fixable:false, blast_radius:"high"}')
  _atmux_audit_dry_run=1
  run _atmux_audit_class_b_fix "$f"
  [ "$status" -eq 0 ]
  # Stub never fired — dry-run short-circuits before the invoke call.
  [ ! -s "$stub_record" ]
  grep -q 'class=B result=dry-run' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'would invoke' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'atmux team repair-rename a' "$ATMUX_DIR/logs/audit-fix.log"
  grep -q 'atomic mv' "$ATMUX_DIR/logs/audit-fix.log"
}

@test "audit --dry-run --class b at verb level → exit 0 (dry-run OR detect emits same array semantics)" {
  # Verb-surface smoke — dry-run alone (without --fix) is documented as
  # equivalent to detect for the print/return-code behavior; the actual
  # fixer invocation is gated on --fix. We assert the verb doesn't
  # error-exit and that no repair-rename was triggered as a side-effect.
  run "$ATMUX_BIN" audit --dry-run --class b
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
  # No mention of "would invoke" because --fix wasn't passed; the verb
  # ran in detect-only mode despite --dry-run being present.
  ! [[ "$output" =~ "would invoke" ]]
}

# ---- 5. fix_hint shape (whip ⚠️ Surfaced cross-test) ------------------

@test "audit class B finding: fix_hint is the ready-to-fire repair-rename invocation (whip ⚠️ Surfaced copy)" {
  # Cross-test note: the whip layer (tests/unit/whip_audit.bats) verifies
  # that B-class findings land in the Surfaced section with copy
  # `class B · <detail> · fire: <fix_hint>`. The "fire:" payload here
  # MUST be a copy-pasteable command — operators paste it into the
  # driver shell after eyeballing. This test pins the format.
  _source_audit
  _atmux_audit_class_b_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  local hint
  hint=$(jq -r '.fix_hint' <<<"${_atmux_audit_findings[0]}")
  [[ "$hint" =~ ^atmux\ team\ repair-rename\ a ]]
  [[ "$hint" =~ "atomic mv" ]]
  [[ "$hint" =~ "session/window rename" ]]
  [[ "$hint" =~ "cron rewrite" ]]
}
