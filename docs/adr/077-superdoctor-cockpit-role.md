# ADR-077: superdoctor — self-healing cockpit role

**Status**: accepted
**Date**: 2026-05-08
**Date-accepted**: 2026-05-13 — shipped via 0.6.0 release commit `1ade34c` (D1 cockpit topology + D4 inbox/messaging). D5 (complaint box) + D6 (skill + bootstrap brief) remain deferred as marked in their section headers; tracked under epic t-274ec70c.
**Driver-ref**: 2026-05-08 hax session — operator asked "can the whip ask a superdoctor (sitting beside the superdriver) whether everything seems normal in atmuxland, and if not fix it, find out why, and make sure it doesn't happen again?" Existing surface (ADR-019 `atmux doctor` verb, ADR-040 whip watchdog) handles **detection**; nothing today owns the **diagnosis → systemic-fix** loop. atmux teams have died from causes that recur (e.g. a member running e2e tests inside the team's own tmux cage instead of an isolated cage and trampling the live stack) and the recurrence is the bug, not the death.

> ⚠️ **RENAMED 2026-05-14**: this role is now called **medic** per [ADR-133](133-medic-rename.md).
> Supersedes naming only — design decisions in this ADR remain canonical for the role.
> Original term "superdoctor" retained in this file for historical accuracy.
>
> **2026-05-14 sibling**: ADR-132 §D2 adds a `martinet` cockpit-tier
> sibling at window 3 (pluggable per-team whip-manager, fleet-wide
> iterator). The medic role at window 2 (formerly named here) remains
> the fleet self-healing / diagnosis-and-prevention loop per §D1
> below; martinet handles per-team observation + nudge work that
> doesn't require Opus judgment. Verb impl: T8 of ADR-132 (commit
> t-fb5e4c1f).
>
> **2026-05-15 §E hook — starving-bootstrap recovery moved here**
> ([ADR-081 §E](081-bootstrap-brief-paste-bug.md)): the lead's whip
> §4a `auto-bootstrap-starving-members` step is removed in favour
> of supervisor-side recovery on this role. The chicken-and-egg
> failure mode (stuck/confused lead cannot fire whip; 2026-05-12
> 20h+ dormancy incident) is broken by relocating the rule to
> medic's hourly cron tick. The recovery primitive is the existing
> `atmux doctor --fix` (ADR-081 §D + commit `8248778`,
> `fixStarvingMembers` at `src/verbs/doctor.ts:2329`) — medic
> invokes it per enabled team in `~/.atmux/cockpit.json` when a
> team has ≥1 starving member AND lead has been idle ≥5 min.
> Closes medic complaints `c-7193c689` (starving-bootstrap) and
> `c-8ecd3a61` (doctor blind spot — addressed by §D + this hook).
> Per ADR-081 §E §"Reversibility": (E) is one-line revert
> (re-add the whip §4a step). Per ADR-140 cheap-model-first, the
> hourly-cron cadence becomes event-driven via martinet once
> ADR-140 lands. Skill-side wiring (operator dotfiles —
> `~/.claude/skills/whip/whip-prompt.md` §4a removal +
> `~/.claude/skills/medic/medic-prompt.md` starvation-detection
> rule) is driver-scope per CLAUDE.md "Driver MAY: edit global
> skills"; tracked separately from the in-repo annotation here
> (t-9f235ad5 atmux-repo work; dotfiles work routes via driver).
>
> **2026-05-14 cadence + authority narrowing** per [ADR-140](140-cheap-model-first.md)
> (cheap-model-first principle, accepted 2026-05-15): §D3's "hourly cadence" is
> **deprecated**; medic moves to **event-driven** (no idle hourly tick), listening
> on `~/.atmux/state/medic-events.log` written by martinet. The scan-loop primitives
> in §D2 (`atmux doctor --json` per team, complaint filing) are preserved but fire
> only on event-arrival, not on a timer. §D3's "full action authority" is preserved
> for **code-fix-to-atmux** + cage-cycle authority; **routine** rotation authority
> (context-token >400k, refusal-pattern, dormancy-window per [[feedback_rotation_threshold_400k]])
> moves to martinet (Cursor composer-2-fast) per ADR-140 §Decision. Medic retains
> **emergency** rotation authority for code-fix scenarios where a member's claude
> proc is genuinely broken and needs kill+respawn. Source: ADR-140 §"What MOVES /
> What STAYS" + roles+responsibilities matrix.

