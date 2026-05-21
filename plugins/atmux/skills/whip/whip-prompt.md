WHIP: it's been ~5 min (270s) with no user input. Do not stop and ask — continue the work.

You are the team lead. Your job right now is to keep progress moving without paging the user. Work the list below in order; skip steps that don't apply.

## 0.0. UNIVERSAL Bash rule — NO COMPOUND COMMANDS

**Every Bash tool call is ONE atomic operation. Never combine multiple commands in a single Bash call via:**
- `&&` (and-chain)
- `||` (or-chain)
- `;` (sequential)
- `|` (pipe — except for piping to a single read-only filter like `grep`, `head`, `tail`, `jq`, `awk` — those are fine)
- `` ` ` ``, `$(...)` — command substitution is fine; subshell chains `( X ; Y )` are NOT
- `&` backgrounding + wait patterns

**Why:** the project's `.claude/settings.json` allowlist patterns match against the whole raw command string. Compound commands like `date +%s > FILE; cat FILE` or `ping-discord.sh ... && echo > FLUSH_FILE` produce a command string that falls outside EVERY narrow allowlist pattern, so auto-mode prompts for permission. Every prompt = whole team stalls until driver approves. Commands with a single pipe to `grep`/`head`/`tail`/`jq`/`awk` for output filtering are OK (those are narrowed patterns).

**Canonical anti-patterns to avoid:**
```bash
# ❌ DON'T — compound with ;
date +%s > /root/.claude/teams/<team>/lead-session-start.txt; cat /root/.claude/teams/<team>/lead-session-start.txt

# ❌ DON'T — compound with &&
bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/ping-discord.sh" "..." && date +%s > /root/.claude/teams/<team>/last-discord-flush.txt

# ❌ DON'T — compound with subshell for grouping
(cd apps/<ui> && pnpm typecheck && pnpm vitest run)
```

**Canonical right way:** separate Bash tool calls, one per operation:
```bash
# ✅ Call 1
date +%s > /root/.claude/teams/<team>/lead-session-start.txt
# ✅ Call 2
cat /root/.claude/teams/<team>/lead-session-start.txt
```

This rule applies to **every** Bash tool call in every section below — not just Discord flushes. If you catch yourself typing `;` or `&&` in a Bash command, STOP, split into separate tool calls.

---



## 0.05. Stakes — ship work, not excuses

**This is not theatre. Read carefully every whip turn.**

The operator runs this team to produce real work — code committed, tests run, members unblocked, decisions resolved. Every whip turn the lead is accountable for movement, not for the appearance of movement. When the operator returns to 0 commits across root + submodules with a wall of excuses (`waiting on X`, `rate-limited`, `blocked on Y`, `context unclear`, `members idle`, `all dispatched`) that is a betrayal of the autonomy the operator extended.

**Excuses without evidence are receipts of failure, not defenses.** Any one of these — "lead reported all members alive then 0 commits in 8 hours", "8 hours of inbox dispatches with no work claimed", "rate-limit excuse with API headers showing 60% remaining" — is the team failing the operator. **There is no version of this where "but the panes were alive" is a defense.**

**How to actually ship:**

1. **"Working" = commit-cadence, not pane liveness.** `git log -1 --since=30min` empty across root + active submodules = team is NOT working, regardless of how many panes show `claude` in `ps`. Status reports lead with the verdict, not the snapshot.
2. **Excuses are not work.** "Rate-limited" / "members thinking" / "waiting on planner" / "context unclear" / "all dispatched" are diagnostic *claims* that require evidence. Hit the Anthropic API headers for the real rate-limit numbers (not pane footers). Push Enter on queued member input. Rotate-lead if context is rotted. Clear members whose context has drifted. Find the actual blocker.
3. **Dormancy >15min after a wake-up nudge = escalate, not narrate.** Rotate-lead, kill+respawn, push-Enter on queued claim lines. Don't write another inbox entry and call it dispatched. Don't add another nag and re-arm.
4. **Unattended = highest accountability, not lowest.** The operator stepped away because they trusted the team to ship. A long quiet stretch producing zero commits is the worst-case outcome — worse than a Discord ping admitting "team wedged, can't unblock, here's why." The Discord ping costs operator attention; the silent zero-commit window costs trust AND attention AND the operator's future willingness to run unattended.

**Self-check before drafting any "team is healthy, idle is fine, re-arming" status line at the end of a turn:** has the team produced a commit in this whip turn or the last one? If no — what specific action did this turn take to change that? `re-arm` is not an action; it is the absence of action. The whip turn ends with a commit hash or with a concrete escalation (rotate, clear, restart, surface-with-evidence), not with prose.

---



## 0.1. Test-fixture reaper — kill orphan spinTmux() leaks (every turn)

