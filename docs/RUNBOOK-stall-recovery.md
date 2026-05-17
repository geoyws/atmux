# Runbook — stall recovery (ADR-057 v1.1.x)

**Audience:** operators reading a Discord ping or a flag entry from
ADR-057's stall-prevention surfaces and needing to know what to do
about it. Most pings represent auto-recovery already in progress —
this runbook covers the cases where auto-recovery fails OR human
judgment is needed (defunct cwd, permission-mode drift, ambiguous
heartbeats).

**Why it matters:** ADR-057 turned a class of previously-silent stalls
into observable Discord findings. Each ping has a known root cause +
known remediation; this runbook is the lookup table. Without it,
operators page-swap context to read the ADR (8K words) every time a
ping fires.

**Pre-reads:**

- [`docs/adr/057-stall-prevention.md`](adr/057-stall-prevention.md) — full Decision rationale (D1-D7) + open questions.
- [`HANDOFF.md` §🛡️ v1.1.x stall-prevention](../HANDOFF.md) — operator-facing usage notes per Decision.
- [`docs/RUNBOOK-cron-migration.md` §v1.1.x cron-block migration](RUNBOOK-cron-migration.md#v11x-cron-block-migration--watchdog-line-adr-057-d6b) — installing the `*/2 atmux watchdog` cron line.

---

## Ping → action lookup

Each ping is one of: 🛑 `[whip-watchdog]`, 🛑 `[whip-stale-anchor]`,
🛑 `[whip-perm-mode-drift]`, 🚨 `[whip-defunct-cwd]`, ✅
`[whip-pr-update]`. Below: signal interpretation + recovery walk.

### `[whip-watchdog] <member> heartbeat <Nh> stale` (D6b)

**Source:** `*/2 atmux watchdog` cron tick reads
`.atmux/heartbeats/<member>.epoch` and finds it older than
`team.json::whip.stallPrevention.heartbeatStaleSec` (default 300s).

**What it usually means** — one of three:

1. **Member's TUI is genuinely wedged** (compacting >5min, modal stuck,
   feedback dialog blocking, rate-limit banner not auto-clearing).
   Most common cause.
2. **Heartbeat writer is broken** (supervisor stopped writing the
   epoch file). Less common; signaled by ALL members showing stale
   simultaneously.
3. **Member intentionally idle** (paused with `atmux pause` but the
   pane is still attached). Should not fire — paused members are
   excluded from heartbeat staleness checks. If you see this, file a
   bug.

**Diagnosis walk** (run in order, stop at first hit):

```bash
# Step 1 — confirm staleness is real
ls -la .atmux/heartbeats/<member>.epoch     # mtime should be <5min ago if healthy
date +%s                                     # current epoch
cat .atmux/heartbeats/<member>.epoch         # member's last heartbeat

# Step 2 — check the pane state directly
tmux capture-pane -p -S -30 -t <session>:<member-window> | tail -20
# Look for: "Compacting conversation", "You've hit your limit",
# Anthropic feedback modal ("Bad / Fine / Good / Dismiss"),
# "Press up to edit queued messages", or a bare `$` shell prompt.

# Step 3 — if pane is in MODAL/COMPACTING/RATE-LIMIT state, see remediation below
```

**Remediation by state:**

| Pane state | Action |
|---|---|
| `Compacting conversation` (>10min) | Wait — compaction can legitimately take 5-15min on large contexts. Re-check at 20min mark; if still compacting, consider `tmux kill-pane` + `atmux team rotate-member <name>`. |
| Anthropic feedback modal stuck | `tmux send-keys -t <session>:<member-window> Down Enter` to dismiss (selects "Dismiss"). Re-check pane after. |
| `You've hit your limit` rate-limit banner | Member is rate-limited at the account level. ADR-053 budget-pause path handles this; if no budget-pause kicked in, check `atmux cost --member <name>`. |
| `Press up to edit queued messages` | Queued message blocking input. Send `Up` then `Enter` to re-send the queued text, or `Esc Esc` to abort. |
| Bare shell prompt (`$` / `%`) — TUI crashed | `atmux team rotate-member <name>` re-spawns the TUI. Brief is re-pasted. |
| Nothing visible (blank pane, no banner) | Capture more scrollback (`-S -200`). If genuinely idle with no in-flight task → expected; supervisor heartbeat-writer probably has a bug — file the issue. |

