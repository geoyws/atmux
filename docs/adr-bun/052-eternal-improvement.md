# ADR-052: Eternal-improvement — kanban-empty fallback to autonomous self-improvement loop

**Status:** proposed
**Date:** 2026-05-06
**Owner:** planner

## Context

When a team's kanban hits empty, today's path is: whip observes 2 idle ticks → fires `atmux stop` (per ADR-043's `whip.autoStopAfterIdleTicks` hook) → cage dies → cron block self-removes → operator-touch needed to bring it back. Witnessed live on the sopx team 2026-05-06 — 2× auto-stops at 19:20 + 21:25 MYT, then 22:25 MYT manual restart.

Per `project_atmux_mission.md`'s north-star ("agent-team autonomy; silent stalls are worse than no harness; bias toward operator-touch removal"), each operator-touch is an autonomy regression. The kanban-empty path is a particularly cheap one to convert into autonomous work: agents are already up, the cage is healthy, the only thing missing is *something to do*.

This ADR specifies **eternal-improvement**: a verb (`atmux improve`) that decomposes "what can we improve on?" into kanban Tasks, dispatches them, and loops — bounded by a token budget, terminating cleanly when the budget is exhausted. Two invocation modes share one implementation:

- **Mode A — user-invoked.** Driver or operator runs `atmux improve [--budget <spec>]` from a project root. Any time, any state. The team picks up improvement work alongside whatever else is in flight.
- **Mode B — idle-fallback.** Whip's existing ADR-043 idle-stop hook is intercepted: instead of firing `atmux stop`, it kicks off an `atmux improve` run with the standing default budget. `atmux stop` only fires after the budget is exhausted AND kanban is still empty AND no in-progress improvement Task remains.

Driver origin: `driver-inbox.md` 22:40 MYT + 22:43 MYT entries (P0 priority for atmux team, standing activation across all 3 cages — sopx + atmux + unum — at 30% of weekly tokens per cage).

### Branch / runtime ambiguity

The atmux team's runtime `atmux` symlinks to `/root/work/src/atmux/bin/atmux` on the **`atmux-geoyws` branch**. ADR-043 (auto-stop), ADR-049 (Claude Max budget watcher), and most observability infra live on that branch — NOT on `worktree-atmux-bun` where this work is being decomposed. Implementation therefore has a fork:

- `lib/improve.sh` lands in this branch's tree but is NOT runtime-effective until either (a) merged into `atmux-geoyws`, or (b) the runtime symlink switches to a unified branch.
- `src/verbs/improve.ts` (TS port) IS runnable directly via `bun run bin/atmux-bun improve` from this worktree, so dogfooding has a path even pre-merge.

This ADR scopes the deliverable to atmux-bun's tree (per lead's dispatch — ADR file in `docs/adr-bun/`, code in `src/verbs/` + `lib/`). Cross-branch sync is surfaced as **OQ-1** for driver decision.

### Supergroomer overlap (t-9319a22c) and budget-pause cage (t-706655ee)

`t-9319a22c` (Supergroomer agent — long-running janitor in cage) and `t-706655ee` (Multi-tier fallback chain for budget-pause) both touch the *autonomous self-work* problem space:

- **Supergroomer** is fleet-level + multi-step + judgment-heavy + uses cage isolation + LLM consulted only when cron-groom finds work it can't handle.
- **Eternal-improvement** is team-local + single-step (decompose → land → dispatch) + uses the team's existing cage + LLM consulted on every cycle.

They share **infra** (cage, isolation, LLM-as-janitor) but differ on **scope**, **trigger**, and **action surface**. Three clean options for the boundary, surfaced as **OQ-2**:

1. **Keep distinct.** Eternal-improvement is per-team, kanban-driven, branch-local. Supergroomer is fleet-level, state-leak-driven, cross-team. They never overlap because their triggers + action surfaces are disjoint.
2. **Eternal-improvement absorbs supergroomer.** Run supergroomer-style fleet sweeps as one of the improvement-task taxonomy seeds within an `atmux improve` cycle. Single mechanism, two trigger types (kanban-empty for branch-local; cron-fired for fleet-level).
3. **Supergroomer absorbs eternal-improvement.** When cron-groom finds "team has nothing to do," it kicks off a supergroomer cycle that includes branch-local improvement work as one of its action paths.