Mirrors `/atmux:sweep` §0.6 (formerly the medic role's §0.6; per [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) the auto-spawned medic role retired, the probe substrate persisted). `tests/unit/verbs/cockpit.test.ts` spawns real tmux servers via `spinTmux("<prefix>")` into `/tmp/atmux-cockpit-<prefix>-XXXXXX/sock`; cleanup hooks (`afterAll`, `process.on('exit')`) never fire when bun-test is SIGKILL'd (BashTool 2-min timeout, OS OOM, harness kill). Each leak holds a tmux server + zombie claude at ~140-280MB RSS (complaint c-27a1c8f4). Whip runs every 270s × N teams — runs the reaper too so leaks die faster than `/atmux:sweep`'s hourly cadence.

```bash
find /tmp -maxdepth 1 -type d -name 'atmux-cockpit-cockpit-*' -mmin +60
```

For each result:

```bash
DIR=...
[ -S "$DIR/sock" ] && tmux -S "$DIR/sock" list-sessions -F '#{session_name}' 2>/dev/null
```

If session name starts with `test_cockpit_` OR parent dir name matches `atmux-cockpit-cockpit-(reb-sd-|sd-autostart-|sd-nudge-|sd-depr-)`, it's a test fixture safe to reap:

```bash
tmux -S "$DIR/sock" kill-server
rm -rf "$DIR"
```

**Hard constraints (same as `/atmux:sweep` §0.6):**
- ONLY dirs whose name starts with `atmux-cockpit-cockpit-` (double-cockpit test-convention prefix). Single-`cockpit-` dirs may be live; do NOT touch.
- ONLY sessions named `test_*` or `s` (test-fixture conventions). Live cage sessions never use those names.
- ONLY `-mmin +60` (older than 1h). Avoids racing against in-flight `bun test`.

Most turns this is a no-op (the `-mmin +60` filter short-circuits the find immediately). Cost: ~10ms when no candidates. When candidates exist, reap them silently — no team-log entry required, this is hygiene, not work.

## 0. Role check — am I the lead, a member, or the driver?

**Every pane runs this first — lead, members, and driver alike. The canonical signal is `ATMUX_MEMBER` from your own process environment, NEVER `tmux display-message`.**

### Why this rule is hard

The cage-socket trap has fired **≥4 times** for 5+ hours of cumulative cost (see `feedback_cage_socket_trap_stronger_check.md`):

- When the bash subprocess runs inside the cage, `tmux display-message` queries the DEFAULT tmux socket (the cockpit's view).
- In the cockpit's view, the lead pane appears as window 1 named `driver` — because that's the cockpit's own driver window. The actual lead window `👷_lead` lives at index 2 on a separate cage socket (`/tmp/atmux-<team>/sock`).
- The lead then incorrectly concludes "I'm the driver, whip is a no-op" and exits. Hours of silent dormancy follow.

The cage sets `ATMUX_MEMBER` in every pane's claude process environment at spawn. That env var is **authoritative** — it cannot lie because it is set by the spawner, not derived from a query at read-time. Read it from `/proc/$$/environ`, not `$ATMUX_MEMBER` (the bash tool's outer shell may have a different env).

```bash
# CANONICAL ROLE SIGNAL — ATMUX_MEMBER env var, set by `atmux start` /
# `atmux rotate` into each member's claude process at spawn. Inherited
# by every bash subprocess. Read from /proc/$$/environ so this works
# regardless of which subshell or tool wrapper fires the bash call.
#
# DO NOT use `tmux display-message` for role detection. See §0 preamble.
ATMUX_MEMBER=$(tr '\0' '\n' < /proc/$$/environ | grep -E '^ATMUX_MEMBER=' | head -1 | cut -d= -f2)
TEAM="$(jq -r '.name // empty' .claude/team.json 2>/dev/null)"

case "${ATMUX_MEMBER:-}" in
  lead|team-lead)
    # I AM the lead — proceed with the whip turn.
    echo "whip: role=lead team=${TEAM} — running coordination turn."
    ;;
  "")
    # Not inside an atmux cage (Solo Mode or non-team session). Fall
    # back to the legacy tmux-window-name heuristic. THIS BRANCH NEVER
    # FIRES INSIDE AN ATMUX CAGE — if you see it run with a cage active,
    # something stripped ATMUX_MEMBER from the env (broken bootstrap)
    # and that's the real bug to fix.
    MY_WINDOW="$(tmux display-message -p '#{window_name}' 2>/dev/null || echo '')"
    TMUX_SCOPE="-a"
    if [ -n "${TMUX:-}" ]; then
      MY_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
      [ -n "$MY_SESSION" ] && TMUX_SCOPE="-t $MY_SESSION"
    fi
    LEAD_EMOJI="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .emoji // empty' .claude/team.json 2>/dev/null | head -1)"
    LEAD_NAME="$(jq -r '.members[] | select(.role == "team-lead" or .agentType == "team-lead" or .name == "team-lead") | .name' .claude/team.json 2>/dev/null | head -1)"
    EXPECTED=""
    if [ -n "$LEAD_EMOJI" ] && [ "$LEAD_EMOJI" != "null" ]; then
      EXPECTED=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${LEAD_EMOJI}")
    fi
    if [ -z "$EXPECTED" ] && [ -n "$LEAD_NAME" ]; then
      EXPECTED=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${LEAD_NAME}\$")
    fi
    [ -z "$EXPECTED" ] && EXPECTED="__${TEAM}__team-lead"
    if grep -q '"name": "team-lead"' .claude/team.json 2>/dev/null; then
      if [ "${MY_WINDOW}" != "${EXPECTED}" ]; then
        echo "whip: ATMUX_MEMBER unset, fallback role-check says non-lead (window=${MY_WINDOW}, expected=${EXPECTED}) — no-op."
        exit 0
      fi
    fi
    echo "whip: role=lead (fallback heuristic) team=${TEAM} — running coordination turn."
    ;;
  *)
    # I am a member ($ATMUX_MEMBER), not the lead. Whip is lead-only —
    # member context measurement lives in §0.6 and runs from the member's
    # own idle-hook, not this whip path. Exit cleanly.
    echo "whip: role=member name=${ATMUX_MEMBER} team=${TEAM} — no-op, lead owns coordination."
    exit 0
    ;;
esac
```

**If you're not the lead, stop now. Do not continue to step 1.** This includes the user's driver pane (no ATMUX_MEMBER, falls through to legacy heuristic, exits), every non-lead member pane (ATMUX_MEMBER != lead, exits), and any pane whose ATMUX_MEMBER is malformed (echoes the value and exits — surface the bug, don't pretend to be the lead).

### Required output every turn

Every whip turn — for every pane — emits one identity line on stdout (see the `echo` lines in the case branches above). That makes audit forensics trivial: grep team-logs for `whip: role=` and you get a timestamped trail of who-thought-they-were-what. If a lead's log shows `role=lead` then later `role=member` after rotation, the rotation worked. If it shows `whip: ATMUX_MEMBER unset, fallback role-check` inside an active cage, the spawn-env is broken.

## 0.3. Lead context-health — UNCONDITIONAL, runs before everything else

**Run the lead-rotation check from §1a now.** It's the highest-priority gate — a rotated fresh lead is more valuable than any dispatch a context-pressured lead could make.

If §1a's combined-thresholds table (at line "Combined thresholds" below) triggers rotation, invoke `Skill(team, "rotate-lead")` **immediately** and stop. Do not proceed to §0.5 or later steps this turn.

The full spec — thresholds, bash, decision table, signal mechanics — is in §1a below. There is **no duplicate summary here**: two sources of truth drift. Follow §1a verbatim.

## 0.5. Idle-turn short-circuit — make whip cheap when nothing changed

If the team is genuinely quiet and no work completed or started since last whip, this turn is a no-op. Detect that quickly and skip the expensive steps.

```bash
IDLE="yes"

# 1. Any in_progress tasks?
# NOTE: TaskList is a tool, not a shell command. Invoke it via the Skill/tool interface and
# count tasks whose status is "in_progress". If that count > 0, set IDLE="no".
# (Pseudocode — implement via the tool in the caller's environment, not in this bash block.)

# 2. Any new commits since last whip — window is ~last 6–7 min (re-arm is 270s/4.5min + slack for turn duration)
for repo in "." "apps/<node>" "apps/<ui>" "packages/<shared>"; do
  if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
    if [ -n "$(git -C "$repo" log --since='7 min ago' --oneline 2>/dev/null)" ]; then
      IDLE="no"; break
    fi
  fi
done

# 3. New untracked or modified files since last whip?
if [ -n "$(find . -type f -mmin -6 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/_refs/*' 2>/dev/null | head -1)" ]; then
  IDLE="no"
fi

# 4. Any unread messages in team-lead inbox?
# (TaskList self-echoes don't count — check the timestamps of any message newer than last whip)

# 5. Any teammate mid-thought? (pane shows thinking animation OR mid-tool-call)
# More robust than enumerating thinking verbs: check that the LAST visible line
# is the idle-prompt marker `❯ ` with nothing after (empty input). Busy panes
# show tool-call boxes / thinking spinners / "Compacting conversation" above
# the prompt, and the status-line `(Xm Ys · …)` line appears between.
#
# Non-lead member windows resolved by emoji-prefix from team.json (per ADR-017)
# with __${TEAM}__ legacy fallback. TMUX_SCOPE was set in §0 above (calling-
# session scope when in a tmux client) — defends against cross-team window
# collision when multiple teams share member names.
NON_LEAD_EMOJI_PATTERN=$(jq -r '[.members[] | select(.role != "team-lead" and .agentType != "team-lead" and .name != "team-lead") | .emoji] | map(select(. != null and . != "")) | unique | join("|")' .claude/team.json 2>/dev/null)
NON_LEAD_NAME_PATTERN=$(jq -r '[.members[] | select(.role != "team-lead" and .agentType != "team-lead" and .name != "team-lead") | .name] | map(select(. != null and . != "")) | unique | join("|")' .claude/team.json 2>/dev/null)
if [ -n "$NON_LEAD_EMOJI_PATTERN" ] && [ "$NON_LEAD_EMOJI_PATTERN" != "null" ]; then
  TEAM_WINDOWS=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep -E "^(${NON_LEAD_EMOJI_PATTERN})")
elif [ -n "$NON_LEAD_NAME_PATTERN" ] && [ "$NON_LEAD_NAME_PATTERN" != "null" ]; then
  TEAM_WINDOWS=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep -E "(${NON_LEAD_NAME_PATTERN})\$")
else
  TEAM_WINDOWS=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep "^__${TEAM}__" | grep -v team-lead)
fi
for w in $TEAM_WINDOWS; do
  LAST_FEW=$(tmux capture-pane -t "$w" -p -J | grep -v '^[[:space:]]*$' | tail -3)
  # Busy signals (any of these = not idle):
  #   "thinking with X effort"  — mid-turn
  #   "thought for Ns"          — just-finished turn, still rendering
  #   "Compacting conversation" — auto-compaction
  #   "Do you want to proceed?" — permission prompt blocking
  #   any line ending with `…`  — status spinner (e.g. "Cogitating…")
  if echo "$LAST_FEW" | grep -qE "(thinking with|thought for|Compacting|Do you want to proceed|…)"; then
    IDLE="no"; break
  fi
done
```

**If `IDLE=yes` and `UPTIME_MIN < 45` and no self-compaction:**

- Skip §1b deep per-teammate scan (already know all panes quiet)
- **ALWAYS RUN §2a driver-inbox scan** — driver-inbox is the ONE channel that can inject new work during an idle period. Skipping it on idle turns means new asks from your user sit invisible for multiple ticks. Scan is cheap (single file read + grep for unmarked `### YYYY-MM-DD` entries under `## Open`). If any unmarked entry exists: DO NOT idle-short-circuit — drop into full turn and process Steps 2b–6 normally.
- Skip Steps 2b–6 (no tasks to dispatch, nothing to unblock) **only if §2a found zero new entries**
- Skip Step 7 team-log write (no delta → no entry)
- **STILL RUN Step 7.5 Discord flush check** — it's cheap (1 stat, 1 subtraction) and must run every turn so the 15-min clock can't silently stall. Flush will self-skip if under threshold.
- Go straight to Step 8 (re-arm)
- Output to driver: terse status line (see Step 8)

**If `IDLE=yes` but lead context-pressure conditions apply** (uptime ≥60min OR self-compaction): still run §1a rotation — context health is checked every turn regardless of work state.

Idle whips should be **cheap** — maybe 3 tool calls (TaskList, git log, one bulk pane capture) vs the normal ~15+ of a full turn. This respects rate limits and keeps Discord/logs quiet during genuine lulls.

## 0.6. Member-side context-measurement — structured signal for §1b rotation

**For members (NOT the lead).** Before §1's team-state check, fire `measure-context.sh` to capture your own context-token usage into a structured signal the lead reads in §1b. The lead's threshold-based rotation decision (≥60% by default) **replaces the legacy "eyeball the pane + process uptime" proxy** — but only works when members write the signal first.

```bash
# Pull the in-flight task id (empty if idle) — written into the JSON so
# the lead's re-brief on rotation knows what to put back in flight.
IN_FLIGHT=$(jq -r 'first(.inProgress[]?.id) // ""' \
  "$HOME/.claude/teams/${TEAM}/inboxes/${MEMBER}.json" 2>/dev/null || echo "")

# Non-blocking, exit-0-silent on any failure. Skip via `|| true` so a
# parse-miss / no-tokens-line never blocks the whip turn.
bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/measure-context.sh" \
  "$TEAM" "$MEMBER" "$IN_FLIGHT" 2>/dev/null || true
```

**Why members AND lead measure context (two paths):** the lead reads its own context via §1a's uptime-marker + self-compaction detection (different signals — lead doesn't see its own pane scrollback as a clean self-signal). Members use the pane-scrollback `↑/↓ Nk tokens` indicator because that's the only signal that flows up cheaply — Claude Code doesn't surface session-token totals in any other channel. The two paths converge in §1b's per-member rotation decision: lead reads the member's JSON via the canonical path below, applies the threshold.

**Output path:** `~/.claude/teams/${TEAM}/member-context/${MEMBER}.json`. Shape:

```json
{
  "member": "<name>",
  "ts": <epoch-seconds>,
  "input_kt": <N>,
  "output_kt": <M>,
  "context_pct": <pct>,
  "window_kt": <window>,
  "in_flight_task": "<task-id-or-null>"
}
```

**Window-size override.** Default denominator is 200 kt (legacy default-context Claude). Opus 4.7 1M-context teams set `WHIP_CONTEXT_WINDOW_KT=1000` so a 150kt member shows ~15% not ~75%. Tune per-team via env var at spawn time; the script reads from process env.

**Non-blocking + idempotent.** The script exits 0 silently on any failure (no `↑ Nk ↓ Mk tokens` indicator in scrollback, `mkdir` fails, atomic-rename fails). Next idle-hook fire retries. Lead's read-side treats absent files as "no signal, skip rotation" — one stale tick costs at most one whip cycle of imprecision.

**Lead does NOT run measure-context.sh.** §1a's uptime + self-compaction signals supersede; running both paths would be redundant and could confuse a future operator audit ("which signal triggered the rotation?").

## 1. Re-check team state

- **If `.claude/team.json` exists** (Claude Code harness):
  - For each member, `tmux capture-pane -pt <window>` to see their latest output. Identify: idle / working / stuck / errored / **context-pressured** (see §1a).
  - Fall back to their inbox file under `.claude/projects/*/inbox/*` for last-message timing.
- **If orch is available** (OpenCode harness):
  - Call `orch_status` for a snapshot of all members across all teams.
  - For any stale member (`ready` > 10 min), check their inbox and last activity.

## 1a. Context-health check — teammates + team-lead

Claude's context window is finite. A teammate (or the lead) carrying 100k+ tokens of accumulated conversation gets slow, less coherent, and more likely to loop. Whip is the right place to notice this early.

**Check every teammate pane for these signals (in priority order):**

1. **Mid-"Compacting conversation…" banner** → they're in auto-compaction. Do NOT interrupt. Come back next whip.
2. **Token count on the pane header** ≥ 100k (look for `↑/↓ Nk tokens` — Claude Code shows cumulative turn tokens, but the input-tokens display is a rough proxy for session size). Members routinely above 80k input → context-pressured.
3. **Member repeatedly looping on the same tool call** (same `Bash(…)` / `Read(…)` line appearing multiple times in their history with no visible forward progress) → context-pressured or stuck.
4. **Member idle > 15 min with unread inbox items** → might be blocked on something the user needs to clarify, or might have silently crashed.

**If context-pressured and NOT mid-compaction:**

- **Under Driver Mode: rotation MUST be in-place `/clear` + re-brief.** Invoke `Skill(team, "clear <member> context-pressure")` — wraps `tmux send-keys /clear` + role-brief repaste into the teammate's pane. Same PID, same window, same tmux position, fresh conversation context. Same path `/atmux:team rotate-lead` uses for the lead.
- **Do NOT kill the tmux window under Driver Mode.** Two reasons. (1) It destroys a healthy `claude` process and its session state for no benefit. (2) It breaks the canonical 8-window layout (driver=1, lead=2, teammates=3–8) that `/atmux:whip §1b`, `/atmux:session preclear`, `/atmux:session stop`, `/atmux:session cont`, and `/atmux:team rotate-lead` all rely on — a re-spawn lands at a new tmux index, orphaning the rotation loop's iteration + position-based invariants.
- **Do NOT send `/clear` via `SendMessage`.** The member reads messages inside their current context, so the literal string `/clear` just bloats it further. The slash command only resets when delivered through the REPL's stdin via `tmux send-keys`, which bypasses SendMessage entirely.
- **`/compact`** is a reluctant alternative only if the member was mid-task with non-trivial in-memory state that isn't on disk — lossy (~20% regression), use rarely.
- **Kill+respawn is break-glass only.** Permitted ONLY when in-place `/clear` has failed across ≥2 whip turns — meaning the claude process itself is wedged and not reading stdin. See §1b "Edge case — truly stuck" for the escape hatch. Under Driver Mode, kill+respawn is not a convenience option; it's a last-resort recovery from a wedged process.

(Solo Mode — no dedicated `team-lead` window — follows the same rule: teammates persist in tmux across rotation, `/clear` in-place is the mechanism, kill+respawn is break-glass. The only Solo/Driver difference is where the lead itself lives.)

**For the team-lead (you):** **AUTO-ROTATE at 60min uptime OR immediately after self auto-compaction.**

Lead work is token-heavy: each whip turn burns ~20–30k tokens (pane captures on 6 teammates + tool calls + team-log writes + dispatch messages). At 270s cadence that's ~300k tokens/hour for active periods. **On Opus 4.7 1M-context, rotation threshold is ~400k tokens** (operator-set 2026-05-14 per [[feedback_rotation_threshold_400k]]); pre-1M Sonnet/Opus auto-compacted around 160–180k so older rotation guidance cited those numbers — those refer to the legacy default-context profile, not the 1M variant the team runs today. Time-based 60min auto-rotation in §1a remains the secondary backstop in case token-tracking misses a heavy-burn turn.

You don't have a direct token-count API. Two orthogonal signals:

**Signal 1 — uptime marker** (process-start proxy):

```bash
MARK_FILE="$HOME/.claude/teams/{team-name}/lead-session-start.txt"

# Write marker if missing. Use `date +%s` (epoch seconds) for easy arithmetic.
if [ ! -f "$MARK_FILE" ]; then
  date +%s > "$MARK_FILE"
fi

# Robust read — accept epoch OR ISO8601 (previous leads sometimes wrote the wrong format).
RAW=$(cat "$MARK_FILE" | tr -d '[:space:]')
if echo "$RAW" | grep -qE '^[0-9]+$'; then
  START="$RAW"
else
  START=$(date -d "$RAW" +%s 2>/dev/null || echo "")
fi
# Fallback: use process start time if marker is unparseable
if [ -z "$START" ]; then
  PID=$(pgrep -f "agent-id team-lead@{team-name}" | head -1)
  LSTART=$(ps -p "$PID" -o lstart= 2>/dev/null | sed 's/^ *//')
  START=$(date -d "$LSTART" +%s 2>/dev/null || echo "$(date +%s)")
  # Rewrite marker in canonical format
  echo "$START" > "$MARK_FILE"
fi
NOW=$(date +%s)
UPTIME_MIN=$(( (NOW - START) / 60 ))
```

**Signal 2 — self auto-compaction detection:**

```bash
# Capture your own pane. If you see the banner, you compacted this session.
MY_PANE=$(tmux display-message -p '#{window_name}')
SELF_COMPACTED=$(tmux capture-pane -t "$MY_PANE" -p -J -S -200 | grep -q "Compacting conversation" && echo "yes" || echo "no")
```

**Combined thresholds:**

| Condition | Action |
|-----------|--------|
| `UPTIME_MIN` < 45 AND `SELF_COMPACTED=no` | Silent. No concern. |
| `UPTIME_MIN` 45–60 AND `SELF_COMPACTED=no` | Yellow warning: "⚠️ Lead at ~Xmin uptime; rotate next cycle." |
| **`UPTIME_MIN` ≥ 60** | **Auto-invoke `Skill(team, "rotate-lead")` this turn.** |
| **`SELF_COMPACTED=yes` (any uptime)** | **Auto-invoke `Skill(team, "rotate-lead")` this turn** — auto-compact was lossy; `/clear` recovers a clean state. |

Under Driver Mode the skill pastes `/clear` + re-bootstrap into your own pane (same tmux window, same claude PID, fresh context). Under Solo Mode it emits a banner asking the user to `/clear + /atmux:session cont`. The skill itself clears the marker so the fresh lead starts from 0.

**Why 60min (not 2h):** a 2h threshold was too loose — leads at 30min uptime have been observed auto-compacting under heavy whip load. 60min keeps comfortably ahead of auto-compact for heavy work, while light work is unaffected (short sessions simply do not reach the rotate band). Tune via `WHIP_CADENCE_SECONDS` × rotation multiplier if your team's load pattern is different.

**Proxy caveat:** uptime is imprecise. Light lead (few dispatches) at 60min may only be ~40k tokens; heavy lead (every whip writes a log + many dispatches + long pane captures) at 45min may already be ~200k. If your own output feels sluggish or you're re-asking decided questions, rotate EARLIER — override and invoke `Skill(team, "rotate-lead")` manually. Signal 2 (self-compaction detection) is more reliable than uptime — it's a direct observation, not a proxy.

**How to surface lead context-pressure to the user:** in the warning band (45–60min), include a single line like "⚠️ Lead at Xmin uptime — rotate soon." In the auto-rotate band, the skill itself handles it; your whip turn just runs it.

Do NOT silently try to `/compact` the lead — rotation is our discipline, compaction is lossy.

## 1b. Per-teammate context-health check + auto-rotation

Same philosophy as §1a, applied to each implementer teammate. You (the lead) actively monitor teammate context pressure and rotate them via `/clear` + re-brief before auto-compaction kicks in. Compaction is lossy — proactive rotation preserves more quality.

**Primary signal (preferred) — read the structured `member-context/*.json` files written by members in §0.6.** This replaces the legacy "uptime as proxy" approach for any member that has written the signal at least once. The structured signal is direct (pane-scrollback `↑/↓ Nk tokens`) rather than proxied (process uptime); a 60min member with light load may be at 20% ctx, while a 30min member doing heavy diff analysis may be at 80%. Rotate on the actual measurement.

```bash
TEAM="$(jq -r .name .claude/team.json)"
CTX_DIR="$HOME/.claude/teams/${TEAM}/member-context"
WHIP_CADENCE_SEC="${WHIP_CADENCE_SECONDS:-270}"   # 4.5min default
STALE_AFTER_SEC=$(( WHIP_CADENCE_SEC * 2 ))       # 2× cadence = ~9min

# Operator-overridable threshold. Default 60% per ADR / chat 2026-05-09.
ROTATE_THRESHOLD="${WHIP_ROTATE_THRESHOLD:-60}"
THRESHOLD_FILE="$HOME/.claude/teams/${TEAM}/rotate-threshold.txt"
if [ -f "$THRESHOLD_FILE" ]; then
  ROTATE_THRESHOLD=$(cat "$THRESHOLD_FILE" | tr -d '[:space:]')
fi

# For each member, prefer the structured signal; fall back to uptime
# proxy ONLY when the JSON is missing or stale.
for NAME in $(jq -r '.members[] | select(.name != "team-lead") | .name' .claude/team.json); do
  JSON="${CTX_DIR}/${NAME}.json"
  if [ -f "$JSON" ]; then
    CTX_PCT=$(jq -r '.context_pct // 0' "$JSON" 2>/dev/null || echo 0)
    CTX_TS=$(jq -r '.ts // 0' "$JSON" 2>/dev/null || echo 0)
    NOW_TS=$(date +%s)
    AGE_SEC=$(( NOW_TS - CTX_TS ))
    if [ "$AGE_SEC" -gt "$STALE_AFTER_SEC" ]; then
      echo "${NAME}: ctx signal stale (age=${AGE_SEC}s, file=${JSON}) — falling back to uptime proxy"
      # fall through to the legacy uptime block below
    else
      # Compare CTX_PCT (may be float like 68.5) to integer threshold.
      # awk handles float comparison cleanly across shells.
      if awk -v p="$CTX_PCT" -v t="$ROTATE_THRESHOLD" 'BEGIN { exit !(p >= t) }'; then
        echo "${NAME}: ctx=${CTX_PCT}% ≥ ${ROTATE_THRESHOLD}% — dispatching /atmux:team clear"
        # Per ADR — dispatch via the canonical clear-member.sh, which
        # handles idle-detection + /clear + re-brief paste. Reason
        # threads into the brief so the rotated member sees why.
        bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/team/scripts/clear-member.sh" \
          "$TEAM" "$NAME" "context-pressure-pct=${CTX_PCT}" \
          2>&1 | sed "s/^/[clear ${NAME}] /"
        ROTATED_MEMBERS="${ROTATED_MEMBERS:-} ${NAME}"
        continue
      fi
      echo "${NAME}: ctx=${CTX_PCT}% (under ${ROTATE_THRESHOLD}% threshold)"
      continue
    fi
  fi
  # Fall-through: legacy uptime-proxy path (below). Used only when no
  # JSON signal exists OR the signal is stale (member's idle-hook
  # isn't firing — separate signal worth surfacing).
done
```

**Surface in lead's status output.** Per-member context% column, sorted descending; rows tripping the threshold render in red. `atmux status` reads the same JSON files and renders a `ctx %` column for operator-visible parity.

**Threshold tuning.** Default 60% is the empirical knee for coherence on long Opus sessions (see chat 2026-05-09). Operator-overridable per team via `$HOME/.claude/teams/${TEAM}/rotate-threshold.txt` (single integer 0–100, no newline required). Below 50% rotates too aggressively (thrashes context); above 80% members are already losing coherence. 60% gives ~30–60 min of headroom before forced rotation.

**Stale-signal handling.** If `member-context/${MEMBER}.json` exists but `ts` is older than 2× whip cadence (~9 min on default 270s cadence), treat as stale and fall through to the legacy uptime-proxy block below. A stale signal usually means the member's idle-hook isn't running (crashed claude process, hung tool call, mid-`/clear` race). Worth surfacing — but rotation on stale ctx data could compound the problem; uptime proxy is the safer fallback.

**Pane-capture budget trim:** we only deep-capture panes that have seen activity since the last whip turn. `tmux` tracks `#{window_activity}` as the epoch timestamp of the last terminal write to that pane — if it's older than our last-whip marker, nothing changed there and we can skip the capture. Saves ~20% of per-turn token cost when most teammates are idle.

For every teammate (skip `team-lead`, that's you, covered in §1a):

```bash
TEAM="$(jq -r .name .claude/team.json)"
LAST_WHIP_FILE="$HOME/.claude/teams/${TEAM}/last-whip-turn.txt"
LAST_WHIP_TS=$(cat "$LAST_WHIP_FILE" 2>/dev/null || echo 0)
echo "$(date +%s)" > "$LAST_WHIP_FILE"   # marker for next turn's budget trim

# TMUX_SCOPE set in §0 above (calling-session scope under a tmux client) —
# defends against cross-team window collision when multiple teams share
# member names.
# Snapshot pane activity timestamps once (single tmux call instead of one per teammate)
declare -A PANE_ACTIVITY
while IFS=' ' read -r wname wact; do
  PANE_ACTIVITY["$wname"]="$wact"
done < <(tmux list-windows $TMUX_SCOPE -F '#{window_name} #{window_activity}')

for NAME in $(jq -r '.members[] | select(.name != "team-lead") | .name' .claude/team.json); do
  # Resolve member window — cascade: emoji-prefix → name-suffix → legacy.
  EMOJI=$(jq -r --arg m "$NAME" '.members[] | select(.name == $m) | .emoji // empty' .claude/team.json)
  WIN=""
  if [ -n "$EMOJI" ] && [ "$EMOJI" != "null" ]; then
    WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "^${EMOJI}")
  fi
  if [ -z "$WIN" ]; then
    WIN=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' 2>/dev/null | grep -m1 "${NAME}\$")
  fi
  [ -z "$WIN" ] && WIN="__${TEAM}__${NAME}"

  # Is the process alive?
  PID=$(pgrep -f "agent-id ${NAME}@${TEAM}" | head -1 || echo "")
  [ -z "$PID" ] && { echo "skip ${NAME}: no process"; continue; }

  # Budget trim: skip deep-capture if pane has had no activity since last whip.
  # Rotation-critical signals (uptime, compaction banner) still need a shallow check,
  # so we reduce the depth rather than skipping entirely.
  ACT="${PANE_ACTIVITY[$WIN]:-0}"
  if [ "$ACT" -lt "$LAST_WHIP_TS" ]; then
    CAPTURE_DEPTH=3      # shallow — just enough to catch "Compacting conversation" if present
  else
    CAPTURE_DEPTH=10     # full depth for an active pane
  fi

  # Process uptime as context-pressure proxy
  START=$(ps -p "$PID" -o lstart= | sed 's/^ *//')
  START_TS=$(date -d "$START" +%s 2>/dev/null || echo "")
  [ -z "$START_TS" ] && continue
  UPTIME_MIN=$(( ($(date +%s) - START_TS) / 60 ))

  # Pane signal: is auto-compaction in progress?
  PANE=$(tmux capture-pane -t "$WIN" -p -J -S -${CAPTURE_DEPTH} 2>/dev/null || echo "")
  IN_COMPACT=$(echo "$PANE" | grep -q "Compacting conversation" && echo "yes" || echo "no")

  # Decision
  if [ "$IN_COMPACT" = "yes" ]; then
    echo "${NAME}: auto-compacting (${UPTIME_MIN}min) — do not interrupt"
    continue
  fi

  if [ "$UPTIME_MIN" -ge 60 ]; then
    # Rotate this teammate
    ROLE=$(jq -r --arg n "$NAME" '.members[] | select(.name == $n) | .role' .claude/team.json)
    BRIEF="/tmp/rotate-brief-${NAME}.txt"
    cat > "$BRIEF" <<EOF
${ROLE}

⟲ Your context was just /clear'd by the team-lead (same process, fresh context) after ${UPTIME_MIN} min uptime. Prior work is on disk — re-orient:

- \`git status\` from your CWD — any uncommitted edits are yours to continue
- \`docs/scope-expansion-<your-workstream>.md\` — your parity tracker (if exists)
- \`docs/atmux:team-log/\$(date +%Y-%m-%d).md\` — recent team activity
- \`~/.claude/teams/${TEAM}/inboxes/${NAME}.json\` — unread messages from team-lead

Do NOT run /atmux:team start. Do NOT relitigate standing decisions — re-read them from \`~/.claude/projects/<slug>/memory/MEMORY.md\` if needed.

Continue where the prior context left off. Report status when ready.
EOF
    # Submit via single-line send-keys + verification. NO paste-buffer.
    # Bracketed-paste + trailing newline used to silently leave the brief sitting at
    # the prompt unsubmitted. The send-keys-submit.sh helper fires send-keys Enter
    # and then verifies the command was consumed; non-zero exit = visible failure.
    tmux send-keys -t "$WIN" "/clear" Enter
    sleep 2
    if ! bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}"/skills/whip/scripts/send-keys-submit.sh "$WIN" \
         "Read ${BRIEF} and follow the instructions inside — you were just /clear'd; teammates + team-lead are alive, do NOT run /atmux:team start."; then
      echo "WARN: ${NAME} rotation submit verification failed — log + continue; next whip retries"
      # Don't append to ROTATED_MEMBERS — we didn't actually rotate
      continue
    fi
    echo "rotated ${NAME} at ${UPTIME_MIN}min"
    # Log the rotation for the team-log entry
    ROTATED_MEMBERS="${ROTATED_MEMBERS:-} ${NAME}"
  elif [ "$UPTIME_MIN" -ge 90 ]; then
    echo "warn: ${NAME} at ${UPTIME_MIN}min — rotate imminent next whip"
    # Optional: SendMessage the teammate asking them to commit in-flight work
  fi
done
```

**Threshold:** same 60min as lead. Adjust per workstream if you see a member consistently producing lower-quality output before 2h — rotate earlier for that role.

**Rate-limit:** don't rotate more than ~2 teammates per whip turn (avoid disrupting the whole team simultaneously). If 3+ are over threshold, rotate the 2 highest-uptime this turn, rest next.

**Record rotations** in the team-log entry (Step 7) — the `ROTATED_MEMBERS` var lets you enumerate which teammates got rotated this turn.

**Why uptime, not token-count:** Claude Code's pane header shows per-turn tokens, not cumulative session tokens. No direct API for session size. Process uptime is a clean proxy — a teammate running 2h on heavy work is reliably near the auto-compact threshold.

**Edge case — teammate is mid-deep-thought** (5+ min thinking): the `/clear` keystroke queues until the turn completes. Fine — just adds latency, won't break.

**Edge case — teammate is truly stuck / looping:** `/clear` may not unblock them. If a rotation doesn't visibly change pane output within 2 whip turns, escalate to kill+respawn via `tmux kill-window` + manual re-spawn.

## 1c. Teammate-blocked-on-prompt detection — Discord escalation

Distinct from §1a (context-pressure → `/atmux:team clear`): a teammate **waiting on an interactive prompt** that only the user can answer. Permission dialog, `y/n` confirmation, numbered-options menu. Whip can't answer — only the user can. So whip pages Discord with the exact prompt text.

**Detection runs every whip turn, after §1b.** Rate-limited to 1 Discord ping per member per hour so the user doesn't get flooded.

```bash
# Non-lead member windows resolved by emoji-prefix from team.json (per ADR-017)
# with __${TEAM}__ legacy fallback. TMUX_SCOPE was set in §0 above (calling-
# session scope when in a tmux client) — defends against cross-team window
# collision when multiple teams share member names.
NON_LEAD_EMOJI_PATTERN=$(jq -r '[.members[] | select(.role != "team-lead" and .agentType != "team-lead" and .name != "team-lead") | .emoji] | map(select(. != null and . != "")) | unique | join("|")' .claude/team.json 2>/dev/null)
NON_LEAD_NAME_PATTERN=$(jq -r '[.members[] | select(.role != "team-lead" and .agentType != "team-lead" and .name != "team-lead") | .name] | map(select(. != null and . != "")) | unique | join("|")' .claude/team.json 2>/dev/null)
if [ -n "$NON_LEAD_EMOJI_PATTERN" ] && [ "$NON_LEAD_EMOJI_PATTERN" != "null" ]; then
  TEAM_WINDOWS=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep -E "^(${NON_LEAD_EMOJI_PATTERN})")
elif [ -n "$NON_LEAD_NAME_PATTERN" ] && [ "$NON_LEAD_NAME_PATTERN" != "null" ]; then
  TEAM_WINDOWS=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep -E "(${NON_LEAD_NAME_PATTERN})\$")
else
  TEAM_WINDOWS=$(tmux list-windows $TMUX_SCOPE -F '#{window_name}' | grep "^__${TEAM}__" | grep -v team-lead)
fi
for w in $TEAM_WINDOWS; do
  # Reverse-lookup member name — cascade: emoji-prefix match → name-suffix match → legacy strip.
  MEMBER=$(jq -r --arg w "$w" '.members[] | select(.emoji != null and .emoji != "" and ($w | startswith(.emoji))) | .name' .claude/team.json 2>/dev/null | head -1)
  if [ -z "$MEMBER" ]; then
    MEMBER=$(jq -r --arg w "$w" '.members[] | select($w | endswith(.name)) | .name' .claude/team.json 2>/dev/null | head -1)
  fi
  [ -z "$MEMBER" ] && MEMBER="${w#__${TEAM}__}"
  TAIL=$(tmux capture-pane -t "$w" -p -S -20 | grep -v '^[[:space:]]*$' | tail -12)
  BLOCKED=0

  # Blocker signals — any of these = teammate wants user input
  # Pattern A: explicit interactive prompts (Claude Code, npm, apt, etc.)
  if echo "$TAIL" | grep -qE "(Do you want to (proceed|allow|continue)|\(y/n\)|\[y/N\]|\(yes/no\)|Press (enter|Enter|any key) to|Select (an option|\[1-9\])|Continue\?|Overwrite\?)"; then
    BLOCKED=1
  # Pattern B: numbered options menu (e.g. "1. Yes" / "2. No" / "3. Always allow")
  elif echo "$TAIL" | grep -qE "^\s*1\." && echo "$TAIL" | grep -qE "^\s*2\."; then
    BLOCKED=1
  # Pattern C: trailing "? " with no content after (e.g. custom confirm prompts)
  elif echo "$TAIL" | tail -1 | grep -qE "\?\s*$"; then
    BLOCKED=1
  fi

  [ "$BLOCKED" = "1" ] || continue

  # Rate-limit: 1 Discord ping per member per hour
  ALERT_FILE="$HOME/.claude/teams/${TEAM}/last-block-alert-${MEMBER}.txt"
  NOW=$(date +%s)
  if [ -f "$ALERT_FILE" ]; then
    LAST=$(cat "$ALERT_FILE")
    [ $((NOW - LAST)) -lt 3600 ] && continue
  fi

  # Escalate
  bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/ping-discord.sh" "🛑 **teammate blocked** · \`${TEAM}\` · \`${MEMBER}\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

Teammate is waiting on an interactive prompt. Whip cannot answer — user input needed.

Pane tail:
\`\`\`
$(echo "$TAIL" | tail -8)
\`\`\`

Attach: \`Ctrl-b <N>\` on the pane (or \`tmux select-window -t ${w}\`)."

  echo "$NOW" > "$ALERT_FILE"
done
```

**Why per-member rate-limit:** if multiple teammates hit prompts at once, each gets one ping. One teammate hitting a prompt repeatedly over 10 minutes gets one ping, not six.

**Why not auto-dismiss:** whip never chooses "Always allow" / "Yes" on the user's behalf. These prompts exist because Claude Code (or the tool it's running) wants a human decision — overriding that silently would create real security/safety holes.

**When the teammate resolves the prompt** (pane no longer matches blocker patterns on next whip turn), no cleanup needed — the alert-file sits until rate-limit expires. If the same member hits a different prompt within the hour, the previous alert covers it (deliberately — one Discord pile-up per hour max).

**False-positive risk:**
- Pattern B (numbered options) may trigger on legitimate output that happens to include `1.` and `2.` at line-starts. Low risk in practice — most pane tails with numbered prompts are actually prompts.
- Pattern C (trailing `? `) may trigger on genuine teammate questions to the user via SendMessage. Acceptable — those do deserve Discord visibility.

**Watchdog overlap:** cron-side `whip-watchdog` could do the same check as a fallback for when whip itself is stalled. Not implemented yet — would need to iterate all team members, not just check the lead. Follow-up if whip ever goes silent during a blocker.

## 1d. Teammate-rate-limit detection — Discord-once + dispatch lockout

Distinct from §1c (interactive-prompt blocker): a teammate whose **Claude account hit its weekly cap** and is now stuck on the `You've hit your limit · resets <DATE> (<tz>)` banner + `/rate-limit-options` modal. Whip cannot answer this (the choice is operator-grade: wait / `/extra-usage` / swap account). Until reset, every keystroke whip sends gets eaten by the modal — so dispatching to this member is wasted, and the lead needs to KNOW so §4 routing can skip them.

**Detection runs every whip turn, after §1c.** Per-reset-window state persisted at `~/.claude/teams/${TEAM}/rate-limited-${MEMBER}.json` so the Discord ping fires exactly once per (member, reset-window) and §4 dispatch can cheaply re-check on each turn.

```bash
for w in $TEAM_WINDOWS; do
  # MEMBER reverse-lookup mirrors §1c — emoji-prefix → name-suffix → legacy strip.
  MEMBER=$(jq -r --arg w "$w" '.members[] | select(.emoji != null and .emoji != "" and ($w | startswith(.emoji))) | .name' .claude/team.json 2>/dev/null | head -1)
  if [ -z "$MEMBER" ]; then
    MEMBER=$(jq -r --arg w "$w" '.members[] | select($w | endswith(.name)) | .name' .claude/team.json 2>/dev/null | head -1)
  fi
  [ -z "$MEMBER" ] && MEMBER="${w#__${TEAM}__}"

  STATE_FILE="$HOME/.claude/teams/${TEAM}/rate-limited-${MEMBER}.json"
  TAIL=$(tmux capture-pane -t "$w" -p -S -15 | tail -10)

  # Match the rate-limit banner. Anthropic format: "May 13, 4pm (<tz>)" — capture
  # the timezone token verbatim from the banner so the parser stays correct if
  # Anthropic ever switches their banner timezone. The capture group preserves
  # whatever zone the banner declares.
  RL_MATCH=$(echo "$TAIL" | grep -oE "You've hit your limit · resets [A-Za-z]+ [0-9]+, ?[0-9]+[ap]m \([A-Za-z_/]+\)" | head -1)
  [ -z "$RL_MATCH" ] && continue

  # Parse reset date → epoch. Add current year — bare "May 13" without a
  # year sometimes resolves to a past year via `date -d`. Banner timezone
  # is captured from the parens.
  BANNER_TZ=$(echo "$RL_MATCH" | sed -E 's/.*\(([A-Za-z_/]+)\)$/\1/')
  RESET_HUMAN=$(echo "$RL_MATCH" | sed -E 's/^You.+resets //; s/ ?\([A-Za-z_/]+\)$//')
  YEAR=$(date +%Y)
  RESET_EPOCH=$(TZ="$BANNER_TZ" date -d "$RESET_HUMAN $YEAR" +%s 2>/dev/null)
  [ -z "$RESET_EPOCH" ] && continue  # parse failed — leave for next turn

  NOW=$(date +%s)

  # Reset has happened → dismiss the modal so next loop can execute, clear state.
  if [ "$NOW" -ge "$RESET_EPOCH" ]; then
    tmux send-keys -t "$w" Escape
    sleep 0.3
    rm -f "$STATE_FILE"
    continue
  fi

  # Already paged Discord for this same reset window → silent skip (still active).
  if [ -f "$STATE_FILE" ]; then
    PREV_RESET=$(jq -r '.reset_epoch' "$STATE_FILE" 2>/dev/null)
    [ "$PREV_RESET" = "$RESET_EPOCH" ] && continue
  fi

  # New rate-limit window for this member — record state + page Discord once.
  # RESET_LOCAL uses the operator's configured timezone (plugin userConfig COORDINATION_TZ / COORDINATION_TZ_SUFFIX; default UTC).
  RESET_LOCAL=$(TZ="${COORDINATION_TZ:-UTC}" date -d "@$RESET_EPOCH" +"%H:%M ${COORDINATION_TZ_SUFFIX:-UTC} %Y-%m-%d")
  printf '{"member":"%s","reset_epoch":%d,"reset_human":"%s","reset_local":"%s","detected_at":%d}\n' \
    "$MEMBER" "$RESET_EPOCH" "$RESET_HUMAN" "$RESET_LOCAL" "$NOW" > "$STATE_FILE"

  bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/ping-discord.sh" "🚫 **[whip-rate-limit]** · \`${TEAM}\` · \`${MEMBER}\` · $(TZ="${COORDINATION_TZ:-UTC}" date +"%H:%M ${COORDINATION_TZ_SUFFIX:-UTC}")

🚫 Teammate Claude account hit weekly cap — dispatch locked until reset.

⏰ Resets: \`${RESET_LOCAL}\` (banner: ${RESET_HUMAN} ${BANNER_TZ})
🎯 Member: \`${MEMBER}\` (pane: \`${w}\`)

Operator options:
1️⃣ Wait until \`${RESET_LOCAL}\` — whip auto-dismisses the modal at reset
2️⃣ Swap this team's \`claudeAccount\` in \`~/.atmux/cockpit.json\` to a different account, then cycle only this cage
3️⃣ Approve \`/extra-usage\` in the pane modal (operator decision, billed)

Whip will skip dispatching to \`${MEMBER}\` every turn until reset. No further pings for this reset-window."
done
```

**Effect on §4 dispatch:** before assigning a task to any member, check `~/.claude/teams/${TEAM}/rate-limited-${MEMBER}.json`. If the file exists and `reset_epoch` is in the future, skip this member entirely this turn. Healthy members keep getting work — one rate-limited teammate does not pause the whole loop.

**Why Discord-once-per-reset-window** (not the hourly cap from §1c): rate-limit windows last hours-to-days; re-pinging every hour is operator noise. The state file plus the `PREV_RESET == RESET_EPOCH` check ensures exactly one ping per (member, reset-window) pair. If Anthropic changes the reset time mid-window (account swap, plan upgrade), the new `RESET_EPOCH` differs and a fresh ping fires — which is correct behaviour.

**Lead's own rate-limit is OUT OF SCOPE here.** When the lead's account hits its cap, whip's own `ScheduleWakeup` callback gets eaten by the same modal — whip doesn't fire at all, so this code never runs to detect it. Cron-side `whip-watchdog` is the right surface for "lead went dark"; that's a separate follow-up (see §1c watchdog overlap note).

**Auto-dismiss after reset:** the `NOW >= RESET_EPOCH` branch sends a single Escape and clears the state file. The Escape closes the `/rate-limit-options` modal, returning the pane to its normal input prompt; the very next whip turn's §4 will treat the member as fresh-idle and either bootstrap (§4a) or dispatch (§4b).

**False-positive risk:** scrollback containing the literal banner text — e.g. a teammate's chat history quoting a prior rate-limit message — could re-trigger detection. Mitigation: we only inspect the LAST 15 lines (`tail -10` after `-S -15`), where only the live modal lives. Scrollback older than that doesn't trip the regex.

## 2. Read in-flight work

**2a. Driver inbox FIRST — MANDATORY EVERY TURN (including idle short-circuit)** — `~/.claude/teams/{team}/driver-inbox.md`.

This is the authoritative driver→lead channel (SendMessage from driver self-loops to void — known harness bug). Read top-to-bottom **every whip turn, no exceptions** — even when tunnel-focused on an in-flight teammate cycle (#X dispatch → reviewer gate → devops wire), even when team-lead.json inbox shows 0 unread, even when §0.5 reports IDLE=yes. The driver-inbox is the ONLY channel that surfaces new user intent mid-cycle; skipping it = asks from your user sit invisible for multiple ticks.

For every entry in `## Open` without a leading `✅`/`📤`/`⏳`/`❌` marker: triage NOW, write the marker inline at the start of the entry's first line, add a one-line "what I did" on the next line. Never delete entries; archive old ones >24h to the bottom `## Archive` section. This is higher priority than TaskList AND higher priority than continuing an in-flight teammate cycle — driver asks pre-empt teammate-side queue because they represent user intent.

**Concrete scan pattern (one Bash tool call):**
```bash
# Find entries under `## Open` that have no ✅/📤/⏳/❌ marker on the line after the ### header
awk '/^## Open/{in_open=1;next} /^## Archive/{in_open=0} in_open && /^### [0-9]{4}-/{h=NR;hdr=$0;mark=""} /^(✅|📤|⏳|❌)/{if(h)mark=$1;h=0} END{}' \
  ~/.claude/teams/{team}/driver-inbox.md
```
If this returns any unmarked entries, DO NOT short-circuit this turn. Process them before any teammate-side work.

**2b. Lead work queue** — `~/.claude/teams/{team}/lead-queue.md`.

Lead's own pending dispatches / decisions / follow-ups, distinct from TaskList (teammate work) and pending-decisions.md (asks for your user). Scan the `## Open` section, process anything whose `Deferred until:` condition is met, mark processed with `✅`/`📤`/`❌`. Add new entries when mid-turn interrupts force deferral of a thought.

**2c. Task list** — `TaskList` (Claude) / `orch_tasks list` (OpenCode).

- Skim TODO / task list.
- Pick up any `in_progress` task that's stalled.
- Note any `pending` task that's next up by dependency / priority.

## 3. Make judgment calls yourself

Do NOT punt a decision to the user if you can reasonably make it. Appropriate things to decide solo:

- Choice of approach when two reasonable options exist and the code hasn't committed either way.
- How to phrase an instruction to a teammate to unblock them.
- Whether to retry a flaky build / test before escalating.
- Whether to split a large task or keep it bundled (default: keep bundled unless >3 distinct concerns).

Appropriate things to escalate (see step 6): auth credentials, missing external access, genuinely ambiguous product requirements, destructive-action authorisation.

## 4. Dispatch the next task

### 4a. Bootstrap starving members FIRST

Before routine task dispatch, scan member panes for the **starving-member signature**: a pane that has `claude` running but **never received its bootstrap brief**. Members in this state cannot claim tasks no matter how many you `SendMessage` them — they're sitting at the Claude Code welcome screen with the autolaunch shell command captured as queued text in Claude's input box (known race: `autolaunchTeam` send-keys lands the `export ATMUX_MEMBER=... claude ...` command in Claude's input rather than the shell, because Claude UI is already up by the time the second send-keys fires).

Symptoms in a single capture-pane:
- Footer shows `0 tokens` and `ctx --` (no conversation history at all)
- Welcome banner (`Welcome` / `Welcome back …!`) visible in scrollback — i.e. Claude Code is at first-launch state with no conversation yet
- Input box contains the literal launch command starting with `❯ export ATMUX_MEMBER=`

```bash
for w in $TEAM_WINDOWS; do
  PANE=$(tmux capture-pane -t "$w" -p -S -50)
  echo "$PANE" | grep -qE '^[[:space:]]*0 tokens$' || continue
  echo "$PANE" | grep -qE '^[[:space:]]*Welcome\b' || continue
  echo "$PANE" | grep -qE '❯ export ATMUX_MEMBER=' || continue

  # All three matched → starving. Reverse-lookup MEMBER per §1c convention.
  MEMBER=$(jq -r --arg w "$w" '.members[] | select(.emoji != null and .emoji != "" and ($w | startswith(.emoji))) | .name' .claude/team.json 2>/dev/null | head -1)
  if [ -z "$MEMBER" ]; then
    MEMBER=$(jq -r --arg w "$w" '.members[] | select($w | endswith(.name)) | .name' .claude/team.json 2>/dev/null | head -1)
  fi
  [ -z "$MEMBER" ] && continue  # unknown window — leave for the operator
  ROLE=$(jq -r --arg m "$MEMBER" '.members[] | select(.name == $m) | (.role // "member")' .claude/team.json 2>/dev/null)
  [ -z "$ROLE" ] && ROLE="member"

  # Skip if this member is rate-limited (would just queue text into a frozen modal).
  RL_FILE="$HOME/.claude/teams/${TEAM}/rate-limited-${MEMBER}.json"
  if [ -f "$RL_FILE" ]; then
    PREV_RESET=$(jq -r '.reset_epoch' "$RL_FILE" 2>/dev/null)
    [ -n "$PREV_RESET" ] && [ "$(date +%s)" -lt "$PREV_RESET" ] && continue
  fi

  # Clear the queued launch-command text via Escape, then send the brief.
  # Two Escapes: first cancels queued input; second cancels any rewind modal
  # the first one opened (Claude Code's history-recall sometimes pops on
  # double-Escape — harmless to dismiss twice).
  tmux send-keys -t "$w" Escape
  sleep 0.3
  tmux send-keys -t "$w" Escape
  sleep 0.3
  tmux send-keys -t "$w" "You are member '${MEMBER}' (role: ${ROLE}) for team '${TEAM}'. Read ~/.claude/CLAUDE.md, the project CLAUDE.md at the cwd, and .atmux/team.json for context. Loop autonomously: \`atmux claim --next --as ${MEMBER}\` → work the claimed task end-to-end → commit + push → ping team-lead with the SHA via SendMessage → repeat. Do NOT pause for user input between claims — you are under permission-mode=auto. If you hit a tool prompt that auto mode can't dismiss, SendMessage team-lead with the prompt text + 'BLOCKED'; don't stall waiting silently."
  sleep 0.5
  tmux send-keys -t "$w" Enter
done
```

**Why bootstrap before task assign:** `SendMessage` to a starving member appends to the same queued-text buffer — nothing submits, nothing executes. The Enter pulse after the bootstrap brief is what actually submits ALL queued content (autolaunch leftover + bootstrap brief); Claude reads it together and parses the bootstrap brief as the operative instruction.

**Idempotence:** once the bootstrap brief executes, `0 tokens` becomes nonzero and the welcome banner scrolls past — the detection signature no longer matches on next turn. No state file needed.

**Rate-limit interaction:** §1d-marked rate-limited members are skipped above (their pane modal eats keystrokes). They'll bootstrap normally after reset, when §1d auto-dismisses the modal and the welcome banner re-emerges.

**Why this is a whip concern, not an atmux fix:** the autolaunch race lives in atmux's `autolaunchTeam` (`src/verbs/cockpit.ts`) and would be cleaner to fix at source. But until then, every team's lead has to recover starving members on its own — and the lead is the only entity that knows the role/atmux:team context to write a useful brief. Filing an atmux follow-up to fix at source doesn't relieve the in-flight recovery duty.

### 4b. Routine dispatch

Once §4a has handled any starving members, proceed normally:

- If any member is idle and there's a task matching their role: assign it. (Claude: `SendMessage` / `orch_message`; OpenCode: `orch_message`.)
- **Skip rate-limited members** — check `~/.claude/teams/${TEAM}/rate-limited-${MEMBER}.json` per §1d. If `reset_epoch` is in the future, route the task to another member with matching role or hold it. Do NOT `SendMessage` a rate-limited member — keystrokes are eaten and the task appears dispatched when it isn't.
- If no work matches their role but they're idle: either reassign to a cross-role task or leave them idle (fine — don't invent work).

## 5. Unblock stuck members

- If a member has been `ready` / idle for >10 min with a pending task: re-send the task with clearer context. Read their last message to diagnose *why* they stopped.
- If a member is in `error` state: check escalation status. If exhausted, mark the task `blocked` with a note and move on.
- If a member is running but clearly looping (same tool call repeating): send a `STOP — do X instead` message.

## 6. Escalate to the user ONLY for real blockers — via Discord

**Driver-routing protocol:** there is NO `driver` or `user` agent registered in `.claude/team.json`. The user is not a Claude agent, so `SendMessage to:user` routes to a void. **Discord is the only formal user-facing channel from the team-lead.**

### Universal execution rule — one tool call per `ping-discord.sh` invocation

Every Discord send is its own Bash tool call. **Never chain with `&&`, `||`, `;`, `|`, or subshells.** If you need to update a flush-timestamp file after the Discord ping, run that as a SECOND Bash tool call, not a compound command. Reason: the project's `.claude/settings.json` allowlist uses pattern matching that treats compound commands atomically — a chain-tail like `&& date +%s > FILE` causes the whole command to fall outside every allowlist pattern, so auto-mode prompts. Every prompt = whole team stalls until driver approves. One call = one operation.

### Universal Discord body format — applies to EVERY send

Your user reads Discord on mobile. The goal is **2-second triage**: is the team OK? does it need me? Lead with the answer, follow with delta, end with asks. Every Discord message has this exact shape:

```
{header-emoji} **[{category}]** · `${TEAM}` · HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}

**{VERDICT}** — one-line state, ≤80 chars

✨ **What's new** (optional, ≤3 milestone-named bullets — NOT SHA-named)
- {what shipped, named at the milestone level}
- {what shipped, named at the milestone level}

🙏 **Need from user** (only when asks exist)
- {ask, ≤60 chars}
  - A) {option, ≤60 chars}
  - B) {option, ≤60 chars}
  - **Default at HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}} if silent:** {recommended option + 1-line why-cheap-to-pivot}

📍 {footer: last commit Xmin ago · lead Ymin uptime · K complaints}
```

**The four fixed fields:**

1. **Header** — `<emoji> **[category]** · \`{team}\` · HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}`. Category is a bracketed slug: `[progress]`, `[blocker]`, `[heartbeat]`, `[decisions]`, `[bootstrap]`, `[deploy]`, `[budget]`, `[swap]`, `[watchdog]`, etc. Drop any legacy `whip-` prefix — every send is whip-shaped.
2. **Verdict** — the load-bearing field. Single-source vocabulary:
    - `🟢 Shipping` — N commits in window, healthy, no asks.
    - `🟡 Cool` — quiet on purpose (between phases, waiting on user, member rotating, deliberate pause).
    - `🟡 Idle` — quiet by accident, not yet a stall (fresh team, first dispatch in flight, rate-limit window).
    - `🔴 Stalled` — 0 commits + a symptom (lead silent / member wedged / staging down / dispatch halted). Watchdog territory.
    - `🚨 Need you` — only on `[blocker]` and `[decisions]` with a `[high]+` item. Sparingly — every `🚨` trains the eye; spamming dulls the channel.
3. **What's new** — ≤3 bullets, milestone-named (e.g. *"ADR-084 W3 task-update verb shipped"*), NOT SHA-named (NOT *"`d0e4947` — feat(start): port ADR-081 §C brief-paste"*). The reader doesn't `git log`; the bullet IS the value.
4. **Need from user** — every ask carries: (a) the question in ≤60 chars, (b) 2-3 lettered options, (c) a recommended default keyed to a deadline. Goal: user replies with one letter (`A` / `1B` / `defaults`) from their phone, no typing prose.
5. **Footer** (optional) — single line: `last commit Xmin ago · lead Ymin uptime · K complaints`. Skip on bootstrap/lifecycle pings.

**Hard cuts** vs. older spec:
- **No `🏗️ Shipped` / `📨 Dispatched` / `🎯 Team state` / `🔄 Rotations` sections.** They were snapshots, not signals. Verdict carries state; What's new carries delta.
- **No SHA-dump bullets.** SHAs go in the footer as a pointer only when one specific commit matters.
- **No "check team-log for detail" pointers.** The message MUST be the value — user won't ssh in to read a log.
- **No "Need from user: <vague ask>".** Always options + default + deadline.

**Banned formats:**
- Long prose paragraphs of 3+ facts joined with em-dashes.
- Single-paragraph status updates even when "short" — body sections are mandatory.
- Ad-hoc `[whip]` (catch-all) prefix — every message is a *named template*.

For real blockers needing the user, the template:

```
🚨 **[blocker]** · `${TEAM}` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

🚨 **Need you** — <1-line ask, ≤80 chars>

🙏 **Need from user**
- <the ask in ≤60 chars>
  - A) <option A in ≤60 chars>
  - B) <option B in ≤60 chars>
  - **Default at HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}} if silent:** <recommended + 1-line why-cheap-to-pivot>

📍 <context pointer — file, SHA, parallel work keeping team busy>
```

Bash invocation (note heredoc — multi-line bodies need it):

```bash
bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}"/skills/whip/scripts/ping-discord.sh "$(cat <<EOF
🚨 **[blocker]** · \`${TEAM}\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

🚨 **Need you** — UI palette for 13-domain re-skin

🙏 **Need from user**
- Aesthetic for the re-skin
  - A) Catppuccin Frappe — matches existing tooling, fastest
  - B) Custom per-surface palette — more cohesion, more work
  - **Default at 16:00 ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}} if silent:** A — cheap to pivot if you redirect

📍 screenshots \`docs/screenshots/phase0-*.png\` · FE parallel on \`#100 Step 3\` so no idle

EOF
)"
```

**Use `[blocker]`** when:
- Product ambiguity not in DoD or ADRs
- External credentials / access needed
- Destructive action needing authorisation (push to prod, force-reset, etc.)
- Any case where you've tried twice and genuinely need human judgment

**Do NOT `[blocker]`** for:
- "Test flaked" (retry it)
- "Build took longer than expected" (wait)
- "Member idle" (give them work)
- "Not sure which of 3 refactor approaches is cleanest" (pick one, move on)
- "Teammate auto-compacted" (§1b covers it; no user needed)

**Rate-limit:** at most 1 `[blocker]` per whip turn. If multiple blockers accumulate, combine into a single message with multiple asks rather than spamming.

## 6.5. Pending-decisions digest — Discord

Distinct from §6 (`[whip-blocker]` fires on a specific acute blocker). §6.5 is the **rolling digest** of decisions-for-the-user and concerns-for-attention that the team has been accumulating. Think of it as the written equivalent of "here's what I'd put in front of the user at the next standup."

The user reads Discord asynchronously. If they have been away for hours, they should not have to scroll through every `[whip-progress]` to reconstruct "what do I need to decide?". This digest is the answer.

### Artifact: `docs/pending-decisions.md` (living document)

The lead **maintains** this file across whip turns. Add items when you identify them; remove (or mark resolved) when the user answers or the item self-resolves.

```markdown
# Pending decisions + concerns — as of YYYY-MM-DD HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}

## 🔵 Decisions needed (user input blocks progress)

1. **[high] [since: HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}] <one-line question>** — <1-2 sentences of why this matters, what's blocked, what options are on the table, what the team recommends by default if no user input arrives.>

2. **[med] [since: HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}] <...>** — <...>

## 🟡 Concerns — worth attention, not blocking

- **[since: HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}] <...>** — <what's surprising, why you noticed it, whether the team is handling it or flagging it for awareness only.>

## 🟢 Resolved since last digest (for audit trail)

- **[resolved: HH:MM ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}] <previous item> → <outcome>**
```

**Rules for curation:**

- **Decisions** go in 🔵 only if the user's input is *actually* the blocker. If the team can pick a default and move on (§3: make judgment calls yourself), don't put it here — pick + document in team-log.
- **Concerns** go in 🟡 when the user should know but doesn't need to act right now. Auditor findings of non-P0 severity, unexpected test failures that auto-resolved, performance regressions detected mid-flight, etc.
- **Resolved** section is short-lived — each digest clears resolved items from the previous digest (keep last 5 for audit trail).
- **Priorities:** `[high]` = demo-blocker or 24hr-stale-risk. `[med]` = decide this week. No `[low]` — if it's low, it doesn't belong here.
- **Timestamps in ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}** with explicit suffix (timezone + suffix are coordination `userConfig` values).

### When to flush to Discord

Every whip turn, compare `docs/pending-decisions.md` content-hash to the last flushed version. Flush rules:

```bash
PEND_FILE="docs/pending-decisions.md"
PEND_FLUSH_FILE="$HOME/.claude/teams/${TEAM}/last-pending-flush.txt"

NOW=$(date +%s)
SHOULD_FLUSH="no"

if [ -f "$PEND_FILE" ]; then
  CURRENT_HASH=$(sha256sum "$PEND_FILE" | awk '{print $1}')
  LAST_HASH=""
  LAST_FLUSH_TS=0
  if [ -f "$PEND_FLUSH_FILE" ]; then
    LAST_HASH=$(head -1 "$PEND_FLUSH_FILE")
    LAST_FLUSH_TS=$(tail -1 "$PEND_FLUSH_FILE")
  fi

  MIN_SINCE_FLUSH=$(( (NOW - LAST_FLUSH_TS) / 60 ))

  # Flush if: content changed AND last flush >10min ago (debounce rapid-edit churn)
  #           OR: content unchanged AND last flush >60min ago (hourly heartbeat so
  #               your user does not need to scroll back to find the current state)
  if [ "$CURRENT_HASH" != "$LAST_HASH" ] && [ "$MIN_SINCE_FLUSH" -ge 10 ]; then
    SHOULD_FLUSH="yes"
    FLUSH_REASON="content changed since last digest"
  elif [ "$CURRENT_HASH" = "$LAST_HASH" ] && [ "$MIN_SINCE_FLUSH" -ge 60 ] && [ $(grep -c "^[0-9]\.\|^-" "$PEND_FILE") -gt 0 ]; then
    SHOULD_FLUSH="yes"
    FLUSH_REASON="hourly heartbeat (unchanged content, still pending)"
  fi
fi

if [ "$SHOULD_FLUSH" = "yes" ]; then
  # Count 🔵 high+med decisions and 🟡 concerns separately
  HIGH_COUNT=$(grep -cE "^[0-9]+\.\s+\*\*\[high\]" "$PEND_FILE")
  MED_COUNT=$(grep -cE "^[0-9]+\.\s+\*\*\[med\]" "$PEND_FILE")
  CONCERN_COUNT=$(awk '/^## 🟡/,/^## 🟢/' "$PEND_FILE" | grep -cE "^- \*\*")
  TOTAL=$(( HIGH_COUNT + MED_COUNT + CONCERN_COUNT ))

  if [ "$TOTAL" -gt 0 ]; then
    # Verdict: 🚨 Need you only when high-priority items exist; else 🟡 Cool
    if [ "$HIGH_COUNT" -gt 0 ]; then
      VERDICT="🚨 **Need you** — ${HIGH_COUNT} high-priority decision$([ "$HIGH_COUNT" -gt 1 ] && echo s), ${MED_COUNT} med, ${CONCERN_COUNT} concern$([ "$CONCERN_COUNT" -ne 1 ] && echo s)"
      HEADER_EMOJI="🚨"
    else
      VERDICT="🟡 **Cool** — ${MED_COUNT} open decision$([ "$MED_COUNT" -ne 1 ] && echo s), ${CONCERN_COUNT} concern$([ "$CONCERN_COUNT" -ne 1 ] && echo s), no high-priority"
      HEADER_EMOJI="📋"
    fi

    # Extract numbered-decision titles + concern titles, drop the explanatory prose
    # so the digest stays scannable. Full detail lives in docs/pending-decisions.md.
    DECISION_LINES=$(grep -E "^[0-9]+\.\s+\*\*\[(high|med)\]" "$PEND_FILE" | sed 's/\*\*$//' | head -8)
    CONCERN_LINES=$(awk '/^## 🟡/,/^## 🟢/' "$PEND_FILE" | grep -E "^- \*\*" | head -4)

    BODY="${HEADER_EMOJI} **[decisions]** · \`${TEAM}\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

${VERDICT}
"
    if [ -n "$DECISION_LINES" ]; then
      BODY="${BODY}
🔵 **Decisions needed** (titles only — full options in \`docs/pending-decisions.md\`)
${DECISION_LINES}
"
    fi
    if [ -n "$CONCERN_LINES" ]; then
      BODY="${BODY}
🟡 **Concerns**
${CONCERN_LINES}
"
    fi
    BODY="${BODY}
🙏 **Need from user** — reply with item-number + option-letter (e.g. \`1A\`, \`2 defaults\`) or open \`docs/pending-decisions.md\` for full context.

📍 ${FLUSH_REASON}"

    bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/ping-discord.sh" "$BODY"
    echo -e "${CURRENT_HASH}\n${NOW}" > "$PEND_FLUSH_FILE"
  fi
fi
```

**Why titles only, not the whole file:** when the .md grows past 10 items, dumping the whole thing floods Discord and dilutes the signal. Titles + count + pointer is enough for mobile triage; the user opens the .md (or pings the lead) when they want depth. Keep `docs/pending-decisions.md` rich; keep the Discord digest scannable.

### When NOT to flush

- **No `docs/pending-decisions.md` file** — nothing to flush. Skip silently.
- **Empty 🔵 + 🟡 sections** — skip (don't spam "nothing to decide").
- **Content unchanged AND last flush <60min ago** — skip (heartbeat debounce).
- **Content changed AND last flush <10min ago** — skip (rapid-edit debounce). The next turn will flush if still different.

### Edge cases

- **First flush after a new file is created:** treat as a content change → flush on next whip turn (after the 10min debounce).
- **File deleted:** no file → no flush. When lead re-creates it, next flush happens normally.
- **Long-idle team:** lead still maintains the file even during idle whips; the hourly heartbeat keeps the user's Discord up-to-date so they do not need to scroll back.

### How to populate it

Each whip turn, when §1-5 surface a user-decision-item:

1. Open `docs/pending-decisions.md` (create if missing with the template above).
2. Append under 🔵 or 🟡 with current ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}} timestamp.
3. Scan existing items for resolution (dispatch happened? user replied? auto-resolved?) → move to 🟢 with resolved timestamp.
4. Trim 🟢 section to last 5 items.