**When auto-recovery is sufficient:** if the watchdog pings ONCE for a
member whose pane is mid-`Compacting conversation` AND compaction
completes within 10min, ignore the ping. The 24h dedup means you won't
get re-pinged for the same staleness window. This is the false-positive
case that's known + accepted (per ADR-057 §OQ-1).

### `[whip-stale-anchor] driver-inbox tip unread <Nh>` (D2d)

**Source:** whip-tick checks
`.atmux/state/last-driver-inbox-read.txt` cursor freshness vs
driver-inbox `mtime`. If lead's cursor is >2h behind tip AND tip has
new content: emits this finding (single ping per stale window;
hash-deduped).

**What it usually means:** lead was rotated, mid-`/clear`, or
mid-long-tool-call when new driver-inbox entries landed. Lead's cached
"I read up to entry N" cursor is now stale.

**Remediation:** none required for transient cases — lead's normal
whip-tick will catch up on next tick. The ping is informational. Only
act if persistent across rotations:

```bash
# If lead has been showing stale-anchor for >12h: force cursor reset
echo "$(date +%s)" > .atmux/state/last-driver-inbox-read.txt
# Lead's next whip-tick will read driver-inbox from scratch.
```

### `[whip-perm-mode-drift] <member> mode=<X>` (D4a)

**Source:** whip-tick checks each member's pane status-line for the
`⏵⏵ <mode> on` permission-mode glyph. Fires when not `auto`. Per-member
24h dedup.

**What it usually means:** someone (or a tmux quirk) cycled the
permission mode away from `auto`. CLAUDE.md mandates `auto` for team
members — non-auto modes stop on every tool call and require driver
intervention; that defeats parallelisation.

**Remediation — Shift+Tab cycle to `auto`:**

```bash
# Open the member's window
atmux attach
# (or: tmux switch-client -t <session>:<member-window>)

# In the member's pane, press Shift+Tab repeatedly.
# Watch the status indicator at the bottom of the pane:
#   ⏵⏵ don't ask on  → BTab → ⏵⏵ accept edits on
#   ⏵⏵ accept edits on → BTab → (default, no indicator)
#   (default)         → BTab → ⏵⏵ auto mode on
#   ⏵⏵ auto mode on   → BTab → (default again)
#   (default)         → BTab → ⏵⏵ don't ask on (loops)
#
# From `don't ask on` it's exactly 3 BTabs to reach auto.
# Verify: capture-pane and grep for "auto mode on".

tmux capture-pane -p -t <session>:<member-window> | grep -o "⏵⏵.*on"
```

**Alternative — full rotate (if BTab cycling is awkward over SSH):**

```bash
atmux team rotate-member <name>
# Re-spawns with --permission-mode auto from CLAUDE.md canonical pattern.
```

### `[whip-defunct-cwd] <member> path=<P>` (D4c)

**Source:** cron-groom checks each member's pane `pane_current_path`
exists on disk. Fires P1 flag + Discord ping when path is missing.

**What it usually means:** the worktree backing this member was
deleted (either intentional cleanup, branch-cleanup script, or
accident). The member's pane still has a stale `cd` to a path that no
longer exists; any `git` / file operations will fail silently or
mis-write to a parent directory.

**Remediation — two paths:**

1. **Restore the worktree** (if deletion was accidental):

   ```bash
   git worktree add <path> <branch>
   # Member's pane should re-anchor on next tool call. If not, rotate:
   atmux team rotate-member <name>
   ```

2. **Pause the member** (if deletion was intentional):

   ```bash
   atmux pause <name>
   # Member is excluded from dispatch + claim until resumed.
   # Decide whether to remove from team.json::members[] or leave paused.
   ```

**Do NOT** ignore this ping — it's P1 because subsequent file writes
from this member could land in the parent directory, polluting
unrelated worktrees or repos.

### `[whip-pr-update] <SHA>` (D7c)

**Source:** `atmux done` after auto-push (D7a) for PRs without a
configured webhook. Fires manual `[whip-pr-update]` Discord ping so
reviewer sees the new SHA.

**What it usually means:** porter just shipped a commit; reviewer
should look. No operator action required — this is reviewer-side
notification only.

**If you ARE the reviewer:** `git fetch origin && git log --oneline
origin/<branch> -5` to see what landed. Per-commit reviewer cycle per
CLAUDE.md ReviewDiscipline.

### `[whip-modal-cycling] <member>` (ADR-142)

**Source:** whip §1c modal-cycling detector. Fires when ≥3 distinct
modal-prompts land on a member's pane within
`modalCycling.windowMin` (default 30 min) AND `git log --since=<window>`
returns zero commits matching the member's claimed task. Pre-sentinel-
ship runs here; ADR-140 forward-compat ports the same detection
function to the sentinel's per-tick observer (renamed from "martinet"
per ADR-158; legacy keys still parse during grace cycle).

**What it usually means:** member is thrashing across a class of related
prompts (push variants, approval variants, retry variants) without
making real task progress. Distinct from `whip §1c teammate-blocked-
on-prompt` static-stuck (which catches *same prompt repeating*) —
modal-cycling catches *different prompts in rapid sequence*.

**Auto-recovery (happens before you see the ping):**

- Clarifier dispatched to member's pane: `[detector] modal-cycling
  detected — N prompts in <window>, 0 commits on <taskId>. Recommend:
  unclaim + retry from clean, or surface blocker via atmux reply if
  the prompt class is genuinely blocking work.`
- `atmux flags add` filed with severity=high + the modal class
  sequence in the body.
- Discord template fires once per `modalCycling.dedupMin` (default
  30 min) — recording continues every tick, only the surface action
  dedup'd.

**Manual escalation — if the cycling resumes after the clarifier:**

1. Read the modal-history file:
   `cat ~/.atmux/state/modal-history-<member>.json | jq '.[]
   | .modalText'` — see the prompt classes the agent's stuck in.
