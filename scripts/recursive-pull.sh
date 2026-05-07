#!/usr/bin/env bash
# scripts/recursive-pull.sh — git pull --ff-only origin <branch> on root + every nested submodule.
#
# Usage:  recursive-pull.sh <branch> [<repo-root>]
# Default repo-root = $PWD.
#
# Pre-flight scans every repo's current branch and refuses to proceed if any
# repo is not on <branch> — partial pulls leave the tree in a half-state where
# some repos advanced and others didn't. Use recursive-checkout.sh first to
# unify, then re-run this.
#
# --ff-only refuses merge commits — keeps the sweep mechanical, never produces
# a merge anyone forgot to expect.
#
# Exit code: 0 = all clean, 1 = pull failed somewhere, 2 = pre-flight refused.

set -uo pipefail

branch="${1:?usage: recursive-pull.sh <branch> [<repo-root>]}"
root="${2:-$PWD}"

cd "$root" || { echo "ERR: cannot cd $root" >&2; exit 2; }
root_abs="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERR: $root is not inside a git repo" >&2; exit 2
}

mapfile -t paths < <(cd "$root_abs" && git submodule foreach --recursive --quiet 'echo "$displaypath"')

# ---- Pre-flight: every repo must be on <branch>, else refuse ----
echo "=== pre-flight: branch consistency check (target=$branch) ==="
mismatch=0
mismatch_list=()
_check_branch() {
  local label="$1"
  local current
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ "$current" = "HEAD" ] && current="(detached)"
  if [ "$current" = "$branch" ]; then
    printf "  %-3s %s\n" "✓" "$label  [$current]"
  else
    printf "  %-3s %s\n" "✗" "$label  [$current]"
    mismatch=$((mismatch + 1))
    mismatch_list+=("$label [$current]")
  fi
}
( cd "$root_abs" && _check_branch "(root)" )
for path in "${paths[@]}"; do
  ( cd "$root_abs/$path" && _check_branch "$path" )
done

if [ "$mismatch" -gt 0 ]; then
  echo
  echo "✗ REFUSE: $mismatch repo(s) not on '$branch':"
  for m in "${mismatch_list[@]}"; do
    echo "    - $m"
  done
  echo
  echo "  Run: $(dirname "$0")/recursive-checkout.sh $branch"
  echo "  Then re-run this command."
  exit 2
fi
echo "✓ all repos on '$branch' — proceeding"
echo

# ---- Action: pull per repo (everyone confirmed on $branch) ----
fail=0
_pull_one() {
  local label="$1"
  echo "=== $label ==="
  if git pull --ff-only origin "$branch" 2>&1 | tail -3; then
    return 0
  else
    echo "  WARN: pull failed (non-ff or network)"
    return 1
  fi
}

cd "$root_abs"
_pull_one "(root) $root_abs" || fail=$((fail + 1))

for path in "${paths[@]}"; do
  ( cd "$root_abs/$path" && _pull_one "$path" )
  rc=$?
  [ "$rc" -ne 0 ] && fail=$((fail + 1))
done

echo
echo "=== summary: $fail failed out of $((${#paths[@]} + 1)) repos ==="
exit "$fail"
