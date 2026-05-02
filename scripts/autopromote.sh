#!/usr/bin/env bash
# scripts/autopromote.sh — hourly cron job: pull origin/<branch> into an isolated
# staging tree, run the test suite, rsync to /opt/atmux-stable IF tests don't
# regress vs the last successful promote. Discord-pings outcome.
#
# Override branch via ATMUX_PROMOTE_BRANCH env (default: main).
#
# Why isolated staging tree (not pulling /root/work/src/atmux directly):
#   - /root/work/src/atmux is the live atmux dogfooding team's worktree.
#     `git pull` there would clobber the team's in-flight uncommitted work
#     (workers stage files between commits via the pre-commit MM trap).
#   - Promote pipeline owns its own checkout at /root/.atmux-promote-staging/.
#     Idempotent: clones on first run, fetch+reset --hard origin/$BRANCH after.
#
# Failure budget — promote ABORTS when:
#   - Test fail count > baseline fail count (last successfully promoted SHA's
#     test result). Pre-existing flakes don't block; net-new ones do.
#   - rsync fails (filesystem error, permission, etc).
#
# Idempotent re-runs: same-SHA-as-last-examined → exit immediately (no test
# re-run, no Discord spam). Only re-tests when origin/$BRANCH moves.

set -euo pipefail

# ---- Config (override-able via env) ----
PROMOTE_TREE="${ATMUX_PROMOTE_TREE:-/root/.atmux-promote-staging}"
STABLE_TREE="${ATMUX_STABLE_TREE:-/opt/atmux-stable}"
DEV_ATMUX_DIR="${ATMUX_DEV_DIR:-/root/work/src/atmux/.atmux}"
LOG="${ATMUX_PROMOTE_LOG:-$DEV_ATMUX_DIR/logs/autopromote.log}"
LOCK="${ATMUX_PROMOTE_LOCK:-/var/lock/atmux-autopromote.lock}"
LAST_PROMOTED_SHA_FILE="${ATMUX_PROMOTE_LAST_PROMOTED:-/root/.atmux-promote-last-promoted-sha}"
LAST_EXAMINED_SHA_FILE="${ATMUX_PROMOTE_LAST_EXAMINED:-/root/.atmux-promote-last-examined-sha}"
TEST_LOG_DIR="${ATMUX_PROMOTE_TEST_LOG_DIR:-$DEV_ATMUX_DIR/logs}"
REPO_URL="${ATMUX_REPO_URL:-https://github.com/geoyws/atmux.git}"
BRANCH="${ATMUX_PROMOTE_BRANCH:-main}"

mkdir -p "$(dirname "$LOG")" "$TEST_LOG_DIR"

