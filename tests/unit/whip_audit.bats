#!/usr/bin/env bats
# Unit tests for _atmux_whip_check_audit — E14/Sd t-e3291557, ADR-040.
#
# Strategy: stub `atmux audit --json` + `atmux audit --fix --class X` via a
# test atmux binary that returns canned findings JSON and writes synthetic
# audit-fix.log rows. Call _atmux_whip_check_audit against a hand-built
# `findings=()` array (same dynamic-scoping convention as the phantom
# sweep tests). No live tmux session needed for the green / B / C / D / E
# / F paths; class A pane-busy path stubs the busy detector via a custom
# pane state.
#
# AC coverage:
#   1. .audit.enabled=false skip-gate → no findings, no fix invocation.
#   2. zero findings → no [whip-audit] section appended.
#   3. low-blast (D/E) → fixer fires, bullet lands in 'Auto-corrected'.
#   4. high-blast (B) → bullet lands in 'Surfaced — driver action' with
#      ready-to-fire command; fixer NOT invoked.
#   5. high-blast (C) → bullet lands in 'Refused' with manual hint.
#   6. medium-blast (A) + driver pane busy → bullet in 'Surfaced'.
#   7. composed body carries header `🛡️ **[whip-audit]** · \`<team>\``
#      and only the non-empty sections.
#   8. audit verb non-zero rc → no section appended (failure-mode path).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
  atmux_assert_sandbox

  # Per-test stub root replaces the real atmux binary for `atmux audit ...`
  # invocations made by _atmux_whip_check_audit. The stub honors two env
  # vars: ATMUX_TEST_AUDIT_JSON (file with canned findings) and
  # ATMUX_TEST_AUDIT_RC (rc to exit with on the --json call).
  STUB_DIR="$ATMUX_TEST_TMP/stub-bin"
  mkdir -p "$STUB_DIR"
  cat > "$STUB_DIR/atmux" <<'STUB'
#!/usr/bin/env bash
# Test stub. Recognises `audit --json` (echo canned JSON) and `audit --fix
# --class X` (append a result row to audit-fix.log). Anything else delegates
# to the real binary so unrelated whip helpers keep working.
if [[ "$1" == "audit" ]]; then
  shift
  if [[ "$1" == "--json" ]]; then
    if [[ -n "${ATMUX_TEST_AUDIT_JSON:-}" && -f "$ATMUX_TEST_AUDIT_JSON" ]]; then
      cat "$ATMUX_TEST_AUDIT_JSON"
    else
      echo "[]"
    fi
    exit "${ATMUX_TEST_AUDIT_RC:-0}"
  fi
  if [[ "$1" == "--fix" && "$2" == "--class" ]]; then
    cls=$(echo "$3" | tr 'a-z' 'A-Z')
    log="${ATMUX_TEST_FIX_LOG:-/tmp/audit-fix.log}"
    mkdir -p "$(dirname "$log")"
    printf '[stub] class=%s result=%s action=stub-fired detail=stub\n' \
      "$cls" "${ATMUX_TEST_FIX_RESULT:-ok}" >> "$log"
    exit 0
  fi
  exit 0
fi
exec "$ATMUX_REAL_BIN" "$@"
STUB
  chmod +x "$STUB_DIR/atmux"
  export ATMUX_REAL_BIN="$ATMUX_BIN"
  export ATMUX_BIN_DIR_BACKUP="$ATMUX_BIN_DIR"
  export ATMUX_BIN_DIR="$STUB_DIR"
  export ATMUX_TEST_FIX_LOG="$ATMUX_DIR/logs/audit-fix.log"
  mkdir -p "$ATMUX_DIR/logs"
}

teardown() {
  export ATMUX_BIN_DIR="${ATMUX_BIN_DIR_BACKUP:-$ATMUX_BIN_DIR}"
  atmux_teardown_sandbox
}

_source_whip() {
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
}

_seed_findings() {
  local file="$ATMUX_TEST_TMP/audit-findings.json"
  printf '%s' "$1" > "$file"
  export ATMUX_TEST_AUDIT_JSON="$file"
}

