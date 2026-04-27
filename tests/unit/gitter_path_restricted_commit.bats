#!/usr/bin/env bats
# Tests for the gitter brief's path-restricted commit discipline (E15
# t-bf9bd197, ref templates/briefs/gitter.md §"Path-restricted commits —
# race-staging defense").
#
# What's under test here is NOT atmux code — it's the *git semantics* the
# gitter brief relies on. Pinning these as bats specs gives us:
#   - a regression-pin if a future git release changes pathspec or
#     worktree-state semantics around `git commit -m '...' -- <files>`,
#   - executable documentation of the rule + its Mm exception,
#   - mock-coverage for the post-commit verification → `atmux flag add`
#     handoff that gitter performs when a commit is wider than expected.
#
# Each test runs in its own throwaway git repo (mktemp -d + git init) —
# no atmux team or sandbox helpers required since we're verifying raw git
# behaviour, not atmux verbs.

setup() {
  GITTER_TMP="$(mktemp -d "${TMPDIR:-/tmp}/atmux-gitter-XXXXXX")"
  cd "$GITTER_TMP" || return 1
  git init -q -b main
  git config user.email "test@atmux.local"
  git config user.name  "atmux test"
  # Suppress hooks (some hosts inherit a global core.hooksPath).
  git config core.hooksPath /dev/null
  # Initial commit so HEAD exists for `git diff HEAD --`.
  echo "seed" > .seed
  git add .seed
  git commit -q -m "seed"
}

teardown() {
  cd /
  [[ -n "${GITTER_TMP:-}" && -d "$GITTER_TMP" ]] && rm -rf "$GITTER_TMP"
}

# Latest-commit tree as a sorted newline-list of paths (excludes .seed
# unless the test explicitly committed it). `git show --stat --format=` is
# what the brief prescribes operators run; we use the lower-level
# `git show --name-only` here for stable parsing.
_head_paths() {
  git show --name-only --format= HEAD | grep -v '^$' | sort
}

# ---------- AC1: race-staging defense (happy path) ----------

@test "path-restricted: commit -m '...' -- A scopes commit to A even when B is concurrently staged" {
  echo "alpha" > A
  echo "bravo" > B

  # Stage A first.
  git add A

  # Simulate a parallel worker staging B between our `add A` and our
  # `commit -- A`. Foreground is fine — the race we're defending against
  # is purely an index-state race, not a wall-clock one. By the time the
  # commit fires, B is already in the index alongside A.
  git add B

  # Sanity: both A and B are in the index now.
  git diff --cached --name-only | grep -qx A
  git diff --cached --name-only | grep -qx B

  # Path-restricted commit names ONLY A. The brief's claim: B stays in
  # the index, A lands in HEAD.
  git commit -q -m "scope: A only" -- A

  local paths; paths="$(_head_paths)"
  [ "$paths" = "A" ]

  # B is still staged (next worker's commit-Task picks it up).
  git diff --cached --name-only | grep -qx B
  ! git diff --cached --name-only | grep -qx A
}

# ---------- AC2: argument order — flag after pathspec ----------

@test "path-restricted: 'git commit -- A -m msg' (flag AFTER pathspec) is rejected by git" {
  # Post-`--` everything is a pathspec — `-m` becomes a literal path
  # called `-m`, and `msg` becomes a literal path called `msg`. Neither
  # exists in the index, so git errors out. This pins the brief's
  # warning that argument order matters.
  echo "alpha" > A
  git add A
  run git commit -- A -m "msg"
  [ "$status" -ne 0 ]
  # Error class isn't pinned (git versions phrase it differently —
  # 'pathspec ... did not match' or 'did not match any file(s) known to
  # git'); we just assert the commit didn't take. Note _head_paths still
  # returns `.seed` (from setup's seed commit), so we assert A is not
  # there rather than HEAD being empty.
  ! _head_paths | grep -qx A
  # And A is still staged — the failed commit didn't strip the index.
  git diff --cached --name-only | grep -qx A
}

# ---------- AC3: Mm worktree-state edge case ----------

