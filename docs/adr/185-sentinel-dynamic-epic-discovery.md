# ADR-185: Sentinel dynamic epic-team discovery — drop the cockpit.json registration requirement

**Status**: proposed
**Date**: 2026-05-20
**Driver-ref**: 2026-05-20 driver session — operator design call following the [ADR-183](./183-sentinel-scope-includes-epic-teams.md) ship (2026-05-20 morning batch). Operator framing: *"epic-teams are dynamic. We make them and dissolve them often. They must not be in cockpit.json sessions[]; sentinel must find them at tick time."*
**Parent EPIC**: none (single follow-up Task: `t-b51f085b` filed 2026-05-20).
**Supersedes (in scope)**: [ADR-183 §D1](./183-sentinel-scope-includes-epic-teams.md) static-cockpit-roster assumption — `enabledTeams(cockpit)` walks `cockpit.json::sessions[]`, but epic-teams MUST be absent from that tree. The replacement model: sentinel discovers epic-teams at tick time. ADR-183's §Amendment 2026-05-20 already records this supersession in the supersedee.
**Cross-refs**: [ADR-183](./183-sentinel-scope-includes-epic-teams.md) (parent — sentinel scope to epic-teams), [ADR-091](./091-kanban-driven-auto-merge.md) (epic-team fan-in — proliferation source), [ADR-090](./090-epic-team-lifecycle.md) (epic-team lifecycle — `spawn-epic` / `dissolve-epic`), [ADR-132](./132-pluggable-martinet.md) (sentinel design), [ADR-181](./181-global-ram-budget-gate-on-spawn.md) (host-wide epic-team cap — the upper bound the discovery cost must fit under), [ADR-089](./089-hierarchical-cockpit.md) (recursive `sessions[]` shape — what we are explicitly NOT extending).

## Context

### Why the post-ADR-183 path is wrong even though it works

ADR-183 §D1 swapped `sentinelTick`'s source from `cockpit.teams ?? []` (parent-team-only back-compat field) to `enabledTeams(cockpit)` (post-ADR-089 flattener; both team-shape entries). That closed the silent-member-death class for epic-teams that *are* registered in `cockpit.json::sessions[]`.

The hidden assumption: epic-teams ARE registered in `cockpit.json::sessions[]`. Some of them are — the early manual-test epic-teams were hand-registered. But the steady-state pattern is they aren't:

- `atmux team spawn-epic` provisions a new cage, kanban, worktree, and tmux session, but does NOT auto-register the new epic-team in `cockpit.json::sessions[]`. The operator (or follow-up Task) is expected to register it explicitly.
- `atmux team dissolve-epic` tears down the cage + kanban + worktree, but does NOT auto-remove the cockpit.json entry. Manual cleanup, frequently skipped.
- `atmux cockpit rebuild` reconciles cockpit.json against running tmux state, sometimes adding entries, sometimes removing them — but the reconcile is parent-team-shaped, not epic-team-shaped, so epic-teams are touched inconsistently.

Result: cockpit.json drifts out of sync with disk + running tmux reality across three independent paths.

### Three drift symptoms observed

1. **Cron orphan** (auto-memory `project_epic_team_dissolve_cron_leak`, 2026-05-19) — dissolve-epic on a non-trivial cage leaves crontab blocks pointing at dead worktrees. Observed 7+ orphan blocks 2026-05-19. The atmux side has filed t-c9c86d1e + ADR-170 §Amendment for the dissolve-side fix, but the cockpit.json side still drifts on the same boundary.
2. **Sentinel gap on stale entries** — if cockpit.json lists an epic-team whose worktree is gone, `enabledTeams(cockpit)` yields a phantom team; sentinel's per-team try/catch (ADR-183 §D3) contains the observe-failure but logs an error row indefinitely until someone runs `atmux cockpit rebuild` or hand-edits.
3. **Cockpit-rebuild churn** — every rebuild reads cockpit.json + reconciles, but since epic-teams turn over faster than the rebuild cadence, the reconcile keeps adding the same kinds of entries the operator just removed.

### Why static registration is the wrong primitive for high-churn entities

Parent teams turn over rarely — operator-managed, lifecycle measured in weeks. Static registration in cockpit.json fits.

Epic-teams turn over daily — ≥13 live observed in atmux/sopx/rentx within days of ADR-091 landing; turnover rate observed ~5/day average. Static registration is fighting the rate.

The post-ADR-181 host-wide cap is 30 concurrent epic-teams. Discovery cost must fit comfortably inside the 270s W3 cadence even at the cap.

## Decision

### D1 — Sentinel discovers epic-teams at tick time

`sentinelTick` no longer relies on `cockpit.json::sessions[]` for the epic-team list. Parent teams continue to be cockpit.json-registered (low churn, operator-managed); epic-teams are enumerated dynamically each tick.

