# medic

> **2026-09-07 alignment — the medic is LIVE.** The role was reinstated as a
> cockpit member by operator decision (geoyws, 2026-09-07) per
> [ADR-291](./adr/291-medic-reinstated-as-cockpit-member.md), which supersedes
> [ADR-212](./adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md)
> §D1 (retire at cockpit W2), §D5 (retire last, behind the Honker/orchd
> substrate — deleted by [ADR-276](./adr/276-orchd-retirement-and-atmux-scope.md)
> on 2026-08-27) and §D6 (the `medic-config-residue` probe, never built).
> ADR-212 §D2–§D4 / §D7 stand as history. ADR-077's **probe substrate library**
> (`src/core/doctor-class.ts`, the doctor probe registry) was never in question
> and is unchanged. Read the whole page with the four corrections below.
>
> 1. **Window placement is not "window 2".** `_medic` sits immediately after
>    `_sd` and every `_sdN` superdriver lane — slot `anchor.index + 1 + laneCount`
>    per [ADR-290](./adr/290-superdriver-lane-shortform-and-multi-lane-cockpit.md)
>    §D5. On `@@mbp` the target order is `_sd, _sd2, _sd3, _medic, _misc, …`;
>    with no lanes declared it collapses to the original slot 2.
> 2. **The operating loop is a kb board, not an hourly tick.** The medic is a
>    cockpit lane in the ADR-290 §D2 shape: identity `ATMUX_MEMBER=medic`
>    (ADR-291 §D3), kb actor `claude@medic` on lane `medic`, working the `medic`
>    kb board on `@@hax` under an operator-armed standing goal
>    (`/standing-goal /kb-goal`). **kb rows are the only interaction surface**,
>    and `tmux send-keys` into any pane is BANNED (board rule `r-1376df29`);
>    panes are read-only for liveness checks. Mutating work is delegated to
>    isolated worktrees; the shared cwd is read-only. The brief is
>    [`templates/briefs/medic.md`](../templates/briefs/medic.md).
> 3. **`autoStart: false` is the recommended setting.** The auto-start path
>    (`autoStartSuperdoctorLoop`) send-keys `/loop /medic` into a freshly
>    created pane. That slash command no longer exists in the operator's plugin
>    tree (checked 2026-09-07), and injecting keystrokes conflicts with
>    `r-1376df29`. The field and helper still ship; leave `autoStart` false (or
>    omitted) and arm the standing goal by hand. ADR-291 §Out of scope carries
>    the follow-up.
> 4. **§"What it does each whip turn", §"P0 send-keys escalation runbook",
>    §"Reading the complaint box", §"Talking to it" and §"Self-escalation"
>    describe the ADR-077 substrate** — the hourly `/loop /whip` cadence,
>    `atmux send __superdoctor__`, the complaint box, the P0 bypass. That
>    machinery still ships and is still readable, but it is **historical
>    mechanics, not the operating loop**, and the P0 send-keys bypass in
>    particular is superseded by the send-keys ban. The §"What it must NOT do"
>    hard limits are unchanged and still binding.

> Operator reference for the cockpit-level self-healing role originally introduced as **`superdoctor`** in [ADR-077](./adr/077-superdoctor-cockpit-role.md) and renamed to **`medic`** on 2026-05-14 per [ADR-133](./adr/133-medic-rename.md). The role's design, authority surface, and complaint-box contract are canonical in ADR-077; only the role's *name* is superseded. **Storage-layer identifiers** (`superdoctor_attempts` table, `SuperdoctorAttemptsRepo`, member sentinel `__superdoctor__`, Discord dedup key `superdoctor-self-heal-escalation`) **remain unchanged** for the deprecation window per ADR-133 §Out of scope — table renames require a separate schema-migration ADR. The skill source (`~/.claude/skills/superdoctor/`) and Discord template prefix (`[superdoctor]`) rename land separately under EPIC `t-d25ff629` TR5 (plugin source) and follow-up work — until those ship, the operator-visible Discord prefix is `[superdoctor]` and the skill path stays put.

## What it is

A dedicated Claude (or Codex) session in the operator cockpit, in the `_medic` window — placed immediately after `_sd` and every `_sdN` superdriver lane, before `_superbot`, the other operator windows and the per-team viewers ([ADR-290](./adr/290-superdriver-lane-shortform-and-multi-lane-cockpit.md) §D5; [ADR-291](./adr/291-medic-reinstated-as-cockpit-member.md) §D1). It works the `medic` kb board on `@@hax` under an operator-armed standing goal and asks: *is anything abnormal in atmuxland or on its hosts, and if so, why, and how do I prevent it from happening again?*

