#!/usr/bin/env bats
# Unit tests for lib/common.sh

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
}

teardown() {
  atmux_teardown_sandbox
}

@test "common: atmux::version returns semver" {
  run atmux::version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "common: atmux::dir honors ATMUX_DIR override" {
  ATMUX_DIR="/tmp/foo/.atmux" run atmux::dir
  [ "$output" = "/tmp/foo/.atmux" ]
}

@test "common: atmux::dir walks up to find .atmux" {
  mkdir -p .atmux
  mkdir -p sub/sub2
  cd sub/sub2
  unset ATMUX_DIR
  run atmux::dir
  [ "$output" = "$ATMUX_TEST_TMP/project/.atmux" ]
}

@test "common: atmux::dir honors ATMUX_TEAM_DIR (project-root override)" {
  unset ATMUX_DIR
  ATMUX_TEAM_DIR="$ATMUX_TEST_TMP/project" run atmux::dir
  [ "$output" = "$ATMUX_TEST_TMP/project/.atmux" ]
}

@test "common: atmux::dir strips trailing slash from ATMUX_TEAM_DIR" {
  unset ATMUX_DIR
  ATMUX_TEAM_DIR="$ATMUX_TEST_TMP/project/" run atmux::dir
  [ "$output" = "$ATMUX_TEST_TMP/project/.atmux" ]
}

@test "common: atmux::dir — ATMUX_DIR wins over ATMUX_TEAM_DIR" {
  ATMUX_DIR="/tmp/explicit/.atmux" ATMUX_TEAM_DIR="/tmp/team-root" run atmux::dir
  [ "$output" = "/tmp/explicit/.atmux" ]
}

@test "common: atmux::dir — ATMUX_TEAM_DIR resolves cron \$HOME breakage" {
  # Repro of the cron-from-\$HOME bug: cwd has no .atmux/, walk-up finds nothing,
  # so ATMUX_TEAM_DIR has to substitute for cd-into-project.
  mkdir -p home
  cd home
  unset ATMUX_DIR
  ATMUX_TEAM_DIR="$ATMUX_TEST_TMP/project" run atmux::dir
  [ "$output" = "$ATMUX_TEST_TMP/project/.atmux" ]
}

@test "common: atmux::gen_id returns t-prefixed 10-char id" {
  run atmux::gen_id
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^t-[0-9a-f]{8}$ ]]
}

@test "common: atmux::now_epoch returns epoch seconds" {
  run atmux::now_epoch
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+$ ]]
  # within a plausible range
  (( output > 1700000000 ))
}

@test "common: atmux::now_iso returns ISO-8601 Z" {
  run atmux::now_iso
  [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
}

@test "common: atmux::now_myt ends with MYT" {
  run atmux::now_myt
  [[ "$output" =~ MYT$ ]]
}

@test "common: atmux::require_team fails without team.json" {
  run atmux::require_team
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no team.json" ]]
}

@test "common: atmux::require_team fails on bad JSON" {
  mkdir -p .atmux
  echo 'not json' > .atmux/team.json
  run atmux::require_team
  [ "$status" -ne 0 ]
  [[ "$output" =~ "not valid JSON" ]]
}

@test "common: atmux::team_name reads .name from team.json" {
  mkdir -p .atmux
  echo '{"name":"hello","members":[]}' > .atmux/team.json
  run atmux::team_name
  [ "$output" = "hello" ]
}

@test "common: atmux::session_name composes atmux-<team>" {
  mkdir -p .atmux
  echo '{"name":"foo","members":[]}' > .atmux/team.json
  run atmux::session_name
  [ "$output" = "atmux-foo" ]
}

@test "common: atmux::session_name honors ATMUX_SESSION override" {
  mkdir -p .atmux
  echo '{"name":"foo","members":[]}' > .atmux/team.json
  ATMUX_SESSION="custom-sess" run atmux::session_name
  [ "$output" = "custom-sess" ]
}

@test "common: atmux::window_name composes __<team>__<member>" {
  mkdir -p .atmux
  echo '{"name":"foo","members":[]}' > .atmux/team.json
  run atmux::window_name bar
  [ "$output" = "__foo__bar" ]
}

@test "common: atmux::member_json returns the matching member" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{"name":"t","members":[{"name":"alice","tui":"claude"},{"name":"bob","tui":"kimi"}]}
JSON
  run atmux::member_json alice
  [ "$status" -eq 0 ]
  [[ "$output" =~ \"name\":\ *\"alice\" ]]
}

@test "common: atmux::member_json fails for unknown member" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{"name":"t","members":[{"name":"alice","tui":"claude"}]}
JSON
  run atmux::member_json charlie
  [ "$status" -ne 0 ]
}

@test "common: atmux::members_names lists in declared order" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{"name":"t","members":[{"name":"a"},{"name":"b"},{"name":"c"}]}
JSON
  run atmux::members_names
  [ "${lines[0]}" = "a" ]
  [ "${lines[1]}" = "b" ]
  [ "${lines[2]}" = "c" ]
}