ts() { TZ='Asia/Kuala_Lumpur' date +'%Y-%m-%d %H:%M MYT'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" | tee -a "$LOG"; }

# Discord webhook resolved from atmux team's team.json (.discord.webhook).
# Honors $ATMUX_DISCORD_WEBHOOK env override (matches lib/discord.sh pattern).
discord_webhook() {
  if [[ -n "${ATMUX_DISCORD_WEBHOOK:-}" ]]; then
    printf '%s' "$ATMUX_DISCORD_WEBHOOK"; return
  fi
  local tj="$DEV_ATMUX_DIR/team.json"
  [[ -f "$tj" ]] || return 0
  jq -r '.discord.webhook // empty' "$tj" 2>/dev/null
}

discord_notify() {
  local hook; hook=$(discord_webhook)
  [[ -z "$hook" ]] && return 0
  command -v jq >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -sS --max-time 10 -H 'Content-Type: application/json' \
    -d "$(jq -n --arg c "$1" '{content: $c}')" \
    "$hook" >/dev/null 2>&1 || true
}

# ---- Single-run lock — exit cleanly if previous run still in progress.
# Tests can take 30+ min; cron fires hourly. flock -n is the natural fit.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another autopromote run is in progress — exiting"
  exit 0
fi

# ---- Step 1: prepare promote tree (clone or fetch+reset).
if [[ ! -d "$PROMOTE_TREE/.git" ]]; then
  log "first run — cloning $REPO_URL → $PROMOTE_TREE"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$PROMOTE_TREE"
fi

git -C "$PROMOTE_TREE" fetch --quiet origin "$BRANCH"
git -C "$PROMOTE_TREE" reset --hard --quiet "origin/$BRANCH"

new_sha=$(git -C "$PROMOTE_TREE" rev-parse HEAD)
last_examined=$(cat "$LAST_EXAMINED_SHA_FILE" 2>/dev/null || echo "")
last_promoted=$(cat "$LAST_PROMOTED_SHA_FILE" 2>/dev/null || echo "")

# ---- Step 2: short-circuit if we already examined this SHA (no spam).
if [[ "$new_sha" == "$last_examined" ]]; then
  exit 0
fi

if [[ -n "$last_promoted" ]]; then
  n_new=$(git -C "$PROMOTE_TREE" log --oneline "$last_promoted..HEAD" 2>/dev/null | wc -l)
  log "origin/$BRANCH at $new_sha — $n_new commit(s) since last promote ($last_promoted)"
else
  log "origin/$BRANCH at $new_sha — no prior promote, this is the first attempt"
fi

# ---- Step 3: run tests.
test_log="$TEST_LOG_DIR/autopromote-test-$new_sha.log"
log "running tests/run.sh (logging → $test_log)"
test_exit=0
(cd "$PROMOTE_TREE" && bash tests/run.sh > "$test_log" 2>&1) || test_exit=$?
fail_count=$(grep -cE '^not ok ' "$test_log" 2>/dev/null || echo 0)
pass_count=$(grep -cE '^ok ' "$test_log" 2>/dev/null || echo 0)
log "tests: $pass_count pass / $fail_count fail (exit=$test_exit)"

# Stamp examined SHA — we did the work, future hourly runs short-circuit.
echo "$new_sha" > "$LAST_EXAMINED_SHA_FILE"

# ---- Step 4: baseline regression check.
baseline_fail=0
new_failure_sample=""
if [[ -n "$last_promoted" ]]; then
  baseline_log="$TEST_LOG_DIR/autopromote-test-$last_promoted.log"
  if [[ -f "$baseline_log" ]]; then
    baseline_fail=$(grep -cE '^not ok ' "$baseline_log" 2>/dev/null || echo 0)
  fi
fi

if (( fail_count > baseline_fail )); then
  delta=$(( fail_count - baseline_fail ))
  log "ABORT: +$delta net-new failures vs baseline ($baseline_fail → $fail_count)"

  # Sample the new failures (subjects only, dedup'd).
  if [[ -f "${baseline_log:-}" ]]; then
    new_failure_sample=$(diff \
      <(grep -E '^not ok ' "$baseline_log" 2>/dev/null | sed 's/^not ok [0-9]* //' | sort -u) \
      <(grep -E '^not ok ' "$test_log"     2>/dev/null | sed 's/^not ok [0-9]* //' | sort -u) \
      | grep '^>' | head -5 | sed 's/^> /  - /')
  else
    new_failure_sample=$(grep -E '^not ok ' "$test_log" | sed 's/^not ok [0-9]* /  - /' | head -5)
  fi

  log "new failure sample:"
  printf '%s\n' "$new_failure_sample" | tee -a "$LOG"

  discord_notify "🚨 **[autopromote-abort]** $(ts)
SHA \`${new_sha:0:7}\` — \`$new_sha\`
**$delta** net-new failures vs baseline ($baseline_fail → $fail_count)
First few:
\`\`\`
$new_failure_sample
\`\`\`
Stable NOT updated. Investigate via \`tests/run.sh\` locally."
  exit 1
fi

# ---- Step 5: rsync promote.
log "promoting $new_sha → $STABLE_TREE"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.atmux/' \
  --exclude='tests/' \
  --exclude='.gitignore' \
  --exclude='scripts/' \
  "$PROMOTE_TREE/" "$STABLE_TREE/" >> "$LOG" 2>&1

echo "$new_sha" > "$LAST_PROMOTED_SHA_FILE"

# ---- Step 6: outcome ping.
shipped_log=""
if [[ -n "$last_promoted" ]]; then
  shipped_log=$(git -C "$PROMOTE_TREE" log --oneline "$last_promoted..HEAD" | head -10 | sed 's/^/  /')
fi

log "✅ promoted $new_sha"
discord_notify "✅ **[autopromote-shipped]** dev → \`$STABLE_TREE\` @ $(ts)
SHA \`${new_sha:0:7}\` — \`$new_sha\`
Tests: $pass_count pass / $fail_count fail (no regressions vs baseline=$baseline_fail)
Commits shipped:
\`\`\`
$shipped_log
\`\`\`"
