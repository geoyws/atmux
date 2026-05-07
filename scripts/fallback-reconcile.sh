#!/usr/bin/env bash
# scripts/fallback-reconcile.sh — ADR-058 §D5: operator-manual reconciliation.
#
# Diffs a Tier 3+ cage workspace against the project worktree, prompts
# the operator per delta (y/n/d/q), and rsyncs ACCEPTED deltas into the
# operator-owned worktree as the OPERATOR's UID (not the agent's). After
# reconcile, the operator picks up at the standard git workflow.
#
# Per ADR-058 §OQ4: v1 ships interactive-only. `--accept <glob>` is a
# v1.1 feature gate.
#
# Tier 2 (operator-UID cage) does NOT have a separate reconcile path —
# the agent operated directly in the operator's worktree, so reconcile
# is implicit (commits already on the branch). Calling with --tier 2
# prints a no-op message + exits 0.
#
# Idempotence: re-running on an already-reconciled cage produces a
# 'no deltas' message + exit 0. Same diff invocation against identical
# trees yields no output.
#
# Usage:
#   scripts/fallback-reconcile.sh <team> <lane>
#   scripts/fallback-reconcile.sh <team> <lane> --tier <2|3|4>
#   scripts/fallback-reconcile.sh --help
#
# Env (test/CI overrides):
#   ATMUX_RECONCILE_PROJECT_ROOT  override project root (default <script>/..)
#   ATMUX_RECONCILE_HOME_PREFIX   override /home (default /home; tests use tmpdir)
#   ATMUX_RECONCILE_SUDO          override sudo command (default sudo)
#   ATMUX_RECONCILE_INPUT         input source for prompts (default /dev/tty)
#   ATMUX_RECONCILE_DIFF          override `diff` (default diff)
#   ATMUX_RECONCILE_AGENT         override agent name (test only — bypasses tier→agent)

set -euo pipefail

# ---------- defaults ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PROJECT_ROOT="${ATMUX_RECONCILE_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
readonly PROJECT_ROOT
readonly HOME_PREFIX="${ATMUX_RECONCILE_HOME_PREFIX:-/home}"
readonly SUDO_CMD="${ATMUX_RECONCILE_SUDO:-sudo}"
readonly INPUT_SRC="${ATMUX_RECONCILE_INPUT:-/dev/tty}"
readonly DIFF_CMD="${ATMUX_RECONCILE_DIFF:-diff}"
readonly AGENT_OVERRIDE="${ATMUX_RECONCILE_AGENT:-}"

# Cage-context files that the cage builder injects (per fallback-cage.ts
# buildTier3PlusWorkspace). These are read-only references for the agent
# and MUST NOT be reconciled back into the project tree.
readonly -a CAGE_CONTEXT_FILES=("_history.log" "_status.log" "_branch.log")

TIER=""
TEAM=""
LANE=""

# ---------- helpers ----------
log() {
  printf '[%s] %s\n' "$(TZ='Asia/Kuala_Lumpur' date +'%Y-%m-%d %H:%M:%S MYT')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit "${EXIT_CODE:-1}"
}

usage() {
  cat <<'EOF'
fallback-reconcile.sh — ADR-058 §D5 operator-manual reconciliation.

USAGE:
  scripts/fallback-reconcile.sh <team> <lane>
  scripts/fallback-reconcile.sh <team> <lane> --tier <2|3|4>
  scripts/fallback-reconcile.sh --help

ARGS:
  <team>   atmux team name (matches team.json::name)
  <lane>   logical lane / cage identity (matches CageHandle.lane)
  --tier   explicit tier when ambiguous (auto-detected if omitted)

INTERACTIVE PROMPT (per delta):
  y  accept — bring the cage's version into the project worktree
  n  skip   — leave the operator's worktree as-is
  d  view-diff — print unified diff, then re-prompt
  q  abort  — exit immediately, leaving any prior accepts applied

OPERATOR-DRIVEN. Sudo required for Tier 3+ (reads from agent home).
EOF
}

# tier→agent map (mirrors fallback-cage.ts TIER_AGENT).
agent_for_tier() {
  case "$1" in
    2) echo "operator" ;;
    3) echo "kimi-agent" ;;
    4) echo "minimax-agent" ;;
    *) die "unknown tier: $1" ;;
  esac
}

# ---------- argv parse ----------
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --tier)
      [[ $# -ge 2 ]] || EXIT_CODE=2 die "--tier requires a value"
      TIER="$2"; shift 2 ;;
    --) shift; break ;;
    -*) EXIT_CODE=2 die "unknown flag: $1" ;;
    *)
      if [[ -z "$TEAM" ]]; then
        TEAM="$1"
      elif [[ -z "$LANE" ]]; then
        LANE="$1"
      else
        EXIT_CODE=2 die "extra positional arg: $1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$TEAM" || -z "$LANE" ]]; then
  usage >&2
  exit 2
fi