@test "common: atmux::jq_update creates + mutates JSON file atomically" {
  local f="$ATMUX_TEST_TMP/x.json"
  echo '{"xs":[]}' > "$f"
  atmux::jq_update "$f" '.xs += [1]'
  atmux::jq_update "$f" '.xs += [2]'
  run jq -c '.xs' "$f"
  [ "$output" = "[1,2]" ]
}

@test "common: atmux::jq_update returns nonzero on bad filter + leaves file intact (A11)" {
  # E6/S5 t-7ae355e9 — pre-A11 a malformed filter silently emitted an
  # empty tmp + mv'd over the live JSON. Now jq's nonzero rc surfaces
  # and the source file is preserved.
  local f="$ATMUX_TEST_TMP/preserved.json"
  echo '{"keep":"me"}' > "$f"
  local before; before="$(cat "$f")"
  run atmux::jq_update "$f" '.this is not valid jq @@@'
  [ "$status" -ne 0 ]
  [ "$(cat "$f")" = "$before" ]
}

@test "common: atmux::ensure_dirs creates subdirs" {
  mkdir -p .atmux
  echo '{"name":"t","members":[]}' > .atmux/team.json
  atmux::ensure_dirs
  [ -d .atmux/inboxes ]
  [ -d .atmux/logs ]
  [ -d .atmux/state ]
  [ -d .atmux/archive ]
}

# ---------- atmux::guard_push_target — ADR-028 refuse-gate ----------

@test "common: guard_push_target — refuses push to main" {
  run atmux::guard_push_target main
  [ "$status" -ne 0 ]
  [[ "$output" =~ "PR-only" ]]
  [[ "$output" =~ "ADR-028" ]]
}

@test "common: guard_push_target — refuses push to master" {
  run atmux::guard_push_target master
  [ "$status" -ne 0 ]
  [[ "$output" =~ "PR-only" ]]
  [[ "$output" =~ "ADR-028" ]]
}

@test "common: guard_push_target — refuses 'main' regardless of how caller resolved it (misconfigured branch.X.merge)" {
  # Repro shape: caller resolves push target via `git config branch.foo.merge`
  # which (drift bug) returns refs/heads/main. Caller strips refs/heads/ and
  # passes "main" to the guard. Guard must refuse on the resolved string;
  # provenance is irrelevant.
  local resolved="refs/heads/main"
  resolved="${resolved#refs/heads/}"
  run atmux::guard_push_target "$resolved"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "PR-only" ]]
}

@test "common: guard_push_target — allows WIP branches (geoyws, feature-x)" {
  run atmux::guard_push_target geoyws
  [ "$status" -eq 0 ]
  run atmux::guard_push_target feature-x
  [ "$status" -eq 0 ]
  run atmux::guard_push_target main-staging
  [ "$status" -eq 0 ]
}
