#!/usr/bin/env bash
# ADR-141: Migrate per-account Claude memory + skill workspace dirs
# to a single canonical store under the operator's dotfiles repo,
# then symlink each account's path to canonical.
#
# Dry-run by default. `--apply` is the explicit gate that actually
# writes changes. Idempotent — re-running on a migrated state is a
# no-op.
#
# Workflow per project / skill:
#   1. Resolve "winning" account (most-recent-mtime by default; per-
#      project override via the audit script's recommendation OR a
#      manual --prefer <slug>:<account> flag).
#   2. Backup losing-side content to <canonical>/_archive-<DATE>/
#      <account>/<slug>/.
#   3. Move winning content to <canonical>/memory/<slug>/.
#   4. Remove each loser's old path (after backup).
#   5. Create symlink from each account's path → canonical.
#
# Safety:
#   - Refuses to run with `--apply` if any 'claude' process is alive
#     (use --force to override at your own risk).
#   - Every destructive op is preceded by the backup step.
#   - Idempotent: if a project is already migrated (canonical exists
#     AND every account's path is a symlink to canonical), skip.
#
# Usage:
#   scripts/claude-shared-migrate.sh                  # dry-run
#   scripts/claude-shared-migrate.sh --apply          # execute
#   scripts/claude-shared-migrate.sh --apply --force  # ignore claude-alive check
#   scripts/claude-shared-migrate.sh --home <dir>     # test injection
#   scripts/claude-shared-migrate.sh --canonical <p>  # canonical override
#   scripts/claude-shared-migrate.sh --skill-only     # skip memory; only skill workspaces
#   scripts/claude-shared-migrate.sh --memory-only    # skip skills; only memory

set -euo pipefail

APPLY=0
FORCE=0
HOME_OVERRIDE=""
CANONICAL_OVERRIDE=""
SKILL_ONLY=0
MEMORY_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --home) HOME_OVERRIDE="$2"; shift 2 ;;
    --canonical) CANONICAL_OVERRIDE="$2"; shift 2 ;;
    --skill-only) SKILL_ONLY=1; shift ;;
    --memory-only) MEMORY_ONLY=1; shift ;;
    -h|--help)
      sed -n '2,35p' "$0" | sed 's/^# \?//'
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
TODAY="$(date +%Y-%m-%d)"
ARCHIVE_ROOT="$CANONICAL/_archive-$TODAY"

# ---- Helpers ----

# Log either prefixed [DRY] or plain (when --apply). Distinguishes
# would-do vs did-do at every line.
log() {
  if [[ $APPLY -eq 1 ]]; then
    echo "  $*"
  else
    echo "  [DRY] $*"
  fi
}

# Execute a destructive op gated on $APPLY. In dry-run, just log.
# The eval is intentional — callers pass a single quoted command
# string (with embedded `"$path"` quotes that need to survive the
# re-parse). The alternative — bash arrays — would force every call
# site to use argv shape, which loses readability for the path-
# quoting case here. shellcheck disable=SC2294 acknowledges the
# trade-off.
do_op() {
  log "$@"
  if [[ $APPLY -eq 1 ]]; then
    # shellcheck disable=SC2294
    eval "$@"
  fi
}

# ---- Pre-flight ----

mapfile -t ACCOUNTS < <(
  find "$HOMEDIR" -maxdepth 1 -type d -name ".claude*" 2>/dev/null | sort
)

if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
  echo "no .claude* account directories found under $HOMEDIR — nothing to migrate"
  exit 0
fi

echo "═══ ADR-141 Claude shared-store migration ═══"
echo "Home:      $HOMEDIR"
echo "Canonical: $CANONICAL"
echo "Mode:      $([[ $APPLY -eq 1 ]] && echo APPLY || echo dry-run)"
echo "Archive:   $ARCHIVE_ROOT"
echo "Accounts:  ${#ACCOUNTS[@]}"
for a in "${ACCOUNTS[@]}"; do
  echo "           $(basename "$a")"
done
echo