Recommended default in this ADR: **Option 1 — keep distinct.** Eternal-improvement is dogfoodable now; supergroomer requires the dedicated-Linux-user provisioning + fleet-level state-leak detection that's still on the t-9319a22c blocked path. Coupling them slows down both.

## Decision

### `atmux improve` verb

```
atmux improve [--budget <spec>] [--status] [--dry-run] [--default-budget]
              [--idle-fallback]

  --budget <spec>      Token budget. Forms accepted:
                         <int>            raw token count, e.g. `2000000`
                         <int>%           fraction of 5h cap, e.g. `50%`
                         <int>%-5h        same as `<int>%`
                         <int>%-wk        fraction of weekly cap (DEFAULT)
                         e.g. `30%-wk`
  --default-budget     Use the standing default (`30%-wk`).
                       Equivalent to `--budget 30%-wk` but resolves
                       AT INVOCATION TIME so multi-tick callers don't
                       re-resolve a moving target. Used by Mode B.
  --status             Print state-file contents + computed remaining
                       to stdout, exit 0. Read-only.
  --dry-run            Resolve budget, print formula + computed total
                       + chosen taxonomy seeds, exit 0. No state writes.
  --idle-fallback      Marks this invocation as Mode B. Affects
                       termination behaviour: on budget exhaustion,
                       runs `atmux stop` (the original ADR-043 path)
                       instead of returning to whatever invoked it.
```

### Budget formula

**Default:** `0.3 × min(remaining_wk_tokens_per_active_member)`.

- `remaining_wk_tokens_per_active_member` is read from each member's claude budget state (the source-of-truth lives in ADR-049's budget probe — `.atmux/state/budget-probe-<team>.json` for the runtime branch).
- `min(…)` over members is intentional: it prevents pinning the lowest-budget member over their cap. A member with 100k weekly tokens left + a member with 1M weekly tokens left → budget is `0.3 × 100k = 30k`, not `0.3 × 1M`.
- "Active members" = team.json members with `paused: false` AND a live pane.
- If no observability data is available (e.g. ADR-049 not yet ported / not yet probing), `--budget` MUST be passed explicitly. The default fails closed with a USAGE error rather than silently picking a bogus number.

**Override forms** (in resolution-precedence order, first wins):

1. CLI `--budget <spec>`.
2. Env `ATMUX_IMPROVE_BUDGET=<spec>`.
3. `team.json::improve.defaultBudget` (string, same spec format).
4. Built-in default `"30%-wk"`.

`--budget=30%-5h` mode (per the original 22:40 MYT spec, superseded by the 22:43 MYT update but still a legitimate overrideable knob): `0.3 × min(remaining_5h_tokens_per_active_member)`. Documented but not the default.

### State-file schema

Single greppable JSON file at `.atmux/state/eternal-improvement.json`:

```jsonc
{
  "active": true,                       // false when between runs (file may persist for audit)
  "runId": "ei-<8-hex>",                // new id per `atmux improve` invocation
  "startedAt": 1778080000,              // epoch seconds, UTC
  "mode": "user-invoked" | "idle-fallback",
  "budgetSpec": "30%-wk",               // raw spec string as resolved
  "budgetTotal": 1500000,               // tokens, computed at start
  "budgetRemaining": 1247000,           // tokens, decremented per cycle
  "cycleN": 3,                          // cycle counter (1-indexed)
  "currentCycle": {
    "startedAt": 1778085000,
    "tasksLanded": ["t-aaaaaaaa", "t-bbbbbbbb"],
    "tasksDispatched": ["t-aaaaaaaa"],
    "tasksDone": [],
    "tokensSpent": 53000               // running tally; finalized when cycle closes
  },
  "lastCycleClosedAt": 1778084000,      // epoch seconds; null on first cycle
  "history": [                          // append-only ring; max 50 entries
    {
      "cycleN": 1,
      "startedAt": 1778080000,
      "closedAt": 1778082000,
      "tasksLanded": 4,
      "tasksDone": 4,
      "tokensSpent": 200000
    }
  ]
}
```

- File is created on first `atmux improve` start. Locking via `eternal-improvement.json.lock` flock pattern (matches `whip-idle-state.json.lock`).
- `active: false` is the resting state — set when a run terminates (budget exhausted, manual abort, or operator `atmux stop`). The file persists for `atmux improve --status` reads + post-mortem.
- Schema version is OMITTED at first land per ADR-016's "Phase 6 introduces versioning post-bash-decommission" carve-out. If a Phase 6 schema bump is needed later, ADR-016 covers it.