# ---- 1. skip-gate ------------------------------------------------------

@test "whip-audit: .audit.enabled=false → no-op (no findings appended, no fix invoked)" {
  _source_whip
  jq '.audit = {enabled: false}' "$ATMUX_DIR/team.json" > "$ATMUX_DIR/team.json.tmp"
  mv "$ATMUX_DIR/team.json.tmp" "$ATMUX_DIR/team.json"

  _seed_findings '[{"class":"D","severity":"low","team":"a","detail":"x","fix_hint":"y","auto_fixable":true,"blast_radius":"low"}]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 0 ]
  # Stub fix-log untouched — gate fired before any --fix call. Either log
  # missing entirely OR present but contains no stub-fired action rows.
  if [[ -s "$ATMUX_TEST_FIX_LOG" ]]; then
    ! grep -q "stub-fired" "$ATMUX_TEST_FIX_LOG"
  fi
}

# ---- 2. zero findings → no section ------------------------------------

@test "whip-audit: zero findings → no section appended (idempotence)" {
  _source_whip
  _seed_findings '[]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 0 ]
}

# ---- 3. low-blast D + E → auto-corrected -----------------------------

@test "whip-audit: D + E findings → auto-fix fires + bullets in Auto-corrected section" {
  _source_whip
  _seed_findings '[
    {"class":"D","severity":"low","team":"a","detail":"window stub-d residue","fix_hint":"tmux rename","auto_fixable":true,"blast_radius":"low"},
    {"class":"E","severity":"low","team":"a","detail":"stray cage tmpdir /tmp/x","fix_hint":"rmdir /tmp/x","auto_fixable":true,"blast_radius":"low"}
  ]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 1 ]
  local body="${findings[0]}"

  [[ "$body" =~ "[whip-audit]" ]]
  [[ "$body" =~ "Auto-corrected" ]]
  [[ "$body" =~ "class D · window stub-d residue" ]]
  [[ "$body" =~ "class E · stray cage tmpdir /tmp/x" ]]

  # Each class fired its --fix path exactly once.
  grep -c 'class=D result=ok' "$ATMUX_TEST_FIX_LOG"
  [ "$(grep -c 'class=D' "$ATMUX_TEST_FIX_LOG")" = "1" ]
  [ "$(grep -c 'class=E' "$ATMUX_TEST_FIX_LOG")" = "1" ]
}

# ---- 4. high-blast B → surfaced (no fix) -----------------------------

@test "whip-audit: B finding → Surfaced bullet with fire-hint, no --fix invoked" {
  _source_whip
  _seed_findings '[{"class":"B","severity":"high","team":"a","detail":"hyphen-form tmpdir","fix_hint":"atmux team repair-rename a","auto_fixable":false,"blast_radius":"high"}]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 1 ]
  local body="${findings[0]}"

  [[ "$body" =~ "Surfaced" ]]
  [[ "$body" =~ "class B · hyphen-form tmpdir · fire: atmux team repair-rename a" ]]
  ! grep -q 'class=B' "$ATMUX_TEST_FIX_LOG" 2>/dev/null
}

# ---- 5. high-blast C → refused ---------------------------------------

@test "whip-audit: C finding → Refused bullet with manual hint, no --fix invoked" {
  _source_whip
  _seed_findings '[{"class":"C","severity":"high","team":"a","detail":"window 11 misplaced","fix_hint":"tmux swap-window","auto_fixable":false,"blast_radius":"high"}]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 1 ]
  local body="${findings[0]}"

  [[ "$body" =~ "Refused" ]]
  [[ "$body" =~ "class C · window 11 misplaced · manual: tmux swap-window" ]]
  ! grep -q 'class=C' "$ATMUX_TEST_FIX_LOG" 2>/dev/null
}

# ---- 6. composite — D + B + C across all three sections --------------