@test "path-restricted Mm trap: 'commit -- A' with staged delta-1 + unstaged delta-2 records BOTH (worktree state)" {
  # The brief's explicit warning: path-restricted commits record WORKTREE
  # state of the listed paths, not INDEX state. For files in `Mm` state
  # (staged + unstaged), this combines both deltas into one commit.
  #
  # `Mm` requires a tracked baseline — `git status -s` only emits the
  # `M` (modified) glyphs against an already-committed file. A brand-
  # new file goes through `A` (added) → `AM` (added + worktree-modified)
  # instead. So we commit `line-1` first, then layer delta-2 + delta-3
  # to construct the Mm state the brief warns about.
  echo "line-1" > A
  git add A
  git commit -q -m "A baseline (line-1)"

  echo "line-2" >> A
  git add A                          # delta-2 staged → index has line-1+line-2
  echo "line-3" >> A                 # delta-3 in worktree on top → Mm

  # First column = index change → 'M', second column = worktree change
  # → 'M'. Together: 'MM A'.
  run git status -s A
  [[ "$output" == "MM A" ]]

  git commit -q -m "Mm trap" -- A

  # HEAD now contains BOTH delta-2 (line-2) AND delta-3 (line-3) — the
  # worktree state, not the index state at commit time.
  local head_content; head_content="$(git show HEAD:A)"
  [[ "$head_content" == *"line-1"* ]]
  [[ "$head_content" == *"line-2"* ]]
  [[ "$head_content" == *"line-3"* ]]

  # And `git status` shows A clean post-commit — both deltas consumed.
  run git status -s A
  [ "$output" = "" ]
}

# ---------- AC4: curated-patch workaround for Mm ----------

@test "Mm workaround: curated patch via 'apply --cached' + plain commit lands ONLY filtered hunks" {
  # The brief's prescribed workaround when Mm is detected: build a
  # curated patch via `git diff HEAD -- A`, filter hunks, `git apply
  # --cached <patch>`, then plain `git commit -m "..."` (no `--`). This
  # routes through the index, not the worktree, so only the filtered
  # hunks land.

  # Set up an initial committed shape so we can build deltas off it.
  printf 'line-1\nline-3\nline-5\n' > A
  git add A
  git commit -q -m "A baseline"

  # Stage delta-1 (insert line-2 between 1 and 3).
  printf 'line-1\nline-2\nline-3\nline-5\n' > A
  git add A

  # Add unstaged delta-2 (insert line-4 between 3 and 5) → Mm.
  printf 'line-1\nline-2\nline-3\nline-4\nline-5\n' > A
  run git status -s A
  [[ "$output" == "MM A" ]]

  # Reset the index for A so we can rebuild it via the curated path.
  # In real gitter flow, the operator inspects `git diff HEAD -- A`,
  # filters out the unwanted hunks, then `git apply --cached`. We
  # simulate that by handcrafting the index state to contain ONLY
  # delta-1 (line-2) — i.e. drop delta-2.
  git reset -q HEAD A
  printf 'line-1\nline-2\nline-3\nline-5\n' | git hash-object -w --stdin > /tmp/.gitter-blob.$$
  local blob; blob="$(cat /tmp/.gitter-blob.$$)"
  rm -f /tmp/.gitter-blob.$$
  git update-index --cacheinfo "100644,$blob,A"

  # Worktree still has delta-2; `git diff` (not --cached) shows it.
  git diff --name-only A | grep -qx A

  # Plain commit — NO `-- A` — so git uses the INDEX state. Only delta-1
  # lands in HEAD; delta-2 stays in the worktree.
  git commit -q -m "curated-only delta-1"

  local head_content; head_content="$(git show HEAD:A)"
  # delta-1 (line-2) committed; delta-2 (line-4) NOT committed.
  [[ "$head_content" == *$'line-1\nline-2\nline-3\nline-5'* ]]
  [[ "$head_content" != *"line-4"* ]]

  # And the worktree still carries delta-2 — exactly the state the
  # brief's workaround leaves you in.
  grep -qx "line-4" A
}

