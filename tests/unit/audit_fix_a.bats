#!/usr/bin/env bats
# Unit tests for class A fixer in lib/audit.sh — pane-state safety gate
# end-to-end with REAL pane content (E14/Sf, ADR-038 §Pane-state safety).
#
# Coverage gap vs. existing tests/unit/audit.bats:
#   - audit.bats's `class A fix:` cells STUB _atmux_audit_pane_idle_reason
#     to force ok / refuse, bypassing the actual `tmux capture-pane` →
#     preflight regex path. This file drives the live capture path:
#     printf-into-window seeds deterministic pane content, the fixer's
#     own capture-pane reads it, and the unmodified preflight decides.
#   - Three real busy banners (Compacting / queued-messages / thinking)
#     each refused with the finding still surfaced in _atmux_audit_findings.
#   - Two real idle prompts ($ and ❯) each fire the rename atomically.
#   - Target window collision: `__<team>__driver` already exists → fixer
#     refuses, BOTH windows survive (no half-rename, no swap).
#   - Idempotence: post-rename, re-running the detector emits zero A
#     findings (the fixer's outcome is observable to the next pass).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
  atmux_assert_sandbox
  export ATMUX_AUDIT_TMP_ROOT="$ATMUX_TEST_TMP/audit_tmp"
  mkdir -p "$ATMUX_AUDIT_TMP_ROOT"
}

teardown() {
  for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^auFA' || true); do
    tmux kill-session -t "=$s" 2>/dev/null || true
  done
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

_seed_tmux_session() {
  local sess="$1"
  printf '%s\n' "$sess" > .atmux/state/session.txt
  jq --arg s "$sess" '.name = $s' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  tmux new-session -d -s "$sess" -n "scratch" 3>&- 4>&-
}

# Spawn a 'driver' window whose pane displays a deterministic literal
# string. printf prints + sleep holds the pane open so tmux capture-pane
# sees the rendered content. The body string must be /bin/sh-safe; callers
# pass single-quote-friendly text only.
_spawn_driver_with_pane() {
  local sess="$1" body="$2"
  tmux new-window -d -t "=$sess" -n "driver" "printf '%s' '$body'; sleep 60" 3>&- 4>&-
  # Render-drain — printf+pty rendering is fast but not synchronous w.r.t.
  # tmux's frame buffer. A fixed 0.3s budget covers every test in this
  # file's hardware envelope; if it ever goes flaky, switch to a poll on
  # `tmux capture-pane | grep -q "<sentinel>"`.
  sleep 0.3
}

# ---- gate-busy: real banner injection refuses rename -------------------

@test "gate-busy: 'Compacting conversation' in pane → REFUSED + finding still in array" {
  _source_audit
  _seed_tmux_session "auFA1"
  _spawn_driver_with_pane "auFA1" $'Compacting conversation… (4k tokens)\n$ '

  _atmux_audit_class_a_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  # Bare 'driver' window untouched — rename did not fire.
  local bare
  bare="$(tmux list-windows -t "=auFA1" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  [ "$bare" = "1" ]
  ! tmux list-windows -t "=auFA1" -F '#{window_name}' 2>/dev/null \
      | grep -qxF '__auFA1__driver'

  # Finding survives the dispatcher (class A fixer logs skip but does not
  # remove the finding from the accumulator).
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]
  [ "$(jq -r '.class' <<<"${_atmux_audit_findings[0]}")" = "A" ]

  [ -f .atmux/logs/audit-fix.log ]
  grep -qE 'class=A.*result=skip.*banner' .atmux/logs/audit-fix.log
}

@test "gate-busy: 'Press up to edit queued messages' in pane → REFUSED" {
  _source_audit
  _seed_tmux_session "auFA2"
  _spawn_driver_with_pane "auFA2" $'Press up to edit queued messages\n$ '

  _atmux_audit_class_a_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local bare
  bare="$(tmux list-windows -t "=auFA2" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  [ "$bare" = "1" ]
  ! tmux list-windows -t "=auFA2" -F '#{window_name}' 2>/dev/null \
      | grep -qxF '__auFA2__driver'
  grep -qE 'class=A.*result=skip.*banner' .atmux/logs/audit-fix.log
}

@test "gate-busy: 'thinking with' in pane → REFUSED" {
  _source_audit
  _seed_tmux_session "auFA3"
  _spawn_driver_with_pane "auFA3" $'✶ thinking with extended reasoning…\n$ '

  _atmux_audit_class_a_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local bare
  bare="$(tmux list-windows -t "=auFA3" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  [ "$bare" = "1" ]
  ! tmux list-windows -t "=auFA3" -F '#{window_name}' 2>/dev/null \
      | grep -qxF '__auFA3__driver'
  grep -qE 'class=A.*result=skip.*banner' .atmux/logs/audit-fix.log
}

# ---- gate-idle: bare prompt fires the rename ---------------------------