## Context

Three pieces of the self-healing puzzle already exist:

- **`atmux doctor`** (ADR-019, `src/verbs/doctor.ts`, 1063 LOC) — runs deterministic green/yellow/red checks (deps, team.json, TUI binaries, .atmux writability, Discord webhook reachability, phantom inboxes, orphan sessions). It tells you *what* is wrong.
- **`atmux whip` + watchdog** (ADR-022 / ADR-040 / ADR-043) — periodic per-team liveness sweep. Knows whether a member is responsive and whether dispatch is making progress. Tells you *that* something has stalled.
- **Operator superdriver** (ADR-025 / ADR-029 / ADR-034 / ADR-042 / ADR-063 cockpit) — the cross-team supervisor that owns the cockpit tmux session. Reads driver-inbox, dispatches across teams, escalates to the operator (George). Acts on individual incidents but doesn't loop on prevention.

What's missing is the **structural-fix loop**: when an anomaly fires, *why* did it fire, and what change to atmux itself (or to the affected team's playbook / lead-queue / kanban) would prevent the next one? Today that loop is George's, run interactively in the superdriver pane. It doesn't run when George is asleep, and the lessons don't compound — each recurrence is re-diagnosed from scratch.

The **complaint box** is the artifact this loop produces: a per-team SQLite-backed log of *root causes + preventive asks*, distinct from driver-inbox (per-team asks at the lead) and pending-decisions.md (asks at the operator). Complaint box is "this team had an incident; here's why; here's the structural fix." It already lives in the kanban as a not-yet-built idea — gets formalised here as deferred follow-up under epic `t-274ec70c` (Super-\* hierarchy port).

## Decision

Introduce **superdoctor** as a permanent cockpit role at window 2, between superdriver (window 1) and the per-team viewers (windows 3..N). It is a Claude Opus 4.7 + xhigh + auto-mode session, structurally identical to superdriver but owning the diagnosis-and-prevention loop instead of cross-team dispatch.

### D1 — Cockpit topology

Cockpit window order under ADR-077 (operator cockpit session, default `atmux_teams`):

| # | Window | Role |
|---|--------|------|
| 1 | `superdriver` | Operator's cross-team REPL (unchanged, ADR-063). |
| 2 | `superdoctor` | **New.** Self-healing diagnosis + complaint authoring. |
| 3..N | per-team viewers | Each nest-attaches to its team's cage `:driver` window (unchanged, ADR-063). Indices shift down by 1. |

`reconcileCockpitSession` (`src/verbs/cockpit.ts:526`) is the single point of mutation:

- When `cockpit.superdoctor.enabled === true`: ensure window 2 exists with name `superdoctor`; spawn the configured TUI command (default the same env-prefixed `claude` invocation as superdriver but with the `superdoctor` skill bootstrap).
- When unset / `enabled: false`: cockpit shape is unchanged from ADR-063 (no window 2 superdoctor; team viewers stay at 2..N).
- The `wanted` set at line 544 grows to `["superdriver", "superdoctor", ...teams.map(t => t.name)]` so the orphan-prune loop never kills it.
- Idempotent: existing `superdoctor` window is preserved as-is (matching the per-team viewer pattern at line 549).

Operator opt-in is explicit: superdoctor is OFF by default. Single-team and Solo-Mode operators don't need it; the value comes from running ≥2 teams concurrently. Activation = add `"superdoctor": { "enabled": true, ... }` block to `~/.atmux/cockpit.json` and re-run `atmux cockpit rebuild`.

### D2 — Config schema

`~/.atmux/cockpit.json` gets one optional top-level block (passthrough at the root preserves backward-compat for existing rosters per ADR-063 §D2):

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