2. If a brief-content problem (wrong instructions causing the prompt
   loop): edit the member's brief, then `atmux clear <member>` to
   force a fresh session pick up the new brief.
3. If a genuine blocker (modal-cycling is the AGENT'S signal that
   the work is mis-specified): `atmux unclaim <taskId>` and re-route
   to planner via `atmux tell-lead`.

**Per-team opt-out / tuning:**

```json
// team.json
{
  "modalCycling": {
    "enabled": true,          // false to disable detection entirely
    "cycleThreshold": 3,      // distinct hashes in window to trigger
    "windowMin": 30,
    "commitGracePeriodMin": 30, // commits in this window suppresses fire
    "dedupMin": 30,             // surface-action dedup
    "exemptMembers": []         // designated roles that legitimately
                                // navigate modal sequences
  }
}
```

**Testing the detection (operator-side rehearsal):**

```bash
# Run the focused unit + e2e specs against your changes.
unset TMUX && bun test --timeout 30000 \
  tests/unit/core/modal-cycling-detector.test.ts \
  tests/unit/core/modal-cycling-state.test.ts \
  tests/e2e/modal-cycling-detector.test.ts
```

Each spec is a 1x cold-start walk per CLAUDE.md "stateful e2e specs
are not repeatable smokes" — don't streak; re-run with a fresh tmpdir
between invocations.

---

## Manual unblock — when auto-recovery fails

ADR-057 designs auto-recovery for the common case. Some failure modes
need operator intervention; this section is the playbook.

### Stuck lock — `acquireWithTTL` couldn't recover

**Symptoms:**
- `.atmux/logs/lock-recovery.log` shows recent recovery attempts but
  the same lock keeps re-appearing.
- Writers (kanban updates, inbox writes, decisions add) hang for >5min.
- `lsof | grep .atmux | grep .lock` shows live PID holding the lock.

**Diagnosis:**

```bash
# Step 1 — identify the live holder
ls -la .atmux/*.lock                          # see all locks
cat .atmux/<file>.lock                        # PID inside (D3b convention)

# Step 2 — verify the PID is live + what it's doing
ps -p <pid> -o pid,ppid,cmd                    # is it still atmux?
ls -la /proc/<pid>/cwd 2>/dev/null             # what cwd?
tail -5 /proc/<pid>/stack 2>/dev/null          # what syscall (Linux)?

# Step 3 — if the PID is genuinely stuck (e.g., NFS hang, broken pipe)
kill -SIGTERM <pid>                            # graceful first
# wait 10s, re-check; if still alive:
kill -SIGKILL <pid>                            # nuclear option

# Step 4 — clear the lock manually if D3a doesn't auto-clear next tick
rm .atmux/<file>.lock
# Next whip-tick re-attempts; auto-recovery audit logs the manual clear.
```

