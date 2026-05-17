#!/usr/bin/env bash
# ADR-141: Read-only audit of Claude account memory + skill workspaces.
#
# Walks every `~/.claude*/projects/*/memory/` and every
# `~/.claude*/skills/*` (workspace dirs only — plugin-cache symlinks
# are skipped). Reports per-project + per-skill:
#   - Which accounts have content
#   - Total size + leaf-file count
#   - Suggested "winning" account (most-recent-mtime)
#   - Conflict flag when multiple accounts have non-trivial content
#
# Safe to run any time — read-only. NO mv, NO ln -s, NO rm. The
# companion `claude-shared-migrate.sh` is the destructive partner.
#
# Usage:
#   scripts/claude-shared-audit.sh [--home <dir>] [--canonical <path>]
#
#   --home <dir>        Override $HOME (test injection). Default: $HOME.
#   --canonical <path>  Canonical store path. Default:
#                       <home>/work/journals/.sb/_dotfiles/claude-shared.
#                       Reported separately as "already migrated" vs
#                       "still per-account" buckets.
#
# Output format: human-readable table. Pipe to `less` for long output.

set -euo pipefail

HOME_OVERRIDE=""
CANONICAL_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)
      HOME_OVERRIDE="$2"
      shift 2
      ;;
    --canonical)
      CANONICAL_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

HOMEDIR="${HOME_OVERRIDE:-$HOME}"
CANONICAL="${CANONICAL_OVERRIDE:-$HOMEDIR/work/journals/.sb/_dotfiles/claude-shared}"

# Discover account dirs — anything under $HOME starting with .claude
# (excluding plain files like .claude.json).
mapfile -t ACCOUNTS < <(
  find "$HOMEDIR" -maxdepth 1 -type d -name ".claude*" 2>/dev/null | sort
)

if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
  echo "no .claude* account directories found under $HOMEDIR"
  exit 0
fi

echo "═══ ADR-141 Claude shared-store audit ═══"
echo "Home:      $HOMEDIR"
echo "Canonical: $CANONICAL"
echo "Accounts:  ${#ACCOUNTS[@]}"
for a in "${ACCOUNTS[@]}"; do
  echo "           $(basename "$a")"
done
echo

# ---- Memory audit ----

echo "─── Project memory dirs ───"
# Collect every project slug across accounts.
declare -A SLUG_SEEN=()
for a in "${ACCOUNTS[@]}"; do
  proj_dir="$a/projects"
  [[ -d "$proj_dir" ]] || continue
  while IFS= read -r mem; do
    # mem looks like .../.claude-X/projects/<slug>/memory
    slug="$(basename "$(dirname "$mem")")"
    SLUG_SEEN[$slug]=1
  done < <(find "$proj_dir" -mindepth 2 -maxdepth 2 -type d -name memory 2>/dev/null)
done