# Validate team + lane against the same charset provision-fallback-user
# uses for the agent — short, lower-snake-ish, no shell metacharacters.
for arg_name in TEAM LANE; do
  v="${!arg_name}"
  if [[ ! "$v" =~ ^[a-z0-9][a-z0-9._-]{0,62}$ ]]; then
    EXIT_CODE=2 die "invalid $arg_name: $v (must match ^[a-z0-9][a-z0-9._-]{0,62}\$)"
  fi
done

# Tier validation.
if [[ -n "$TIER" ]]; then
  case "$TIER" in
    2|3|4) ;;
    *) EXIT_CODE=2 die "invalid --tier: $TIER (must be 2, 3, or 4)" ;;
  esac
else
  # Auto-detect: try Tier 3 first (most common), fall back to Tier 4.
  for try_tier in 3 4; do
    try_agent="$(agent_for_tier "$try_tier")"
    if [[ -n "$AGENT_OVERRIDE" ]]; then try_agent="$AGENT_OVERRIDE"; fi
    if [[ -d "$HOME_PREFIX/$try_agent/cages/${TEAM}-${LANE}/work" ]]; then
      TIER="$try_tier"
      break
    fi
  done
  if [[ -z "$TIER" ]]; then
    die "could not auto-detect tier for ${TEAM}/${LANE} — pass --tier explicitly"
  fi
fi

readonly TIER TEAM LANE

# Resolve agent identity.
AGENT="$(agent_for_tier "$TIER")"
if [[ -n "$AGENT_OVERRIDE" ]]; then AGENT="$AGENT_OVERRIDE"; fi
readonly AGENT

# ---------- Tier 2 fast path (no reconcile needed) ----------
if [[ "$AGENT" == "operator" ]]; then
  log "Tier 2 (operator-UID cage) — no reconcile needed."
  log "Tier 2 cages operate directly on the project worktree; commits"
  log "are already on the working branch. Inspect with \`git log\` /"
  log "\`git status\`."
  exit 0
fi

# ---------- locate cage workspace ----------
CAGE_DIR="$HOME_PREFIX/$AGENT/cages/${TEAM}-${LANE}/work"
readonly CAGE_DIR

log "fallback-reconcile: team=$TEAM lane=$LANE tier=$TIER agent=$AGENT"
log "  cage:    $CAGE_DIR"
log "  project: $PROJECT_ROOT"

# Sanity-check cage exists. Use sudo because cage is under agent's chmod-700 home.
if ! "$SUDO_CMD" -u "$AGENT" test -d "$CAGE_DIR"; then
  die "cage workspace not found at $CAGE_DIR (was the cage spawned for ${TEAM}/${LANE}?)"
fi
[[ -d "$PROJECT_ROOT" ]] || die "PROJECT_ROOT=$PROJECT_ROOT not a directory"

# ---------- diff-rq classify ----------
# Run diff as the agent so it can read the cage tree; agent has rX on the
# project root via setfacl, so reading project-side is fine in the same
# subprocess. Suppress diff's exit=1 (means "differences found") via `|| true`
# but preserve real failures (exit=2).
diff_run() {
  local out rc
  set +e
  out="$("$SUDO_CMD" -u "$AGENT" "$DIFF_CMD" -rq "$CAGE_DIR" "$PROJECT_ROOT" 2>&1)"
  rc=$?
  set -e
  case "$rc" in
    0|1) printf '%s\n' "$out" ;;
    *)   die "diff invocation failed (rc=$rc): $out" ;;
  esac
}

is_cage_context_file() {
  local relpath="$1"
  for ctx in "${CAGE_CONTEXT_FILES[@]}"; do
    [[ "$relpath" == "$ctx" ]] && return 0
  done
  return 1
}

# Classify each diff line into ADDED / MODIFIED / DELETED tuples.
#
# Output format (one delta per line, tab-separated):
#   <CLASS>\t<rel-path>
#
# CLASS ∈ {ADDED, MODIFIED, DELETED}
classify_deltas() {
  local diff_out="$1"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
      "Only in $CAGE_DIR"*)
        # Format: "Only in <cage>: filename"
        # Strip prefix to get relative path.
        local rest="${line#Only in $CAGE_DIR}"
        rest="${rest#: }"     # collapse the colon+space
        rest="${rest#/}"      # strip leading / if present
        # If the "Only in" path is a subdirectory, format is
        # "Only in <cage>/sub: file" — combine sub + file:
        local subdir="${rest%%:*}"
        local fname="${rest##*: }"
        local relpath
        if [[ "$subdir" == "$rest" ]]; then
          # No `:` in rest — file at cage root
          relpath="$rest"
        else
          relpath="${subdir}/${fname}"
        fi
        is_cage_context_file "$relpath" && continue
        printf 'ADDED\t%s\n' "$relpath"
        ;;
      "Only in $PROJECT_ROOT"*)
        local rest="${line#Only in $PROJECT_ROOT}"
        rest="${rest#: }"
        rest="${rest#/}"
        local subdir="${rest%%:*}"
        local fname="${rest##*: }"
        local relpath
        if [[ "$subdir" == "$rest" ]]; then
          relpath="$rest"
        else
          relpath="${subdir}/${fname}"
        fi
        is_cage_context_file "$relpath" && continue
        printf 'DELETED\t%s\n' "$relpath"
        ;;
      "Files $CAGE_DIR/"*" and $PROJECT_ROOT/"*" differ")
        # "Files <cage>/path and <project>/path differ"
        local stripped="${line#Files $CAGE_DIR/}"
        local relpath="${stripped%% and *}"
        is_cage_context_file "$relpath" && continue
        printf 'MODIFIED\t%s\n' "$relpath"
        ;;
      *)
        # Unrecognised diff output (e.g., binary-file marker) — skip with warn.
        log "WARN: unrecognised diff line: $line"
        ;;
    esac
  done <<< "$diff_out"
}

