# ADR-134: In-team auto-merger via expanded gitter role — per-member-branch fan-in

> **⚠ PARTIALLY SUPERSEDED by [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) — 2026-05-24 (§Triggers cron-backstop half only; `committer --sweep` + paired `orchd --drain` cron lines retired). Remainder canonical: intra-team auto-merger design + `committer --daemon` path stay live.**

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**EPIC**: t-51d2c635
**Driver-ref**: 2026-05-14 driver session — operator on the worktree caveat: *"we have to automate"*. Initial proposal placed merger at cockpit W4; operator pushed back with five locality-of-mutation arguments + an ADR-091 symmetry observation. This ADR captures the reframe.
**Filename note**: Task `t-63e3ddc2` body referenced `docs/adr/134-cockpit-merger.md` from the pre-reframe scope. The EPIC body (t-51d2c635) reframed the merger to live *in-team*, not at the cockpit; the filename here reflects the accepted scope. Old filename is not used.
**Amends**: ADR-091 §scope (clarifies the ADR-091 auto-merger applies to *sibling epic-team scope*, not intra-team per-member-branch fan-in). No state-machine collision — this ADR borrows ADR-091's shape and extends it; the two run at different nesting levels.

> **Implementation note (2026-05-15 — T4 / t-64e52aac)**: cron backstop sweep landed as `atmux gitter --sweep` per §triggers §cron-backstop-secondary. Verb lives at `src/verbs/gitter.ts`; pure eligibility-analysis core at `src/core/gitter-sweep.ts`. Sweep gates on `team.autoMerge.enabled === true`; consumes `MergerStateRepo` (T2 / t-b5f12ab1 prereq trunk-merged) to skip in-flight branches. `TeamAutoMerge` Zod schema lands the full §Config surface in the same commit so T6 gitter member impl + T7 cron-install template + T8 e2e read the canonical field set. The actual merge dispatcher (T3 / t-27b06cda event-driven, parallel work) is injectable — pre-T3, the verb wires a `recordingQueueMergeAttempt` stub that logs queue intent so the sweep emits useful cron-log evidence; T3 swaps the real dispatcher in. Sweep core unchanged either way. Cron line installation is T7's responsibility (t-a87a39f1).

> **Implementation note (2026-05-16 — T9 / t-6987392a)**: cron-driven real merge dispatcher landed at `src/core/intra-team-merge-dispatcher.ts`. The `productionQueueMergeAttempt` factory builds a `QueueMergeFn` closure that walks the per-branch state machine via the shared `performMerge` driver (re-uses T2 `intra-team-merge.ts`), wrapped in `BEGIN IMMEDIATE` per ADR-134 §state-machine race-protection. Dispatcher walks `open → in_progress → ready_to_merge → merging → tested` synchronously within one cron tick (no event bus; cron cadence is the latency floor). Stops at `tested` — the `tested → merged | test_failed` test-gate decision is deferred to ADR-144 / future work; base IS advanced by the time we reach `tested` (the `git merge --no-ff` ran inside `merging`), so the operator-visible acceptance criterion is met. The recording stub (`recordingQueueMergeAttempt`) stays exported as a test seam only — verb-layer default flipped to the production dispatcher. Pre-merge gate (kanban open-task count, worktree clean, ahead-of-base, base-moved) resolves once per dispatcher invocation. Conflict surface is durable via the `merger_state.note` row (`performMerge` writes it inside the BEGIN IMMEDIATE transition); fire-and-forget operator notification awaits T5 (t-e9363607). T3's event-driven path (t-27b06cda) is unblocked at the dispatcher level — when the pubsub primitive (t-4f57c9e4) lands, T3's event handler will call the same `productionQueueMergeAttempt` factory without duplicating state-machine logic.

## Context

### Substrate — per-member-branch worktrees gave us parallelism

[ADR-082](082-worktree-isolation-per-member.md) introduced per-member git worktrees (`team.json::worktreeIsolation: true`); [ADR-084](084-worktree-per-member-branch-model.md) amended it to per-member *branch* (`<base>-<member>`) so git's worktree-branch refusal stops killing concurrent spawns. Together they unblocked 20+ member concurrency — the demo-week constraint that drove ADR-082 in the first place.

The atmux team itself runs at `worktreeIsolation: true` since 2026-05-12 (`t-e82c1d11`). Eleven members ship eleven parallel branches on top of `geoyws`. The substrate works.

### Observed bottleneck — manual fan-in is now the queue drain

With workers shipping commits to per-member branches concurrently, the *fan-in* — merging each `geoyws-<member>` back into `geoyws` — is now manual. The atmux team currently has:

- 4 EPICs in flight (ADR-085, ADR-086, ADR-087, ADR-088 chains + ADR-089/093/094 finishing).
- ~25 commits/hour expected during heavy days (observed peak 2026-05-13: 14 commits in a 90-minute window).
- No member is the gitter for the atmux team — workers self-commit + push per [[feedback_atmux_no_gitter_worker_commits]]; the base branch `geoyws` falls behind every per-member branch until the driver hand-merges.

Manual merge is now the queue drain. Every `geoyws-<member>` branch drifts forward; lateral coordination (`whip-impl` needs `up-impl`'s ADR-094 work; `parity-cron-impl` needs `parity-state-impl`'s worktree-W6 fix) breaks because no member sees a sibling's work until the driver merges to `geoyws`. The fan-in is the bottleneck.

