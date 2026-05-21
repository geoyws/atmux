#!/usr/bin/env bash
# /ghostbuster — sweep mergeable epic-team branches in the current cage
# See SKILL.md for behaviour spec. This script is source-of-truth.
set -euo pipefail

# ---------- args ----------
DRY_RUN=0
NO_MERGE=0
NO_DELETE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --no-merge) NO_MERGE=1 ;;
    --no-delete) NO_DELETE=1 ;;
    -h|--help)
      cat <<'EOF'
/ghostbuster — merge mergeable epic-team branches + delete stale ones.
  --dry-run     report only, take no action
  --no-merge    skip merges (delete only)
  --no-delete   skip deletes (merge only)
EOF
      exit 0
      ;;
    *) echo "ghostbuster: unknown arg: $a" >&2; exit 2 ;;
  esac
done

# ---------- preflight ----------
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "ghostbuster: not in a git repo (run from inside a cage worktree)" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Determine trunk branch. Resolution chain:
#   1. $GHOSTBUSTER_TRUNK env override (operator's explicit choice)
#   2. origin/HEAD symbolic-ref (the repo's configured default branch)
#   3. local main / master fallback
#   4. current branch — but only if it doesn't look like an epic branch
#      (an epic branch can't be its own trunk; refuse + ask operator)
if [ -n "${GHOSTBUSTER_TRUNK:-}" ]; then
  TRUNK="$GHOSTBUSTER_TRUNK"
elif default_ref="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)"; then
  TRUNK="${default_ref#origin/}"
elif git rev-parse --verify --quiet refs/heads/main >/dev/null; then
  TRUNK="main"
elif git rev-parse --verify --quiet refs/heads/master >/dev/null; then
  TRUNK="master"
else
  CUR="$(git rev-parse --abbrev-ref HEAD)"
  case "$CUR" in
    *-epic-*) echo "ghostbuster: can't infer trunk (current is epic branch '$CUR'). Set GHOSTBUSTER_TRUNK=<branch>." >&2; exit 1 ;;
    *) TRUNK="$CUR" ;;
  esac
fi

if ! git rev-parse --verify --quiet "refs/heads/$TRUNK" >/dev/null; then
  echo "ghostbuster: trunk branch '$TRUNK' not found locally." >&2
  exit 1
fi

EPIC_PREFIX="${TRUNK}-epic-"

