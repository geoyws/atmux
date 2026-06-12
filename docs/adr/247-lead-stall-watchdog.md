# ADR-247: Lead-stall watchdog — `story.ready` routable event + idle-lead wake substrate

**Status**: accepted (proposed 2026-05-28 after mx-root cross-cage complaint c-b2c8418e surfaced the gap; **accepted 2026-06-09** — George directed Phase-1 implementation as an [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) §D6b "5-min health nudge" quick win. Phase-1 scope + deferrals + a §D4 verb correction in §Amendment 2026-06-09 below.)
**Date**: 2026-05-28
**Driver-ref**: 2026-05-28 — mx-driver filed c-b2c8418e (also filed locally as c-cd993df8 in mx-root before ADR-150 routing impl): agile loop stalls at the lead after planner decomposition. Stories advance `planning → ready` but leads then sit idle 10+ minutes with empty composers; no stall-watchdog wakes them. Members ping the lead with "kanban dry: 0 stories, 0 tasks for epic <eid>" — the message arrives in the lead's composer but the lead never processes it. Only operator-manual nudge with concrete story-ids + dispatch targets resumes flow. Verified mx-root today across e-4 / e-5 / e-6.

**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker substrate — the events bus this ADR adds a topic to + a consumer on), [ADR-203](203-event-topic-taxonomy.md) (event-topic taxonomy — `story.ready` is the new topic this ADR adds), [ADR-210](210-eliminate-hold-posture-deadlock-structurally.md) §Tier 1 (lead bootstrap doctrine — same theme: don't let leads sit idle on actionable work), [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) (sentinel retire → honker consumers — established the "observation = honker consumer" pattern; this ADR adds another consumer of that flavor), [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) §D2 (canonical lead-gated destructive-action pattern — this ADR is the NON-destructive ping flavor; pattern still applies for the message-format discipline), [ADR-218](218-auto-fold-in-verb-and-lead-auto-drive.md) (lead-auto-drive — ADJACENT: that ADR is fold-in-after-SAFE-DISSOLVE; this ADR is dispatch-on-story-ready; both are lead-stall closers at different stages of the lifecycle), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) / [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) (orchd auto-spawn — closes the parent-side analog of this gap: spawn-epic on epic-ready; this ADR closes the in-cage analog: dispatch-on-story-ready), [ADR-246](246-per-cage-orchd-autostart.md) (per-cage orchd autostart — prerequisite: the watchdog runs as a consumer inside the cage's orchd; without ADR-246 the consumer has no host)

## Context

### Reproduced today (2026-05-28 mx-root)

3 freshly-spawned epic cages — e-4-0f173e5b Rewards / e-5-3a7c6f57 Points / e-6-742fd2bb Responsive — all exhibited the same stall:

1. Bootstrap completed normally (per c-3f066182 double-Enter workaround + per c-dee78b11 manual orchd-start).
2. Planner in each cage decomposed the epic into stories and advanced them `planning → ready` (e-4: 2 stories, e-5: 3 stories, e-6: 4 stories — verified via `atmux story list --epic <eid>`).
3. **Leads then went IDLE.** Composers empty, no thinking spinner, no follow-up action — for 10+ minutes.
4. Members (be-* / fe-*) sat with empty kanbans. At least one (be-1 in e-5) actively pinged the lead with `kanban dry: 0 stories, 0 tasks for epic e-5-3a7c6f57` — the message arrived in the lead's composer but the lead never processed it.
5. Orchd was running in each cage with the lane-router consumer registered (e-4) or pending first event (e-5 / e-6); events queue had ready stories but no dispatcher ran.
6. Result: zero dispatch events, zero claims, zero commits beyond one operator-driven FE commit on e-4 (`63fec42 — author 'George Yong'`, committed before the planner finished decomposing, so it bypassed the agile flow entirely).
7. The flow only re-started after MANUAL operator nudge to each lead pane with explicit story-ids + dispatch targets — at which point all 3 leads immediately began thinking (Gusting / Forging / Julienning).

### Distinct from sibling complaints