| | `_sd` / `_sdN` superdriver lanes | `_medic` | per-team lead |
|---|---|---|---|
| **Lives at** | cockpit `atx:1` (`_sd`) + `atx:2..` (`_sdN`) | cockpit `_medic`, the window right after the last `_sdN` lane (`atx:4` on `@@mbp` with two lanes declared; `atx:2` when no lanes are declared) | each team's cage `:driver` window |
| **Identity** | `ATMUX_MEMBER=sd` / `sdN`, kb `claude@sdN` | `ATMUX_MEMBER=medic`, kb `claude@medic` on lane `medic` (ADR-291 §D3) | team member id |
| **Cadence** | operator-armed standing goal over the `superdriver` kb board | operator-armed standing goal over the `medic` kb board (`/standing-goal /kb-goal`) | per-team whip (270s default) |
| **Owns** | cross-team dispatch, ad-hoc decisions | fleet + host health: doctor/status sweeps, host-pressure playbook ([ADR-198](./adr/198-medic-host-pressure-playbook.md)), branch fixes, cage cycles | one team's coordination |
| **Talks to operator via** | kb rows (`sr` / `att`) | kb rows on the `medic` board — `kb att raise` for anything needing the operator | driver-inbox + Discord |

(Per [ADR-264](./adr/264-cockpit-session-atx-rename.md) the cockpit session is `atx`; pre-ADR-264 deployments still see `atmux_cockpit` or, pre-ADR-135, `atmux_teams`.)

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

The canonical form is a `type: "medic"` entry in the cockpit roster's `sessions[]` array ([ADR-279](./adr/279-declarative-operator-cockpit-windows.md)). This is the exact live `@@mbp` entry from `~/.atmux/cockpit.macos.json` on 2026-09-07:

```jsonc
{
  "type": "medic",
  "name": "medic",
  "enabled": true,
  "autoStart": false,
  "claudeAccount": {
    "configDir": "/Users/geoyws/.claude-gmail",
    "label": "gmail"
  },
  "tuiOverrides": {
    "effortLevel": "xhigh",
    "permissionMode": "auto",
    "pluginDir": "/Users/geoyws/work/journals/.sb/claude-skills"
  }
}
```

`autoStart: false` is the recommended setting — see correction 3 in the banner at the top of this page. The legacy top-level `medic` block in `~/.atmux/cockpit.json` is still read and still works; the legacy `superdoctor` key is not (that shim expired per [ADR-266](./adr/266-shim-sunset-policy-and-first-sweep.md) §D2 — a config still carrying it fails with an actionable error).

Then:

```bash
atmux cockpit reconcile
```

(`reconcile` is the verb; `atmux cockpit rebuild` is gone.) The reconcile creates `_medic` in the slot right after `_sd` and the declared `_sdN` lanes and reorders any misaligned windows by moves only — no pane is killed, no `--yes` needed (ADR-290 §D5). Then arm the lane by hand in that pane: `/standing-goal /kb-goal` against the `medic` board.

To disable: set `enabled: false` (or remove the entry) and re-run `atmux cockpit reconcile`. The window is killed; no other cockpit shape changes.

## Per-team `cageMode` flag (t-72a6b7d7 / c-a99bf461)

Each team entry in `~/.atmux/cockpit.json` accepts an optional `cageMode` field that declares operator intent for the team's cage tmux socket. Medic's sweep cross-references the declared mode against live socket-presence to colour each row — eliminating the pre-flag failure mode where "cage intentionally torn down" looked identical to "cage anomalously absent".

| `cageMode` value | sessionAlive=true | sessionAlive=false |
|---|---|---|
| `"autonomous"` (default — legacy configs without the field) | 🟢 cage healthy | 🔴 cage missing — autonomous team expected a live socket |
| `"direct"` (operator-driven, no cage by design) | 🟡 unexpected live cage — confirm intent | 🟢 direct-driver mode (no cage by design) |
| `"paused"` (intentionally down today) | 🟡 paused team has a live cage — clear pause or tear down | 🟡 paused — restart on next `atmux cockpit reconcile` |

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

## What it does each whip turn (ADR-077 substrate — HISTORICAL mechanics)

> **Not the operating loop.** This is the [ADR-077](./adr/077-superdoctor-cockpit-role.md) hourly-tick design as filed on 2026-05-08. The live loop is the `medic` kb board under an operator-armed standing goal (banner correction 2). The probes and verbs named below are exactly the ones a medic still runs — the *cadence* and the `__superdoctor__` inbox hop are what changed.

