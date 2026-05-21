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

Eight EPICs in sequence, each kill-switched, each kept-behind-cron-backstop until ≥30 days observed-stable:

| EPIC | Scope | Eta |
|---|---|---|
| e-honker-substrate | Extension load + schema (per-team + cockpit-events DBs) + consumer-base class + kill-switch + doctor probe + smoke tests. **No consumers.** | 3-5 days |
| e-honker-jury | First real consumer — `_jury` ratify/verdict pipeline (ADR-204). Cron-poll backstop kept. | 2-3 days (after substrate) |
| e-honker-gitter | gitter listens for `task.done` → merge. Cron retained. | 1-2 days |
| e-honker-watchdogs | Port absence-detection (15min stall, wedged pane, lead-unresponsive) to Honker scheduler. Deletes ≥5 cron entries. | 1-2 days |
| e-honker-whip | `/whip run` loop becomes event-consumer; deprecation grace one release. | 1-2 days |
| e-honker-sentinel | Sentinel observation eventized; pane-classifier event-triggered (not periodic). | 1-2 days |
| e-honker-medic | Medic state-driven on complaint/hygiene/wedge events. | 1-2 days |
| e-honker-cleanup | Delete deprecated loops; remove cron-backstops where ≥30 days stable; ADR-091/134/145 §Amendments documenting switchover. | 2-3 days |

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
