#!/usr/bin/env bash
# scripts/deploy-docs.sh — atmux docs site cron-pulled deploy.
#
# Pulls main HEAD of the atmux repo, copies README + CHANGELOG into docs/,
# runs `vitepress build`, syncs output to /var/www/atmux-docs/.
#
# Idempotent. Safe to run on every cron tick.
#
# Usage (cron-friendly):
#   */15 * * * * /root/work/src/atmux/.claude/worktrees/atmux-bun/scripts/deploy-docs.sh \
#       >> /var/log/atmux-docs-deploy.log 2>&1
#
# Tracked branch: main (NOT worktree-atmux-bun — we publish shipped reality,
# not in-flight ports). Override via DOCS_BRANCH env var if needed.
#
# Driver-coordinated: lives in repo, runs on hax. Not auto-installed; see
# docs/RUNBOOK-hosting.md for installation.

set -euo pipefail

# --- config (env-overridable) ---
readonly REPO_DIR="${ATMUX_DOCS_REPO_DIR:-/root/work/src/atmux}"
readonly WORKTREE_DIR="${ATMUX_DOCS_WORKTREE:-${REPO_DIR}/.claude/worktrees/atmux-bun}"
readonly DOCS_BRANCH="${ATMUX_DOCS_BRANCH:-main}"
readonly OUT_DIR="${ATMUX_DOCS_OUT:-/var/www/atmux-docs}"
readonly LOCK_FILE="${ATMUX_DOCS_LOCK:-/var/lock/atmux-docs-deploy.lock}"

# --- helpers ---
log() {
  printf '[%s] %s\n' "$(TZ='Asia/Kuala_Lumpur' date +'%Y-%m-%d %H:%M:%S MYT')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

# --- single-instance lock ---
exec 9>"$LOCK_FILE" || die "cannot open lock file $LOCK_FILE"
if ! flock -n 9; then
  log "another deploy in flight; skipping this tick"
  exit 0
fi

# --- preflight ---
[[ -d "$REPO_DIR/.git" ]] || die "REPO_DIR=$REPO_DIR is not a git repo"
[[ -d "$WORKTREE_DIR" ]] || die "WORKTREE_DIR=$WORKTREE_DIR not found"
command -v bun >/dev/null || die "bun not on PATH (mise activate?)"
command -v rsync >/dev/null || die "rsync missing"

cd "$REPO_DIR"

# --- 1. fetch + check tip ---
log "fetching origin..."
git fetch --quiet origin "$DOCS_BRANCH" || die "git fetch failed"

local_tip="$(git rev-parse "origin/$DOCS_BRANCH")"
last_built_file="$WORKTREE_DIR/.atmux/state/docs-last-built.sha"
last_built="$(cat "$last_built_file" 2>/dev/null || true)"

if [[ "$local_tip" == "$last_built" ]]; then
  log "no change since last build ($local_tip); skipping"
  exit 0
fi

log "deploying $DOCS_BRANCH @ $local_tip (last built: ${last_built:-none})"

# --- 2. checkout main contents into a temp staging dir ---
# We build from a worktree of the tracked branch — keeps the active
# worktree-atmux-bun untouched.
staging="$(mktemp -d -t atmux-docs-build.XXXXXX)"
trap 'rm -rf "$staging"' EXIT

git --work-tree="$staging" checkout "$DOCS_BRANCH" -- .
log "checked out $DOCS_BRANCH into $staging"

# --- 3. mirror README + CHANGELOG into docs/ for vitepress ---
# vitepress reads docs/ as srcDir; root-level README/CHANGELOG aren't
# served otherwise. Copy is build-only — never committed back.
[[ -f "$staging/README.md" ]] && cp "$staging/README.md" "$staging/docs/README.md"
[[ -f "$staging/CHANGELOG.md" ]] && cp "$staging/CHANGELOG.md" "$staging/docs/CHANGELOG.md"

# --- 4. install + build ---
cd "$staging"
log "installing deps..."
bun install --frozen-lockfile --silent || die "bun install failed"

log "building docs..."
bun run docs:build || die "vitepress build failed"

build_out="$staging/docs/.vitepress/dist"
[[ -d "$build_out" ]] || die "build output missing at $build_out"

# --- 5. atomic sync to OUT_DIR ---
mkdir -p "$OUT_DIR"
log "syncing to $OUT_DIR..."
rsync -a --delete \
  --exclude='.well-known' \
  "$build_out/" "$OUT_DIR/"

# --- 6. record success ---
mkdir -p "$(dirname "$last_built_file")"
printf '%s\n' "$local_tip" > "$last_built_file"

log "deploy OK: $local_tip → $OUT_DIR"
