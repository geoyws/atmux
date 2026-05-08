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

## What it must NOT do

Inherited from CLAUDE.md global policies:

- **No force-push to `origin/main`** — universal.
- **No push to `origin/${product}-staging`** — George-manual only (push policy, ADR-024).
- **No actions against IFCA prod** — superdoctor scope is hax + cockpit + dev/staging only.
- **No skipping pre-commit hooks** — `--no-verify` and friends are off-limits unless George explicitly authorises (and superdoctor doesn't have a chat path to George; only the operator does, so the answer is always no).

A misdiagnosis here lives in the complaint box as a self-filed complaint. Future-superdoctor reads it and learns.

## Reading the complaint box

The complaint box is the durable artifact of the diagnosis loop. **Note: the complaint box is deferred** — its SQLite schema + verb family land as a follow-up under kanban epic `t-274ec70c` (Super-\* hierarchy port). Until then, superdoctor logs complaints inline to its lead-queue and Discord.

When the complaint box ships, the access pattern will be:

```bash
# All open complaints across all teams
atmux complaints list --status open

# One team's complaints
atmux complaints list atmux

# Resolve one (after the preventive_ask has shipped)
atmux complaints resolve <id> --note "ADR-079 implements the preventive ask"
```

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

Cockpit topology + schema landed in this commit (per ADR-077 §D1, §D2). Skill bootstrap brief, complaint box, and full inbox integration are deferred follow-ups in the kanban under epic `t-274ec70c`. Until those land, enabling superdoctor in `cockpit.json` spawns a window 2 with a Claude session that can read its inbox via raw SQL but doesn't have the role brief — it'll behave like a generic Opus session unless you hand-roll a prompt at start. Treat this commit as the topology cutover, not the production-ready superdoctor.
