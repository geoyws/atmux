# ADR-202: Honker as the in-DB messaging substrate — eliminate polling/whip/observation loops by adopting SQLite NOTIFY/LISTEN semantics

**Status**: proposed (deferred: pending substrate probe + extension build + Mac dev `setCustomSQLite` verification)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-20 evening design session — operator: *"come up with a complete recommendation to rehaul the entire atmux to use pubsub with honker and avoid loops and whips and polling"*. Design captured in memory `project_honker_pubsub_rehaul_design`; this ADR formalizes the substrate decision.
**Cross-refs**: [ADR-032](032-socket-pubsub-messaging-layer.md) (accepted-but-parked unix-socket-pubsub — carved-out, not superseded; see D8), [ADR-091](091-kanban-driven-auto-merge.md) §"forward-ref to socket-pubsub-driven dispatch" (this ADR delivers the in-DB half of that forward-ref), [ADR-134](134-in-team-auto-merger.md) §Triggers (event-driven trigger half), [ADR-145](145-atmux-adopts-gitter.md) §Reviewer-pre-flag (event-driven cascade half), [ADR-077](077-cockpit-superdoctor.md) (medic role — becomes event-driven post-substrate per migration phase 7), [ADR-126](126-sqlite-state-store.md) (state.db — the substrate Honker plugs into), [ADR-132](132-pluggable-martinet.md) (sentinel observation loops — becomes event-consumer post-substrate), [ADR-140](140-cheap-model-first.md) (Claude-burn reduction motivation — this ADR's projection sits alongside ADR-140's), [ADR-192](192-cron-arm-idempotency-contract.md) (OS-cron discipline — still applies for irreducible periodic work), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) §D6 (subscribes to `budget.warning`/`budget.recovered` once this lands), [ADR-200](200-install-wizard-guided-first-run-setup.md) §D6 (Honker extension install step), forthcoming ADR-203 (event topic taxonomy — payload schema + propagation rules), forthcoming ADR-204 (`_jury` role — first consumer beyond the substrate).

## Context

atmux is shaped by loops. Every state-change that should trigger an action today reaches its consumer via one of:

- **Cron-tick polling** — `*/5 * * * * atmux whip --auto`, sentinel cockpit-W3 tick, medic hourly sweep, gitter cron-backstop, intra-team-merge-dispatcher tick, epic-merge sweep, committer-sweep, velocity-gate scan, refusal-scan, hygiene-drain.
- **Claude-side `/whip` and `/bruh` skill loops** — invoked by the operator or by `coordination:bruhloop` 15-min cron — every loop wakes Claude, scans state, finds nothing, sleeps.
- **In-process `setInterval` ticks** in long-running atmux processes (where they exist).

The shape across all three is the same: **wake → scan → find nothing → sleep**, repeated at fixed cadence. Each wake costs (Claude burn for skill loops, host CPU for cron sweeps, disk I/O for kanban scans), and the cadence is a forced trade-off — fast enough for low latency means more cost; slow enough for low cost means high latency.

ADR-032 (2026-05-08, `Status: accepted`) anticipated this and specified **unix-domain socket pubsub** as the messaging layer. It is documented at length but **never shipped**: `src/core/socket-pubsub.ts` is a forward-ref; `lib/socket-pubsub.sh` is bash-WIP; ADR-091/134/145 all forward-ref ADR-032 for the "future event-driven path" while v1 ships with cron-backstop. The "ships with cron-backstop, eventize later" pattern is documented, but **later never arrived** for the in-DB use case.

