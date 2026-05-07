# ADR-056: Account-swap — preemptive handoff at high utilization

**Status:** proposed
**Date:** 2026-05-07
**Owner:** planner

## Context

Driver-inbox 08:38 MYT 2026-05-07 (Ask 5.3): instead of halting at ≤10% remaining (ADR-049 / ADR-053 budget-pause), swap members to a healthier account before exhaustion. Today's behavior — pause everyone until the budget window resets — preserves work but stalls progress for hours. With the operator running 4 accounts on hax (icloud, ifca, unum, personal/default), at any given moment one account is usually fresh while another is depleted; this ADR enables that capacity to flow.

This is the heaviest of the three Ask-5 ADRs. Hard prerequisite: **ADR-053's Fix C (OAuth refresh) lands first** — without it, target-account probes 401 silently and swap chooses unhealthy accounts.

### Push-back: 70-80% trigger threshold (driver suggestion) — VALIDATED + REFINED

Driver suggested 70-80% used (20-30% remaining), explicit pushback: at 90% the choreography may not fit. Validation:

**Choreography per member:** probe target → spawn shadow member on target account (cwd + role + lane same as original) → `atmux handoff <original> <shadow>` → confirm shadow ack'd via inbox → `atmux pause <original>`. Driver brief estimates 2-5min per member.

**Worst-case math (8 members on shared account, serial swap):**

- 8 members × 5min/member = 40min.
- At 90% used on a 5h window: 10% remaining = 30min before exhaustion. **40 > 30 → exhausts mid-swap.**
- At 80% used: 20% remaining = 60min. **40 < 60 → fits with margin.**
- At 75% used: 25% remaining = 75min. **40 < 75 → fits comfortably.**
- At 70% used: 30% remaining = 90min. **40 < 90 → fits with healthy buffer.**

**Recommended threshold: 75% used** (25% remaining). Default in TeamWhip Zod schema (ADR-054 `accountSwapTriggerThreshold` default 75). Matches driver intent + has buffer for spawn/handoff variance.

**Hard cap per-member swap deadline: 5min.** If a single swap exceeds 5min, abort that swap (don't kill original; log + flag), keep moving. Prevents one stuck swap from consuming the budget window.

**Concurrent swaps: serialized.** Per-team flock (`.atmux/state/account-swap.lock`) — only one swap in flight at a time. Sequential keeps the math tractable AND prevents thrash on shared-account confusion (two members swapping in parallel could both target the same fallback, creating new contention).

### Lead/planner exclusion

Driver brief: "NEVER swap lead or planner — they hold cross-conversation memory that handoff doesn't carry." This ADR codifies. The `atmux handoff` primitive serializes inbox + claimedTask + per-member kanban-cursor — but lead's cross-conversation context (driver-inbox triage state, planner's decomp state) is in conversation memory, not state files. Swapping wipes it.

Lane-scoped swap-eligibility: only members with `role: worker` (or absent role, treated as worker) are swappable. Members with `role: lead | planner | reviewer` are excluded. Configurable via `team.json::whip.accountSwapExcludeRoles` (default `["lead", "planner", "reviewer"]`).

## Decision

### D1 — Swap state machine

Per-team state file: `.atmux/state/account-swap.json`.

```jsonc
{
  "active": false,            // true while a swap pass is in progress
  "passId": "swap-<8-hex>",   // unique per pass (a pass = one trigger event, may swap N members)
  "startedAt": 1778120000,
  "trigger": {                // what fired the swap pass
    "account": "icloud",
    "h5_pct_used": 76,
    "wk_pct_used": 23
  },
  "decisions": {              // per-member-name decisions made at trigger time
    "member-a": { "from": "icloud", "to": "ifca", "status": "pending|in-progress|done|aborted|excluded", "startedAt": null, "finishedAt": null, "shadowName": "member-a-swap" }
  },
  "history": [                // pass-level history (last 20 passes)
    { "passId": "swap-...", "completedAt": 1778115000, "swapped": 6, "excluded": 3, "aborted": 0 }
  ]
}
```

Lock via `.atmux/state/account-swap.lock` flock.

### D2 — Trigger detection

Inside whip.ts's per-tick budget check (after ADR-053's pause-check, BEFORE pause-fire):