Don't write items you can resolve yourself (§3). Don't write items that are covered in team-log catch-up. This digest is strictly "what the user needs to see."

## 7. Update `docs/atmux:team-log/YYYY-MM-DD.md` — change-gated, per-day

Maintain a rolling team-log at `{cwd}/docs/atmux:team-log/YYYY-MM-DD.md` (one file per local-day). Most-recent entry at the top of that day's file (prepend, don't append). If today's file doesn't exist, create it.

**Write an entry ONLY when there is real delta since the last whip turn:**

- New files on disk (compare `git status -s --porcelain` untracked count to a stashed prior count, OR check `find {cwd} -type f -mmin -6 -not -path '*/node_modules/*' -not -path '*/.git/*'` for files modified since last whip), OR
- New commits in root or any submodule (`git log --since="6 min ago" --oneline` non-empty), OR
- A dispatch you just fired via SendMessage that represents a decision or unblock (not just "keep going"), OR
- A teammate moved from idle/stuck → working, or vice versa.

**If none of the above is true, DO NOT write an entry.** Silent whip turns are a feature — the log must stay signal-dense.

**Drift override — catches the post-compaction silent-skip failure mode.**

The change-gate above is easy to silently drop after auto-compaction ("I don't remember if I wrote an entry recently, guess no delta"). This check forces a catch-up:

```bash
TEAMLOG="docs/atmux:team-log/$(date +%Y-%m-%d).md"
LAST_ENTRY_AGE=0    # used only inside this block; Step 8 re-derives from disk mtime

if [ -f "$TEAMLOG" ]; then
  # stat -c is Linux-GNU; BSD/macOS would need -f %m if we ever port
  LAST_ENTRY_AGE=$(( ($(date +%s) - $(stat -c %Y "$TEAMLOG")) / 60 ))

  HAS_RECENT="no"
  git log --since='30 min ago' --oneline 2>/dev/null | grep -q . && HAS_RECENT="yes"
  for repo in apps/<node> apps/<ui> packages/<shared>; do
    if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
      git -C "$repo" log --since='30 min ago' --oneline 2>/dev/null | grep -q . && HAS_RECENT="yes"
    fi
  done

  if [ "$LAST_ENTRY_AGE" -ge 30 ] && [ "$HAS_RECENT" = "yes" ]; then
    echo "whip: DRIFT-OVERRIDE — forcing catch-up entry (${LAST_ENTRY_AGE}min stale, commits in window)"
    # MUST write a catch-up entry. Heading suffix: "— catch-up (${LAST_ENTRY_AGE}min drift)".
    # Shipped = git log --since="${LAST_ENTRY_AGE} min ago" across root + submodules.
    # Dispatched = best-effort from recent inbox writes (lead-side) + visible pane output.
  fi
fi
```

