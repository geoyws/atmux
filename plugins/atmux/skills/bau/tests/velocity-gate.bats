#!/usr/bin/env bats
# Unit tests for scripts/lib-velocity-gate.sh::team_recent_velocity_ok
# (t-0a4fc7f6, resolves bau Stuck-input false-positive).

setup() {
  TESTDIR="$(mktemp -d "${TMPDIR:-/tmp}/bau-vg-test.XXXXXX")"
  export WHIP_VG_LOG="$TESTDIR/whip-velocity-gate.log"
  # Source the lib — adjust path to be relative to the bats file.
  LIB="$(cd "$(dirname "$BATS_TEST_FILENAME")/../scripts" && pwd)/lib-velocity-gate.sh"
  # shellcheck source=../scripts/lib-velocity-gate.sh
  source "$LIB"
}

teardown() {
  rm -rf "$TESTDIR"
}

# ---------- Log-absent / log-empty ----------

@test "log file missing → returns 1 (no signal)" {
  rm -f "$WHIP_VG_LOG"
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}

@test "log file empty → returns 1 (no readings to evaluate)" {
  : > "$WHIP_VG_LOG"
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}

@test "log present but no entries for this team → returns 1" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:25 UTC 2026-05-15 [teamB] velocity=OK commits-30min=2 last-sha=abc123
14:25 UTC 2026-05-15 [teamC] velocity=OK commits-30min=1 last-sha=def456
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}

# ---------- The acceptance — Stuck-input false-positive fix ----------

@test "ACCEPTANCE: team with velocity=OK + commits-30min>=1 in last 3 → returns 0 (BAU verdict, not Stuck-input)" {
  # Mirrors today's cockpit state: pane-snapshot found queued_n>=3
  # mid-spinner gap, but velocity-gate has a recent OK reading. The
  # cross-check MUST fire success so the bau verdict ladder downgrades
  # Stuck-input → BAU.
  cat > "$WHIP_VG_LOG" <<'EOF'
14:25 UTC 2026-05-15 [teamA] velocity=OK commits-30min=2 last-sha=abc123 last-age=0min lead-busy=0
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 0 ]
}

@test "all 3 most-recent readings velocity=BAD → returns 1 (genuine Stuck — let bau fire)" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:10 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0 last-sha=abc last-age=120min
14:15 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0 last-sha=abc last-age=125min
14:20 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0 last-sha=abc last-age=130min
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}

@test "ANY of last 3 readings velocity=OK → returns 0 (even if 2 of 3 are BAD)" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:10 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
14:15 UTC 2026-05-15 [teamA] velocity=OK commits-30min=3
14:20 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 0 ]
}

@test "older velocity=OK BEYOND the last-3 window → returns 1 (window slid past)" {
  cat > "$WHIP_VG_LOG" <<'EOF'
12:00 UTC 2026-05-15 [teamA] velocity=OK commits-30min=5
12:05 UTC 2026-05-15 [teamA] velocity=OK commits-30min=4
14:10 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
14:15 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
14:20 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}

# ---------- Action lines + interleaved teams ----------

@test "action lines (`BAD — menu injected`) are skipped — only velocity= lines count" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:10 UTC 2026-05-15 [teamA] velocity=OK commits-30min=2
14:10 UTC 2026-05-15 [teamA] BAD — menu injected, strike 1
14:15 UTC 2026-05-15 [teamA] OK — strike reset
EOF
  # Three lines exist for teamA; only one is a velocity-reading (the
  # first), and it's OK. Function returns 0.
  run team_recent_velocity_ok teamA
  [ "$status" -eq 0 ]
}

@test "interleaved teams in log — function isolates by team tag" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:10 UTC 2026-05-15 [teamB] velocity=OK commits-30min=5
14:10 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
14:10 UTC 2026-05-15 [teamC] velocity=OK commits-30min=3
14:15 UTC 2026-05-15 [teamB] velocity=OK commits-30min=4
14:15 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
14:15 UTC 2026-05-15 [teamC] velocity=OK commits-30min=2
14:20 UTC 2026-05-15 [teamB] velocity=OK commits-30min=3
14:20 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
14:20 UTC 2026-05-15 [teamC] velocity=OK commits-30min=1
EOF
  # teamA: last 3 readings ALL BAD → status 1
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
  # teamB + teamC: last 3 readings ALL OK → status 0
  run team_recent_velocity_ok teamB
  [ "$status" -eq 0 ]
  run team_recent_velocity_ok teamC
  [ "$status" -eq 0 ]
}

# ---------- Edge: single reading ----------

@test "single OK reading (log has only 1 entry) → returns 0 (last-3 window degrades gracefully)" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:25 UTC 2026-05-15 [teamA] velocity=OK commits-30min=1
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 0 ]
}

@test "single BAD reading → returns 1" {
  cat > "$WHIP_VG_LOG" <<'EOF'
14:25 UTC 2026-05-15 [teamA] velocity=BAD commits-30min=0
EOF
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}

# ---------- WHIP_VG_LOG override ----------

@test "WHIP_VG_LOG=/missing/path → returns 1 (graceful, no crash)" {
  WHIP_VG_LOG=/non/existent/path/whip-velocity-gate.log
  run team_recent_velocity_ok teamA
  [ "$status" -eq 1 ]
}
