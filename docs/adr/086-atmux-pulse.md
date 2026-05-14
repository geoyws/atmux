# ADR-086: `atmux pulse` — cockpit-wide deterministic verdict probe (Phase 1 of MiniMax observer)

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-13

> **Naming note 2026-05-14**: the cockpit-tier hourly role this ADR compares against (named `superdoctor` in §Context "complementary at hourly LLM tier" bullet + §Cross-refs) is now called **medic** per [ADR-133](133-medic-rename.md). Supersession is naming-only — design canonical per ADR-077.

## Context

The cockpit runs several liveness layers already:

- **`whip`** nudges panes per team; doesn't render a cross-team verdict.
- **`atmux watchdog`** scans per-team heartbeats per ADR-057 §D6b; per-member only.
- **`superdoctor`** (ADR-077) runs an hourly LLM session, not a 5min deterministic loop.
- **`atmux doctor --json`** is single-team config health; no commit-cadence.
- **`atmux status --json`** is a single-team kanban/member snapshot.

None of them answer the recurring failure mode flagged repeatedly in `CLAUDE.md` §"Team Roles & Driver Mode":

> *"Recurring failure mode George has flagged dozens of times: driver reports 'team is alive / queued / dispatched' without verified turn-execution, user re-checks N min later, nothing moved, time wasted. **'Working' is defined by commit-cadence**, not pane liveness."*

George floated a 5min cockpit-level probe — check every enabled team, ping Discord if a team-lead or its members are stuck. The original framing was MiniMax-via-OpenCode for **model-diversity** (catch Claude blind spots that our same-model whip/watchdog/superdoctor loops rationalise away).

Direction decided in chat: **build the cheap deterministic probe first, layer MiniMax on top later.** Phase 1 validates the signal pipeline (data sources → verdict function → Discord rendering → dedup) and is shippable in isolation. Phase 2 swaps the verdict-renderer for a MiniMax-via-OpenCode call against the same input bundle — separate plan, separate ADR.

## Decision

Add a new cockpit-wide verb `atmux pulse`. Pure-function verdict logic, separated for testability and Phase 2 reuse. Discord ping fires on verdict **change**, not every cycle.

### Verdict rules (`computeVerdict` in `src/core/pulse-verdict.ts`)

Precedence (top wins):

```
🚨 Need you   ← pendingDecisionsCount > 0 OR staleDriverInboxCount > 0
🟢 Shipping   ← commitCount ≥ 1 AND doctorRed == 0
🔴 Stalled    ← commitCount == 0 AND inProgressCount ≥ 1 AND windowAgeMin ≥ windowMin
🟡 Cool       ← commitCount == 0 AND inProgressCount == 0 AND todoCount == 0
🟡 Idle       ← otherwise (work exists, no commits yet)
```

The verdict vocabulary mirrors `CLAUDE.md §Discord` exactly. A team with commits AND a red doctor finding falls through to Idle — we don't announce 🟢 over a broken environment.

### Data sources per team (read-only)

For each `team` in `enabledTeams(loadCockpit())`:

1. `git -C <team.root> log --since=<windowMin>min --oneline` → `commitCount`
2. `runAllChecks(<atmuxDir>, team)` (the in-process pipeline behind `atmux doctor --json`) → `redCount`
3. `loadKanban(<atmuxDir>)` → `inProgressCount` + `todoCount`
4. `<team.root>/docs/pending-decisions.md` → count lines starting with `🔵`
5. `<atmuxDir>/driver-inbox.md` → count entries without a triage marker (✅/📤/⏳/❌) AND >30min old

Phase 1 scope: **root commits only**. Submodule recursion deferred to Phase 2 (added value, but adds cost per cycle).

### Dedup / fire policy (`shouldFire` in `src/core/pulse-state.ts`)

State file: `~/.atmux/state/pulse-state.json` — cockpit-scoped, one row per team.

