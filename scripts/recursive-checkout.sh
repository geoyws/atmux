#!/usr/bin/env bash
# scripts/recursive-checkout.sh — checkout <branch> on root + every nested submodule.
#
# Usage:  recursive-checkout.sh <branch> [<repo-root>]
# Default repo-root = $PWD.
#
# For each repo (root + every nested submodule, recursively):
#   - fetch origin
#   - if <branch> exists locally: git checkout <branch>
#   - else if origin/<branch> exists: git checkout -b <branch> origin/<branch>
#   - else: WARN, skip (continues with other repos — never aborts the sweep)
#
# Detached HEAD repos are switched onto <branch> if available.
# Branch presence is per-repo: each submodule is independent (some may live on
# ix-geoyws while siblings live on sopx-geoyws — script reports per-repo).
#
# A pre-flight scan reports each repo's CURRENT branch BEFORE any action — so
# the user sees the divergent state before it gets unified.
#
# Exit code = number of repos that failed to checkout.

set -uo pipefail

branch="${1:?usage: recursive-checkout.sh <branch> [<repo-root>]}"
root="${2:-$PWD}"

cd "$root" || { echo "ERR: cannot cd $root" >&2; exit 2; }
root_abs="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERR: $root is not inside a git repo" >&2; exit 2
}

# Collect repo paths: root first, then every nested submodule.
mapfile -t paths < <(cd "$root_abs" && git submodule foreach --recursive --quiet 'echo "$displaypath"')

# ---- Pre-flight: report current branch per repo, flag mismatch vs target ----
echo "=== pre-flight: current branch per repo (target=$branch) ==="
mismatch=0
_print_branch() {
  local label="$1"
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ "$current" = "HEAD" ] && current="(detached)"
  if [ "$current" = "$branch" ]; then
    printf "  %-7s %s\n" "✓" "$label  [$current]"
  else
    printf "  %-7s %s\n" "✗" "$label  [$current]"
    mismatch=$((mismatch + 1))
  fi
}
( cd "$root_abs" && _print_branch "(root)" )
for path in "${paths[@]}"; do
  ( cd "$root_abs/$path" && _print_branch "$path" )
done
if [ "$mismatch" -gt 0 ]; then
  echo "  WARN: $mismatch repo(s) not on '$branch' — they will be switched (or skipped if branch missing)"
fi
echo

# ---- Action: checkout per repo ----
fail=0
_checkout_one() {
  local label="$1"
  echo "=== $label ==="
  git fetch origin 2>&1 | tail -3 || true
  if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    git checkout "$branch" 2>&1 | tail -2
  elif git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
    git checkout -b "$branch" "origin/$branch" 2>&1 | tail -2
  else
    echo "  WARN: $branch missing locally and on origin — skipping"
    return 1
  fi
}

cd "$root_abs"
_checkout_one "(root) $root_abs" || fail=$((fail + 1))

for path in "${paths[@]}"; do
  ( cd "$root_abs/$path" && _checkout_one "$path" ) || fail=$((fail + 1))
done

echo
echo "=== summary: $fail repo(s) failed to checkout $branch ==="
exit "$fail"
