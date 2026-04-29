#!/usr/bin/env bats
# Unit tests for lib/super-status.sh — fleet rollup + per-team digest.
# Covers ADR-025 §Decision super-status: read-only default, --prune mutation,
# --json schema, liveness-stale detection, kanban + git + outbox digest.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/super-status.sh
  . "$ATMUX_LIB_DIR/super-status.sh"
  atmux_assert_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# Build a fake project root with .atmux/ + kanban + (optional) git history.
# $1=name $2=projectRoot
_seed_team() {
  local name="$1" proj="$2"
  mkdir -p "$proj/.atmux"
  cat > "$proj/.atmux/team.json" <<JSON
{"name":"$name","tmuxTmpdir":"$ATMUX_TEST_TMP/tmux"}
JSON
  cat > "$proj/.atmux/kanban.json" <<'JSON'
{
  "tasks": [
    {"id":"t-1","status":"todo","lane":"be"},
    {"id":"t-2","status":"in-progress","lane":"be","claimedAt":1},
    {"id":"t-3","status":"blocked","lane":"fe"},
    {"id":"t-4","status":"todo","lane":"ops"},
    {"id":"t-5","status":"done","lane":"ops"}
  ],
  "epics": [
    {"id":"e-1","title":"shipped epic","status":"in-progress"},
    {"id":"e-2","title":"review epic","status":"review"},
    {"id":"e-3","title":"all-stories-done","status":"in-progress"}
  ],
  "stories": [
    {"id":"s-1","epic":"e-3","status":"done"},
    {"id":"s-2","epic":"e-3","status":"done"},
    {"id":"s-3","epic":"e-1","status":"in-progress"}
  ]
}
JSON
  echo "- 12:00 MYT  · lead-bootstrap" > "$proj/.atmux/lead-outbox.md"
  echo "- 12:05 MYT  · dispatched t-1 → be-foo" >> "$proj/.atmux/lead-outbox.md"
  echo "- 12:10 MYT  · t-1 done sha=abc1234" >> "$proj/.atmux/lead-outbox.md"
}

# Init a tiny git repo so super-status can read git log + ahead/behind.
_seed_git() {
  local proj="$1"
  (
    cd "$proj"
    git init -q -b main
    git config user.email "t@t"
    git config user.name "t"
    echo a > a.txt
    git add a.txt
    git -c commit.gpgsign=false commit -q -m "init"
  )
}

@test "super-status: empty registry → human (no teams) message" {
  rm -f "$ATMUX_REGISTRY"
  run main
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no teams registered" ]]
}

@test "super-status: empty registry --json → empty teams + zero counts" {
  rm -f "$ATMUX_REGISTRY"
  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.teams == [] and .fleet.counts.running == 0
                       and .fleet.counts.stopped == 0 and .fleet.counts.stale == 0' >/dev/null
}

@test "super-status: single registered team --json includes kanban + branch + outbox + gitlog" {
  local proj="$ATMUX_TEST_TMP/p1"
  _seed_team alpha "$proj"
  _seed_git "$proj"

  atmux::registry_upsert alpha "$proj" "atmux-alpha" >/dev/null

  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.teams | length == 1' >/dev/null
  echo "$out" | jq -e '.teams[0].name == "alpha"' >/dev/null
  echo "$out" | jq -e '.teams[0].kanban.todo == 2' >/dev/null
  echo "$out" | jq -e '.teams[0].kanban.inProgress == 1' >/dev/null
  echo "$out" | jq -e '.teams[0].kanban.blocked == 1' >/dev/null
  # opsPending counts ops-lane Tasks where status≠done — t-4 is todo → 1.
  echo "$out" | jq -e '.teams[0].kanban.opsPending == 1' >/dev/null
  # Outbox tail = 3 entries.
  echo "$out" | jq -e '.teams[0].leadOutbox | length == 3' >/dev/null
  # Git log ≥ 1 entry.
  echo "$out" | jq -e '.teams[0].gitLog | length >= 1' >/dev/null
  # Branch ahead/behind both 0 vs no-upstream → fields exist.
  echo "$out" | jq -e '.teams[0].branch | has("ahead") and has("behind")' >/dev/null
}