### Why ADR-091 doesn't cover this

[ADR-091 (pre-flag at `t-4af76f05`, draft pending impl)] specifies auto-merge for *epic-team* scope — a child epic-team's branch merging up into its parent team's base. That state machine is **sibling-scoped** (epic-team-as-child → parent-team-as-base). It explicitly does NOT cover **intra-team scope** (member-branch-as-child → team-base-as-base) — the operator's reviewer-pre-flag audit (`.atmux/reviewer-preflag-ADR089-091.md` §ADR-091) confirms this carve-out.

So per-member-branch fan-in needs its own ADR. This one.

### Why in-team, not cockpit (per operator pushback, captured in EPIC body)

The initial driver framing placed the merger at cockpit window 4 (fleet-wide, per-team-loop, single Tier-1 carve-out). The operator pushed back with five concrete arguments:

1. **Locality of mutation** — every merger op is scoped to ONE team's git repo (`git -C <teamRoot> merge geoyws-<member>`). No fleet-wide coordination required; cockpit placement creates artificial cross-team coupling.
2. **Symmetry with ADR-091 epic-team gitters** — epic-teams already have their own gitter living inside the epic-team cage, doing auto-merge cron. A per-team intra-team merger sits in the same architectural position, just at a lower nesting level. Symmetry across nesting levels is a virtue (one mental model for the whole tree).
3. **Failure isolation** — a cockpit-W4 outage freezes fan-in for every team. A per-team gitter outage only affects its team. Same reasoning that already pushed sopx to spawn its own gitter (`🐢gitter` at window 16) rather than relying on a fleet-wide merger.
4. **Account scoping** — cockpit-W4 needs claude-account switching per team (atmux=personal, sopx=ifca). A per-team gitter inherits the team's claude account naturally — no `gh auth switch` mutex contention (the exact footgun pre-flagged in [`.atmux/reviewer-preflag-ADR089-091.md`] §ADR-091 §3).
5. **Cage tier alignment** — the merger needs Tier-1 git access (`merge`, `revert`, branch operations). A per-team cage member inherits Tier-1 naturally (per ADR-058 (cage tier naming — no surviving ADR file) — every team-cage member is Tier-1 within its team). Cockpit-W4 would need an explicit Tier-1 carve-out at cockpit scope — an architectural smell, because the cockpit tier is otherwise read-only / dispatch-only.

The reframe collapses two open questions:

- *"Should the atmux team have a gitter?"* → **YES**, and it does auto-merge as its primary scope. Closes [[feedback_atmux_no_gitter_worker_commits]] (currently workers self-commit because no gitter exists; adding a gitter with auto-merge as its primary verb is the natural fix).
- *"Where does the merger live?"* → **In-team, as the (expanded) gitter** — symmetric with sopx's existing gitter and with ADR-091's epic-team gitter.

## Decision

### Expand the gitter role to cover intra-team auto-merge

The existing single-trunk gitter role (defined in `templates/briefs/gitter.md`) gains an **auto-detect mode switch** keyed on `team.json::worktreeIsolation`:

| `worktreeIsolation` | Gitter mode | Primary verb |
|---|---|---|
| `false` (default — legacy teams) | **Single-trunk commit-hygiene** | Compose commit message + commit on the shared base branch |
| `true` (post-ADR-082) | **Worktree fan-in** | Watch per-member-branch task-done events; auto-merge `<base>-<member>` into `<base>` |

Both modes coexist behind the same `gitter` member entry; the brief auto-routes based on `team.json` at gitter spawn time. **No new member role**; this is a scope expansion of an existing role.

### Cockpit topology — UNCHANGED

The initial cockpit-W4-merger framing is **DROPPED**. Cockpit retains its pre-ADR-134 shape:

- **W1** — superdriver
- **W2** — medic ([ADR-077](077-superdoctor-cockpit-role.md) + ADR-133 sibling)
- **W3** — martinet (ADR-132 sibling)
- **W4+** — per-team viewers (nested-attach)

No new cockpit window. No new cockpit Tier-1 carve-out. No fleet-wide merger cron at the cockpit layer.

### Per-team topology — atmux team gains a gitter member

Inside each team's cage tmux session (`atmux_<team>` on `/tmp/atmux-<team>/sock`):

- **W1** — driver
- **W2** — team-lead
- **W3+** — members — *including* a `gitter` member entry when `worktreeIsolation: true` OR when the team wants single-trunk commit hygiene

For the atmux team specifically: a `gitter` member entry lands in `.atmux/team.json` (sub-task T7). The gitter operates in **worktree-fan-in mode** because the atmux team has `worktreeIsolation: true`.

### State machine

The per-member-branch auto-merge runs through nine states. Eight inherit verbatim from ADR-091's epic-team state machine; one is new (`tested`) to gate the post-merge test pass. Transitions:

