#!/usr/bin/env bash
# scripts/recursive-push.sh — git push origin <branch> on root + every nested submodule.
#
# Usage:  recursive-push.sh <branch> [<repo-root>]
# Default repo-root = $PWD.
#
# Pre-flight scans every repo's current branch and refuses to proceed if any
# repo is not on <branch> — pushing only some repos leaves origin in a state
# where the parent's submodule pointers reference unpushed child commits OR
# an inconsistent branch shape. Use recursive-checkout.sh first to unify.
#
# Push order is leaves-first (deepest submodules first) — git refuses a parent
# push if the parent's submodule pointer references a commit not on origin.
#
# Exit code: 0 = all clean, 1 = push failed somewhere, 2 = pre-flight refused.

set -uo pipefail

branch="${1:?usage: recursive-push.sh <branch> [<repo-root>]}"
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
echo "✓ all repos on '$branch' — proceeding (leaves-first push order)"
echo

# ---- Action: push leaves-first ----
fail=0
_push_one() {
  local label="$1"
  echo "=== $label ==="
  if git push origin "$branch" 2>&1 | tail -3; then
    return 0
  else
    echo "  WARN: push failed"
    return 1
  fi
}

# Submodules deepest-first (reverse of foreach output)
for ((i = ${#paths[@]} - 1; i >= 0; i--)); do
  path="${paths[$i]}"
  ( cd "$root_abs/$path" && _push_one "$path" )
  rc=$?
  [ "$rc" -ne 0 ] && fail=$((fail + 1))
done

# Root last
cd "$root_abs"
_push_one "(root) $root_abs" || fail=$((fail + 1))

echo
echo "=== summary: $fail failed out of $((${#paths[@]} + 1)) repos ==="
exit "$fail"