@test "super-status: liveness-stale when projectRoot/.atmux is gone" {
  local proj="$ATMUX_TEST_TMP/p2"
  _seed_team beta "$proj"
  atmux::registry_upsert beta "$proj" "atmux-beta" >/dev/null

  rm -rf "$proj/.atmux"

  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.teams[0].status == "stale"' >/dev/null
  echo "$out" | jq -e '.fleet.counts.stale == 1' >/dev/null
}

@test "super-status: default render does NOT mutate registry (no auto-prune)" {
  local proj="$ATMUX_TEST_TMP/p3"
  _seed_team gamma "$proj"
  atmux::registry_upsert gamma "$proj" "atmux-gamma" >/dev/null
  rm -rf "$proj/.atmux"

  main --json >/dev/null 2>&1
  # Registry status should still be "running" — render is read-only.
  run jq -r '.[0].status' "$ATMUX_REGISTRY"
  [ "$output" = "running" ]
}

@test "super-status: --prune flips liveness-stale entries to status=stale (preserves entry)" {
  local proj="$ATMUX_TEST_TMP/p4"
  _seed_team delta "$proj"
  atmux::registry_upsert delta "$proj" "atmux-delta" >/dev/null
  rm -rf "$proj/.atmux"

  main --prune >/dev/null 2>&1
  run jq -r '.[0].status' "$ATMUX_REGISTRY"
  [ "$output" = "stale" ]
  # Entry preserved (length still 1).
  run jq 'length' "$ATMUX_REGISTRY"
  [ "$output" = "1" ]
}

@test "super-status: promoteReadyEpics surfaces review-state + all-stories-done epics" {
  local proj="$ATMUX_TEST_TMP/p5"
  _seed_team eps "$proj"
  atmux::registry_upsert eps "$proj" "atmux-eps" >/dev/null

  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.fleet.promoteReadyEpics | length == 2' >/dev/null
  # IDs: e-2 (status=review) + e-3 (all stories done)
  run jq -r '.fleet.promoteReadyEpics | map(.id) | sort | join(",")' <<<"$out"
  [ "$output" = "e-2,e-3" ]
}

@test "super-status: staleClaims surfaces in-progress Tasks claimed >24h ago" {
  local proj="$ATMUX_TEST_TMP/p6"
  _seed_team zeta "$proj"
  atmux::registry_upsert zeta "$proj" "atmux-zeta" >/dev/null

  local out; out="$(main --json 2>/dev/null)"
  # t-2 has claimedAt=1 (epoch) which is >24h ago no matter when test runs.
  echo "$out" | jq -e '.fleet.staleClaims | length == 1' >/dev/null
  echo "$out" | jq -e '.fleet.staleClaims[0].id == "t-2"' >/dev/null
  echo "$out" | jq -e '.fleet.staleClaims[0].team == "zeta"' >/dev/null
}

@test "super-status: --prune is no-op when no stale entries" {
  local proj="$ATMUX_TEST_TMP/p7"
  _seed_team eta "$proj"
  _seed_git "$proj"
  atmux::registry_upsert eta "$proj" "atmux-eta" >/dev/null
  # Operator-stop: status='stopped' is intentional and skipped by liveness,
  # so eta won't appear stale → --prune has nothing to flip.
  atmux::registry_deregister eta >/dev/null

  run main --prune
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no stale entries" ]]
  run jq -r '.[0].status' "$ATMUX_REGISTRY"
  [ "$output" = "stopped" ]
}

@test "super-status: human render header carries fleet counts" {
  local proj="$ATMUX_TEST_TMP/p8"
  _seed_team theta "$proj"
  atmux::registry_upsert theta "$proj" "atmux-theta" >/dev/null
  rm -rf "$proj/.atmux"

  run main
  [ "$status" -eq 0 ]
  [[ "$output" =~ "super-status" ]]
  [[ "$output" =~ "stale=1" ]]
  [[ "$output" =~ "theta" ]]
}

@test "super-status: dispatcher route — 'atmux super-status' resolves to lib/super-status.sh" {
  # Exercise via the bin dispatcher rather than the sourced main(). Empty
  # registry path (sandbox unset → defaults under sandbox HOME) should
  # produce the no-teams message and exit 0.
  rm -f "$ATMUX_REGISTRY"
  run "$ATMUX_BIN" super-status
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no teams registered" || "$output" =~ "super-status" ]]
}