The post-discovery iteration step is unchanged — same observe → decide → apply per pane, same cockpit-tier exclusion via discriminator filter, same per-team try/catch error containment.

### D2 — Choose a single discovery mechanism (this ADR proposes A as primary)

Four candidates were considered; one is selected as the v1 mechanism. The four:

| ID | Mechanism | Cost per tick @ 30 epic-teams | Freshness | Failure mode |
|---|---|---|---|---|
| (A) | Parent `.atmux/state.db` epics table query — `SELECT id, status FROM epics WHERE status IN ('in_progress', 'review')` per parent team | ~5ms (single SQLite read × ~4 parent teams = ~20ms) | Stale by up to one task-done event — kanban-authoritative | DB unreachable → sentinel observes parent teams only that tick |
| (B) | Filesystem scan — glob `<parent-root>-epics/` or `.atmux/worktrees/e-*` | ~50ms per parent team × 4 = ~200ms | Filesystem-authoritative; matches what's on disk | Network FS / lock contention; symlink loops |
| (C) | Live tmux session enumeration — `tmux list-sessions` filtered by `atmux_<parent>__epic-` prefix per ADR-089 §F naming | ~10ms total (one tmux client call) | tmux-authoritative; matches running sessions | tmux server down → no epic-teams discovered |
| (D) | Crontab walk — `crontab -l \| grep 'atmux:team=e-'` | ~5ms (one shell call) | Cron-authoritative; matches scheduled work | Stale crontab blocks (the drift symptom this ADR is dodging) yields phantoms anyway — kicks the can |

**Primary**: (A) parent state.db epics table query. The kanban is the single source of truth for "what work exists" already (per ADR-076 + ADR-060); reading epic-team membership from the same store keeps the abstraction layer thin. Cost is well under budget. Failure mode (DB unreachable) is the rarest of the four.

**Rejected**:
- (B) filesystem scan ships the second-worst failure mode (network FS / symlink loops are nondeterministic to debug) and double the cost.
- (C) tmux enumeration ties sentinel scope to tmux availability — but the W3 sentinel is on the cockpit tmux server, not the per-team server, so it'd need a fan-out probe. Adds complexity for marginal accuracy improvement.
- (D) crontab walk kicks the drift can — orphan crontab blocks (already a known drift symptom) would yield phantom epic-teams of their own.

### D3 — `enabledTeams(cockpit)` semantics split

`enabledTeams(cockpit)` becomes parent-team-only. A sibling helper — `discoverEpicTeams()` — runs the (A) state.db query against each parent team's atmux dir. `sentinelTick` calls both and concatenates the lists.

The cockpit-tier exclusion (medic / superdriver / sentinel itself) is preserved in `enabledTeams(cockpit)` discriminator filter; epic-teams are excluded from cockpit-tier exclusion because they aren't cockpit-tier.

This split lets other callers (`pulse` / `sweep-epics` / `cockpit.rebuild`) continue using `enabledTeams(cockpit)` without inadvertently picking up dynamic-discovery epic-teams. Each call-site decides whether epic-team coverage matters — sentinel says yes, pulse + rebuild say no (rebuild is the entity that creates parent-team registration; pulse summarises operator-facing state that lives in cockpit.json).

### D4 — Cache the discovery result per tick, not across ticks

`discoverEpicTeams()` runs ONCE per `sentinelTick` invocation (not per team observation inside that tick) and returns a frozen list. No cross-tick memoisation — every tick re-discovers. The cost (~20ms total) is small enough to pay every 270s; a cross-tick cache would need invalidation when `spawn-epic` / `dissolve-epic` lands, which is a new failure surface.

### D5 — `cockpit.json::sessions[]` registration of an epic-team is a doctor probe warn

Per the ADR-183 §Amendment 2026-05-20 reviewer surface — if a future change re-registers epic-teams in `cockpit.json::sessions[]` (intentionally or by accident), the dynamic-discovery model double-counts that team (once from cockpit.json walk, once from discovery). Doctor probe `epic-team-in-cockpit-json` (P2 warn) surfaces this; resolution is to remove the cockpit.json entry. The probe lives alongside `cockpit-has-w3-sentinel` in the cockpit-tier probe class.

## Consequences

### Positive

- **Removes registration drift class.** All three drift symptoms (cron orphan, sentinel gap, rebuild churn) stop being sentinel's problem — sentinel observes only what's *actually* alive at tick time.
- **Cost stays inside budget.** ~20ms discovery + ~2s parallel observation (per the post-aec82d5 bounded concurrency cap, see below) keeps the tick under the 270s W3 cadence by 2 orders of magnitude even at 30 epic-teams.
- **Cleaner spawn-epic / dissolve-epic boundary.** `atmux team spawn-epic` no longer needs to coordinate a cockpit.json edit; `dissolve-epic` no longer needs to remove one. The two verbs become purely cage-side.

