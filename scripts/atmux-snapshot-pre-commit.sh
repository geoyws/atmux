#!/usr/bin/env bash
# ADR-244 — per-repo pre-commit kanban + decisions snapshot.
#
# Best-effort hook installed at .git/hooks/pre-commit via
# scripts/install-hooks.sh. Snapshots .atmux/state/kanban.sqlite +
# .atmux/decisions.md + .atmux/decisions/** into the firing commit so a
# fresh machine can `git clone + atmux start` and recover the team's
# kanban / decisions state.
#
# Every line ends in `|| true` — a snapshot hiccup MUST NEVER block the
# operator's underlying commit. The whole feature is a backup safety
# net; failing the firing commit would defeat the safety frame.
#
# Bounded growth: .atmux/decisions.md is rotated to monthly archives by
# the daily `groom` cron (ADR-079, default --decisions-days 30), so the
# live file stays small. Archives are also markdown + git-friendly.
#
# Cross-machine merge of kanban.sqlite is intentionally unsupported —
# this ADR is single-machine machine-death backup, not multi-box sync.

set -u  # no `set -e` — we WANT continuation on individual failures.

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "$repo_root" ]]; then
  # Not in a git repo (e.g. invoked from a sparse worktree). Nothing to
  # snapshot — exit clean so commits still go through.
  exit 0
fi

cd "$repo_root" || exit 0

kanban_db=".atmux/state/kanban.sqlite"
decisions_md=".atmux/decisions.md"
decisions_dir=".atmux/decisions"

# 1. WAL checkpoint — collapse any pending writes into the main file so
#    the .sqlite blob is self-consistent without the .sqlite-wal /
#    .sqlite-shm sidecars. TRUNCATE mode discards the WAL after merge.
#    Best-effort: missing sqlite3 binary or absent DB → continue.
if [[ -f "$kanban_db" ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$kanban_db" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
fi

# 2. Force-add recovery-relevant files. `-f` overrides any leftover
#    gitignore exclusion (the parent's `.atmux/*` rule still wins for
#    files NOT explicitly carved out, which is exactly what we want).
#    Each `git add` is independent so a missing file doesn't cascade.
[[ -f "$kanban_db" ]]    && git add -f "$kanban_db"    >/dev/null 2>&1 || true
[[ -f "$decisions_md" ]] && git add -f "$decisions_md" >/dev/null 2>&1 || true
[[ -d "$decisions_dir" ]] && git add -f "$decisions_dir" >/dev/null 2>&1 || true

# Always exit 0 — see header rationale.
exit 0
