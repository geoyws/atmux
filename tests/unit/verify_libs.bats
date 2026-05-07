#!/usr/bin/env bats
# Unit tests for `atmux verify-libs` (lib/verify_libs.sh) — E3/S2 / t-d731e7e0.
# Per AC: green when all libs source + every declared atmux::*/_atmux_*
# function resolves; red on syntax error or missing function. doctor.sh
# integrates this as the 'libs:' row.
#
# Strategy: build a sandbox lib dir under BATS_TMPDIR, point ATMUX_LIB_DIR
# at it, and run `main` directly (sourced from the real verify_libs.sh).
# Fault injection = drop a broken .sh into the sandbox lib/.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox

  # Build a sandbox lib dir seeded with a tiny known-good lib that
  # verify-libs can validate without dragging in the entire real tree.
  SBLIB="$ATMUX_TEST_TMP/lib"
  mkdir -p "$SBLIB"
  cat > "$SBLIB/good.sh" <<'EOF'
#!/usr/bin/env bash
atmux::greet() { echo "hi"; }
_atmux_internal_helper() { echo "internal"; }
EOF

  # Source the real verify_libs.sh into THIS shell for direct main() invocation.
  # Order matters: common.sh defines atmux::die / atmux::require which
  # verify_libs.sh references.
  atmux_source_libs
  # shellcheck source=../../lib/verify_libs.sh
  . "$ATMUX_LIB_DIR/verify_libs.sh"
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- AC (a): all-good lib dir → exit 0 + summary ----------

@test "verify-libs: all-good lib dir ⇒ exit 0 + ✅ row + summary" {
  ATMUX_LIB_DIR="$SBLIB" run main
  [ "$status" -eq 0 ]
  [[ "$output" =~ "✅ good.sh" ]]
  [[ "$output" =~ "2 functions" ]]
  [[ "$output" =~ "Summary" ]]
  [[ "$output" =~ "1/1 OK" ]]
}

# ---------- AC (b): syntax-error lib → exit 1 + ❌ ----------

@test "verify-libs: syntax-error lib ⇒ exit 1 + ❌ row + first-line error captured" {
  cat > "$SBLIB/broken.sh" <<'EOF'
#!/usr/bin/env bash
atmux::die_intentional( {  # malformed function declaration
  echo "wrong"
}
EOF
  ATMUX_LIB_DIR="$SBLIB" run main
  [ "$status" -eq 1 ]
  [[ "$output" =~ "❌ broken.sh" ]]
  [[ "$output" =~ "source failed" ]]
  [[ "$output" =~ "Summary" ]]
  [[ "$output" =~ "source-fail" ]]
}

# ---------- AC (c): missing function (sources, but type -t empty) → exit 1 + ⚠️ ----------

@test "verify-libs: declared fn missing post-source ⇒ exit 1 + ⚠️ row" {
  # Lib declares atmux::ghost() syntactically, but the source-time `unset -f`
  # rips the function so type -t resolves empty after sourcing.
  cat > "$SBLIB/missing.sh" <<'EOF'
#!/usr/bin/env bash
atmux::ghost() { echo "I will be unset"; }
unset -f atmux::ghost
EOF
  ATMUX_LIB_DIR="$SBLIB" run main
  [ "$status" -eq 1 ]
  [[ "$output" =~ "⚠️" ]]
  [[ "$output" =~ "missing.sh" ]]
  [[ "$output" =~ "atmux::ghost" ]]
  [[ "$output" =~ "missing-fns" ]]
}

# ---------- AC (d): --json emits valid JSON ----------

@test "verify-libs: --json emits valid JSON with summary + libs[] keys" {
  ATMUX_LIB_DIR="$SBLIB" run main --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.summary.total == 1' >/dev/null
  echo "$output" | jq -e '.summary.ok == 1' >/dev/null
  echo "$output" | jq -e '.libs | length == 1' >/dev/null
  echo "$output" | jq -e '.libs[0].name == "good.sh"' >/dev/null
  echo "$output" | jq -e '.libs[0].status == "OK"' >/dev/null
}

@test "verify-libs: --json on broken lib reflects sourceFail in summary" {
  cat > "$SBLIB/broken.sh" <<'EOF'
this is not valid bash )(
EOF
  ATMUX_LIB_DIR="$SBLIB" run main --json
  [ "$status" -eq 1 ]
  echo "$output" | jq -e '.summary.sourceFail >= 1' >/dev/null
  echo "$output" | jq -e '.libs | map(select(.status == "FAIL")) | length >= 1' >/dev/null
}

# ---------- AC (e): --quiet on green emits nothing (well — no per-lib lines) ----------

@test "verify-libs: --quiet on all-green emits nothing" {
  ATMUX_LIB_DIR="$SBLIB" run main --quiet
  [ "$status" -eq 0 ]
  # Output is empty (or trivially whitespace).
  [ -z "${output//[[:space:]]/}" ]
}

@test "verify-libs: --quiet on red emits first failure + summary" {
  cat > "$SBLIB/bad.sh" <<'EOF'
syntax bad ((
EOF
  ATMUX_LIB_DIR="$SBLIB" run main --quiet
  [ "$status" -eq 1 ]
  [[ "$output" =~ "❌" ]] || [[ "$output" =~ "⚠️" ]]
  [[ "$output" =~ "Summary" ]]
}

# ---------- AC: error on missing/unset ATMUX_LIB_DIR ----------

@test "verify-libs: ATMUX_LIB_DIR unset ⇒ atmux::die" {
  unset ATMUX_LIB_DIR
  run main
  [ "$status" -ne 0 ]
  [[ "$output" =~ "ATMUX_LIB_DIR" ]]
}

@test "verify-libs: unknown flag ⇒ atmux::die" {
  ATMUX_LIB_DIR="$SBLIB" run main --bogus
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown flag" ]]
}

# ---------- AC (f) + (g): doctor integration ----------

@test "doctor: includes 'libs:' row in output (live tree, expect green)" {
  # Doctor runs against the real lib tree. Expect the libs row to surface.
  run "$ATMUX_BIN" doctor
  # doctor exits 0 on full-green, non-zero with ❌ rows; either is acceptable
  # for THIS test — we only verify the libs row appears.
  [[ "$output" =~ "libs" ]]
}

@test "doctor: --json passthrough includes libs section" {
  run "$ATMUX_BIN" doctor --json
  echo "$output" | jq -e '.libs.summary.total > 0' >/dev/null
  echo "$output" | jq -e '.libs.libs | length > 0' >/dev/null
}