```
open                                 (initial — per-member branch exists, no done-task yet)
  └── task-done event ──▶ in_progress
                              │
                              │ all owner's tasks done + tree clean + ahead of base
                              ▼
                          ready_to_merge
                              │
                              │ base moved during member's work?
                              ├── yes ──▶ rebasing ──▶ ready_to_merge (after rebase clean)
                              │                    └── conflict ─▶ conflict (terminal)
                              ▼
                          merging
                              │  git -C <teamRoot> merge --no-ff geoyws-<member>
                              ├── conflict ────────▶ conflict (terminal — surface to operator)
                              ▼
                          tested
                              │  team.json::autoMerge.testCommand (default: bun test)
                              ├── pass ──▶ merged (terminal)
                              └── fail ──▶ test_failed
                                              │
                                              │ team.json::autoMerge.revertOnFail (default: true)
                                              ▼
                                          reverted (terminal — revert merge commit, surface to operator)
```

Terminal states: `merged`, `conflict`, `reverted`. From `conflict` or `reverted`, transition back to `in_progress` is **manual** — operator resolves, gitter re-claims on next event/cron tick.

All state transitions wrap in `BEGIN IMMEDIATE` SQLite transactions per the [pre-flag audit recommendation](.atmux/reviewer-preflag-ADR089-091.md#adr-091-auto-merge-state-machine--t-4af76f05) on ADR-091. State lives in `state.db::merger_state` rows keyed on `<team>:<base>-<member>`.

### Triggers

#### Event-driven primary

Socket-pubsub cascade ([ADR-032](032-socket-pubsub-messaging-layer.md)) on `atmux task move <id> done`. The gitter subscribes to its **own team's** pubsub socket — not cross-team. On a task-done event:

1. Gitter resolves the member-of-done-task via `task.owner` field.
2. Checks: all of member's other claimed tasks done? branch ahead of base? tree clean?
3. If yes, transitions `open → in_progress → ready_to_merge` and continues the state machine.
4. If no, returns to `open` (next done event will retry).

Event-driven gives sub-second latency on the common path.

#### Cron backstop secondary

`atmux gitter --sweep` runs from the gitter's own cron (installed at gitter member spawn, scoped to the team cage), default cadence 10 minutes. Sweep walks every per-member branch and re-evaluates the state machine. Backstop catches:

- Tasks that completed before the gitter subscribed (cold-start race).
- Socket-pubsub deliveries that the gitter missed (transient socket churn).
- Manual `git commit` on a member branch without an `atmux task move ... done` (operator hand-fix).

Cron cadence is `team.json::autoMerge.cronBackstopMin` (default 10).

> **§Amendment 2026-05-22 (II) (t-0542595c)** — Auto-re-entry from `merged` when the member branch has shipped MORE commits past the prior fan-in. Pre-amendment, `merged` was permanently terminal — long-lived members had to operator-reset `merger_state.state` manually after EVERY additional commit (memory `project_merger_state_merged_terminal_design_gap`, reproduced today on `atmux-geoyws-docs` immediately after the t-04694072 fan-in: commit c84e54e on docs branch sat at `state=merged` with `+1 ahead` until this fix landed). The original design comment "fresh `open` row after the branch is realigned to the new base" assumed branches were ephemeral (matches epic-team scope, not long-lived parent-team members). Post-amendment, the intra-team dispatcher checks `state=merged + aheadCount>0` at entry; on match it auto-transitions back to `open` with `transitioned_by='cron'` + `note='auto-re-entry: +N new commits past prior fan-in (§Amendment 2026-05-22 II)'` and continues the standard walk. `isValidTransition()` now explicitly permits `merged → open` to support this path (still rejects `merged → in_progress` and other forwards — the auto-reset goes through the open entry to keep the lifecycle predictable). **Carve-out**: `conflict` and `reverted` stay terminal per the original spec ("From conflict or reverted, transition back to in_progress is manual — operator resolves"). Epic-team fan-in (`verbs/epic-merge.ts`) is unchanged: epic-teams ARE ephemeral, so `merged` SHOULD stay terminal there. Regression test in `tests/unit/core/intra-team-merge-dispatcher.test.ts` ("cell 2c" updated + new "§Amendment 2026-05-22 (II)" case).

> **§Amendment 2026-05-22 (t-9aa2f8cb)** — Intra-team `ownerOpenTaskCount` gate semantics narrowed to **in-progress only**. Pre-amendment, the gate counted `todo + in-progress` tasks (matching the original spec phrase "all owner's tasks done" above); this structurally wedged long-lived parent-team members (docs / lead / reviewer / etc.) who continuously carry forward future todos: the gate was never satisfied, so cron `committer --sweep` cycled the state from `open → in_progress` forever and never reached `ready_to_merge`. Operators had to run a manual sqlite reset on `merger_state` every time fan-in was needed — reproduction: 2026-05-22 11:46 MYT `atmux-geoyws-docs` carried +8 ADR-status-flip + cockpit-fix commits stuck behind 9 future todos; gitter manual-merge bypass at trunk `d2040c7` (recovery task t-04694072). Post-amendment, only `status='in-progress'` rows owned by the member count toward the gate. Safety intent — "don't fan in mid-active-work" — is preserved by the `in-progress` signal alone, combined with the existing `worktreeIsClean` gate (uncommitted work never merges). **Carve-out**: epic-team fan-in (`verbs/epic-merge.ts`) keeps its original semantic ("count all non-`done` non-`wontfix` tasks"); for ephemeral epic-teams, all-tasks-done IS the epic-complete signal that fan-in is appropriate. The shared `shouldTransitionFromInProgress` reason-string (`"<N> open task(s) — owner still working"`) is unchanged — `ownerOpenTaskCount` is computed by the per-scope input resolver, so the gate's emitted reason remains accurate for both scopes (the count differs by scope; the wording is generic on purpose). Reader of the §State-machine diagram: the line "all owner's tasks done" above should be read as "all owner's in-progress tasks done" for the intra-team scope (kept as written for prose continuity; the code at `src/core/intra-team-merge-dispatcher.ts::resolvePreMergeGate` is the authoritative definition).

> **§Amendment 2026-05-18 (t-911c9314)** — Sweep candidate enumeration is roster-gated. After the `git branch --list "<baseBranch>-*"` glob, results are filtered to `<baseBranch>-<m>` where `<m>` is in `team.json::members[].name`. Non-member branches matching the prefix — operator safety backups (`<base>-planner-rebased-backup`), archived feature branches, epic-team fan-in branches (`<base>-epic-<id>` handled by [ADR-091](091-kanban-driven-auto-merge.md)'s `epic-merge` cron) — are dropped before the dispatcher sees them. Carve-out: empty `rosterMembers` reverts to the pre-amendment behavior (every prefix-matching branch is a candidate), so a misconfigured team.json with zero members doesn't silently drop every member branch on the floor. Driver of the amendment: 2026-05-17 `geoyws-planner-rebased-backup` got enumerated, transitioned `null → in_progress → rebasing`, then stranded 7h26m because the `rebasing → ready_to_merge` outer wiring (T3+T4 in `intra-team-merge.ts:357-364`) is not yet implemented — see [t-2b7572d7](../tasks/t-2b7572d7.md) for the deeper structural follow-up. The roster gate is the upstream defense; t-2b7572d7 closes the underlying wiring gap.

> **§Amendment 2026-05-18 (t-2b7572d7)** — `rebasing → ready_to_merge | conflict` outer-wiring shipped. The strand the prior amendment described is closed: `src/core/intra-team-rebase.ts::performRebase()` runs `git rebase origin/<base>` inside the member's worktree, transitions to `ready_to_merge` (clean, with new `baseSha` = post-rebase HEAD) or terminal `conflict` (capture porcelain conflict paths, fire `git rebase --abort`, write paths to `merger_state.note`). Dispatcher (`src/core/intra-team-merge-dispatcher.ts`) drives one rebase per cron tick max — when the walk enters `rebasing` it dispatches `performRebase` then breaks; the merge step (`ready_to_merge → merging → tested`) lands on the NEXT cron tick. Rationale for break-after-rebase: rebase can take seconds-to-minutes on large divergence; coupling it with the merge in one invocation doubles wall-clock cost of an already expensive operation and defeats the cron-cadence-as-latency-floor design. Missing-worktree fallback: when the verb-layer's `resolveMemberWorktreePath` resolver returns null (worktreeIsolation disabled, branch doesn't match `<base>-<member>` convention), the dispatcher transitions to terminal `conflict` with reason "cannot resolve worktree for <branch>" — better than silent strand. TOCTOU guard in `performRebase` re-reads state before transitioning so a sibling tick / operator reset that already advanced past `rebasing` returns concurrency-loss no-op. Entry-state refusal in the dispatcher was narrowed: `rebasing` is no longer refused at entry (the prior `if (entryState === "rebasing" || entryState === "merging")` only retains `merging`), so a row already wedged in `rebasing` from a pre-T3+T4 strand gets picked up + advanced on the next tick. `tested` / `test_failed` remain caller-driven — those are ADR-144 test-gate territory.

### Conflict surface (3-way reliable)

When `merging → conflict` OR `test_failed → reverted` fires:

1. **Durable** — `state.db::merger_state.note = "conflict at <SHA>"` written FIRST (per the [reviewer pre-flag audit](.atmux/reviewer-preflag-ADR089-091.md#adr-091-auto-merge-state-machine--t-4af76f05) §2 — durable signal must precede the fire-and-forget surface).
2. **Operator-facing — atmux flag** — `atmux flag add --severity high "gitter: merge conflict on <base>-<member> at <SHA>"`.
3. **Operator-facing — Discord** — `[merge-conflict]` named template (per [/CLAUDE.md §Discord Message Format]) with 30-minute dedup window keyed on `<team>:<branch>:<SHA>`. Fire-and-forget; failure to deliver does not block the durable state write.

The lead pane picks up the `flag add` event via socket-pubsub (per ADR-032). Member receives `atmux send <member>` ping with the conflict location and the recovery sketch.

### Cage tier

Gitter inherits **Tier 1** naturally from its team-cage membership (per ADR-058 (cage tier naming — no surviving ADR file) — every cage member at L2-team-level is Tier-1 within that team's repo). No new tier carve-out is needed. The merger's git ops (`merge`, `revert`, branch ops) run inside the gitter's worktree — the same Tier-1 boundary every team member already operates within.

This is one of the five reasons the in-team placement was chosen over cockpit-W4: cockpit would have required an explicit Tier-1 carve-out at cockpit scope, breaking the "cockpit is read-only / dispatch-only" architectural promise.

### Config — `team.json::autoMerge`

```json
{
  "autoMerge": {
    "enabled": true,
    "requireReviewerSignoff": false,
    "skipTestGate": false,
    "testCommand": "bun test",
    "revertOnFail": true,
    "cronBackstopMin": 10,
    "maxMergesPerHour": null
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` when `worktreeIsolation: true`; `false` otherwise | Master switch. `false` returns gitter to single-trunk commit-hygiene mode. |
| `requireReviewerSignoff` | `false` | v1 default. When `true`, gitter waits for a `reviewer-trunk-signoff` task (per the [pre-flag audit](.atmux/reviewer-preflag-ADR089-091.md#adr-090-epic-team-lifecycle--t-6f80c4cb) §1 marker convention — `task.role: "reviewer-trunk-signoff"`) on the member's branch before transitioning `ready_to_merge → merging`. Forward-compat for teams that want a reviewer gate on every fan-in. |
| `skipTestGate` | `false` | When `true`, skips `tested` state entirely (merging → merged directly). Escape hatch for teams whose `testCommand` doesn't apply (docs-only teams, archival-only repos). |
| `testCommand` | `"bun test"` | Resolves [OQ-1](#open-questions). Per-team override; e.g. sopx might use `"pnpm test:unit"`. |
| `revertOnFail` | `true` | Resolves [OQ-2](#open-questions). When `false`, gitter pauses at `test_failed` (no revert) and pings operator. Recommended `true` because revert-on-fail is safer than leaving a known-broken merge on base. |
| `cronBackstopMin` | `10` | Cron sweep cadence. Lower for high-throughput teams (5min); higher for low-throughput (30min). |
| `maxMergesPerHour` | `null` (no cap) | Resolves [OQ-3](#open-questions). `null` means uncapped; numeric value rate-limits gitter to N merges/hour to prevent thrash if conflicts cascade. Recommended unset for v1; revisit if conflict-thrash observed. |

`cockpit.json` gains **no new fields**. The cockpit-merger block from the initial framing is dropped entirely. Backward-compat: existing teams without the `autoMerge` block keep current behavior (workers commit + push their own branches; no auto-merge fires).

### Per-member-branch lifecycle after success

Resolves [OQ-4](#open-questions). On `merged` (terminal), gitter:

1. Verifies the member's branch tip equals the post-merge HEAD (sanity check).
2. **Does not delete the branch.** The branch is kept; the next task the member claims continues on the same branch.
3. Gitter re-aligns the branch to the new base via `git -C <teamRoot> worktree set-ref geoyws-<member> geoyws` (so the member's next commit lands cleanly).

Rationale: branch *deletion* would force `provisionWorktree` to re-create on the next claim (per ADR-084's create-or-reuse logic), which is wasteful when the branch is going to be reused anyway. **Keep + realign** is cheaper.

The member is notified via `atmux send <member> "[gitter] geoyws-<member> merged + realigned to <newSHA>; safe to continue"` so they don't get surprised by the silent base shift.

## Open questions

### OQ-1 — Post-merge test command default

`bun test` is the fleet-wide default. Per-team overridable via `team.json::autoMerge.testCommand`. Rationale: bun-test is the atmux-team's existing CI gate (per [.github/workflows/ci.yml](../../.github/workflows/ci.yml)); sopx uses pnpm-test; future projects can override. **Resolution**: default = `"bun test"`; explicit per-team override is the documented escape hatch.

### OQ-2 — Revert strategy on test fail

Three options:

- **(A) Revert immediately, then surface** — gitter runs `git revert <merge-commit>` automatically; operator receives a `[merge-reverted]` ping. Pro: base stays green at all times. Con: operator must manually re-fire the merge after fixing.
- **(B) Pause + ping, no revert** — gitter leaves the broken merge on base and pings operator for manual resolution. Pro: operator sees the failure context first-hand. Con: base is broken until operator acts.
- **(C) Configurable per-team** — `team.json::autoMerge.revertOnFail` boolean (default `true`).

**Resolution**: **(C) configurable with default true**. Most teams want a green base (A-behavior). Slow / docs-heavy teams that don't trust their test gate can flip to `false` (B-behavior).

### OQ-3 — Merger pace cap

If conflicts cascade (member A's merge unblocks member B's merge unblocks member C's merge), the gitter could fire N merges in a tight loop. A `maxMergesPerHour` cap would prevent thrash; without it, a bad batch could land 30 merges in a minute and exhaust resources.

**Resolution**: **field exists, default unset (no cap)**. Most teams' natural commit cadence is well below any reasonable cap. Field exists for slow / shared-CI teams to opt in (e.g. `5`/hour). v1 leaves it `null`; revisit if thrash observed.

### OQ-4 — Per-member-branch lifecycle after success

Two options:

- **(A) Delete + recreate** — branch deleted on `merged`; `provisionWorktree` recreates on next member-task claim.
- **(B) Keep + reuse** — branch retained; gitter realigns its ref to the new base; member's next commit lands cleanly on top.

**Resolution**: **(B) Keep + reuse**, with gitter realigning the ref. Cheaper (no worktree teardown/setup), simpler for the member (no surprise re-clone), aligned with how git's `worktree set-ref` is designed to be used. The realign notification (`atmux send <member>`) keeps the member informed.

## Sub-tasks (8) — reframed for in-team placement

| Task | Subject | Lane | Deps |
|---|---|---|---|
| **T1** | Draft ADR-134 spec (this doc) | docs / planner (pinch-hit reviewer) | — |
| **T2** | State-machine module (extract from ADR-091 OR sibling impl) | be | T1 |
| **T3** | Event-driven trigger via socket-pubsub cascade (subscribes to OWN team's pubsub) | be | T2 |
| **T4** | Cron backstop sweep (gitter's own cron from team cage; NOT cockpit-fleet sweep) | be | T2 |
| **T5** | Conflict surface 3-way (durable + flag + Discord) | be | T3 |
| **T6** | Gitter brief expansion — auto-detect `worktreeIsolation`, mode-switch, integrate merger logic | docs / be | T2 |
| **T7** | Add gitter member to atmux `team.json` + spawn integration | be | T6 |
| **T8** | e2e: synthetic 3-member team with gitter doing auto-merge | test | T6 + T7 |

T1 supersedes the original "draft cockpit-merger ADR" Task body. T6 / T7 replace the original "cockpit W4 integration" sub-tasks.

## Acceptance gates

- ADR-134 lands at `docs/adr/134-in-team-auto-merger.md` with Status: proposed. ✅ (this commit)
- ADR references: ADR-091 (sibling epic-team scope), ADR-082 + ADR-084 (worktree-isolation substrate), ADR-032 (socket-pubsub), ADR-058 (cage tier), [[feedback_atmux_no_gitter_worker_commits]] (gap closed). ✅
- Gitter brief at `templates/briefs/gitter.md` gains a "worktree-isolation mode" section (in T6); backward-compat for single-trunk teams retained.
- `atmux team.json` gains a `gitter` member entry (in T7); `atmux start` spawns the gitter window correctly.
- e2e proof (in T8): 3 parallel commits + auto-merge to base + 1 forced-conflict + 1 forced-test-fail-revert all green.
- Reviewer-gated commits across the chain (per [/CLAUDE.md §Reviewer / Audit Discipline]).

## Out of scope

- **Cross-team merge consensus** — deferred; ADR-091 epic-team scope and this ADR's intra-team scope cover the two nesting levels we need today.
- **Custom merge strategies per file** — deferred; `git merge --no-ff` default is sufficient for v1.
- **Auto-fan-in from team-base to main** — operator-driven only ([ADR-028](028-main-master-pr-only-no-agent-push.md) is fleet-wide; agents never push to main).
- **PR mode** — deferred (mirrors ADR-091 pre-flag §8). Schema may eventually gain `autoMerge.mergeMode: "auto" | "pr"`; v1 only implements `auto`.
- **Multi-account `gh` CLI mutex** — irrelevant under in-team placement (each team's gitter inherits one account naturally; the mutex was a cockpit-W4 concern).

## Cross-refs

- [ADR-091] — epic-team auto-merge (sibling at higher nesting level; reuses state-machine shape)
- [ADR-082](082-worktree-isolation-per-member.md) + [ADR-084](084-worktree-per-member-branch-model.md) — worktree-per-member-branch (substrate)
- ADR-058 (cage tier naming — no surviving ADR file) — cage tiering; gitter lives at team cage's Tier 1 naturally
- [ADR-032](032-socket-pubsub-messaging-layer.md) — socket-pubsub for task-done cascade
- [ADR-077](077-superdoctor-cockpit-role.md) — medic cockpit role (orthogonal; cockpit topology unchanged by this ADR)
- ADR-132 — martinet cockpit role (sibling cockpit concern; orthogonal)
- ADR-133 — medic sibling at cockpit (orthogonal)
- [ADR-063](063-cockpit-verb-port.md) — cockpit window order (confirms W1/W2/W3 unchanged)
- [[feedback_atmux_no_gitter_worker_commits]] — memory file the EPIC closes
- [`.atmux/reviewer-preflag-ADR089-091.md`] — pre-flag audit; state-machine + conflict-surface durability lessons borrowed from §ADR-091

## Reviewer pre-flag (for the next-stage audit)

Forward-flagged so the eventual T2-T8 reviewer (planner pair-review per t-cc4c5fd9 precedent) doesn't relitigate:

1. **Subscription scope** — gitter must subscribe to its OWN team's pubsub only. Cross-team subscription is a coordination footgun. T3 implementer: assert `socket-pubsub.subscribe(<own-team-socket>)`, refuse cross-team in the brief.
2. **`worktree set-ref` is destructive on dirty worktrees** — gitter must verify the member's worktree is clean before realigning. T2/T7 implementer: gate the realign on `git status --porcelain` empty.
3. **Cron backstop must not race the event-driven path** — when both fire on the same `<base>-<member>`, the second one must see `state.db` already at `in_progress`/`ready_to_merge` and no-op. State-machine transitions wrapped in `BEGIN IMMEDIATE` handle this; T2 implementer: don't bypass the transaction wrap on the cron path.
4. **`bun test` default may not exist on every team's repo** — gitter must fail-fast at spawn if `team.json::autoMerge.enabled === true` and `which $testCommand` returns non-zero. T7 implementer: assert at gitter brief paste-time, refuse with operator-facing message.
5. **Revert commit message** — gitter-authored revert commits must carry `Revert: <subject> — failed <testCommand> (gitter auto-revert per ADR-134 §revertOnFail)` so the git log is honest about why the revert happened. Avoids ambiguity later.

These five do not block T1 (this ADR); they're load-bearing for T2/T3/T7 implementers.

## T8 acceptance proof — `tests/e2e/merger.test.ts` (t-c607d9f1)

The EPIC's T8 acceptance proof lives at `tests/e2e/merger.test.ts`. It exercises the SHIPPED composition end-to-end against a real git repo + per-member worktrees + a real SQLite `merger_state` ledger:

| Beat | Asserts | Wrapper-stop state |
|---|---|---|
| B1 | Happy 3-merge sequential — 3 member branches walk to wrapper stop; base advances by ≥3 commits | `tested` (× 3) |
| B2 | Conflict path — colliding branch records `state="conflict"` in the ledger; base unchanged; member's branch retains the conflict commit | `conflict` |
| B3 | Caller-driven no-op short-circuit — re-tick on `tested` returns `changed=false` with `reason=/caller-driven/`; ledger row + base SHA unchanged | `tested` |
| B4 | Operator-reset + retry — manual `repo.transition({ next: "in_progress" })` post-conflict cleanup; next tick walks the post-reset branch to `tested` | `tested` |
| B5 | `merge-cycle` bulk fan-in — current trunk merges land cleanly (3 successful, push ok) but the ledger rows stay null (verb bypasses `MergerStateRepo` today); pinned as a contract assertion that flips when the T6/T8 bridge wires through | n/a (verb path) |

**Wrapper-stop vocabulary.** Happy path stops at `tested`, NOT `merged` — the `tested → merged` transition is the post-merge test gate driven by the T3+T4 outer dispatcher (still todo). The merge itself has already landed by the time the wrapper reaches `tested` (`mergeMember` runs during `merging → tested`); the ledger just hasn't been advanced to `merged` yet.

**Deps NOT yet shipped — explicitly skip-documented in the spec header**:

- **T3 (`t-27b06cda`)** socket-pubsub event-driven trigger on task-done. Original task body's Beat 3 ("event-driven path: 3 parallel happy commits → merge-queued event published within 1s") needs this dispatcher. Until T3 lands, the cron-backstop sibling path (T4, done) is the production fallback — same `performMerge` call site, different fire-source. The e2e exercises `performMerge` direct + via `mergeCycle`; the event-driven cascade is the T3-shipping-Task's e2e responsibility.
- **T5 (`t-e9363607`)** conflict surface — `atmux send <member> ...`, `[merge-conflict]` Discord template, `atmux flag add`. Original task body's Beats 5+7 require T5 to assert the FAN-OUT side of conflict/test-fail handling. This e2e asserts the LEDGER side (state.db `merger_state` row with `state="conflict"`), which is what every T5 surface reads from. T5's e2e covers the renders + sends + flag write.
- **Post-merge test-fail revert path** (Beat 7) — `performMerge`'s `test_failed` / `reverted` branches are caller-driven (per `intra-team-merge.ts:370-374`); they wait on T3+T4 wiring to run `bun test` after merge + auto-revert on red. The state machine accepts the states; the bun-test invocation + auto-revert composition isn't a unit-of-T8.
- **Cockpit-W4 merger pane** — superseded by the EPIC reshape (see §"Why in-team, not cockpit" above). Original task body predates the reshape; the cockpit-W4 fixture is no longer applicable.

Test result: `bun test tests/e2e/merger.test.ts` → 5 pass / 0 fail. Typecheck green. Single commit. Reviewer-gated.


## Amendments

### 2026-05-17 — Role-type identifier renamed `gitter` → `committer` (ADR-159)

The role type identified as "gitter" throughout this ADR is renamed to "committer" per [ADR-159](159-gitter-to-committer-rename.md) — SV/Reddit-eng register sweep + OSS-canon vocabulary alignment, supersedes nomenclature only. Design preserved verbatim — the expanded auto-merger fan-in semantics (single-trunk + auto-merge modes, 9-state machine + `tested` carve-out, socket-pubsub + cron backstop, `[merge-conflict]` Discord template) all stay as canonical in this ADR's §Decision. The `TeamMember.role` enum accepts both `"gitter"` and `"committer"` for one release with deprecation-warn (schema-level shim per ADR-159 TR3, `.transform()` canonicalizes `gitter` → `committer` on parse). Member id stays `"gitter"` forever per ADR-136 immutability — branch `<base>-gitter`, worktree path, kanban owner are stable across the rename. Brief filename rename: `templates/briefs/gitter.md` → `templates/briefs/committer.md` (TR4); source files renamed in TR2 (`src/verbs/gitter.ts` → `src/verbs/committer.ts`, `src/core/gitter-sweep.ts` → `src/core/committer-sweep.ts`). See ADR-159 for rename mechanic + rationale; the §Decision section of this ADR remains the canonical in-team auto-merger design (now under the new role-type name).

### 2026-05-19 — Intra-team merger is the SOURCE-of-truth test layer (test-trust principle, t-afcc71af)

Driver finding 2026-05-19 06:30 MYT codifies a doctrine implicit in this ADR's §State machine: the auto-merger's `merging → tested` transition runs `team.json::autoMerge.testCommand` (default `bun test`) on the merged SHA, and the resulting `test_outcome` ("pass" / "fail") is the **authoritative test verdict for this branch's content**. Downstream layers (epic-team fan-in via [ADR-091](091-kanban-driven-auto-merge.md) → parent base) **trust this verdict and do NOT re-run tests by default** ([ADR-144](144-epic-team-test-gate.md) §Amendment 2026-05-19: `testGateMode: "skip"` is the doctrine default for fan-in).

**Implication for this ADR's design**: there is no "downstream re-test that protects against a flaky L1 pass". Once the auto-merger records `test_outcome: "pass"`, the merge commit ships and the dispatchDissolve / fan-in chain reads that as ground truth. The `team.json::autoMerge.revertOnFail` (default true) handles the FAIL side at this layer — `tested → test_failed → reverted` walks the merge back **before** the L2 fan-in ever sees the branch. Flake-mitigation belongs at this layer (retryOnFlake, deterministic seed, etc.) — adding L2 re-test would create the false-fail revert wedge the test-trust principle exists to prevent.

**Reviewer surface** — if a committer or merger code path is observed re-running tests at a layer above this one (parent-side fan-in tick growing its own `bun test` invocation), file `atmux flag add --severity high --subject "[committer/epic-merge] L2 re-test violates ADR-134 §Amendment 2026-05-19 test-trust principle"`. Brief carrier: [`templates/briefs/committer.md`](../../templates/briefs/committer.md) §Test-trust principle.

**Filed via** t-afcc71af (P1 doctrine clarification, 2026-05-19).

### 2026-05-24 — Sweep IN_FLIGHT_STATES no longer includes `ready_to_merge` (post-rebase-break recovery, gitter wedge session)

The cron sweep's `IN_FLIGHT_STATES` set (`src/core/committer-sweep.ts`) initially included `"ready_to_merge"` alongside `rebasing`, `merging`, `tested`, and `test_failed`. Combined with §Amendment 2026-05-18 (t-2b7572d7) — "one rebase per tick max — the merge step (`ready_to_merge → merging → tested`) lands on the NEXT cron tick" — this produced a deadlock for any branch that needed a rebase: the dispatcher would rebase, transition the row to `ready_to_merge`, and break out of the walk; the next sweep tick would see `ready_to_merge` in `IN_FLIGHT_STATES` and self-skip with `action=skipped-in-flight, note="another tick is moving this branch"` — even though no other tick actually was. With no `task.done` event to wake the daemon's dispatcher path (idle teams, post-base-commit moments without new task activity), the merge sat indefinitely; operators had to reset `merger_state.state` to `open` by hand to re-enter the walk.

**Reproduction** (2026-05-24 09:00–09:25 MYT gitter bootstrap session): driver landed 5 commits on `atmux-geoyws` between 09:00 and 09:05, clearing a dirty-base window. `atmux-geoyws-reviewer` (+2 commits ahead) auto-rebased per §Amendment 2026-05-18 and parked at `ready_to_merge`. Three back-to-back `atmux committer --sweep` invocations all reported `action=skipped-in-flight, observedState=ready_to_merge`. `atmux committer --drain` also no-op'd (the gitter consumer's `withIdempotency` loop saw new events but the dispatcher refused at entry-state). Recovery required state.db surgery (`UPDATE merger_state SET state='open' ... WHERE member_branch=...`) — exactly the operator-toil the auto-merger exists to eliminate.

**Resolution**: drop `"ready_to_merge"` from `IN_FLIGHT_STATES`. The dispatcher-level `CALLER_DRIVEN_STATES` set (`src/core/intra-team-merge-dispatcher.ts`) — which IS the authoritative "do not re-enter" gate — never included `ready_to_merge`; only `tested` and `test_failed` are dispatcher-side terminal-for-the-walk. Sweep re-entry from `ready_to_merge` walks `ready_to_merge → merging → tested` cleanly under the same BEGIN IMMEDIATE wrap that protects all other transitions. The rare event/cron race (a `task.done` firing at the same instant the sweep re-enters) is handled by the existing TOCTOU guards in `performMerge` (re-read state before transitioning; concurrency-loss → no-op).

**Carve-out preserved**: `rebasing`, `merging`, `tested`, `test_failed` all stay in `IN_FLIGHT_STATES`. `rebasing` and `merging` mean a sibling tick is actively running `git rebase` / `git merge` (true in-flight); `tested` and `test_failed` are caller-driven for the ADR-144 test-gate wiring (operator/test-runner owns the next transition).

**Reviewer surface** — any future expansion of `IN_FLIGHT_STATES` should justify the addition against the dispatcher's `CALLER_DRIVEN_STATES` set. Sweep's job is eligibility analysis; it MUST NOT refuse a state the dispatcher would happily enter — that pattern is precisely the gate this amendment closes (and the t-f4088323 `in_progress` amendment closed before it). Brief carrier: [`templates/briefs/committer.md`](../../templates/briefs/committer.md) §Operating mode (auto-detected from team.json).

**Filed via** gitter wedge-recovery session 2026-05-24 09:00–10:00 MYT (atmux team auto-merge bootstrap).
