# ADR-212: Retire Medic role — lead-gated rotation pattern; fold ADR-211's 4-EPIC sentinel-split back into one watchdogs EPIC (simplification pass)

**Status**: Accepted — ratified by driver 2026-05-21 (Medic role retires at cockpit W2; ADR-077 probe substrate library `src/core/doctor-class.ts` + doctor probe registry PERSISTS — only the cockpit-tier scheduled-tick role removed; canonical §D2 lead-gated destructive action pattern Honker→tell-lead→Claude-judges→atmux-verb-executes — same pattern used by ADR-211/213/214 retirements; §D3 three-layer Honker detection model (writer-emits + watchdog-scheduler + cron-threshold-probe) zero idle cost; §D4 collapses ADR-211's 4-EPIC sentinel-split into 1 unified e-honker-observation-watchdogs absorbing sentinel+medic+ombudsman functions; §D5 sequencing — medic retires LAST after substrate ≥30 days observed-stable across jury+gitter consumers; §D6 single doctor probe medic-config-residue merges with sentinel residue probe in cleanup-EPIC; §D7 context-pct enrichment of every rotation-candidate event using existing measure-context.sh + ${HOME}/.claude/teams/${TEAM}/member-context/${MEMBER}.json infrastructure — thresholds 60% LOW / 75% MED / 85% HIGH per memory feedback_rotation_threshold_400k; §OQ recommendations as-written)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator — *"let's do lead gated and retire medic (atmux is getting too complex and we need to simplify)"* — after ADR-211 (sentinel retired) split sentinel into 4 EPICs. Operator's simplification directive triggers a re-fold + medic retirement on the same architectural grounds.
**Supersedes (in scope)**: [ADR-077](077-superdoctor-cockpit-role.md) §"Doctor stays shared infra" — medic role at cockpit W2 retires. ADR-077 §"Doctor as probe substrate" stays — `src/core/doctor-*` libraries persist; only the cockpit-tier scheduled-tick role is removed. [ADR-133](133-medic-rename.md) (rename only — terminology stays as historical). Also **amends** [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) §D2 + [ADR-202](202-honker-in-db-messaging-substrate.md) §D12: collapse the 4 sentinel-split EPICs back into one absorbed-by-watchdogs EPIC per operator's "simplify" directive.
**Cross-refs**: [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) (sentinel retired — sibling decision; same lead-gated pattern), [ADR-202](202-honker-in-db-messaging-substrate.md) §D12 (consumer EPIC sequence — amended), [ADR-143](143-external-lead-rotation.SUPERSEDED.md) (lead-rotation verb — reused by lead-gated consumer), [ADR-077](077-superdoctor-cockpit-role.md) (medic role being retired), [ADR-131](131-superdoctor-kanban-hygiene.md) (hygiene fingerprints — eventize into `hygiene.violated` per ADR-203), memory `feedback_opus_all_for_agile_flow` (operator stance refreshed 2026-05-21).

## Context

ADR-211 retired sentinel and split its functions into 4 new EPICs (pane-classifier, wedge-clearer, refusal-handler, silent-team-detector). Operator's reaction 2026-05-21: *"atmux is getting too complex and we need to simplify"*. This ADR addresses both the simplification ask AND the medic-retirement question on the same architectural grounds as ADR-211.

The pattern that makes both retirements safe is **lead-gated execution**: Honker handles cheap mechanical detection, the lead's Claude handles judgment-class decisions (including destructive ones like rotation). The cursor sentinel failure mode (autonomous rotation killing operator's TUIs) is closed by putting Claude judgment in the loop.

## Decision

### D1 — Retire the Medic role at cockpit W2

No production atmux configuration ships a Medic impl. Same shape as ADR-211 §D1 for sentinel:

- `~/.atmux/cockpit.json::medic` schema field stays for one release back-compat; runtime ignores it.
- `src/verbs/medic.ts` + `src/core/superdoctor-*` cron-tick path deleted in cleanup-EPIC.
- W2 cockpit slot becomes vacant.
- ADR-077's **probe substrate library** (`src/core/doctor-class.ts`, doctor probe registry) PERSISTS — those are reusable infrastructure. Only the cockpit-tier scheduled-tick role is removed.

### D2 — Lead-gated destructive action pattern (canonical for Honker era)

```
Honker watchdog/event detects condition
  → emit `<class>.<action-needed>` event       (e.g. lead.uptime-exceeded, member.stalled, hygiene.violated)
  → consumer writes to lead's driver-inbox
  → consumer sends-keys nudge to lead's pane
  → Lead's Claude reads + decides
       → "ignore — false alarm / context-dependent" → no action
       → "act — rotate / clear / fix" → lead runs atmux verb (`atmux rotate <m>`, `atmux clear <m>`, etc.)
       → "escalate — needs operator" → lead emits `*.escalated` → operator driver-inbox + Discord ping
```

**The detection is automated (1ms latency); the destructive execution is gated by Claude lead's reasoning.** Closes the cursor sentinel failure class (autonomous low-quality LLM making high-stakes calls) without removing the responsiveness.