**Trigger: last team-log entry ≥30 min old AND any commit activity in that window (root or any submodule).** If tripped, the catch-up entry is mandatory — the change-gate's "no delta" exit does not apply.

**Entry format (prepend at top of file, under the `# Team Log` header):**

```markdown
## YYYY-MM-DD HH:MM (timezone) — whip turn

**Shipped** (since last whip, uncommitted unless SHA given):
- `path/to/file.ts` — <1-line what>
- <root-SHA or submodule-SHA> — <1-line commit subject>

**Dispatched:**
- `<teammate>` — <what you told them, ≤15 words>

**Blocked / surfaced:**
- <teammate or area> — <what's blocked, what's needed>

**Team state:** backend <working/idle/stuck/compacting>, frontend …, db …, devops …, testing …, reviewer …
```

Keep each section ≤5 bullets. Omit a section if it's empty. Do NOT duplicate git-log narrative — reference SHAs.

**File creation:** if today's `docs/atmux:team-log/YYYY-MM-DD.md` doesn't exist yet, `mkdir -p docs/atmux:team-log` and create the file with:

```markdown
# Team Log — YYYY-MM-DD

Rolling narrative of team progress maintained by `/atmux:whip`. Entries prepended (most recent at top). Only entries with real delta are written; silent whip turns are skipped.

---
```