1. For each account observed on this team: read latest probe.
2. If account's `h5_pct_used >= accountSwapTriggerThreshold` (default 75) OR `wk_pct_used >= same threshold`:
   - Find which members are using this account (`team.members[].claudeAccount` or `team.whip.claudeAccount` default).
   - Filter out excluded roles.
   - For each candidate member: pick fallback per `team.whip.accountFallback` priority list. First fallback with BOTH `h5_pct_used <= 50` AND `wk_pct_used <= 50` wins. (50% threshold for fallback healthiness — half-used is safe-enough; deeper would over-constrain.)
   - If any candidates have a viable fallback: enter swap pass (acquire account-swap.lock, write state, dispatch first swap).
   - If no viable fallback for any candidate: skip swap; fall through to ADR-053 budget-pause.

3. If `active: true` already: skip trigger detection (in-flight pass owns the per-tick action).

### D3 — Per-member swap workflow

Sequential, one-at-a-time. Per swap:

1. **Probe target account** (D1 of ADR-053; ttl=0 i.e. force-fresh probe to avoid stale cache).
2. If target's probe-401 or no-credentials: mark this member's decision `aborted`, log, dispatch next.
3. **Spawn shadow member** via `atmux add-member` programmatic call (or new low-level helper if add-member can't be invoked from inside whip):
   - Name: `<original>-swap` (collision-detect: append `-2`, `-3` if name taken).
   - Same `role`, `lane`, `cwd`, `tui`, `model` as original.
   - `claudeAccount`: target.
   - DO NOT auto-`atmux start` the shadow's window — `atmux start` is heavy. Instead, programmatic spawn directly into the team's tmux server (matches how atmux start spawns members internally).
4. **Wait for shadow's pane to reach prompt** (poll pane content ≤10s; abort swap if not ready).
5. **`atmux handoff <original> <shadow>`** — moves inbox entries, in-progress task assignment, and per-member state.
6. **Confirm shadow ack via inbox** — poll shadow's inbox for the handoff entry being read (or fire a synthetic ping the shadow ACKs); ≤10s timeout.
7. **`atmux pause <original>`** — DO NOT kill. Pause preserves rollback.
8. **Update state file:** mark this member's decision `done`, record `shadowName`, `finishedAt`.
9. **Discord ping `[whip-account-swap-success]` for this member.**
10. **Dispatch next member** in `decisions` order.

When all `decisions` are `done | aborted | excluded`: close the pass, fire `[whip-account-swap-pass-complete]`, archive pass to `history`, set `active: false`, release lock.

### D4 — `claudeAccount` becomes runtime-mutable

Currently `team.json::members[].claudeAccount` is set at spawn time + read by `atmux send`/`dispatch`/`claim`. After swap, the shadow has a different `claudeAccount` than the original. Two integration points:

1. **kanban claim references** — `claim` reads the claiming member's row in team.json. After swap, the SHADOW is the owner of in-flight tasks (transferred via handoff). So `claim` reads shadow's row, sees its `claudeAccount`, no special handling needed.
2. **send/dispatch** — likewise reads target member's row at send time. After swap, sends to `<original>-swap`, not `<original>`. Lead's TaskList + driver-side mental model needs to reflect the renaming.

**Lead-side surfacing:** when a swap completes, the swap state-file is summarized in:

- `atmux status` — shows which members are paused-via-swap.
- Driver-inbox entry — appended at swap-pass-close with the from→to map (so driver doesn't need to check state file).
- whip's normal Discord findings — shadow members appear normally; original-paused members show as paused (matches existing `atmux pause` UX).

### D5 — Discord templates

Add to `DiscordEventType` union:

```ts
| "whip-account-swap-start"     // pass-level
| "whip-account-swap-success"   // per-member success
| "whip-account-swap-fail"      // per-member abort
| "whip-account-swap-pass-complete"
```

Templates:

```
🔄 [whip-account-swap-start] · `<team>` · HH:MM MYT
  • 🚨 trigger: account `icloud` at 76% (5h)
  • 👥 candidates: 6 members (3 excluded: lead/planner/reviewer)
  • 🎯 target fallback: `ifca` (8%/12%)
  • 🆔 passId: swap-a3f2c814

🔄 [whip-account-swap-success] · `<team>` · HH:MM MYT
  • ✅ swapped: `parity-state-impl` → `parity-state-impl-swap` on `ifca`
  • 💼 in-flight task: t-abc1234 (handed off cleanly)
  • ⏱️ duration: 3min42s
  • 📊 progress: 3/6

🔄 [whip-account-swap-fail] · `<team>` · HH:MM MYT
  • ❌ swap aborted: `up-impl` (target probe 401)
  • 🚩 reason: refresh failed for `ifca` — re-login needed
  • 📍 fallback: keeping `up-impl` on `icloud` (will hit pause)
  • 🚩 flag: p2 raised

🔄 [whip-account-swap-pass-complete] · `<team>` · HH:MM MYT
  • ✅ pass `swap-a3f2c814` complete
  • 📊 swapped: 5 / aborted: 1 / excluded: 3
  • 💰 budget on icloud post-pass: 76% used (no longer pinned)
  • ⏱️ pass duration: 18min
```

### D6 — Failure-mode hardening

Per driver brief (failure modes to design around):

| Failure | Detection | Response |
|---|---|---|
| Target credentials 401'd | `probeBudget(target).status === "probe-401"` | Mark this member aborted; try next fallback in priority list; if no healthy fallback → fall through to ADR-053 budget-pause |
| Concurrent swaps from operator | `account-swap.lock` flock contention | Block (operator's manual `atmux pause` overrides; whip waits) |
| Shadow spawn fails | Spawn timeout 10s OR exit code != 0 | Don't kill original; log + Discord `[whip-account-swap-fail]`; fall through to budget-pause for this member |
| Lead/planner mid-decision | Excluded by `accountSwapExcludeRoles`; never swapped | N/A (excluded at trigger detect) |
| Per-member 5min deadline exceeded | Wall-clock timer per swap | Don't kill original; log + Discord; mark aborted; move to next |
| Pass interrupted (whip-tick crashes mid-swap) | On next tick, observe `active: true` AND no progress in last 5min | Mark in-progress decision as aborted; release lock; resume from pending decisions |
| Operator manually `atmux start`'s shadow | Shadow already exists | Skip spawn step; proceed to handoff (idempotent) |

### D7 — Rollback (out of scope)

Driver brief mentions rollback when account refreshes — "can swap back if desired (separate ADR; out of scope here)." Confirmed out of scope.

### D8 — Configuration

In `team.json::whip` (typed via ADR-054):

```jsonc
{
  "whip": {
    "accountFallback": ["icloud", "ifca", "unum", "default"],
    "accountSwapTriggerThreshold": 75,
    "accountSwapFallbackHealthThreshold": 50,
    "accountSwapPerMemberDeadlineSec": 300,
    "accountSwapExcludeRoles": ["lead", "planner", "reviewer"]
  }
}
```

`accountFallback` is per-team (each team defines its own priority list). Empty array = swap disabled.

### D9 — Test coverage

Per CLAUDE.md TestingDiscipline:

- `tests/unit/state/account-swap.test.ts` — state-file shape, lock contention, idempotence on tick interruption, aborted-resume.
- `tests/unit/verbs/whip.test.ts` (extend) — trigger detection, candidate filter (excluded roles), fallback priority pick, no-viable-fallback fall-through.
- `tests/unit/core/account-swap.test.ts` — per-member workflow steps, deadline timeout, shadow-spawn failure, handoff failure.
- `tests/unit/abstractions/discord.test.ts` (extend) — 4 new template renderers.
- `tests/e2e/account-swap.test.ts` — synthetic high-utilization scenario walks through swap of 2 members; matches stateful-e2e shape per CLAUDE.md (1x cold-start+walk; non-idempotent).

## Consequences

- **Operator stops watching budget windows manually.** Auto-swap covers the case "one account drained, another fresh" — operator only intervenes when ALL accounts are simultaneously drained (rare).
- **Member roster grows during swap pressure.** Original + shadow both exist; original is paused. Roster cleanup is a follow-up (post-resume reconciliation).
- **In-flight tasks survive cleanly.** `atmux handoff` is the proven primitive; this ADR is a wrapper that orchestrates handoff + lifecycle.
- **75% trigger gives 25% margin = 60-75min on 5h windows.** Worst-case 8-member serial swap = 40min. Margin is comfortable.
- **OAuth-401 hardening from ADR-053 is load-bearing.** Without Fix C, target probes lie + swap chooses unhealthy accounts. Hard dep ordering preserves correctness.
- **Lead/planner stability preserved.** Swapping them would wipe conversation memory; explicit exclusion + configurable.
- **Failure modes are loud, not silent.** Every abort fires Discord + flags entry; operator never wonders why a swap didn't happen.

## Considered alternatives

### A. 90% trigger threshold (driver's original 4-line spec)

Discarded per §"Push-back" — math doesn't support it. 30min budget window vs 40min serial swap = exhausts mid-swap.

### B. Parallel swaps (instead of serial)

Discarded — thrash risk on shared fallback account; complicates failure recovery; gain in elapsed time (8 members in 5min vs 40min) is offset by O(8) concurrent shadow spawns straining tmux + the target account simultaneously.

### C. Spawn shadow lazily (only on next message to that member)

Discarded — adds latency to every member interaction post-swap-trigger; harder to verify swap success; doesn't preserve in-flight task continuity.

### D. Reuse existing paused-member as shadow

Discarded — breaks the "swap in PARALLEL; original stays paused as rollback" semantic. Reusing a paused member loses the rollback option.

### E. Auto-resume swap-back when original's account refreshes

Out of scope per driver brief. Future ADR if usage shows operator wants it.

### F. Migrate `claudeAccount` field to runtime-only state file

Considered. Discarded — `claudeAccount` is a member identity; team.json is the SoT. Runtime mutation IS allowed (member rows can be edited at runtime), but the SoT remains team.json. Swap writes the new `claudeAccount` back to team.json + uses atmux::jq_update for atomic write (matches existing dispatch pattern).

## Open questions

### OQ-1 — Shadow naming convention (low reversibility)

`<original>-swap` simple + greppable. If swaps stack (member already swapped → swap-back → swap-again), naming becomes `<original>-swap-2` etc. Trivially flippable (just the rename helper).

### OQ-2 — Should `atmux pause` on the original kill the tmux pane or keep it visible? (low reversibility)

Recommended: keep visible (pause = don't claim/dispatch; doesn't tear down the pane). Operator can read pane history + manually resume if desired. Matches existing `atmux pause` UX.

### OQ-3 — Member roster cleanup post-swap (medium reversibility)

After swap pass, the team has 2× members (original paused + shadow active). On budget-window-refresh, original could be unpaused — but then there are 2× workers, both potentially claiming. Recommended: explicit `atmux team rotate-back` verb or a follow-up "post-resume reconciliation" feature; out of scope for this ADR.

### OQ-4 — Excluded-role override flag (low reversibility)

Default excludes lead/planner/reviewer. If operator wants to swap planner anyway (e.g., during single-account exhaustion), `--include-role planner` flag on a manual `atmux account-swap` verb (verb itself is a follow-up; not in this ADR's first-wave). Trivial.

### OQ-5 — Probe staleness during swap (low reversibility)

Trigger detect uses cached probe (≤240s). The healthy-fallback-pick uses force-fresh probe. The actual swap then takes 2-5min. By the time member 6's swap fires, fallback could be ≤50% healthy. Recommended: re-probe before each individual swap; if fallback drifts above 50% during the pass, switch to next-priority fallback for remaining members. Trivial flip during impl.

### OQ-6 — Discord channel routing for swap events (low reversibility)

Use main team channel per existing convention. Operator can re-route via existing per-team Discord overrides if needed.

## Termination signals

`proposed → accepted` flip is gated on:

- ADR-053 (Fix C OAuth refresh + probe port) lands first — HARD DEPENDENCY.
- ADR-054 (Zod whip-config) lands — TeamWhip schema must include the swap-related fields.
- Reviewer-gate per commit.
- E2E test passes on synthetic 2-member swap scenario.
- Manual real-fire on a non-critical team to validate the math (75% trigger + serial swap fits the budget window in practice).

OQ-3 (member roster cleanup) is the only OQ that may need a follow-up ADR; the rest are code-shape.