# ---------- per-delta apply ----------

# Read content from the cage as the agent and write into the project as
# the operator. Result file is operator-owned.
apply_added_or_modified() {
  local relpath="$1"
  local cage_path="$CAGE_DIR/$relpath"
  local project_path="$PROJECT_ROOT/$relpath"
  local parent
  parent="$(dirname "$project_path")"
  mkdir -p "$parent"
  # Read via sudo cat (agent UID), redirect into operator-owned file.
  "$SUDO_CMD" -u "$AGENT" cat "$cage_path" > "$project_path"
  # Preserve mode if readable (chmod --reference handles non-readable
  # files via stat metadata sudo grants).
  local mode
  mode="$("$SUDO_CMD" -u "$AGENT" stat -c '%a' "$cage_path" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" =~ ^[0-7]+$ ]]; then
    chmod "$mode" "$project_path" 2>/dev/null || true
  fi
}

apply_deleted() {
  local relpath="$1"
  local project_path="$PROJECT_ROOT/$relpath"
  rm -f "$project_path"
}

show_diff() {
  local relpath="$1"
  local cage_path="$CAGE_DIR/$relpath"
  local project_path="$PROJECT_ROOT/$relpath"
  printf -- '--- diff: %s ---\n' "$relpath"
  set +e
  "$SUDO_CMD" -u "$AGENT" "$DIFF_CMD" -u "$project_path" "$cage_path" || true
  set -e
  printf -- '--- end diff ---\n'
}

# ---------- main loop ----------
DIFF_OUT="$(diff_run)"

if [[ -z "$DIFF_OUT" ]]; then
  log "no deltas — cage workspace matches project worktree (idempotent re-run OK)"
  exit 0
fi

DELTAS="$(classify_deltas "$DIFF_OUT")"

if [[ -z "$DELTAS" ]]; then
  log "no actionable deltas (only cage-context files differ)"
  exit 0
fi

DELTA_COUNT=$(printf '%s\n' "$DELTAS" | wc -l | tr -d ' ')
log "found $DELTA_COUNT delta(s) — entering interactive prompt"
printf '\n'

ACCEPTED=0
SKIPPED=0
ABORTED=0

# Open the input source on FD 3 once so consecutive reads advance the
# file position. Re-opening per `read` (via `< "$INPUT_SRC"`) resets to
# position 0 each call and answers the same question repeatedly.
exec 3<"$INPUT_SRC"

while IFS=$'\t' read -r CLASS RELPATH; do
  [[ -z "$CLASS" ]] && continue
  while true; do
    printf '[%s] %s — accept (y) / skip (n) / view-diff (d) / abort (q)? ' \
      "$CLASS" "$RELPATH"
    if ! IFS= read -r ANS <&3; then
      printf '\n'
      log "input closed; aborting"
      ABORTED=1
      break 2
    fi
    case "$ANS" in
      y|Y)
        case "$CLASS" in
          ADDED|MODIFIED) apply_added_or_modified "$RELPATH" ;;
          DELETED)        apply_deleted "$RELPATH" ;;
        esac
        log "  applied: $CLASS $RELPATH"
        ACCEPTED=$((ACCEPTED + 1))
        break
        ;;
      n|N)
        log "  skipped: $CLASS $RELPATH"
        SKIPPED=$((SKIPPED + 1))
        break
        ;;
      d|D)
        if [[ "$CLASS" == "MODIFIED" ]]; then
          show_diff "$RELPATH"
        else
          log "  view-diff only meaningful for MODIFIED; current class=$CLASS"
        fi
        # re-prompt
        ;;
      q|Q)
        log "  aborted at: $CLASS $RELPATH"
        ABORTED=1
        break 2
        ;;
      *)
        printf '  invalid answer (y/n/d/q)\n'
        ;;
    esac
  done
done <<< "$DELTAS"

printf '\n'
if [[ "$ABORTED" -eq 1 ]]; then
  log "aborted: accepted=$ACCEPTED skipped=$SKIPPED (deltas remaining unprocessed)"
  exit 3
fi

log "reconcile complete: accepted=$ACCEPTED skipped=$SKIPPED"
log "next step: \`git status\` in $PROJECT_ROOT to review staged-but-uncommitted state"