@test "gate-idle: bare '\$ ' prompt → fires rename, '__auFA4__driver' present" {
  _source_audit
  _seed_tmux_session "auFA4"
  _spawn_driver_with_pane "auFA4" '~/foo $ '

  _atmux_audit_class_a_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local renamed bare
  renamed="$(tmux list-windows -t "=auFA4" -F '#{window_name}' 2>/dev/null \
              | grep -cxF '__auFA4__driver' || true)"
  bare="$(tmux list-windows -t "=auFA4" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  [ "$renamed" = "1" ]
  [ "$bare" = "0" ]
  grep -qE 'class=A.*result=ok' .atmux/logs/audit-fix.log
}

@test "gate-idle: '❯ ' starship prompt → fires rename" {
  _source_audit
  _seed_tmux_session "auFA5"
  _spawn_driver_with_pane "auFA5" '~/foo ❯ '

  _atmux_audit_class_a_detect || true
  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  local renamed bare
  renamed="$(tmux list-windows -t "=auFA5" -F '#{window_name}' 2>/dev/null \
              | grep -cxF '__auFA5__driver' || true)"
  bare="$(tmux list-windows -t "=auFA5" -F '#{window_name}' 2>/dev/null \
            | grep -cxF 'driver' || true)"
  [ "$renamed" = "1" ]
  [ "$bare" = "0" ]
  grep -qE 'class=A.*result=ok' .atmux/logs/audit-fix.log
}

# ---- target window collision -------------------------------------------

@test "collision: '__auFA6__driver' already exists → REFUSED, both windows survive" {
  _source_audit
  _seed_tmux_session "auFA6"
  # Pre-create the canonical window FIRST. Holds the target name so the
  # fixer's tmux rename-window will fail (tmux refuses on duplicate name).
  tmux new-window -d -t "=auFA6" -n "__auFA6__driver" 3>&- 4>&-
  _spawn_driver_with_pane "auFA6" '~/foo $ '

  _atmux_audit_class_a_detect || true
  # Detector matches on bare 'driver' (the canonical window doesn't trip it).
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  # BOTH windows survive — no swap, no half-rename.
  local pre bare
  pre="$(tmux list-windows -t "=auFA6" -F '#{window_name}' 2>/dev/null \
           | grep -cxF '__auFA6__driver' || true)"
  bare="$(tmux list-windows -t "=auFA6" -F '#{window_name}' 2>/dev/null \
           | grep -cxF 'driver' || true)"
  [ "$pre" = "1" ]
  [ "$bare" = "1" ]

  # Pre-flight collision guard (E14/Sf-followup t-263aaeaa) refuses
  # BEFORE the rename, so the row is class=A result=skip with the
  # collision reason naming the canonical window — not result=fail
  # (which would imply tmux's rename actually fired and rejected).
  grep -qE 'class=A.*result=skip' .atmux/logs/audit-fix.log
  grep -q "collision:" .atmux/logs/audit-fix.log
  grep -q "__auFA6__driver" .atmux/logs/audit-fix.log

  # Idempotency on the collision path: re-firing the dispatcher must
  # NO-OP — both windows still survive, and the audit log gains a
  # second skip row (not an ok / fail / double-rename).
  local skips_before skips_after
  skips_before="$(grep -cE 'class=A.*result=skip' .atmux/logs/audit-fix.log)"
  _atmux_audit_findings=()
  _atmux_audit_class_a_detect || true
  _atmux_audit_dispatch_action

  pre="$(tmux list-windows -t "=auFA6" -F '#{window_name}' 2>/dev/null \
           | grep -cxF '__auFA6__driver' || true)"
  bare="$(tmux list-windows -t "=auFA6" -F '#{window_name}' 2>/dev/null \
           | grep -cxF 'driver' || true)"
  [ "$pre" = "1" ]
  [ "$bare" = "1" ]
  skips_after="$(grep -cE 'class=A.*result=skip' .atmux/logs/audit-fix.log)"
  [ "$skips_after" -eq "$((skips_before + 1))" ]
}

# ---- idempotence: post-rename detect emits zero -----------------------

@test "idempotent: after successful rename, re-detect emits no class A finding" {
  _source_audit
  _seed_tmux_session "auFA7"
  _spawn_driver_with_pane "auFA7" '~/foo $ '

  _atmux_audit_class_a_detect || true
  [ "${#_atmux_audit_findings[@]}" -eq 1 ]

  _atmux_audit_fix_mode=1
  _atmux_audit_dry_run=0
  _atmux_audit_dispatch_action

  # Sanity: rename succeeded.
  tmux list-windows -t "=auFA7" -F '#{window_name}' 2>/dev/null \
    | grep -qxF '__auFA7__driver'

  # Re-run the detector on the now-clean state — zero A findings.
  _atmux_audit_findings=()
  _atmux_audit_class_a_detect
  [ "${#_atmux_audit_findings[@]}" -eq 0 ]
}
