---
name: whip
description: Unified whip skill. Verbs — run (autonomous-work nudge loop, default), cadence (tune re-arm interval), watchdog (liveness one-shot). Use /atmux:whip <verb> or `/loop /atmux:whip` for the main loop.
argument-hint: [run | cadence <slow|fast|default|status|N> | watchdog [team]]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:whip — unified autonomous-work skill

Single entry point for the three whip surfaces:

- **`run`** (default, bare) — autonomous-work nudge loop. Fires ~5 min after last user input, dispatches, escalates real blockers, re-arms.
- **`cadence <args>`** — tune the re-arm interval per-team.
- **`watchdog [team]`** — manual one-shot liveness check (primary path is cron, not this slash command).

Dispatch is on the first argument. **Empty args → `run`** (this preserves the `/loop /atmux:whip` contract). Unknown first arg → print usage + exit.

## Verb dispatch

```bash
case "${1:-run}" in
  run)            ;;   # main loop turn — see §Run
  cadence)        ;;   # re-arm override — see §Cadence
  watchdog)       ;;   # liveness one-shot — see §Watchdog
  help|--help|-h) echo "Usage: /atmux:whip [run | cadence <slow|fast|default|status|N> | watchdog [team]]"; exit 0 ;;
  *)              echo "Unknown verb '$1'. Usage: /atmux:whip [run | cadence <args> | watchdog [team]]"; exit 1 ;;
esac
```

---

## §Run — main loop turn (default)

Autonomous-work nudge. Fires every N seconds (default 270s; overridable via `cadence`). Tells the lead to continue working, make judgment calls, and only escalate real blockers.

Dual-harness: this is the Claude Code entry point; OpenCode runs the same logic via `WhipMonitor` in `opencode-plugin-orch` (`src/core/whip-monitor.ts`), which reads the same `whip-prompt.md` so both harnesses behave identically.

### How to run

- **Start**: `/loop /atmux:whip` — dynamic mode. The skill self-paces via `ScheduleWakeup` at the end of each turn, reading cadence from `~/.claude/teams/${TEAM}/whip-cadence.txt` (fallback 270s).
- **Stop**: reply `stop` on the next whip turn, or exit the session.
- **Restart after `/clear`**: `/loop /atmux:whip` again.

### Instructions

Each time this skill fires in `run` mode, do the following. Keep the response terse — goal is *action*, not narration.

1. **Load the shared prompt.** Read `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/whip-prompt.md` and follow it verbatim. It is the single source of truth for whip behaviour (shared with the OpenCode harness).

2. **Check for `.claude/team.json`** in the current cwd. If absent, exit cleanly — whip is a no-op without a team.

3. **Execute the prompt.** Do the team check, dispatch/unblock work, make judgment calls. Do NOT stop and wait for the user.

   **Eternal-improvement fallback** (operator directive 2026-05-20): if the team check finds zero work to dispatch/unblock AND zero pending claims AND every member is genuinely idle (not paused / not rate-limited / not mid-rotation), run one eternal-improvement cycle for this team — file ONE `[improve P3]` task per the first heuristic that hits, in this order (formerly `/atmux:bruh` §0.7, retired per ADR-288 §D4; the list is inlined here so nothing dangles):

   1. **Tech-debt grep** — `rg -nE 'TODO|FIXME|HACK|XXX' src/ docs/ -g '!**/node_modules/**' | head -10`; pick one TODO with concrete actionable scope and file it with the verbatim `file:line` + a fix sketch.
   2. **ADR §OQ follow-ups** — `rg -nE '^### OQ-|^## Open questions' docs/adr/ | head -10`; an open OQ older than 30 days is a candidate — file a P3 task to resolve it via ADR amendment.
   3. **Test coverage gaps** — run the project's coverage probe (e.g. `bun test --coverage`) and pick the lowest-coverage tracked file; file "Raise X.ts coverage from N% to 100% — add tests for [uncovered lines]".
   4. **Aged doctor warn rows** — `atmux doctor --json | jq '.rows[] | select(.status == "yellow")'`; pick a row yellow for >7 days and file a task to fix it (not suppress it).
   5. **Lint warning sweep** — if the lint run reports >50 warnings, file one P3 sweep task; below 50 the signal/noise is too low.
   6. **Stale memory entries** — `find <claude-memory-dir> -name '*.md' -mtime +90 | head -5`; file a P4 task to triage + archive.

   Constraints: default priority P3, one task per cycle (a slow drip, not a flood), title prefix `[improve P3] …`, body cites the exact heuristic hit, skip a heuristic when a sibling improvement task is already in `todo` for the same hit.

   Do NOT lengthen the cadence yet — let §Cadence's adaptive slow-down fire only if the team STAYS idle after the improvement-task injection. Skip the fallback if operator freeze is in lead's driver-inbox last 24h. This replaces the legacy "idle = slow down" reflex with "idle = generate self-directed work".

