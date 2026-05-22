# ADR-199: Claude account pool for epic-team spawning — least-loaded selection from a configured pool, replacing manual per-spawn assignment

**Status**: proposed (deferred: gated on Honker substrate ADR + impl)
**Date**: 2026-05-20
**Driver-ref**: 2026-05-20 evening design session — operator request "we also need a feature to be able to spawn epic-teams from a pool of claude accounts" + "gate it after our honker implementation"
**Cross-refs**: [ADR-033](033-kanban-driver-only-flag.md) (driver-scope-only flag — pool config follows this scope), [ADR-091](091-kanban-driven-auto-merge.md) (epic-spawn / spawn-epic verb surface that this extends), [ADR-140](140-cheap-model-first.md) (motivation overlap — observation-loop Claude-burn reduction; pool reduces per-team rate-limit blast), Honker-substrate ADR (TBD — forward-ref for budget-event subscription path), memory `feedback_spawn_epic_claude_account_inheritance_gap` (the 401-on-spawn manual recovery dance this resolves), memory `feedback_spawn_epic_requires_driver_scope` (spawn-epic itself is driver-scope-only — pool mutations inherit), memory `project_spawn_epic_claude_account_pool` (design state).

## Context

`atmux team spawn-epic <eid>` provisions an ephemeral epic-team (per ADR-091) with its own cage, worktree, kanban DB, and tmux session. Each member in the spawned team needs a `claudeAccount` field on its roster entry — without one, the cage spawn 401s at the first Claude API call.

Today there is **no inheritance and no pool**:

1. Operator runs `atmux team spawn-epic <eid>` from driver-scope.
2. spawn-epic writes the new team.json with default roster — `claudeAccount` field unset.
3. `atmux start <team>` spawns Claude in each pane → **401 immediately** (no creds resolvable).
4. Operator hand-patches the new team.json (`jq` to inject `claudeAccount`), runs `atmux stop --force`, then re-runs `atmux start`. Memory `feedback_spawn_epic_claude_account_inheritance_gap` documents this recovery dance.

The recovery friction compounds two problems:

- **Manual selection** — operator picks an account from memory of who's been used recently. No view of which account has the most rate-limit headroom; busy accounts get re-selected; freshly rate-limited accounts get spawned into and immediately blocked.
- **No exhaustion signal** — when all accounts are rate-limited, the operator finds out via 401-burst across multiple panes after spawn. No "spawn refused — pool exhausted" gate.

`coordination:budget` already probes 5h + weekly utilization across all configured accounts and caches at `~/.atmux/state/budget-probe-<account>.json`. The data needed for "least-loaded" is already collected — it's just not consumed by the spawn path.

The shape of the fix is "pool-draw on spawn, gated on real-time budget state." The shape conflicts with the current cron-poll architecture because:

- Polling budget probe on every spawn-epic call is wasteful (the probe runs on its own cadence; cache may be stale at spawn time).
- Polling budget probe on a faster cadence to keep the cache fresh adds Claude-burn cost.
- The right primitive is **events**: budget probe emits `budget.warning` when an account crosses a threshold; pool-selector subscribes and reorders selection. This is the in-DB pubsub pattern that the queued Honker substrate ADR will deliver.

Hence the gating: **this ADR ships only after the Honker substrate lands.** Until then, the manual jq-patch dance continues (acceptable — frequency is low, blast radius is bounded to a single spawn).

## Decision

### D1 — Pool config shape

Pool config lives at **cockpit-level** (`~/.atmux/cockpit.json::claudeAccountPool[]`) with optional per-parent-team override (`.atmux/team.json::epicSpawnPool[]`).

```jsonc
// ~/.atmux/cockpit.json
{
  "claudeAccountPool": [
    { "account": "c-u",  "weight": 1, "enabled": true },
    { "account": "c-ic", "weight": 1, "enabled": true },
    { "account": "c-i",  "weight": 1, "enabled": false } // disabled (e.g. IFCA acct off-hours)
  ]
}

// <parent-team>/.atmux/team.json (optional override)
{
  "epicSpawnPool": ["c-u", "c-ic"]  // string-list shorthand; weights default to 1
}
```

