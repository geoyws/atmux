# ADR-189: Lean-mode side-project topology preset — disable cron-polling stopgaps + aggressive auto-prune

**Status**: Accepted — ratified by driver 2026-05-21 (lean vs fleet `team.json::topology` enum; lean is default for NEW installs; lean disables sentinel cron-poll / doctor cron backstop / drainer-cron pattern; event-driven dispatcher replaces; §OQ recommendations as-written)
**Date**: 2026-05-20
**Driver-ref**: driver-2026-05-20-11:20 MYT (operator killed sentinel cron 11:15 MYT after observing the 40% CPU/cycle cost at 18-team fleet scale).
**Parent EPIC**: e-be01fc89 (lean-mode side-project topology — anchor decision).
**Story**: s-47911ef7.
**Cross-refs**: [ADR-132](./132-pluggable-martinet.md) §Amendment 2026-05-20 (cron-polling deprecation), [ADR-140](./140-cheap-model-first.md) §Amendment 2026-05-20 (cheap-model-first pattern revision), [ADR-091](./091-kanban-driven-auto-merge.md) (epic-team lifecycle — gc integration), [ADR-077](./077-superdoctor-cockpit-role.md) (cockpit super-doctor — observer pattern context; on-demand-not-cron-fired under lean-mode), [ADR-086](./086-atmux-pulse.md) (Discord templates — invariant under lean-mode), [ADR-184](./184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-wide cap — orthogonal but related cost-curve framing), Epic [e-be01fc89](#) (parent — this ADR is its anchor decision).

## Context

### What the fleet-mode preset was sized for

The atmux fleet-of-teams conventions (cron-polling sentinel + W3 / W4 cockpit observers + drainer crons + lane-tick at high frequency) were designed for steady-state autonomous operation: 4–8 teams shipping in parallel, an operator available daily-or-weekly, and any single team's loop expected to make forward progress without human intervention for hours at a time. In that posture, cron-polling pays for itself: the cost of one operator-visible silent-failure-class wedge dominates the cost of running observers every 270s.

### What side-project scale actually looks like

A single operator running atmux on a side project has a different cost curve:

- **Single operator, episodic presence.** The driver attaches daily-ish, in bursts of 1–4h, then disconnects entirely overnight or for multi-day stretches.
- **Burst-then-idle work pattern.** A 2h focused work block produces ~4 commits, then teams sit idle for 18+h until the next session.
- **Wedges are operator-visible quickly.** If the driver re-attaches and a team isn't shipping, it's diagnosed in the first minute of triage — no week-long silent-death class.
- **Self-healing autonomy is wasted cost.** Sentinel cron polling 18 epic-teams every 270s while the operator is asleep produces nothing actionable; the operator triages the same wedges manually the next morning anyway.

### The cost curve that broke today

Operator observed 2026-05-20 11:15 MYT: sentinel cron-polling at 18-team fleet scale (4 parent teams + 14 live epic-teams across atmux / sopx / rentx / unum) consumed ~40% CPU on every tick — ~2min wallclock per fleet pass at the 270s cadence. Sustained CPU floor of ~10% across the host. Operator killed the cron line at 11:15 MYT; doctor probes + on-demand sentinel ticks continued to surface wedges as needed; no actual visibility regression observed.

The killcron event surfaced what was an implicit assumption: **sentinel cron-polling is sized for fleet-mode steady-state, not for side-project burst-then-idle**. At 4-team scale (~6 months ago when ADR-132 landed) the polling was free (~5% CPU/cycle, 27s per tick). At 18-team scale it dominated. The cost-curve crossover happened gradually as epic-teams proliferated post-ADR-091; no single ship caused it.

### Operator demand

Operator framing (post-killcron, 2026-05-20 11:20 MYT): *"opinionated preset for side-project installs; fleet-mode preset for orgs that need autonomous self-healing"*. The two postures co-exist — atmux serves both audiences — but the side-project install must NOT inherit fleet-mode cost defaults.

## Decision

### D1 — `team.json::topology` enum field

Add `topology: "lean" | "fleet"` to the team config schema. Default for NEW installs (`atmux start --new-team` / `atmux init --wizard`): **`lean`**. Existing teams (those whose `team.json` lacks the field) remain `fleet` until explicitly migrated via `atmux migrate --topology lean` (per §OQ-2).

The flip-point is the schema default. No magic-detection-from-fleet-size; operator owns the choice. Lean is the new default because most side-project installs don't need the fleet-mode cost envelope; orgs that do flip via `atmux start --topology fleet` or `atmux migrate --topology fleet`.

### D2 — Lean-mode disable list

Under `team.json::topology = "lean"`, the following cron-polling surfaces are **disabled by default**:

- **Sentinel cron-polling** (was: `*/270s` per fleet pass via W3 cockpit window + cron backstop). Per [ADR-132](./132-pluggable-martinet.md) §Amendment 2026-05-20, the cron-polling layer becomes lean-mode-opt-in; sentinel still ships, but only on-demand via `atmux sentinel tick --once` and via event-driven escalate-to-claude-lead in the dispatcher (per `t-ffcbd1dc`).
- **Doctor cron backstop** (was: `*/5min atmux doctor` planned as part of Epic e-35dd6274 Part E). Under lean-mode, doctor is on-demand only — operator runs `atmux doctor` at session start. The deploy-completeness probe class still ships as the probe library; only the cron firing layer retires.
- **Drainer-cron pattern** (`~/.atmux/bin/*-drainer.sh` + `*/N` cron blocks). The canonical example was `sentinel-escalation-drainer`; under lean-mode all such drainer-cron blocks are retired. The event-driven dispatcher (per t-ffcbd1dc) is the canonical replacement.
- **Lane-tick at >`*/15min` frequency**. Default lane-tick stays at `*/15` for nudges; high-freq variants (`*/5min` overrides observed on some teams) are flipped to `*/15` baseline under lean-mode.

### D3 — Lean-mode enable list

Under lean-mode, the following surfaces ship as the canonical replacements:

- **Aggressive `atmux cockpit gc`** (per Epic e-be01fc89 Story S3). Default `--stale-threshold 7d` under lean-mode (was: opt-in via flag). The gc pass reaps stale epic-team worktrees + cron blocks + cockpit.json entries that fleet-mode would have caught via sentinel polling.
- **Event-driven escalate-to-claude-lead via dispatcher** (per `t-ffcbd1dc`). When a worker fails to make progress (dispatcher detects via pubsub heartbeat or commit-cadence gap), the dispatcher escalates directly to the claude-lead pane via socket-pubsub — no cron required.
- **On-demand audit verbs**: `atmux sentinel tick --once`, `atmux doctor`, `atmux wedges` (the latter per [ADR-186](./186-wedge-clearing-mechanism.md)). Operator runs these at session start / on suspicion; the verbs produce the same outputs as the cron-polling layer would have, just at operator cadence.

### D4 — Manual driver triage assumption

Lean-mode assumes the human driver is in the loop **≥daily**. No autonomous self-healing required. Wedges that need claude-lead attention escalate via the dispatcher event-driven path; operator triages on the next session window. Fleet-mode's autonomous-overnight-recovery posture is explicitly OFF.

This assumption is load-bearing — it's what makes the cost-curve framing in §Context true. If an operator wants autonomous overnight recovery on a side-project install, they flip to fleet-mode (one-shot config change, no migration cost).

### D5 — Discord templates invariant

Discord templates from ADR-086 (`[whip-blocker]`, `[merge-conflict]`, `[epic-test-pass|fail]`, etc.) ship **identically** under both topologies. The *path* to Discord changes (event-driven vs cron-polling) but the message shape is invariant — operators see the same surfaces regardless of topology.

### D6 — Migration verb (NOT this ADR's scope)

The `atmux migrate --topology <lean|fleet>` verb is a sibling Task (per §OQ-2 resolution). This ADR specifies the field's existence + defaults; the migration mechanic is a separate implementation deliverable.

## Consequences

### Positive

- **CPU floor drops back to free-cost regime.** Lean-mode side-project installs stay in the ~5% CPU floor that fleet-mode held only at small scale. The cost-curve crossover that broke today no longer applies.
- **Simpler crontab** — fewer `*/N atmux ...` lines per team; `atmux up` footprint shrinks.
- **Cleaner failure model** — wedges surface at operator-triage cadence, not at cron-tick cadence. Easier to reason about "what's still broken when I sit down."
- **Fleet-mode preserved as opt-in.** Orgs running atmux for autonomous self-healing flip to `topology: "fleet"` explicitly; nothing about today's fleet-mode invariants changes.

### Negative

- **Lose the autonomous-overnight-recovery posture by default.** A wedge that lands at 02:00 MYT under lean-mode sits until the operator's next session. For side-project installs this is acceptable (operator framing); for fleet-mode-needing orgs it's not — they opt into fleet-mode for that reason.
- **Migration cost for existing teams.** Operators with running teams must run `atmux migrate --topology lean` deliberately; auto-migration was rejected per §OQ-2 to avoid surprise behavior changes.

### Neutral

- **Sentinel + doctor + drainer code stays in tree.** Lean-mode disables the *cron firing*, not the code path. The on-demand verbs (`atmux sentinel tick --once`, `atmux doctor`, `atmux wedges`) continue to ship for both topologies; lean-mode just doesn't auto-fire them.
- **Topology field is per-team.** A cockpit hosting both lean teams and fleet teams is a supported configuration (per §OQ-3 resolution).

## Trade-offs considered

### Why not "scale cron cadence by team count"

Considered: dynamically reduce sentinel cadence from 270s to e.g. 30min when team count >10, back to 270s when <5. Rejected — adds a dynamic-tuning surface that needs its own observability + reasoning model. Operators want **predictable** cron behavior, not adaptive cadence. Two clean buckets (lean / fleet) is easier to reason about than a continuous tuning curve.

### Why not "drop cron-polling entirely; only support event-driven"

Considered: deprecate fleet-mode + ship only the event-driven dispatcher as the universal path. Rejected — fleet-mode's autonomous-overnight-recovery posture is genuinely useful for orgs running atmux as production infrastructure; killing it would orphan that audience. The two-topology split lets each posture coexist without one taxing the other.

### Why not "default to fleet for back-compat"

Considered: keep `fleet` as the schema default; require explicit `topology: "lean"` to opt in. Rejected — most installs today are side-project scale (operator framing), and the cost curve broke at fleet defaults. Defaulting to lean for NEW installs matches the typical use case; existing teams keep their behavior via the no-field-means-fleet back-compat path.

## Open questions

1. **(LOW reversibility) Default for NEW installs: `lean` OR `fleet`?** Recommendation: `lean` (matches operator side-project posture). Fleet stays as opt-in. Driver can override per install via `atmux start --topology fleet` (per §D1). Easy to reverse if usage data shows most installs are fleet-class.

2. **(LOW reversibility) Migration path for EXISTING teams: auto-migrate on next `atmux up` OR explicit `atmux migrate --topology lean` verb?** Recommendation: **explicit verb** (no surprise self-migrations). Operators should choose the topology flip deliberately. Auto-migrate would silently change cron behavior on existing installs.

3. **(LOW reversibility) Per-team override granularity: team-level `topology` field OR per-verb opt-out flag?** Recommendation: **team-level** (simpler; operator sets once at team-creation). Per-verb opt-outs would multiply the matrix of "what's cron-firing on this team?" surfaces — too much per-team config to reason about.

4. **(LOW reversibility) Discord template revisions: do lean-mode escalations get a different message header?** Recommendation: **no** — same ADR-086 templates; the *path-to-Discord* changes (event-driven vs cron-polling) but the message shape is invariant. Operators see the same `[whip-blocker]` / `[merge-conflict]` headers regardless of topology.

## Implementation plan

This ADR is design-only. Sibling Tasks under Epic e-be01fc89:

- **T6** (deps T5 — THIS ADR): `team.json` schema field + reader gating (`src/schema/team.ts::TeamConfig.topology`, `z.enum(["lean","fleet"]).default("lean")`; reader gates the disable/enable lists per §D2/§D3).
- **T7**: Cron emission gating — `src/core/cron.ts::renderCronLines` reads `team.topology` and omits sentinel-polling + drainer + high-freq lane-tick blocks under `lean`.
- **T8**: `atmux migrate --topology <lean|fleet>` verb — flips the field + reconciles cron state in one shot (no surprise auto-migrations; operator runs explicitly).
- **T9**: ADR-132 + ADR-140 §Amendments — the cron-polling deprecation note (under lean-mode) + cheap-model-first pattern revision (under lean-mode, the cheap-model-observer pattern is on-demand not cron-fired).
- **T10**: RUNBOOK-on-demand-audit replaces RUNBOOK-sentinel for lean-mode operators (or supplements it with a §Lean-mode section).
- **T11**: Regression-guard test — ensures cron blocks not re-introduced on lean-mode installs (a sibling team's accidentally-fleet-shaped cron template doesn't drift).

## Out of scope

- **Auto-detect topology from observed behavior.** No "cron-polling will be skipped if your last fleet-pass was <1% CPU" magic. Operator owns the choice via the schema field.
- **Per-verb opt-out flags** (per §OQ-3 resolution).
- **Discord template variants per topology** (per §OQ-4 resolution).
- **Fleet-mode shutdown.** ADR-132 / ADR-140 / ADR-091 cron paths continue to ship for fleet-mode; lean-mode just opts out.
