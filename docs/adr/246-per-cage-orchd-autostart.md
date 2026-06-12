# ADR-246: Per-cage orchd autostart on `spawn-epic` and `atmux up`

**Status**: Proposed (operator-fired 2026-05-28 12:18 MYT in driver session after mx-root cross-cage complaint surfaced the gap; complaint c-3787ee5c)
**Date**: 2026-05-28
**Driver-ref**: 2026-05-28 — mx-driver filed c-3787ee5c (also filed locally as c-dee78b11 in mx-root before ADR-150 routing impl): spawn-epic creates the worktree + team.json + tmux cage but does not start an orchd inside the epic's local `.atmux/state.db`. Each epic cage has its own state.db; members publish `task.unclaimed` / `task.done` etc. but with no consumer registered nothing actuates. Operator-manual `nohup atmux orchd --start &` inside each worktree instantly registers `atmux:lane-router` and starts chewing the backlog. Verified across 3 freshly-spawned mx-root epic cages today (e-4 / e-5 / e-6).

**Cross-refs**: [ADR-090](090-epic-team-lifecycle.md) (`spawn-epic` lifecycle — the verb being extended), [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker substrate — the events bus that requires a per-cage consumer), [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) (sentinel retire → honker consumers — established the "events-need-consumers" doctrine), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) (orchd rename + auto-spawn loop — ADJACENT: that ADR is about the PARENT's orchd calling spawn-epic; this ADR is about the CHILD cage running its own orchd), [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) (orchd auto-spawn / solo-worker dissolve handlers — same parent-side scope as ADR-224; sibling), [ADR-232](232-orchd-cross-cage-dispatcher-seam.md) (cross-cage dispatcher seam — proposed; not a substitute for per-cage orchd: cross-cage RPC ≠ in-cage event consumption), [ADR-236](236-three-tier-orchd-supervision.SUPERSEDED.md) §Superseded → [ADR-240](240-drop-superorchd-orchd-self-supervises.md) (orchd self-supervises — per-cage orchd inherits this property; no superorchd needed), [ADR-241](241-atmux-start-preflight-deps-wizard.md) (`atmux start` preflight — sibling startup-discipline ADR; this ADR extends the doctrine to `atmux up` on a worktree), [ADR-242](242-atmux-shutdown-fleet-teardown-verb.md) (`atmux shutdown` — symmetric teardown: per-cage orchd is reaped on cage dissolution per ADR-090 + ADR-227)

## Context

### The orchd-per-database invariant (per ADR-202 substrate)

[ADR-202](202-honker-in-db-messaging-substrate.md) §IX-A established the lane-tick dispatch contract — events live in `<cage>/.atmux/state.db::honker_events`, consumers register against that DB, the registry persists per-consumer offsets, the consumer chews events forward. Each `.atmux/state.db` is a **physically distinct SQLite file**; an orchd process bound to DB-A cannot see DB-B's events. That's the substrate invariant.

[ADR-090](090-epic-team-lifecycle.md) created a **separate `.atmux/` per epic-team** (verified today: `/root/work/ifca/src/mx-root-epics/e-4-0f173e5b/.atmux/state.db` is a distinct DB from `mx-root/.atmux/state.db`). Members in the epic cage emit events into the **epic-cage-local** DB. The parent's orchd (running against `mx-root/.atmux/state.db`) is bound to a different file — it cannot consume from `mx-root-epics/e-4-.../.atmux/state.db`.

### The missing half

`atmux team spawn-epic` currently:

1. Creates the worktree at `<parent>-epics/<eid>/` (per ADR-090 §lifecycle).
2. Writes `team.json` (symlinked to operator dotfile per ADR-244 §Supersession-2026-05-26).
3. Creates the cage tmux session + spawns the role panes (lead, members, driver).
4. **Does not start an orchd inside the cage.**

`atmux up` (the verb that brings up a cage's tmux session against an existing project root) likewise:

1. Probes for an existing tmux session, attaches if present, else creates.
2. Re-spawns the role panes if absent.
3. **Does not start an orchd against the project's `.atmux/state.db` either.**

The parent team's orchd (started by `atmux start <parentTeam>` per ADR-224 Phase 1) lives in the parent's tmux session against the parent's DB. It is **not** a multi-DB consumer; the parent orchd's `subscriptions[]` are registered in `<parent>/.atmux/state.db::honker_subscriptions`, not in the epic cage's DB.

### Observed effect (2026-05-28 mx-root)

Reproduced today across e-4-0f173e5b (Rewards), e-5-3a7c6f57 (Points), e-6-742fd2bb (Responsive):

- Sequence: `atmux team spawn-epic` + `atmux up` + brief-submit + members bootstrap.
- After bootstrap, `atmux orchd --status` inside each epic worktree printed `no consumers yet — orchd hasn't processed any events` despite the planner having decomposed 2-4 stories per epic and emitted task.unclaimed events.
- Manual `nohup atmux orchd --start &` inside each worktree: orchd registers `atmux:lane-router` consumer, processes the backlog (e-4 picked up 3 task.unclaimed within 2s of start).
- Backlog stayed unconsumed for 10+ minutes before the manual nudge. Members in be-* / fe-* lanes sat with empty kanbans because the lane-router that would have routed them tasks was not running in their cage.

### Independence from sibling failures

This complaint is **architecturally distinct** from c-cd993df8 → ADR-247 (lead-stall watchdog) — even with a per-cage orchd running, the agile loop also needs a wake-on-ready signal to convert `story.ready` into lead dispatch. ADR-246 (this ADR) closes the events-consumer half; ADR-247 closes the wake-signal half. Both are required for autonomous epic-cage operation; neither is sufficient alone.

This ADR is also **NOT** a duplicate of [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) Phase 2 or [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md). Those describe the **parent**'s orchd subscribing to `epic.ready` / `epic.unblocked` and **calling** `spawn-epic`. That parent-side handler is the trigger for spawn; it does not create an orchd inside the child cage. ADR-246 is the child-side half: once spawn-epic lands, the cage runs its own orchd.

## Decision

### D1 — `atmux team spawn-epic` autostarts a per-cage orchd as part of cage bootstrap

After step 3 (cage tmux session + role panes), `spawn-epic` spawns an `__orchd__` window inside the cage tmux session, running `atmux orchd --start` with `ATMUX_STATE_DB=<epic-cage>/.atmux/state.db` (or equivalent CWD scoping so orchd's read-path resolves the local DB).

- **Window name**: `__orchd__` (per ADR-224 Phase 1 rename — same convention as parent's orchd window; no clash since each cage has its own tmux session per ADR-018 cage-isolation).
- **Window lifecycle**: persistent across the cage's lifetime. Reaped on `atmux team dissolve-epic` via the existing ADR-090 §dissolve cron-reaper teardown hook (per ADR-197) + ADR-227 auto-dissolve subscriber.
- **Idempotency**: `spawn-epic` checks for an existing `__orchd__` window in the target cage tmux session before spawning. If present (e.g. respawn-after-crash path), do not duplicate. Reuses ADR-161 §Self-heal window-auto-rename pattern.
- **Consumer registry**: orchd registers `atmux:lane-router` against the cage-local DB on startup. The registry persists per-consumer offsets per ADR-202 §IX-A — restart-safe.

### D2 — `atmux up` autostarts per-cage orchd on the project root being brought up

`atmux up` resolves the project root via the standard `.atmux/` discovery walk (per ADR-245 §D2 singleton invariant). Once the cage tmux session is up + role panes are present, `atmux up` ALSO ensures an `__orchd__` window exists in the cage; if absent, spawns one against the project-root DB.

This covers two failure modes:

1. **Cage created without orchd** (the c-3787ee5c reproduction): a pre-ADR-246 spawn-epic ran; the cage is up but has no orchd. `atmux up` self-heals.
2. **Orchd crashed + window vanished**: per ADR-240 (orchd self-supervises with internal retry), the supervisor should recover, but a fatal init crash that takes down the orchd window itself needs an external re-arm. `atmux up` provides that re-arm.

### D3 — Orchd-presence check is part of `atmux doctor` for every active cage

`atmux doctor` (per ADR-077 medic / ADR-133 medic-rename / ADR-186 wedge-clearing) gains a probe class:

**Probe: `orchd-window-present`**
- For each cage tmux session enumerated via the cockpit registry (per ADR-089 hierarchical-cockpit DFS walk): check for an `__orchd__` window AND a live `atmux orchd` process whose `--state-db` argument (or CWD) matches that cage's project root.
- Verdict: `green` (window + process match), `yellow` (window present, process not found — orchd died inside the window), `red` (window absent entirely).
- Auto-remediation: `yellow` → `tmux send-keys` orchd restart command into the existing window. `red` → spawn the window per §D1 idempotency path.

This makes the per-cage orchd a **first-class doctor invariant**: cages are not considered healthy without a live orchd against their local DB.

### D4 — `atmux up` logs a warning if the cage's DB has unconsumed offsets but no orchd PID matches

Diagnostic for the operator-visible symptom of c-3787ee5c. Heuristic:

1. Read `<cage>/.atmux/state.db::honker_events` for `max(rowid) > 0`.
2. Read `<cage>/.atmux/state.db::honker_subscriptions` for any `last_processed_rowid < max(rowid)`.
3. `ps` for `atmux orchd` processes whose `--state-db` or CWD references the cage's project root.
4. If (1) AND (2) AND not (3) → log to stderr: `WARN: cage <name> has <N> unconsumed events but no orchd process binding to its state.db; spawning one now.`

This is the user-facing surface of the §D3 doctor probe; `atmux up` carries it because that's where operators are most likely to see the warning when first bringing up a cage.

### D5 — Per-cage orchd subscribes to lane-router only by default; parent-side subscriptions stay on the parent

Per-cage orchd's role is **in-cage agile flow**: route `task.unclaimed` to free members in the appropriate lane (be-/fe-/docs-/etc.); ack `task.done`; surface `task.failed` to the cage lead.

It does NOT subscribe to:
- `epic.added` / `epic.ready` / `epic.unblocked` — those are parent-side spawn triggers (ADR-224 Phase 2 + ADR-231).
- `epic.merged` — parent-side auto-dissolve trigger (ADR-227).
- Cross-cage dispatcher seams (ADR-232) — separate scope; not part of every cage's baseline.

The cage's orchd is **lean by default**. ADR-202 §III consumer-registration policy applies: subscriptions are explicit, registry-persisted, restart-safe.

### D6 — No new ADR-184 host-pressure exemption

Per-cage orchds count as live processes against the host RAM/CPU budget. ADR-184 host-wide cap = 8 (cap = N concurrent epic-teams) does not change; per-cage orchd is part of the per-epic-team footprint. ADR-198 medic host-pressure playbook applies as-is.

## Open Questions

- **OQ1**: Should `atmux start <team>` for the parent team ALSO walk-and-rearm orchd for every active child epic cage in the cockpit registry, or just rely on `atmux up` per-cage? Recommend: rely on `atmux up` per-cage. Rationale: `atmux start` is parent-scoped; bundling child-cage orchd rearm into it crosses the cage-isolation boundary (ADR-018). Reviewer: confirm before §D2 impl lands.
- **OQ2**: Should the per-cage orchd write its own log file at `<cage>/.atmux/logs/orchd.log`, separate from the parent's `<parent>/.atmux/logs/orchd.log`? Recommend: yes. Each cage owns its own logs; cross-cage log correlation happens via cockpit-mirror per ADR-230 (proposed).
- **OQ3**: Migration for existing cages with no orchd running (the c-3787ee5c reproductions in mx-root e-4 / e-5 / e-6 right now): does ADR-246 impl include a one-shot sweeper that walks the cockpit registry + spawns missing orchd windows? Recommend: yes, in the same impl epic. Single CLI: `atmux cockpit ensure-orchds`. Idempotent. Operator can run it once post-deploy and again under doctor's auto-remediation.

## Implementation epic

Bundled with [ADR-247](247-lead-stall-watchdog.md) in EPIC `e-cage-agile-self-sustain` (filed 2026-05-28). Shared acceptance test: spawn-epic → bootstrap → walk away 10 min → members claiming + committing without operator intervention.

## Related complaints

- **c-3787ee5c** (atmux DB) — operator-filed 2026-05-28 12:13 MYT after mx-root reproduction. This ADR closes it.
- **c-dee78b11** (mx-root DB) — mx-driver-filed 2026-05-28 11:38 MYT; resolved 12:05 MYT pointing to this ADR (misrouted into mx-root DB due to ADR-150 routing gap, separately tracked as c-a30cc447 → ADR-150 impl epic).
