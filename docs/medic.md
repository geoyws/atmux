# medic

> Operator reference for the cockpit-level self-healing role originally introduced as **`superdoctor`** in [ADR-077](./adr/077-superdoctor-cockpit-role.md) and renamed to **`medic`** on 2026-05-14 per [ADR-133](./adr/133-medic-rename.md). The role's design, authority surface, and complaint-box contract are canonical in ADR-077; only the role's *name* is superseded. **Storage-layer identifiers** (`superdoctor_attempts` table, `SuperdoctorAttemptsRepo`, member sentinel `__superdoctor__`, Discord dedup key `superdoctor-self-heal-escalation`) **remain unchanged** for the deprecation window per ADR-133 §Out of scope — table renames require a separate schema-migration ADR. The skill source (`~/.claude/skills/superdoctor/`) and Discord template prefix (`[superdoctor]`) rename land separately under EPIC `t-d25ff629` TR5 (plugin source) and follow-up work — until those ship, the operator-visible Discord prefix is `[superdoctor]` and the skill path stays put.

## What it is

A second Claude Opus session in the operator cockpit, sitting at window 2 (right after `superdriver`, before the per-team viewer windows). It runs an hourly `/whip` loop and asks: *is anything abnormal in atmuxland, and if so, why, and how do I prevent it from happening again?*

| | superdriver (window 1) | medic (window 2) | per-team lead |
|---|---|---|---|
| **Lives at** | cockpit `atmux_cockpit:1` | cockpit `atmux_cockpit:2` | each team's cage `:driver` window |
| **Cadence** | operator-driven (interactive REPL) | own `/loop /whip`, hourly | per-team whip (270s default) |
| **Owns** | cross-team dispatch, ad-hoc decisions | diagnosis loop, complaint authoring, structural fixes | one team's coordination |
| **Talks to operator via** | direct (it IS the REPL) | `pending-decisions.md` + Discord pings | driver-inbox + Discord |

(Per [ADR-135](./adr/135-cockpit-naming.md) the cockpit session is `atmux_cockpit` post-rename; pre-ADR-135 deployments still see `atmux_teams`.)

## When you want it

- Running ≥2 atmux teams concurrently.
- Long autonomous sessions where George is asleep / AFK and you want a third hand catching recurring issues before they compound.
- After an incident: the post-mortem-author + structural-fix-proposer role, captured durably in the complaint box.

## When you don't want it

- Solo Mode (single team, driver is also the lead) — the operator already owns the diagnosis loop interactively.
- Cost-constrained sessions — medic is one extra Opus + xhigh session running a whip cycle every hour.
- During a tight demo loop — its action authority might pick up the wrong signal mid-rehearsal. Disable it for the demo window; re-enable after.

Default state: **off**. Activation is opt-in per operator.

## Enabling it

Add a `medic` block to `~/.atmux/cockpit.json` (the legacy `superdoctor` key is still accepted during the deprecation window per ADR-133 §"Schema rename + backward-compat shim" — emits a deprecation warning, then proceeds normally):