4. **Escalate only real blockers.** If and only if a blocker needs user input (credentials, ambiguous product decision, external access), call:

   ```
   bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/ping-discord.sh" "🚨 **[whip-blocker]** · \`$TEAM\` · $(TZ='${COORDINATION_TZ:-${user_config.COORDINATION_TZ}}' date +'%H:%M ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}}')

<what's blocked> — <what team tried> — <what's needed>"
   ```

   Format rule: emoji + bold bracket-tag + `·` separators + ${COORDINATION_TZ_SUFFIX:-${user_config.COORDINATION_TZ_SUFFIX}} timestamp. Body below header with blank line. Grep-tag (`[whip-blocker]`) stays inside the bold so Discord search still hits it.

   Healthy state = no Discord ping. The user should only be paged when you genuinely need them.

5. **Re-arm.** At the end of the turn, read cadence from `~/.claude/teams/${TEAM}/whip-cadence.txt` (fallback 270 if missing/invalid; clamp to [60, 3600]), then call:

   ```
   ScheduleWakeup(delaySeconds: ${CADENCE}, prompt: "<<autonomous-loop-dynamic>>", reason: "whip re-arm")
   ```

   **Default 270s, not 300s.** 270s stays inside the 5-min prompt-cache TTL. 300s crosses the TTL boundary — cache miss. Per `ScheduleWakeup` docs: "drop to 270s (stay in cache) or commit to 1200s+".

   **Override via `/atmux:whip cadence`** (see §Cadence). Don't lengthen unilaterally — Discord-flush and team-log cadences assume 270s firing rate during active work.

### §Run notes

- **Timer reset on user input**: Claude Code resets implicitly — a new user turn ends the current loop cycle; the next whip fires after the next `/loop` turn end. No code needed.
- **Not a daemon**: whip dies with the session. `/clear` or exit kills the loop. Re-arm with `/loop /atmux:whip` if you want it back.
- **Discord flush window is separate**: `[whip-progress]` batches team-log delta over a 15-min window. That's a batching boundary inside the whip prompt, NOT the re-arm cadence.
- **Discord helper degrades gracefully**: if `DISCORD_WHIP_WEBHOOK` secret isn't in Infisical `/shared`, the script logs a warning and exits 0; the whip still does team-check work.

---

## §Cadence — tune re-arm interval

`/atmux:whip run` re-arms via `ScheduleWakeup(delaySeconds: N)` each turn. This verb flips `N` per-team at runtime. **Default is adaptive** — 270s while team is active, auto-slows to 3600s after 3 consecutive idle turns, auto-snaps back to 270s on the next active turn. No config needed for this; `/atmux:whip cadence` only matters when you want to override the adaptive behavior.

### Sub-verbs

