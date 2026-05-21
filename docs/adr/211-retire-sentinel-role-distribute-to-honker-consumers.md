# ADR-211: Retire the Sentinel role — observation functions distributed to Honker event consumers

**Status**: Accepted — ratified by driver 2026-05-21 (Sentinel role retires entirely; observation functions distribute to Honker event consumers per §D2; ADR-132 pluggable abstraction interface preserved one release for back-compat; doctor probe surfaces config drift; cleanup-EPIC purges sentinels/*.ts + sentinel verb + sentinel-related cron entries; ADR-186 wedge-probe-library half persists, sentinel-runner half migrates; ADR-077 medic NOT affected per §D6 → see ADR-212 which retires medic on same lead-gated pattern; §OQ recommendations as-written including the 4-EPIC sentinel-split — superseded by ADR-212 §D4's 1-EPIC collapse per operator's simplification directive same session)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator question — *"do we really need the sentinel?"* — after the cursor rejection (ADR-201) + ADR-207 (Opus-sentinel supersedes cursor) + Honker substrate Phase-1 ship (ADR-202 + ADR-203). Sentinel was a stopgap for the polling era; with Honker delivering event-driven wake at ~1ms p50, the continuous-observation role becomes net-negative.
**Supersedes (in scope)**: [ADR-132](132-pluggable-martinet.md) (pluggable Sentinel abstraction — both §D1 backend selection and §D2 abstraction become moot when no role is shipped) and [ADR-207](207-opus-sentinel-supersedes-cursor-sentinel-adr-132.md) (Opus-sentinel supersedes cursor-sentinel — supersedes the supersession; ADR-207's impl-EPIC never ships per this ADR). Sibling sentinel-extension ADRs that become historical context only: [ADR-158](158-rename-martinet-to-sentinel.md) (rename martinet→sentinel — terminology only, persists), [ADR-183](183-sentinel-scope-includes-epic-teams.md) (sentinel scope to epic-teams — scope-extension premise lost when the role itself retires), [ADR-185](185-sentinel-epic-team-scope-extension.md) (sentinel epic-team scope extension — same), [ADR-206](206-sentinel-dynamic-epic-discovery.md) (sentinel dynamic discovery — same).
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) §D12 (consumer EPIC sequence — amended to absorb sentinel functions), [ADR-203](203-event-topic-taxonomy.md) §D2 (event topics that subscribe to sentinel-class signals), [ADR-138](138-verified-send-keys.md) (pane-classifier patterns — kept as event-triggered helper), [ADR-077](077-cockpit-superdoctor.md) (medic role at cockpit W2 — sentinel's sibling; medic stays since it's hourly-scheduled diagnosis-and-prevention, not continuous observation), [ADR-186](186-wedge-clearing-mechanism.md) (wedge-clearing mechanism — its sentinel-runner half becomes a Honker consumer, probe-library half is unchanged), memory `feedback_opus_all_for_agile_flow` (operator stance — refreshed 2026-05-21).

## Context

The Sentinel role at cockpit window W3 was introduced (ADR-132, 2026-05-14) to **offload mechanical observation work** from the Claude lead's per-team whip cycle. The premise was:

1. The Claude lead is expensive — burn Opus + xhigh per turn.
2. Pure observation (capture pane state, classify cadence, nudge idle members) is mechanical work that doesn't need Opus.
3. Therefore: a separate, cheaper LLM (cursor composer-2-fast per ADR-132 §D1) runs continuously at cockpit W3, observing every team's panes + nudging when needed. ADR-132 §D5's strict escalation gate routes judgment-class decisions to Claude lead; the cheaper sentinel handles the mechanical surface.

That premise rested on **continuous polling**: sentinel ticks every 30-60 seconds, captures every pane across every team, classifies state, decides what (if anything) to do, sleeps. Even when nothing is happening, sentinel is awake and consuming API quota.

The world has moved:

- **ADR-201 rejected (2026-05-21)** — cursor is OUT across atmux. Sentinel's backend becomes Opus per ADR-207, but Opus running observation continuously is expensive. ADR-140's cheap-model-first principle is preserved at sentinel tier only by accepting the cost or by changing the architecture.
- **ADR-202 Honker substrate Phase-1 shipped (2026-05-21)** — in-DB pubsub via SQLite extension. State-machine transitions become events. Consumer wake latency ~1ms p50 (vs 30-60s tick cadence). Subscribers sleep until specific events fire — no idle observation cost.
- **Pane-state observation** — the one residual concern was that pane glyph + scroll content live in tmux memory, not sqlite, so polling tmux capture-pane was unavoidable. The resolution per ADR-202 §"Pane-state — the not-in-DB problem": **pane-classifier becomes event-triggered**, not scheduled. Run capture-pane ONCE per relevant trigger event (`task.claimed`, `send.invoked`, watchdog-fired), write the classification back to a `pane_state` table, emit `pane.classified` event for downstream consumers. Drops the polling cadence to zero.

Every function sentinel performed maps cleanly to an event-driven Honker consumer:

| Sentinel function (today) | Honker-era consumer (proposed) |
|---|---|
| Periodic pane-state capture + classify | Event-triggered classifier job: fires on `task.claimed`, `send.invoked`, watchdog timeouts. Writes `pane_state` row + emits `pane.classified`. |
| Wedge recovery (send-keys to stuck panes) | Consumer of `pane.wedged` event (emitted by classifier when wedge pattern detected). Re-uses the existing `safeSendKeysWithVerify` per ADR-138. |
| Idle-member nudging | Consumer of `task.unclaimed` (newly published when a Task transitions to claimable state with no claimant). Optional watchdog: if no claim within N min, ping the relevant lane's members. |
| Refusal detection | Consumer of `pane.refusal-detected` event (emitted by classifier when refusal patterns match per ADR-139). |
| Stall-complaint filing | Consumer of `task.stalled` event (emitted by watchdog after no-commit-in-N-min on claimed task). |
| Silent-member-death (ADR-183 scope) | Consumer of substrate's `internal.smoke.tick` — absence-of-ticks-from-team-X for M min → emit `team.silent` → cockpit alert. |
| ADR-132 §D5 judgment-class escalation | Same routing pattern — consumer that detects an escalation condition emits `*.escalated` event; Claude lead's pane consumes via the existing tell-lead mechanism. |

The pluggable abstraction (ADR-132 §D2 — Sentinel as a pluggable role decoupled from any specific LLM CLI) was preserved through ADR-207 against a future re-enable. With this ADR, that re-enable path is also dropped — the architectural reason for the abstraction (swappable observation backend) is replaced by "no continuous observation, only event-driven consumers."

## Decision

### D1 — Retire the Sentinel role entirely

No production atmux configuration ships a Sentinel impl. Specifically:

- **`team.json::sentinel`** field stays in the Zod schema (back-compat) but the runtime no longer reads it. Doctor probe emits a yellow row if it's present + non-null in any config (deprecation surface for one release).
- **`cockpit.json::defaultSentinel`** same — stays in schema, runtime reads it but never spawns a sentinel pane.
- **`cockpit.json::sentinel`** block — stays in schema, but `enabled: true` no longer provisions W3. Doctor probe surfaces the dead field.
- **`src/abstractions/sentinel.ts`** interface — kept (for the Zod-schema-paired type), but no impls register. The `claude` impl from ADR-132 §D1 falls back path is deleted in the impl-EPIC.
- **`src/abstractions/sentinels/cursor.ts`** — already slated for deletion per ADR-207 D1. Stays deleted.
- **`src/abstractions/sentinels/claude.ts`** — deleted in this ADR's impl-EPIC (it was ADR-207's planned replacement; never ships now).
- **`src/verbs/sentinel.ts`** (the verb-level tick) — deleted. The function it performed migrates to event consumers per D2 below.

The W3 cockpit slot becomes vacant + reusable (or repurposed for a future cockpit role).

### D2 — Distribute sentinel functions across Honker event consumers

Amend ADR-202 §D12 consumer EPIC sequence:

| EPIC (ADR-202 §D12) | Sentinel function absorbed |
|---|---|
| **e-honker-watchdogs** (was: port absence-detection) | Absorbs **task.stalled** stall-complaint emission + watchdog-driven pane-classifier triggering. |
| **e-honker-pane-classifier** *(new — splits from sentinel EPIC)* | Event-triggered tmux capture-pane + classify. Emits `pane.classified`, `pane.wedged`, `pane.refusal-detected`. Cron-backstop sweep at 10-min cadence for catch-net. |
| **e-honker-wedge-clearer** *(new — splits from sentinel EPIC)* | Consumer of `pane.wedged`. Re-uses ADR-138 verified-send-keys. Replaces sentinel's wedge-recovery half. |
| **e-honker-refusal-handler** *(new — splits from sentinel EPIC, may fold into watchdogs)* | Consumer of `pane.refusal-detected`. Emits `*.escalated` if threshold exceeded per ADR-139. |
| **e-honker-silent-team-detector** *(new — splits from sentinel EPIC)* | Consumer of `internal.smoke.tick` absence-per-team. Replaces ADR-183 silent-member-death role. |
| **~~e-honker-sentinel~~** (was: sentinel observation eventized) | **REMOVED** — no sentinel role to eventize. |
| **e-honker-cleanup** | Adds: delete sentinel.ts + sentinels/*.ts + sentinel verb + sentinel-related cron entries + ADR-132/158/183/185/206 reviewer-surface entries that are now moot. |

The original ADR-202 §D12 sequence had `e-honker-sentinel` as one of 8 EPICs. With this ADR, it splits into 4 smaller, function-specific EPICs (pane-classifier, wedge-clearer, refusal-handler, silent-team-detector). Each is single-responsibility + simpler to ship + easier to roll back if Honker has issues.

### D3 — Doctor probe + reviewer surface

Three drift surfaces during the deprecation grace:

1. **Doctor row `sentinel-config-residue`** (yellow) — any `team.json` or `cockpit.json` with `sentinel.enabled === true` or `sentinel.impl` set to a non-null value, OR `cockpit.json::defaultSentinel` set to anything other than null. Hint: per ADR-211, sentinel is retired — set field to null.

2. **Reviewer flag-class** — code that imports `src/abstractions/sentinel.ts` or `src/verbs/sentinel.ts` past the impl-EPIC ship date triggers a high-severity flag. (Pre-impl-EPIC, the files still exist; reviewer scopes the flag to commits-after-EPIC-ship-SHA.)

3. **Memory + brief sweep** — memories `project_martinet_pattern`, `project_sentinel_rename_adr_158`, `project_cheap_model_first_adr_140` get annotation pointers to this ADR. Templates `templates/briefs/sentinel.md` (if present) deleted.

### D4 — Sequencing

The retirement EPIC runs LAST, after the consumer EPICs that absorb sentinel functions have stabilized:

```
1. e-honker-substrate          ← shipped 2026-05-21 (Phase-1)
2. e-honker-jury                ← spawned 2026-05-21 (e-5a5110d0, soft-stopped, ready to resume)
3. e-honker-gitter
4. e-honker-watchdogs
5. e-honker-pane-classifier    ← absorbs sentinel function #1
6. e-honker-wedge-clearer      ← absorbs function #2
7. e-honker-refusal-handler    ← absorbs function #4 (may fold into #4 watchdogs)
8. e-honker-silent-team-detector ← absorbs ADR-183 function
9. e-honker-whip
10. e-honker-medic              ← MEDIC PERSISTS (sibling role at W2, NOT retired — it's hourly diagnosis, not continuous observation; ADR-077 stays)
11. e-honker-cleanup            ← absorbs sentinel-residue deletion per D3
```

**Pre-stabilization protection:** until consumers #5-8 land + run stable for ≥7 days, the sentinel-residue doctor probe stays yellow rather than red — operators get notice of the impending retirement without blocking other work. Once consumers are stable, the doctor probe upgrades to red on residual sentinel config.

### D5 — ADR-207 disposition

ADR-207 (Opus-sentinel supersedes cursor-sentinel) stays `Status: Accepted` (operator ratified 2026-05-21 commit `2beb82b`) but its impl-EPIC **never ships**. Mark in this ADR's §References — ADR-207 was a transitional decision based on the assumption that the sentinel role itself would persist with a different backend. That assumption is reversed here.

The §D2 "pluggable abstraction preserved" decision in ADR-207 becomes moot since no impl will register against the abstraction. The abstraction interface stays in `src/abstractions/sentinel.ts` for one release (Zod schema parity) before deletion in the cleanup-EPIC.

### D6 — Medic stays (not affected by this ADR)

Medic (cockpit W2, ADR-077) is a **sibling role** to sentinel but is **NOT retired**. Reason: medic is **hourly-scheduled diagnosis-and-prevention**, not continuous observation. It runs once an hour, examines hygiene fingerprints / complaints / cage states, takes structural fixes (rotate lead, clear member, push branch fix). That's genuinely scheduled work — Honker substrate doesn't displace scheduled work, only polling-disguised-as-observation.

Medic continues to run at W2 with the Opus backend it currently has. ADR-077 stands.

## Consequences

**Becomes easier:**

- One less role to spawn at cockpit boot — simpler cockpit topology.
- One less Claude budget line item — sentinel was projected as cheap-via-cursor; with cursor rejected, Opus-sentinel would have been expensive. Retirement eliminates the question.
- Fewer ADR cross-refs to maintain — ADR-132/158/183/185/206 become historical context, not roadmap.
- Each absorbed function gets a dedicated single-responsibility consumer — easier to reason about, test, and disable individually.
- ADR-132 §D5 escalation gate complexity disappears (no central role making the judgment-vs-mechanical split; each consumer routes escalations to the lead directly).

**Becomes harder:**

- More consumer EPICs in the sequence (5 split functions instead of 1 sentinel EPIC). Each is small but adds to the total EPIC count.
- Distributed observation means no central "what's the state of every team" view. The cockpit BAU report + medic hourly tick provide the equivalent at slower cadence — usually sufficient.
- Operator mental model shift — "sentinel watches X" becomes "X watches itself via these specific events." Documentation sweep covers this in the impl-EPIC.

**Risks + mitigations:**

- **Risk**: A sentinel function gets missed in the migration — silently lost capability. **Mitigation**: D3 doctor probe surfaces sentinel-config-residue. D4 sequencing keeps sentinel disabled but config-readable during the grace period so operators can audit "what functions did sentinel do that aren't yet absorbed?" before the cleanup-EPIC purges.
- **Risk**: Operator changes stance — wants sentinel back. **Mitigation**: ADR-132 §D2 pluggable abstraction interface stays in `src/abstractions/sentinel.ts` for one release. Restoring sentinel is a new ADR + register-an-impl, not an architectural redo.
- **Risk**: Distributed consumers create coordination overhead (e.g. two consumers both react to `pane.wedged`). **Mitigation**: each event has exactly one declared primary consumer per ADR-203 taxonomy; secondary consumers are explicit + log-only by convention.
- **Risk**: Pane-classifier EPIC doesn't ship in time, leaving observation gaps. **Mitigation**: cron-backstop sweep at 10-min cadence for the classifier itself — same defense-in-depth as ADR-202 §D6 for every other consumer.

## Out of scope (deferred)

- **Re-adding a Sentinel-like role for future LLM (Sonnet, Haiku, kimi)** — separate ADR + impl-EPIC if/when needed.
- **Cockpit W3 slot repurposing** — the freed slot is left vacant. A future ADR may claim it (e.g. a dedicated planner-observer role, an operator dashboard pane). Not in this ADR.
- **Migrating the existing `sentinel-state.json` artifacts** — they remain on disk as forensic record until cleanup-EPIC purges. No migration path needed (consumers don't read sentinel-state).
- **ADR-186 wedge-clearing-mechanism refactor** — its sentinel-runner half maps to e-honker-wedge-clearer; the probe-library half persists. The ADR itself doesn't need re-filing; the impl-EPIC handles the wiring shift.

## References

- ADR-132 — pluggable Sentinel abstraction (this ADR supersedes both §D1 backend selection and §D2 abstraction shape — no impl ships)
- ADR-207 — Opus-sentinel supersedes cursor-sentinel (Status: Accepted; impl-EPIC never ships per this ADR's §D5)
- ADR-202 §D12 — Honker substrate consumer EPIC sequence (amended to absorb sentinel functions per §D2 above)
- ADR-203 §D2 — event topic taxonomy (sentinel-class events: `pane.classified`, `pane.wedged`, `pane.refusal-detected`, `task.stalled`, `team.silent`)
- ADR-158 — martinet→sentinel rename (terminology stays; role retires)
- ADR-183 — sentinel scope to epic-teams (the silent-member-death function it added becomes a Honker consumer per D2)
- ADR-185 — sentinel epic-team scope extension (same fate)
- ADR-206 — sentinel dynamic epic-team discovery (premise lost when no continuous-discovery process exists; dynamic lookup happens at consumer subscribe-time instead)
- ADR-186 — wedge-clearing-mechanism (sentinel-runner half maps to e-honker-wedge-clearer)
- ADR-077 — cockpit superdoctor / medic (NOT affected — medic stays per §D6)
- ADR-138 — verified send-keys (reused by wedge-clearer event consumer)
- ADR-139 — refusal-pattern detection (reused by refusal-handler event consumer)
- ADR-140 — cheap-model-first principle (sentinel-tier walk-back redundantly closed: not Opus-sentinel, not any-sentinel)
- memory `feedback_opus_all_for_agile_flow` — 2026-05-21 reaffirmation date covers this ADR too
- memory `project_honker_pubsub_rehaul_design` — design state, needs §"Sentinel retired" annotation in the impl-EPIC
- memory `project_martinet_pattern` — historical context for the pattern being retired
