#!/usr/bin/env bash
# scripts/recursive-reset.sh — git fetch + reset --hard origin/<branch> on
# root + every nested submodule.
#
# Usage:  recursive-reset.sh <branch> [<repo-root>]
# Default repo-root = $PWD.
#
# Snaps every repo (root + submodules) to its own `origin/<branch>` tip,
# discarding ALL local changes (uncommitted, staged, AND unpushed commits).
# Used by the per-member-long-lived-branch (PMLLB) flow in ADR-069+075:
# when a member finishes a task and starts a new one, `/rreset <member-branch>`
# (or `/rreset main` to drop a member-branch back to a clean main checkout)
# is the canonical "fresh slate" operation across the monorepo+submodules.
#
# Pre-flight scans every repo's current branch and refuses to proceed if
# any repo is not on `<branch>` — resetting only some repos leaves the tree
# inconsistent. Use recursive-checkout.sh first to unify.
#
# Action order is leaves-first (deepest submodules first) for symmetry with
# recursive-push.sh, though for reset the order is functionally
# independent — each repo's reset is local.
#
# DESTRUCTIVE: discards uncommitted work + unpushed commits. There is no
# `--dry-run` flag — operator confirms by typing the command.
#
# Exit code: 0 = all clean, 1 = reset failed somewhere, 2 = pre-flight refused.

set -uo pipefail

branch="${1:?usage: recursive-reset.sh <branch> [<repo-root>]}"
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
echo "✓ all repos on '$branch' — proceeding (leaves-first reset order)"
echo

# ---- Action: fetch + reset --hard origin/<branch> per repo, leaves-first ----
fail=0
_reset_one() {
  local label="$1"
  echo "=== $label ==="
  if ! git fetch origin "$branch" 2>&1 | tail -3; then
    echo "  WARN: fetch failed"
    return 1
  fi
  if git reset --hard "origin/$branch" 2>&1 | tail -3; then
    return 0
  else
    echo "  WARN: reset --hard failed"
    return 1
  fi
}

# Submodules deepest-first (reverse of foreach output)
for ((i = ${#paths[@]} - 1; i >= 0; i--)); do
  path="${paths[$i]}"
  ( cd "$root_abs/$path" && _reset_one "$path" )
  rc=$?
  [ "$rc" -ne 0 ] && fail=$((fail + 1))
done

# Root last
cd "$root_abs"
_reset_one "(root) $root_abs" || fail=$((fail + 1))

echo
echo "=== summary: $fail failed out of $((${#paths[@]} + 1)) repos ==="
exit "$fail"