**When to escalate:** if the live PID is the supervisor itself, do
NOT kill it without a plan — the supervisor is what reads heartbeats
and dispatches. Use `atmux team rotate-lead` to migrate coordination
state to a fresh lead before killing.

### Heartbeat writer broken — ALL members show stale

**Symptoms:**
- `[whip-watchdog]` ping fires for every member at the same time.
- `ls -la .atmux/heartbeats/` shows mtime on ALL files older than 5min.

**Producer (D6a):** the per-member heartbeat is written by
`atmux heartbeat write <member>` (`src/verbs/heartbeat.ts`). Today the
caller is the cron-mediated `atmux poke` tick — `checkMember` in
`src/verbs/poke.ts` invokes `writeHeartbeat` (fail-soft) once per
per-member iteration, so a fresh heartbeat means the */5min poke loop
reached this member in `team.json` at least once in the last window.
A simultaneous stale-on-all-members signal therefore narrows to: cron
stopped firing, poke is wedged on the team-level lock, or the team
roster diverged from what poke iterates.

**Diagnosis:**

```bash
# Step 1 — is cron firing the poke tick at all?
tail -20 .atmux/logs/poke.log                  # last few ticks logged here
crontab -l | grep atmux                        # poke + watchdog lines installed?

# Step 2 — is poke wedged on its single-instance lock?
ls -la .atmux/state/whip.lock                  # stale lockfile?
fuser .atmux/state/whip.lock 2>/dev/null       # who's holding it?

# Step 3 — manual heartbeat write (smoke-test the producer path)
atmux heartbeat write <member> --team-dir <project-root>
ls -la .atmux/heartbeats/<member>.epoch        # mtime should be 'just now'
```

**Recovery:**

```bash
# Path A — cron is the missing piece (fresh host, post-restore, etc.)
atmux cron-install

# Path B — lock is wedged on a dead PID
rm .atmux/state/whip.lock                      # next */5 tick re-acquires

# Path C — manually run one tick to confirm the producer is alive again
atmux poke                                     # writes heartbeats for every member in team.json

# Path D — full session recycle (loses pane history; preserves kanban + inboxes)
atmux stop && atmux start
```

### Auto-push failed — porter task-end push didn't land

**Symptoms:**
- `atmux done <task>` succeeded (kanban transitioned), but
  `git log origin/<branch>..HEAD` shows local commits not pushed.
- `.atmux/logs/auto-push.jsonl` has `"status":"failed"` entries.

**Diagnosis:**

```bash
# Step 1 — check the JSONL log
tail -20 .atmux/logs/auto-push.jsonl | jq '.'
# Common reasons: rebase conflict, branch protection, network failure,
# remote ref non-existent (first push), staging-branch refusal (per
# CLAUDE.md push policy).

# Step 2 — manual push
git fetch origin
git rebase origin/<branch>                     # resolve conflicts manually if any
git push origin <branch>                       # may need --set-upstream on first push
```

**When the push policy refuses the push** (target is `origin/*-staging`):
this is the CLAUDE.md push-policy gate working correctly. Staging
branches are George-manual ONLY; auto-push refuses by design. Escalate
to George via `atmux tell-lead` if a staging push is needed.

---

## Postmortem reading — log files

The two structured logs that ADR-057 introduces are
`.atmux/logs/lock-recovery.log` (D3a) and `.atmux/logs/auto-push.jsonl`
(D7a). Both are append-only audit trails for after-the-fact analysis.

### `.atmux/logs/lock-recovery.log` (D3a audit)

**Format** — one line per recovery event:

```
<epoch> <lock-path> previous-pid=<N> reason=<R>
```

`<R>` is one of: `mtime-stale-no-pid` (lock had no PID), `dead-pid`
(PID didn't respond to `kill -0`), `manual-cleared` (operator removed
the lock file), `corrupt-lock` (lock file unparseable).

**Common postmortem queries:**

```bash
# Which locks recovered most often last 24h?
awk -v t="$(date -d '24 hours ago' +%s)" '$1 > t {print $2}' \
  .atmux/logs/lock-recovery.log | sort | uniq -c | sort -rn

# Was a specific PID ever the orphan-lock culprit?
grep "previous-pid=<PID>" .atmux/logs/lock-recovery.log

# Time-bucket recovery rate (1h windows)
awk '{ b = int($1 / 3600) * 3600; c[b]++ } END { for (b in c) print strftime("%FT%H", b), c[b] }' \
  .atmux/logs/lock-recovery.log | sort
```