# Refuse to run --apply when claude processes are alive (operator
# should stop sessions first per ADR-141 §D5 sessions-stopped
# invariant). --force bypasses with explicit operator ack.
if [[ $APPLY -eq 1 && $FORCE -eq 0 ]]; then
  running=$(pgrep -af 'claude\b' 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$running" -gt 0 ]]; then
    echo "❌ refusing --apply: $running 'claude' process(es) alive."
    echo "   Stop sessions first OR re-run with --force at your own risk."
    echo "   (sessions-stopped invariant per ADR-141 §D5)"
    exit 1
  fi
fi

# Create canonical store dirs (idempotent).
if [[ $APPLY -eq 1 ]]; then
  mkdir -p "$CANONICAL/memory" "$CANONICAL/skills" "$ARCHIVE_ROOT"
else
  echo "  [DRY] mkdir -p $CANONICAL/memory $CANONICAL/skills $ARCHIVE_ROOT"
fi
echo

# ---- Migrate memory ----

migrate_memory() {
  echo "─── Migrating project memory dirs ───"
  declare -A SLUG_SEEN=()
  for a in "${ACCOUNTS[@]}"; do
    proj_dir="$a/projects"
    [[ -d "$proj_dir" ]] || continue
    while IFS= read -r mem; do
      slug="$(basename "$(dirname "$mem")")"
      SLUG_SEEN[$slug]=1
    done < <(find "$proj_dir" -mindepth 2 -maxdepth 2 -type d -name memory 2>/dev/null)
  done

  if [[ ${#SLUG_SEEN[@]} -eq 0 ]]; then
    echo "  (none — no project memory dirs across any account)"
    return
  fi

  for slug in $(printf '%s\n' "${!SLUG_SEEN[@]}" | sort); do
    process_slug "$slug" "projects" "memory"
  done
}

# ---- Migrate skill workspaces ----

migrate_skills() {
  echo "─── Migrating skill workspace dirs ───"
  declare -A SKILL_SEEN=()
  for a in "${ACCOUNTS[@]}"; do
    skills_dir="$a/skills"
    [[ -d "$skills_dir" ]] || continue
    while IFS= read -r sk; do
      [[ -L "$sk" ]] && continue  # skip plugin-cache symlinks
      name="$(basename "$sk")"
      SKILL_SEEN[$name]=1
    done < <(find "$skills_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
  done

  if [[ ${#SKILL_SEEN[@]} -eq 0 ]]; then
    echo "  (none — no real skill workspace dirs across any account)"
    return
  fi

  for skill in $(printf '%s\n' "${!SKILL_SEEN[@]}" | sort); do
    process_slug "$skill" "skills" ""
  done
}

# Unified slug processor — handles both memory (path = $proj_dir/$slug/memory)
# and skills (path = $skills_dir/$skill). The $sub_kind arg distinguishes:
#   - "projects" → per-account path is $account/projects/$slug/memory
#                  canonical path is $canonical/memory/$slug
#   - "skills"   → per-account path is $account/skills/$slug
#                  canonical path is $canonical/skills/$slug
process_slug() {
  local slug="$1"
  local sub_kind="$2"
  local trailing="$3"  # "memory" for projects, "" for skills

  local canonical_path
  if [[ "$sub_kind" == "projects" ]]; then
    canonical_path="$CANONICAL/memory/$slug"
  else
    canonical_path="$CANONICAL/skills/$slug"
  fi

  # Collect per-account presence.
  local -a real_paths=()
  local -a link_paths=()
  local winner_account=""
  local winner_path=""
  local winner_mtime=0
  for a in "${ACCOUNTS[@]}"; do
    local path
    if [[ "$sub_kind" == "projects" ]]; then
      path="$a/$sub_kind/$slug/$trailing"
    else
      path="$a/$sub_kind/$slug"
    fi
    if [[ -L "$path" ]]; then
      link_paths+=("$path")
    elif [[ -d "$path" ]]; then
      real_paths+=("$path")
      local cnt
      cnt=$(find "$path" -type f 2>/dev/null | wc -l | tr -d ' ')
      if [[ "$cnt" -gt 0 ]]; then
        local latest
        latest=$(find "$path" -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1)
        local latest_int=${latest%.*}
        latest_int=${latest_int:-0}
        if [[ "$latest_int" -gt "$winner_mtime" ]]; then
          winner_mtime=$latest_int
          winner_account="$(basename "$a")"
          winner_path="$path"
        fi
      fi
    fi
  done

  # Idempotent skip: canonical exists AND every real path is a
  # symlink. The link_paths array already captures the symlinks;
  # if real_paths is empty AND canonical exists, we're done.
  if [[ ${#real_paths[@]} -eq 0 && -d "$canonical_path" ]]; then
    log "skip $slug: already migrated (canonical exists, no real dirs)"
    return
  fi

  if [[ -z "$winner_account" ]]; then
    log "skip $slug: no winning content (all empty)"
    return
  fi

  echo
  echo "🔄 $slug"
  echo "   winner: $winner_account (mtime $winner_mtime)"

  # Backup non-winning real paths to archive.
  for p in "${real_paths[@]}"; do
    if [[ "$p" == "$winner_path" ]]; then
      continue
    fi
    local acct
    acct="$(basename "$(echo "$p" | sed -E "s|^$HOMEDIR/(\.[^/]+)/.*|\1|")")"
    local backup_dir="$ARCHIVE_ROOT/$acct/$slug"
    do_op "mkdir -p \"$(dirname "$backup_dir")\""
    do_op "mv \"$p\" \"$backup_dir\""
  done

  # Move winner to canonical (or skip if canonical already exists).
  if [[ -d "$canonical_path" ]]; then
    log "canonical exists for $slug — backing up winner instead of overwriting"
    local acct
    acct="$(basename "$(echo "$winner_path" | sed -E "s|^$HOMEDIR/(\.[^/]+)/.*|\1|")")"
    local backup_dir="$ARCHIVE_ROOT/$acct/$slug"
    do_op "mkdir -p \"$(dirname "$backup_dir")\""
    do_op "mv \"$winner_path\" \"$backup_dir\""
  else
    do_op "mkdir -p \"$(dirname "$canonical_path")\""
    do_op "mv \"$winner_path\" \"$canonical_path\""
  fi

  # Symlink each account's path → canonical.
  for a in "${ACCOUNTS[@]}"; do
    local path
    if [[ "$sub_kind" == "projects" ]]; then
      path="$a/$sub_kind/$slug/$trailing"
    else
      path="$a/$sub_kind/$slug"
    fi
    # Skip if already a symlink to canonical (idempotent).
    if [[ -L "$path" ]]; then
      local target
      target=$(readlink "$path")
      if [[ "$target" == "$canonical_path" ]]; then
        log "$path already symlinks to canonical"
        continue
      fi
      do_op "rm \"$path\""
    fi
    # For "projects" path, the parent dir ($a/projects/$slug) must
    # exist for the symlink at its `memory` subdir to land. Create
    # the slug dir if needed.
    if [[ "$sub_kind" == "projects" ]]; then
      do_op "mkdir -p \"$(dirname "$path")\""
    fi
    do_op "ln -s \"$canonical_path\" \"$path\""
  done
}

# ---- Drive ----

if [[ $MEMORY_ONLY -eq 1 ]]; then
  migrate_memory
elif [[ $SKILL_ONLY -eq 1 ]]; then
  migrate_skills
else
  migrate_memory
  echo
  migrate_skills
fi

echo
echo "─── Done ───"
if [[ $APPLY -eq 1 ]]; then
  echo "✅ migration applied. Archive: $ARCHIVE_ROOT"
  echo "   Next: commit the dotfiles repo changes (canonical store under"
  echo "         _dotfiles/claude-shared/) per ADR-141 deliverable #5–7."
else
  echo "🟡 dry-run complete. Re-run with --apply to execute."
  echo "   Stop sessions first OR pass --force to override (per ADR-141 §D5)."
fi
