# ADR-185: Sentinel scope extension to epic-teams — supersedes ADR-132/158 §Out of scope

**Status**: proposed
**Date**: 2026-05-19
**Driver-ref**: driver-inbox P0 2026-05-19 04:10 MYT — "gitter dead for hours and we had no idea". EPIC `e-f2d7c7a5` (sentinel-deploy) Part C `t-c97f585a`. Lead confirmed ADR number 182 in turn 2026-05-19 14:44 MYT (implicit confirmation via "178 + planner sidebar reservations" framing).
**Supersedes**: ADR-132 §"Out of scope" + ADR-158 §rename-preserves-design — the explicit epic-team carveout at `src/verbs/sentinel.ts:360-364`. Design substrate (observe → decide → apply loop) unchanged; **scope-set widened**.
**Relates**: ADR-090 (epic-team lifecycle — produces the cages this ADR observes), ADR-132/158 (sentinel substrate this ADR extends), ADR-135 (cockpit window naming — `_sentinel` _-prefix), ADR-140 (cheap-model-first — sentinel keeps cursor `composer-2-fast` impl), ADR-184 (host-cap registry — sentinel reads same epic-team set), ADR-167 (cockpit rotate — sentinel may fire rotate per scope-widened policy).

## Context

ADR-132 §"Out of scope" (preserved verbatim through the ADR-158 rename) carved out epic-teams from sentinel's observation set:

```ts
// src/verbs/sentinel.ts:360-364
// Only iterate top-level enabled teams. Nested epic-teams + cockpit-
// internal singletons (superdriver / medic / sentinel itself) are
// excluded — the sentinel observes work-doing teams, not its
// cockpit-tier siblings (ADR-132 §"Out of scope").
```

The rationale at the time of ADR-132 was scope-conservatism — sentinel was new infra; epic-team lifecycle (ADR-090) was concurrent in-flight; the carveout deferred the multiplicative observation cost until the parent-team observation loop proved stable.

That conservatism is now load-bearing the wrong way:

- 2026-05-19 driver finding: a gitter was silently dead for hours. Sentinel was the substrate designed to catch this — but the dead gitter sat inside a parent team that WAS observable, so the silence was actually a separate gap (the sentinel never deployed; covered by `e-f2d7c7a5` Part A). Investigation surfaced the related gap: epic-team members CAN ALSO die silently, and there is **no liveness watcher** at the epic-team layer.
- ADR-184 brings ≤ host-cap=8 concurrent epic-teams as steady-state. Each holds a tmux cage with N member panes. Without sentinel coverage, every epic-team member-pane is a silent-death hole.
- e-db13ac01 Part C (orphan-cron reaper) addresses the cron-side residue of dissolved epic-teams; the live-side observability gap is this ADR's surface.
- Cheap-model-first (ADR-140) makes the extra cost minimal: sentinel uses cursor `composer-2-fast`, not Claude. Per-tick budget on a 13-epic-team observation set is well within current cadence.

The carveout is no longer defensible. This ADR supersedes it.

## Decision

### Scope-widening

Sentinel's per-tick observation walks **both top-level teams AND nested epic-teams**:

```ts
// src/verbs/sentinel.ts — new observation loop (post-ADR-185)
const cockpit = readCockpit();
for (const parent of cockpit.sessions) {
  if (!parent.enabled) continue;
  await observeTeam(parent);
  for (const epic of parent.sessions ?? []) {           // NEW — was skipped
    if (!epic.enabled) continue;
    if (epic.team?.sentinel?.enabled === false) continue;  // per-epic-team opt-out
    await observeTeam(epic);
  }
}
```