# Build set of branches with active worktree checkouts (don't delete these).
declare -A ACTIVE_WT
while IFS= read -r line; do
  case "$line" in
    branch\ refs/heads/*) ACTIVE_WT["${line#branch refs/heads/}"]=1 ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null)

# Push-policy gate: refuse to auto-push if trunk looks staging-grade.
PUSH_OK=1
case "$TRUNK" in
  *-staging|main|master) PUSH_OK=0 ;;
esac

# ---------- timestamp + report header ----------
# TZ falls back to UTC when COORDINATION_TZ (plugin userConfig) is unset
# — matches the bundled-plugin canonical default (bau.sh, watchdog.sh).
NOW_HUMAN="$(TZ="${COORDINATION_TZ:-UTC}" date +'%H:%M %Z %F')"
echo "# /ghostbuster — $NOW_HUMAN · trunk=\`$TRUNK\` · dry-run=$DRY_RUN"
echo

# ---------- enumerate + classify ----------
declare -a MERGEABLE=()
declare -a DEFERRED=()
declare -a CONTENTLESS=()
declare -a STALE=()
declare -a ACTIVE=()
declare -a SKIPPED_E2E=()

# Fetch first so ahead/behind is accurate vs. local refs.
git fetch origin --quiet 2>/dev/null || true

while IFS= read -r b; do
  [ -z "$b" ] && continue
  # Skip the trunk itself if matched (shouldn't, but safe).
  [ "$b" = "$TRUNK" ] && continue
  # Skip e2e/staging deploy variants outright.
  case "$b" in
    *-e2e|*-staging|*-fanin-e2e|*-fanin) SKIPPED_E2E+=("$b"); continue ;;
  esac

  ahead="$(git rev-list --count "$TRUNK..$b" 2>/dev/null || echo 0)"
  behind="$(git rev-list --count "$b..$TRUNK" 2>/dev/null || echo 0)"
  has_wt=0
  [ -n "${ACTIVE_WT[$b]:-}" ] && has_wt=1

  if [ "$ahead" = "0" ]; then
    if [ "$has_wt" = "1" ]; then
      ACTIVE+=("$b")
    else
      STALE+=("$b|$behind")
    fi
    continue
  fi

  # ahead > 0
  if [ "$has_wt" = "1" ]; then
    # Check whether the worktree is clean. If yes, merging is safe.
    # If dirty, defer — operator/team needs to commit or stash first.
    wt_path="$(git worktree list --porcelain | awk -v b="refs/heads/$b" '$1=="worktree"{p=$2} $1=="branch" && $2==b {print p; exit}')"
    if [ -n "$wt_path" ] && [ -d "$wt_path" ]; then
      if [ -z "$(git -C "$wt_path" status --porcelain 2>/dev/null)" ]; then
        : # clean — fall through to conflict-probe below
      else
        DEFERRED+=("$b|+${ahead}|active-worktree dirty — team has uncommitted changes")
        continue
      fi
    fi
  fi

  # Check for contentless-merge: ahead=1, single commit is a merge whose both parents are ancestors of TRUNK.
  if [ "$ahead" = "1" ]; then
    tip="$(git rev-parse "$b")"
    nparents="$(git cat-file -p "$tip" | grep -c '^parent ' || true)"
    if [ "$nparents" -ge 2 ]; then
      all_ancestors=1
      for p in $(git cat-file -p "$tip" | awk '/^parent /{print $2}'); do
        if ! git merge-base --is-ancestor "$p" "$TRUNK" 2>/dev/null; then
          all_ancestors=0
          break
        fi
      done
      if [ "$all_ancestors" = "1" ]; then
        CONTENTLESS+=("$b")
        continue
      fi
    fi
  fi

  # Probe for merge conflicts (dry-run merge into trunk via a temp index).
  # We use --no-commit + --no-ff with a write to detect conflicts cheaply.
  # Do this in a temp worktree so we don't touch the primary checkout.
  PROBE_WT=".claude/worktrees/ghostbuster-probe-$$-${b//\//_}"
  rm -rf "$PROBE_WT" 2>/dev/null || true
  if git worktree add --detach "$PROBE_WT" "$TRUNK" >/dev/null 2>&1; then
    if git -C "$PROBE_WT" merge --no-commit --no-ff "$b" >/dev/null 2>&1; then
      git -C "$PROBE_WT" merge --abort 2>/dev/null || true
      MERGEABLE+=("$b|+${ahead}")
    else
      conflicts="$(git -C "$PROBE_WT" diff --name-only --diff-filter=U 2>/dev/null | head -5 | paste -sd, -)"
      git -C "$PROBE_WT" merge --abort 2>/dev/null || true
      DEFERRED+=("$b|+${ahead}|conflicts: ${conflicts:-unknown}")
    fi
    # Cleanup probe worktree. Submodule deinit needed for the std/aix submodules
    # (per CLAUDE.md §Submodule Hygiene).
    git -C "$PROBE_WT" submodule deinit -f --all >/dev/null 2>&1 || true
    git worktree remove --force "$PROBE_WT" >/dev/null 2>&1 || rm -rf "$PROBE_WT"
  else
    DEFERRED+=("$b|+${ahead}|could-not-probe-worktree-add")
  fi
done < <(git branch -l "${EPIC_PREFIX}*" --format='%(refname:short)')

# ---------- act: merge ----------
declare -a MERGED_OK=()
declare -a MERGE_FAILED=()
if [ "$NO_MERGE" = "0" ] && [ "${#MERGEABLE[@]}" -gt 0 ] && [ "$DRY_RUN" = "0" ]; then
  # Set up the fold-in worktree.
  TS="$(date +%Y%m%d-%H%M%S)"
  FOLD_WT=".claude/worktrees/ghostbuster-$TS"
  FOLD_BRANCH="ghostbuster-fold-$TS"
  if git worktree add -b "$FOLD_BRANCH" "$FOLD_WT" "$TRUNK" >/dev/null 2>&1; then
    for entry in "${MERGEABLE[@]}"; do
      b="${entry%%|*}"
      if git -C "$FOLD_WT" merge --no-ff "$b" -m "merge: $b (ghostbuster sweep $TS)" >/dev/null 2>&1; then
        MERGED_OK+=("$b")
      else
        # Roll back this one, continue with next.
        git -C "$FOLD_WT" merge --abort 2>/dev/null || true
        MERGE_FAILED+=("$b")
      fi
    done
    # If anything landed, fast-forward TRUNK + push.
    if [ "${#MERGED_OK[@]}" -gt 0 ]; then
      # Fast-forward trunk in the primary worktree.
      if git -C "$REPO_ROOT" merge --ff-only "$FOLD_BRANCH" >/dev/null 2>&1; then
        if [ "$PUSH_OK" = "1" ]; then
          git -C "$REPO_ROOT" push origin "$TRUNK" >/dev/null 2>&1 || \
            echo "ghostbuster: push to origin/$TRUNK failed — check manually" >&2
        fi
      else
        echo "ghostbuster: could not ff $TRUNK to fold-in tip — merges stay on $FOLD_BRANCH" >&2
      fi
    fi
    # Clean up fold-in worktree + branch (only if successfully ff'd).
    git -C "$FOLD_WT" submodule deinit -f --all >/dev/null 2>&1 || true
    git worktree remove --force "$FOLD_WT" >/dev/null 2>&1 || rm -rf "$FOLD_WT"
    git branch -D "$FOLD_BRANCH" >/dev/null 2>&1 || true
  fi
fi

# ---------- act: delete ----------
declare -a DELETED=()
declare -a DELETE_FAILED=()
if [ "$NO_DELETE" = "0" ] && [ "$DRY_RUN" = "0" ]; then
  # Delete stale (0 ahead, no worktree) + contentless-merge branches.
  for entry in "${STALE[@]}" "${CONTENTLESS[@]}"; do
    b="${entry%%|*}"
    if git branch -d "$b" >/dev/null 2>&1; then
      DELETED+=("$b")
    elif git branch -D "$b" >/dev/null 2>&1; then
      DELETED+=("$b (force)")
    else
      DELETE_FAILED+=("$b")
    fi
  done
  # Also delete the branches we just merged (they're now stale).
  for b in "${MERGED_OK[@]}"; do
    if git branch -d "$b" >/dev/null 2>&1; then
      DELETED+=("$b (post-merge)")
    elif git branch -D "$b" >/dev/null 2>&1; then
      DELETED+=("$b (force, post-merge)")
    else
      DELETE_FAILED+=("$b (post-merge)")
    fi
  done
fi

# ---------- report ----------
echo "## Summary"
echo
echo "- Trunk: \`$TRUNK\`  (push-policy: $([ "$PUSH_OK" = "1" ] && echo "auto-push OK" || echo "manual-push only"))"
echo "- Mergeable branches: ${#MERGEABLE[@]}"
echo "- Deferred (conflicts / active-worktree): ${#DEFERRED[@]}"
echo "- Contentless-merge (deletable): ${#CONTENTLESS[@]}"
echo "- Stale (0 ahead, no worktree): ${#STALE[@]}"
echo "- Active (worktree, 0 ahead): ${#ACTIVE[@]}"
echo "- Skipped (e2e/staging variants): ${#SKIPPED_E2E[@]}"
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "**DRY RUN — no changes were made.** Re-run without \`--dry-run\` to act."
  echo
fi

if [ "${#MERGED_OK[@]}" -gt 0 ]; then
  echo "### ✅ MERGED ($([ "$PUSH_OK" = "1" ] && echo "+ pushed") — ${#MERGED_OK[@]})"
  for b in "${MERGED_OK[@]}"; do echo "- \`$b\`"; done
  echo
fi

if [ "${#MERGE_FAILED[@]}" -gt 0 ]; then
  echo "### ❌ MERGE FAILED — ${#MERGE_FAILED[@]} (conflicts surfaced during apply)"
  for b in "${MERGE_FAILED[@]}"; do echo "- \`$b\`"; done
  echo
fi

if [ "${#DEFERRED[@]}" -gt 0 ]; then
  echo "### 🟡 DEFERRED — ${#DEFERRED[@]}"
  for entry in "${DEFERRED[@]}"; do
    b="${entry%%|*}"
    rest="${entry#*|}"
    echo "- \`$b\` ($rest)"
  done
  echo
fi

if [ "${#DELETED[@]}" -gt 0 ]; then
  echo "### 🗑 DELETED — ${#DELETED[@]}"
  for b in "${DELETED[@]}"; do echo "- \`$b\`"; done
  echo
fi

if [ "${#DELETE_FAILED[@]}" -gt 0 ]; then
  echo "### ⚠ DELETE FAILED — ${#DELETE_FAILED[@]}"
  for b in "${DELETE_FAILED[@]}"; do echo "- \`$b\`"; done
  echo
fi

if [ "${#ACTIVE[@]}" -gt 0 ]; then
  echo "### ⏭ ACTIVE worktrees (kept) — ${#ACTIVE[@]}"
  for b in "${ACTIVE[@]}"; do echo "- \`$b\`"; done
  echo
fi

if [ "${#SKIPPED_E2E[@]}" -gt 0 ]; then
  echo "### ⏭ SKIPPED (e2e/staging carve-outs) — ${#SKIPPED_E2E[@]}"
  for b in "${SKIPPED_E2E[@]}"; do echo "- \`$b\`"; done
  echo
fi

if [ "${#MERGED_OK[@]}" = "0" ] && [ "${#DELETED[@]}" = "0" ] && [ "${#DEFERRED[@]}" = "0" ]; then
  echo "_Nothing to do — no mergeable branches, no stale branches._"
fi