- **NOT c-3f066182 (verified-send Enter)** — TUI input layer; messages arriving in the composer here are evidence input is healthy.
- **NOT c-dee78b11 → ADR-246 (per-cage orchd missing)** — even with a per-cage orchd running, the agile loop stalls because `story.ready` doesn't surface as a routable event. ADR-246 closes the events-consumer half; this ADR closes the wake-signal half.
- **NOT ADR-218 (auto-fold-in)** — that ADR is the lead-stall closer at `SAFE-DISSOLVE → merge + dissolve`. This ADR is the lead-stall closer at `story.ready → dispatch`. Different stage of the lifecycle.

### Root cause

The agile-FLOW layer has no autonomous trigger that converts `story.status = ready` into a lead dispatch:

- The planner emits `story.added` / story-status-change events into honker-events, but per ADR-203 §taxonomy, `story.ready` is **not currently a registered topic**. Members emit `task.unclaimed` for explicit tasks the lead has already dispatched — but stories sitting `ready` with no dispatch yet are not in that stream.
- The lane-router subscribes to `task.unclaimed` (per ADR-202 §IX-A lean-dispatch contract) — but with no `task.unclaimed` for the un-dispatched ready stories, lane-router stays dormant.
- The lead is supposed to BE the trigger that reads `story.ready` and dispatches — but receives no wake signal. They are effectively waiting forever for an input that never comes.

### Why not "lead just polls kanban every N minutes"

Two reasons:

1. **Polling at the agent layer burns tokens and operator cost** — every cron-poll wake is a full agent turn. The whole arc from ADR-211 (sentinel-retire) to ADR-240 (orchd-self-supervise) has been moving away from polling toward event-driven consumers. A lead-side cron-poll regresses that arc.
2. **Lead doesn't know when to STOP polling.** Once the kanban is drained, the lead needs to quiesce; with a poll, it keeps waking. Event-driven gives the lead a clear contract: "wake on these specific topics; when no event lands, sleep."

## Decision

### D1 — `story.ready` becomes a registered topic in ADR-203 taxonomy

[ADR-203](203-event-topic-taxonomy.md) §taxonomy adds `story.ready` to the registered-topics list with:

- **Emitter**: planner (when a story transitions `planning → ready` via `atmux story advance --to ready` or equivalent).
- **Payload**: `{ epicId, storyId, lane, assigneeHint?, body }`.
- **Vocabulary contract**: `story.ready` is fired ONCE per story-ready transition; not re-fired on subsequent reads of the same row. Idempotency invariant per ADR-202 §IX-A.
- **Companion events** (added in same ADR-203 amendment): `story.unclaimed` (story.status = ready AND no claimant after N minutes) and `story.advanced` (any other status transition — observational, low-priority).

### D2 — Per-cage orchd (per ADR-246) registers a `lead-stall-watchdog` consumer

The watchdog is a consumer registered in `<cage>/.atmux/state.db::honker_subscriptions` with:

- **Subscriptions**: `story.ready`, `story.unclaimed`, `task.unclaimed` (the last one already exists in lane-router; this is a parallel subscription with a different handler, not a sibling-channel competitor).
- **Handler**: on event arrival, evaluate the wake conditions (§D3); if any fire, send a CONCRETE ping to the lead pane (§D4).
- **Lifecycle**: starts/stops with the per-cage orchd. Per ADR-246 §D5 default consumer set, the watchdog is part of the cage's baseline consumer profile.
- **Idempotency**: per-event handler is at-least-once delivery per ADR-202 §III; the ping itself is rate-limited via §D5 to prevent spam on repeated event re-delivery.

### D3 — Wake conditions

The watchdog fires a ping to the lead pane when ANY of the following hold:

- **W1 (ready-stories-no-claimant)**: ≥ 1 story with `status = ready` AND no claimant in the kanban view for ≥ N minutes (default N=5).
- **W2 (unclaimed-tasks)**: ≥ 1 task with `status = unclaimed` in the queue for ≥ N minutes (default N=5).
- **W3 (composer-idle-plus-actionable)**: lead pane composer empty + no thinking spinner + `lead.last_user_turn_age > N` minutes (default N=5) AND (W1 or W2 true).

W3 is the strongest signal — composer-idle WITH actionable work, the lead is definitionally stuck. W1 + W2 cover the case where the lead's pane state is hard to introspect (no pane-state-verb available; pane-content polling racy per ADR-155 §pane-state proposed/deferred).