Schema reuses `CockpitClaudeAccount` and `CockpitTuiOverrides` verbatim — superdoctor's spawn shape is structurally identical to a team window's TUI shape, so reusing the leaf objects keeps drift detection (historical decision number 054 (no surviving ADR file) §D3 .strict() pattern) consistent.

### D3 — Cadence + authority

Two operator-set knobs answered in the 2026-05-08 design conversation:

1. **Cadence**: superdoctor runs its own `/loop /whip` (per /loop skill) at **hourly cadence** (`/loop 1h /whip` or equivalent). Reason: anomalies that warrant superdoctor attention are rare in practice; a tighter loop burns Opus tokens on idle sweeps. The hourly cadence is configurable per-operator (`tuiOverrides.whipIntervalMin` deferred — superdoctor reads its own bootstrap brief for the cadence today).
2. **Authority**: **full action authority**. Superdoctor may (a) `/team rotate-lead`, (b) `/team clear <member>`, (c) cycle a wedged cage, (d) push fixes to atmux source on its own branch + open PR, (e) modify `~/.atmux/cockpit.json` (e.g. flip a team's `enabled: false` if it's hard-stuck and dragging the cockpit). It MUST NOT (per global "Executing actions with care" + George policy): force-push to main, push to `origin/${product}-staging` (ADR-024 / push-policy: George-manual only), or take any action against IFCA prod.

Trade-off: full authority means a misdiagnosis can compound (e.g. wrong-team `/team clear` loses an in-flight teammate's context). Mitigation lives in protocol, not code — superdoctor logs every action to its complaint box BEFORE executing, so the audit trail survives even if the action is wrong.

### D4 — Inbox + messaging

Per the 2026-05-08 directive: "the inbox must live in sqlite for data safety purposes and type safety."

Superdoctor's inbox is the existing `inbox_messages` SQLite table (already schema'd at `src/abstractions/sqlite-migrations.ts:89`, currently unused after historical decision number 076 (no surviving ADR file) collapsed per-member inbox semantics into the `tasks` table). Member key is the literal string `__superdoctor__`. Sender semantics:

- **Members → superdoctor** (e.g. lead surfacing "I think this is a recurrent symptom"): `atmux send __superdoctor__ "<msg>"` writes a row to `inbox_messages` with `member='__superdoctor__'`, `sender='<team>:<member>'`, `kind='heads-up'`. Superdoctor reads on each whip turn.
- **Superdoctor → members** (urgent only, e.g. "stop running e2e in your own cage"): `atmux send <team>:<member> "<msg>"` — this routes through the same `tasks` table writer the rest of the cluster uses (historical decision number 076 (no surviving ADR file) SQL-canonical inbox).
- **Superdoctor → lead** (routine asks): same as above, target `<team>:<lead>`.
- **P0 escalation** (the system is on fire): bypass routing. Capture the target pane (per global "always read pane state BEFORE tmux send-keys"), then `tmux send-keys -t <window>` directly. Reserved for "demo in <30min and member is wedged" — every send-keys bypass is audit-logged in superdoctor's complaint box.

The cockpit-level superdoctor is NOT a member of any team's `team.json`. It's at the cockpit tier (alongside superdriver), so its inbox key (`__superdoctor__`) is reserved and won't collide with team members.

### D5 — The complaint box (deferred)

Out of scope for this ADR's implementation; kanban-tracked under epic `t-274ec70c`. Specified here so superdoctor's bootstrap brief has a target shape:

- **Storage**: per-team SQLite at `<team-root>/.atmux/state.db`, new `complaints` table (NOT a JSON file — historical decision number 076 (no surviving ADR file) cutover stays).
- **Schema** (proposed, draft only): `id TEXT PRIMARY KEY, opened_at INTEGER, opened_by TEXT, incident_summary TEXT, root_cause TEXT, preventive_ask TEXT, status TEXT (open/resolved/wontfix), resolved_at INTEGER, resolved_by TEXT, related_task_id TEXT, extra TEXT`.
- **Verb surface** (proposed): `atmux complaints list [<team>]`, `atmux complaints file <team> --summary ... --root-cause ... --ask ...`, `atmux complaints resolve <id>`. Deferred to a follow-up ADR when the volume justifies a verb (until then superdoctor uses raw SQL via `bun:sqlite`).
- **Cross-team complaint**: when superdoctor identifies a bug that belongs to atmux itself (vs the affected team), it files in atmux's complaint box. Operator pulls atmux complaints into atmux's own kanban as actionable tasks.

### D6 — Skill + bootstrap brief (deferred)

The actual `superdoctor` skill (analogous to `~/.claude/skills/whip/whip-prompt.md`) is deferred follow-up. Skeleton sketched in §Implementation Plan. This ADR commits the cockpit topology change + schema; the skill brief lands in the follow-up task.

## Consequences

**Positive**:

- Self-healing loop runs without operator intervention; the third hand on the wheel during long autonomous sessions.
- Recurrence prevention compounds — every complaint is a structural fix proposal, audit-logged across cockpit lifetimes.
- Existing infrastructure reused: cockpit reconcile, historical decision number 076 (no surviving ADR file) SQL inbox, `/loop /whip`, `/team` skill family.

**Negative**:

- Adds one Claude Opus + xhigh session to the operator's cockpit. Cost: roughly one whip cycle/hour of Opus + xhigh idle (worst case ~$X/day; precise number depends on cluster size and anomaly rate). Mitigation: hourly cadence (not 5-15min), opt-in default off.
- Full action authority widens the blast radius of a single misdiagnosis. Mitigation: action-before-log audit trail, push-policy + prod policies still bind.
- Superdoctor adds a third Opus voice to the cockpit (driver, lead-rotation, superdoctor) — operators need clear naming discipline so a Discord ping or a lead-queue entry from superdoctor is recognisable as such (`📋 [superdoctor]` prefix in Discord templates per global format rules; reuses the unprefixed-`[whip]` ban from CLAUDE.md).

**Open** (rolled into deferred follow-ups):

- Whether superdoctor's kanban-modify authority extends to *creating* tasks in another team's kanban or only filing complaints. Current bias: file-only; let the team's lead decide whether to convert.
- Whether the complaint box should be cockpit-wide (one `~/.atmux/complaints.db`) or per-team. Current bias: per-team — owners read their own complaints; cockpit-wide audit composable via `UNION ALL` query when needed.

## Implementation plan

This ADR's commit lands D1 + D2 only. Everything else is follow-up.

1. **Schema** (`src/schema/cockpit.ts`): add `CockpitSuperdoctor` (singleton; `enabled` + reused `CockpitClaudeAccount` + `CockpitTuiOverrides`), wire into `Cockpit` top-level as `.optional()`.
2. **Reconcile** (`src/verbs/cockpit.ts:526`): when `cockpit.superdoctor?.enabled` is true, ensure window 2 exists with name `superdoctor`. Spawn command resolved via the same `tuiOverrides → claude` builder used for team windows (extracted to a small helper if not already shared). `wanted` set grows to include it; orphan-prune loop already skips known names.
3. **Tests** (`tests/unit/verbs/cockpit.test.ts`): assert window-2 placement, idempotent re-run, orphan-prune respect, team-viewer shift, disabled-cockpit pass-through.
4. **Operator docs** (`docs/superdoctor.md`): user-facing reference — what it does, how to enable it, escalation rules, how to read the complaint box (when built).

Deferred follow-up tasks (filed in atmux kanban under epic `t-274ec70c`):