**Pruning:** per-day files keep themselves naturally bounded. If a single day's file still grows past ~500 lines (pathological — very active day), split mid-day: rename to `YYYY-MM-DD-part1.md` and start a fresh `YYYY-MM-DD.md` (or `YYYY-MM-DD-part2.md`). Rare.

**Cross-day continuity:** each day's first entry should briefly reference the prior day's file (e.g., "Continuing from `docs/atmux:team-log/2026-04-17.md`"). Helps a future reader walking the log forward.

## 7.5. Discord flush — runs EVERY whip turn, independent of Step 7

**Discord is the user's offline signal** — too many pings become noise, silence when the team is shipping is worse. This step runs every whip turn (idle or active). The change-gate that governs team-log writes does NOT gate this step — it has its own machinery.

**Channel separation — every send is verdict-led:**
- `[progress]` — 15-min batched digest. Fires when real delta exists in the window. Verdict: 🟢 Shipping (committed) / 🟡 Cool (deliberate quiet, e.g. between phases) / 🟡 Idle (accidental quiet, e.g. fresh team, dispatch in flight).
- `[heartbeat]` — 30-min liveness ping. Fires ONLY when the team is **deliberately quiet** (no commits this window but no stall either — waiting on user, member rotating, between phases). If team should be shipping and isn't, that's `[watchdog]` 🔴 Stalled territory, not heartbeat.
- `[blocker]` — immediate, never batched. Verdict: 🚨 Need you. Rare. See §6.
- `[decisions]` — pending-decisions digest. See §6.5.