### Negative

- **Slight blast-radius increase for state.db reads.** Sentinel's fault-mode list grows by "parent state.db unreachable → that parent's epic-teams skipped this tick". The per-team try/catch (ADR-183 §D3) already contains the cost — the operator sees an error row in `atmux sentinel status` and acts. Acceptable.
- **Sibling tooling diverges slightly.** `pulse` / `sweep-epics` continue to see only parent teams from `enabledTeams(cockpit)`. If a future surface needs epic-team coverage (e.g. an aggregated cadence column across parent + epic-teams), it calls `discoverEpicTeams()` explicitly. The split is intentional, not accidental.

### Neutral

- **No schema change.** `cockpit.json` schema unchanged; the `sessions[]` field still accepts epic-team-shape entries (for back-compat with manually-registered epic-teams during the migration cycle). The doctor probe in D5 is the policy enforcement; the schema stays permissive.
- **Bounded concurrency from `aec82d5` continues to apply.** Per-tick parallelism cap N=4 is set in `sentinelTick`'s fleet-pass loop, downstream of the discovery step. Discovery feeds the queue; the cap drains it. Together they keep CPU + RAM under the 2026-05-20 operator-design-call NFR.

## Trade-offs considered

### Why not "deprecate `cockpit.json::sessions[]` entirely and discover parent teams too"

Considered. Rejected — parent teams are operator-managed (turnover measured in weeks), the registration surface IS the operator's lifecycle interface ("which teams should the cockpit show"), and removing it would force a new operator-facing config surface that's strictly less useful than what cockpit.json already provides. Dynamic discovery is correct for high-churn entities (epic-teams); registration is correct for low-churn entities (parent teams).

### Why not "make `discoverEpicTeams` opt-in via cockpit.json::sentinel.discoverEpicTeams: true"

Considered. Rejected — defaulting off perpetuates the silent-death class the ADR-183 ship was supposed to close. Opt-out is cheaper to revert than opt-in is to discover ("why isn't sentinel catching this?"). The escape hatch path is the doctor probe in D5 (operator can choose to register an epic-team in cockpit.json with full awareness that the probe will warn).

### Why not "use a long-lived in-memory cache invalidated on spawn-epic / dissolve-epic events"

Considered. Rejected — adds a new failure surface (cache invalidation correctness) and saves ~20ms per tick. Not worth it.

## Implementation plan

Single Task: `t-b51f085b` filed 2026-05-20. Scope:

1. **`src/core/sentinel-discovery.ts`** — new file. `discoverEpicTeams(cockpit, fs?, db?)` runs the (A) state.db query per parent team listed in `enabledTeams(cockpit)`. Returns `Array<EpicTeamSession>` shaped to match `enabledTeams(cockpit)` output for that subset.
2. **`src/verbs/sentinel.ts`** — `sentinelTick` calls `discoverEpicTeams()` once at top of fleet pass, concatenates with `enabledTeams(cockpit)` (parent-team-only filtered), feeds combined list into the existing parallel observation loop.
3. **`src/core/cockpit.ts`** — `enabledTeams` flattener filters out `type: "epic-team"` entries (warn-class log when found — they shouldn't be in cockpit.json anymore).
4. **`src/verbs/doctor.ts`** — new probe `epic-team-in-cockpit-json` (P2 warn) per §D5.
5. **Tests** — unit: discovery round-trips a fixture parent state.db with 3 epic-teams; sentinel tick fixture with mixed parent + epic-team coverage; doctor probe fires P2 when cockpit.json has an epic-team entry.
6. **Docs** — same-commit per CLAUDE.md: this ADR proposed → accepted on reviewer signoff; RUNBOOK-cockpit.md §7 already covers the operator-facing flow (this PR); CHANGELOG entry under [Unreleased] in the t-b51f085b commit.

## Out of scope

- **Cross-parent-team epic-team enumeration.** If epic-teams ever span parent teams (currently they don't — each epic-team is a child of exactly one parent), the discovery would need to deduplicate. Defer until a real cross-parent epic-team appears.
- **Operator surface for "show me what sentinel will tick next pass"**. `atmux sentinel status` already shows last-tick output; if operators want a pre-tick preview, file a follow-up.
- **Discovery for `pulse` / `sweep-epics`**. Their call-sites are separate per §D3; if an operator needs epic-team coverage from one of those, that's a separate ADR (not strictly a sentinel concern).
- **Cache layer.** Per §D4 explicit rejection.

## Open questions

None at write time. Mechanism (A) is the safest tradeoff; cost fits inside budget; failure mode is the rarest of the four candidates. If a future scale event (>50 concurrent epic-teams) shifts the budget, revisit with per-team timeout (`t-ccf06b97`) and/or a discovery-result cache.