```json
{
  "teams": {
    "<team>": { "verdict": "🟢 Shipping", "lastFireEpoch": 1715568000, "lastCommitCount": 3 }
  }
}
```

Fire rules:

- **No prior state** → fire (`first-observation`).
- **Verdict transition** → fire (`transition`).
- **Same verdict ≥ 🔴** (`🔴 Stalled` / `🚨 Need you`) AND prior fire ≥ `dedupMins` ago → re-fire (`sustained-urgency`).
- **Same verdict < 🔴** → skip (`deduped`).

Channel is **quiet during steady-state 🟢 Shipping or 🟡 Cool**, loud on transitions and on sustained urgency. State is written ONLY when at least one team fired this tick — non-fire ticks don't bump `lastFireEpoch`, so the sustained-urgency window is measured against the last fire (not against tick count).

### Schema (`src/schema/cockpit.ts`)

```ts
export const CockpitPulse = z.object({
  windowMins?: number,    // default 30
  intervalMins?: number,  // default 5 (manual cron line P1)
  dedupMins?: number,     // default 30
}).strict();
```

All fields opt-in. Omitting the `pulse` block in `cockpit.json` gets the defaults.

### Discord template

New named template `pulse-verdict` in `src/abstractions/discord.ts`. Verdict-first format per `CLAUDE.md §Discord`:

```
💓 **[pulse-verdict]** · `atmux` · 15:38 MYT

🟢 **Shipping** — 3 commits in 30min, doctor green

📍 3 commits in 30min · 2 inProgress · fire: transition
```

Header emoji per-verdict: 💓 (Shipping), 📊 (Cool/Idle), 🛑 (Stalled), 🚨 (Need you). All four are in the `CategoryEmoji` union and the bullet allowlist.

Body is verdict-only (single load-bearing line) with a 📍 footer carrying ambient liveness. No bullets / sections — keep the message scannable on mobile per the verdict-first spec.

### Cron installation

Cockpit-wide cron is new ground — distinct namespace from the existing per-team cron block. The auto-install fires from `atmux cockpit rebuild` as Phase 6 (after session reconcile), mirroring the per-team `atmux start → cron-install` flow:

- Marker fence: `# >>> atmux:cockpit` / `# <<< atmux:cockpit` (separate from `atmux:team=<n>` so per-team strip passes never touch it).
- One line: `*/<interval> PATH=... <atmux-bin> pulse --config <cockpit.json> >> <log> 2>&1`.
- Interval default 5min, configurable via `cockpit.pulse.intervalMins`.
- Idempotent: re-running `cockpit rebuild` is a no-op when the line is current; replaces the block when the interval changes.
- Honors `ATMUX_NO_CRON=1` opt-out + non-fatal posture (crontab swap failure warns to the rebuild logger, does NOT abort the rebuild).

The pure transforms live in `src/core/cron.ts`: `renderCockpitCronBlock`, `stripCockpitBlock`, `installCockpitCronBlock`. The verb-side install lives in `src/verbs/cockpit.ts::installCockpitCron`.

