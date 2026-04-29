#!/usr/bin/env bash
# scripts/recursive-push.sh — git push origin <branch> on root + every nested submodule.
#
# Usage:  recursive-push.sh <branch> [<repo-root>]
# Default repo-root = $PWD.
#
# For each repo (root + every nested submodule, recursively):
#   - if not on <branch>: WARN, skip (use recursive-checkout.sh first)
#   - else: git push origin <branch>
#
# Push order is leaves-first (deepest submodules first) — git refuses a parent
# push if the parent's submodule pointer references a commit not on origin.
# We invert the recursive-checkout.sh / recursive-pull.sh top-down walk by
# reversing the foreach output before pushing.
#
# Exit code = number of repos that failed to push.

set -uo pipefail

branch="${1:?usage: recursive-push.sh <branch> [<repo-root>]}"
root="${2:-$PWD}"

cd "$root" || { echo "ERR: cannot cd $root" >&2; exit 2; }
root_abs="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERR: $root is not inside a git repo" >&2; exit 2
}

fail=0
skipped=0

_push_one() {
  local label="$1"
  echo "=== $label ==="
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$current" != "$branch" ]; then
    echo "  SKIP: on '$current', not '$branch' (run recursive-checkout.sh $branch first)"
    skipped=$((skipped + 1))
    return 0
  fi
  if git push origin "$branch" 2>&1 | tail -3; then
    return 0
  else
    echo "  WARN: push failed"
    return 1
  fi
}

# Leaves first — collect all submodule paths, reverse, push each, then root last.
mapfile -t paths < <(cd "$root_abs" && git submodule foreach --recursive --quiet 'echo "$displaypath"')
# reverse
for ((i = ${#paths[@]} - 1; i >= 0; i--)); do
  path="${paths[$i]}"
  ( cd "$root_abs/$path" && _push_one "$path" )
  rc=$?
  [ "$rc" -ne 0 ] && fail=$((fail + 1))
done

# root last
cd "$root_abs"
_push_one "(root) $root_abs" || fail=$((fail + 1))

echo
echo "=== summary: $fail failed, $skipped skipped (wrong branch), out of all repos ==="
exit "$fail"