**Cockpit-level default** because most teams should share the same pool. **Per-team override** allows per-product account scoping (e.g. IFCA-product epic-teams draw only from IFCA accounts).

The existing `team.claudeAccount` field on the parent team is **NOT a pool entry** — it remains the parent team's literal account. Pool entries are separate; the parent's `claudeAccount` is only used as a fallback when both the cockpit pool and per-team override are empty.

### D2 — Selection strategy: least-loaded by budget probe

On `atmux team spawn-epic <eid>`:

1. Resolve effective pool (per-team override if present, else cockpit pool).
2. Filter to `enabled: true` entries.
3. Read each entry's `budget-probe-<account>.json` cache (or subscribe to `budget.warning`/`budget.recovered` events via Honker once the substrate ships).
4. Compute `available_5h_pct = (limit_5h - used_5h) / limit_5h` for each entry.
5. Pick the entry with the **highest `available_5h_pct`**. Ties broken by **round-robin** using a counter persisted at `~/.atmux/state/pool-rr-counter.json` (incremented on every spawn).
6. Inject the selected `claudeAccount` into every member entry in the new team.json. **Per-team assignment**, not per-member — matches current `team.claudeAccount` semantics and simplifies routing.

### D3 — Exhaustion behavior

Pool is **exhausted** when all `enabled: true` entries fail one of:

- `available_5h_pct < 0.05` (5% threshold — configurable via `cockpit.poolMinHeadroomPct`)
- Weekly-cap hit (per the probe cache's `weekly_remaining_pct < 0.02`)
- Budget probe data older than `cockpit.poolMaxProbeStaleMin` minutes (default 30)

On exhaustion, spawn-epic **refuses** with a structured error:

```
atmux: team spawn-epic refused — claude account pool exhausted
  c-u  5h: 2% (rate-limited)
  c-ic 5h: 3% (rate-limited)
  c-i  disabled
hint: wait for 5h-window refresh at <timestamp>, or `atmux pool enable c-i`
```

Once the Honker substrate ships, refusal also **emits a `epic.spawn_blocked` event** with the exhaustion reason in the payload. A subscriber on the cockpit can:

- Notify the operator via Discord (debounced per the future Discord-batcher consumer).
- Auto-retry spawn when a `budget.recovered` event lands for any pool entry.

### D4 — Stale-state grace

Budget probe runs on its own cadence (5h-window probe + weekly probe). Cache freshness is bounded by that cadence. Two grace mechanisms:

1. **`poolMaxProbeStaleMin` threshold** (default 30 min) — entries with cache older than this are treated as exhausted (not assumed-fresh-and-healthy). Safer: refuse spawn if we genuinely don't know the state.
2. **Pre-spawn refresh trigger** — if any pool entry's cache is `> poolMaxProbeStaleMin / 2` stale, spawn-epic triggers a synchronous `coordination:budget` refresh before selection. Refresh cost (~1 API call per stale account) is bounded and only fires on spawn (low-frequency event).

### D5 — Driver-scope only for pool mutations

Per ADR-033 driver-only-flag + memory `feedback_spawn_epic_requires_driver_scope` (spawn-epic itself is driver-scope-only — runtime gate refuses non-driver callers with verbatim hint `ATMUX_CALLER_SCOPE=driver atmux team spawn-epic ...`):

- Pool config (cockpit-level + per-team override) is mutated **only via driver-scope verbs**:
  - `atmux pool add <account> [--team <parent>]`
  - `atmux pool remove <account> [--team <parent>]`
  - `atmux pool enable <account>` / `atmux pool disable <account>`
  - `atmux pool list [--team <parent>]` (read-only — available to lead-scope)
- Lead-scope can `pool list` but not mutate.
- Member-scope cannot read or mutate.

### D6 — Honker substrate integration (the gating dependency)

Once the Honker substrate ADR is accepted + impl-EPIC ships:

1. `coordination:budget` probe emits `budget.warning <account>` when `available_5h_pct < 0.10` and `budget.recovered <account>` when it crosses back above `0.15`.
2. Pool-selector subscribes to both topics. On `budget.warning`, the account is **soft-excluded** from selection (still in pool, marked degraded). On `budget.recovered`, it returns to active rotation.
3. Pool-selector caches the subscribed state in-memory; no per-spawn re-poll of the probe cache files.
4. On `epic.spawn_blocked` (pool exhaustion), a separate `epic.spawn_retry` consumer waits for the next `budget.recovered` event and re-attempts the spawn.

**Until the Honker substrate ships**, pool-selector reads probe cache files directly on every spawn (D2 step 3 above). Slower + more disk I/O, but spawn-epic is low-frequency so the cost is acceptable as a v1-without-substrate fallback. The deferred status of this ADR means the impl-EPIC does not land until both the substrate ADR is accepted AND the substrate impl-EPIC ships.

## Consequences

**Becomes easier:**

- Zero manual jq-patch after spawn-epic. Pool-draw handles `claudeAccount` injection automatically.
- Spawn-epic on a rate-limited account fails **at spawn time with a clear refusal**, not at first Claude call with a 401-burst.
- Pool size scales independently of teams — operator can add accounts to the pool without per-team config churn.
- Operator can `disable` a pool entry temporarily (e.g. IFCA account off-hours) without removing it.

**Becomes harder:**

- New config surface (`~/.atmux/cockpit.json::claudeAccountPool[]`) — needs schema validation, migration for existing cockpits.
- Pool mutation is gated on driver-scope — lead can no longer ad-hoc swap accounts without driver intervention. (Acceptable per ADR-033 scoping; lead pool-list still works for diagnosis.)
- Pool exhaustion now becomes a first-class blocker — operator must respond to `epic.spawn_blocked` or pre-add a new pool entry. Tradeoff is the alternative is silent 401s.
- Forward-ref to Honker substrate ADR means this ADR cannot ship until that lands. **Intentional**: implementing the cache-file-polling fallback (D6 fallback path) would create technical debt that the Honker subscription path replaces immediately — better to wait.

**Risks + mitigations:**

- **Risk**: Pool-selector picks an account that's about to be rate-limited (probe cache stale). **Mitigation**: D4 stale-state grace + pre-spawn refresh trigger.
- **Risk**: Round-robin counter desync across cockpit restarts. **Mitigation**: counter persisted at `~/.atmux/state/pool-rr-counter.json` (durable); restart resumes from disk.
- **Risk**: Per-team override silently shadows cockpit pool entries the operator forgot about. **Mitigation**: `atmux pool list --team <parent>` shows effective pool with override-vs-cockpit annotations; doctor probe surfaces drift.
- **Risk**: Pool config diverges from what `atmux start` expects (claudeAccount in roster). **Mitigation**: spawn-epic is the only writer of new team.json's claudeAccount field; start verifies field is present + matches a known account before spawning.

## Out of scope (deferred)

- **Per-member account assignment within an epic-team** — every member gets the same account (D2 step 6). Splitting be-1 / fe-1 / test-1 across accounts would distribute load but complicates routing + doubles the spawn-time probe-read cost. Deferred until operator data shows per-team account load is the bottleneck.
- **Cross-host pool entries** — pool entries are local-to-this-cockpit. Spanning accounts across multiple hax instances is out of scope.
- **Dynamic pool growth via auto-discovery** — operator manually adds accounts via `atmux pool add`. Auto-discovery of `~/.claude-*` directories is a follow-up if the manual surface proves painful.

## References

- ADR-033 — driver-only flag (pool mutations follow this scope)
- ADR-091 — kanban-driven auto-merge / spawn-epic verb surface
- ADR-140 — cheap-model-first principle (motivation overlap with pool: spread Claude-burn across accounts)
- ADR-192 — cron-arm idempotency contract (sibling discipline pattern at the OS-cron layer)
- Honker substrate ADR (TBD — forward-ref D6)
- `coordination:budget` skill — `~/.atmux/state/budget-probe-<account>.json` cache shape
- memory `feedback_spawn_epic_claude_account_inheritance_gap` — current pain
- memory `feedback_spawn_epic_requires_driver_scope` — scope precedent
- memory `project_spawn_epic_claude_account_pool` — design state + open questions
- memory `project_honker_pubsub_rehaul_design` — substrate dependency


## §Amendment 2026-05-22 — Minimal slice shipped (substrate + spawn-epic integration)

Ships the **load-bearing** piece of ADR-199 — `claudeAccountPool[]` configured in cockpit + `selectAccount()` least-loaded selector + spawn-epic integration. Closes the spawn-epic 401-regression class without waiting on Honker subscriber + cron-backstop substrate; those are ergonomic improvements that don't block migration.

**Shipped:**

- `src/schema/cockpit.ts::ClaudeAccountPoolEntry` — `{configDir, label, weight?}` schema (extends the existing `CockpitClaudeAccount` precedent).
- `src/schema/cockpit.ts::Cockpit::claudeAccountPool` — root-level `ClaudeAccountPoolEntry[]` optional array. When unset / empty, spawn-epic falls back to the existing parent-inheritance chain (no behavior change).
- `src/core/account-pool.ts::selectAccount()` — pure selector. Selection ladder:
  1. Exclude `status !== "allowed"` entries when ANY entry is healthy (otherwise pick least-bad).
  2. Among eligible, prefer lower `h5_util` (most headroom).
  3. Tie → higher `weight` (default 1.0).
  4. Further tie → pool-array order.
- `src/core/account-pool.ts::readBudgetProbe` + `loadBudgetMap` — I/O wrappers that read `$HOME/.atmux/state/budget-probe-<label>.json` per the existing budget skill convention.
- `src/verbs/team/spawn-epic.ts::extractPoolFromCockpit` + `resolvePoolFallback` — pool-resolution helpers; pool fills the bottom of the inheritance ladder (after explicit roster + parent-name-match + parent-team-default).
- `inheritClaudeAccount` signature extended with optional `poolFallback` parameter; backward-compatible when pool is null/empty.

**Selection semantics (verified by 14 unit tests on the pure function):**

- Empty pool → null result, fallback to existing inheritance chain.
- Lowest h5_util wins among allowed entries.
- Throttled entries excluded if ANY allowed; all-throttled → pick least-bad.
- Fresh budget data wins over stale (default 30min stale threshold).
- Missing budget data treated as stale (weight + order fallback).

**Stale-grace contract** — entries with `probedAt` older than `staleThresholdSec` (default 1800) are treated as unknown. Default value chosen because budget probe runs every ~15min (2× safety margin).

**Deferred to follow-up Tasks** on EPIC e-7471f008:

- CLI verbs (`atmux cockpit account-pool add/remove/list` — driver-scope-only per ADR-033)
- Honker subscription to `budget.warning` / `budget.recovered` topics (event-driven re-weighting; currently selector re-reads probe state at each spawn-epic)
- Cron-backstop 5min poll (defense-in-depth per ADR-202 §D6)
- Doctor probe row `claudeAccountPool` (green when populated + non-stale; yellow on partial staleness)
- Per-team override `team.json::epicSpawnPool[]` (cockpit-pool override scope)
- `epic.spawn_blocked` event emission on exhaustion

**Why ship now without the deferred items:**

The deferred items optimize an already-working flow. The minimal slice eliminates the 401-on-bootstrap regression that was forcing manual jq-patch + restart on every spawn-epic. With this commit, spawn-epic against a cockpit with `claudeAccountPool` populated picks a working account automatically; operators configure the pool once + forget.

**Tests:** 20 unit tests (100% func / 98.73% line coverage) on `account-pool.ts`. 27 spawn-epic tests still pass (no regression from the inheritance signature extension).

**Cross-refs:** ADR-090 §Amendment 2026-05-20 (claudeAccount inheritance contract — pool fills the team-default leaf), ADR-202 (Honker substrate — deferred subscription path), `coordination:budget` skill (state file shape).

**Filed via** 2026-05-22 driver session — operator: "deliver the whole thing for honker and fam first".