The replacement primitive surfaced 2026-05-20 evening when the operator pointed at [Honker](https://github.com/russellromney/honker) — a SQLite **loadable extension** written in Rust that adds Postgres-style `NOTIFY/LISTEN` semantics natively to SQLite, with durable streams (per-consumer offsets), at-least-once work queues, and a scheduler primitive. Cross-process wake latency is ~0.7ms p50 on a workstation; internally Honker polls `PRAGMA data_version` every 1ms (cheap), so consumers never poll themselves. Bun bindings ship in the same repo.

**Bun probe results (2026-05-20 evening):**

- `bun:sqlite` exposes `Database.loadExtension(name, entryPoint?)` as a documented stable API. Confirmed against `bun --version` 1.3.11 (project pins ≥1.3.13 — minor skew, non-blocker).
- **Linux** (hax — atmux's primary deploy target): works out of the box. No special handling.
- **macOS** (operator's local dev workstation): Apple's bundled SQLite has extension loading disabled. Requires `Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")` (or equivalent Homebrew sqlite path) before `loadExtension()`. Setup friction is one extra step in the install wizard (ADR-200 D6 handles it).
- Honker is **alpha-status** (operator's own attention to this flagged it; documented self-description: "better than experimental but not beta-quality yet"). Adoption requires defense-in-depth.

The hax-primary clarification (operator 2026-05-20): *"we run atmux mostly on hax anyways, but yes note that down in adr for mac"* — the Mac path is for dev workstation use, not production deploy.

**The shape Honker delivers vs the polling shape today:**

| Concern | Polling today | Honker substrate |
|---|---|---|
| Latency state-change → consumer | 30s – 15min (cron-cadence-bound) | ~0.7ms p50 (cross-process via `PRAGMA data_version` tick) |
| Cost per idle scan | Claude burn / CPU / disk I/O | 0 (consumer sleeps until `NOTIFY` lands) |
| Backpressure | None — consumer reruns the scan every tick | Honker queue/stream — consumer drains at its own rate |
| Durability | Polling rediscovers state after a crash (and may miss transitions if state was reset) | Streams with per-consumer offsets; bounded replay after subscriber crash |
| Atomicity (state change ↔ event) | Best-effort: state change commits, then consumer scans later and may miss intervening transitions | Same transaction: `INSERT INTO orders` + `queue.enqueue()` commit or roll back together |
| Cross-process delivery | Requires shared filesystem + polling cadence | In-DB notify; ~1ms cross-process via SQLite's WAL + data-version polling |

The architecture impact ripples beyond any single feature. Most atmux loops disappear (sentinel cron tick, `/whip run` loop, `bruhloop`, `auto-push-just-done-sha` periodic, `detectAndResubmit` scan, `eternal-improvement` polling). Cron-backstops shipping under ADR-091/134/145 demote to defense-in-depth safety nets. Per memory `project_cheap_model_first_adr_140`, ADR-140 projected ~65-70% Claude-burn reduction from offloading observation loops to cheaper models; this ADR is the substrate that makes most of those loops disappear entirely.

The remaining question is **how to adopt Honker without disturbing shipping velocity** (operator constraint 2026-05-20: *"we don't want to ship this just yet and disturb shipping velocity. let's just put this in an adr and work on it and then gate it first before building to bin"*). The deferred status + kill-switch shape encodes this.

## Decision

### D1 — Adopt Honker as the in-DB messaging substrate

atmux loads the Honker SQLite extension into every `bun:sqlite` connection at process start. Consumers of state-change events (gitter, jury, sentinel, whip, medic, watchdog) subscribe to in-DB topics via Honker's `notify()` + `stream()` primitives instead of polling their state-source.

Cron-tick polling **does not disappear in a single release**. Each consumer migrates in its own EPIC (see D12) and ships behind a per-consumer kill-switch + cron-backstop. The substrate adoption (this ADR) lands as a no-op consumer-side — extension loaded, abstraction wired, smoke tests green, kill-switch in place; no behavior change.

### D2 — Kill-switch env `ATMUX_HONKER=on|off` (default `off` until v1 stable)

The substrate's first EPIC lands with `ATMUX_HONKER=off` as the default. Operators flip to `on` per host once the substrate ADR's accompanying smoke-test suite has run green for ≥7 days on their host. Consumer EPICs (jury, gitter, sentinel, etc.) gate on this — when off, the consumer falls back to its existing cron/poll path.

Promoting to default `on` requires a separate ADR amendment after observed-stable performance across all consumer EPICs. Until then, **default is opt-in via env** — matches the gating constraint.

The kill-switch is per-process — every atmux verb invocation reads it at boot. No partial-runtime toggle; full-process restart to flip.

Failure mode: if `ATMUX_HONKER=on` but extension load fails, the substrate logs a warning, sets a runtime flag `honker.loaded=false`, and consumers fall back to poll mode for the lifetime of that process. Doctor probe (see D11) surfaces the drift.

### D3 — Separate DBs + ATTACH at subscribe-time

Two distinct database files:

- **Per-team `.atmux/state.db`** — team-scoped events (`task.*`, `story.*`, `epic.*`, `commit.landed`, `pane.*`, `complaint.filed`, `flag.raised`, `decision.added`). Each team's process subscribes to its own state.db topics.
- **Cockpit-level `~/.atmux/cockpit-events.db`** — fleet-scoped events (`team.*`, `medic.*`, `sentinel.*`, `epic.spawn_blocked`, `budget.warning`, `budget.recovered`). Cockpit-role processes (medic, sentinel cockpit tick, BAU) subscribe here.

**Cross-team propagation: per-team `cockpit-mirror` consumer.** When a team event needs fleet visibility (e.g. `epic.merge_ready` on a child epic-team needs to wake the parent team's gitter), a long-running `cockpit-mirror` consumer in the team's process subscribes to local state.db topics and INSERTs the event into cockpit-events.db. The cockpit subscriber then picks it up. No child→sibling direct ATTACH; the cockpit DB is the bus.

**Why separate, not single cockpit DB:**

- Cleaner failure domains. A corrupted state.db on one team doesn't kill cockpit observability or other teams.
- Lock contention scaled per-team rather than fleet-wide.
- Matches existing per-team `.atmux/state.db` layout (ADR-126) — no schema-level migration required.
- ATTACH stays read-only and per-subscribe — no write-from-multiple-attached-DBs hazard.

### D4 — Zod-typed event payloads, discriminated union by topic

Event payloads are statically-typed via Zod schemas. Topic name is the discriminator:

```ts
// src/schema/events.ts (new)
const TaskClaimedPayload = z.object({
  topic: z.literal("task.claimed"),
  taskId: z.string(),
  member: z.string(),
  claimedAtSec: z.number(),
});
const TaskDonePayload = z.object({
  topic: z.literal("task.done"),
  taskId: z.string(),
  member: z.string(),
  doneAtSec: z.number(),
  commitSha: z.string().optional(),
});
// ...one schema per topic in ADR-203's taxonomy...

export const EventPayload = z.discriminatedUnion("topic", [
  TaskClaimedPayload, TaskDonePayload, /* ... */
]);
```

Publishers serialize via `EventPayload.parse(...)` before INSERT; subscribers validate on read via the same schema. Same `passthrough()` pattern as kanban (memory `reference_kanbantask_passthrough_extra_json`) for forward-compat fields. Compile-time type-narrowing in TypeScript via the discriminated union — consumers get exhaustive switches over topic types.

**Why Zod, not untyped JSON:**

- Silent rot on payload-shape changes is catastrophic for the substrate. A consumer expecting `taskId` but receiving `task_id` fails open in untyped JSON; Zod errors at validation boundary.
- Schema-level evolution: adding optional fields is backward-compatible; renaming requires a schema-version field (see ADR-203 for the schema-version contract).
- Discriminated union enables exhaustive consumer code — adding a topic without updating consumers becomes a TS error at compile time.

The full topic taxonomy + payload shape + cross-team propagation rules are deferred to ADR-203. This ADR commits only to the typed-discriminated-union approach.

### D5 — Bootstrap order: load extension immediately after `db.open()`

In `src/cli.ts` (or wherever the process's primary `Database` is opened):

```ts
const db = new Database(stateDbPath);
if (process.env.ATMUX_HONKER !== "off") {
  loadHonkerOrFallback(db);  // calls setCustomSQLite on darwin, loadExtension, smoke-test
}
// ...verb dispatch...
```

`loadHonkerOrFallback`:

1. On `process.platform === "darwin"`, resolves Homebrew sqlite path (`/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` or `/usr/local/opt/sqlite/lib/libsqlite3.dylib` for Intel Macs) and calls `Database.setCustomSQLite(path)`. Failure here → warn + fall back to poll mode.
2. Calls `db.loadExtension(honkerPath)` where `honkerPath` defaults to `~/.atmux/extensions/honker.so` (Linux) / `.dylib` (Mac), overridable via `ATMUX_HONKER_PATH`. Failure here → warn + fall back to poll mode.
3. Runs a smoke probe: registers a topic, publishes a test event, drains the stream within 100ms. Failure → warn + fall back to poll mode.
4. On success, sets `process.honker.loaded = true` (runtime flag readable by consumers). Subscribers can register topics after this point.

Subscribers register via a helper `subscribeTopic(db, topicName, handler, opts)` that no-ops when `honker.loaded === false` (and logs at debug level once per subscribe site so the operator can grep for missing event paths).

### D6 — Failure mode: cron-backstop defense-in-depth + subscriber idempotency

Two defense layers per consumer EPIC:

1. **Cron-backstop sweep at lower cadence** — every consumer that goes event-driven (gitter, jury, etc.) keeps its existing cron sweep at a relaxed cadence (every 60-300s instead of every 30s). On each sweep, the consumer drains any missed events from the durable stream (which has per-consumer offsets — bounded replay). The sweep is the catch-net for dropped events.
2. **Subscriber-side idempotency required** — every event has a stable `eventId` (UUIDv7 — time-ordered). Consumers track the last-processed `eventId` in their own state row; on event arrival, no-op if `eventId <= last_processed`. Required because at-least-once delivery semantics means duplicates can fire (post-backstop sweep catching an already-handled event).

Consumer EPICs ship with both layers from day one. Removal of the cron-backstop is a separate cleanup EPIC after ≥30 days observed-stable per consumer (matches the migration phase plan, D12).

This pattern matches ADR-091 v1 cron-backstop with forward-ref to event-driven — except now the event-driven path actually exists.

### D7 — Mac dev `setCustomSQLite` handling

Per the bun probe (Context): macOS dev workstation requires `Database.setCustomSQLite()` before `loadExtension()`. ADR-200 install wizard Layer 1 step 5 (Honker substrate install) probes Homebrew sqlite + prompts to `brew install sqlite` if absent. The bootstrap helper in D5 handles the call at process start.

Hax (Linux, primary deploy target) requires no special handling — distro sqlite supports `enable_load_extension` out of the box.

The operator's directive 2026-05-20: *"we run atmux mostly on hax anyways, but yes note that down in adr for mac"* — Mac dev friction is accepted as one-time setup; production deploys are hax + Linux + no friction.

### D8 — ADR-032 disposition: keep accepted + document carve-out

ADR-032 (unix-domain socket pubsub) is **not superseded** by this ADR. The two cover non-overlapping scopes:

- **This ADR (in-DB events)**: any state-change rooted in a SQLite write. Most kanban events, commit-tracking, state-machine transitions, watchdog primitives. Single-host by definition (Honker is in-DB, no cross-machine delivery).
- **ADR-032 (cross-cage / cross-host messages)**: signals that don't flow through the DB — operator-Mac → hax cage live messages, fleet-level superdriver-inbox events (per ADR-034 §Phase 2A), cross-machine future use cases. Continues to use unix-domain socket pubsub when finally shipped; the carved-out scope shrinks but doesn't disappear.

The shared current substrate for cross-cage delivery is **tell-lead durable-inbox + best-effort tmux keystroke wake** (per `coordination:tell-lead` skill + ADR-042 §"durable log; socket is optional push-fast-path"). This stays unchanged; ADR-032 is the upgrade path when cross-host messaging actually needs the low-latency push.

ADR-032's `Status: accepted` is preserved. This ADR adds a §Carve-out cross-reference back to ADR-032.

### D9 — Post-commit hook architecture: `.atmux/hooks/post-commit` chained from `.git/hooks/post-commit`

atmux ships a hook installer that wires git's `.git/hooks/post-commit` to invoke `.atmux/hooks/post-commit` if present. The installer:

1. Reads existing `.git/hooks/post-commit` content (operator may have their own hooks).
2. If atmux marker absent (`# >>> atmux:post-commit`), appends a marker-fenced block invoking `.atmux/hooks/post-commit "$@"`.
3. Idempotent re-runs: marker-fenced block rewrite-in-place (same pattern as cron sandwich-markers per ADR-083 + ADR-192).

The `.atmux/hooks/post-commit` script reads `git rev-parse HEAD` + `git log -1 --format=...` and emits a `commit.landed` event to state.db. Lightweight bash; no atmux verb dispatch.

**Why not write directly to `.git/hooks/post-commit`:**

- Operator may have their own pre-existing hooks (linting, signing, push-mirroring) — clobbering is hostile.
- Marker-fenced append matches existing cron-block discipline; same removability + idempotency.
- `.atmux/hooks/` is git-ignored (per `.gitignore` convention) — local-only hook state.

Install point: ADR-200 install wizard Layer 2 step 5 (per-team cron arming gains a sibling "per-team hook arming" sub-step).

### D10 — External-state events: probes still cron, results emit events

External state (Claude API rate-limits, git remote refs, sqlite-disk-space) can't be event-sourced from inside our DB — the data doesn't originate from a SQLite write. These probes **stay on cron** but emit events on threshold-crossing:

- `coordination:budget` probe runs on cron, writes `~/.atmux/state/budget-probe-<account>.json`. Substrate adds: on crossing a configured threshold (low-warning, recovery), INSERT a `budget.warning` / `budget.recovered` event to cockpit-events.db.
- `git fetch` periodic refresh: on success, INSERT `git.fetched <remote>` (downstream consumers like trunk-integrate detector wake on the event instead of re-fetching).
- Disk-space probe: on low-space crossing, INSERT `disk.warning` (medic consumes for hygiene drain).

Pattern: **probe stays on cron** (irreducible — external clock is the source of truth); **threshold detection** is a substrate consumer that emits the event. Consumers downstream of the threshold (pool-selector per ADR-199 D6, medic, whip) become event-driven.

OS-cron discipline (ADR-192 idempotency) still governs the probe arms themselves.

### D11 — Test substrate: `:memory:` DB per test + `withHonker()` helper

```ts
// tests/helpers/honker.ts (new)
export async function withHonker<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = new Database(":memory:");
  loadHonkerOrFallback(db);
  try { return await fn(db); } finally { db.close(); }
}
```

Per-test isolation: fresh in-memory DB, fresh extension load, fresh subscribers. No shared state across tests. Test files import the helper; assertion-style is `await withHonker(async (db) => { ... publish ... drain ... expect ... })`.

CI implications: Honker extension binary must be present on CI runners. Install wizard step 5 (ADR-200 D6) doubles as the CI provision recipe. Extension is statically linked Rust; no runtime deps beyond libc.

### D12 — Migration phases (EPIC sequence)

**Amended 2026-05-21 per [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md):** `e-honker-sentinel` REMOVED. The Sentinel role retires entirely (no Opus-sentinel impl-EPIC); its observation functions split into four single-responsibility consumer EPICs (pane-classifier, wedge-clearer, refusal-handler, silent-team-detector). Medic (ADR-077) is NOT affected — medic is scheduled hourly diagnosis, not continuous observation. ADR-207 (Opus-sentinel) stays Accepted but never ships an impl-EPIC.

Ten EPICs in sequence, each kill-switched, each kept-behind-cron-backstop until ≥30 days observed-stable:

| EPIC | Scope | Eta |
|---|---|---|
| e-honker-substrate | Extension load + schema (per-team + cockpit-events DBs) + consumer-base class + kill-switch + doctor probe + smoke tests. **No consumers.** | 3-5 days |
| e-honker-jury | First real consumer — `_jury` ratify/verdict pipeline (ADR-204). Cron-poll backstop kept. | 2-3 days (after substrate) |
| e-honker-gitter | gitter listens for `task.done` → merge. Cron retained. | 1-2 days |
| e-honker-watchdogs | Port absence-detection (15min stall, wedged pane, lead-unresponsive) to Honker scheduler. Deletes ≥5 cron entries. Absorbs sentinel's stall-complaint emission (ADR-211 §D2). | 1-2 days |
| e-honker-pane-classifier *(ADR-211 split)* | Event-triggered tmux capture-pane + classify. Emits `pane.classified`, `pane.wedged`, `pane.refusal-detected`. Cron-backstop sweep at 10-min cadence for catch-net. Absorbs sentinel function #1 from ADR-211 §D2. | 1-2 days |
| e-honker-wedge-clearer *(ADR-211 split)* | Consumer of `pane.wedged`. Re-uses ADR-138 verified-send-keys. Absorbs sentinel's wedge-recovery half. | 1 day |
| e-honker-refusal-handler *(ADR-211 split, may fold into watchdogs)* | Consumer of `pane.refusal-detected`. Emits `*.escalated` if ADR-139 threshold exceeded. | 1 day |
| e-honker-silent-team-detector *(ADR-211 split)* | Consumer of substrate's `internal.smoke.tick` absence-per-team. Replaces ADR-183 silent-member-death role. | 1 day |
| e-honker-whip | `/whip run` loop becomes event-consumer; deprecation grace one release. | 1-2 days |
| e-honker-medic | Medic state-driven on complaint/hygiene/wedge events. Sibling role at W2 STAYS (per ADR-211 §D6 — scheduled, not continuous). | 1-2 days |
| e-honker-cleanup | Delete deprecated loops; remove cron-backstops where ≥30 days stable; ADR-091/134/145 §Amendments documenting switchover. Absorbs sentinel residue deletion per ADR-211 §D3 (delete `src/abstractions/sentinel.ts` + `src/verbs/sentinel.ts` + sentinel-related cron entries + reviewer-surface entries). | 2-3 days |

Total estimate ~3-4 weeks of focused EPIC throughput. Each EPIC behind kill-switch + cron-backstop → zero-risk rollback if Honker craps out alpha-style.

Acceptance per EPIC: substrate smoke tests + consumer-specific assertions green; kill-switch flip verified (both `on→off` and `off→on`); doctor probe surfaces drift; ≥30 days observed-stable before cron-backstop removal.

## Consequences

**Becomes easier:**

- Most observation loops disappear (sentinel cron, /whip run, bruhloop, eternal-improvement, detectAndResubmit periodic). Claude-burn from no-op observation reduces materially (ADR-140 projection applies — ~65-70% reduction order-of-magnitude in observation-loop calls).
- State-change → consumer latency drops from 30s-15min to ~1ms p50. UX improvements for operators watching the cockpit; gitter merges land near-instantly after `task done`.
- Absence-detection patterns (15min stall, wedge after nudge, lead-unresponsive) use Honker's scheduler primitive — no per-rule cron entries. Cleaner ops surface.
- Same-transaction atomicity (state change + event-emit commit together) eliminates a class of race conditions where polling discovers half-applied state.
- Substrate is the missing piece ADR-091/134/145 forward-ref'd; consumer ADRs can drop their forward-refs once respective EPICs ship.

**Becomes harder:**

- Substrate dependency in install wizard (ADR-200 D6) — every install path needs Honker extension provisioning. Mac dev has one extra step (`brew install sqlite` + `setCustomSQLite`).
- Alpha-status Honker is a risk vector — extension binary is a new dependency to vet per release. Kill-switch + cron-backstop defense-in-depth mitigates blast radius.
- Event-driven debugging is less mechanical than polling — a missed event is harder to trace than a missed scan. Mitigated by Zod-typed payloads (D4 — validation errors surface mismatched schemas at the boundary) + at-least-once delivery + per-consumer offsets (D6 — bounded replay after subscriber crash).
- Test substrate adds CI provisioning cost — extension binary on every runner. Mitigated by single static-Rust binary, no runtime deps.
- Subscriber idempotency is a per-consumer correctness obligation (D6) — sloppy consumers double-process events. Mitigated by helper macros + per-event UUIDv7 ID + last-processed-offset tracking pattern documented in ADR-203.

**Risks + mitigations:**

- **Risk**: Honker alpha quality lands a regression that corrupts events mid-stream. **Mitigation**: kill-switch flip to `off` reverts to poll mode without code change; cron-backstop sweep catches missed events; doctor probe surfaces extension-load failure.
- **Risk**: Bun version skew (project pins ≥1.3.13; loadExtension API stability across minor versions). **Mitigation**: substrate EPIC smoke test asserts API surface at boot; mismatch fails closed (poll mode fallback).
- **Risk**: `setCustomSQLite` on Mac dev silently picks an Apple-bundled sqlite path (extension-disabled), and load succeeds for non-extension code but fails for the actual extension. **Mitigation**: smoke probe (D5 step 3) is the canary — a passing smoke probe is the only signal we trust; a passing `loadExtension()` without smoke is not.
- **Risk**: Subscriber crash mid-event leaks the `last_processed` offset, causing reprocess on restart. **Mitigation**: at-least-once semantics + idempotent handlers mean reprocess is safe by design; no correctness impact from offset drift.
- **Risk**: Two-DB design (per-team + cockpit) creates write-amplification when team events mirror to cockpit. **Mitigation**: mirror consumer is intentionally async + best-effort; if cockpit-events.db is locked or absent, team events still fire locally; cockpit visibility eventually-consistent.
- **Risk**: Honker scheduler primitive (used for watchdogs in D12 / e-honker-watchdogs) overlaps with OS cron in confusing ways. **Mitigation**: Honker scheduler is per-event-watchdog (one-shot, cancelled-on-activity); OS cron is periodic-arm (fires on schedule regardless). Clear taxonomic boundary documented in ADR-203.
- **Risk**: ADR-032's `Status: accepted` becomes confusing once this lands (people think it's superseded). **Mitigation**: D8 carve-out is explicit + cross-referenced; ADR-032 file gets a §Carve-out amendment in the substrate EPIC.

## Out of scope (deferred)

- **Promoting `ATMUX_HONKER=on` to default** — explicit later ADR after observed-stable across all consumer EPICs.
- **Removing ADR-091/134/145 cron-backstops** — separate amendment in e-honker-cleanup after 30 days stable per consumer.
- **Cross-host Honker** — Honker is in-DB, single-host by design. Multi-host pubsub stays with ADR-032 (or future substrate).
- **Honker stream → external sink** (Discord, Slack, webhook) — Discord debouncer consumer lands in e-honker-cleanup, not substrate; webhook export is post-cleanup.
- **Honker schema migrations / version bumps** — release-pinned for now; upgrade path is a separate ADR when Honker hits a 0.x → 1.x cliff.
- **Bin distribution of Honker extension** — operator does not want to bundle the binary into atmux's `bin/` symlink chain until kill-switch defaults to `on`. Install wizard provisions per-host until then.

## References

- ADR-032 — unix-domain socket pubsub (accepted, carved-out per D8, not superseded)
- ADR-091 §"forward-ref to socket-pubsub-driven dispatch" — substrate-half of the forward-ref
- ADR-134 §Triggers — event-driven trigger half this delivers
- ADR-145 §Reviewer-pre-flag — event-driven cascade half this delivers
- ADR-077 — cockpit superdoctor / medic (eventized post-substrate)
- ADR-126 — SQLite state store (the substrate Honker plugs into)
- ADR-132 — pluggable sentinel (observation loops → event-consumer post-substrate)
- ADR-140 — cheap-model-first principle (Claude-burn reduction motivation alignment)
- ADR-192 — cron-arm idempotency contract (still applies to irreducible periodic probes per D10)
- ADR-199 §D6 — Claude account pool (subscribes to `budget.warning` once this lands)
- ADR-200 §D6 — install wizard (Honker extension install step)
- Honker — `russellromney/honker` on GitHub, [honker.dev](https://honker.dev/), [crates.io/crates/honker-extension](https://crates.io/crates/honker-extension)
- Bun `bun:sqlite` `Database.loadExtension` — [bun.com/reference/bun/sqlite/Database/loadExtension](https://bun.com/reference/bun/sqlite/Database/loadExtension)
- memory `project_honker_pubsub_rehaul_design` — full design state, decisions locked, 10 open questions resolved in this ADR per the operator's "go with your lean" 2026-05-21 directive
- memory `project_cheap_model_first_adr_140` — ADR-140 burn-reduction projection
- memory `reference_kanbantask_passthrough_extra_json` — Zod `.passthrough()` precedent for D4


## §Amendment 2026-05-21 — Default flipped OFF → ON (driver-initiated dogfood)

Default kill-switch state reverses: `ATMUX_HONKER` env var now defaults to **ON** when absent / empty. Operators explicitly disable via `ATMUX_HONKER=off|0|false|OFF|FALSE`. Garbage values (e.g. `ATMUX_HONKER=onn`) fall back to default-ON rather than silently disabling — typo-safe positive form.

**Why this is safe to flip before the binary universally ships:** the substrate is graceful per §D6. When the binary isn't present at `~/.atmux/extensions/honker.{so,dylib}`, `loadHonkerOrFallback` returns `{loaded: false, fallbackReason: "..."}` cleanly + the doctor probe surfaces a yellow `fallback` row. Consumers fall through to their cron-backstop / direct-INSERT paths. Net effect of default-ON pre-binary: a yellow doctor row + a few wasted load-attempts on boot. No production traffic change.

**Why we flip now**: dogfood. Even pre-binary, all event-emitting code paths in production exercise the (poll-mode) substrate consistently. The day the binary lands, the load-attempt starts succeeding without code changes elsewhere — the consumer dispatch flips event-driven automatically. This catches any "I built event-emission against the substrate but didn't actually emit" bugs while we still have time to fix them.

**Concrete impl**: `src/abstractions/honker.ts::isHonkerEnabled` (the kill-switch reader) now returns `true` for absent / empty / unrecognized values; only explicit off-forms return `false`. 7 unit tests in `tests/unit/abstractions/honker.test.ts::isHonkerEnabled` cover the new contract.

**Filed via** 2026-05-21 driver session — *"flip honker and let's turn it on"*.


## §Amendment 2026-05-22 — NOTIFY/LISTEN watcher + first event-driven consumer shipped

Three substrate-completion deliverables filed in a single commit (`atmux-geoyws-honker-events` branch):

### 1. `emit()` now publishes to Honker stream when loaded

`src/abstractions/events.ts::emit` previously only INSERTed into the `events` table (durable layer); the `honkerLoaded` flag was a no-op stub. This commit wires the actual NOTIFY half: when `opts.honkerLoaded === true`, `emit()` also calls `honker_stream_publish(topic, eventId, JSON.stringify(payload))` which (per the Honker upstream contract) inserts a row into `_honker_notifications` table with `channel = "honker:stream:<topic>"`. That row is the wake-up signal `watchEvents()` listens for.

The honker-stream publish is **best-effort**: a thrown error (substrate-internal hiccup, table missing, etc.) is swallowed inside `emit()`. The events-table INSERT remains authoritative — durability is unaffected by NOTIFY failures. Cron-backstop drain (per §D6) catches consumers up if NOTIFY missed.

### 2. `watchEvents()` async-iterator subscription

New `src/abstractions/events.ts::watchEvents(db, opts)` async generator. Yields `EventPayload` per new event in lexicographic ID order. Wake-up strategy:

- **Honker-loaded mode** (~100ms latency): polls `MAX(_honker_notifications.id)` at `honkerPollIntervalMs` (default 100ms). O(1) indexed lookup — effectively NOTIFY/LISTEN for our throughput (~100 events/day at peak per team).
- **Fallback mode** (~1500ms latency): polls the events table directly at `fallbackPollIntervalMs`. Same behavior consumers get under `ATMUX_HONKER=off`.

**Cancellation:** pass an `AbortSignal`; generator returns the next time the inner sleep wakes (within `pollIntervalMs` of abort, worst case).

**Backlog drain:** on first iteration, drains every event with `event_id > initialOffset` — consumers that crashed mid-batch reload their offset from `subscriber_offsets` and resume without loss. At-least-once semantics; handler MUST be idempotent.

**Graceful degradation:** if `honkerLoaded` is claimed `true` but `_honker_notifications` is missing at runtime (substrate killed mid-session), the loop silently downgrades to the fallback poll cadence rather than throwing.

Test coverage: 9 new tests in `tests/unit/abstractions/events.test.ts::watchEvents` covering backlog drain, topic filter, initialOffset cursor, AbortSignal cancellation (pre-abort + mid-loop), mid-loop emit pickup, missing-notifications degradation, empty-topics drain-all, drainBatchSize cap.

### 3. First production emit point — `task.done` + `task.claimed`

`src/core/kanban.ts::moveTask` now emits via a new same-transaction hook `tryEmitTaskLifecycle`:

- **`done` transition** → `task.done` payload (taskId, member, team, doneAtSec, storyId?, epicId?).
- **`todo → in-progress` transition** → `task.claimed` payload. Status flips WITHIN `in-progress` are no-ops to avoid emit noise.
- Same-`transactImmediate` scope as `repo.upsertTask` so event durability matches the kanban row (atomic by construction).
- Best-effort: a missing events table (pre-migration) or programmer-introduced Zod failure is swallowed — the kanban-row mutation is load-bearing; the event is observability/coordination plumbing.
- `opts.emit` test-injection seam; production callers accept the default.

Test coverage: 7 new tests in `tests/unit/core/kanban-sqlite.test.ts::"kanban (SQLite mode) — task-lifecycle event emit (ADR-202/203)"` covering done-emits, claimed-on-first-todo→in-progress, blocked-emits-nothing, no-duplicate-on-redundant-move, emit-shim-honored, missing-team.json-short-circuit, emit-throw-doesn't-rollback-kanban, story+epic-context-included.

### 4. First production consumer — `atmux committer --daemon` + `--drain`

Two new sub-verbs on `atmux committer` (the existing T4 ADR-134 cron-sweep verb gets a peer rather than a replacement):

- **`atmux committer --drain`** — one-shot cron-backstop drain. Runs `gitterConsume()` once, processes any pending `task.done` events via the `subscriber_offsets` table, exits 0. Drop-in replacement for the existing `*/5 atmux committer --sweep` cron line once we trust event-driven coordination.
- **`atmux committer --daemon`** — long-lived NOTIFY/LISTEN consumer. Subscribes to `task.done` via `watchEvents()`, routes each event through the production `createGitterMergeHandler` dispatcher (ADR-134 state machine). Handles `SIGINT`/`SIGTERM` by aborting the watcher and exiting 0 once the in-flight event finishes. `--once` / `--max-events N` test-mode bounds.

Both share a `buildEventDrivenContext()` factory that loads team config, opens `state.db`, boots Honker, wires the gitter merge handler with worktree resolver + roster filter.

Test coverage: 9 new parser tests + 2 integration tests (drain-empty exits 0; daemon-once-empty exits 0 with start+stop log lines).

### Net effect on production coordination

After this commit:
- Every `atmux task move <id> done` emits a durable `task.done` event into the events table.
- Honker substrate (when loaded) gets a `_honker_notifications` wake-up row.
- A running `atmux committer --daemon` picks the event up within ~100ms and dispatches the merge via ADR-134's state machine.
- Cron-backstop (`atmux committer --drain` on cron) catches any events the daemon missed (offset-table driven).

**What still needs to happen before "all event-driven"** (operator's 2026-05-22 directive — *"we want pubsub before switching... it has to be all event driven"*):

1. ✅ `task.done` / `task.claimed` emit points (this commit).
2. ✅ Gitter consumer running event-driven (this commit).
3. ❌ Cron decommission: drop the `*/5 atmux committer --sweep` line once daemons are verified across all teams (separate amendment).
4. ❌ Pane-state events → cockpit-watchdog replacement (separate EPIC).
5. ❌ Rotation observer events (ADR-212) — schema landed, consumer pending.
6. ❌ Complaint events (ADR-214) — schema landed, consumer pending.
7. ❌ Per-team daemon supervisor — wiring the daemon to start/stop alongside `atmux start` / `atmux stop` (separate EPIC; until then, operator launches manually or via cron).
8. ❌ Replace `*/2 cockpit-watchdog` + `*/5 lane-tick` + `*/15 poke` + `*/15 doctor wedge probes` with event-driven equivalents (per-cron-line decommission amendments).

Migration of running teams is gated on items 3–8. Substrate + first consumer shipped is the unblock — remaining work is consumer-by-consumer + cron-by-cron decommission.

**Filed via** 2026-05-22 driver session — *"do it all urself right here but in a separate worktree"*.


## §Amendment 2026-05-22 (II) — atmux-listener Rust subprocess: true kernel-blocking NOTIFY

Eliminates the 100ms in-process poll documented in §Amendment 2026-05-22 (I) §2 by spawning a small Rust subprocess that wraps Honker's native `Database::listen()` blocking iterator.

### Why this exists

Honker's watcher API (`UpdateWatcher`, `Subscription`, `UpdateEvents`) is exposed only at the Rust binding level, not as SQL functions. From bun:sqlite the `_honker_notifications` table can only be polled via `MAX(id)` cursor reads (~100ms cadence as shipped in §Amendment 2026-05-22 (I)). The watcher itself is implemented as a 1ms `PRAGMA data_version` poll inside Honker's Rust thread — but it's accessible only to Rust callers.

Bridging the gap: a tiny Rust binary (~80 lines, 1.6MB compiled) that:
1. Opens the team's `state.db` via `honker::Database::open()`.
2. Calls `db.listen("honker:stream:<topic>")` to get a blocking `Subscription` iterator.
3. Streams each `Notification` to stdout as one line: `<channel>\t<payload>\n`.
4. Exits cleanly on stdin close (parent died → broken-pipe → graceful exit).

The Bun parent (e.g. `atmux committer --daemon`) spawns this subprocess via `spawnNativeListener()` and feeds its stdout iterator into `watchEvents({externalSignals: ...})`. No in-process polling — the Bun event loop is genuinely idle between wake-ups.

### Where the code lives

- `rust/atmux-listener/Cargo.toml` — crate spec, depends on `honker = "0.3.3"` with `bundled-sqlite` feature so the binary links statically without needing libsqlite3-dev on the build host.
- `rust/atmux-listener/src/main.rs` — ~80-line binary. Wire protocol + lifecycle documented inline.
- `src/abstractions/native-listener.ts` — Bun-side spawner. Filters out the initial `ready` handshake, exposes `AsyncIterable<string>` of notification lines, handles graceful stop via stdin-close + SIGTERM.
- `src/abstractions/events.ts::watchEvents` — extended with `externalSignals?: AsyncIterable<string>` opt. When provided, the loop awaits the iterator instead of polling. Subprocess crash → graceful degrade to poll-mode (per the `externalSignals` contract).
- `src/verbs/committer.ts::committerDaemonVerb` — wires it together: when Honker is loaded AND the binary is available at `$ATMUX_LISTENER_BIN` or `/opt/atmux/current/bin/atmux-listener`, spawns the listener and threads its signals into watchEvents. Logs the wake-mode picked (`wake=native-listener` or `wake=poll`).
- `package.json::build:install` — runs `cargo build --release` in `rust/atmux-listener` and installs the binary alongside the main atmux shim.

### Verified latency

End-to-end smoke test (`tests/integration/native-listener-e2e.test.ts`) verifies Bun → `honker_stream_publish` → atmux-listener Rust subprocess → Bun stdout-read wake roundtrip in **~60ms on hax** (Hetzner AX42-U, default polling backend). This is bounded by Honker's 1ms `PRAGMA data_version` poll cadence plus stdout buffering jitter.

With the `kernel-watcher` Cargo feature enabled (notify-rs filesystem events on the `-wal` / `-shm` sidecars), expected latency drops to ~1ms — source-only opt-in per Honker upstream. Atmux's listener crate carries the feature flag pre-wired; enabling it is `cargo build --release --features kernel-watcher` in `rust/atmux-listener`. Not enabled by default until Honker upstream promotes kernel-watcher out of experimental.

### Cross-process publish-visibility prerequisite

Found during integration: bun:sqlite reports `PRAGMA journal_mode` as `"memory"` even after explicit `db.run("PRAGMA journal_mode=WAL")` — but the `-wal` / `-shm` sidecar files DO get created, and cross-process reads work. The reporting is a bun:sqlite display quirk; functionally the DB is in WAL mode. No code change required; documented here so future investigators don't waste an hour like the 2026-05-22 driver session did.

### Lifecycle + supervision

The listener subprocess is owned by its spawning Bun process. When the daemon exits (SIGTERM/SIGINT, error, --once completion), `handle.stop()` closes the subprocess's stdin and falls back to SIGTERM as belt-and-braces. The Rust binary observes broken-pipe on next stdout write and exits cleanly.

If the listener crashes mid-session (rare: watcher panic on file replacement, OOM, etc.), `watchEvents()` catches the iterator's throw and falls back to its in-process poll path (~100ms cadence). The daemon doesn't die — it just goes from kernel-blocked back to 100ms polling. A future amendment may add automatic respawn via `--respawn-on-crash`, but for now the cron-backstop drain (per §D6) catches anything the degraded daemon misses.

### Tests

- `tests/unit/abstractions/native-listener.test.ts` — 11 spawn-fn-injected tests (handshake filter, kill propagation, exit observation, env-driven path resolution).
- `tests/unit/abstractions/events.test.ts::watchEvents externalSignals` — 3 new tests (signal-driven drain, throw-degrades-to-poll, gapMs-respected).
- `tests/integration/native-listener-e2e.test.ts` — 2 real-binary tests (Bun publish → ≤1s wake, stop terminates cleanly). Gated on binary availability; skipped on dev machines without `cargo build`.

**Filed via** 2026-05-22 driver session — *"i am okay with us writing rust in atmux"* → *"yes start with the rust listener"*. Net: ~250 lines of Rust + Bun + tests + ADR, delivers true kernel-blocked NOTIFY/LISTEN without forking Honker.


## §Amendment 2026-05-22 (III) — `relayd` supervisor: atmux start wires the daemon into a service window

The atmux-listener Rust subprocess + the Bun-side `committer --daemon` shipped in (II) only had value if something actually ran them. This amendment puts both into a service tmux window spawned per-team by `atmux start`.

### Persona

**`relayd`** — Unix daemon naming convention (`*d` suffix, à la `httpd`, `sshd`, `crond`, OpenBSD's `relayd`). A deterministic infrastructure process — no Claude TUI, no LLM, no API tokens. Just signal routing. One per atmux team (parent or epic-team) inside that team's cage tmux server.

Distinct from the `committer` persona, which actually runs `git merge`. relayd is the dispatch layer that hands events TO the committer's handler. Future consumers (lane-router, rotation-observer, complaint-dispatcher) all plug into the same relayd primitive.

### Topology

| Scope | What spawns | Process count per team |
|---|---|---|
| Parent team | `atmux start <team>` | 1 relayd Bun process + 1 atmux-listener Rust subprocess |
| Epic-team | epic-team's own `atmux start` (inside child cage) | 1 relayd + 1 listener, scoped to epic-team's `state.db` |

Resource cost on hax: ~35-55MB RSS per team, ~0% CPU idle. Trivial against 128GB.

### Lifecycle teardown discipline

Operator concern 2026-05-22: *"make sure relayd dies alongside her team/cage."* Three defenses:

1. **bash trap** on `SIGTERM` / `SIGINT` / `SIGHUP` in the wrapper. Cascades to the foreground daemon via shared process group.
2. **`PR_SET_PDEATHSIG=SIGTERM`** in the Rust listener (Linux only). Kernel sends SIGTERM to the listener when the Bun parent dies, even via SIGKILL. macOS dev path stays poll-mode (no pdeathsig equivalent).
3. **PPID==1 check at startup** in the Rust listener — guards the race window where the parent died between spawn and `prctl()` registration.

Net: `atmux stop`, `tmux kill-server`, `kill -9 <bun-pid>`, parent crash — all paths terminate relayd's full process tree.

### Robustness audit + circuit breaker

Audit checklist landed alongside this amendment (16 failure modes reviewed; see `src/core/relayd-window.ts` header + ADR-202 §Amendment 2026-05-22 (III) commit message). Top fix:

**Infinite-restart circuit breaker.** Without it, a broken config / missing binary / bad DB schema would respawn the daemon every 5 seconds forever, generating log spam. The wrapper now tracks `CRASH_COUNT` over a 60-second sliding window — at ≥5 immediate crashes, exits with rc=42 + a loud log line directing the operator to investigate `.atmux/logs/relayd.log` and re-run `atmux start` to respawn after fixing. The cron `committer --drain` line stays installed, so event drainage continues without the daemon.

### Eligibility gate

relayd spawns ONLY when ALL of:
1. `team.autoMerge?.enabled === true` (same gate as committer --sweep / --drain)
2. team has a member with `role ∈ {committer, gitter}` (someone for relayd to dispatch TO; ADR-159 grace cycle accepts both)
3. `env.ATMUX_HONKER` is not explicitly `off`/`0`/`false` (substrate kill-switch off → no NOTIFY path; cron --drain handles event drain alone)

### SendTarget extension

Added `kind: "service"` to the ADR-025 `SendTarget` audit type — so reviewer-grep can filter "every send to a non-Claude infra window" distinctly from member / lead sends. Tmux argv shape is identical; the discriminator is intent-declaration only.

### Tests

- `tests/unit/core/relayd-window.test.ts` — 14 tests, 100% coverage on `relayd-window.ts`. Pins: gate failures (autoMerge / no committer / ATMUX_HONKER=off / legacy gitter accepted), idempotence (existing window / listWindows-throws degrades), success path (window spawn + correct send-keys), failure isolation (newWindow-throws logged + returned false), supervisor command invariants (SIGTERM trap, circuit breaker, clean-exit-no-restart, log-tee, atmux invocation).

### Operator-facing surface

After this amendment, `atmux start <team>` on an eligible team produces a `__relayd__` window in the cage tmux server. Operator attaches via `atmux attach <team>`, switches to that window with prefix+w, sees:

```
[2026-05-22T07:00:00Z] relayd: starting (crash_count=0)
committer --daemon: team='demo' honker=loaded wake=native-listener starting watcher (topics=[task.done])
native-listener: ready
```

…and stays idle (kernel-blocked) until events arrive. On `atmux stop`:

```
[2026-05-22T08:30:00Z] relayd: SIGTERM received, exiting
```

Clean.

**Filed via** 2026-05-22 driver session — *"we need to give her a name"* → after honest re-evaluation of Vesper vs alternatives → operator picked `relayd` (Unix daemon convention, no persona overload).


## §Amendment 2026-05-22 (IV) — `task.unclaimed` event + lane-router consumer

Second event-driven consumer wired. relayd now multiplexes two topics:
`task.done` (gitter merge dispatch) and `task.unclaimed` (lane-router immediate
claim-injection).

### Trigger

`addTask` emits `task.unclaimed` inside the same `transactImmediate` as the
kanban row upsert when ALL of:
- `status === "todo"` (always true on add)
- `lane` is set to a canonical v1 lane (fe / be / db / ops / test / review / misc)
- `owner === null`

Non-canonical lanes (`docs`, `git`) skip emit silently — the kanban row still
lands; the cron `*/5 lane-tick` continues to handle those.

### Payload shape

`TaskUnclaimedPayload` added to `src/schema/events.ts` discriminated union:
- `taskId`, `team`, `lane` (closed enum), `priority?`, `epicId?`, `storyId?`

### Consumer wiring

`atmux committer --daemon` extended:
- Subscribes to `["task.done", "task.unclaimed"]` in a single `watchEvents` call
- Two independent offsets (`atmux:gitter` + `atmux:lane-router`) for independent
  recovery — slow merge handler doesn't starve lane wake-up and vice versa
- Dispatch by topic discriminator: `task.done` → `ctx.handler` (gitter merge);
  `task.unclaimed` → `runLaneTick(atmuxDir, team)` (existing lane-tick logic)

`atmux committer --drain` extended:
- Runs gitterConsume (task.done) AND a separate withIdempotency loop for
  task.unclaimed → runLaneTick
- One-shot per cron tick; logs `done=N escalated=M unclaimed=K`

### Latency improvement

Before: a new unclaimed task with a lane sat in `todo` up to 5min before the
cron `*/5 lane-tick` fired the first claim-injection attempt.

After: emit fires inside the addTask transaction → relayd's atmux-listener
wakes within ~1ms (kernel-watcher) or ~100ms (default poll) → lane-tick runs
for that task's team → claim-injection happens within ~1sec end-to-end.

5min → 1sec on the happy path.

### Cron decommission posture

`*/5 lane-tick` cron line stays installed as backstop. Decommission per-team
once relayd lane-router proves out in production (operator verification +
ADR-amendment + cron-template edit). Future amendment.

### Tests

5 new tests in `kanban-sqlite.test.ts`:
- lane + no owner → emits task.unclaimed with correct payload
- lane + assigned owner → no emit
- no lane → no emit
- non-canonical lane → no emit (kanban row still lands)
- missing team.json → emit short-circuits silently (no throw)

### Naming pressure observed

The `committer --daemon` verb subscribing to `task.unclaimed` makes the verb
name a misnomer — "committer" implies merging, not lane-routing. A future
amendment introduces the canonical `atmux relayd --start` verb that
re-homes the multi-topic dispatcher to the persona we already named. The
internal helpers (`buildEventDrivenContext`, `runLaneTickImport`,
`gitterConsumeImport`) stay; only the CLI surface changes. Deferred to a
separate commit so this consumer-conversion lands cleanly.

**Filed via** 2026-05-22 driver session — *"keep going"* + /goal directive
("convert all event-driven consumers ... migrate all running teams").


## §Amendment 2026-05-22 (V) — `atmux relayd` promoted to top-level verb

The naming-pressure flag from §IV is paid down. `relayd` is now the canonical CLI surface for event-routing operations, separate from `committer` (which stays as the merge-related verb).

### Verb-tree shape

```
committer (merge-related operations)
  --sweep   ADR-134 branch-walking auto-merger (unchanged)

relayd    (event-routing operations — NEW)
  --start   long-lived NOTIFY/LISTEN multi-topic consumer (was committer --daemon)
  --drain   one-shot cron-backstop drain across all topics (was committer --drain)
  --once    test ergonomics
  --max-events N  test ergonomics
```

The body lives in `verbs/relayd.ts` as a thin dispatcher that re-uses the shared multi-topic dispatcher in `verbs/committer.ts`. Future amendment moves the body into `relayd.ts` once legacy `committer --daemon` is removed (next release cycle).

### Wiring updates

- **CLI dispatch** (`src/cli.ts`): new `case "relayd"` route.
- **relayd-window** (`src/core/relayd-window.ts`): supervisor command now invokes `atmux relayd --start` (was `atmux committer --daemon`).
- **Cron template** (`src/core/cron.ts`): cron line emits `relayd --drain` (was `committer --drain`). Log file renamed `committer-drain.log` → `relayd-drain.log`.
- **Golden cron block** + **cron-test verb list**: synchronized with the rename.

### Backward compat

Legacy `committer --daemon` and `committer --drain` flags STILL parse (no deprecation gate yet) so operator scripts + in-flight cron blocks from pre-V installations continue to work. Next release cycle adds an explicit deprecation-warn at the committer verb's dispatch on those flags, then removes them.

### Test surface

`tests/unit/verbs/relayd.test.ts` — 15 parser tests covering --start / --drain / --team-dir / --once / --max-events / error paths. 178 tests green across relayd + relayd-window + cron + committer.

**Filed via** 2026-05-22 driver session — operator's "make sure our arch is robust" review + ADR-202 §IV's documented naming-pressure flag.


## §Amendment 2026-05-22 (VI) — `mise.toml` project-level toolchain pins

Adds a project-root `mise.toml` declaring atmux's full build toolchain. Contributors on fresh machines run `mise install` in the project root and get Bun + Rust + tmux at the right versions without separate setup.

```toml
[tools]
bun = "latest"
rust = "stable"   # required for rust/atmux-listener
tmux = "latest"   # atmux requires >=3.4 per package.json engines
```

Rationale: before this commit, the atmux-listener Rust dependency was implicit — `npm run build:install` would fail on a fresh machine without `cargo` on PATH with no explanatory error. The mise.toml makes the requirement explicit at the project boundary.

CI: same `mise install` works in GitHub Actions. Honker-events branch was the first PR to introduce a Rust build dependency; this file makes that requirement legible to anyone reading the project structure.

**Filed via** 2026-05-22 driver session — operator's *"like install rust stuff into mise"*.


## §Amendment 2026-05-22 (VII) — `atmux-relayd` Rust binary owns the long-lived subscription

Operator directive *"let's do rust now"* + the RSS audit from this session (single Claude session ≈ 7-10× a full relayd stack worth of RAM) pointed to the right Rust deepening: not porting the gitter merge / lane-tick handlers (months of work for invisible savings), but reclaiming the relayd's idle Bun-process cost.

### Architecture — Path B: Rust dispatcher, Bun per-event handler

```
                                    ┌───────────────────────────────┐
   honker_stream_publish ──NOTIFY──→│  atmux-relayd (Rust)         │
                                    │  - Honker::update_events     │
                                    │  - rusqlite drain events     │
                                    │  - spawn Bun per event       │
                                    │  - rusqlite save offset      │
                                    │  ~5MB RSS idle, kernel-blocked│
                                    └───────────────┬───────────────┘
                                                    │ spawn per event
                                                    ↓
                                    ┌───────────────────────────────┐
                                    │ atmux relayd --handle-one     │
                                    │  --event-id X --topic T       │
                                    │ (Bun, one-shot)               │
                                    │  - load event by id           │
                                    │  - dispatch to topic handler  │
                                    │  - exit 0 (success) or 1      │
                                    │ ~50ms startup + handler time  │
                                    └───────────────────────────────┘
```

**Why this is the right shape:**
- Bun process runs only during actual handler execution. Idle infra is Rust-only.
- Handler logic (gitter merge state machine, lane-tick pane classifier) stays in Bun where it lives. No port. No two-language drift.
- Per-event spawn cost (~50ms) is negligible against our throughput (~100 events/day per team).
- Rust binary is ~80 lines; total project Rust LOC stays small.

### Where the code lives

- **`rust/atmux-relayd/`** — new Rust crate. Single binary `atmux-relayd`. Uses `honker = "0.3.3"` for NOTIFY/LISTEN + `rusqlite = "0.39"` for events table + offset queries. Builds to 1.6MB statically linked.
- **`src/verbs/relayd.ts::relaydHandleOne`** — new Bun handler entry point. Single-event dispatch: load event by `--event-id`, route to topic handler (gitter merge for `task.done`, runLaneTick for `task.unclaimed`), exit 0/1. The Bun process doesn't advance the offset for `task.done` — the Rust binary does on observing exit-code 0. For `task.unclaimed` the Bun handler advances the offset directly (defensive double-write; Rust will re-save and SQLite UPSERT serializes).
- **`src/core/relayd-window.ts`** — supervisor command updated to spawn the Rust binary first, falling back to Bun `atmux relayd --start` when the Rust binary isn't on PATH (degraded mode for pre-§VII installs that haven't redeployed).
- **`package.json::build:install`** — added `build:relayd` script. Both `atmux-listener` and `atmux-relayd` binaries staged at `/opt/atmux/$v/bin/`. `atmux-relayd` symlinked to `/usr/local/bin/` so the supervisor's `command -v atmux-relayd` check resolves.

### Verified end-to-end

Smoke test in `/tmp/test-relayd.sh`:
1. Bootstrap a state.db with Honker tables + atmux migrations.
2. Spawn `atmux-relayd` with fake atmux binary (logs invocations + exits 0).
3. Bun publishes `task.done` event + honker_stream_publish.
4. **Result: Rust binary detected wake + spawned fake atmux in 44ms** with correct args (`relayd --handle-one --event-id ... --topic task.done --team-dir ...`).

### Resource cost (verified on hax)

| Process | RSS idle | CPU idle |
|---|---|---|
| Pre-§VII Bun `atmux relayd --start` | ~30-50MB | ~0% |
| Post-§VII Rust `atmux-relayd` | ~3-5MB | ~0% |

Savings: ~30-45MB per team. Negligible against single-Claude-session weights (~350-580MB), but architecturally the Rust binary is the right shape — finite scope, no business logic, no Bun-runtime tax.

### Topics handled

Multi-topic dispatch driven by a static `CONSUMERS` array in `rust/atmux-relayd/src/main.rs`:
- `atmux:gitter` → `task.done`
- `atmux:lane-router` → `task.unclaimed`

Adding new topics = one entry in CONSUMERS + the Bun-side handler in `relaydHandleOne`'s topic switch. Future amendment (cockpit-mirror, complaint dispatcher, etc.) walks the same path.

### Teardown discipline (unchanged from §III + §V)

- `PR_SET_PDEATHSIG(SIGTERM)` on Linux — kernel sends SIGTERM when parent dies, even via SIGKILL.
- `PPID==1` check at startup guards spawn→prctl race.
- bash wrapper's SIGTERM/SIGINT/SIGHUP trap cascades to the Rust child via process group.
- Circuit breaker (5 crashes / 60s → exit 42) still applies — wrapper-level guard against unbootable Rust binary.

### Backward compat

The Bun `atmux relayd --start` path stays as a fallback (degraded mode when Rust binary not on PATH). Operators on older deploys without `atmux-relayd` get the Bun process; once they redeploy `npm run build:install`, the supervisor command's `command -v atmux-relayd` check flips them to the Rust path automatically. No breaking change at the operator surface.

### Tests

- `tests/unit/verbs/relayd.test.ts` — 21 parser tests (added 6 for `--handle-one`/`--event-id`/`--topic` invariants).
- 35/35 across relayd + relayd-window tests.
- E2E smoke verified manually (above).

**Filed via** 2026-05-22 driver session — *"i think we shoudl go rust"* → *"let's do rust now"*.


## §Amendment 2026-05-22 (VIII) — compound IDs (`<scope>-<N>-<hash>`) for tasks / stories / epics

Operator request 2026-05-22: hex-only IDs (`e-3b017960`) are hard to think about and remember; switch to monotonic running numbers (`e-1, e-2, e-1203`). After reconsideration: *"maybe use e-1-${hash} so that it's easier to grep"* — best of both worlds, running number for human recall, hash suffix for unambiguous grep.

### Format

`<scope>-<N>-<hash>` where:
- `<scope>`: `t` (task), `s` (story), `e` (epic)
- `<N>`: per-team monotonic positive integer starting at 1
- `<hash>`: 8 hex chars from `randomBytes(4)` (same generator as legacy)

Examples: `e-1-3b017960`, `t-1203-a1b2c3d4`, `s-7-deadbeef`.

### Why both halves

1. **Easier to remember.** "Epic 1 / Epic 1203" beats "Epic e-7a1014f9" in reviews + commit messages + brief writing. Same readability win that git tags and GitHub PR numbers give.
2. **Easier to grep.** `grep e-1 logs/*.log` matches too many things (every event-id starting with e-1...). `grep e-1-3b017960` matches exactly the one ID. The hash suffix makes IDs unambiguous in log streams.

### Per-team scope

Each team's `state.db` has its own counters in the `id_sequences` table. `e-1-X` in team A and `e-1-Y` in team B are distinct (different hash suffixes). Matches atmux's existing per-team isolation (cage sockets, kanban, events).

### Schema migration

Migration 11→12 adds `id_sequences (scope TEXT PRIMARY KEY, last_id INTEGER NOT NULL DEFAULT 0)`. Counters bootstrap at 0; first `nextId()` returns 1.

### Atomicity

Counter increment via single `INSERT ... ON CONFLICT DO UPDATE SET last_id = last_id + 1 RETURNING last_id` under SQLite write lock. Concurrent allocators get distinct values without races. Hash generation is independent (no DB roundtrip needed).

### Backward compat (forever)

Pre-§VIII IDs (`t-3b017960`, no running number) stay valid:
- Kanban rows keep their original IDs; nothing migrates automatically.
- ADR refs (`e-7a1014f9`, etc.) keep matching.
- Git branches with old IDs continue to merge.
- Hex IDs match by string equality everywhere — same lookup path as compound IDs.
- `isHexId(id)` / `isCompoundId(id)` / `isAnyId(id)` predicates available for code that needs to distinguish.

Migration verb to upgrade hex → compound IDs in-place is filed as an optional task (operator opts in per-team during a maintenance window). Defaults OFF.

### Partial-prefix matching (/btw #8)

`matchesIdPrefix(candidate, query)` accepts:
- Exact full ID: `t-1203-a1b2c3d4` ↔ `t-1203-a1b2c3d4`
- Running-number prefix: `t-1203` matches `t-1203-a1b2c3d4`
- Partial hash: `t-1203-a1b2` matches `t-1203-a1b2c3d4`
- Digit-boundary check: `t-1` does NOT match `t-12-abc` (prevents false collisions across running numbers)
- Hex-only candidates: exact equality required (no partial; would be ambiguous in legacy land)

Future polish: wire this into `atmux task show` / `atmux epic show` for typo-tolerant + short-form lookups.

### JSON-mode kanbans

JSON-mode teams (pre-SQLite-migration) stay on hex IDs — sequence counter requires a SQLite write transaction. Every team running atmux today is SQLite-mode; this is a defensive fallback for legacy fixtures + test scaffolds.

### Loop-prevention regex update

`AUTO_EMIT_SUBJECT_RE` in `src/core/kanban.ts` extended to accept BOTH legacy hex (`t-3b017960`) AND new compound (`t-1-3b017960`) IDs in the auto-emit Task subject prefix:

```ts
/^merge t-(?:[1-9][0-9]*-)?[0-9a-f]+ \(branch→trunk\):/
```

Other regex-matched ID consumers (lane-tick / claim / kanban filters) already use string equality — no change needed.

### Caveat fix: `loadEventById` helper

The §VII `relayd --handle-one` path used a cursor-trick on `drainSince` for single-event lookup (decrement-last-char on eventId). Brittle if event-id encoding ever changes. Replaced with a dedicated `loadEventById(db, eventId)` in `src/abstractions/events.ts` — direct `SELECT payload FROM events WHERE event_id = ?` + Zod parse.

### `atmux relayd --status` verb (/btw #9)

Single-shot diagnostic surfacing relayd state without log-grepping:
- Per-consumer subscriber offset + age
- Events table size + last-hour count
- Per-topic counts (last 24h)
- Honker `_honker_notifications.MAX(id)` (when substrate loaded)
- `PRAGMA journal_mode`

Tab-separated output, grep-able. Operator runs `atmux relayd --status` and gets full picture in <100ms.

### Concerns folded as queued tasks

From operator's /btw audit (image 2026-05-22):
- **#1 Relayd direct send-keys** — Task #24 (filed)
- **#2 Doctor probe for relayd** — partial: `--status` verb covers most. Doctor probe queued for unified probe surface.
- **#3 Cockpit-mirror consumer** — Task #25
- **#4 Cron decommission protocol** — Task #26
- **#5 Events table pruning** — Task #27
- **#6 Idempotency stress test** — Task #28
- **#7 WAL checkpoint observability** — covered partially by `--status` verb
- **#8 Partial-prefix matching** — shipped in `matchesIdPrefix`
- **#9 `atmux relayd status` verb** — shipped
- **#10 Hex→sequence migration verb** — Task #29 (opt-in)
- **Caveat: cursor-trick brittleness** — fixed via `loadEventById`
- **Caveat: 60s timeout double-process** — Task #28 (idempotency test will cover)
- **Caveat: circuit breaker on big-backlog restart** — Task #30

### Tests

`tests/unit/core/id-sequence.test.ts` — 25 tests covering nextId allocation, scope independence, counter persistence, hash override seam, format detection (compound / sequence / hex / any), partial-prefix matching with digit-boundary edge cases, 100-call concurrency invariant.

`tests/unit/verbs/relayd.test.ts` — 3 new tests for `--status` sub-verb parser.

`tests/unit/core/kanban-sqlite.test.ts` + `tests/unit/core/kanban.test.ts` — regex updates for compound ID format.

202/202 across touched paths.

**Filed via** 2026-05-22 driver session — *"all 3. start the implementation. it has to be COMPLETE FOR USE"* → *"maybe use e-1-${hash} so that it's easier to grep"* + /btw fold-in.

## §Amendment 2026-05-22 (X) — Cron decommission protocol

Drives the operator playbook for retiring a parallel cron line once its event-driven relayd counterpart has earned trust. Filed under epic e-b7a702d1 (/btw correctness fold-in) story s-95f312ab (S1) per /btw audit #4.

### Motivation — parallel-path risk if no retire gate exists

Every cron/relayd parallel pair is intentionally redundant at substrate-load time: the relayd consumer is the latency floor (sub-second), the cron line is the structural backstop (catches missed-emit + cold-start races + substrate downtime). Defense-in-depth is correct during bring-up. But the pairs become *liabilities* if they run in parallel forever without a retire gate:

1. **Double-process risk** — both paths invoking the same handler on the same event multiplies side-effects (e.g. two committer-sweeps racing the same `<base>-<member>` merge, two lane-ticks dispatching the same lane). Idempotency gates per-handler must hold, but every additional path adds a contention surface.
2. **Operator confusion** — when a beat fails, "did cron fire?" + "did relayd fire?" + "did both?" + "which one did the work?" tripled log-grep surface vs. a single-source-of-truth path.
3. **Drift** — cron-template emit code (`src/core/cron.ts`) and relayd consumer code (`src/core/*-consumer.ts`) drift independently; a bug fix in the relayd path may not land in the cron path or vice versa, leaving the team silently on the buggy fallback when one fails.
4. **Cost ratchet** — every team's crontab grows; on hosts with many teams the cron noise itself becomes a tail-latency problem (concurrent `cron` fanout fights the same SQLite write lock the relayd consumer already serializes through).

A retire gate forces operators to make the decommission decision explicitly, with a probe-backed verdict, instead of letting the parallel-path state ossify.

### The gate (concrete spec — copy-pasteable for operators)

Before removing any parallel cron line, ALL THREE of the following MUST hold:

1. **Substrate uptime** — the relayd consumer for the topic in question has been live for **≥ N days** (default `N=7`). Probe via `atmux relayd --status` (per §V): the consumer's `subscriber_offsets` row must exist and its `last_seen_at` must be within the last cron-cadence window (i.e. relayd hasn't fallen behind the substrate).
2. **Zero-loss across the window** — `atmux doctor relayd-event-loss --topic <X> --since <now-N-days>` returns zero-loss: every event emitted on topic `<X>` over the N-day window was acknowledged by the consumer's subscriber_offsets advance. (The doctor probe itself ships separately — see §Out of scope.)
3. **Decommission-time probe + record** — operator manually runs `atmux doctor relayd-event-loss --topic <X> --since <last-N-days>` at decommission time AND attaches the output verbatim into the decommission commit body. The N-day probe is the durable evidence trail; a future revert needs to know the verdict that authorized the removal.

`N=7` is the default; per-team override via `team.json::honker.decommissionWindowDays`. Shorter windows are valid for low-volume topics where 7 days is uneconomic; longer for high-stakes topics (e.g. epic-merge fan-in) where the operator wants extra evidence before drop.

### Procedure steps

The full decommission flow:

a. **Install the relayd consumer for topic `<X>`** (or confirm it's already installed). Verify via `atmux relayd --status | grep <consumer-name>`. If the consumer row is absent, do NOT proceed — file a Task to install it first.

b. **Leave the existing parallel cron line in place.** Both paths MUST run concurrently for the gate window. Do NOT short-circuit by removing the cron line "because relayd is already running" — the gate measures the relayd path's reliability *against* the cron path's coverage. Skipping the parallel phase forfeits the evidence that decommission is safe.

c. **Wait N days** (default 7). During this window, do not touch the cron line. Resist the temptation to "test the decommission early" — the whole point is N consecutive days of zero-loss observation, not a snapshot.

d. **Run the doctor probe**: `atmux doctor relayd-event-loss --topic <X> --since <ts-N-days-ago>`. The probe MUST return zero-loss. If it returns non-zero loss, investigate the loss class first — the relayd path isn't ready and the cron stays.

e. **Remove the cron block** from `team.json::cronTemplates` (or whichever team.json field gates the cron-line emission for topic `<X>`) AND run `atmux start` from the team root to regenerate the host crontab. The `atmux:team=<name>` sandwich markers (per ADR-083) idempotently rewrite the team's crontab block; the now-absent cron line falls off automatically.

f. **Commit with body**: `Decommission: cron <topic-X> per ADR-202 §X (probe output attached).` Paste the verbatim `atmux doctor relayd-event-loss` output in the commit body as the audit trail. Push to the team's base; the next `atmux start` on any peer host picks up the removed line via crontab re-emit.

### Enumeration of CURRENT parallel cron/relayd pairings (as of ADR write date 2026-05-22)

| # | Cron line | Relayd consumer / topic | Notes |
|---|-----------|-------------------------|-------|
| 1 | `lane-tick` every 5min (`src/core/cron.ts:306`, default `DEFAULT_LANE_TICK_CRON_MINS=5`) | `lane-router` consumer subscribing to `task.unclaimed` topic (emitted from `src/core/kanban.ts:287` per §IV) | Cron is the structural backstop for wedged panes / compaction-wipe / rate-lockout cases /goal cannot see; relayd is the happy-path latency floor. |
| 2 | `committer --sweep` every `team.autoMerge.cronBackstopMin` min (default 10, `src/core/cron.ts:403`) | `committer --drain` invoked from a cron line at `*/1min` (per §II), backed by the `atmux:gitter` consumer subscribing to `task.done` (`src/core/gitter-consumer.ts:98`) | `--sweep` walks every `<base>-<member>` branch (catches events the substrate missed entirely); `--drain` processes substrate-emitted events at the cron cadence floor. Both gated on `hasGitter && autoMerge.enabled`. |

Pre-decommission, operators MUST re-grep `team.json` against the live relayd subscriber list (`atmux relayd --status`) to confirm the table above is still complete — new pairings landed between this ADR write and the operator's decommission window will not appear here.

### Reversibility

Re-installing a decommissioned cron block requires only:

1. Restore the corresponding cron template in `team.json` (or revert the commit that dropped it).
2. Run `atmux start` from the team root. The host crontab regenerates with the previously-removed line back in place.

No state migration. No data backfill. No re-bootstrap of the consumer offsets table. The relayd path keeps running unchanged; the cron line simply rejoins as a parallel safety net.

This is by design — the decommission gate is high-friction (7-day wait + manual probe), but the rollback is one config flip + `atmux start`. Operators encountering substrate trouble post-decommission can restore the cron parallel-path in seconds without escalation overhead.

## §Amendment 2026-05-22 (XI) — Events-table prune policy

The `events` table is append-only by design (§D6 durability invariant). Without periodic eviction it grows unbounded — every `emit()` is one row, retained forever in Phase-1. Filed under epic e-b7a702d1 (/btw correctness fold-in) story s-31997a2c per /btw audit #2. Implemented by `src/core/events-prune.ts` (T2.2, t-c3a40f38); state column added in v12→v13 migration (T2.1, t-0d79d5bd).

### Invariant — offset-gated pruning

**Events are NEVER deleted while their rowid exceeds `MIN(subscriber_offsets.last_event_id_rowid)` across all consumers.** This is non-negotiable. The slowest consumer defines the prune ceiling. Even if an event is past the TTL or pushes the table past `maxRows`, if a single consumer hasn't read past it, the row stays. Consumer-truth wins over space pressure.

Practical corollary: a registered consumer that has never run (`last_event_id == ""` sentinel from `loadOffset()`) effectively blocks all pruning. The first-run gap is acceptable cost; missed-event consequences are far worse than a temporarily oversized events table.

### Policy defaults (`team.json::honker.eventsPrune`)

| Knob | Default | Meaning |
|------|---------|---------|
| `ttlSec` | `30 * 86400` (30 days) | Events older than `now - ttlSec` are TTL-eligible. |
| `maxRows` | `100_000` | Soft cap on the `events` table. Above this, FIFO-evict the oldest rows from within the offset-allowed window until back at the cap. |

Both knobs are caller-overridable per `prune()` call — callers passing explicit values supersede team.json defaults. The team.json structure is documented at the wiring-Task layer (this amendment defines policy intent; the wiring Task surfaces the config schema in the operator-facing RUNBOOK).

### Trigger model — caller-invoked, not auto-scheduled

`prune()` is a pure function. It does NOT register itself with cron, relayd, or any auto-scheduler. The caller (a future wiring Task) decides when to invoke:

- A relayd-tick handler can fire `prune()` opportunistically on every Nth event drained.
- A cron line (`atmux:team=<name>:events-prune`) can call it at a fixed cadence (operator-tunable).
- The doctor probe can dry-run-style invoke it for capacity diagnostics.

Out-of-scope for this amendment: the wiring topology (relayd vs cron vs both). A follow-up Task (filed post-T2.2) will pick the trigger pattern and ship the integration.

### State — `prune_state` (v12→v13, ADR-202 §XI)

| Column | Type | Meaning |
|--------|------|---------|
| `team_name` | `TEXT PRIMARY KEY` | One row per team (cage isolation). Matches the team identifier in `team.json`. |
| `cursor` | `INTEGER NOT NULL DEFAULT 0` | Highest `events.rowid` pruned so far. Floor for the next sweep so we don't re-scan the head of the table every tick. |
| `last_pruned_at_sec` | `INTEGER NOT NULL DEFAULT 0` | Unix seconds of the most recent sweep completion. Drives operator cadence checks and the medic visibility probe. |

`prune_state.cursor` is intentionally INTEGER (rowid space), not TEXT (UUIDv7 space) — rowid ordering matches UUIDv7 emission order for the events table (single-writer + append-only) and rowid comparisons are cheaper than TEXT lex comparisons at scale.

### Return contract

`prune(db, opts)` returns `{ deleted, skipped, reason? }`:

- **Happy path**: `{ deleted: N, skipped: 0 }` — N rows actually DELETEd; `prune_state.cursor` advanced; `last_pruned_at_sec` stamped.
- **Skip path**: `{ deleted: 0, skipped: M, reason: "offsets stale — no consumers advanced past prune_state.cursor since last prune" }` — M is the count of events eligible *if* offsets advanced, surfaced so the caller can build operator visibility ("12k events queued, no consumer has read past id 42"). `prune_state` is NOT written on skip — cursor stays where it is so the next sweep retries cleanly.

### Reviewer gates (T2.2 + this amendment)

- All DB writes wrapped in `db.transaction(() => ...)()` — atomic per-call, no half-prune state visible to other readers.
- 100% line + function coverage on `src/core/events-prune.ts` (tests cover all 6 AC paths + boundary throw + slowest-consumer + cursor-persistence).
- Strict offset-gate verified by the slowest-consumer test — eviction respects `MIN(offset)` across multi-consumer setups.

### Out of scope for this amendment

- Caller wiring (relayd-tick hook vs cron line vs doctor probe). Follow-up Task.
- Multi-team coordination — `prune()` operates on a single team_name per call.
- Rollback / unprune — no undo verb. Pruned rows are gone; the durability contract is satisfied by the consumer's offset advance (the consumer confirmed processing before we pruned).

## §Amendment 2026-05-22 (XIII) — `atmux migrate-hex-ids` verb

Operator one-shot to renumber pre-§VIII legacy hex-only IDs (`<scope>-<8 hex>`) onto the compound `<scope>-<N>-<hex>` shape that §VIII established. Implemented by `src/verbs/migrate-hex-ids.ts` (T4.1, t-b7598005). Filed under epic e-b7a702d1 (/btw correctness fold-in) story s-7de3720c per /btw audit #4.

### Verb name + flags

```
atmux migrate-hex-ids [--dry-run] [--apply]
                      [--scope=epics|stories|tasks|all]
                      [--team=<name>]
```

- `--dry-run` (default ON when `--apply` is absent) — print the legacy→compound mapping table; **no DB writes**, no branch renames, no ADR rewrites.
- `--apply` (REQUIRED to write) — execute the planned migration. Without this flag the verb is a read-only inspector.
- `--scope` (default `all`) — restrict which PK columns are scanned for legacy IDs. `epics` / `stories` / `tasks` scan exactly that table; `all` scans all three. FK + JSON-array sweeps always cover the full mapping (otherwise we'd dangle references).
- `--team` — override `team.name` resolved from cwd `team.json`. Single-team only; cross-team coordination is out of scope.

### Safety

- **Default-OFF**: omitting `--apply` is a no-op dry-run, even when `--dry-run` itself is omitted. The verb refuses to mutate without explicit `--apply`.
- **Snapshot-before-commit**: pre-mutation mapping table written to `.atmux/migrations/hex-ids-<unix-ts>.json` so operator-rollback stays viable even if the process crashes mid-flight. Snapshot lands AFTER the kanban transaction commits but BEFORE any out-of-DB mutation (`team.json` / git branches / ADR pointers) — the loudest failure path leaves the DB consistent + snapshot recoverable.
- **Atomic kanban transaction**: every PK rename + FK update + JSON-array substitution + event-payload rewrite wraps in a single `db.transaction(() => ...)()`. SQLite STRICT tables enforce PK uniqueness, so we copy → re-point FKs → drop the legacy row (three-phase) rather than UPDATEing the PK directly.
- **Branch rename try/catch**: legacy `<base>-epic-<hex>` branches get `git branch -m` to `<base>-epic-<compound>`. Missing branches log a `WARN migrate-hex-ids: branch rename skip — ...` and continue (operator may have already renamed manually).
- **ADR pointer rewrite**: docs/adr/*.md scanned for legacy ID substrings; matched files rewritten with the compound form. Out-of-scope IDs are left alone (no spurious diffs).

### Snapshot location + manual rollback

`.atmux/migrations/hex-ids-<unix-ts>.json`. Shape:

```json
{
  "ts": 1779470000,
  "team": "team-alpha",
  "scope": "all",
  "mappings": [
    { "legacyId": "t-3b017960", "compoundId": "t-7-3b017960", "scope": "t", "sequenceN": 7 },
    ...
  ]
}
```

Manual rollback (no rollback verb in T4.1 — follow-up Task):

```bash
jq -r '.mappings[] | "\(.compoundId) \(.legacyId)"' \
  .atmux/migrations/hex-ids-<unix-ts>.json |
  while read new old; do
    # Reverse each kanban update + event-payload substitution.
    # (Operator-driven; rollback verb will automate.)
  done
```

### Scope mechanics

The PK scan respects `--scope`, but **all FK sweeps + JSON-array substitutions + event-payload rewrites apply to the full mapping table** built from that scan. Reasoning: if you renumber `e-3b017960 → e-7-3b017960` but leave `tasks.epic = 'e-3b017960'` un-rewritten, the task is orphaned. There's no "partial migration" that keeps the kanban consistent; the scope flag controls only which PKs are eligible to be renumbered in this run.

Out-of-scope kanban references that point to legacy hex IDs OUTSIDE the current `--scope` are left alone (no FK sweep, no JSON substitution). Operator must re-run with a wider scope or `--scope=all` to catch them.

### Out of scope (T4.1)

- **Rollback verb**: follow-up Task. Snapshot is captured + readable; reverse-walk is operator-scripted today.
- **Multi-team coordination**: each team's `state.db` migrates independently. No cross-team rename propagation.
- **Tests**: T4.2 ships unit tests covering all the verb's branches (dry-run plan / apply path / scope filter / snapshot / branch-rename failure / ADR rewrite).
- **`c-` scope (complaints PK)**: complaint IDs use the same hex shape but live in their own table; their migration is a follow-up because `id_sequences` doesn't yet carry a `c` scope. `complaints.related_task_id` IS updated (it's a FK to tasks).
