# ADR-166: `team.json.autonomy` shared policy block — aggression dials read by all action-class actors

**Status**: Accepted — ratified by driver 2026-05-21 (`team.json::autonomy` shared policy block — aggression dials consumed by martinet/bruh/gitter/reviewer; rejects whip→bruh rename in favor of shared policy; §OQ recommendations as-written)
**Date**: 2026-05-16
**Author**: `whip-impl` (per `t-446cc619`, parent EPIC `t-99b85ee9` — *team.json.autonomy shared policy block — rejects whip→bruh rename*)
**Driver-ref**: 2026-05-15 19:02 MYT — operator proposed *"rename whip to bruh and merge functionalities, let team.json handle how bruh should be used (sometimes we don't want auto flip, auto accept adrs, etc)"*. Driver pushback led to the shared-policy-block reframe captured in this ADR.
**Slot-history**: originally drafted as **ADR-151** per EPIC `t-99b85ee9` planner reservation; collision detected pre-write 2026-05-16 ~22:30 MYT — `docs/adr/151-unblocker-role.md` had already shipped on `geoyws-docs-2` via sibling task `t-b0e6c4ff` (commit `fabbf30`, 2026-05-15 22:26 MYT). Driver routed re-slot to **ADR-165** 2026-05-16 22:38 MYT (`/bruh #5`); by 23:00 MYT ADR-165 had also shipped via `t-85b928a9` (atmux team config CLI, commit `7cdd886` — different topic). Applying driver/lead intent ("next clean gap") to current state — landed at **ADR-166**. Append-only convention preserved across both prior slot occupants.
**Relates**: ADR-132 (pluggable martinet — continuous observer; reads policy per `NudgeAction`), ADR-140 (cheap-model-first — where whip-equivalent observation work lives now), ADR-145 (atmux adopts gitter — `autoMerge` consumer), ADR-013 (kanban write atomicity — reviewer's existing convention layer), ADR-077 (medic — complaint-handling consumer for `autoFileFollowUps`), ADR-148 (commit-cadence — sibling team-level config block pattern). `/bruh` skill at `/root/work/journals/.sb/claude-skills/plugins/coordination/skills/bruh/SKILL.md`.

## Context

### What this ADR rejects (the rename proposal)

Operator's first framing 2026-05-15 19:02 MYT was *"rename whip to bruh and merge functionalities."* That framing collapses three orthogonal concerns into one role:

1. **`whip`** — continuous observer that fires every 5min via cron. Mostly-legacy substrate at this point: ADR-140 displaced the lead-driven continuous-observer work to cheap-model martinet (per ADR-132).
2. **`/bruh` skill** — operator-typed sweep that runs ONCE per invocation. The sweep ITSELF is the operator authorization — by typing `/bruh`, the operator has consented to whatever the skill does in that pass. Collapsing into a cron-fired loop loses that semantic.
3. **Per-team aggression dial** — how aggressive should the team's auto-decisions be? This is the actually-shared concern; orthogonal to *when* or *how* the role fires.

Renaming `whip → bruh` and merging the loops would lose the operator-authorization semantic of `/bruh` and force one-shot + continuous loops to share an invariant they don't actually share.

The reframe: the aggression-dial concern IS shared (multiple roles need it); the role mechanics are NOT. Lift the aggression dial to a **shared policy block** that every action-class actor consults; leave the role mechanics where they are.

### Why this block needs to exist

Today aggression knobs live scattered across role-specific schema blocks:

- `team.json::autoMerge` (per ADR-145) — gitter's auto-merge toggle.
- `team.json::eternalImprovement.enabled` (per ADR-149) — improvement-cycle opt-in.
- `team.json::whip` — cron cadence, budget-pause thresholds (ADR-053/054).
- `cockpit.json::defaultAutoMerge` / `defaultMedic` — fleet defaults.
- `/bruh` skill behaviour — currently hardcoded ("sweep all pending decisions, flip all flags, merge all worktrees").
- Martinet's `NudgeAction` per ADR-132 — observation pipeline aggression hardcoded.

Operators currently have NO single-source-of-truth for "how aggressive is this team allowed to be?" Each new aggression dimension (auto-approve decisions, auto-flip flags, auto-rotate stale members, auto-reanimate zombies) ships under whichever ADR introduces it, scattering operator mental model and forcing duplicate `cockpit.json` mirrors for every per-role block.

This ADR introduces ONE shared policy block consumed by ALL action-class actors. Per-role blocks remain authoritative for role-internal mechanics (cron cadence, schemas, etc.); only the **aggression dimension** centralizes.

## Decision

### D1 — Introduce `team.json.autonomy` shared policy block

A new sub-config under `team.json`, consumed by all action-class actors:

- martinet (per [ADR-132](132-pluggable-martinet.md) / [ADR-140](140-cheap-model-first.md))
- `/bruh` skill (claude-skills coordination plugin)
- gitter (per [ADR-145](145-atmux-adopts-gitter.md))
- reviewer (per [ADR-013](013-kanban-write-atomicity.md))

Each consumer reads the SAME block at decision-time; no consumer has its own private aggression toggle going forward (existing per-role aggression toggles deprecate over one release window — see D5 back-compat).

### D2 — `cockpit.json.defaultAutonomy` mirrors the same keys for fleet defaults

Sibling block under `cockpit.json` containing the SAME schema keys. Resolution order at consumer read-time:

1. `team.json::autonomy.<key>` if present → wins.
2. `cockpit.json::defaultAutonomy.<key>` if present → fallback.
3. Hard-coded schema default (all-auto-enabled per D5) → final fallback.

Per-team block wins on key conflict. This matches the existing `whip` / `medic` / `autoMerge` resolution conventions (per ADR-077 / ADR-145) — operators flexing one team's aggression without touching cockpit defaults is the common case.

### D3 — Policy block keys (proposed shape; reviewer-overridable at signoff)

```ts
team.autonomy: {
  autoMerge: 'off' | 'trunk-merge-tasks' | 'all',
  autoApproveDecisions: boolean,
  autoFlipFlags: boolean,
  autoReanimateZombies: 'off' | 'lead-only' | 'all-members',
  autoRotateMembers: 'off' | 'ctx-pressure' | 'ctx-or-stale' | 'all',
  autoFileFollowUps: boolean,
  bruhScope: 'narrow' | 'sweep',
}
```

Per-key semantics:

- **`autoMerge: 'off' | 'trunk-merge-tasks' | 'all'`** — read by gitter (per ADR-145). `'off'` = gitter refuses all auto-merges (operator-only). `'trunk-merge-tasks'` = gitter consumes auto-emitted trunk-merge Tasks per ADR-146 but refuses orphan merges. `'all'` = gitter is fully autonomous on every merge-class signal. **Default `'trunk-merge-tasks'`** per ADR-145.
- **`autoApproveDecisions: boolean`** — read by `/bruh` skill + martinet event-handler. Auto-promotes `pending-decisions.md` 🔵 entries to 🟡 after threshold age (martinet continuous) OR during `/bruh` sweep (operator-typed). Default `true`.
- **`autoFlipFlags: boolean`** — read by `/bruh` skill. Auto-flips feature flags / account-swap toggles during `/bruh` sweep when queued in `flags.md` or `.atmux/state/pending-flags.json`. Default `true`.
- **`autoReanimateZombies: 'off' | 'lead-only' | 'all-members'`** — read by `/bruh` skill (driver-actionable per skill §3.5) + martinet (continuous). On dead-pane detection: `'off'` = no auto-reanimation (operator must respawn); `'lead-only'` = lead pane re-spawned, members held; `'all-members'` = full team reanimation. Default `'all-members'`.
- **`autoRotateMembers: 'off' | 'ctx-pressure' | 'ctx-or-stale' | 'all'`** — read by martinet (per ADR-132 §classifier) + `/bruh` (cascade). Rotation triggers: `'off'` = no auto-rotate (member self-clears via `/clear`); `'ctx-pressure'` = rotate on ≥30% ctx threshold per `[[feedback_rotation_threshold_400k]]`; `'ctx-or-stale'` = also rotate on cadence-stale threshold per ADR-148; `'all'` = additionally rotate on refusal-pattern hits per ADR-139. Default `'ctx-or-stale'`.
- **`autoFileFollowUps: boolean`** — read by martinet (per ADR-077). When a complaint resolves with a preventive-ask body, martinet auto-files the ask as a Task. Default `true`.
- **`bruhScope: 'narrow' | 'sweep'`** — read by `/bruh` skill. `'narrow'` = `/bruh` sweeps ONE pending decision / flag / blocker per invocation (operator confirms each). `'sweep'` = `/bruh` sweeps EVERYTHING in one pass (current behaviour). Default `'sweep'`.

The 7-key proposed shape mirrors the EPIC body verbatim. Per T1 scope boundary, this ADR documents the proposal; reviewer-signoff settles final shape (key renames, additional knobs, narrowing/widening enums) before T2 ships the Zod schema.

### D4 — Operator override semantics: `/bruh` always sweeps regardless of policy

The autonomy block governs **automated paths only** (cron-fired loops, event-driven handlers, scheduled sweeps). Deliberate operator action SUPERSEDES — typing `/bruh` on a team with `autoApproveDecisions: false` STILL approves pending decisions DURING that sweep, because the `/bruh` invocation IS the operator's authorization.

The block's job is to govern what happens WITHOUT the operator in the loop. When the operator IS in the loop (typing a command), the block is silent.

Implementation note for `/bruh` skill: the skill MUST distinguish "I am running on operator's explicit invocation" (autonomy-block-bypass) from "I am being invoked by a sibling skill / scheduled tick" (autonomy-block-honor). The distinction is whether the invocation chain started from operator-typed text. Skill authors can capture this via environment marker (`BRUH_OPERATOR_INVOKED=1`) or argv inspection (operator-typed → no marker; sibling-invoked → marker present).

### D5 — Backward compatibility: missing block = all-auto-enabled (today's behavior preserved)

A team.json WITHOUT an `autonomy` block resolves every key to its current "all auto" default:

- `autoMerge: 'trunk-merge-tasks'` (matches today's gitter behavior per ADR-145)
- `autoApproveDecisions: true` (matches today's bruh sweep + martinet auto-promote)
- `autoFlipFlags: true` (matches today's bruh sweep)
- `autoReanimateZombies: 'all-members'` (matches today's bruh reanimation cascade)
- `autoRotateMembers: 'ctx-or-stale'` (matches today's martinet + lead rotation triggers)
- `autoFileFollowUps: true` (matches today's martinet follow-up filing)
- `bruhScope: 'sweep'` (matches today's bruh skill default)

**Migration is purely additive** — no schema bump, no data migration. Existing teams that don't add the block keep today's behavior verbatim. Teams that want to dial DOWN aggression add the block with `false` / `'off'` values per dimension.

Existing per-role aggression toggles (e.g. `team.autoMerge.enabled`, `eternalImprovement.enabled`) coexist with the new block for ONE release window. After that, per-role toggles deprecate with hard-error pointing operators at the autonomy block. The transition window gives operators time to migrate without breaking live teams.

### D6 — Consumer matrix (verbatim from EPIC body)

| Action | Read by | Fires when |
|---|---|---|
| `autoMerge` | gitter (ADR-145 worker) | policy-allowed branch becomes trunk-merge-eligible |
| `autoApproveDecisions` | bruh skill + martinet event-handler | 🔵 entry pending >Nmin (martinet) OR `/bruh` sweep (bruh) |
| `autoFlipFlags` | bruh skill | `/bruh` sweep finds queued flag toggle |
| `autoReanimateZombies` | bruh skill (driver-actionable per skill §3.5) + martinet (continuous) | dead-pane detected |
| `autoRotateMembers` | martinet (per ADR-132 §classifier) + bruh (cascade) | ctx-pressure / cadence-stale threshold |
| `autoFileFollowUps` | martinet | complaint resolved with preventive ask |
| `bruhScope` | bruh skill | operator types `/bruh` |

Reading conventions:

- **martinet** reads via the existing `team.json` load path in its observation pipeline (per ADR-132).
- **gitter** reads at sweep + on-tick (per ADR-145), shape similar to its existing `autoMerge.enabled` consumer.
- **`/bruh` skill** reads via `atmux team get autonomy.<key>` (per ADR-165 — the new `atmux team set/get/unset` CLI ships the read primitive `/bruh` consumes). Until ADR-165's T2-T6 land, `/bruh` reads `team.json` directly via `jq`.
- **reviewer** reads `autoFileFollowUps` at complaint-resolution boundary; consumes via existing `loadTeam` helper.

### D7 — Sibling config block pattern (per ADR-148 §commit-cadence)

`autonomy` joins the family of team-level config blocks alongside `whip`, `kanban`, `crons`, `epicTeam`, `cadence` (per ADR-148), `eternalImprovement` (per ADR-149). Same shape conventions:

- Schema lives in `src/schema/team.ts` as a Zod `.strict()` sub-object (drift-rejection per ADR-054).
- `.passthrough()` at the parent `Team` schema level remains intact — adding `autonomy` doesn't break unrelated fields.
- Mirror in `src/schema/cockpit.ts` for the `defaultAutonomy` fleet-default sibling.
- Default values declared at the Zod level via `.default(...)` per existing pattern (e.g. `TeamWhip.intervalMins.default(15)`); D5's all-auto-enabled posture means every key defaults to today's behavior.
- Resolver helper in `src/core/common.ts` or sibling — `resolveAutonomy(team, cockpit, key)` returns the resolved value per D2 cascade.

## Consequences

### Enables

- Per-team aggression dialing without renaming or merging existing roles (the `whip → bruh` rename is unnecessary once the shared dial exists).
- Operator self-service: `atmux team set autonomy.autoFlipFlags false` (per ADR-165's new CLI) flips one team's aggression without touching cockpit defaults or hand-editing JSON.
- Fleet-wide aggression baselines via `cockpit.json::defaultAutonomy`; per-team overrides as exceptions.
- Cleaner martinet + bruh interaction model — both read the SAME source-of-truth, eliminating "martinet auto-approved a decision the bruh skill was about to gate" race conditions.

### Does NOT cover

- **Per-member overrides** — `team.autonomy.byMember.<name>.autoRotateMembers` etc. Team-level is sufficient for v1; per-member adds schema surface area without clear demand. Deferred.
- **Time-of-day windows** — "autoMerge `off` between 22:00-06:00 MYT" etc. Cron-schedule-as-aggression-dial is a different abstraction; deferred to a future cron-aware-autonomy ADR if demand emerges.
- **Cross-team inheritance via super-driver** — fleet-wide aggression patterns shared across teams. Deferred to ADR-274 super-* hierarchy EPIC.
- **Time-bounded one-shot overrides** — "set autoMerge to `'all'` for the next 1h then revert". Operator can manually flip the value and revert; the CLI in ADR-165 makes this trivial. Cron-aware revert is out of v1.

### Rollback path

Omit the `autonomy` block from `team.json` → schema-default fills in (D5 all-auto). No code change required. Rollback is a single `atmux team unset autonomy` (once ADR-165's CLI lands) or hand-edit removing the block.

## Reuse statement (zero new abstractions)

This ADR introduces **no new abstractions**:

- **Schema**: extend existing `Team` Zod object in `src/schema/team.ts` with one new sub-block (alongside `whip`, `cadence`, `eternalImprovement`, etc.).
- **Mirror**: extend existing `Cockpit` Zod object in `src/schema/cockpit.ts` with `defaultAutonomy` (alongside `defaultEternalImprovement`, etc.).
- **Resolver**: pattern matches `resolveEternalImprovementEnabled` (per ADR-149) verbatim — same `team > cockpit > schema-default` cascade.
- **Consumers**: martinet (`src/abstractions/martinets/*.ts`), gitter (per ADR-145 existing wiring), bruh skill (skill-side `jq` read until ADR-165 CLI lands), reviewer (existing `loadTeam` helper).
- **CLI surface**: reuse ADR-165's `atmux team set autonomy.<key> <value>` verb — no new verb namespace.

The whole ADR is plumbing on top of existing abstractions. The decision IS the schema shape; everything else is mechanical wiring.

## Cross-references

- **[ADR-013](013-kanban-write-atomicity.md)** — reviewer's existing convention layer. `autoFileFollowUps` consumer.
- **[ADR-077](077-superdoctor-cockpit-role.md)** — medic (formerly superdoctor; renamed per ADR-133). Complaint-handling lives here; `autoFileFollowUps` fires martinet's preventive-ask filing path.
- **[ADR-132](132-pluggable-martinet.md)** — martinet continuous observer. Reads policy per `NudgeAction`.
- **[ADR-140](140-cheap-model-first.md)** — where whip-equivalent observation work lives now (martinet via cursor composer-2-fast). Frames why the `whip → bruh` rename is unnecessary.
- **[ADR-145](145-atmux-adopts-gitter.md)** — gitter `autoMerge` consumer; this ADR generalizes the per-role `autoMerge.enabled` toggle into the shared autonomy block.
- **[ADR-148](148-commit-cadence-truth-signal.md)** — sibling team.json config block pattern. Confirms the schema shape.
- **[ADR-165](165-atmux-team-config-cli.md)** — CLI surface for editing `team.json` (incl. the new `autonomy` block). `/bruh` skill's `autonomy.<key>` read path consumes this verb once shipped.
- **`/bruh` skill** at `/root/work/journals/.sb/claude-skills/plugins/coordination/skills/bruh/SKILL.md` — operator-typed sweep skill. Defining property: "the sweep itself is the operator authorization."
- **driver-ref**: 2026-05-15 19:02 MYT (rename proposal) + 2026-05-16 22:38 MYT (`/bruh #5` re-slot decision).

## Implementation plan

T1 (this ADR) ships the spec ONLY. Execution slices file separately per the parent EPIC's decomp:

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-166 (this ADR) | — | docs |
| T2 | Schema impl — `TeamAutonomy` + `CockpitDefaultAutonomy` Zod blocks in `src/schema/team.ts` + `src/schema/cockpit.ts`; `resolveAutonomy(team, cockpit, key)` helper in `src/core/common.ts`; same-commit unit tests | T1 | be |
| T3 | Consumer wiring — gitter reads `autoMerge`; martinet reads `autoApproveDecisions` / `autoRotateMembers` / `autoFileFollowUps`; reviewer reads `autoFileFollowUps`; same-commit unit tests | T1, T2 | be |
| T4 | `/bruh` skill update — reads `autonomy.<key>` via `atmux team get` (once ADR-165 T3 ships) or fallback `jq` until then; handles `'narrow'` vs `'sweep'` scope; D4 operator-bypass semantic | T1, T2, ADR-165 T3 | docs |
| T5 | Same-commit doc sweep — `templates/briefs/lead.md` (autonomy-aware nudge wording), `docs/PRD.md` (config-surface index), `CHANGELOG.md` (`📋 Proposed` row migrates to `🟢 Shipped` at T6 close) | T1 | docs |
| T6 | e2e — synthetic team with `autonomy: { autoMerge: 'off' }` (gitter refuses); with `autoApproveDecisions: false` (martinet doesn't promote; `/bruh` operator-bypass STILL promotes); with default-omit-block (all-auto preserved) | T2, T3, T4 | test |

Sub-task filing per `[[feedback_decomp_same_session_with_deps]]` — left to a follow-up session per the planner-routed convention (T1 ships ADR-draft only; sub-task filing is parent EPIC's responsibility per Task body's "T1 ships ADR file ONLY" boundary).

## Acceptance gates (T1 only)

- [x] `docs/adr/166-team-autonomy-policy.md` exists with `Status: proposed`.
- [x] Pre-flight verify cited (`git log --all -- 'docs/adr/166-*'` empty; ADR-165 just shipped by parallel sibling at commit `7cdd886`; ADR-164 by `3b23687` planner sync-claude-team-json; resolved 166 as next-clean per driver's `/bruh #5` 22:38 MYT decision intent).
- [x] All 7 §Decision-anchors land as numbered prose lines.
- [x] Consumer matrix table preserved verbatim from EPIC body (7 rows).
- [x] Cross-refs to ADR-013 / ADR-077 / ADR-132 / ADR-140 / ADR-145 / ADR-148 + ADR-165 (CLI-surface dep).
- [x] §Reuse statement explicit on "zero new abstractions".
- [x] Backward-compat posture stated (D5 — missing block = all-auto, no migration).
- [x] §Consequences §Enables / §Does NOT cover / §Rollback all present.
- [x] §Out-of-scope explicit on per-member / time-of-day / cross-team inheritance / time-bounded overrides.
- [ ] Single commit; reviewer-gated; reviewer flips Status proposed → accepted in subsequent commit post-T6 ship.

T2-T6 acceptance gates are out of T1's scope per the EPIC body's explicit boundary.

## Out of scope

- **Per-member aggression overrides** (`autonomy.byMember.<name>.…`).
- **Time-of-day aggression windows** (cron-aware autonomy block).
- **Cross-team inheritance via super-driver** — ADR-274 super-* hierarchy concern.
- **Time-bounded one-shot overrides** ("set X to Y for 1h then revert").
- **Schema impl** (T2 — `src/schema/team.ts` + `src/schema/cockpit.ts` field additions + resolver).
- **Consumer wiring** (T3 — gitter / martinet / reviewer / `/bruh` skill).
- **e2e** (T6 — 3-state synthetic team across all-auto / dialed-down / operator-bypass).
- **Per-role toggle deprecation removal** — D5 names a one-release coexistence window; the removal commit is a separate Task post-window.