### Loop mechanics

One **cycle** = (ask → plan → dispatch → implement → review → commit → close). Performed by:

1. **Lead** receives `atmux improve` invocation (verb writes a directive to `lead-inbox` style entry — "🌱 eternal-improvement cycle <N> requested").
2. **Lead** routes to **planner** with prompt template: "ask each lane member their top improvement candidate; score by impact-vs-cost; land top N as kanban Tasks; dispatch."
3. **Planner** queries members via `atmux send <member> "what's the highest-leverage improvement in your lane right now?"`. Members reply via the existing reply chain (`atmux reply` → lead-outbox.md → planner reads).
4. **Planner** scores + decomposes: typically 1–3 Tasks per cycle (matches whip's "no fresh body-hash" cadence — small batches keep idle-detection accurate).
5. **Lead** dispatches normally. Workers pull. Reviewer + gitter close the loop per existing flow.
6. **Cycle closes** when all Tasks of that cycle are `done` AND committed. State-file's `currentCycle` is moved to `history`, `cycleN` increments, `lastCycleClosedAt` updates.

**Token-spend accounting** (cycle-level, not Task-level):

- At cycle start: snapshot `wk_tokens_spent_per_member`.
- At cycle close: snapshot again. Sum the deltas across active members → `tokensSpent`.
- Budget decrement: `budgetRemaining -= tokensSpent`.
- If `budgetRemaining ≤ 0` AT CYCLE CLOSE → terminate. **Mid-cycle overage is allowed** per the driver's "feature must be fully built even though a bit more tokens are used" directive.
- Snapshot source: same `.atmux/state/budget-probe-<team>.json` ADR-049 file, OR a polling fallback (`atmux cost --json`) if the probe isn't available.

### Idempotence

A second `atmux improve` invocation while a run is already active:

- Reads `.atmux/state/eternal-improvement.json::active`.
- If `active: true` AND the existing `runId` is < 24h old: **refuse with exit 0** (not error — second invocation is benign), log "🌱 eternal-improvement: already active (runId=<…>, cycle=<N>) — pass `--force` to start a parallel run". stderr message, exit 0 keeps cron scheduling sane.
- `--force` flag overrides idempotence guard. Used by tests + by the operator if state file is stale.
- Stale-detection: if `active: true` but `startedAt` is > 24h old AND no `currentCycle.startedAt` in the last 6h, treat as crashed / abandoned → log "🌱 stale improvement run — clearing state" + clear + start fresh. Conservative thresholds; a real improvement run shouldn't go 6h without a cycle close.

### Termination

A run terminates when **all** of:

1. `budgetRemaining ≤ 0` (post-cycle-close accounting).
2. No `currentCycle.tasksDispatched` are still in `pending` / `in-progress` / `review` states.
3. (Mode B only) kanban is still empty (no driver-dispatched non-improvement Tasks landed during the run).

On termination:

- Set `active: false` in state file, finalize `history`.
- Discord ping `🌱 [eternal-improvement-done]` with cycle count + tasks shipped + final budget delta + run duration.
- Log line in `whip.log` (Mode B) or improve.log (Mode A).
- Mode B: invoke `atmux stop` (the path ADR-043 originally took). Mode A: return exit 0.

If the driver dispatches new (non-improvement) Tasks DURING a run, those preempt:

- Improvement cycle in progress finishes (don't abort mid-cycle per fully-built directive).
- Loop pauses (set `currentCycle.paused: true`).
- Driver Tasks proceed normally.
- When driver Tasks are done AND kanban is empty again AND budget remains → loop resumes from cycle N+1.

### Scope guardrails

Improvement Tasks MUST satisfy all of:

- Lands on the team's working branch (no forks, no greenfield rewrites, no architectural pivots).
- Does NOT touch `_refs/` (frozen reference material).
- Does NOT rewrite ADRs (additive ADRs OK; rewrites need driver approval).
- Does NOT modify `staging` / `prod` deploy configs (per CLAUDE.md push policy — Demo path off-limits).
- Is fully landable in ≤1 cycle (no multi-cycle epics inside an improvement run; if planner sees one, escalate to driver via decisions.md).

If a candidate improvement violates any of the above → escalate via the regular `pending-decisions.md` / `lead-outbox.md` path, do not silently ship.

### Improvement-task taxonomy (planner riffs on these per cycle)

Seeds per the driver brief:

- Test-coverage gaps (per-lane, narrowed denominator per CLAUDE.md TestingDiscipline).
- Lint warnings.
- Stale TODOs in `docs/`.
- ADR backlog (decisions made-but-unwritten).
- Code dup'n / refactor opportunities.
- Doc drift vs current behaviour.
- Observability holes (missing log tags, untested error paths).
- CI flakes.
- Deps freshness.
- `.gitignore` noise.
- Dead-code pruning.

Lane-specific seeds welcome. Planner's discretion to add new seed categories per cycle.

### Discord templates

Three new named templates added to the existing whip Discord vocabulary (per CLAUDE.md per-bullet emoji rules):

```
🌱 [eternal-improvement-start] · `<team>` · HH:MM MYT
  • 🌱 budget: 30%-wk = 1.5M tokens
  • 🎯 mode: user-invoked / idle-fallback
  • 📍 runId: ei-a3f2c814

🌱 [eternal-improvement-progress] · `<team>` · HH:MM MYT  (per cycle close)
  • ✅ cycle N closed — M tasks shipped
  • 💰 tokens spent: 200k of 1.5M
  • 📊 budget remaining: 1.3M
  • 🔜 cycle N+1 starting

🌱 [eternal-improvement-done] · `<team>` · HH:MM MYT
  • ✅ run complete — Ncyc cycles, Mtasks tasks shipped
  • 💰 tokens consumed: 1.52M of 1.5M (1.3% overage, mid-task)
  • ⏱️ duration: 6h45m
  • 🛑 (Mode B) team will now `atmux stop`
```

Trigger labels (`ATMUX_DISCORD_TRIGGER`): `eternal-improvement-start`, `eternal-improvement-progress`, `eternal-improvement-done`. Add to the `DiscordEventType` union in `src/abstractions/discord.ts` alongside existing `whip-budget` / `whip-autostop` / etc.

### Whip integration (Mode B)

Modify ADR-043's `_atmux_whip_check_auto_stop` (bash) / future `_atmux_whip_check_auto_stop` TS port:

```diff
- atmux::log "whip: team idle ${count} ticks ≥ threshold ${threshold} — invoking atmux stop"
- ATMUX_DISCORD_TRIGGER="whip-autostop" atmux::discord_embed_ping "$msg" 2>/dev/null || true
- if ! "$ATMUX_BIN_DIR/atmux" stop >/dev/null 2>&1; then
+ # Pre-stop intercept: kick off eternal-improvement if not already active.
+ if ! _atmux_improve_is_active; then
+   atmux::log "whip: idle threshold met — invoking atmux improve --idle-fallback --default-budget instead of stop"
+   ATMUX_DISCORD_TRIGGER="eternal-improvement-start" \
+     atmux::discord_embed_ping "$improve_start_msg" 2>/dev/null || true
+   if "$ATMUX_BIN_DIR/atmux" improve --idle-fallback --default-budget >/dev/null 2>&1; then
+     return 0  # eternal-improvement now owns the termination path
+   fi
+   atmux::log "whip: improve invocation failed — falling through to stop"
+ fi
+ # Original stop path (eternal-improvement was already active and exhausted, OR improve failed):
+ atmux::log "whip: team idle ${count} ticks ≥ threshold ${threshold} — invoking atmux stop"
+ ATMUX_DISCORD_TRIGGER="whip-autostop" atmux::discord_embed_ping "$msg" 2>/dev/null || true
+ if ! "$ATMUX_BIN_DIR/atmux" stop >/dev/null 2>&1; then
```

The `_atmux_improve_is_active` helper reads `.atmux/state/eternal-improvement.json::active`.

**Important nuance:** `atmux improve --idle-fallback` returns *immediately* (not blocking until budget exhausts). It dispatches the first cycle to the lead + writes state, then exits. Subsequent whip ticks observe `active: true` AND non-idle (the cycle is generating activity), so the auto-stop counter resets — exactly the behaviour we want. When the run terminates, the verb itself fires `atmux stop` directly (Mode B's termination semantic).

### Cross-cage handshake

Per the driver brief (22:43 MYT): the atmux team announces feature-readiness via `lead-outbox.md` + Discord `🌱 [eternal-improvement-shipped]`. Driver then runs `atmux improve --budget=30%-wk` from sopx + unum project roots — pre-staged in those teams' driver-inboxes.

This ADR does NOT cover the sopx / unum side rollout. Their teams pick up the verb + ADR via the regular merge / sync path (the runtime symlink resolves to whichever branch they're on).

## Consequences

- **Operator-touch removal.** Today's `kanban-empty → auto-stop → manual restart` cycle becomes `kanban-empty → improve cycles → auto-stop`. Manual restart is preserved as the explicit operator action when truly needed.
- **Token-spend trades against operator-touch.** 30%-wk-tokens is non-trivial. The deal: spend tokens autonomously now to reduce operator interrupts later. Driver overrideable per-cage via `team.json::improve.defaultBudget` (e.g. unum's lower 10%-wk if dogfooding bites cost-pressure).
- **Improvement Tasks are real Tasks.** They go through review + gitter + commit like any other Task. Reviewer's per-commit gate applies. CLAUDE.md TestingDiscipline applies (100% coverage, narrowed denominator, tests in same commit). Push policy applies (improvement Tasks land on team's working branch; never push to staging without explicit George authorization).
- **Whip's idle-detection logic stays.** ADR-043's body-hash idle-tick counter is unchanged; eternal-improvement only intercepts the *action* on threshold-fire, not the *detection*. This keeps the whip change small + reversible.
- **State file proliferation.** Adds `.atmux/state/eternal-improvement.json` + lock. Doctor's R6-compliant fs probes already cover this directory; no new doctor work required.
- **Branch-fork risk.** Per OQ-1, this ADR + code lands first in `worktree-atmux-bun` but the runtime is `atmux-geoyws`. Mitigation: commits are small, atomic, easily cherry-pickable. Driver-side merge is the unblock action.
- **Supergroomer's path is preserved.** Per the recommended default in OQ-2 (keep distinct), supergroomer remains a future-build with its own trigger criteria. Eternal-improvement does NOT delay or supersede it.
- **Rollback path.** Set `team.json::improve.defaultBudget = "0"` (or remove `--idle-fallback` from whip's hook) → eternal-improvement is dormant. The verb itself remains callable for explicit user-invoked runs. Full removal: revert the whip hook diff + remove state file, leaving the verb harmless.

## Considered alternatives

### A. Driver-only invocation (no whip integration)

Mode A only. Eternal-improvement only fires when the driver explicitly runs `atmux improve`. Discarded because the original problem (operator-touch on kanban-empty) is exactly what Mode B solves; Mode A alone doesn't move the needle on autonomy.

### B. Budget = 50% of 5h tokens (per original 22:40 MYT spec)

Superseded by 22:43 MYT update — driver explicitly switched to 30%-wk. The 5h-window default is more aggressive on burn rate (5h windows refresh faster than weekly windows), which makes mid-day exhaustion more likely + recovery faster. Weekly budget gives a smoother long-tail profile. Keep `30%-5h` as a documented overrideable knob (already in the spec form), default to `30%-wk`.

### C. Single-cycle "do one improvement and stop"

Eternal-improvement runs one cycle then stops. Discarded because the loop's value comes from the *cumulative* burn — 1 improvement Task is rarely high-leverage; 10 small ones over a 30%-wk budget is meaningful drift toward better code. Mode B's idle-fallback also requires the loop semantic — single-cycle would just shift the operator-touch back one step.

### D. Token budget tracked per-Task instead of per-cycle

Discarded because Task-level token tracking would (a) require tighter integration with each member's instrumentation than ADR-049 currently provides, (b) miss out-of-band token spend (planner asks, reviewer gates), (c) make mid-task overage harder to reason about. Per-cycle keeps the accounting cheap + matches whip's existing tick cadence.

### E. Eternal-improvement as a pluggable strategy

Multiple improvement strategies (test-coverage-only, refactor-only, doc-drift-only) selectable via flag. Discarded for v1: too speculative without observed usage patterns. Add later if real lane-specific demand emerges.

## Open questions

### OQ-1 — Where does the FIRST landing happen? (high reversibility)

- **Recommended default:** atmux-bun (this branch), per lead's dispatch. ADR + `src/verbs/improve.ts` + `lib/improve.sh` ship here. Cross-branch sync to `atmux-geoyws` (the runtime) is a driver action.
- **Alternative:** land directly on `atmux-geoyws` so the runtime picks it up immediately. Requires a parallel dispatch outside this team.
- **Override window:** before any implementation Task is claimed. After workers commit, branch-side cleanup is more expensive but still tractable.
- **Driver consideration:** if dogfooding speed matters more than branch hygiene, override to atmux-geoyws.

### OQ-2 — Supergroomer (t-9319a22c) overlap — keep distinct, merge, or absorb? (medium reversibility)

- **Recommended default:** keep distinct (Option 1 in §Context). They share infra but their triggers + scopes are disjoint.
- **Alternatives:** Option 2 (eternal-improvement absorbs supergroomer) or Option 3 (supergroomer absorbs eternal-improvement) — both increase coupling.
- **Override window:** supergroomer is currently blocked behind t-706655ee (multi-tier fallback cage). Decision is reversible until either Task's implementation Task lands.

### OQ-3 — Budget observability source — ADR-049 probe vs polling `atmux cost`? (low reversibility)

- **Recommended default:** prefer ADR-049 probe when available; fall back to `atmux cost --json` polling.
- **Open detail:** ADR-049 is on `atmux-geoyws`, not on this branch. The TS-side budget read may need a stub until ADR-049 ports.
- **Override window:** flippable in the verb implementation; just a function-call swap.

### OQ-4 — Cycle batch size (1 Task per cycle vs 1–3 vs 5+)? (low reversibility)

- **Recommended default:** 1–3 Tasks per cycle (planner's discretion within range).
- **Driver consideration:** smaller batches → tighter idle detection + faster review feedback; larger batches → fewer cycle-overhead trips. Planner can tune per-cycle.
- **Override window:** trivially flippable in the planner's prompt template.

### OQ-5 — Mid-run preemption by driver Tasks — auto-pause vs explicit `atmux improve --pause`? (low reversibility)

- **Recommended default:** auto-pause (per §Termination) — driver Tasks land normally, eternal-improvement loop pauses + resumes when kanban returns to empty.
- **Alternative:** require explicit `atmux improve --pause` to prevent dispatch contention.
- **Override window:** flippable in lead's whip-tick logic.

### OQ-6 — Discord channel for eternal-improvement pings — main team channel vs dedicated? (low reversibility)

- **Recommended default:** main team channel, same routing as `[whip-progress]` / `[whip-autostop]`.
- **Alternative:** dedicated `#eternal-improvement` channel per cage (would require Discord-side setup + per-cage config).
- **Override window:** trivial config flip.

### OQ-7 — Mode B termination — fire `atmux stop` immediately on budget exhaustion vs wait for next whip tick? (medium reversibility)

- **Recommended default:** fire immediately from inside `atmux improve --idle-fallback`'s termination branch. Cleanest semantic — the verb that intercepted the stop owns the stop.
- **Alternative:** mark `active: false` + let the next whip tick observe idle + fire stop the original way. Looser coupling but adds a tick of latency + a tick where the team is "done improving but not yet stopped."
- **Override window:** flippable in the verb's termination branch.

## Broader-context paragraph (planner-far carve-out)

Per the driver brief (22:40 MYT) — planner-far normally weighs in on roadmap fit, but this team has no planner-far, so collapsing into this paragraph: **eternal-improvement is the first concrete instance of "what does an autonomous team do when it has no orders?"** That question recurs in adjacent autonomy work — supergroomer (what does the fleet do when one team has nothing to do?), super-driver (what does the operator-of-operators do when all cages are idle?), and the future "supervisor decides team scope" work where the supervisor itself reasons about which teams should exist + at what intensity. Eternal-improvement's cycle mechanism (ask members → score → land → dispatch → close → repeat under budget) is a candidate primitive for those higher layers — supergroomer's per-team intervention path could reuse the cycle shape; super-driver's "promote idle team to higher-budget improvement target" could lean on the budget formula. Designing eternal-improvement's state-file + cycle accounting cleanly leaves headroom for those layers to sit on top without rework. Anti-pattern to avoid: baking team-specific logic into the cycle that future supervisors couldn't override (e.g. hardcoding seed taxonomy in code instead of config). The taxonomy seeds in §"Improvement-task taxonomy" should move to `team.json::improve.taxonomy[]` once the v1 patterns settle, exactly so that supervisor-decides-team-scope can program-set them.

## Termination signals (re-enable handles)

This ADR's `proposed` → `accepted` flip is gated on:

- OQ-1 resolved (driver picks branch for first landing).
- OQ-2 resolved (driver picks supergroomer boundary).
- Reviewer-gate signoff on the verb skeleton (Mode A working end-to-end on a synthetic 1-cycle run).

Other OQs can be resolved in-flight — they're code-shape, not architectural.
