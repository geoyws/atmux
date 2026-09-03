# ADR-183: Sentinel scope includes epic-teams — silent-member-death coverage

> **⚠ SUPERSEDED by [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) — 2026-05-23. Read ADR-211 instead; this file is kept for trace only.**

**Status**: Superseded by e-be01fc89 (sentinel deleted 2026-05-23). Was: accepted 2026-05-20.
**Date**: 2026-05-20
**Driver-ref**: 2026-05-20 driver session — operator demand "fix it all, we want sentinel now" closing t-186d5910 Part C. The original implementation comment in `src/verbs/sentinel.ts:360-364` claimed epic-teams were out-of-scope per ADR-132 §"Out of scope", but ADR-132 actually only excludes cockpit-tier surfaces (medic / superdriver); the epic-team exclusion was an implementation choice that predates ADR-091 epic-team proliferation.
**Parent EPIC**: none (Task `t-186d5910` Part C — driver hotfix bundled with Parts A + D).
**Supersedes (in scope)**: `src/verbs/sentinel.ts:360-364` implementation comment claiming epic-teams are out-of-scope; no ADR clause is rescinded (ADR-132 §"Out of scope" never named epic-teams explicitly, only cockpit-tier surfaces).
**Cross-refs**: [ADR-132](./132-pluggable-martinet.SUPERSEDED.md) §D2/§D4 (sentinel design, cockpit W3, impl pluggability), [ADR-158](./158-martinet-to-sentinel-rename.SUPERSEDED.md) (martinet → sentinel rename — vocabulary only), [ADR-091](./091-kanban-driven-auto-merge.md) (epic-team lifecycle — proliferation source), [ADR-089](./089-hierarchical-cockpit.md) (recursive `sessions[]` shape — flattener lives here), [ADR-140](./140-cheap-model-first.md) (cheap-model-first — justifies extending observation surface).

## Context

### The cockpit-tier exclusion ADR-132 actually has

ADR-132 §"Out of scope" lists four exclusions:

1. Cross-model consensus
2. Hot-swap mid-run
3. Per-member Martinet
4. **Martinet observation of cockpit-tier surfaces** (medic own loop, superdriver)
5. Custom Martinet impls beyond the initial 2
6. Discord channel routing per Martinet

Item 4 is the load-bearing one. It says "Martinet observes *teams*; medic observes *the cluster including teams*". The discriminator is **cockpit-tier siblings vs work-doing units**: the sentinel doesn't watch its own peer roles (superdriver, medic, sentinel itself).

That clause has nothing to do with epic-teams. Epic-teams are work-doing units that ship code, file tasks, claim from kanban — exactly the surface ADR-132 §"Pane state observation" describes. The exclusion came from `src/verbs/sentinel.ts:360-364`:

```ts
// Only iterate top-level enabled teams. Nested epic-teams + cockpit-
// internal singletons (superdriver / medic / sentinel itself) are
// excluded — the sentinel observes work-doing teams, not its
// cockpit-tier siblings (ADR-132 §"Out of scope" — Sentinel does NOT
// observe cockpit-tier surfaces).
```

The comment conflates two distinct exclusion classes — cockpit-tier siblings (which ADR-132 *does* exclude) and nested epic-teams (which ADR-132 *does not*). The latter exclusion was the implementer's interpretive choice when ADR-091 epic-team proliferation hadn't landed yet.

### Why this matters now — silent-member-death class

`t-186d5910` filed 2026-05-19 04:14 MYT. Operator framing: *"we had a gitter dead for hours and we had no idea... or committer."* Investigation found:

- Sentinel implementation green end-to-end (`src/verbs/sentinel.ts`, `src/core/sentinel-escalation.ts`, cursor impl, full test suite)
- ~13 live epic-teams across `atmux` / `sopx` / `rentx` at the time of filing
- **Zero observation coverage** of those epic-teams — sentinel's `cockpit.teams` iteration only returns `type: "team"` entries via the back-compat synthesis
- Result: a gitter / committer dying inside an epic-team is invisible to the cockpit-tier observation loop until someone runs `atmux status` by hand or the operator notices commits aren't landing