```jsonc
{
  "cockpitSession": "atmux_cockpit",
  "medic": {
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

Window 2 of the cockpit session shows `medic` (formerly `superdoctor`). Per-team viewers shift to windows 3..N (was 2..N before).

To disable: set `enabled: false` (or remove the block) and re-run `atmux cockpit rebuild`. The window is killed; no other cockpit shape changes.

## Per-team `cageMode` flag (t-72a6b7d7 / c-a99bf461)

Each team entry in `~/.atmux/cockpit.json` accepts an optional `cageMode` field that declares operator intent for the team's cage tmux socket. Medic's sweep cross-references the declared mode against live socket-presence to colour each row — eliminating the pre-flag failure mode where "cage intentionally torn down" looked identical to "cage anomalously absent".

| `cageMode` value | sessionAlive=true | sessionAlive=false |
|---|---|---|
| `"autonomous"` (default — legacy configs without the field) | 🟢 cage healthy | 🔴 cage missing — autonomous team expected a live socket |
| `"direct"` (operator-driven, no cage by design) | 🟡 unexpected live cage — confirm intent | 🟢 direct-driver mode (no cage by design) |
| `"paused"` (intentionally down today) | 🟡 paused team has a live cage — clear pause or tear down | 🟡 paused — restart on next `atmux cockpit rebuild` |

Only the 🔴 cell is `actionable` (medic escalates it to the operator); every other cell is informational. The classifier is `verdictForCage(cageMode, sessionAlive)` in `src/core/superdoctor-cage-verdict.ts` — call it directly when wiring custom sweep logic.

```jsonc
{
  "sessions": [
    { "type": "team", "name": "sopx", "root": "/p/sopx" },              // → "autonomous" (default)
    { "type": "team", "name": "atmux", "root": "/p/atmux", "cageMode": "direct" },
    { "type": "team", "name": "unum", "root": "/p/unum", "cageMode": "paused" }
  ]
}
```

Legacy cockpit.json files without `cageMode` keep their pre-flag behaviour exactly — every team defaults to `autonomous`, and the medic sweep continues to flag socket-missing rows red.

## What it does each whip turn

Hourly `/loop /whip` cycle, in order:

1. **Read its own inbox** (`inbox_messages` table, member `__superdoctor__` — sentinel name unchanged for the deprecation window per ADR-133 §Out of scope) — heads-up nudges from team leads or members.
2. **Sweep each enabled team** — `atmux doctor --json` + `atmux status --json` per team. Detection layer (ADR-019).
3. **Triage** — silent if all green. If yellow/red anywhere, route into investigation.
4. **Investigate** — trace the anomaly to its root cause. Read git log, recent commits, lead-queue entries, driver-inbox archive. Forks an Agent (Sonnet for read-only research) when the search is wide.
5. **Decide authority level**:
   - File-only (default): write a complaint to the affected team's complaint box; ping its lead via `atmux send <team>:<lead>`.
   - Action: rotate a wedged lead, clear a confused member, cycle a stuck cage, push a fix to atmux's own source on a branch.
   - P0 send-keys bypass (rare): direct `tmux send-keys` to a member or lead pane when the SQL inbox routing is too slow (e.g. demo in 20min, member wedged on a recoverable error).
6. **Author preventive ask** — every complaint includes a `preventive_ask` field. The point isn't fixing this incident; it's ensuring the next one doesn't happen.
7. **Log everything** — every action medic takes is logged to its own complaint box first. Audit trail survives a misdiagnosis.

> **Cheap-model-first interaction (per [ADR-140](./adr/140-cheap-model-first.md))**: post-ADR-140, the hourly *scan loop* described above moves to an **event-driven** model — medic no longer fires a periodic sweep; it wakes on events written to `~/.atmux/state/medic-events.log` by the [ADR-132](./adr/132-pluggable-martinet.md) martinet (Cursor composer-2-fast, cockpit W3). Medic's **rotation authority is narrowed to code-fix scenarios** post-ADR-140; routine rotation (uptime / refusal / dormancy) moves to martinet. ADR-143's cron-rotate stopgap covers routine lead-rotation until martinet's CursorMartinet impl ships. This page describes the pre-ADR-140 hourly cadence (still in effect at time of writing); transition is sequenced via ADR-131 / ADR-132 / ADR-139 impl waves.

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

**When**: medic is allowed to bypass the SQL inbox and write directly to a teammate's pane via `tmux send-keys` only when (a) demo in <30min and a member is wedged on a recoverable error, OR (b) active stack regression and the team-lead's whip is stuck, OR (c) disk-full / process-table-full anomalies the team can't recover from autonomously. Anything else is a level-5b action (file complaint + `atmux send <team>:<lead>`), not P0.

**Hard rules** (verbatim from the skill brief, repeated here so the operator can audit):

1. **Read pane state FIRST** — global "always read pane state BEFORE tmux send-keys" applies. `tmux capture-pane -p -t <window> -S -30 | tail -20` and interpret. Don't send into a `Compacting conversation` banner. Don't send into a queued-message state. Don't send if a permission prompt is open (the keystroke answers the wrong question).
2. **Use verified send-keys** — per [ADR-138](./adr/138-verified-send-keys.md), every cross-pane keystroke from medic SHOULD route through `safeSendKeysWithVerify` with an appropriate built-in verifier. Direct `tmux send-keys` is reserved for cases where verification is N/A (window-rename, layout commands).
3. **Audit-log to complaint box BEFORE executing** — the complaint row carries `kind = 'p0'` and `incident_summary` literally containing the phrase `P0 send-keys bypass`. If medic crashed mid-bypass, the audit row survives.
4. **Never against `superdriver` pane** — that's the operator's territory. Medic does not write into it under any circumstances.
5. **Never `--no-verify` / `--no-gpg-sign` / hook-bypass** — global CLAUDE.md rule, no exceptions, even under P0.
6. **One-shot** — if the bypass doesn't unstick the target on the next pane state read (1 sweep later), escalate to the operator via `pending-decisions.md` + Discord ping. Do not retry; retrying compounds the misdiagnosis.

**Sequence**:

```text
# 1. Identify target window (capture state first)
TARGET_WIN="<team-cage-socket>:<member-window-name>"
tmux capture-pane -p -t "$TARGET_WIN" -S -30 | tail -20