| Sub-verb | Writes | Cadence |
|---|---|---|
| `fast` / `default` / `auto` | delete file (restore default) | **adaptive** — 270s active, 3600s after 3 idle turns, snaps back on activity |
| `slow` | `3600` | **locked at 1 hour** — overrides adaptive; stays slow even during active work |
| `<N>` (integer seconds) | `N` (clamped to [60, 3600]) | **locked at N** — overrides adaptive |
| `status` | read-only | — prints current mode + value |

**Adaptive vs locked:**
- `auto` / `fast` / `default` / no-file → adaptive (recommended)
- `slow` → locked 3600 (use during rehearsal/live demo when no Discord chatter wanted regardless of team activity)
- `<N>` → locked N (power user)

**Idle-streak state** lives in `~/.claude/teams/{team}/atmux:whip-idle-streak.txt` (integer). Written by whip-prompt.md each turn. Resets to 0 on any active turn. Adaptive mode auto-slows when streak ≥ 3.

### When to slow down

- **Overnight** when team is idle — burning ~300k tokens/hour at 270s cadence for a silent team is waste. At 3600s you still get hourly heartbeat + emergency-signal propagation.
- **Post-demo wind-down** — work shipped, team idle, the user wants to read without chatter.

**Note** (operator directive 2026-05-20): eternal-improvement (the six-heuristic list inlined in step 3 — formerly `/atmux:bruh` §0.7, retired per ADR-288 §D4) fires from `/atmux:whip run` step 3 BEFORE the adaptive slow-down. Real idle (slow-down triggers) only after the fallback runs and STILL finds no work to do. Empty kanban + every improvement-heuristic already filed = legitimate idle. Idle ≠ "nothing to do" — idle = "nothing to do AND nothing to improve".
- **Rate-limit pressure** — slowing the lead's cadence reduces its share of the usage bucket.
- **Demo rehearsal / live demo** — no Discord pings mid-presentation.

### When to restore fast

- **Active demo week** — sub-5-min turnaround between teammate commits matters.
- **Incident response** — faster Discord escalation for real blockers.
- **Any time the team resumes real work** — default is default for a reason.

### Usage

```
/atmux:whip cadence slow       # 3600s — 1 hour cadence
/atmux:whip cadence fast       # restore 270s default
/atmux:whip cadence default    # same as fast
/atmux:whip cadence 600        # 10 min custom
/atmux:whip cadence status     # show current
```

### Implementation

```bash
# Step 0 — resolve team
TEAM="$(jq -r .name .claude/team.json 2>/dev/null || echo '')"
if [ -z "$TEAM" ]; then
  echo "ERROR: no .claude/team.json in $(pwd) — run from a team project root"
  exit 1
fi
CONFIG_DIR="${HOME}/.claude/teams/${TEAM}"
CONFIG_FILE="${CONFIG_DIR}/whip-cadence.txt"
mkdir -p "${CONFIG_DIR}"

# Step 1/2 — parse sub-verb + apply
case "$2" in
  slow)
    echo 3600 > "$CONFIG_FILE"
    echo "✅ /atmux:whip cadence slow — locked at 3600s (manual)"
    ;;
  fast|default|auto)
    rm -f "$CONFIG_FILE"
    rm -f "${CONFIG_DIR}/atmux:whip-idle-streak.txt"   # reset streak so next tick starts at 270
    echo "✅ /atmux:whip cadence $2 — restored adaptive mode (270s active / 3600s after 3 idle turns)"
    ;;
  status)
    STREAK=$(cat "${CONFIG_DIR}/atmux:whip-idle-streak.txt" 2>/dev/null || echo 0)
    if [ -f "$CONFIG_FILE" ]; then
      VAL=$(cat "$CONFIG_FILE")
      case "$VAL" in
        auto|fast|default|"")
          echo "cadence: adaptive (override file says '$VAL'); idle-streak=$STREAK"
          ;;
        *)
          echo "cadence: locked at ${VAL}s (manual override at $CONFIG_FILE); idle-streak=$STREAK"
          ;;
      esac
    else
      if [ "$STREAK" -ge 3 ]; then
        echo "cadence: adaptive → currently slow (idle-streak=$STREAK, re-arm=3600s)"
      else
        echo "cadence: adaptive → currently fast (idle-streak=$STREAK, re-arm=270s)"
      fi
    fi
    ;;
  *)
    if [[ "$2" =~ ^[0-9]+$ ]]; then
      N=$2
      [[ $N -lt 60 ]]   && N=60
      [[ $N -gt 3600 ]] && N=3600
      echo "$N" > "$CONFIG_FILE"
      echo "✅ /atmux:whip cadence $N — locked at ${N}s (manual)"
    else
      echo "Usage: /atmux:whip cadence <fast|slow|auto|default|status|N-seconds>"
      exit 1
    fi
    ;;
esac
```

