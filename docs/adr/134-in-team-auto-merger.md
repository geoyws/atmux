# ADR-134: In-team auto-merger via expanded gitter role — per-member-branch fan-in

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**EPIC**: t-51d2c635
**Driver-ref**: 2026-05-14 driver session — operator on the worktree caveat: *"we have to automate"*. Initial proposal placed merger at cockpit W4; operator pushed back with five locality-of-mutation arguments + an ADR-091 symmetry observation. This ADR captures the reframe.
**Filename note**: Task `t-63e3ddc2` body referenced `docs/adr/134-cockpit-merger.md` from the pre-reframe scope. The EPIC body (t-51d2c635) reframed the merger to live *in-team*, not at the cockpit; the filename here reflects the accepted scope. Old filename is not used.
**Amends**: ADR-091 §scope (clarifies the ADR-091 auto-merger applies to *sibling epic-team scope*, not intra-team per-member-branch fan-in). No state-machine collision — this ADR borrows ADR-091's shape and extends it; the two run at different nesting levels.

> **Implementation note (2026-05-15 — T4 / t-64e52aac)**: cron backstop sweep landed as `atmux gitter --sweep` per §triggers §cron-backstop-secondary. Verb lives at `src/verbs/gitter.ts`; pure eligibility-analysis core at `src/core/gitter-sweep.ts`. Sweep gates on `team.autoMerge.enabled === true`; consumes `MergerStateRepo` (T2 / t-b5f12ab1 prereq trunk-merged) to skip in-flight branches. `TeamAutoMerge` Zod schema lands the full §Config surface in the same commit so T6 gitter member impl + T7 cron-install template + T8 e2e read the canonical field set. The actual merge dispatcher (T3 / t-27b06cda event-driven, parallel work) is injectable — pre-T3, the verb wires a `recordingQueueMergeAttempt` stub that logs queue intent so the sweep emits useful cron-log evidence; T3 swaps the real dispatcher in. Sweep core unchanged either way. Cron line installation is T7's responsibility (t-a87a39f1).

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
5. **Cage tier alignment** — the merger needs Tier-1 git access (`merge`, `revert`, branch operations). A per-team cage member inherits Tier-1 naturally (per [ADR-058](058-cage-tier-naming.md) — every team-cage member is Tier-1 within its team). Cockpit-W4 would need an explicit Tier-1 carve-out at cockpit scope — an architectural smell, because the cockpit tier is otherwise read-only / dispatch-only.

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

### Conflict surface (3-way reliable)

When `merging → conflict` OR `test_failed → reverted` fires:

1. **Durable** — `state.db::merger_state.note = "conflict at <SHA>"` written FIRST (per the [reviewer pre-flag audit](.atmux/reviewer-preflag-ADR089-091.md#adr-091-auto-merge-state-machine--t-4af76f05) §2 — durable signal must precede the fire-and-forget surface).
2. **Operator-facing — atmux flag** — `atmux flag add --severity high "gitter: merge conflict on <base>-<member> at <SHA>"`.
3. **Operator-facing — Discord** — `[merge-conflict]` named template (per [/CLAUDE.md §Discord Message Format]) with 30-minute dedup window keyed on `<team>:<branch>:<SHA>`. Fire-and-forget; failure to deliver does not block the durable state write.

The lead pane picks up the `flag add` event via socket-pubsub (per ADR-032). Member receives `atmux send <member>` ping with the conflict location and the recovery sketch.

### Cage tier

Gitter inherits **Tier 1** naturally from its team-cage membership (per [ADR-058](058-cage-tier-naming.md) — every cage member at L2-team-level is Tier-1 within that team's repo). No new tier carve-out is needed. The merger's git ops (`merge`, `revert`, branch ops) run inside the gitter's worktree — the same Tier-1 boundary every team member already operates within.

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
- [ADR-058](058-cage-tier-naming.md) — cage tiering; gitter lives at team cage's Tier 1 naturally
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