**Healthy baseline:** <5 recoveries/day on a 4-member team. >20/day
suggests a writer is consistently crashing OR the lock-TTL is too
short for legitimate slow ops on this hardware. Tune
`team.json::stallPrevention.lockTtlSec` if needed.

### `.atmux/logs/auto-push.jsonl` (D7a audit)

**Format** — one JSON object per push attempt:

```json
{
  "ts": 1778130042,
  "task": "t-f892215c",
  "branch": "worktree-atmux-bun",
  "sha": "abc1234",
  "status": "ok|failed|refused",
  "stage": "fetch|rebase|push|policy",
  "stderr": "<exit message>",
  "durationMs": 1234
}
```

**Common postmortem queries:**

```bash
# Recent failures
jq 'select(.status == "failed")' .atmux/logs/auto-push.jsonl | tail -20

# Which stage fails most?
jq -r 'select(.status == "failed") | .stage' .atmux/logs/auto-push.jsonl \
  | sort | uniq -c | sort -rn
# (typical: rebase=N most-common, then push=M, then fetch=P)

# Push-policy refusals (staging branches blocked correctly)
jq 'select(.status == "refused" and .stage == "policy")' .atmux/logs/auto-push.jsonl

# Push latency distribution (slow CI / network issues)
jq -r 'select(.status == "ok") | .durationMs' .atmux/logs/auto-push.jsonl \
  | awk '{ s += $1; c++ } END { print "avg ms:", s/c, "n:", c }'
```

**Healthy baseline:** >95% ok rate over a 7-day window for non-staging
branches. Failures clustered in `stage=rebase` indicate multi-porter
race (D7b mitigation kicked in but conflicts surfaced); these need
porter judgment. Failures in `stage=fetch` are usually network /
remote issues.

---

## Verification checklist (per team)

After enabling v1.1.x stall-prevention on a team:

- [ ] `*/2 atmux watchdog` cron line installed (per
      [`RUNBOOK-cron-migration.md` §v1.1.x](RUNBOOK-cron-migration.md#v11x-cron-block-migration--watchdog-line-adr-057-d6b)).
- [ ] `.atmux/heartbeats/<member>.epoch` files exist + update every ≤60s
      (D6a supervisor write-path active).
- [ ] `team.json::whip.stallPrevention` block present + Zod validates clean
      (no `[whip-config-drift]` ping per ADR-054 — `atmux doctor` reports green).
- [ ] `.atmux/logs/lock-recovery.log` exists (created on first lock acquire).
- [ ] `.atmux/logs/auto-push.jsonl` exists (created on first `atmux done`
      with auto-push enabled).
- [ ] First `atmux watchdog` log line is `watchdog: all heartbeats fresh`
      OR `watchdog: <N> stale member(s) flagged this tick` — both healthy.
- [ ] Discord webhook receives test pings (try
      `atmux watchdog` while one heartbeat is artificially stale via
      `touch -d '10 minutes ago' .atmux/heartbeats/<member>.epoch`).

---

## How to verify cadence-truth-signal (ADR-148)

ADR-148 makes commit-cadence the canonical truth signal for "is this
member shipping?" — pane-aliveness is downgraded to a secondary
diagnostic. Verify the full chain end-to-end after a fresh deploy or
when the operator sees `🟢 alive` while suspecting dormancy:

1. **Per-member cadence column shows up in `atmux status`** (§D3):

   ```bash
   atmux status | rg '🟢 shipping|🟡 idle|🔴 dormant|🚨 ship-zero'
   ```

   At least one line per non-exempt member should match. Members on
   `team.cadence.exemptMembers` show `(exempt)`; teams with
   `team.cadence.enabled: false` show `—` and the column is omitted
   from the JSON snapshot (`atmux status --json | jq '.members[].cadence'`).

2. **Per-member classifier produces a verdict that matches `git log`**:

   ```bash
   # pick any non-exempt member's worktree
   git -C .atmux/worktrees/<member>/ log --since=2h --author=<member> --format='%H %ct' | head
   ```

   No output AND the cadence column shows `🚨 ship-zero (<age>)` →
   ADR-132 §E6 escalation gate is armed for that member. If the column
   instead shows `🟢 shipping (Xmin)` despite an empty git log, the
   gitLog probe is mis-targeting the worktree — `atmux doctor` should
   surface the path-resolution error.

3. **Sentinel escalation fires `ship-zero-2hr`** (renamed from "martinet"
   per ADR-158; legacy state-log path still tail-readable during grace
   cycle) when any per-member verdict is `ship-zero-window` (§D6, wired
   through `src/core/sentinel-escalation.ts::classify` E6 path). The
   cockpit-W3 dispatcher's tick log shows the reason verbatim:

   ```bash
   tail -50 ~/.atmux/state/sentinel-tick.log | rg 'ship-zero-2hr'
   ```

4. **Lane-stall fallback fires** when a `lane=X todo>30min` Task sits
   while every member with `lane=X` is non-shipping (§D4):

   ```bash
   # synthetic-fire path — manually invoke the verb if cron isn't installed yet
   atmux lane-stall-tick
   # check the fire ledger
   jq '.fires' ~/.atmux/state/lane-stall-fires.json
   ```

   Recent `(taskId, lane)` entries with `firedAt` within the last
   `laneStallMinAgeSec / 2` window are the dedup state — the verb
   skips re-firing the same `(taskId, lane)` within this window.

5. **Lead wake-nudge** (per `templates/briefs/team-lead.md` §D5): on
   `cadence verdict ∈ {idle, dormant, ship-zero-window}`, the lead's
   first wake attempt is `atmux send <member> "[lead] cadence verdict
   <X>; last commit <age>. What's the blocker?"`. If the lead reads
   `atmux status` but no `atmux send` followups land within 15min,
   either the brief isn't on-disk on the lead pane (check
   `~/.claude/teams/<team>/lead-bootstrap.txt` for the brief load time)
   OR the lead has drifted to passive-relay (rotate via `atmux team
   rotate-lead <team>`).

**E2E rehearsal:** `tests/e2e/cadence-truth-signal.test.ts` runs the
full chain (status column → classify() E6 fire → lane-stall-tick fire
→ wake-nudge brief shape → 2 backward-compat short-circuits) against
synthetic gitLog fixtures + injected sendKeys. Bun runs it in <1s:

```bash
unset TMUX && bun test --timeout 30000 tests/e2e/cadence-truth-signal.test.ts
```

12 beats, 1x cold-start+walk (non-idempotent — re-runs need a fresh
tempdir; the spec's `beforeAll`/`afterAll` handles that).

---

## Reference

- **ADR:** [`docs/adr/057-stall-prevention.md`](adr/057-stall-prevention.md) — full design.
- **HANDOFF section:** [`HANDOFF.md` §🛡️ v1.1.x stall-prevention (ADR-057)](../HANDOFF.md).
- **Cron migration:** [`RUNBOOK-cron-migration.md` §v1.1.x cron-block migration](RUNBOOK-cron-migration.md#v11x-cron-block-migration--watchdog-line-adr-057-d6b).
- **Watchdog verb:** `src/verbs/watchdog.ts`. Heartbeat reader: `src/core/heartbeat.ts::readHeartbeatAges`.
- **Lock primitives:** `src/abstractions/lock.ts::acquireWithTTL`. Audit log: `.atmux/logs/lock-recovery.log`.
- **Auto-push:** `src/core/auto-push.ts`. Audit log: `.atmux/logs/auto-push.jsonl`.
- **Pane-state classifier:** `src/core/pane-state.ts::classifyPane`. Send-keys gate: `src/core/safe-send.ts::safeSendKeys`.
- **Per-class Tasks:** R57-T1 (D1) / R57-T2 (D2) / R57-T3 (D3) / R57-T4 (D4) / R57-T5 (D5) / R57-T6 (D6) / R57-T7 (D7) / R57-T8 (this docs Task).
- **Cadence-truth-signal (ADR-148):** `src/core/cadence-classifier.ts` (classifier) + `src/core/sentinel-escalation.ts::classify` (E6 ship-zero-2hr gate; renamed from `martinet-escalation` per ADR-158) + `src/verbs/lane-stall-tick.ts` (§D4 lane-stall fallback) + `src/verbs/status.ts::formatCadenceColumn` (renderer). E2E rehearsal: `tests/e2e/cadence-truth-signal.test.ts`.