- F1: superdoctor skill + `/whip` bootstrap brief (`~/.claude/skills/superdoctor/superdoctor-prompt.md` analogous to whip-prompt).
- F2: per-team complaint box SQLite schema + verb family (`atmux complaints …`).
- F3: `atmux send` / `atmux receive` recognise `__superdoctor__` as a valid inbox member at the cockpit tier.
- F4: P0 send-keys escalation runbook (when superdoctor is allowed to bypass the SQL inbox and write directly to a teammate's pane).
- **F6**: superdoctor self-escalation when its own structural fixes fail. Without this, superdoctor silently loops while the team stays broken (rotate-lead swallowed under auto-mode, kill+respawn welcome-screen-gates, all members idle 3h after rebuild). Primitives shipped in atmux:
  - Migration v2→v3 (`src/abstractions/sqlite-migrations.ts`) materialises `superdoctor_attempts(id, complaint_id, attempt_n, outcome ∈ {resolved, partial, failed}, attempted_at, action, note, extra)` per-team. One row per structural-fix attempt the skill takes; CHECK constraint on `outcome`.
  - Typed CRUD via `SuperdoctorAttemptsRepo` (`src/core/repositories/superdoctor-attempts-repo.ts`) — `insert` / `listForComplaint` / `countByOutcomeFor` / `latestFor`. The load-bearing query is `countByOutcomeFor(complaintId, 'failed')`; reaching 3 triggers the escalation.
  - Discord template `self-heal-failed` + renderer `renderSelfHealFailed` (`src/abstractions/discord.ts`) — verdict-first ABC menu (`A` /team stop+start, `B` swap account, `C` park for the night) with a 30min-default deadline keyed off `whenMs`. Operator replies one letter from a phone.
  - Dedup state lives in `state_kv` (feature `superdoctor-self-heal-escalation`, key per `complaint_id`) with a 1h re-fire window — the table is the durable attempt log, not the dedup ledger.

  The hourly self-heal logic itself (record-attempt-with-outcome, check threshold, render-and-emit, action handler for the operator's letter reply) lives in `~/.claude/skills/superdoctor/superdoctor-prompt.md` (F1) and `~/.claude/skills/superdoctor/scripts/*` — the skill operates against the typed primitives this ADR ships in atmux.

## §F7 — refusal-pattern scan + record (ADR-139 T3 hook)

**Annotation 2026-05-16** (t-841049e4, ADR-139 §D2 medic integration).

Medic gains an hourly **refusal-pattern scan** pass over each enabled team's members. The scan invokes the existing classifier from ADR-139 T2 (`src/core/refusal-classifier.ts`) on every member-pane capture and records positive results to the per-team `refusal_events` SQLite table (migration v6→v7 in `src/abstractions/sqlite-migrations.ts`).

**Primitive surface (this commit ships)**:

- `atmux refusal-scan [--team-dir <path>] [--json]` — verb at `src/verbs/refusal-scan.ts`. For each member: capture pane via tmux, classify via `classifyRefusal`, write positive results to `refusal_events` with idempotent `INSERT OR IGNORE` keyed on `(member, minute_bucket, severity)`. Emits a JSON summary to stdout; one log line per outcome to stderr.
- `scanTeamForRefusals(team, atmuxDir, deps)` — pure-of-direct-IO core at `src/core/refusal-scan.ts`. Every external collaborator (pane capture, classifier, DB factory, clock) is dep-injectable so the medic prompt can wire its own pane-capture if it pre-captures for other diagnostic passes.
- `refusal_events` schema: `(id TEXT PK, member TEXT, team TEXT, phrases TEXT JSON, severity TEXT, confidence REAL, detected_at INTEGER, minute_bucket INTEGER)` + `UNIQUE(member, minute_bucket, severity)`. Idempotency contract per ADR-139 §D2.

**Medic invocation contract** (skill side, in `~/.claude/skills/superdoctor/superdoctor-prompt.md` aka medic per ADR-133): after the existing per-team complaints sweep, fire `atmux refusal-scan --team-dir <path>` once per enabled team. The verb is a record-only no-op when no detections land — safe to run every tick.

**T3 is SCAN + RECORD only**. Threshold-trigger logic (read accumulated `refusal_events` rows + decide rotation) ships in ADR-139 T4 via `refusal-threshold.ts::shouldRotate` against the same table. Until T4 lands, the rows sit as durable observability — operators can inspect them via direct SQL (`SELECT * FROM refusal_events WHERE detected_at > ? ORDER BY detected_at DESC`).

**Martinet sibling** — same verb, faster cadence (270s per tick vs medic's hourly). Wired forward-compat per ADR-132 §D1 cross-ref + `templates/briefs/martinet.md` scaffold. Once martinet's skill prompt lands (post-ADR-133 T8), it invokes the same `atmux refusal-scan` verb per-tick; medic stays as the hourly backstop.

## §lead-uptime-measurement — rotation gate reads session-start.txt, NOT process etime

**Annotation 2026-05-15** (t-6d950ffd, preventive for superdoctor complaint c-06dabd47).

ADR-009 rotation gate ("rotate the lead at ≥60min uptime") MUST read `~/.claude/teams/<team>/lead-session-start.txt` — refreshed by **`/clear`** AND **`atmux rotate-lead`**. This is the canonical "how long since the lead's CURRENT context window started?" signal.

It is NOT `ps -o etime` against the lead pane's shell PID. The shell process typically long-outlives any one Claude session — `/clear` resets the session-start marker without exiting the parent shell, and `atmux rotate-lead` reuses the same pane (and thus the same shell PID) per ADR-082. A pane whose shell has been running for 6 hours can have a freshly-`/clear`'d Claude session that's only 90 seconds old.

Observers (medic / martinet / superdriver) conflating the two signals have rotated leads prematurely (incident c-06dabd47, 2026-05-15). The rotation gate MUST read `lead_session_uptime_s` (the marker-derived value); `shell_pid_etime_s` is exposed for diagnostic transparency ONLY.

Surfaces:

- `atmux status --json` `lead` block (t-6d950ffd) — two explicitly-named fields:
  - `lead_session_uptime_s` — **rotation-gate source**. Derived from `lead-session-start.txt`.
  - `shell_pid_etime_s` — diagnostic-only. Derived from `ps -o etime= -p <leadPanePid>`.
- Whip per-tick `--lead-uptime-only` probe (per whip-prompt.md §1a) — same source: reads `lead-session-start.txt`, never `ps`.
- Global CLAUDE.md whip-policy carries the same one-sentence clarification ("rotation gate reads session-start.txt, NOT process etime").

Cross-refs: ADR-009 (rotation gate), ADR-077 (this ADR / medic role), c-06dabd47 (superdoctor complaint), [[feedback_rotation_threshold_400k]] memory (400k-ctx rotation policy that triggered the prior incident review).

## Out of scope

- Multi-superdoctor (one per region, federation across cockpits) — Phase 6+.
- Automated rollback of superdoctor-authored fixes that fail CI — Phase 6+.
- LLM-judge cross-check on superdoctor's preventive asks (ADR-023 cascade) — Phase 6+.
- Replacing the superdriver with superdoctor-driven autonomous operation — explicitly NOT a goal; superdriver remains the operator's interactive REPL, superdoctor remains a bg watcher.

## Amendments

### 2026-05-19 — Scope tightened to repository health; pane-liveness moved to Sentinel

**Driver finding 2026-05-19 06:00 MYT** (mechanism audit finding #2 against EPIC e-35dd6274). Today's silent gitter/committer death exposed a coverage gap: medic owned "health probes" but **pane-death detection / claude TUI wedge** sat in the seam between this role and the sentinel role at W3 ([ADR-132](./132-pluggable-martinet.SUPERSEDED.md) / [ADR-158](./158-martinet-to-sentinel-rename.SUPERSEDED.md)). Reviewer + driver triage couldn't point to which mechanism owned it. Without explicit boundary text, future agents would keep falling into "medic should have caught that" / "I thought sentinel did that" arguments.

**Medic scope (this ADR — narrowed):**

- Repository health: test failures, lint errors, broken builds, schema drift.
- Code-fix path: drives same-commit fixes when probes flag regressions (preserves §D3 code-fix-to-atmux authority).
- Probe runner for `atmux doctor` (code/test/lint classes) — invoked event-driven per the 2026-05-14 cadence narrowing.
- **Not scoped to**: pane liveness, claude TUI wedges, queued compose-boxes, refusal patterns. Those are sentinel scope per [[ADR-132 §Amendment 2026-05-19]].

**Sentinel sibling (boundary):** pane-liveness, mechanical nudges, member-state observation, routine + emergency rotation per [ADR-132](./132-pluggable-martinet.SUPERSEDED.md) §Amendment 2026-05-19. Sentinel observe-pass invokes doctor probes for code-class findings (read-only) and escalates code-fix work back to medic via the escalate-to-claude-lead path; medic invokes doctor for liveness-class findings via the shared probe library.

**Doctor stays shared infra** per the doctor self-diagnostics history (no surviving local ADR file) — owns no loop of its own; probe classes (code-health, deploy-completeness per [ADR-208](./208-deploy-completeness-probe-class.md), wedge-classes per EPIC e-35dd6274, lifecycle-symmetry per audit finding #1) are invoked by callers.

> **§Amendment 2026-05-21 — partial supersession by [ADR-212](./212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md):** The **cockpit-tier Medic scheduled-tick role** (the W2 pane running hourly diagnosis-and-prevention) retires per ADR-212 §D1. The **probe substrate library** described above (`src/core/doctor-class.ts`, doctor probe registry, probe-class taxonomy) **PERSISTS** — it's reusable infrastructure for the Honker consumer EPICs that absorb medic's functions. Only the W2 role retires; the doctor library that this ADR established stays in tree.

**Why the seam mattered today.** Gitter pane appeared alive (process running, no segfault), but claude TUI was wedged (no `✻` activity, no commit since N hours, no response to operator). That is sentinel scope. Medic wouldn't probe it because nothing was broken in the code/test/build sense; the member was just *quiet*. Same root cause as the lifecycle-symmetry gap (audit finding #1).

Cross-refs: ADR-132 §Amendment 2026-05-19 (sentinel boundary side), ADR-027 (doctor framework), ADR-140 (cheap-model-first — sentinel = mechanical, medic = judgment-bearing), EPIC e-35dd6274 (wedge-clearing mechanism — scope clarity is precondition for probe-class routing per ADR-186), t-186d5910 (sentinel deploy — landing the deploy makes the boundary observable).

### 2026-05-22 — Doctor probes consume the fleet topo manifest

Per [ADR-222](222-topo-fleet-observability.md) §D6, the fleet manifest + orphan classifier are consolidated under `atmux topo`. Doctor probes consume the same manifest rather than re-probing per-class — the cage-tmux-without-registry / cron-block-without-worktree / worktree-without-cage / branch-without-row probes now filter `topo --json`'s `orphans[]` array. ADR-219 §D3's narrow `dissolve-epic` probe stays for one release window then collapses into topo's unified view (per ADR-222 §OQ4).

### 2026-05-23 — Sentinel role deleted per e-be01fc89; pane-liveness flows on-demand + orchd

The 2026-05-19 boundary text above moved pane-liveness scope to sentinel (W3 cockpit role). With sentinel deleted entirely 2026-05-23 (Sentinel REMOVAL EPIC), that routing is dead. Replacement coverage:

- **On-demand pane-liveness probes** — operator runs `atmux doctor` at session start / on suspicion; doctor's probe library (ADR-027) carries the wedge-class probes from ADR-186.
- **Event-driven escalate-to-claude-lead** — orchd substrate (EPIC e-a946af69) absorbs sentinel's continuous-observation pattern as event-driven consumers; ship-zero-window / pane-wedge / refusal-pattern signals flow to claude-lead via Honker pubsub (ADR-202/203), no cron required.
- **Cockpit-tier medic** — per [ADR-212](./212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) the W2 medic scheduled-tick role is also retired; the **probe substrate library** described in §Amendment 2026-05-21 above PERSISTS for orchd consumer use.

The 2026-05-19 cross-refs (ADR-132 §Amendment, t-186d5910 sentinel deploy, ADR-140 sentinel/medic boundary) are preserved as historical audit context; the live mechanisms they pointed at are gone.