The whole point of ADR-132 was to catch silent member death. Excluding the layer where members actually live (epic-teams ship the bulk of code post-ADR-091 atmux-team decomposition) negates the design.

### Why this ADR is small

The fix is a one-line iterator swap: `(cockpit.teams ?? []).filter((t) => t.enabled)` → `enabledTeams(cockpit)`. The flattener at `src/core/cockpit.ts:497` already returns both `type: "team"` and `type: "epic-team"` entries with `level` annotated, excludes cockpit-internal singletons (superdriver / medic / sentinel itself) by discriminator, and threads `parentRoot` so epic-team `.root` resolves to the parent team's worktree (epic-teams share parent worktree per ADR-089 §F).

The cursor-impl observe path is `tmux capture-pane`-based, identical machinery for team + epic-team panes — the exclusion was nomenclature-driven, not capability-driven.

## Decision

### D1 — Sentinel iterates both `type: "team"` and `type: "epic-team"` sessions

`sentinelTick` switches its source from `cockpit.teams` (legacy back-compat field; parent-team-only) to `enabledTeams(cockpit)` (post-ADR-089 flattener; both team-shapes). Cockpit-internal singletons remain excluded by discriminator.

Per-team `team.json::sentinel` override (ADR-132 §D6) still applies — an epic-team can opt out by setting its sentinel field once the T3 per-team read path lands. Until then, every enabled team-shape session ticks under `cockpit.defaultSentinel`.

### D2 — Out-of-scope clause from ADR-132 §"Out of scope" item 4 stays

This ADR does NOT modify ADR-132's cockpit-tier exclusion. Sentinel still does not observe medic / superdriver / sentinel itself. The flattener's discriminator filter (drops `type: "superdriver" | "medic" | "sentinel" | "superdoctor"`) preserves that boundary at the layer below.

### D3 — Error containment per epic-team, not fleet-wide

`sentinelTick` already wraps each team's `observe → decide → apply` in a try/catch (lines 391-417 pre-change; same after). An epic-team whose cage is mid-spawn (no socket yet) or mid-dissolve (worktree gone) will fail observe; the error is captured in `SentinelTeamState.error`, the fleet pass continues, and the operator sees the error in `atmux sentinel status` output.

### D4 — Doctor probe lives separately (`cockpit-has-w3-sentinel`, t-186d5910 Part D)

The doctor surface added in the same commit is **cockpit-level** (does the W3 window exist?) not **epic-team-level**. Per-epic-team liveness probes are a future ADR if the operator wants per-cage red rows when an epic-team sentinel tick fails N times. v1 ships fleet-pass containment + cron backstop visibility.

## Consequences

### Positive

- **Epic-team silent-member-death class closes** (the original operator motivation). A dead gitter / committer in an epic-team surfaces via sentinel observation within ≤270s (W3 loop cadence) or ≤5min (cron backstop), same as parent-team coverage.
- **Implementation tax: ~10 lines** — the flattener + per-team error containment were already built. The ADR is mostly cleanup of an interpretive exclusion.
- **Symmetric coverage across the team tree** — `enabledTeams(cockpit)` is the canonical walker used by `pulse` / `sweep-epics` / `cockpit.rebuild` already. Sentinel adopting it removes a shape divergence.

### Negative

- **Per-tick cost grows linearly with epic-team count.** ~13 live epic-teams + 4 parent teams = 17 teams ticking per pass vs 4 prior. Cursor impl observed at ~36s per fleet pass (5 teams) in the t-186d5910 stopgap, so ~17 teams projects to ~2min. At the 270s W3 loop cadence + 5min cron, this fits inside the budget. If epic-team count grows past ~50 (ADR-181 host-wide cap is 30 today), tick may spill past the cadence window — revisit then with per-team timeout or batching.
- **Failed observation on a transient epic-team produces a noisy `error` row** in sentinel status until the cage settles or dissolves. The try/catch contains the failure but the operator sees the noise. Acceptable for v1; revisit if dissolve-epic timing produces stale error rows that don't self-clear.