Manual install (for operators who don't run `cockpit rebuild`) is still documented in `docs/RUNBOOK-pulse.md`. A future `atmux cron-install --cockpit` standalone verb is a deferred follow-up but not load-bearing — the auto-install already covers the common path.

## Consequences

- **+1 verb** (`atmux pulse`). Registered in `src/cli.ts`; usage `atmux pulse [--json] [--ping] [--config <path>]`.
- **+1 Discord template** (`pulse-verdict`), one renderer in `src/abstractions/discord.ts`.
- **+1 state file** (`~/.atmux/state/pulse-state.json`), cockpit-scoped, atomic writes.
- **+1 cron line** (manual P1).
- **+1 cockpit.json field** (`pulse`, optional with defaults).
- **Channel-noise budget**: ≤1 ping per team per transition + ≤1 sustained re-fire per `dedupMins` for 🔴 / 🚨. Steady-state 🟢 / 🟡 → silent.
- **Reviewer enforcement**: same as ADR-085 — `needs-approval` watcher + `pulse` cover overlapping fields (driver-inbox + decisions), but the consumers differ. ADR-085 surfaces approval debt in the whip digest; ADR-086 surfaces cross-team verdict at 5min cadence. Both stay.

## Forward pointer (Phase 2 — separate plan)

- MiniMax-via-OpenCode external observer reading the same `--json` bundle, rendering a parallel LLM verdict line; pinged alongside the deterministic verdict for divergence detection.
- Submodule-recursive commit-cadence (root + active submodules).
- Auto-install via `atmux cron-install --cockpit`.
- Per-team Discord webhook routing (multi-channel).
- Historical verdict timeline (`atmux pulse history`).

Phase 2 plan slot reserved (no number assigned yet).

## Phase 1.5: Verdict-specific dedup ladder

**Date added**: 2026-05-13. **Driver-ref**: driver-inbox 18:17 MYT 2026-05-13 (pulse-spam Discord cadence). **Task**: t-c99360fb.

### Context

Phase 1's `shouldFire` uses a single `dedupMins` window for ALL sustained-urgency verdicts (🔴 Stalled + 🚨 Need you). Phase 1.1's flat 30 → 120 bump reduces channel noise but doesn't differentiate urgency tiers, and leaves 🟡 Idle/Cool with no re-surface at all (silent ambiguity: "is the cron broken, or is the team genuinely cool?"). CLAUDE.md §Discord verdict-ladder explicitly orders 🚨 above 🔴 — they deserve distinct re-fire cadences.

### Decision

Per-verdict ladder constant + schema field; `shouldFire` consults the ladder instead of a flat int.

```ts
// src/core/pulse-state.ts
export const DEFAULT_PULSE_DEDUP_LADDER: Readonly<Record<PulseVerdict, number | null>> = {
  "🚨 Need you":  60,      // 1hr — loud but not training-the-eye
  "🔴 Stalled":   30,      // 30min — degraded-state probe cadence
  "🟡 Cool":      4 * 60,  // 4hr — confirm steady-state on long lull
  "🟡 Idle":      4 * 60,  // 4hr — confirm steady-state on long lull
  "🟢 Shipping":  null,    // never re-fire on shipping (transition only)
};
```

Schema (`src/schema/cockpit.ts CockpitPulse`) gains an optional ladder override:

```ts
dedupLadderMins: z.partialRecord(VerdictSchema, z.number().int().positive().nullable()).optional(),
```

Operator override merges OVER the default ladder: missing verdicts inherit; explicit `null` disables re-fire for that verdict.

`shouldFire` signature change: `dedupMins: number` → `dedupLadderMins: Record<PulseVerdict, number | null>`. Lookup `ladder[current]`: if `null` → skip (deduped); if number → compare against elapsed since `lastFireEpoch`. Transition path UNCHANGED — transitions always fire regardless of ladder.

`URGENT_VERDICTS` set is REMOVED — replaced by "verdict has non-null entry in ladder".

### Consequences

- One config knob → one map. Operators can tune per-verdict via `cockpit.pulse.dedupLadderMins.🚨 Need you = 90` etc.
- 🟡 Cool/Idle re-fires every 4hr → channel never goes >4hr-silent on a steady-state team. Removes "cron broken or team cool?" ambiguity.
- Phase 1.1's flat `DEFAULT_PULSE_DEDUP_MIN = 120` becomes a **fallback const** (kept for any external caller passing flat int through legacy code paths) but the `atmux pulse` verb itself routes through the ladder.
- Schema field `cockpit.pulse.dedupMins` is preserved as backward-compat alias: if set AND `dedupLadderMins` is unset, populate the ladder uniformly with that int FOR THE URGENT VERDICTS ONLY (mirrors pre-§1.5 binary URGENT_VERDICTS semantic). Soft-deprecate, don't break existing operator configs. Explicit `dedupLadderMins` wins over `dedupMins` when both are set — single-source-of-truth precedence.
- **Phase 1.6 sustained-fire cap DEFERRED**. Unblock condition: if, post-Phase 1.5 soak (14 days), any team produces >2 sustained re-fires per 24h at the same verdict, file follow-up Task for `sustainedFireCount` field on `pulse-state.json` rows + per-team-per-day cap (default 3 → silence until verdict transitions).

### Reversibility

Medium — revert ladder const + schema field + `shouldFire` signature; restore flat `dedupMins` int path. Single commit revert if rolled back fast; two if mixed with Phase 1.6 follow-up.

### Refs

- Phase 1 (ADR-086 main body) — verdict + state file shape this extends.
- Phase 1.1 — flat bump this supersedes (kept as fallback const).
- CLAUDE.md §Discord verdict-ladder — source vocabulary.

## Refs

- `src/verbs/pulse.ts` — verb entry, gather → verdict → fire pipeline.
- `src/core/pulse-verdict.ts` — pure `computeVerdict` + `describeVerdict`.
- `src/core/pulse-state.ts` — dedup state + `shouldFire`.
- `src/abstractions/discord.ts` — `renderPulseVerdict` next to existing renderers.
- `src/schema/cockpit.ts` — `CockpitPulse` schema.
- `docs/RUNBOOK-pulse.md` — operator setup.
- ADR-085 — sibling whip-approvals-watcher; partial overlap on driver-inbox + decisions.
- ADR-077 — superdoctor; complementary at hourly LLM tier.
- ADR-057 §D6b — watchdog; complementary at per-team heartbeat tier.
- `CLAUDE.md` §Discord — verdict vocabulary + format this ADR implements.

## Phase 2: Meta-watchdog (t-351318dc)

### Context

The `[pulse-verdict]` ping fires on per-team commit/doctor/inbox state. It is silent about **superdoctor's own liveness**. If superdoctor (the ADR-077 self-healing role) is saturated, wedged, or its claude process has crashed, the whip → complaints → superdoctor escalation chain silently breaks — complaints accumulate, no one acts.

### Decision

The same 5-min cron tick that emits `[pulse-verdict]` also probes the cockpit's aggregate superdoctor activity. Probe = walk every cockpit-enabled team's `state.db`, aggregate:

- **Open complaints** — `SUM(complaints WHERE status='open')` across teams. The "is anyone unhappy" signal.
- **Latest attempt epoch** — `MAX(superdoctor_attempts.attempted_at)` across teams (the ADR-077 §F6 table). The "is superdoctor acting at all" signal.

**Dormancy gate**: `openComplaints > 0 AND (latestAttempt IS NULL OR now - latestAttempt >= 2h)`. A cold cockpit (no attempts on record) with open complaints qualifies — the cockpit never started healing.

**Fire policy**: 1 page per dormancy streak. Streak ends when (a) a fresh attempt lands, or (b) all complaints clear. State row on `pulse-state.json::metaWatchdog = { paged, dormantSinceSec }`.

**Discord template** `[meta-watchdog]` — verdict-first 2-button menu (A: check superdoctor pane, B: kill+respawn) with a 30-min default deadline.

### Implementation

- `src/core/superdoctor-activity.ts` — `gatherSuperdoctorActivity` (probe) + `decideMetaWatchdogFire` (pure policy).
- `src/abstractions/discord.ts` — `renderMetaWatchdog` template.
- `src/core/pulse-state.ts` — `PulseMetaWatchdogSchema` (optional field on root `PulseState`).
- `src/verbs/pulse.ts` — gather + decide + emit, sequenced after the per-team verdict loop. Failure-isolated: probe exceptions don't crash the verdict pulse.

### Refs

- ADR-077 §F6 — the `superdoctor_attempts` table this probes.
- ADR-077 §D5 — the `complaints` table this aggregates.
- Phase 1 (this ADR's main body) — the cron + state.json shape this extends.
- t-351318dc — kanban Task that authored the implementation.