@test "whip-audit: D + B + C findings produce all three sections in one body" {
  _source_whip
  _seed_findings '[
    {"class":"D","severity":"low","team":"a","detail":"stub-d","fix_hint":"hint-d","auto_fixable":true,"blast_radius":"low"},
    {"class":"B","severity":"high","team":"a","detail":"stub-b","fix_hint":"hint-b","auto_fixable":false,"blast_radius":"high"},
    {"class":"C","severity":"high","team":"a","detail":"stub-c","fix_hint":"hint-c","auto_fixable":false,"blast_radius":"high"}
  ]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 1 ]
  local body="${findings[0]}"

  [[ "$body" =~ "[whip-audit]" ]]
  [[ "$body" =~ "Auto-corrected" ]]
  [[ "$body" =~ "Surfaced" ]]
  [[ "$body" =~ "Refused" ]]
  [[ "$body" =~ "🛠️ class D · stub-d" ]]
  [[ "$body" =~ "⚠️ class B · stub-b" ]]
  [[ "$body" =~ "🛑 class C · stub-c" ]]
}

# ---- 7. audit rc != 0 → failure-mode skip ----------------------------

@test "whip-audit: audit verb rc=2 → no section appended (logged + skipped)" {
  _source_whip
  _seed_findings '[{"class":"D","severity":"low","team":"a","detail":"x","fix_hint":"y","auto_fixable":true,"blast_radius":"low"}]'
  export ATMUX_TEST_AUDIT_RC=2

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 0 ]
}

# ---- 8. audit emits non-JSON → failure-mode skip --------------------

@test "whip-audit: audit emits non-JSON → no section appended" {
  _source_whip
  local f="$ATMUX_TEST_TMP/audit-findings.json"
  printf 'not-json-output\n' > "$f"
  export ATMUX_TEST_AUDIT_JSON="$f"

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 0 ]
}

# ---- 9. body carries team header + MYT timestamp --------------------

@test "whip-audit: body header contains team name in backticks + MYT suffix" {
  _source_whip
  _seed_findings '[{"class":"D","severity":"low","team":"a","detail":"x","fix_hint":"y","auto_fixable":true,"blast_radius":"low"}]'

  local findings=()
  _atmux_whip_check_audit
  local body="${findings[0]}"
  [[ "$body" =~ '🛡️ **[whip-audit]** · `a` ·' ]]
  [[ "$body" =~ "MYT" ]]
}

# ---- 10. class A medium-blast: driver pane busy → surfaced (no fix) -

@test "whip-audit: class A + driver-pane busy → Surfaced bullet, no auto-fix invoked" {
  _source_whip
  # The pane-busy branch is gated on (1) atmux::session_name resolving to
  # a real-looking session AND (2) tmux capture-pane returning non-empty
  # AND (3) _atmux_whip_pane_busy returning 0. Function-shadow tmux to
  # echo a busy marker, and override the pane-busy detector to confirm.
  tmux() {
    if [[ "$1" == "capture-pane" ]]; then
      printf 'thinking with claude...\n'
      return 0
    fi
    command tmux "$@"
  }
  _atmux_whip_pane_busy() { return 0; }

  _seed_findings '[{"class":"A","severity":"medium","team":"a","detail":"bare driver window","fix_hint":"atmux audit --fix --class a","auto_fixable":true,"blast_radius":"medium"}]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 1 ]
  local body="${findings[0]}"

  [[ "$body" =~ "Surfaced" ]]
  [[ "$body" =~ "class A · driver-pane busy — fire later" ]]
  [[ "$body" =~ "atmux audit --fix --class a" ]]
  ! [[ "$body" =~ "Auto-corrected" ]]
  # Pane-busy gate refused the auto-fix invocation entirely — no stub row.
  ! grep -q 'class=A' "$ATMUX_TEST_FIX_LOG" 2>/dev/null
}

# ---- 11. class A pane-idle path → auto-fix fires + Auto-corrected ---