All three conditions are evaluated at event-arrival (event-driven primary trigger) AND on a low-frequency cron-backstop (every 10 minutes, second-tier safety net per the ADR-134 two-trigger pattern).

### D4 — Ping format: CONCRETE dispatch, not generic "check your kanban"

When a wake condition fires, the watchdog sends to the lead pane (via `atmux tell-lead` per ADR-098 send-keys discipline + ADR-205 bracketed-paste):

```
🔔 [lead-stall-watchdog] Idle for >5min with actionable work in epic <eid>:

Ready stories (W1):
  • s-<id1> [lane=be] — <title> — dispatch: atmux dispatch s-<id1> --to be-1
  • s-<id2> [lane=fe] — <title> — dispatch: atmux dispatch s-<id2> --to fe-1

Unclaimed tasks (W2):
  • t-<id3> [lane=docs] — <title> — dispatch: atmux dispatch t-<id3> --to docs-1

Next action: dispatch the ready items, or `atmux story unready s-<id>` if blocked.
```

**Concrete > generic**: story IDs, lane assignments, the next verb to run. NOT "check your kanban". The whole reproduction today turned on this distinction — the operator's manual nudge worked precisely because it listed concrete IDs + dispatch targets; the be-1 message "kanban dry" did not work because it required the lead to do the look-up themselves.

The ping body is templated per ADR-086 verdict-first Discord-style discipline applied to lead-pane prose: 🔔 marker, ≤6 bullet lines, each ≤80 chars, named template.

### D5 — Ping rate-limit + escalation