### Step 3 — report

Remind the user:
- Next whip tick reads the new value; currently-scheduled wakeup is NOT retroactively changed (fires on old schedule, re-arms on new).
- At ≥3600s, Discord `[whip-progress]` flushes drop to ~hourly. Don't stay slow during active work.
- Cache-miss cliff at 300s — don't pick values in [301, 1199]. Either ≤270 or ≥1200.

### §Cadence warnings

- **Team-log / Discord flush cadences assume 270s fires.** At 3600s, flushes batch hourly instead of per-15min. Fine overnight, lagging during active work.
- **Cache miss cliff at 300s.** Skill doesn't enforce the [301, 1199] prohibition; your judgement does.
- **No per-role override.** Sets one cadence for the whole team's lead-loop.
- **Never <60s.** ScheduleWakeup's own clamp is [60, 3600]; this skill mirrors it.

### §Cadence cross-skill coordination

- **`/atmux:session cont`** — if handoff landed under non-default cadence, `cont` does NOT restore default. File persists. `/atmux:whip cadence fast` explicitly to restore.
- **`/atmux:session stop`** — does NOT delete the file. End-of-day shutdown preserves cadence preference for tomorrow.
- **`/atmux:team stop`** — same; file is team-scoped state, survives team restarts.
- **`whip watchdog`** — reads the same file when computing stall thresholds (TODO: widen watchdog's 30-min stall heuristic proportionally at ≥3600s; currently still fires at 30min, which is correct — a stalled lead shouldn't be masked by slow cadence).

---

## §Watchdog — driver-side liveness check

**The primary path is cron** (per-team, `*/10 * * * *`). This slash command is the **manual one-shot** form — useful during active-shipping windows where you want a spot-check between cron ticks.

The canonical implementation lives in `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/watchdog.sh`. Cron invokes it directly; the path is **symlink-stable** post-wizard-install — per ADR-217 §D5 the wizard symlinks `~/.claude/plugins/atmux/` → `<atmux-source>/plugins/atmux/`, so atmux upgrades pick up new script bodies without rewriting the path operators wired into cron.

### Why this exists

The lead's `/atmux:whip run` loop self-reports via Discord. This watchdog exists because `/atmux:whip run` can fail silently — wedged process, bad compaction, rotation crash. An outside observer pages the user within ~10 min of crossing the 30-min stale threshold. Observed failure mode: a 2h 13min Discord dark period where lead was alive but not firing whip ticks, with nothing outside noticing.

The check is cheap (2 file stats + 1 pane capture + 1 `git log --since`) and rate-limited (1 alert per hour).

### Why cron, not a Claude loop

Mechanical check — no reasoning, no dispatch, no inbox reading. A Claude `/loop` at 10-min cadence exceeds the 5-min prompt-cache TTL, so every tick is a full cache miss (~$10-20 per driver session in Opus input tokens for zero real work). Cron runs the same logic at zero token cost; the Claude-side stays available only as an on-demand one-shot.

### How to run

#### Cron (primary — per-team, 10min cadence)

**Install** (one crontab entry per team):