Operator-gated as the second escalation tier: when lead emits `*.escalated`, operator gets the structured prompt via driver-inbox + Discord ping; operator runs the verb manually. Used for irreversible / cross-team-impact actions (e.g. dissolving an epic, pushing a branch fix).

### D3 — How Honker detects: three layers, no continuous observation

| Detection class | Mechanism | Cost |
|---|---|---|
| State-change (DB write) | Writer emits in same transaction; Honker NOTIFY ~1ms p50 cross-process | 0 idle (subscribers sleep) |
| Absence | Watchdog scheduler — schedule timer on event X; cancel on followup event Y; fire on timeout | 0 idle (timer wakes when due) |
| External state | Cron probe (irreducible — data not in DB); maintains last-known state; emits event only on transition | Cron cost (already in budget); subscribers pay only per transition |

The architectural win is "zero idle cost" — sentinel + medic both cost LLM-API per tick even when nothing was happening. Honker consumers cost only when a real signal fires.

### D4 — Amend ADR-211 §D2 + ADR-202 §D12: collapse sentinel-split EPICs back into one watchdogs EPIC

ADR-211 §D2 split sentinel into 4 EPICs (pane-classifier, wedge-clearer, refusal-handler, silent-team-detector). Per operator's simplify directive, fold these back. The unified EPIC `e-honker-observation-watchdogs` absorbs:

- All ADR-211 §D2 sentinel functions (pane-classify on event-trigger + wedge-clearer + refusal-handler + silent-team-detector)
- The original ADR-202 §D12 `e-honker-watchdogs` scope (absence-detection for stall / wedge / lead-unresponsive)
- Lead-rotation watchdog + lead-gated execution per §D2 of THIS ADR
- Medic's hygiene-fingerprint + complaint-handling consumer surface (replaces medic functions)

**Revised ADR-202 §D12 sequence — 5 consumer EPICs after substrate (down from 10 in the ADR-211 amendment):**