Hourly `/loop /whip` cycle, in order:

1. **Read its own inbox** (`inbox_messages` table, member `__superdoctor__` — sentinel name unchanged for the deprecation window per ADR-133 §Out of scope) — heads-up nudges from team leads or members.
2. **Sweep each enabled team** — `atmux doctor --json` + `atmux status --json` per team. Detection layer (ADR-019). Doctor JSON includes the [ADR-162](./adr/162-atmux-owns-tmux-infrastructure.md) warn-class probes `tmux-version-mismatch` and `cockpit-on-default-socket` — see [`docs/RUNBOOK-cockpit.md` §4 — Doctor probes](./RUNBOOK-cockpit.md#§4--doctor-probes) for the payload shapes + self-clearing behaviour.
3. **Triage** — silent if all green. If yellow/red anywhere, route into investigation.
4. **Investigate** — trace the anomaly to its root cause. Read git log, recent commits, lead-queue entries, driver-inbox archive. Forks an Agent (Sonnet for read-only research) when the search is wide.
5. **Decide authority level**:
   - File-only (default): write a complaint to the affected team's complaint box; ping its lead via `atmux send <team>:<lead>`.
   - Action: rotate a wedged lead, clear a confused member, cycle a stuck cage, push a fix to atmux's own source on a branch.
   - P0 send-keys bypass (rare): direct `tmux send-keys` to a member or lead pane when the SQL inbox routing is too slow (e.g. demo in 20min, member wedged on a recoverable error).
6. **Author preventive ask** — every complaint includes a `preventive_ask` field. The point isn't fixing this incident; it's ensuring the next one doesn't happen.
7. **Log everything** — every action medic takes is logged to its own complaint box first. Audit trail survives a misdiagnosis.

> **Cheap-model-first interaction (per [ADR-140](./adr/140-cheap-model-first.md))**: post-ADR-140, the hourly *scan loop* described above is intended to move to an **event-driven** model — medic wakes on events written to `~/.atmux/state/medic-events.log` by future Honker event consumers (orchd Phase 3-5, sibling EPIC e-a946af69 — those consumers will NOT ship: orchd was retired per [ADR-276](./adr/276-orchd-retirement-and-atmux-scope.md)). Medic stays on the hourly sweep described in this page; the legacy sentinel/martinet observer role that originally fed events to medic was decommissioned per EPIC e-be01fc89. ADR-143's cron-rotate covers routine lead-rotation. Transition is sequenced via ADR-131 / ADR-139 / EPIC e-a946af69.

## What its actions look like

These are illustrative (the actual action set is decided by the model at runtime per the auto-mode brief, not hard-coded):

| Anomaly | Likely action | Preventive ask |
|---|---|---|
| atmux team's cage died because tests ran inside it | Cycle the cage; restart the team; ping lead | "lead must dispatch e2e tasks with `--cage isolated` flag" |
| Member wedged on a permission prompt for 30+ min | `tmux send-keys` BTab cycle to flip into auto mode | "spawn pattern in CLAUDE.md should always set `--permission-mode auto`" |
| Discord ping silent for 4h on a team that should be active | `atmux doctor --fix`; verify webhook URL | "add webhook reachability to `atmux start` preflight" |
| Recurring lead rotation timing out | Rotate lead via `/team rotate-lead`; capture context | "60min auto-rotate threshold is too short for this team's task complexity" |
| Two teams competing for the same staging URL | File complaint with both team leads; pause the offending push | "branch-staging URL collision detector at deploy time" |

## P0 send-keys escalation runbook (ADR-077 substrate — SUPERSEDED, do not use)

> **The send-keys bypass below is BANNED as of 2026-09-02.** Board rule `r-1376df29` (basis verified against the live Anthropic Consumer Terms) forbids injecting keystrokes into another session's interactive TUI, and [ADR-291](./adr/291-medic-reinstated-as-cockpit-member.md) §D2 makes kb rows the medic's only interaction surface. A P0 today is a `kb att raise` row plus, where the operator has pre-cleared it, a non-send-keys recovery (cage cycle, `atmux cockpit rotate`). This section is retained as the ADR-077 record of what the role once did and to explain the `kind = 'p0'` complaint rows already in the state DBs.

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
| Cage tmux server alive but no driver session | `tmux -S <socket> kill-server` then `atmux cockpit reconcile` | Not actually a send-keys path — cage cycle. P0 because the team is fully offline. |

**What this is NOT**: medic doesn't use `tmux send-keys` for routine messages. Routine = `atmux send <team>:<lead> "..."`. P0 send-keys is reserved for moments when the SQL inbox routing latency itself is the blocker.

## What it must NOT do

Inherited from CLAUDE.md global policies:

- **No force-push to `origin/main`** — universal.
- **No push to `origin/${product}-staging`** — operator-manual only. The binding rule is the global CLAUDE.md push policy: agents push feature / testing / staging / UAT branches, and `master` / `main` / production refs (`prod`, `production`, `*-prod`, `*-production`) need geoyws' approval.
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

## Talking to it (ADR-077 substrate — the live channel is the kb board)

> **How you actually reach the medic in 2026-09:** file a row on the `medic` kb board on `@@hax` (`kb task add …` for work, `kb att raise …` for something that needs it now). The `atmux send __superdoctor__` inbox hop below still ships and still delivers, but the medic no longer runs an hourly turn that drains it, so a row is the reliable channel and a send is not.

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
- **orchd event consumers (sibling EPIC e-a946af69 / Honker Phase 3-5)** — RETIRED before shipping (orchd removed per [ADR-276](./adr/276-orchd-retirement-and-atmux-scope.md)); the plan had been to absorb routine observation + nudging + rotation per [ADR-140] cheap-model-first principle, leaving medic's residual scope at emergency / code-fix-class incidents. The legacy cockpit-W3 sentinel/martinet observer that previously held this scope was decommissioned per EPIC e-be01fc89.

## Status

**Live as of 2026-09-07** per [ADR-291](./adr/291-medic-reinstated-as-cockpit-member.md). ADR-077 §D1 + §D2 (cockpit topology + schema), §F2 (complaint box SQLite + `atmux complaints` verb), §F3 (`atmux send __superdoctor__` validator), §F4 (the P0 send-keys runbook — shipped, now superseded by the send-keys ban), §F5 (status verb medic surface) and §F6 (self-escalation primitives) all ship. §F1's skill brief at `~/.claude/skills/superdoctor/` does **not** exist in the operator's plugin tree any more (checked 2026-09-07); the in-repo brief is [`templates/briefs/medic.md`](../templates/briefs/medic.md).

Declaring a `type: "medic"` entry with `enabled: true` (or the legacy top-level `medic` block) and running `atmux cockpit reconcile` creates the `_medic` window right after `_sd` and the `_sdN` lanes, with a command that starts `export ATMUX_MEMBER=medic &&` (ADR-291 §D3). The operator then arms the lane by hand — `/standing-goal /kb-goal` against the `medic` kb board on `@@hax`. There is no `/loop /medic` slash command any more, and `autoStart` should stay `false`.

On 2026-09-07 the live `@@hax` cockpit (`atmux_cockpit`) runs `_medic` in window 2 with Codex in it; the `@@mbp` cockpit (`atx`) declares the medic but has no `_medic` window yet. Two `atmux cockpit reconcile --no-launch` runs on 2026-09-03 exited 65 per `~/.atmux/logs/2026/09/events.jsonl`; the refusal source was not captured and does not reproduce (exit 65 is `EX_DATAERR`, the `schema` tag only, and on 2026-09-07 the branch code parsed the cockpit config plus all 42 enabled `team.json` files cleanly). Separately and definitely: under pre-ADR-290 code the medic slot was `anchor.index + 1` — the index `_sd2`'s live REPL occupies — and the fresh-add path would have silently moved-with-killed that pane with no gate at all. ADR-290 §D5 closed that, so the next reconcile on `@@mbp` creates `_medic` without killing a pane.

Historical roadmap note: ADR-140's plan to convert the hourly scan loop to event-driven listening on `~/.atmux/state/medic-events.log` is dead — those orchd consumers never shipped (orchd retired per ADR-276). The kb board replaced that plan entirely.

Open follow-ups (not blocking):

- `atmux complaints list --all-teams` — one query across every cockpit-roster team's state.db. Operator can iterate via shell until this lands.
- Storage-layer rename (`superdoctor_attempts` table, `SuperdoctorAttemptsRepo` class, `__superdoctor__` sentinel, `superdoctor-self-heal-escalation` dedup key, Discord prefix `[superdoctor]`, skill path `~/.claude/skills/superdoctor/`) — separate ADR per ADR-133 §Out of scope; not blocked on this rename.
- Cross-cockpit federation (Phase 6+) — multiple medic instances coordinating across geographic regions.