### Neutral

- **Per-team override path (T3 future work)** unchanged. Epic-teams will be able to opt out of sentinel via `team.json::sentinel: "disabled"` once T3 wires the read path, same as parent teams.
- **Cursor-agent token cost grows** proportionally with team count. Per ADR-140 cheap-model-first, this is the bargained cost — composer-2-fast at ~$0.001/observation vs Opus at ~$0.02 keeps the cumulative cost reasonable.

## Trade-offs considered

### Why not "make epic-team coverage opt-in via cockpit.json"

Considered: a `cockpit.sentinel.includeEpicTeams: false` default with explicit opt-in. Rejected — defaulting off perpetuates the silent-death class operator was burned by. Opt-out is cheaper to revert than opt-in is to discover ("why isn't sentinel catching this?").

### Why not "extend `cockpit.teams` synthesis to include epic-teams"

Considered: change the back-compat field's DFS filter to include `type: "epic-team"`. Rejected — `cockpit.teams` is documented as parent-team-only in `src/schema/cockpit.ts:540-547` and `src/core/cockpit.ts:358-367`; downstream consumers (cockpit rebuild's window provisioning at `src/verbs/cockpit.ts:1769-1771` explicitly filters epic-teams out of cockpit windows; pulse renderers) depend on that shape. Touching it cascades. The cleaner move is to have sentinel adopt `enabledTeams(cockpit)` directly — the post-ADR-089 canonical walker.

### Why not "add a separate `cockpit.sentinel.scope` setting"

Considered: schema field `cockpit.sentinel.scope: "teams" | "all"`. Rejected — adds a knob with no second use case. The four cockpit-tier exclusions remain implicit (filtered at the flattener layer); the only real toggle would be parent-team-only vs parent-plus-epic, and the answer is "parent-plus-epic always" because parent-team-only fails the silent-death class.

## Implementation plan

The fix is small enough to bundle into the t-186d5910 driver commit (no sub-EPIC). Same commit:

1. `src/verbs/sentinel.ts` — import `enabledTeams`, swap `cockpit.teams ?? []` → `enabledTeams(cockpit)`, update the comment to point to this ADR.
2. `src/verbs/doctor.ts` — Part D's `checkCockpitSentinelWindow` probe (separate from this scope change but cited as sibling in §D4).
3. Tests — `src/verbs/sentinel.test.ts` regression: a cockpit fixture with one parent team + two epic-teams ticks 3 entries; the legacy `cockpit.teams`-only path would only tick 1.

Reviewer flips this ADR proposed → accepted in the same commit per driver-hotfix carve-out (no separate reviewer round; the change is so small the doc + code review collapse).

## Out of scope

- **Per-epic-team sentinel impl override** (e.g. epic-team A on cursor, epic-team B on claude). Schema allows it already via `team.json::sentinel`; the read path is T3-future-work. v1 epic-teams inherit `cockpit.defaultSentinel` like parent teams do today.
- **Per-epic-team doctor red rows on N consecutive failed ticks**. Out of v1 — fleet-pass containment + cron-backstop log inspection is enough operator visibility for now. Revisit if epic-team observation produces persistent stale `error` rows operators can't action.
- **Sentinel observation of nested-epic-team children** (i.e. an epic-team inside an epic-team). The recursive `sessions[]` shape allows it; `enabledTeams` walks the full DFS. No additional ADR work needed — the iterator covers it by construction.
- **`atmux sentinel scope` verb** to print which teams would tick on next pass. If operators surface confusion about coverage, file a follow-up; v1 ships the read-only diagnostic via `atmux sentinel status`.

## Open questions