| EPIC | Scope |
|---|---|
| e-honker-substrate | Phase-1 shipped (commit `a8875cb..ef22584`) |
| e-honker-jury | First real consumer (spawned 2026-05-21 as e-5a5110d0, soft-stopped) |
| e-honker-gitter | gitter listens for `task.done` → merge |
| e-honker-observation-watchdogs | **Absorbs sentinel + medic functions** — pane-classifier (event-triggered) + wedge-clearer + refusal-handler + silent-team-detector + lead-uptime-watchdog + member-stall-watchdog + hygiene-violation-handler. Lead-gated for all destructive actions per §D2. |
| e-honker-whip | `/whip run` becomes event-consumer; deprecation grace one release |
| e-honker-cleanup | Delete sentinel.ts + sentinels/*.ts + sentinel verb + medic verb + superdoctor-* core libs (probe-class registry stays) + cron-backstops ≥30 days stable + ADR-091/134/145 §Amendments + ADR-211 §D3 reviewer-surface entries (now redundant) |

**Net effect of this ADR:** 11 EPICs total (was 10 with ADR-211, was 8 in original ADR-202 §D12). Sentinel + medic split-and-distribute work collapses into one EPIC; jury + gitter + whip + cleanup are unchanged. **Simpler than ADR-211's count.**

### D5 — Sequencing: medic retires LAST

Medic stays running during the Honker rollout to act as the safety net. Once `e-honker-observation-watchdogs` ships + runs stable ≥30 days, medic retires in `e-honker-cleanup`. No "medic disabled but config-readable" intermediate state — the cutover is sharp at the cleanup-EPIC mark.

Until then:
- Medic continues its hourly tick (with Opus backend — operator's choice per `feedback_opus_all_for_agile_flow`)
- Honker watchdogs ship event-driven alternatives in parallel
- Operator observes which catches problems faster; if Honker observed-stable for 30 days, medic retires; if not, freeze + reconsider

### D6 — Doctor probe (single, narrow)

One probe row `medic-config-residue` (yellow → red post-cleanup-EPIC) when `cockpit.json::medic` is non-null after the e-honker-cleanup EPIC ships. Hint: per ADR-212, medic retired — set field to null.

No separate sentinel-config-residue probe needed (ADR-211 already specifies one). The two probes merge in cleanup-EPIC.

### D7 — Context-pct enrichment of rotation-candidate events

Every rotation-candidate event emitted by `e-honker-observation-watchdogs` (lead-uptime-exceeded, task-stalled, refusal-detected, pane-wedged) is **enriched with the candidate member's current context-pct + staleness** before the consumer writes the lead's driver-inbox entry. The lead reads one structured entry with full picture instead of cross-checking sources.

**Substrate already exists** — no new measurement code:

- `measure-context.sh` (`/root/work/journals/.sb/claude-skills/plugins/coordination/skills/whip/scripts/measure-context.sh`) runs from each member's idle-hook (post-turn, pre-wait), parses `↑ Nk ↓ Mk tokens` from Claude Code status line, atomic-writes `${HOME}/.claude/teams/${TEAM}/member-context/${MEMBER}.json` per ADR convention. Operator-managed dotfile, not in atmux repo.
- `src/verbs/status.ts:127` already reads `contextPct` + `contextTs` for the `ctx %` column with stale detection at 2× whip cadence.

**New code in this EPIC** — single reader + enrichment hook:

```ts
// src/abstractions/member-context.ts (~50 lines)
export interface MemberContextReading {
  pct: number;       // 0-100; 70+ = rotation-recommended on 1M-context Opus per
                     // feedback_rotation_threshold_400k (30% remaining trigger)
  ts: number;        // epoch seconds when measure-context.sh wrote the JSON
  stale: boolean;    // true if ts older than 2× whip cadence
}
export async function readMemberContext(
  atmuxDir: string, team: string, member: string, whipCadenceMin = 5,
): Promise<MemberContextReading | null>;
```

Consumer code reads this for every rotation-candidate event + attaches to the driver-inbox entry payload. Example enriched entries the lead sees:

```
[uptime-exceeded] lead has been running 65 min — ctx 78%, 4 commits @ 12/8/15/9 min apart
[task-stalled]   be-1 stalled on t-abcd1234 — ctx 92% (HIGH — rotation strongly recommended)
[refusal-detected] fe-2 hit refusal #3 — ctx 41% (low — try clearing first)
```

**Context-pct as a standalone trigger** (no-rotation-candidate-but-high-context case) is **deferred** — start with enrichment-only. If observed behavior shows quiet-high-context members slipping past, add a `member.context-high` watchdog in a follow-up commit (still inside this same EPIC's scope).

Per memory `feedback_rotation_threshold_400k`: threshold = 70% used (30% remaining) on 1M-context Opus. Threshold ≥ 60% = `LOW — consider clearing`; ≥ 75% = `MED — rotation recommended`; ≥ 85% = `HIGH — rotation strongly recommended`. Rendered as the suffix on the inbox entry.

Stale + absent readings — both render as `ctx ?? (stale)` / `ctx ?? (no signal)` — lead handles like any other absent signal (decision goes through without the context boost, lead infers from pane glyph).

## Consequences

**Becomes easier:**

- One fewer continuous cockpit role (medic) — simpler cockpit topology
- One fewer Opus subscription line item (medic was Opus + xhigh)
- Sentinel + medic absorbed into ONE EPIC instead of 5 separate ones — simpler migration plan
- Lead-gated pattern reusable beyond rotation (clear-member, push-fix, dissolve-epic candidates)
- ADR-077 probe substrate kept — no library rewrite

**Becomes harder:**

- Lead's Claude consumes more events (becomes a busier pane). Mitigation: lead's brief grows a §"Honker event handling" section documenting the consume-or-dismiss patterns.
- The simplification is real but commits to a specific architecture — re-adding sentinel or medic post-retirement requires a new ADR + impl-EPIC.
- Cross-team fleet correlation (medic's bonus function — "all 3 teams stalled → infrastructure issue") becomes the lead's responsibility per-team. No fleet-level actor. Mitigation: `coordination:bau` operator-driven sweep covers fleet-scope at slower cadence.

**Risks + mitigations:**

- **Risk**: Lead's pane gets overwhelmed by Honker-event traffic. **Mitigation**: rate-limit + dedup at the consumer (one event per condition-class per N min); lead's brief documents triage; if pane wedges from volume, operator caps the volume via consumer config.
- **Risk**: Honker fails to detect what medic catches today. **Mitigation**: D5 sequencing — medic runs as safety net during the rollout; cutover only after 30 days observed-stable.
- **Risk**: Lead-gated rotation is too slow (Claude turn takes seconds vs medic's seconds-to-execute). **Mitigation**: most rotation conditions aren't urgent (uptime-exceeded is hours of context); the few that are urgent (member-stalled-blocking-others) can escalate to operator-gated tier per §D2.

## Out of scope (deferred)

- **W1 / W2 / W3 cockpit slot repurposing** — freed slots stay vacant. Future ADR may claim them.
- **Cross-team fleet-watcher EPIC** — explicitly NOT added per simplify directive. `coordination:bau` covers the operator-driven equivalent.
- **Lead's brief amendments documenting Honker-event triage** — deferred to e-honker-observation-watchdogs impl-EPIC.
- **Re-adding either sentinel or medic backend later** — possible via new ADR + impl-EPIC. Probe substrate (ADR-077) preserved so a re-add is additive.

## References

- ADR-211 — sentinel retirement (sibling decision; same lead-gated pattern)
- ADR-202 §D12 — Honker substrate consumer EPIC sequence (amended per §D4)
- ADR-077 — cockpit superdoctor (probe substrate stays; cockpit-tier role retires)
- ADR-133 — superdoctor → medic rename (terminology stays as historical)
- ADR-131 — hygiene fingerprints (eventize into `hygiene.violated` per ADR-203)
- ADR-143 — check-lead-rotate verb (reused by lead-gated consumer)
- memory `feedback_opus_all_for_agile_flow` — operator stance reaffirmation 2026-05-21
- memory `project_honker_pubsub_rehaul_design` — design state, needs simplify-pass annotation in impl-EPIC