```
*/10 * * * * bash ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/watchdog.sh <team-name> >>$HOME/.claude/teams/<team-name>/watchdog.log 2>&1
```

Verify `cron` is active: `systemctl status cron`.

**Uninstall**:

```bash
crontab -l | grep -v whip-watchdog/watchdog.sh | crontab -
```

**Logs**:

```bash
tail -f ~/.claude/teams/<team-name>/watchdog.log
```

#### Manual (one-shot, via this slash command)

```
/atmux:whip watchdog             # uses team from $(pwd)/.claude/team.json
/atmux:whip watchdog <team>    # explicit team arg
```

**Do NOT invoke on the lead** — it runs `/atmux:whip run` which has its own self-report.

### Implementation (manual path)

The script at `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/watchdog.sh` is the full implementation with all four checks (lead-stall, teammate-blockers, lead-blocker, teammate-uptime-nag). When running this slash command as a one-shot:

```bash
# Resolve team — arg overrides .claude/team.json
TEAM="${2:-$(jq -r .name .claude/team.json 2>/dev/null)}"
if [ -z "$TEAM" ] || [ "$TEAM" = "null" ]; then
  echo "ERROR: no team — pass as arg or run from a team project root"
  exit 1
fi

# Delegate to the canonical script — same logic as cron
bash "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/plugins/atmux}/skills/whip/scripts/watchdog.sh" "$TEAM"
```

### §Watchdog — what it checks (4 parallel)

1. **Lead-stall** — flush file >30min stale with commit/idle carve-outs. Alerts if commits happened but flush didn't fire, or lead stuck mid-turn.
2. **Teammate-blocker** — any non-lead `__{team}__*` pane stuck on interactive prompt. Rate-limit 1 alert/hour/member.
3. **Lead-blocker** — lead pane itself stuck on interactive prompt. Rate-limit 1 alert/15min (tighter — whole-team-blocked).
4. **Teammate-uptime-nag** — context age past 90min rotation threshold. Prefers `member-clear-<name>.txt` marker; falls back to process `etimes`. Consolidated ping per tick (not per-member).

Each check has its own rate-limit file under `~/.claude/teams/<team>/`. Full logic in `watchdog.sh`.

### §Watchdog notes

- **Not a replacement for /atmux:whip.** Watchdog only notices *absence* of /atmux:whip activity. Positive work happens in `run` mode.
- **Does not touch the team.** Pure observation + Discord ping.
- **Stale-flush is not itself a stall signal.** `/atmux:whip`'s change-gate (§7 of `whip-prompt.md`) legitimately skips flush during extended idle. Carve-outs filter those out. What fires an alert:
  - Commits in last 30min but flush didn't fire → change-gate should have triggered
  - Lead pane stuck mid-turn (thinking/compacting) → wedged process
  - Lead state unknown → can't confirm healthy, fire for safety
  - Flush file missing and lead up >45min → whip never seeded (crashed bootstrap)
- **Rate-limit 1 hour for lead-stall.** If lead dies, user gets one ping, not a hundred. After intervention, lead's first `run` tick touches flush file and watchdog resumes silent.
- **Discord helper degrades gracefully** — if webhook not configured, script logs warning and exits 0.

---

## Migration from old (operator-dotfiles) skill names

These hyphen-form slash commands existed only in operator-dotfiles unification predecessors; they were never bundled. Documented here so operators migrating their muscle memory know the canonical bundled forms:

- `/whip-cadence <args>` (dotfiles legacy) → `/atmux:whip cadence <args>`
- `/whip-watchdog` (dotfiles legacy) → `/atmux:whip watchdog [team]`
- `/whip` (dotfiles bare) → `/atmux:whip` (bundled, equivalent to `/atmux:whip run`)

Old slash-command entries do not exist in this plugin. The `whip/scripts/watchdog.sh` script path is **preserved** under `plugins/atmux/skills/whip/scripts/` — cron contracts stay intact.