None at write time. The cursor-impl `observe` path is socket-discovery-only (per ADR-050 §D1 trust posture, cockpit W3 IS the Tier-2 cage; no per-team cage carve-out), and `enabledTeams` already threads `parentRoot` for epic-team `.root` resolution. If the cursor-impl turns out to need separate cage identity per epic-team for observation (e.g. SSH-into-child semantics), that's a follow-up ADR — the current cockpit-singleton design observes via the parent's tmux socket which is what epic-teams share anyway.

## Amendments

### 2026-05-20 — Dynamic-discovery model supersedes §D1 static-cockpit-roster assumption (t-1fad1f12, follow-up impl t-b51f085b)

§D1 above instructed `sentinelTick` to iterate `enabledTeams(cockpit)`, the post-ADR-089 flattener that reads cockpit.json's `sessions[]` tree. That assumes epic-teams are *registered* in `cockpit.json::sessions[]`. Operator design call 2026-05-20 reverses that assumption.

**New invariant** — epic-teams are dynamic. They are created and dissolved often (proliferation hit ~13 live across atmux / sopx / rentx within days of ADR-091 landing). They **MUST be absent** from `cockpit.json::sessions[]`. Registering them there produces drift across three independent paths:

1. **Cron orphan** — `dissolve-epic` leaves the cockpit.json entry behind if the dissolve isn't fully atomic (auto-memory `project_epic_team_dissolve_cron_leak`, 2026-05-19).
2. **Sentinel gap** — if cockpit.json gets out of sync with disk reality (epic-team worktree gone but entry still listed), sentinel observes a phantom team and logs error rows.
3. **Cockpit-rebuild churn** — `atmux cockpit rebuild` reconciles cockpit.json against running tmux state; epic-team turnover means rebuild keeps adding and removing the same kinds of entries.

**Dynamic-discovery model** — sentinel discovers epic-teams at tick time, NOT from cockpit.json registration. The candidate enumeration mechanisms (one will be chosen via [ADR-206](206-sentinel-dynamic-epic-discovery.SUPERSEDED.md)):

- (A) Parent `.atmux/state.db` epics table query — walks `epics WHERE status IN ('in_progress', 'review')` and resolves the worktree per epic-team naming convention.
- (B) Filesystem scan — `<parent-root>-epics/` or `.atmux/worktrees/e-*` glob.
- (C) Live tmux session enumeration on the parent cage — `tmux list-sessions` filtered by the `atmux_<parent>__epic-` prefix per ADR-089 §F naming.
- (D) Crontab walk — every epic-team has an `atmux:team=e-*` block; walk those.

Each candidate trades freshness against IO cost; the chosen mechanism is sized to keep sentinel tick well under the 270s W3 cadence even at ≥30 epic-teams (the ADR-181 host-wide cap).

**Bounded concurrency cap** — `sentinelTick` parallelisation via `Promise.allSettled` (per t-70c8b562) is now bounded at **N=4** concurrent observations per tick (commit `aec82d5`). The cap exists to protect CPU + RAM — the sentinel-cron backstop was removed earlier this cycle due to sustained CPU usage, and bounded concurrency is the first of the constraints folded in per the operator design call 2026-05-20 "don't spike CPU+RAM". Follow-up: per-team timeout + per-tick token budget (t-ccf06b97).

**Implication for §D1** — sentinel still iterates "enabled team-shape sessions", but the *source* of that list flips from cockpit.json walk to the dynamic-discovery mechanism. Parent teams continue to be cockpit.json-registered (low churn, operator-managed); epic-teams are discovered. The output of the iteration step is unchanged — same observe → decide → apply per pane.

**Reviewer surface** — if a future change re-registers epic-teams in `cockpit.json::sessions[]` (e.g. a fix-up Task that "fixes the missing entries"), file `atmux flag add --severity high --subject "[sentinel] epic-team registration in cockpit.json violates ADR-183 §Amendment 2026-05-20"`. The drift problem is what motivates the dynamic-discovery model; re-adding registration recreates it.

**Filed via** t-1fad1f12 (P0 docs sweep, 2026-05-20); follow-up impl Task t-b51f085b.