# 2. Author the complaint row BEFORE acting (file-only at first; status='open')
atmux complaints file <team> --kind p0 \
    --summary "P0 send-keys bypass: <one-line>" \
    --root-cause "<one sentence>" \
    --ask "<preventive ask>"

# 3. Execute the bypass (via safeSendKeysWithVerify per ADR-138)
tmux send-keys -t "$TARGET_WIN" "<recovery keystroke>"
# (e.g. BTab to flip permission mode, or a one-line message)

# 4. Update the complaint row with outcome
atmux complaints resolve <id> --note "<observed result on next sweep>"
```

**Recovery patterns observed in the wild** (not exhaustive):

| Wedge | P0 keystroke | Notes |
|---|---|---|
| Member stuck on permission-prompt modal | `BTab` until status line shows `auto mode on` | Modes cycle: don't-ask → accept-edits → default → auto. Verify via capture-pane. |
| Member queued message but not submitted | `Enter` | Only if the queued text is the right text — otherwise risks sending the wrong message. |
| Lead pane on `Compacting conversation` | DO NOTHING. Compaction completes on its own. | False-positive wedge — bypass would corrupt the compaction. |
| Cage tmux server alive but no driver session | `tmux -S <socket> kill-server` then `atmux cockpit rebuild` | Not actually a send-keys path — cage cycle. P0 because the team is fully offline. |

**What this is NOT**: medic doesn't use `tmux send-keys` for routine messages. Routine = `atmux send <team>:<lead> "..."`. P0 send-keys is reserved for moments when the SQL inbox routing latency itself is the blocker.

## What it must NOT do

Inherited from CLAUDE.md global policies:

- **No force-push to `origin/main`** — universal.
- **No push to `origin/${product}-staging`** — operator-manual only (push policy, ADR-024).
- **No actions against any product's prod environment** — medic scope is the operator's dev box + cockpit + dev/staging only.
- **No skipping pre-commit hooks** — `--no-verify` and friends are off-limits, period. (Medic has no chat path to the operator for explicit one-off authorisation.)
- **No `atmux send` writes to driver/superdriver panes.** Operator-only territory.
- **No `git reset --hard`, `git push --force`, or kill -9 of any non-cage process.** Destructive ops require operator clearance via `pending-decisions.md` + Discord ask.

A misdiagnosis here lives in the complaint box as a self-filed complaint. Future-medic reads it on the next session and learns.

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
    --by medic

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

> The send-target sentinel `__superdoctor__` stays unchanged for the deprecation window per ADR-133 §Out of scope — schema-level rename happens via a follow-up migration. Operators who want to anticipate the eventual rename can grep `__superdoctor__` in their automation now; an alias `__medic__` may be added under TR2/TR3 backward-compat shim if scope expands.

The message lands in `inbox_messages` table with member `__superdoctor__`. Medic reads it on the next whip turn (worst case ~1h latency).

**P0 to the operator** — medic itself escalates by writing to `pending-decisions.md` (operator's authoritative ask channel) and Discord-pinging George (`[superdoctor]` prefix for now — Discord template rename ships under EPIC `t-d25ff629` TR5+ alongside skill source rename).

## Self-escalation when fixes keep failing

ADR-077 §F6 — without this, medic silently loops while the team stays broken (rotate-lead swallowed under auto-mode; kill+respawn welcome-screen-gates; all members idle 3h after rebuild). Medic logs every structural-fix attempt with its outcome; after **three failed attempts on the same complaint hash**, it pages George with a bounded ABC menu and stops trying that fix on that complaint until the operator picks an option.

**Attempt log** — `superdoctor_attempts` table in each team's `<team-root>/.atmux/state.db` (migration v3, name unchanged per ADR-133 §Out of scope):

| column         | meaning                                                       |
|----------------|---------------------------------------------------------------|
| `complaint_id` | FK-style reference to `complaints.id`                         |
| `attempt_n`    | 1-based attempt counter within the same `complaint_id`        |
| `outcome`      | `resolved` / `partial` / `failed` (CHECK-constrained)         |
| `attempted_at` | epoch seconds when the attempt completed                      |
| `action`       | what fix was tried — `rotate-lead`, `kill-respawn`, etc.      |
| `note`         | one-line observation (verify reason, pane state, SHA)         |

Read via `SuperdoctorAttemptsRepo` (`src/core/repositories/superdoctor-attempts-repo.ts` — class name unchanged for the deprecation window). The trigger query is `countByOutcomeFor(complaintId, 'failed') >= 3`.

**The page** — Discord template `[self-heal-failed]` (`renderSelfHealFailed`). Goal is 2-second triage on a phone:

```
🚨 [self-heal-failed] `<team>` · 14:22 MYT
🚨 self-heal failed: <symptom> — N=3 attempts
🙏 reply A/B/C — one letter pivots cheaply
🛠️ A) /team stop + start <team> — restarts N member(s) ~30s
🔁 B) swap account <from> → <to> — wk budget reset
⏳ C) park <team> for the night — re-engage at session start
⏰ default at 14:52 MYT: A — cheap to pivot if you redirect
📍 <complaintsOpen> open · <whipStrikes> strikes
```

**Dedup** — one ping per complaint hash within a 1h window. State lives in `state_kv` (feature `superdoctor-self-heal-escalation` — feature-key string unchanged per ADR-133 §Out of scope; key = `complaint_id`); subsequent failures inside the window record into `superdoctor_attempts` but skip the Discord emit.

**Action on reply** — operator replies a single letter to the Discord thread; the skill's reply handler resolves the complaint and triggers the named action (`/team stop` + `/team start`, account swap, park-for-night). Operator silence past the 30-min default deadline = `A`.

## Comparison with other roles

- **`atmux doctor` (verb)** — deterministic checks. Detection only, no diagnosis. Run on-demand or as `atmux start` preflight. Medic invokes `atmux doctor --json` as one input among many during its whip turn. (The verb-vs-process naming collision was the rationale for the `superdoctor → medic` rename per ADR-133 §Context: `doctor` the verb predates `superdoctor` the role; renaming the role to `medic` eliminates the collision.)
- **`atmux whip watchdog` (verb)** — per-team liveness one-shot. Pane-state classifier + cage health. Medic sweeps watchdog output across all teams.
- **per-team lead** — coordinator inside one team. Medic doesn't replace a lead; it watches across leads and addresses cross-team / structural issues that no single lead can see.
- **`/whip` skill** — the cycle engine that drives the whip loop. Medic uses it the same way a team-lead does, with a different role brief (the deferred medic skill — formerly the `superdoctor` skill, renamed alongside plugin source under EPIC `t-d25ff629` TR5).
- **martinet (cockpit W3, post-[ADR-132])** — sibling cockpit-level role. Cursor composer-2-fast at 270s; absorbs routine observation + nudging + rotation per [ADR-140] cheap-model-first principle. Medic and martinet split authority on rotation: martinet owns *routine* (uptime / refusal / dormancy threshold trips), medic retains *emergency* (broken claude proc requiring kill+respawn, code-fix scenarios).

## Status

ADR-077 §D1 + §D2 (cockpit topology + schema), §F1 (skill brief in `~/.claude/skills/superdoctor/`), §F2 (complaint box SQLite + `atmux complaints` verb), §F3 (`atmux send __superdoctor__` validator), §F4 (P0 send-keys runbook), §F5 (status verb medic surface), and §F6 (self-escalation primitives — `superdoctor_attempts` table + `renderSelfHealFailed` Discord template) all ship. Setting `medic.enabled: true` (or legacy `superdoctor.enabled: true` during deprecation window per ADR-133) in `~/.atmux/cockpit.json` and running `atmux cockpit rebuild` spawns window 2 with a Claude Opus session that — when invoked as `/loop /medic` (or legacy `/loop /superdoctor` until plugin source TR5 lands) — runs the hourly diagnosis loop end-to-end.

Post-[ADR-140] roadmap: the hourly scan loop converts to event-driven listening on `~/.atmux/state/medic-events.log`; routine rotation authority moves to martinet; medic's residual scope narrows to code-fix-class incidents. Sequenced via ADR-131 / ADR-132 / ADR-139 impl waves.

Open follow-ups (not blocking):

- `atmux complaints list --all-teams` — one query across every cockpit-roster team's state.db. Operator can iterate via shell until this lands.
- Storage-layer rename (`superdoctor_attempts` table, `SuperdoctorAttemptsRepo` class, `__superdoctor__` sentinel, `superdoctor-self-heal-escalation` dedup key, Discord prefix `[superdoctor]`, skill path `~/.claude/skills/superdoctor/`) — separate ADR per ADR-133 §Out of scope; not blocked on this rename.
- Cross-cockpit federation (Phase 6+) — multiple medic instances coordinating across geographic regions.
