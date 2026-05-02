#!/usr/bin/env bats
# Unit tests for atmux::guard_push_target — the hard refuse-gate every
# agent git-push surface routes through (E11/Sa, t-2ac25840, ADR-028).
#
# Contract under test (lib/common.sh:670):
#   - branch == 'main' OR 'master' → atmux::die with 'push-target refuse'
#     message; exit code != 0.
#   - any other branch (WIP, <product>-<dev>-staging, feature
#     branches) → silent return 0.
#   - extra args after the branch (e.g. --force) are ignored — the gate
#     does NOT honor any override flag (intentional; ADR-028 §Decision).
#
# Strategy: source lib/common.sh and call atmux::guard_push_target
# directly. No full `atmux push` integration test here; the gate is
# branch-name-based and the wiring lives at every caller. Wiring
# coverage is left to the surfaces' own tests (gitter commit-flow,
# bin/atmux push verb, etc.).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_assert_sandbox
  # Source the lib so atmux::guard_push_target + atmux::die are in scope.
  atmux_source_libs
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- AC1: push-main refused ----------

@test "push_guard: branch=main ⇒ atmux::die with 'push-target refuse' (non-zero exit)" {
  run atmux::guard_push_target main
  [ "$status" -ne 0 ]
  [[ "$output" =~ "push-target refuse" ]]
  [[ "$output" =~ "main" ]]
  # ADR-028 cite + PR escape-hatch hint surface in the diagnostic so
  # operators don't have to grep the source for context.
  [[ "$output" =~ "ADR-028" ]]
  [[ "$output" =~ "gh pr create" ]]
}

# ---------- AC2: push-master refused ----------

@test "push_guard: branch=master ⇒ same refuse path as main (regex covers both)" {
  run atmux::guard_push_target master
  [ "$status" -ne 0 ]
  [[ "$output" =~ "push-target refuse" ]]
  [[ "$output" =~ "master" ]]
  [[ "$output" =~ "ADR-028" ]]
}

# ---------- AC3: push-via-config (mainline-via-config) ----------

@test "push_guard: branch.<wip>.merge=refs/heads/main ⇒ resolved target 'main' refused" {
  # Real-world failure mode from ADR-028 §Context: a developer's local
  # branch config has `branch.foo.merge = refs/heads/main`. Gitter does
  # `git push` with no args, git resolves the target via that config,
  # and the push lands on main without ever explicitly typing "main".
  # The guard fires AFTER target resolution: every push-surface caller
  # is required (per ADR-028 §Wiring) to resolve the effective target
  # via `git config --get branch.<wip>.merge` + strip `refs/heads/`,
  # then pass the resolved name to the guard. This test pins that
  # exact resolution chain → guard refuse.
  local repo; repo="$ATMUX_TEST_TMP/repo-cfg"
  mkdir -p "$repo" && cd "$repo"
  git init -q -b foo
  git config user.email t@t
  git config user.name  t
  git config core.hooksPath /dev/null
  # Point branch foo's merge target at refs/heads/main — emulates the
  # silent-mainline-via-tracking failure mode the gate defends against.
  git config branch.foo.merge refs/heads/main

  # Resolve effective target the same way every wired caller does.
  local raw resolved
  raw="$(git config --get branch.foo.merge)"
  [ "$raw" = "refs/heads/main" ]
  resolved="${raw#refs/heads/}"
  [ "$resolved" = "main" ]

  cd "$ATMUX_TEST_TMP/project"
  run atmux::guard_push_target "$resolved"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "push-target refuse" ]]
}

# ---------- AC4: push-allowed-WIP (the policy's positive space) ----------

@test "push_guard: WIP branch names (feature / <product>-<dev>-staging) pass through silently" {
  # The whole point of the gate is to refuse main/master while leaving
  # the rest of the branch namespace untouched — agents push to their
  # WIP trunk + per-developer staging URLs all day. Negative-space test:
  # if any of these refuse, the gate is over-broad.
  for branch in feature myteam-alpha-dev myteam-beta-dev \
                myteam-alpha-dev-staging myteam-feature-staging \
                feature/x-y wip-2026-04-27 ifca-product-staging; do
    run atmux::guard_push_target "$branch"
    [ "$status" -eq 0 ] || { echo "branch '$branch' was refused (expected pass)"; false; }
    [ -z "$output" ] || { echo "branch '$branch' emitted output: $output"; false; }
  done
}

# ---------- AC5: --force does NOT override ----------

@test "push_guard: extra args (--force, --force-with-lease) do NOT bypass the gate" {
  # ADR-028 §Decision is explicit: no agent flag (`--force-push-main`)
  # is provided, and the gate ignores unknown trailing args. Pin both
  # vectors — `--force` (real git flag) and a synthetic
  # `--force-push-main` (hypothetical override that must NOT exist).
  run atmux::guard_push_target main --force
  [ "$status" -ne 0 ]
  [[ "$output" =~ "push-target refuse" ]]

  run atmux::guard_push_target master --force-with-lease
  [ "$status" -ne 0 ]
  [[ "$output" =~ "push-target refuse" ]]

  run atmux::guard_push_target main --force-push-main
  [ "$status" -ne 0 ]
  [[ "$output" =~ "push-target refuse" ]]
}

# ---------- bonus: edge cases at the regex boundary ----------

@test "push_guard: branches sharing a prefix (mainline / mastery) are NOT main/master and pass" {
  # The refuse-regex is `^(main|master)$` — anchored. A team that
  # genuinely names a branch `mainline` or `mastery` should never trip
  # the gate. Pins the anchors against accidental loosening to
  # `^(main|master)` (no `$`).
  for branch in mainline mastery main- main_old master-old maintenance; do
    run atmux::guard_push_target "$branch"
    [ "$status" -eq 0 ] || { echo "branch '$branch' was refused (expected pass — regex anchors)"; false; }
  done
}

@test "push_guard: empty branch name passes (no-op — caller's responsibility to validate)" {
  # The gate's contract is "refuse main/master", not "validate
  # caller-provided branch names". An empty string is the caller's
  # bug; the gate stays narrow + composable.
  run atmux::guard_push_target ""
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