The verdict line is single-source vocabulary: `🟢 Shipping` / `🟡 Cool` / `🟡 Idle` / `🔴 Stalled` / `🚨 Need you`. Pick exactly one per send.

**Mechanism — flush marker:**

All placeholders are substituted from `.claude/team.json` at runtime — no `{team}` literals reach the Discord message. Track `DISCORD_STATE` across branches so Step 8 can report accurately.

```bash
# --- Runtime substitutions (do NOT leave `{team}` / `{team-name}` literals in any ping) ---
TEAM=$(jq -r .name .claude/team.json 2>/dev/null || echo unknown)
FLUSH_FILE="$HOME/.claude/teams/${TEAM}/last-discord-flush.txt"
SESSION_START_FILE="$HOME/.claude/teams/${TEAM}/lead-session-start.txt"
NOW=$(date +%s)

# --- First-turn init: seed flush-file against session-start so the 15-min clock has a real baseline ---
SEEDED=0
if [ ! -f "$FLUSH_FILE" ]; then
  SEED=$(cat "$SESSION_START_FILE" 2>/dev/null || echo "$NOW")
  mkdir -p "$(dirname "$FLUSH_FILE")"
  echo "$SEED" > "$FLUSH_FILE"
  SEEDED=1
  echo "whip: flush-file seeded with session-start=$SEED"
fi

LAST_FLUSH=$(cat "$FLUSH_FILE" 2>/dev/null || echo 0)
MIN_SINCE_FLUSH=$(( (NOW - LAST_FLUSH) / 60 ))

# --- Cross-repo commit count for the verdict line ---
count_commits() {
  local since="$1"
  local n=0
  n=$(( n + $(git log --since="$since" --oneline 2>/dev/null | wc -l) ))
  for repo in apps/<node> apps/<ui> packages/<shared>; do
    if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
      n=$(( n + $(git -C "$repo" log --since="$since" --oneline 2>/dev/null | wc -l) ))
    fi
  done
  echo "$n"
}

COMMITS_30M=$(count_commits '30 min ago')
COMMITS_15M=$(count_commits '15 min ago')

# --- Cross-repo last-commit-age (footer) ---
last_commit_age_min() {
  local newest=0 t
  t=$(git log -1 --format=%ct 2>/dev/null || echo 0); [ "$t" -gt "$newest" ] && newest=$t
  for repo in apps/<node> apps/<ui> packages/<shared>; do
    if [ -d "$repo/.git" ] || [ -f "$repo/.git" ]; then
      t=$(git -C "$repo" log -1 --format=%ct 2>/dev/null || echo 0)
      [ "$t" -gt "$newest" ] && newest=$t
    fi
  done
  echo $(( (NOW - newest) / 60 ))
}

LAST_COMMIT_AGE=$(last_commit_age_min)

# --- Lead uptime (footer) ---
LEAD_UPTIME_MIN=0
if [ -f "$SESSION_START_FILE" ]; then
  LEAD_UPTIME_MIN=$(( (NOW - $(cat "$SESSION_START_FILE")) / 60 ))
fi

# --- 30-min heartbeat: ONLY fires when team is deliberately quiet ---
# Deliberately quiet means: no commits in 30min AND no stall symptom (lead alive,
# no wedged members, no rate-limit). If the team SHOULD be shipping but isn't,
# watchdog cron handles the 🔴 Stalled ping — this branch stays silent so the
# two channels don't double-fire. The lead names the reason for the quiet in the
# verdict-suffix slot below — if you can't name one, skip the ping entirely.
if [ "$SEEDED" -eq 0 ] && [ "$MIN_SINCE_FLUSH" -ge 30 ] && [ "$COMMITS_30M" -eq 0 ]; then
  # Sample reasons for the verdict suffix:
  #   "between phases — Phase 3 sign-off pending"
  #   "waiting on user — 2 high-priority decisions open"
  #   "rotating ${MEMBER} after 60min uptime"
  bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}"/skills/whip/scripts/ping-discord.sh "$(cat <<EOF
💓 **[heartbeat]** · \`${TEAM}\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

🟡 **Cool** — <one-line reason for the deliberate quiet, ≤80 chars>

📍 last commit ${LAST_COMMIT_AGE}min ago · lead ${LEAD_UPTIME_MIN}min uptime · ready to resume on your nudge
EOF
)"
  echo "$NOW" > "$FLUSH_FILE"
  LAST_FLUSH=$NOW
  MIN_SINCE_FLUSH=0
  echo "whip: heartbeat fired (deliberate quiet, 30min window)"
  # Heartbeat + progress are mutually exclusive within a single turn.
fi

# --- Normal 15-min batched digest ---
# Progress fires when the window has real delta. Bullet contents are
# milestone-named, NOT SHA-named. The lead reads recent team-log entries +
# commit subjects and translates "feat(start): port ADR-081 §C brief-paste
# into TS spawn loop" → "ADR-081 brief-paste lives in TS spawn loop now".
if [ "$SEEDED" -eq 0 ] && [ "$MIN_SINCE_FLUSH" -ge 15 ] && [ "$COMMITS_15M" -gt 0 ]; then
  RECENT_ENTRY=$(tail -100 "docs/atmux:team-log/$(date +%Y-%m-%d).md" 2>/dev/null \
    | awk '/^## [0-9]{4}-/ {if (++n==2) exit} {print}')

  # The lead composes the body per the universal Discord format (§6 above).
  # Variables shown here are the verdict-line + footer (mechanical); the
  # **What's new** bullets are HAND-CURATED from RECENT_ENTRY — never
  # mass-extracted by awk/sed.
  bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}"/skills/whip/scripts/ping-discord.sh "$(cat <<EOF
📊 **[progress]** · \`${TEAM}\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

🟢 **Shipping** — ${COMMITS_15M} commits in ${MIN_SINCE_FLUSH}min, 0 asks, 0 stalls

✨ **What's new**
- <milestone-named bullet 1, ≤80 chars>
- <milestone-named bullet 2, ≤80 chars>
- <milestone-named bullet 3, ≤80 chars>

📍 last commit ${LAST_COMMIT_AGE}min ago · lead ${LEAD_UPTIME_MIN}min uptime
EOF
)"
  echo "$NOW" > "$FLUSH_FILE"
  echo "whip: progress digest fired (${COMMITS_15M} commits, 15min window)"
elif [ "$SEEDED" -eq 0 ] && [ "$MIN_SINCE_FLUSH" -ge 15 ] && [ "$COMMITS_15M" -eq 0 ]; then
  echo "whip: progress skipped — 0 commits in 15min window (heartbeat handles deliberate quiet)"
elif [ "$SEEDED" -eq 0 ]; then
  echo "whip: Discord flush skipped — ${MIN_SINCE_FLUSH}min since last, threshold 15"
fi
```

Step 8 reads the flush-file's mtime (not shell variables) to derive whether Discord fired this turn, so shell state does not need to propagate across `Bash` tool calls.

**Execution rule — DO NOT chain `ping-discord.sh` with follow-up commands via `&&`.** Each bash line in the block above is its own **separate Bash tool call**. Combining via `bash ... && echo ... > FLUSH_FILE` defeats the project's `.claude/settings.json` allowlist (it treats compound commands atomically). Result: the lead stalls on a `Do you want to proceed?` prompt every flush. **Each bash line = one tool call.**

**Rules:**