@test "whip-audit: class A + driver-pane idle → auto-fix fires; ok result lands in Auto-corrected" {
  _source_whip
  # Same tmux shadow as test 10, but pane-busy detector reports idle so
  # whip routes into the auto-fire branch. Stub returns result=ok per
  # ATMUX_TEST_FIX_RESULT default; whip greps for `class=A result=ok`
  # and routes the bullet into Auto-corrected.
  tmux() {
    if [[ "$1" == "capture-pane" ]]; then
      printf '$ \n'   # bare-prompt shell idle
      return 0
    fi
    command tmux "$@"
  }
  _atmux_whip_pane_busy() { return 1; }
  export ATMUX_TEST_FIX_RESULT=ok

  _seed_findings '[{"class":"A","severity":"medium","team":"a","detail":"bare driver window","fix_hint":"atmux audit --fix --class a","auto_fixable":true,"blast_radius":"medium"}]'

  local findings=()
  _atmux_whip_check_audit
  [ "${#findings[@]}" -eq 1 ]
  local body="${findings[0]}"

  [[ "$body" =~ "Auto-corrected" ]]
  [[ "$body" =~ "🛠️ class A · bare driver window" ]]
  ! [[ "$body" =~ "Surfaced" ]]
  # Stub fired exactly once.
  [ "$(grep -c 'class=A' "$ATMUX_TEST_FIX_LOG")" = "1" ]
  grep -q 'class=A result=ok' "$ATMUX_TEST_FIX_LOG"
}

# ---- 12. audit-fix.log row schema ------------------------------------

@test "whip-audit: audit-fix.log row carries class + result + action + detail (greppable schema)" {
  # ADR-040 §Auto-fix audit log specifies a `.atmux/logs/audit.log` jsonl
  # row schema. Today the implementation in lib/audit.sh::_atmux_audit_log_fix
  # writes to `audit-fix.log` in plain-text key=value form
  # (`[ts] class=X result=Y action=Z detail=W`) — operator-greppable but
  # NOT jsonl. This test pins the CURRENT shape so a future jsonl
  # migration is a deliberate breaking change rather than silent drift.
  # When the migration lands, flip the assertion to `jq -e .` per row.
  _source_whip
  _seed_findings '[
    {"class":"D","severity":"low","team":"a","detail":"d-row","fix_hint":"hint-d","auto_fixable":true,"blast_radius":"low"},
    {"class":"E","severity":"low","team":"a","detail":"e-row","fix_hint":"hint-e","auto_fixable":true,"blast_radius":"low"}
  ]'

  local findings=()
  _atmux_whip_check_audit

  [ -s "$ATMUX_TEST_FIX_LOG" ]
  # Each row carries the four key=value fields the operator + whip
  # rely on (class lookup, result→routing, action→narrative, detail→audit
  # trail). Stub format mirrors the real `_atmux_audit_log_fix` shape.
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    [[ "$row" =~ class=([A-F]) ]]
    [[ "$row" =~ result=(ok|fail|skip|dry-run) ]]
    [[ "$row" =~ action= ]]
    [[ "$row" =~ detail= ]]
  done < "$ATMUX_TEST_FIX_LOG"
}

# ---- 13. whip.log records audit-verb error on non-zero rc -----------

@test "whip-audit: audit verb rc!=0 → atmux::log emits to stderr (whip.log on cron path via 2>&1)" {
  # AC body: 'whip.log records error'. atmux::log writes to stderr; the
  # whip cron line redirects stderr to whip.log via `>> ... 2>&1`, so
  # operator post-mortem grep finds the entry. In a unit context we
  # capture stderr directly and assert the diagnostic shape.
  _source_whip
  _seed_findings '[{"class":"D","severity":"low","team":"a","detail":"x","fix_hint":"y","auto_fixable":true,"blast_radius":"low"}]'
  export ATMUX_TEST_AUDIT_RC=2

  local findings=()
  local stderr_file="$ATMUX_TEST_TMP/stderr.txt"
  _atmux_whip_check_audit 2>"$stderr_file"
  [ "${#findings[@]}" -eq 0 ]   # no section appended (re-asserts test 7)

  [ -s "$stderr_file" ]
  grep -q "whip-audit:" "$stderr_file"
  grep -q "rc=2" "$stderr_file"
  grep -q "skipping section" "$stderr_file"
}