if [[ ${#SLUG_SEEN[@]} -eq 0 ]]; then
  echo "  (none — no project memory dirs across any account)"
  echo
else
  # Header.
  printf "  %-50s  %-30s  %-10s  %s\n" "SLUG" "PRESENT IN" "WINNER" "STATUS"
  printf "  %-50s  %-30s  %-10s  %s\n" "----" "----------" "------" "------"
  for slug in $(printf '%s\n' "${!SLUG_SEEN[@]}" | sort); do
    present=()
    winner_account=""
    winner_mtime=0
    total_files=0
    for a in "${ACCOUNTS[@]}"; do
      path="$a/projects/$slug/memory"
      if [[ -d "$path" && ! -L "$path" ]]; then
        # Real dir (not a symlink). Count files + check mtime.
        cnt=$(find "$path" -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$cnt" -gt 0 ]]; then
          present+=("$(basename "$a")")
          total_files=$((total_files + cnt))
          # mtime of most-recently-modified leaf
          latest=$(find "$path" -type f -name '*.md' -printf '%T@\n' 2>/dev/null | sort -nr | head -1)
          latest_int=${latest%.*}
          latest_int=${latest_int:-0}
          if [[ "$latest_int" -gt "$winner_mtime" ]]; then
            winner_mtime=$latest_int
            winner_account="$(basename "$a")"
          fi
        fi
      elif [[ -L "$path" ]]; then
        # Already a symlink — assume pointing at canonical. Mark
        # as already-migrated separately below.
        present+=("$(basename "$a")→link")
      fi
    done
    if [[ ${#present[@]} -eq 0 ]]; then
      continue
    fi
    status=""
    # Detect already-migrated state: all entries end in →link AND
    # canonical exists.
    all_links=1
    for p in "${present[@]}"; do
      [[ "$p" == *"→link" ]] || { all_links=0; break; }
    done
    if [[ "$all_links" -eq 1 && -d "$CANONICAL/memory/$slug" ]]; then
      status="✅ migrated"
    elif [[ ${#present[@]} -gt 1 ]]; then
      status="⚠️  conflict ($total_files file(s))"
    else
      status="🟡 single-account ($total_files file(s))"
    fi
    presence="$(IFS=,; echo "${present[*]}")"
    printf "  %-50s  %-30s  %-10s  %s\n" "$slug" "$presence" "${winner_account:-—}" "$status"
  done
  echo
fi

# ---- Skill workspace audit ----

echo "─── Skill workspace dirs (real dirs, not plugin-cache symlinks) ───"
declare -A SKILL_SEEN=()
for a in "${ACCOUNTS[@]}"; do
  skills_dir="$a/skills"
  [[ -d "$skills_dir" ]] || continue
  while IFS= read -r sk; do
    # We only care about REAL dirs (workspace state), not symlinks
    # (plugin-cache).
    [[ -L "$sk" ]] && continue
    name="$(basename "$sk")"
    SKILL_SEEN[$name]=1
  done < <(find "$skills_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
done

if [[ ${#SKILL_SEEN[@]} -eq 0 ]]; then
  echo "  (none — every skill across every account is a plugin-cache symlink)"
  echo
else
  printf "  %-30s  %-30s  %-10s  %s\n" "SKILL" "PRESENT IN" "WINNER" "STATUS"
  printf "  %-30s  %-30s  %-10s  %s\n" "-----" "----------" "------" "------"
  for skill in $(printf '%s\n' "${!SKILL_SEEN[@]}" | sort); do
    present=()
    winner_account=""
    winner_mtime=0
    for a in "${ACCOUNTS[@]}"; do
      path="$a/skills/$skill"
      if [[ -d "$path" && ! -L "$path" ]]; then
        present+=("$(basename "$a")")
        latest=$(find "$path" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1)
        latest_int=${latest%.*}
        latest_int=${latest_int:-0}
        if [[ "$latest_int" -gt "$winner_mtime" ]]; then
          winner_mtime=$latest_int
          winner_account="$(basename "$a")"
        fi
      fi
    done
    if [[ ${#present[@]} -eq 0 ]]; then continue; fi
    status="🟡 per-account"
    if [[ -d "$CANONICAL/skills/$skill" ]]; then
      status="✅ canonical exists"
    fi
    if [[ ${#present[@]} -gt 1 ]]; then
      status="⚠️  conflict"
    fi
    presence="$(IFS=,; echo "${present[*]}")"
    printf "  %-30s  %-30s  %-10s  %s\n" "$skill" "$presence" "${winner_account:-—}" "$status"
  done
  echo
fi

# ---- Pre-flight summary ----

echo "─── Pre-flight ───"
canonical_status="✅ exists"
[[ -d "$CANONICAL" ]] || canonical_status="❌ missing (migrate will create)"
echo "Canonical store: $canonical_status"

# Detect running Claude processes (best-effort — operator should
# stop sessions before --apply).
running=$(pgrep -af 'claude\b' 2>/dev/null | wc -l | tr -d ' ')
if [[ "$running" -gt 0 ]]; then
  echo "⚠️  $running running 'claude' process(es) — stop these before scripts/claude-shared-migrate.sh --apply"
else
  echo "✅ no running 'claude' processes — safe to migrate"
fi
echo
echo "Next step: scripts/claude-shared-migrate.sh   (dry-run-by-default)"
echo "           scripts/claude-shared-migrate.sh --apply   (executes)"