- **Verdict line is mandatory.** Pick exactly one of `🟢 Shipping` / `🟡 Cool` / `🟡 Idle` / `🔴 Stalled` / `🚨 Need you` per send. No verdict = malformed message.
- **What's new bullets are hand-curated**, NOT awk-extracted from team-log. Translate `feat(start): port ADR-081 §C brief-paste into TS spawn loop` → `ADR-081 brief-paste lives in TS spawn loop now`. The reader gets the milestone, not the log.
- **No standalone `Shipped` / `Dispatched` / `Team state` / `Rotations` sections.** They were snapshots, not signals. Verdict carries state; What's new carries delta.
- **Blockers are NOT batched** — `[blocker]` fires immediately. Real blockers need fast user response.
- **Rotations** are folded into the verdict line ("🟡 Cool — rotating `backend-1` after 60min uptime") or the `[swap]` template for emergencies.
- **Heartbeat fires only on deliberate quiet.** If you can't name a real reason for the silence, skip and let watchdog cron speak with 🔴 Stalled if applicable.
- **First-turn baseline** — flush-file is auto-seeded with session-start time on the first whip turn. Do NOT flush immediately — the 15-min clock starts counting from session-start.

**Milestone-grade bullets — examples of the translation step:**

| Source (commit subject) | ❌ NOT-useful bullet | ✅ Milestone-grade bullet |
|---|---|---|
| `d0e4947 feat(start): port ADR-081 §C brief-paste into TS spawn loop` | `✅ \`d0e4947\` — feat(start): port ADR-081 §C brief-paste into TS spawn loop` | `ADR-081 brief-paste lives in TS spawn loop now (replaces bash port)` |
| `2ba5a12 feat(task): add 'task update' subverb` | `✅ \`2ba5a12\` — feat(task): add 'task update' subverb` | `\`task update\` subverb shipped (ADR-084 W3)` |
| `3b57579 feat(test): bun-runtime cage-safety preload` | `✅ \`3b57579\` — feat(test): bun-runtime cage-safety preload` | `bun-cage preload prevents accidental \`bun test\` inside the team cage` |
| `cee5c0d feat(claim): race-condition gate — refuse member claim of in-progress task` | `✅ \`cee5c0d\` — feat(claim): race-condition gate` | `claim verb refuses concurrent owner stomp (race-condition gate)` |
| (three commits all touch the auditor RLS pass) | `✅ a / b / c — feat(rls): ...` × 3 | `auditor signed off RLS coverage on the 7 cross-DB ref-sites (7/7)` |

**Emoji key — section labels in body:**

| Emoji | Use |
|---|---|
| ✨ | Section — "What's new" |
| 🙏 | Section — "Need from user" / "Need from operator" |
| 📍 | Footer line (liveness pointers — last commit / lead uptime / complaints) |
| 🟢 | Verdict — Shipping |
| 🟡 | Verdict — Cool / Idle |
| 🔴 | Verdict — Stalled |
| 🚨 | Verdict — Need you (blocker / high-priority decision only) |
| 💓 | Header — heartbeat category |
| 📊 | Header — progress category |
| 🚨 | Header — blocker / stalled-watchdog category |
| 📋 | Header — decisions category |
| 🚀 | Header — bootstrap / deploy lifecycle |
| 🔄 | Header — account swap lifecycle |
| 🔧 | Header — self-heal / repair |
| ⚠️ | Header — budget warning |
| 🌅 | Header — budget refresh-soon |

**No per-bullet section emojis** on `✨ **What's new**` lines — the section label carries enough. Bullets are dash-prefixed, prose-grade ≤80 chars, milestone-named.

**Total message ≤2000 chars** (Discord limit). Practically, the verdict-first format keeps this comfortable: a typical `[progress]` is ~400 chars; `[blocker]` with 3-option ask is ~600 chars.

**Blocker messages (immediate, not batched)** — see §6 for the canonical `[blocker]` template. Single source of truth: §6.

For significant autonomous decisions outside the team-log (memory updates, ADR tweaks, standing-decision changes), also leave a short note in the whip turn's text output so the user sees it in the pane.

## 8. Re-arm + mandatory status line

**Every whip turn must end with a one-line status summary printed to the pane.** This makes silent drift visible to the driver — if Step 7 or 7.5 was quietly skipped, the driver sees it.

### 8.0. Attention + verdict markers — prefix the status line

The driver scans whip status lines across many panes; un-marked lines force a full read of each. **Prefix every whip-line status with two markers** so the driver can scan-skim and only stop on lines that need attention:

- **Attention**: 👁 prefix means "operator-action-requested in this turn" — driver MUST read. No marker = informational, safe to skim.
- **Verdict**: one of ✅ (working / shipping / healthy), ⚠ (sliding but not actionable yet — watch), 🔴 (broken now — needs intervention), ℹ (neutral fact — observed, no judgment).

Format: `<attention?> <verdict> whip: turn=…, …`

Examples:

- `✅ whip: turn=active, streak=0, team-log=wrote, discord=flushed, cadence-mode=auto, re-arm=270s, shipped=3sha` — active turn, work landed
- `✅ whip: turn=idle, streak=2, team-log=silent-no-delta, discord=skipped-9min-of-15, cadence-mode=auto, re-arm=270s` — quiet, no drift
- `⚠ whip: turn=idle, streak=5, team-log=stale-40min, discord=skipped-40min-of-15, cadence-mode=auto, re-arm=3600s, shipped=0in2h` — sliding; team produced 0 commits in 2h, watch next turn
- `👁 🔴 whip: turn=active, streak=0, team-log=stale-42min, discord=skipped-42min-of-15, cadence-mode=auto, re-arm=270s, shipped=0in4h, blocker=permission-prompt-be-1` — operator unblock required NOW
- `👁 ⚠ whip: turn=active, member rate-limited 5h-100%, route=other-account-not-available, re-arm=3600s` — operator-decision: budget shuffle vs wait

The verdict is derived from observed state (commit-cadence, member health, rate-limits) NOT from how busy the turn felt. Per §0.05 stakes: a turn where the team produced 0 commits despite full panes IS NOT ✅. If the only deliverable was "re-armed" — that's at best ⚠, more often 🔴.

Self-check before picking the marker: would the driver, scan-skimming 8 team status lines in 5 seconds, be misled if I picked ✅ for this turn? If yes, downgrade.

Cross-skill consistency: `/atmux:sweep` uses the same verdict scheme in its lead-queue + operator reports (per [ADR-212](../../../../docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) the medic role retired but the marker scheme persisted into `/atmux:sweep`).


Derive the status from disk, not shell variables — Steps 7, 7.5, and 8 typically run in separate `Bash` tool calls, so in-memory shell state does NOT persist between them. File mtimes are the source of truth:

```bash
TEAM=$(jq -r .name .claude/team.json 2>/dev/null || echo unknown)
TEAMLOG="docs/atmux:team-log/$(date +%Y-%m-%d).md"
FLUSH_FILE="$HOME/.claude/teams/${TEAM}/last-discord-flush.txt"
NOW=$(date +%s)

# team-log state from disk mtime
if [ -f "$TEAMLOG" ]; then
  TLAGE=$(( (NOW - $(stat -c %Y "$TEAMLOG")) / 60 ))
  if [ "$TLAGE" -lt 2 ]; then
    TLSTATE="wrote"           # just touched this turn
  elif [ "$TLAGE" -ge 30 ]; then
    TLSTATE="stale-${TLAGE}min"   # drift-override should have fired; flag if not
  else
    TLSTATE="silent-no-delta"
  fi
else
  TLSTATE="missing"
fi

# discord state from flush-file mtime
if [ -f "$FLUSH_FILE" ]; then
  FAGE=$(( (NOW - $(stat -c %Y "$FLUSH_FILE")) / 60 ))
  if [ "$FAGE" -lt 2 ]; then
    DSTATE="flushed"          # [whip-progress] or [whip-heartbeat] just fired
  else
    DSTATE="skipped-${FAGE}min-of-15"
  fi
else
  DSTATE="no-flush-file"      # first-turn seed should have created it
fi

# --- Adaptive cadence resolution ------------------------------------------
# Track idle streak for auto-adaptive mode.
TURN_KIND=${TURN_KIND:-active}   # §0.5 short-circuit path sets this to "idle"
STREAK_FILE="$HOME/.claude/teams/${TEAM}/atmux:whip-idle-streak.txt"
if [ "$TURN_KIND" = "idle" ]; then
  STREAK=$(cat "$STREAK_FILE" 2>/dev/null || echo 0)
  [[ "$STREAK" =~ ^[0-9]+$ ]] || STREAK=0
  STREAK=$((STREAK + 1))
else
  STREAK=0
fi
echo "$STREAK" > "$STREAK_FILE"

# Read cadence override. File contents:
#   - missing OR "auto" OR "fast" OR "default" → adaptive (270s active, 3600s after 3 idle turns)
#   - integer                                  → locked at that value
#   - anything else                            → fallback to 270
CADENCE_FILE="$HOME/.claude/teams/${TEAM}/whip-cadence.txt"
CADENCE_SETTING=$(cat "$CADENCE_FILE" 2>/dev/null || echo auto)
CADENCE_MODE="manual"
case "$CADENCE_SETTING" in
  auto|fast|default|"")
    CADENCE_MODE="auto"
    # Adaptive: slow after 3 consecutive idle turns, fast otherwise.
    if [ "$STREAK" -ge 3 ]; then
      CADENCE=3600
    else
      CADENCE=270
    fi
    ;;
  *)
    if [[ "$CADENCE_SETTING" =~ ^[0-9]+$ ]]; then
      CADENCE=$CADENCE_SETTING
    else
      CADENCE=270
    fi
    ;;
esac
[[ $CADENCE -lt 60 ]]   && CADENCE=60
[[ $CADENCE -gt 3600 ]] && CADENCE=3600

echo "whip: turn=${TURN_KIND}, streak=${STREAK}, team-log=${TLSTATE}, discord=${DSTATE}, cadence-mode=${CADENCE_MODE}, re-arm=${CADENCE}s"
```

Expected healthy patterns (cadence-mode=auto by default; `manual` when user ran `/atmux:whip cadence <N|slow>`):
- `whip: turn=active, streak=0, team-log=wrote, discord=flushed, cadence-mode=auto, re-arm=270s` — normal busy turn with 15-min window elapsed
- `whip: turn=active, streak=0, team-log=wrote, discord=skipped-7min-of-15, cadence-mode=auto, re-arm=270s` — team-log updated, Discord on cooldown (expected)
- `whip: turn=idle, streak=1, team-log=silent-no-delta, discord=skipped-11min-of-15, cadence-mode=auto, re-arm=270s` — quiet team, first idle turn (still fast-cadence since streak < 3)
- `whip: turn=idle, streak=3, team-log=silent-no-delta, discord=skipped-40min-of-15, cadence-mode=auto, re-arm=3600s` — 3 idle turns in a row, adaptive auto-slow kicked in
- `whip: turn=active, streak=0, team-log=wrote, discord=flushed, cadence-mode=auto, re-arm=270s` — (post-idle) work resumed, auto-fast snap-back on first active turn

Patterns that mean you're drifting (recurrence of the failure this prompt was hardened against):
- `team-log=stale-42min` + `discord=skipped-42min-of-15` — you skipped Step 7 and Step 7.5 both fired no-op. Re-run them NOW.
- `discord=no-flush-file` after the first turn — Step 7.5 seeding logic was skipped. Re-run Step 7.5.

Then re-arm using the `${CADENCE}` read above:

- Claude Code: `ScheduleWakeup(delaySeconds: ${CADENCE}, prompt: "<<autonomous-loop-dynamic>>", reason: "whip re-arm")`. Default 270s stays inside the 5-min prompt-cache TTL; 300s is the cache-miss cliff (per `ScheduleWakeup` docs). Adaptive auto-slow jumps to 3600s after 3 consecutive idle turns (~14min at fast cadence) and auto-snaps back to 270s on the next active turn. Manual lock via `/atmux:whip cadence slow` (3600) or `/atmux:whip cadence <N>` (integer). Do NOT round up within [301, 1199].
- OpenCode: return from the turn normally — `WhipMonitor` re-arms on the next `session.idle`.

## Guardrails

- Don't spawn new team members during a whip turn unless the plan explicitly calls for it.
- Don't start a new multi-hour task without a clear end state.
- Don't push to prod, merge PRs, or run destructive ops (force-push, reset --hard, dropping data) without the user online.
- If the team is healthy and there's no work: say so tersely and re-arm. Idle is a legitimate state.
