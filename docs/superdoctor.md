# superdoctor

Operator reference for the cockpit-level self-healing role introduced in [ADR-077](./adr/077-superdoctor-cockpit-role.md).

## What it is

A second Claude Opus session in the operator cockpit, sitting at window 2 (right after `superdriver`, before the per-team viewer windows). It runs an hourly `/whip` loop and asks: *is anything abnormal in atmuxland, and if so, why, and how do I prevent it from happening again?*

| | superdriver (window 1) | superdoctor (window 2) | per-team lead |
|---|---|---|---|
| **Lives at** | cockpit `atmux_teams:1` | cockpit `atmux_teams:2` | each team's cage `:driver` window |
| **Cadence** | operator-driven (interactive REPL) | own `/loop /whip`, hourly | per-team whip (270s default) |
| **Owns** | cross-team dispatch, ad-hoc decisions | diagnosis loop, complaint authoring, structural fixes | one team's coordination |
| **Talks to operator via** | direct (it IS the REPL) | `pending-decisions.md` + Discord pings | driver-inbox + Discord |

## When you want it

- Running ≥2 atmux teams concurrently.
- Long autonomous sessions where George is asleep / AFK and you want a third hand catching recurring issues before they compound.
- After an incident: the post-mortem-author + structural-fix-proposer role, captured durably in the complaint box.

## When you don't want it

- Solo Mode (single team, driver is also the lead) — the operator already owns the diagnosis loop interactively.
- Cost-constrained sessions — superdoctor is one extra Opus + xhigh session running a whip cycle every hour.
- During a tight demo loop — its action authority might pick up the wrong signal mid-rehearsal. Disable it for the demo window; re-enable after.

Default state: **off**. Activation is opt-in per operator.

## Enabling it

Add a `superdoctor` block to `~/.atmux/cockpit.json`:

```jsonc
{
  "cockpitSession": "atmux_teams",
  "superdoctor": {
    "enabled": true,
    "claudeAccount": {
      "configDir": "/root/.claude-personal",
      "label": "personal"
    },
    "tuiOverrides": {
      "effortLevel": "xhigh",
      "permissionMode": "auto",
      "pluginDir": "/root/work/journals/.sb/claude-skills"
    }
  },
  "teams": [ /* ...as today */ ]
}
```

Then:

```bash
atmux cockpit rebuild
```

Window 2 of the cockpit session shows `superdoctor`. Per-team viewers shift to windows 3..N (was 2..N before).

To disable: set `enabled: false` (or remove the block) and re-run `atmux cockpit rebuild`. The window is killed; no other cockpit shape changes.

## What it does each whip turn

Hourly `/loop /whip` cycle, in order:

1. **Read its own inbox** (`inbox_messages` table, member `__superdoctor__`) — heads-up nudges from team leads or members.
2. **Sweep each enabled team** — `atmux doctor --json` + `atmux status --json` per team. Detection layer (ADR-019).
3. **Triage** — silent if all green. If yellow/red anywhere, route into investigation.
4. **Investigate** — trace the anomaly to its root cause. Read git log, recent commits, lead-queue entries, driver-inbox archive. Forks an Agent (Sonnet for read-only research) when the search is wide.
5. **Decide authority level**:
   - File-only (default): write a complaint to the affected team's complaint box; ping its lead via `atmux send <team>:<lead>`.
   - Action: rotate a wedged lead, clear a confused member, cycle a stuck cage, push a fix to atmux's own source on a branch.
   - P0 send-keys bypass (rare): direct `tmux send-keys` to a member or lead pane when the SQL inbox routing is too slow (e.g. demo in 20min, member wedged on a recoverable error).
6. **Author preventive ask** — every complaint includes a `preventive_ask` field. The point isn't fixing this incident; it's ensuring the next one doesn't happen.
7. **Log everything** — every action superdoctor takes is logged to its own complaint box first. Audit trail survives a misdiagnosis.

## What its actions look like

These are illustrative (the actual action set is decided by the model at runtime per the auto-mode brief, not hard-coded):

