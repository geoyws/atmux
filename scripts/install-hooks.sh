#!/usr/bin/env bash
# ADR-244 — one-shot installer for the atmux pre-commit snapshot hook.
#
# Run once per repo (atmux's own + each parent team's repo) to install
# the kanban + decisions snapshot pre-commit hook. Idempotent — re-runs
# detect the existing install + report no-op.
#
# Resolution of the hook source: this script is co-located with
# `atmux-snapshot-pre-commit.sh` under `<atmux-repo>/scripts/`. When
# installed in a non-atmux repo (e.g. sopx-root, unum/root), callers
# invoke this installer via its absolute path:
#
#     bash /root/work/src/atmux/scripts/install-hooks.sh
#
# The script reads its own dirname to locate the hook source, so the
# target repo's CWD only matters for `.git/hooks/` resolution.
#
# Refuses to clobber an existing non-atmux pre-commit hook — operator
# must remove or merge their existing hook manually before re-running.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook_src="$script_dir/atmux-snapshot-pre-commit.sh"

if [[ ! -f "$hook_src" ]]; then
  echo "install-hooks: hook source missing at $hook_src" >&2
  exit 1
fi

# Find the target .git/hooks directory in the current working tree.
git_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -z "$git_dir" ]]; then
  echo "install-hooks: not inside a git repository (run from the target repo's root)" >&2
  exit 1
fi

# git rev-parse may return a relative path — resolve to absolute.
if [[ "$git_dir" != /* ]]; then
  git_dir="$(cd "$git_dir" && pwd)"
fi

hooks_dir="$git_dir/hooks"
hook_dst="$hooks_dir/pre-commit"

mkdir -p "$hooks_dir"

# Marker line embedded in our hook source so we can recognize a prior
# atmux-installed hook + safely re-install.
marker="ADR-244 — per-repo pre-commit kanban + decisions snapshot"

if [[ -e "$hook_dst" ]] || [[ -L "$hook_dst" ]]; then
  # Existing hook — check whether it's ours.
  if [[ -L "$hook_dst" ]]; then
    target="$(readlink "$hook_dst")"
    if [[ "$target" == "$hook_src" ]]; then
      echo "install-hooks: pre-commit already symlinks to $hook_src — no-op"
      exit 0
    fi
  elif grep -qF "$marker" "$hook_dst" 2>/dev/null; then
    # Plain-file install (symlink not available); refresh contents in-place.
    cp "$hook_src" "$hook_dst"
    chmod +x "$hook_dst"
    echo "install-hooks: pre-commit refreshed (plain-file install) at $hook_dst"
    exit 0
  fi
  echo "install-hooks: refused — existing non-atmux pre-commit hook at $hook_dst" >&2
  echo "                remove or merge the existing hook + re-run, or set ATMUX_INSTALL_HOOKS_FORCE=1 to overwrite." >&2
  if [[ "${ATMUX_INSTALL_HOOKS_FORCE:-0}" != "1" ]]; then
    exit 1
  fi
  echo "install-hooks: ATMUX_INSTALL_HOOKS_FORCE=1 — clobbering existing hook." >&2
fi

# Prefer symlink (zero-cost refresh + visible source); fall back to copy
# if symlink fails (filesystem doesn't support, e.g. some FAT shares).
if ln -sf "$hook_src" "$hook_dst" 2>/dev/null; then
  echo "install-hooks: pre-commit symlinked → $hook_src"
else
  cp "$hook_src" "$hook_dst"
  chmod +x "$hook_dst"
  echo "install-hooks: pre-commit copied to $hook_dst (filesystem does not support symlinks)"
fi