@test "super-status: --prune render reports the names that flipped" {
  local proj="$ATMUX_TEST_TMP/p9"
  _seed_team iota "$proj"
  atmux::registry_upsert iota "$proj" "atmux-iota" >/dev/null
  rm -rf "$proj/.atmux"

  local out; out="$(main --prune 2>&1)"
  [[ "$out" =~ "iota" ]]
  [[ "$out" =~ "marked stale" ]]
}

@test "super-status: multi-team mix (1 running + 1 stopped + 1 stale) — fleet counts match" {
  # Running: live .atmux/ AND tmux session up under team's tmpdir.
  local p_run="$ATMUX_TEST_TMP/multi-run"
  _seed_team mu-run "$p_run"
  atmux::registry_upsert mu-run "$p_run" "atmux-mu-run" >/dev/null
  TMUX_TMPDIR="$ATMUX_TEST_TMP/tmux" tmux new-session -d -s "atmux-mu-run" -c "$p_run" 3>&- 4>&-

  # Stopped: operator-deregistered. Even with .atmux/ present, status='stopped'
  # is preserved and skipped by liveness.
  local p_stop="$ATMUX_TEST_TMP/multi-stop"
  _seed_team mu-stop "$p_stop"
  atmux::registry_upsert mu-stop "$p_stop" "atmux-mu-stop" >/dev/null
  atmux::registry_deregister mu-stop >/dev/null

  # Stale: .atmux/ deleted after registration → liveness fails.
  local p_stale="$ATMUX_TEST_TMP/multi-stale"
  _seed_team mu-stale "$p_stale"
  atmux::registry_upsert mu-stale "$p_stale" "atmux-mu-stale" >/dev/null
  rm -rf "$p_stale/.atmux"

  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.teams | length == 3' >/dev/null
  echo "$out" | jq -e '.fleet.counts.running == 1' >/dev/null
  echo "$out" | jq -e '.fleet.counts.stopped == 1' >/dev/null
  echo "$out" | jq -e '.fleet.counts.stale == 1' >/dev/null
  # README schema (line 658) declares `total` alongside the bucket counts.
  # Reviewer-1 caught the gap: it was missing from JSON emission. Pin it
  # here as part of the JSON shape contract.
  echo "$out" | jq -e '.fleet.counts | has("total")' >/dev/null
  echo "$out" | jq -e '.fleet.counts.total == 3' >/dev/null
  echo "$out" | jq -e '.fleet.counts.total == (.fleet.counts.running + .fleet.counts.stopped + .fleet.counts.stale)' >/dev/null

  # Each team's status surfaces individually under .teams[].
  run jq -r '.teams | map({(.name): .status}) | add | to_entries | map("\(.key)=\(.value)") | sort | join(",")' <<<"$out"
  [ "$output" = "mu-run=running,mu-stale=stale,mu-stop=stopped" ]
}

@test "super-status: idle-team detection — no commits + no outbox activity > 24h" {
  # No git init → lastCommit=0. No lead-outbox.md → lastOutbox=0. Both are
  # billions of seconds ago; the >24h threshold trivially passes.
  local proj="$ATMUX_TEST_TMP/idle"
  _seed_team kappa "$proj"
  rm -f "$proj/.atmux/lead-outbox.md"
  atmux::registry_upsert kappa "$proj" "atmux-kappa" >/dev/null

  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.fleet.idleTeams | length == 1' >/dev/null
  echo "$out" | jq -e '.fleet.idleTeams[0].name == "kappa"' >/dev/null
}

@test "super-status: idle-team detection skips status=stopped teams" {
  # Stopped is operator-intentional, not a fleet anomaly — should not appear
  # in idleTeams even when its commit/outbox timestamps would otherwise qualify.
  local proj="$ATMUX_TEST_TMP/idle-stopped"
  _seed_team lam "$proj"
  rm -f "$proj/.atmux/lead-outbox.md"
  atmux::registry_upsert lam "$proj" "atmux-lam" >/dev/null
  atmux::registry_deregister lam >/dev/null

  local out; out="$(main --json 2>/dev/null)"
  echo "$out" | jq -e '.fleet.idleTeams | length == 0' >/dev/null
}