| Anomaly | Likely action | Preventive ask |
|---|---|---|
| atmux team's cage died because tests ran inside it | Cycle the cage; restart the team; ping lead | "lead must dispatch e2e tasks with `--cage isolated` flag" |
| Member wedged on a permission prompt for 30+ min | `tmux send-keys` BTab cycle to flip into auto mode | "spawn pattern in CLAUDE.md should always set `--permission-mode auto`" |
| Discord ping silent for 4h on a team that should be active | `atmux doctor --fix`; verify webhook URL | "add webhook reachability to `atmux start` preflight" |
| Recurring lead rotation timing out | Rotate lead via `/team rotate-lead`; capture context | "60min auto-rotate threshold is too short for this team's task complexity" |
| Two teams competing for the same staging URL | File complaint with both team leads; pause the offending push | "branch-staging URL collision detector at deploy time" |

## P0 send-keys escalation runbook

**When**: superdoctor is allowed to bypass the SQL inbox and write directly to a teammate's pane via `tmux send-keys` only when (a) demo in <30min and a member is wedged on a recoverable error, OR (b) active stack regression and the team-lead's whip is stuck, OR (c) disk-full / process-table-full anomalies the team can't recover from autonomously. Anything else is a level-5b action (file complaint + `atmux send <team>:<lead>`), not P0.

**Hard rules** (verbatim from the skill brief, repeated here so the operator can audit):

1. **Read pane state FIRST** — global "always read pane state BEFORE tmux send-keys" applies. `tmux capture-pane -p -t <window> -S -30 | tail -20` and interpret. Don't send into a `Compacting conversation` banner. Don't send into a queued-message state. Don't send if a permission prompt is open (the keystroke answers the wrong question).
2. **Audit-log to complaint box BEFORE executing** — the complaint row carries `kind = 'p0'` and `incident_summary` literally containing the phrase `P0 send-keys bypass`. If superdoctor crashed mid-bypass, the audit row survives.
3. **Never against `superdriver` pane** — that's the operator's territory. Superdoctor does not write into it under any circumstances.
4. **Never `--no-verify` / `--no-gpg-sign` / hook-bypass** — global CLAUDE.md rule, no exceptions, even under P0.
5. **One-shot** — if the bypass doesn't unstick the target on the next pane state read (1 sweep later), escalate to the operator via `pending-decisions.md` + Discord ping. Do not retry; retrying compounds the misdiagnosis.

**Sequence**:

```text
# 1. Identify target window (capture state first)
TARGET_WIN="<team-cage-socket>:<member-window-name>"
tmux capture-pane -p -t "$TARGET_WIN" -S -30 | tail -20

# 2. Author the complaint row BEFORE acting (file-only at first; status='open')
#    Once F2 ships:
#    atmux complaints file <team> --kind p0 \
#        --summary "P0 send-keys bypass: <one-line>" \
#        --root-cause "<one sentence>" \
#        --ask "<preventive ask>"
#    Until F2 ships: write to ~/.claude/skills/superdoctor/lead-queue.md
#    inline.

# 3. Execute the bypass
tmux send-keys -t "$TARGET_WIN" "<recovery keystroke>"
# (e.g. BTab to flip permission mode, or a one-line message)

# 4. Update the complaint row with outcome
#    atmux complaints resolve <id> --note "<observed result on next sweep>"
```

**Recovery patterns observed in the wild** (not exhaustive):

| Wedge | P0 keystroke | Notes |
|---|---|---|
| Member stuck on permission-prompt modal | `BTab` until status line shows `auto mode on` | Modes cycle: don't-ask → accept-edits → default → auto. Verify via capture-pane. |
| Member queued message but not submitted | `Enter` | Only if the queued text is the right text — otherwise risks sending the wrong message. |
| Lead pane on `Compacting conversation` | DO NOTHING. Compaction completes on its own. | False-positive wedge — bypass would corrupt the compaction. |
| Cage tmux server alive but no driver session | `tmux -S <socket> kill-server` then `atmux cockpit rebuild` | Not actually a send-keys path — cage cycle. P0 because the team is fully offline. |

**What this is NOT**: superdoctor doesn't use `tmux send-keys` for routine messages. Routine = `atmux send <team>:<lead> "..."`. P0 send-keys is reserved for moments when the SQL inbox routing latency itself is the blocker.

## What it must NOT do

Inherited from CLAUDE.md global policies:

