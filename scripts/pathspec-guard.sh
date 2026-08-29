#!/usr/bin/env bash
# pathspec-guard.sh — refuse a commit whose staged paths escape the Task's pathspec
#
# ADR-0058 (b). The failure this prevents is concrete and recurring: a
# lint-staged sweep, or a plain `git commit` over an index someone else already
# added to, absorbs a SIBLING teammate's files into the committer's commit. It
# was measured at 3 incidents in 6 hours on u-n-u-m/root, and every recovery was
# a soft-reset the committer had to notice they needed.
#
# The guard is the structural half of that defence: a Task body declares which
# files it may touch, and a commit that stages anything outside them stops.
#
# WHERE THE PATHSPEC COMES FROM, first match wins:
#   1. --body-file <path>        an explicit Task body (what the tests use)
#   2. $ATMUX_TASK_BODY          the body inline in the environment
#   3. ~/.atmux/state/<member>-claim.json  the member's last claim ($ATMUX_MEMBER)
#
# It is read out of a '## Files' section — markdown bullets, or a fenced block
# directly under the heading. Both shapes appear in real Task bodies, so both
# parse.
#
# NO PATHSPEC IS NOT A VIOLATION. A Task that never declared one cannot be
# judged against it, and failing those closed would block every legacy Task on
# the board. It warns and exits 0, which is also what makes this safe to adopt
# before every Task carries a '## Files' section.
#
# Usage:
#   scripts/pathspec-guard.sh                      # guard the current index
#   scripts/pathspec-guard.sh --body-file task.md  # explicit body
#   scripts/pathspec-guard.sh --staged-from -      # read staged paths on stdin
#
# Exit codes:
#   0 — clean, or no pathspec to judge against, or opted out
#   1 — at least one staged path escapes the pathspec
#   2 — usage error
#
# Opt-out: ATMUX_PATHSPEC_GUARD=off. It is AUDITED, not silent — a recovery
# commit is a legitimate reason to bypass, and hiding that it happened is not.
set -euo pipefail

BODY_FILE=""
STAGED_FROM=""
AUDIT_LOG="${ATMUX_PATHSPEC_AUDIT:-${HOME}/.atmux/logs/pathspec-guard.jsonl}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
    --staged-from) STAGED_FROM="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) printf 'pathspec-guard: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

audit() {
  local verdict="$1" detail="$2"
  mkdir -p "$(dirname "$AUDIT_LOG")" 2>/dev/null || return 0
  printf '{"at":"%s","verdict":"%s","member":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verdict" "${ATMUX_MEMBER:-unknown}" "$detail" \
    >>"$AUDIT_LOG" 2>/dev/null || true
}

if [[ "${ATMUX_PATHSPEC_GUARD:-on}" == "off" ]]; then
  printf 'pathspec-guard: DISABLED via ATMUX_PATHSPEC_GUARD=off (audited)\n' >&2
  audit "opted-out" "ATMUX_PATHSPEC_GUARD=off"
  exit 0
fi

# ── resolve the Task body ────────────────────────────────────────────────────
body=""
if [[ -n "$BODY_FILE" ]]; then
  [[ -f "$BODY_FILE" ]] || { printf 'pathspec-guard: no such body file: %s\n' "$BODY_FILE" >&2; exit 2; }
  body="$(cat "$BODY_FILE")"
elif [[ -n "${ATMUX_TASK_BODY:-}" ]]; then
  body="$ATMUX_TASK_BODY"
elif [[ -n "${ATMUX_MEMBER:-}" && -f "${HOME}/.atmux/state/${ATMUX_MEMBER}-claim.json" ]]; then
  body="$(sed -n 's/.*"body"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' \
    "${HOME}/.atmux/state/${ATMUX_MEMBER}-claim.json" | head -1)"
fi

# ── parse the '## Files' section ─────────────────────────────────────────────
# Bullets and fenced lines both count. A bullet may carry trailing prose after
# the path (real bodies annotate them), so only the first token is taken, and
# backticks are stripped because paths are usually written as code spans.
pathspec="$(
  printf '%s\n' "$body" \
    | awk '
        /^##[[:space:]]+Files/ { inside = 1; next }
        inside && /^##[[:space:]]/ { inside = 0 }
        inside { print }
      ' \
    | sed -e 's/^[[:space:]]*[-*][[:space:]]*//' -e 's/^[[:space:]]*//' \
    | tr -d '`' \
    | awk '{ print $1 }' \
    | grep -vE '^(```|$)' \
    | grep -vE '^[A-Za-z].*:$' \
    || true
)"

if [[ -z "$pathspec" ]]; then
  printf 'pathspec-guard: no "## Files" pathspec on this Task — nothing to verify\n' >&2
  audit "no-pathspec" "task declared no Files section"
  exit 0
fi

# ── the staged set ───────────────────────────────────────────────────────────
if [[ "$STAGED_FROM" == "-" ]]; then
  staged="$(cat)"
elif [[ -n "$STAGED_FROM" ]]; then
  staged="$(cat "$STAGED_FROM")"
else
  staged="$(git diff --cached --name-only)"
fi

[[ -n "$staged" ]] || { printf 'pathspec-guard: nothing staged\n' >&2; exit 0; }

# ── verify ───────────────────────────────────────────────────────────────────
violations=()
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  ok=0
  while IFS= read -r glob; do
    [[ -n "$glob" ]] || continue
    # A directory entry covers everything beneath it; otherwise it is a glob.
    if [[ "$path" == "$glob" ]] || [[ "$path" == $glob ]] || [[ "$path" == "${glob%/}/"* ]]; then
      ok=1; break
    fi
  done <<<"$pathspec"
  (( ok )) || violations+=("$path")
done <<<"$staged"

if (( ${#violations[@]} )); then
  {
    printf 'pathspec-guard: %d staged path(s) are NOT in this Task'"'"'s pathspec:\n' "${#violations[@]}"
    printf '  %s\n' "${violations[@]}"
    printf '\nThe Task declares:\n'
    printf '  %s\n' $pathspec
    printf '\nThis is the sibling-absorption guard (ADR-0058 b). Either unstage what\n'
    printf 'is not yours (git restore --staged <path>), or add the path to the Task'"'"'s\n'
    printf '## Files section if it genuinely belongs to this Task.\n'
    printf 'Legitimate recovery commit? ATMUX_PATHSPEC_GUARD=off (audited to %s).\n' "$AUDIT_LOG"
  } >&2
  audit "blocked" "$(printf '%s ' "${violations[@]}")"
  command -v atmux >/dev/null 2>&1 && atmux flag add "pathspec-guard blocked ${#violations[@]} path(s)" >/dev/null 2>&1 || true
  exit 1
fi

printf 'pathspec-guard: clean (%s staged path(s) within the Task pathspec)\n' "$(printf '%s\n' "$staged" | grep -c .)"
exit 0
