#!/usr/bin/env bash
# scripts/recursive-pull.sh — git pull --ff-only origin <branch> on root + every nested submodule.
#
# Usage:  recursive-pull.sh <branch> [<repo-root>]
# Default repo-root = $PWD.
#
# For each repo (root + every nested submodule, recursively):
#   - if not on <branch>: WARN, skip (use recursive-checkout.sh first)
#   - else: git pull --ff-only origin <branch>
#
# --ff-only refuses merge commits — keeps the sweep mechanical, never produces
# a merge anyone forgot to expect.
#
# Exit code = number of repos that failed to pull (skipped count NOT included).

set -uo pipefail

branch="${1:?usage: recursive-pull.sh <branch> [<repo-root>]}"
root="${2:-$PWD}"

cd "$root" || { echo "ERR: cannot cd $root" >&2; exit 2; }
root_abs="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERR: $root is not inside a git repo" >&2; exit 2
}

fail=0
skipped=0

_pull_one() {
  local label="$1"
  echo "=== $label ==="
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$current" != "$branch" ]; then
    echo "  SKIP: on '$current', not '$branch' (run recursive-checkout.sh $branch first)"
    skipped=$((skipped + 1))
    return 0
  fi
  if git pull --ff-only origin "$branch" 2>&1 | tail -3; then
    return 0
  else
    echo "  WARN: pull failed (non-ff or network)"
    return 1
  fi
}

cd "$root_abs"
_pull_one "(root) $root_abs" || fail=$((fail + 1))

while IFS= read -r path; do
  ( cd "$root_abs/$path" && _pull_one "$path" )
  rc=$?
  [ "$rc" -ne 0 ] && fail=$((fail + 1))
done < <(cd "$root_abs" && git submodule foreach --recursive --quiet 'echo "$displaypath"')

echo
echo "=== summary: $fail failed, $skipped skipped (wrong branch), out of all repos ==="
exit "$fail"