`cockpit.sessions[].sessions[]` is the canonical nested-epic-team registry (per ADR-089/090). `epic.team.sentinel.enabled` is the per-epic-team override — operators can opt a specific epic-team out without amending cockpit.json (e.g., a research epic-team that's expected to be pane-idle for long stretches).

### Preserved exclusions

The following stay excluded — the carveout for cockpit-internal singletons is unchanged:

- `_superdriver` (W1)
- `_medic` (W2)
- `_sentinel` (W3) — sentinel does not observe itself; sentinel-health is a doctor-probe concern per `e-b54050b6` Part A (`sentinel-state-fresh` probe).

Per-team `team.json::sentinel = { enabled: false }` continues to honor opt-out for legitimate observability-free teams (research / dormant parking-lot teams).

### Decision-action mapping for epic-team observations

Same observe → decide → apply loop as parent teams. Per-cage decisions extend with:

| Observed | Sentinel verdict | Apply action |
|---|---|---|
| All member panes alive + recent activity | `healthy` | no-op |
| One member pane dead | `member-dead` | escalate to claude-lead per ADR-132 §D1 |
| ALL member panes dead | `cage-dead` | escalate to claude-lead `[epic-team-cage-dead]` template; suggest `atmux team dissolve-epic <eid>` |
| Worktree directory missing | `cage-orphan` | escalate to claude-lead; cross-link to `e-db13ac01` Part C orphan-cron reaper |
| Rate-limit refusal patterns | `refusal` | per ADR-139 refusal-detection — same as parent-team flow |
| Modal-soup stuck | `modal-stuck` | per ADR-142 modal-cycling-detector — same as parent-team flow |

The `cage-orphan` verdict is new — peculiar to epic-teams (parent teams never have a missing worktree under steady state). It overlaps with `e-db13ac01` Part C (orphan-cron reaper) but the orphan reaper is cron-side cleanup; the sentinel surface is the operator notice. Both fire; they answer different questions.

### Cross-tier cron / cockpit interaction

No new cron entries. Sentinel's existing tick cadence (270s W3-loop + */5 cron backstop per `e-f2d7c7a5` Parts A+B) covers epic-teams at the same cadence as parent teams. The per-tick cost grows linearly with `parentCount + epicTeamCount` — observed ~13 today; ≤ host-cap=8 (ADR-184) bounds the upper limit.

### Discord templates

New per-EPIC `[epic-team-cage-dead]` template fires once per `cage-dead` verdict transition (rate-limited 1/24h per epicId). New `[epic-team-member-dead]` template fires per `member-dead` verdict (rate-limited 1/hour per `<epicId>:<member>` pair). Both route to the **parent team's** Discord channel (NOT a separate epic-team channel) — operators monitor parent channels; doubling Discord surface area is anti-noise.

## Consequences

| Lane | What changes |
|---|---|
| **be** | `src/verbs/sentinel.ts:360-364` — replace early-skip with nested iteration; thread per-epic-team opt-out check. ~15-25 LOC. |
| **be** | New verdict cases (`cage-dead`, `cage-orphan`) in `src/core/sentinel-decision.ts` (or equivalent decision module). ~30-50 LOC. |
| **be** | New Discord templates `[epic-team-cage-dead]` + `[epic-team-member-dead]` in `src/abstractions/discord.ts`. ~20 LOC + tests. |
| **test** | Unit tests for nested iteration + per-epic-team opt-out + new verdicts + Discord rate-limit. Integration test exercising synthetic dead epic-team member end-to-end. |
| **docs** | `templates/briefs/sentinel.md` (or skill prompt) — scope-widened iteration documented. Same brief update fired in `e-f2d7c7a5` Part F. |
| **db** | None — no schema change. Cockpit.json shape unchanged. |
| **ops** | None — no new cron line. Existing sentinel cron + W3-loop cover the widened scope. |

**Forward enablement**: `e-b54050b6` Part B (sentinel observe-pass invokes runDoctor) automatically gets epic-team coverage because the iteration is widened upstream. No additional wiring at the doctor-bridge layer.

**Rollback**: revert the `src/verbs/sentinel.ts:360-364` change OR set `team.json::sentinel.enabled = false` on every epic-team. Per-epic-team opt-out gives operators a non-binary escape hatch.

## Open questions

1. **OQ1 — Per-epic-team opt-out: team.json::sentinel.enabled or a new field?**
   - Default: **reuse the existing `team.json::sentinel.enabled` field** (it's already the per-team override at the parent layer). Adds zero schema surface. Per-epic-team team.json is auto-generated from parent team.json by `spawn-epic` (per ADR-090), so the override propagates naturally; operators can override in the epic-team's own team.json post-spawn.
   - Reversibility: low.

2. **OQ2 — Discord channel routing — parent team's channel, or new per-epic-team channel?**
   - Default: **parent team's channel**. Operators monitor parent channels; doubling Discord surface area for transient epic-teams is anti-noise. If a long-lived epic-team really wants its own channel, override via `team.json::discord.channel` in the epic-team's own team.json.
   - Reversibility: low — opt-in override.

3. **OQ3 — Cage-orphan overlap with e-db13ac01 Part C orphan-cron reaper — both fire on the same orphan, or coordinate?**
   - Default: **both fire — they surface different things**. The orphan-cron reaper REMOVES the dead cron block (cron-side residue); the sentinel `cage-orphan` verdict NOTIFIES the operator (real-time visibility). No coordination needed; both are idempotent.
   - Reversibility: low.

4. **OQ4 — Rate-limit on `[epic-team-cage-dead]` — 1/24h per epicId or per epic-team-lifetime?**
   - Default: **1/24h per epicId**. A cage can be dead, get restarted by an operator (cron-revive or `atmux team spawn-epic` re-fire on same eid), then die again. Per-lifetime rate-limit would miss the re-death. 24h is long enough to dedupe noise + short enough to re-surface persistent issues.
   - Reversibility: low.

5. **OQ5 — Should sentinel observe-pass also call `host-audit` (ADR-184) for dormancy detection?**
   - Default: **NO** — host-audit is its own cron-driven verb at host-tier. Folding it into sentinel observe-pass conflates fleet-tier observability with per-team observability. The two surfaces share signals (heartbeat mtime) but answer different questions (live dead vs dormant-but-alive). Keep separate.
   - Reversibility: low — fold later if operators want unified surface.

## Sub-tasks

Already filed under `e-f2d7c7a5` Part C — see `t-c97f585a`. This ADR is the doc deliverable that Task ships; impl is the iteration update + verdict cases + Discord templates documented in §Consequences.

## Acceptance

- [ ] ADR-185 file lands at `docs/adr/185-sentinel-epic-team-scope-extension.md`.
- [ ] `src/verbs/sentinel.ts:360-364` replaced with nested iteration + per-epic-team opt-out check.
- [ ] `cage-dead` + `cage-orphan` + `member-dead` verdicts implemented.
- [ ] Two new Discord templates with documented rate-limits.
- [ ] Synthetic e2e: dead epic-team member detected within 270s + escalated; dead epic-team cage detected + `[epic-team-cage-dead]` fires.
- [ ] Reviewer signs off; ADR-132/158 §"Out of scope" annotated as superseded by this ADR (append-only annotation per ADR-writeflow discipline).

## Out of scope

- Cockpit-internal singletons (`_superdriver` / `_medic` / `_sentinel`) — stay excluded.
- Per-epic-team dedicated Discord channel routing (deferred; opt-in via `team.json::discord.channel`).
- Auto-dissolve on `cage-dead` verdict (operator-gated; sentinel only notifies, never auto-destroys per ADR-140 §judgment-stays-with-claude).
- Sentinel observing itself (W3) — doctor probe class (`e-b54050b6` Part A `sentinel-state-fresh`) is the right surface.

## Cross-refs

- ADR-090 (epic-team lifecycle — produces the cages this ADR observes).
- ADR-132 (sentinel substrate — §"Out of scope" superseded).
- ADR-135 (cockpit window naming — `_sentinel` prefix).
- ADR-139 (refusal-pattern detection — reused for epic-team panes).
- ADR-140 (cheap-model-first — sentinel cursor impl applies to widened scope).
- ADR-142 (modal-cycling-detector — reused for epic-team panes).
- ADR-158 (sentinel rename — preserved-design ADR; this ADR widens scope under the new role-type name).
- ADR-184 (host-cap registry — bounds the upper limit of epic-team observation set).
- ADR-167 (cockpit rotate — sentinel may fire rotate on epic-team verdicts).
- `e-f2d7c7a5` (sentinel-deploy EPIC — Part C is this ADR's impl substrate; Parts A+B+D wire the deploy that gives this ADR runtime presence).
- `e-db13ac01` (dissolve-cron-leak — Part C orphan-cron reaper coordinates with `cage-orphan` verdict).
- `e-b54050b6` Part B (deploy-completeness sentinel observe-pass — automatically inherits widened scope post-ADR-185).
- Driver-inbox 2026-05-19 04:10 MYT (origin).