- **Per-cage rate-limit**: ≤ 1 ping per 5 minutes per cage. Per-event re-delivery (at-least-once contract) does not multiply pings.
- **Backoff on no-ack**: if the lead does not progress (no new event from the lead's pane in the next 15 min) after a ping, escalate ONCE to the parent's driver-inbox via `atmux tell-lead --escalate` (uses the existing ADR-150 cross-cage routing once that lands; until then, falls back to local driver-inbox + stderr warning).
- **No third tier**: per operator's simplification arc (ADR-211 / 212 / 213 / 214 retire-overlapping-roles), the watchdog does not have a "page the operator" tier. Operator visibility comes via doctor reports + cockpit-mirror per ADR-230.

### D6 — Operator-facing controls

`team.json::lead_stall_watchdog`:

```ts
{
  enabled: z.boolean().default(true),       // off-switch
  idleThresholdMin: z.number().int().min(1).max(60).default(5),
  rateLimitPerCageMin: z.number().int().min(1).max(60).default(5),
  escalationDelayMin: z.number().int().min(5).max(120).default(15),
}
```

Defaults are the recommended values. Operators on lean-mode (ADR-189) may want longer thresholds; the schema permits ≥ 60min for "very lazy" cages, but the default reflects active-development cadence.

### D7 — Doctor probe

`atmux doctor` (per ADR-077 → ADR-186 wedge-clearing) gains a probe class:

**Probe: `lead-stall-watchdog-consumer-present`**

For each active epic cage in the cockpit registry: verify the watchdog is registered as a consumer in the cage's honker-subscriptions, AND the orchd binding to that DB is live (depends on ADR-246 §D3 orchd-window-present probe).

Verdict: `green` (consumer registered + orchd alive), `yellow` (consumer registered, orchd not running — depends on ADR-246 §D3 remediation), `red` (consumer missing — auto-register via orchd's startup consumer-set per ADR-246 §D5).

## Open Questions

- **OQ1**: Should the watchdog fire pings to the **planner** (not just the lead) when the wake condition is "no stories at all in kanban + epic body has un-decomposed items"? Recommend: yes, as a Phase 2 extension. Phase 1 is lead-only. Planner-stall is a less-frequent failure mode (planner usually does its work in one shot); cover it after the lead-stall case is stable.
- **OQ2**: Member-stall (member with claimed task + no commit in N minutes) — same watchdog or separate? Recommend: separate. Member-stall has a different signal vocabulary (commit cadence per ADR-166 autonomy policy) and the appropriate response is rotation per ADR-212 lead-gated rotation pattern, not a dispatch ping. Separate ADR if/when the case materializes; not blocking ADR-247.
- **OQ3**: Should `story.ready` event carry the lane-assignment hint, or should the watchdog look it up from kanban at ping-time? Recommend: ping-time lookup. Event payload stays slim; lane-assignment can change between emit + handle (e.g. operator manually reassigns); look-up at ping-time always reflects the current state.

## Implementation epic

Bundled with [ADR-246](246-per-cage-orchd-autostart.md) in EPIC `e-cage-agile-self-sustain` (filed 2026-05-28). Shared acceptance test: spawn-epic → bootstrap → walk away 10 min → members claiming + committing without operator intervention.

## Related complaints

- **c-b2c8418e** (atmux DB) — operator-filed 2026-05-28 12:13 MYT. This ADR closes it.
- **c-cd993df8** (mx-root DB) — mx-driver-filed 2026-05-28 11:42 MYT; resolved 12:05 MYT pointing to this ADR (misrouted into mx-root DB due to ADR-150 routing gap).

## Amendment 2026-06-09 — Phase-1 implementation (accepted)

Implemented as a [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) §D6b quick win (George 2026-06-09). The watchdog is a deterministic, no-LLM orchd consumer — it reuses the existing kanban + emit substrate and the `decide*`-pure-function pattern (sibling: `src/core/lane-stall.ts`).

**Landed (Phase-1 scope):**
- **D1 topics** — `story.ready` + `story.unclaimed` added to `src/schema/events.ts` (the closed v1 topic set + the discriminated union, per ADR-203 §D2). `story.advanced` deferred (D1 itself flags it observational/low-priority).
- **D1 planner emitter** — `src/core/story.ts::advanceStory` emits `story.ready` once on the `planning → ready` transition (best-effort, post-commit, mirroring the `epic.ready` precedent in `src/core/epic.ts`). Once-per-transition is structural (the `cur === resolved` no-op early-return + the `cur === "planning"` gate).
- **D2 consumer** — `src/core/lead-stall-watchdog.ts` (pure `decideLeadStall` + ping format + rate-limit state), registered in `src/core/orchd-bootstrap.ts` on `story.ready`/`story.unclaimed`/`task.unclaimed`, gated on `team.leadStallWatchdog?.enabled !== false`; production wiring in `src/verbs/orchd.ts`.
- **D3 wake conditions** — W1 (ready story, no owner, idle ≥ `idleThresholdMin`) + W2 (unclaimed/lane-tagged-todo task, no owner, idle ≥ threshold). **W3 deferred** (composer-idle introspection is racy and has no clean pane-state seam in a consumer — ADR-155 §pane-state deferred).
- **D4 ping** — concrete dispatch list with real kanban-sourced ids + lanes + lowest-indexed roster target.
- **D5 rate-limit** — ≤ 1 ping per `rateLimitPerCageMin` via `<atmuxDir>/state/lead-stall-watchdog.json` (`lastPingSec`, recorded BEFORE send → fail toward fewer pings); at-least-once re-delivery within the window sends no second ping.
- **D6 config** — `team.json::leadStallWatchdog` (`enabled`/`idleThresholdMin`/`rateLimitPerCageMin`/`escalationDelayMin`) added to the Team Zod schema.

**§D4 verb correction:** D4's illustrative dispatch verb `atmux dispatch s-<id> --to be-1` does **not exist** — `src/verbs/dispatch.ts` is member-first: `atmux dispatch <member> <task-id>`. The implementation renders the real form (rendering D4's would emit an un-runnable command). D4's example above is illustrative-only; the shipped ping uses `atmux dispatch <member> <id>`.

**Deferred to a follow-up (with code comments citing the section):** W3 (above); **D5 no-ack escalation** (`tell-lead --escalate` to the parent driver-inbox depends on ADR-150 cross-cage routing, not landed — watchdog stays single-tier); **D7 doctor probe** (depends on the ADR-246 cockpit registry to enumerate active cages).

Verification: tsc 0; touched-test sweep + full suite green; `decideLeadStall`/rate-limit/ping are real (tests prove below-threshold does not fire, at/above does, and a second delivery within the rate-limit window emits no second ping — not no-op stubs).
