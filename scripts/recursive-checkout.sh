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
# Exit code = number of repos that failed to checkout.

set -uo pipefail

branch="${1:?usage: recursive-checkout.sh <branch> [<repo-root>]}"
root="${2:-$PWD}"

cd "$root" || { echo "ERR: cannot cd $root" >&2; exit 2; }
root_abs="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERR: $root is not inside a git repo" >&2; exit 2
}

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

while IFS= read -r path; do
  ( cd "$root_abs/$path" && _checkout_one "$path" ) || fail=$((fail + 1))
done < <(cd "$root_abs" && git submodule foreach --recursive --quiet 'echo "$displaypath"')

echo
echo "=== summary: $fail repo(s) failed to checkout $branch ==="
exit "$fail"
