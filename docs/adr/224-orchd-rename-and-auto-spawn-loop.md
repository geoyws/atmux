# ADR-224: `relayd` → `orchd` rename + auto-spawn / auto-dissolve orchestration loop

**Status**: proposed (deferred: Phase 1 ships first behind no-behavior-change rename; Phase 2 auto-spawn loop gated on sibling EPIC e-cf8a6195's `is_ready` + `depends_on` schema substrate landing on trunk; may split into ADR-225 at Phase 2 dispatch if the §Phase 2 section grows long)
**Date**: 2026-05-22
**Driver-ref**: 2026-05-22 driver-inbox EPIC brief e-60e16169 — *"orchd rename + auto-spawn loop"*. Master design + DoD + 5 design OQs in parent atmux kanban `t-10d9f702`. Triggered by Epic A (e-95087c8b) substrate fan-in landing on trunk (befb745 + f376665) — relayd is no longer dispatch-only; orchd will own spawn + dissolve too, justifying the honest name.
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker in-DB messaging substrate — orchd's event source for `epic.added` / `task.done`), [ADR-202](202-honker-in-db-messaging-substrate.md) §Amendment 2026-05-22 (VII) (`atmux-relayd` Rust binary supervisor — the binary being renamed), [ADR-202](202-honker-in-db-messaging-substrate.md) §Amendment 2026-05-22 (IX-A) (lean-dispatch contract via `runLaneTickForOne` — orchd inherits the dispatch contract verbatim), [ADR-090](090-epic-team-lifecycle.md) (`atmux team spawn-epic` — orchd's RPC target for auto-spawn), [ADR-091](091-kanban-driven-auto-merge.md) (kanban-driven auto-merge state-machine — orchd extends the pattern with spawn/dissolve lifecycle), [ADR-134](134-in-team-auto-merger.md) §Triggers (event-driven + cron-backstop two-trigger pattern — orchd mirrors this exact shape for spawn/dissolve resilience), [ADR-161](161-default-member-prefix-and-sort-verbs.md) §Self-heal (window auto-rename on `atmux start` — Phase 1 reuses this pattern for `__relayd__` → `__orchd__`), [ADR-182](182-auto-reap-epic-team-on-epic-merge.md) (auto-reap-on-merge — Phase 2 dissolve handler shares scaffolding), [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-wide epic-team cap still applies to orchd-triggered spawns), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) (claude account pool — orchd-spawned epic-teams consume the pool), [ADR-209](209-never-started-epic-team-detection.md) (never-started detection — Phase 2 closes a class of this bug by making spawn deterministic + observable), [ADR-218](218-auto-fold-in-verb-and-lead-auto-drive.md) (auto-fold-in / lead-auto-drive — adjacent automation; orchd does NOT subsume), [ADR-219](219-cockpit-mirror-rust-crate-fleet-event-consumer.md) (sibling cockpit-mirror Rust crate — identical Rust stack + pinned deps; orchd mirrors crate layout), [ADR-221](221-solo-worker-scope.md) §Phase 2 close-out (solo-worker v2 auto-dissolve folded into orchd's `task.done` subscriber), forthcoming **ADR-225** (Phase 2 §auto-spawn loop semantics — split-or-amend decided at Phase 2 dispatch).

## Context

`relayd` was named for its sole 2026-05-21 responsibility: relay Honker `task.unclaimed` events to per-member tmux send-keys dispatch (lean-dispatch contract per ADR-202 §IX-A). That name accurately described a one-job daemon.

Two scope expansions invalidate the name:

1. **Auto-spawn coupling.** Per parent kanban master task `t-10d9f702` and operator priority (driver-inbox 2026-05-22 02:52 MYT), the daemon will subscribe to `epic.added` and call `spawn-epic` for epics tagged `autoSpawn=true`. This is orchestration, not relay.
2. **Auto-dissolve coupling.** Same daemon will subscribe to `task.done` and dissolve solo-worker teams when the worker's only task moves to done (closes ADR-221 §Phase 2). Again — orchestration of team lifecycle, not relay of dispatch.

`relayd` (relay daemon) is misleading for both. `orchd` (orchestrator daemon) is the honest name. Rename happens BEFORE Phase 2 implementation so the codebase doesn't carry a misleading symbol for the entire Phase 2 development window.

**Why now, not at Phase 2:**

- Cost of rename is fixed and small; cost of misleading-name half-life is unbounded (every Phase 2 reader has to unpack "why is the relay daemon spawning teams?").
- Phase 1 ships behind a no-behavior-change relabel — low risk; deploy + verify quickly.
- Phase 2 implementation references the renamed symbols / paths / cron line / window name — doing it after rename means no in-flight churn during Phase 2.

**Why a single ADR (not 224 + 225 from the start):**

The rename rationale and the auto-spawn loop justify the same scope-shift conclusion: the daemon's responsibility set is expanding. Documenting them in the same ADR keeps the design history coherent. If §Phase 2 grows long during Phase 2 implementation, split into ADR-225 then — the ADR-091 / ADR-134 pair is the precedent for this kind of split-after-grow pattern.

## Decision

### D1 — Rename `relayd` → `orchd` (Phase 1, ships first)

Every `relayd` symbol, file path, binary name, CLI verb, window name, cron line, brief mention, and test reference is renamed to `orchd`. **Pure relabel — zero behavior change.** Phase 1 = mechanical rename.

| Surface | Before | After |
|---|---|---|
| Bun verb file | `src/verbs/relayd.ts` | `src/verbs/orchd.ts` |
| Bun verb args fn | `parseRelaydArgs` | `parseOrchdArgs` |
| Bun window helper | `src/core/relayd-window.ts` | `src/core/orchd-window.ts` |
| Window constant | `RELAYD_WINDOW` | `ORCHD_WINDOW` |
| Window literal | `__relayd__` | `__orchd__` |
| Rust crate dir | `rust/atmux-relayd/` | `rust/atmux-orchd/` |
| Rust crate name | `atmux-relayd` | `atmux-orchd` |
| Rust binary name | `atmux-relayd` | `atmux-orchd` |
| CLI primary verb | `atmux relayd` | `atmux orchd` |
| CLI deprecation alias | (none) | `atmux relayd` → warns + delegates to `atmux orchd`; remove next release |
| Cron line | `atmux relayd --drain` | `atmux orchd --drain` |
| Test files | `tests/unit/verbs/relayd.test.ts` (et al) | `orchd.test.ts` (et al) |
| Brief / doc refs | `relayd` literal | `orchd` literal |

**Deprecation alias semantics** (`atmux relayd`):

- Routes through `src/cli.ts` to the same orchd handler.
- Emits a single-line stderr warning: `[deprecated] 'atmux relayd' renamed to 'atmux orchd' (ADR-224); update callsites — alias removes next release`.
- Same exit code + same stdout shape as `atmux orchd` (so scripts that pipe / parse output keep working).
- Removal targeted at next release post-Phase-1-ship (lead surfaces removal Task once Phase 1 has been on trunk ≥1 release).

### D2 — Window auto-rename in `atmux start` incremental mode

Existing cages that were spawned before Phase 1 have a `__relayd__` window. `atmux start` incremental mode detects this on next invocation and renames it to `__orchd__` in-place (no kill-respawn) — mirrors ADR-161 §Self-heal pattern for member-window prefix migration.

Detection: `tmux list-windows -t <session>` walks the session, matches the literal `__relayd__`, runs `tmux rename-window -t <session>:<idx> __orchd__`. Idempotent — re-running on an already-renamed cage is a no-op (no `__relayd__` to find).

### D3 — Cron line idempotency via sandwich-marker re-install

The OS-cron block `# >>> atmux:team=<name>` … `# <<< atmux:team=<name>` (per ADR-026 / ADR-192) is rewritten by every `atmux start` to the current expected text. So the cron line `atmux orchd --drain` lands automatically on next `atmux start` after Phase 1 — no manual crontab edit, no migration. Operator just runs `atmux start` once after pulling.

This means the only manual operator step at Phase 1 ship is `git pull && atmux start` — the auto-rename in D2 plus the cron rewrite here handle every in-flight cage.

### D4 — Phase 2 auto-spawn loop (forward-ref; may split to ADR-225)

Phase 2 adds two Honker subscribers and a cron-backstop sweep:

**Subscribe `epic.added` → spawn-epic.** When an epic lands with `autoSpawn=true` (config home per OQ1 below), orchd RPC's `atmux team spawn-epic --epic <eid> --roster <r>`. Dedup via `epics.spawned_at` timestamp (OQ3). Failure → mark epic `spawn_failed` + emit operator flag (OQ4).

**Subscribe `task.done` → dissolve-worker.** When the last task owned by a solo-worker team moves to `done`, orchd RPC's `atmux team stop --team <worker-team>`. Closes ADR-221 §Phase 2.

**Cron backstop `atmux orchd --sweep`** every N minutes (config'd via team.json; default 5min mirroring whip cadence). Walks unspawned-epics + workers-with-no-pending-tasks. Defense-in-depth against Honker socket churn / NOTIFY/LISTEN gaps. Mirrors ADR-134 §Triggers exact two-trigger pattern.

**Why one daemon owns both (OQ5).** Spawn and dissolve are two sides of the same epic-team lifecycle; splitting them into two daemons doubles the process count without reducing complexity. orchd ALREADY has a Honker subscription + dispatch loop scaffolded; adding two more subscribers is a localized edit, not a new process.

**Phase 2 split decision (ADR-224 §Phase 2 vs ADR-225)** is made at Phase 2 dispatch time. Heuristic: if §Phase 2 body exceeds ~150 lines of ADR markdown OR if Phase 2 introduces a new top-level concept (e.g. autoSpawn config DSL with non-trivial semantics), split. Otherwise amend.

### D6 — Subscription registry seam (extensibility for sibling EPIC e-a946af69)

Phases 3-5 (auto-merge / auto-dissolve / throttle-queue) ship via **sibling EPIC e-a946af69** gated on this EPIC's Phase 1 + Phase 2 fan-in. Sibling EPIC mounts additional Honker subscribers:

| Sibling phase | Topic | Handler |
|---|---|---|
| Phase 3 (auto-merge) | `task.done` | check epic-readiness → trigger atmux merger |
| Phase 4 (auto-dissolve) | `epic.merged` | dissolve epic-team post-merge (extends ADR-182) |
| Phase 5 (throttle-queue) | `epic.added` / `spawn-queue.*` | host-pressure-aware queue layered on §D4 spawn handler |

**Contract**: `src/verbs/orchd.ts` MUST NOT hard-code its subscription topic list. Subscriptions are registered via a plug-shaped seam from Phase 1 day-one (zero handlers initially; behavior unchanged), and Phase 2 + sibling EPIC e-a946af69 register handlers WITHOUT modifying the daemon scaffolding.

**Seam shape (interface — pinned in Phase 1; impl populates in Phase 2)**:

```ts
// src/core/orchd-registry.ts (new — Phase 1 zero-handler scaffold)
export interface OrchdSubscription {
  topic: string;          // Honker topic (e.g. "epic.added", "task.done")
  consumerId: string;     // Honker subscriber-offset key (e.g. "atmux:orchd:spawn", "atmux:orchd:dissolve-worker")
  handler: (event: HonkerEvent) => Promise<void>;
  // Idempotency contract: handler MUST be idempotent under at-least-once delivery.
  // The registry guarantees per-consumer offset persistence; handler-internal dedup is the handler's responsibility.
}

export const ORCHD_SUBSCRIPTIONS: OrchdSubscription[] = [
  // Phase 1: empty array. Daemon loads, no handlers fire.
  // Phase 2: append { topic: "epic.added", consumerId: "atmux:orchd:spawn", handler: spawnHandler }
  // Phase 2: append { topic: "task.done",  consumerId: "atmux:orchd:dissolve-worker", handler: dissolveSoloWorkerHandler }
  // Sibling EPIC e-a946af69 Phase 3: append { topic: "task.done",   consumerId: "atmux:orchd:auto-merge",   handler: autoMergeHandler }
  // Sibling EPIC e-a946af69 Phase 4: append { topic: "epic.merged", consumerId: "atmux:orchd:auto-dissolve", handler: autoDissolveHandler }
  // Sibling EPIC e-a946af69 Phase 5: append { topic: "epic.added",  consumerId: "atmux:orchd:spawn-throttle", handler: throttleHandler } (layers on, doesn't replace, §D4 spawn)
];
```

**Registry semantics**:

- **Multi-handler-per-topic supported.** Two subscribers on `task.done` (mine: solo-worker dissolve; sibling Phase 3: auto-merge) ride distinct `consumerId`s — Honker's per-consumer offset model gives each its own dispatch cursor. No coordination beyond Honker's own machinery.
- **Handler lifecycle**: at daemon start, orchd iterates `ORCHD_SUBSCRIPTIONS`, calls `db.subscribe(topic, consumerId)` for each, spawns a per-subscription drain task. At daemon stop (SIGTERM / `--drain`), all drain tasks finish their in-flight events + flush offsets before exit.
- **Idempotency contract**: every handler MUST tolerate at-least-once delivery. The registry persists per-consumer offsets post-handler-success; if the handler throws, offset stays + Honker re-delivers on next tick. Handlers that mutate state (e.g. spawn → call spawn-epic) check for pre-existing state (e.g. `epics.spawned_at IS NOT NULL`) before mutating.
- **No global handler ordering guarantees** across topics. Within a topic, Honker delivers in event-id order; across topics, handlers race.

**What sibling EPIC e-a946af69 sees**:

- After Phase 1 lands on trunk, sibling EPIC reads `src/core/orchd-registry.ts` for the seam shape + `ORCHD_SUBSCRIPTIONS` array.
- Sibling adds entries to the array (with consumerIds like `atmux:orchd:auto-merge`) in the **same module-extension pattern** (append, no orchd.ts edit).
- Sibling's tests assert their handler ships + fires on a stub event. orchd.ts itself is untouched.

**Why interface in Phase 1 + impl in Phase 2 (NOT all in Phase 2)**:

- Phase 1 is no-behavior-change relabel. Adding the registry seam with zero handlers IS no-behavior-change — daemon loops idle on its (empty) subscription list, same as today's relayd already iterates an empty registry conceptually. The seam ships flat with the rename so Phase 2 + sibling EPIC have a stable contract to build against; mutual-blocking is avoided.
- If we waited until Phase 2 to introduce the seam, Phase 2 would have to do the rename refactor AND the auto-spawn impl AND the seam design in one EPIC — too much surface for one fan-in.

### D5 — Five Design Open Questions resolved with driver lean

Per the master design-task t-10d9f702, the operator's lean is binding unless reviewer / driver overrides during Phase 2 implementation:

| OQ | Question | Resolution |
|---|---|---|
| OQ1 | Where do auto-spawn settings live? | `epics.extra` per-epic JSON (no migration) **+** `team.json::autoSpawn.defaults` per-team policy (e.g. `[{ match: "/hotfix/", roster: "solo", autoSpawn: true }]`) |
| OQ2 | What triggers the spawn? | **Event-driven primary** (`epic.added` Honker) **+ cron backstop** (`atmux orchd --sweep`) — mirrors ADR-134 §Triggers two-trigger pattern |
| OQ3 | Dedup story? | New column `epics.spawned_at` timestamp; set on successful spawn; orchd skips epics where set. Migration version coordinated with sibling EPIC e-cf8a6195 (sibling's v13→v14 → ours is v14→v15) |
| OQ4 | Failure recovery? | Mark epic `spawn_failed` + emit operator-facing flag via `atmux flag add` (NO silent retry storms — ADR-132 §Amendment lesson explicitly cited) |
| OQ5 | Solo-worker v2 auto-dissolve overlap? | orchd owns BOTH spawn AND dissolve subscriptions (cohesive lifecycle owner; single daemon, two subscribers) |

OQ1-OQ5 resolutions ALSO recorded in `.atmux/decisions.md` at Phase 1 planner-decomp time so the reviewer + driver have an override surface independent of ADR text.

## Consequences

### What changes

- **BE lane**: 4 file moves + 1 symbol-rename sweep (`relayd` → `orchd` in src/, tests/, rust/, docs/, briefs).
- **OPS lane**: cron line rewrites itself via sandwich-marker; window auto-renames via `atmux start` incremental. Zero manual operator step beyond `git pull && atmux start`.
- **TEST lane**: test file renames + assertion sweep. No behavior change → tests should pass post-rename unless they hardcoded the literal `relayd` (which is the intended assertion).
- **DOC lane**: ADR-224 + cross-link updates + brief sweep + ADR-202 §Amendment optional pointer to ADR-224 §D4.
- **Future Phase 2 work**: see §D4 — reviewer dispatches Phase 2 after sibling EPIC e-cf8a6195 lands.

### What breaks

- **Anyone with `atmux relayd --start` in a personal alias / shell-rc / kept-script**: the deprecation alias keeps it working for one release with a stderr warning. Update before next release.
- **Anyone parsing `atmux relayd --help` stdout for verb names**: same — stderr warning, stdout shape preserved, but cite the new verb in any new automation.
- **Anyone with a customer crontab snippet pinning `atmux relayd --drain` literal** (rare): cron sandwich-marker rewrite handles atmux-managed blocks. Hand-pinned crons need a one-line update.

### What we give up

- **`relayd` symbol/name discoverability** — anyone searching the codebase for "relayd" finds only the deprecation alias + ADR-224. Mitigated by the deprecation alias's warning text + ADR-224 §D1 rename table.

### Rollback path

Phase 1 rollback: revert the rename PR (single commit ideally; per-file commits acceptable per ADR-091 fan-in rules). Deprecation alias means downstream callers stay working through rollback.

Phase 2 rollback: per-subscriber feature flag in `team.json::autoSpawn.enabled` defaults to `false` until reviewer signs off Phase 2 trunk-signoff. Disable + restart orchd to fall back to pre-Phase-2 behavior (relay-only).

## Open questions

1. **OQ-A: Should ADR-224 §Phase 2 split into ADR-225 at Phase 2 dispatch?** — deferred to Phase 2 dispatch time; heuristic in §D4.
2. **OQ-B: Should the deprecation alias survive one release or two?** — default one release (per §D1); reviewer may extend to two if operator scripts churn surfaces during Phase 1 deploy.
3. **OQ-C: Does the orchd `--sweep` cadence configurability go in team.json or hardcode 5min?** — defer to Phase 2 (lean: team.json default 5min, operator override possible per ADR-184 host-wide-cap adjacency).

Resolve OQ-A and OQ-B before flipping `Status: accepted`. OQ-C resolved at Phase 2 dispatch.