# ---------- AC5: post-commit verification → atmux flag add invoked ----------

@test "post-commit verification: wider-than-expected commit triggers mock 'atmux flag add'" {
  # Stub `atmux` on PATH so the brief's prescribed `atmux flag add ...`
  # call records its invocation to a tmpfile instead of going anywhere
  # near the real binary. This mirrors the curl-shim pattern used in
  # tests/unit/decisions.bats.
  local mock_bin="$GITTER_TMP/mock-bin"
  mkdir -p "$mock_bin"
  cat > "$mock_bin/atmux" <<EOF
#!/usr/bin/env bash
# mock atmux — record argv NUL-delimited so the test can recover both
# the verb and any --severity / --subject / --body flags.
exec >>"$GITTER_TMP/atmux-mock.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$mock_bin/atmux"

  # Set up a "wider-than-expected" commit. Gitter intends to commit ONLY
  # A, but a parallel worker also staged B; the path-restricted form
  # below stays narrow, but we deliberately use the unsafe wide form
  # (`git commit -m ...` without `-- A`) to simulate the swept-wider
  # failure mode the brief warns about.
  echo "alpha" > A
  echo "bravo" > B
  git add A B
  git commit -q -m "scope-A intended (but bravo also staged)"

  # The expected path set per the gitter Task: just "A". Run the brief's
  # post-commit check.
  local expected="A"
  local actual; actual="$(_head_paths)"

  # The brief's rule: if HEAD-paths ⊋ expected, fire `atmux flag add`.
  if [[ "$actual" != "$expected" ]]; then
    PATH="$mock_bin:$PATH" atmux flag add \
      --severity high \
      --subject "race-staging swept commit-Task t-deadbeef SHA $(git rev-parse --short HEAD)" \
      --body "expected=$expected actual=$actual"
  fi

  # Mock recorded the invocation.
  [ -f "$GITTER_TMP/atmux-mock.bin" ]
  # First arg is the verb (`flag`). Second is `add`.
  local first; first="$(awk 'BEGIN{RS="\0"} NR==1{print; exit}' "$GITTER_TMP/atmux-mock.bin")"
  local second; second="$(awk 'BEGIN{RS="\0"} NR==2{print; exit}' "$GITTER_TMP/atmux-mock.bin")"
  [ "$first" = "flag" ]
  [ "$second" = "add" ]
  # --severity high present in argv.
  grep -aq 'high' "$GITTER_TMP/atmux-mock.bin"
  # subject carries the race-staging marker + a 7-hex SHA.
  grep -aq 'race-staging swept commit-Task' "$GITTER_TMP/atmux-mock.bin"
  awk 'BEGIN{RS="\0"} /race-staging swept commit-Task/{print; exit}' \
    "$GITTER_TMP/atmux-mock.bin" \
    | grep -qE 'SHA [0-9a-f]{7}'
}

@test "post-commit verification: narrow-as-expected commit does NOT invoke 'atmux flag add'" {
  # Inverse-pin of AC5: when path-restricted form does its job, no flag
  # should fire. Catches a regression where the post-commit stat-check
  # mis-classifies a clean narrow commit as wide (false positive → noise
  # on the operator).
  local mock_bin="$GITTER_TMP/mock-bin"
  mkdir -p "$mock_bin"
  cat > "$mock_bin/atmux" <<EOF
#!/usr/bin/env bash
exec >>"$GITTER_TMP/atmux-mock.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$mock_bin/atmux"

  echo "alpha" > A
  echo "bravo" > B
  git add A B
  # Path-restricted form — only A lands.
  git commit -q -m "narrow scope" -- A

  local expected="A"
  local actual; actual="$(_head_paths)"

  if [[ "$actual" != "$expected" ]]; then
    PATH="$mock_bin:$PATH" atmux flag add --severity high --subject 'should-not-fire' --body 'noop'
  fi

  # Mock NEVER invoked — narrow commit had no widening.
  [ ! -f "$GITTER_TMP/atmux-mock.bin" ]
  # And B still staged for the next worker.
  git diff --cached --name-only | grep -qx B
}