- **No force-push to `origin/main`** — universal.
- **No push to `origin/${product}-staging`** — operator-manual only (push policy, ADR-024).
- **No actions against any product's prod environment** — superdoctor scope is the operator's dev box + cockpit + dev/staging only.
- **No skipping pre-commit hooks** — `--no-verify` and friends are off-limits, period. (Superdoctor has no chat path to the operator for explicit one-off authorisation.)
- **No `atmux send` writes to driver/superdriver panes.** Operator-only territory.
- **No `git reset --hard`, `git push --force`, or kill -9 of any non-cage process.** Destructive ops require operator clearance via `pending-decisions.md` + Discord ask.

A misdiagnosis here lives in the complaint box as a self-filed complaint. Future-superdoctor reads it on the next session and learns.

## Reading the complaint box

The complaint box is the durable artifact of the diagnosis loop. It ships as the `complaints` table in each team's `<root>/.atmux/state.db` (sqlite-migrations.ts v2) plus the `atmux complaints` verb family.

Access patterns:

```bash
# Open complaints in the current team's state.db
cd /root/work/src/atmux
atmux complaints list

# Filter by status
atmux complaints list --status resolved
atmux complaints list --all   # every status

# Machine-readable
atmux complaints list --json

# File a new complaint
atmux complaints file \
    --summary "cage cycled itself" \
    --root-cause "tests ran inside the team's own cage" \
    --ask "lead must dispatch e2e with --cage isolated" \
    --by superdoctor

# Resolve one (after the preventive_ask has shipped)
atmux complaints resolve <id> --note "ADR-079 implements the preventive ask"
atmux complaints resolve <id> --wontfix --note "rejected — not actually a bug"
```

Cross-team listing (one query across every cockpit-roster team's state.db) is not yet a single command — operator can iterate via shell or wait for a follow-up that adds `atmux complaints list --all-teams`.

The shape (per ADR-077 §D5):

- `incident_summary` — what happened, in one sentence.
- `root_cause` — why it happened. Not "the test failed" — "the test was running inside the team's own cage instead of an isolated cage, so when it cycled tmux it killed the team's lead."
- `preventive_ask` — what change to atmux / the playbook / the skill brief would prevent recurrence. Often becomes an ADR or a kanban task.
- `status` — open / resolved / wontfix.
- `related_task_id` — kanban task that implements the preventive ask, when one exists.

## Talking to it

**Heads-up from a team member or lead** (e.g. "I think this stall is recurrent, please look"):

```bash
atmux send __superdoctor__ "lead-queue suggests this dispatch failure has happened 3x in 2 weeks — possible structural issue"
```

The message lands in `inbox_messages` table with member `__superdoctor__`. Superdoctor reads it on the next whip turn (worst case ~1h latency).

**P0 to the operator** — superdoctor itself escalates by writing to `pending-decisions.md` (operator's authoritative ask channel) and Discord-pinging George (`[superdoctor]` prefix per CLAUDE.md format rules).

## Comparison with other roles

- **`atmux doctor` (verb)** — deterministic checks. Detection only, no diagnosis. Run on-demand or as `atmux start` preflight. Superdoctor invokes `atmux doctor --json` as one input among many during its whip turn.
- **`atmux whip watchdog` (verb)** — per-team liveness one-shot. Pane-state classifier + cage health. Superdoctor sweeps watchdog output across all teams.
- **per-team lead** — coordinator inside one team. Superdoctor doesn't replace a lead; it watches across leads and addresses cross-team / structural issues that no single lead can see.
- **`/whip` skill** — the cycle engine that drives the whip loop. Superdoctor uses it the same way a team-lead does, with a different role brief (the deferred superdoctor skill).

## Status

ADR-077 §D1 + §D2 (cockpit topology + schema), §F1 (skill brief in `~/.claude/skills/superdoctor/`), §F2 (complaint box SQLite + `atmux complaints` verb), §F3 (`atmux send __superdoctor__` validator), §F4 (P0 send-keys runbook), and §F5 (status verb superdoctor surface) all ship. Setting `superdoctor.enabled: true` in `~/.atmux/cockpit.json` and running `atmux cockpit rebuild` spawns window 2 with a Claude Opus session that — when invoked as `/loop /superdoctor` — runs the hourly diagnosis loop end-to-end.

Open follow-ups (not blocking):

- `atmux complaints list --all-teams` — one query across every cockpit-roster team's state.db. Operator can iterate via shell until this lands.
- Cross-cockpit federation (Phase 6+) — multiple superdoctor instances coordinating across geographic regions.
