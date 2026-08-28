# ADR-230: `atmux-cockpit-mirror` Rust crate — fleet-wide event consumer

> **Renumbered 2026-05-23**: originally filed as ADR-219; collided with [ADR-219 dissolve-epic-completeness](219-dissolve-epic-completeness.md) (filed earlier same day, May 22). Per "older keeps the number" heuristic, this one renumbered to ADR-230. Cross-refs updated across cli.ts, cockpit-mirror.ts, ADR-224, ADR-202, and the t-4160d662 + t-809d1ed9 review docs.

**Status**: proposed (deferred: pending crate scaffold + cockpit-events.db schema bootstrap + per-team mirror writer wiring per OQ1)
**Date**: 2026-05-22
**Driver-ref**: 2026-05-22 operator /btw audit fold-in #3 (cockpit-mirror consumer). Epic e-95087c8b Story 2 — *"Per-team relayd is single-team scope. Add a cockpit-level consumer that subscribes to mirrored events across all teams in the cockpit. Enables fleet observability: Discord pings, dashboard hooks, fleet-wide alerting without each team reimplementing."*
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) §D3 (separate per-team `.atmux/state.db` + cockpit-level `~/.atmux/cockpit-events.db` + per-team `cockpit-mirror` consumer architecture — this ADR delivers the cockpit-side reader of that design), [ADR-202](202-honker-in-db-messaging-substrate.md) §Amendment 2026-05-22 (VII) (`atmux-relayd` Rust binary supervisor pattern — reused here), [ADR-202](202-honker-in-db-messaging-substrate.md) §Amendment 2026-05-22 (IX-A) (sibling Epic e-95087c8b Story 1 — relayd direct send-keys, the per-team analogue of this cockpit-scoped consumer), forthcoming **ADR-203** (event topic taxonomy + payload schema — picks the cross-team whitelist authoritatively), [ADR-077](077-superdoctor-cockpit-role.md) (cockpit-superdoctor — first downstream fleet-scoped consumer), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) §D6 (`budget.warning` / `budget.recovered` subscribers — cockpit-mirror is the dispatch path), [ADR-200](200-install-wizard-guided-first-run-setup.md) §D6 (Honker substrate install — the cockpit-events.db schema-bootstrap step lives in the wizard's Layer 1).

## Context

ADR-202 §D3 specifies the cross-team propagation architecture:

> **Cross-team propagation: per-team `cockpit-mirror` consumer.** When a team event needs fleet visibility (e.g. `epic.merge_ready` on a child epic-team needs to wake the parent team's gitter), a long-running `cockpit-mirror` consumer in the team's process subscribes to local state.db topics and INSERTs the event into cockpit-events.db. The cockpit subscriber then picks it up. No child→sibling direct ATTACH; the cockpit DB is the bus.

Two halves are needed for that architecture to work:

1. **Per-team mirror WRITER** — runs in each team's process, INSERTs whitelisted events from local `state.db` into `~/.atmux/cockpit-events.db`.
2. **Cockpit-level READER** — runs in cockpit scope, subscribes to `~/.atmux/cockpit-events.db` via Honker NOTIFY/LISTEN, dispatches each event to fleet-scoped handlers (Discord webhook for `budget.warning`, dashboard hook for `epic.merge_ready`, etc).

Both halves are unbuilt today. Cross-team event delivery currently flows through `tell-lead` durable-inbox + best-effort tmux keystroke wake (per ADR-202 §D8); this works for human-mediated coordination but doesn't support fleet-wide automation (Discord pings, dashboard updates, fleet-wide alerting). Each downstream consumer that wants fleet visibility today reimplements the cross-team poll-or-grep pattern.

§VII landed the per-team `atmux-relayd` Rust binary that owns the per-team subscription + dispatch loop with ~5MB RSS idle. The same shape applied at cockpit scope gives us a single ~5MB Rust process for fleet-wide event observation — finite scope, no business logic, no Bun-runtime tax.

The Epic e-95087c8b Story 2 charter is to ship the cockpit-side READER as a new Rust crate. The per-team WRITER side is a coordinated decision recorded as OQ1 below (default: extend `atmux-relayd` so a single Rust crate owns both per-team SUBSCRIBE + cockpit-events.db WRITE roles, vs. introducing a second per-team Rust process).

## Decision

### D1 — New Rust crate `rust/atmux-cockpit-mirror/`

Single binary `atmux-cockpit-mirror` built from `rust/atmux-cockpit-mirror/`. Cargo metadata mirrors `rust/atmux-relayd/` (same `honker` + `rusqlite` + `libc` + `serde_json` deps at the same pinned versions). Builds statically linked, target binary size <2MB (matching `atmux-relayd` ~1.6MB).

Process is a singleton at cockpit scope — one process per cockpit, not per team. Lifecycle is owned by the cockpit's `atmux start` analogue (the per-cockpit launcher path that lives in the install wizard's Layer 1, ADR-200).

### D2 — Subscribes to `~/.atmux/cockpit-events.db` via Honker `update_events`

Same wake pattern as `rust/atmux-relayd/src/main.rs`:

1. `Database::open(~/.atmux/cockpit-events.db)`.
2. Bootstrap on open: if the file is absent or missing Honker tables / `events` table / `subscriber_offsets`, run the schema migrations (kept in sync with the `events` schema in `src/abstractions/sqlite-migrations.ts`). Idempotent.
3. `db.update_events()` recv loop with 60s timeout drain (belt-and-braces — same pattern as `atmux-relayd` against subtle Honker bugs).
4. On wake: drain new event_ids per consumer (`atmux:cockpit-mirror:<topic>`); for each event, dispatch.

Subscriber offsets stored in `cockpit-events.db::subscriber_offsets` table (same schema as per-team — re-uses the existing helper-row shape).

### D3 — Topic whitelist (initial v1 set)

Cockpit-mirror subscribes to a hardcoded whitelist; non-whitelisted topics are ignored. Initial v1 set:

| Topic | Why fleet-scoped | Downstream consumer |
|---|---|---|
| `epic.merge_ready` | Parent team's gitter needs to know when child epic-team is ready to fan-in | gitter dispatcher (per ADR-091) |
| `epic.spawn_blocked` | Operator visibility for blocked spawn attempts | Discord ping + cockpit dashboard |
| `team.spawned` | Cockpit registry update; sentinel new-team awareness | registry-rebuild trigger |
| `team.dissolved` | Cockpit registry cleanup; cron-block reaper | registry-rebuild + cron-reaper |
| `budget.warning` | Claude account pool reroute (per ADR-199 D6) | account-pool selector |
| `budget.recovered` | Re-enable rerouted accounts | account-pool selector |
| `gitter.escalated` | Lead-gated destructive action escalation needs fleet visibility | Discord ping + lead-inbox write |

Adding a new topic = one entry in the `CONSUMERS` array + the matching Bun-side handler in `src/verbs/cockpit-mirror.ts`'s topic switch.

The full taxonomy (payload shape + cross-team propagation rules) is owned by ADR-203 (forthcoming, sibling Epic e-6a066299). This ADR commits to the v1 whitelist above; updates land via amendment as new topics warrant fleet visibility.

### D4 — Per-event spawn `atmux cockpit-mirror --handle-one --event-id X --topic T` (Bun)

Same wire-format shape as `atmux-relayd` → Bun (ADR-202 §VII):

```
atmux-cockpit-mirror (Rust)
  └─ spawn `atmux cockpit-mirror --handle-one --event-id X --topic T`
      └─ Bun parses topic, dispatches via switch:
         epic.merge_ready  → gitter-dispatcher hook
         budget.warning    → Discord webhook helper
         gitter.escalated  → flag-add + Discord webhook
         (etc per D3 table)
         exit 0 → Rust caller advances offset
         exit nonzero → Rust does NOT advance offset; next wake retries
```

Bun process runs only during handler execution (~50ms cold start + handler time). Idle infra is Rust-only.

Cocpit-mirror's Bun verb is a new top-level: `atmux cockpit-mirror <--handle-one|--once|--status> [--event-id ID --topic T]` in `src/verbs/cockpit-mirror.ts`. Parser shape + UsageError discipline mirrors `src/verbs/relayd.ts` (per ADR-202 §V + §VII patterns).

### D5 — Lifecycle: cockpit-scoped supervisor window + circuit breaker

Spawned at cockpit start (separate from per-team `atmux start` — cockpit-mirror is fleet-scoped, not per-team). Same supervisor discipline as `atmux-relayd`:

- `PR_SET_PDEATHSIG(SIGTERM)` on Linux — kernel sends SIGTERM when parent dies.
- `PPID==1` startup guard against orphan-after-prctl race.
- bash wrapper trap on `SIGTERM` / `SIGINT` / `SIGHUP` → clean exit + process-group cascade.
- Circuit breaker: 5 crashes / 60s → exit 42 + loud log; operator notices on attach + investigates + reruns cockpit launcher to respawn.
- Log file: `~/.atmux/logs/cockpit-mirror.log` (via `tee -a` for in-pane scroll + file capture).

Cron backstop (ADR-202 §D6 defense-in-depth pattern): a cockpit-scope cron line emits `atmux cockpit-mirror --drain` at lower cadence (every 5min) as a safety-net catch-net for missed events. If the wake loop dies and stays dead between cockpit-start invocations, drain catches events within ~5min.

## Consequences

- **Fleet-wide event observation is centralized.** Discord, dashboard hooks, fleet-wide alerting move from per-team-reimplementation to one cockpit handler. Net code-LOC reduction across consumer EPICs.
- **One additional Rust binary** (`atmux-cockpit-mirror`) staged + symlinked alongside `atmux-relayd` + `atmux-listener` via `package.json::build:install` (Epic e-95087c8b T-S2-10 wires the 3rd stage).
- **One additional supervisor window** (cockpit scope) — adds to cockpit attach footprint (~5MB RSS idle).
- **Schema-bootstrap responsibility** lands in `atmux-cockpit-mirror` (it creates `~/.atmux/cockpit-events.db` if absent + runs migrations on open). ADR-200 install wizard Layer 1 still probes for the directory + permissions but no longer needs to bootstrap schema separately.
- **Rollback path**: cockpit-mirror is opt-in via `ATMUX_HONKER=on` + presence of `atmux-cockpit-mirror` binary on PATH. Operators that don't deploy `npm run build:install` for the 3rd binary get the existing tell-lead + cron path (no fleet-wide observation, no regression on per-team).
- **No dependency on Epic-B-owned files** (per Epic e-95087c8b file-ownership rules: this ADR's Tasks don't touch `src/abstractions/events.ts`, `src/abstractions/sqlite-migrations.ts`, `src/core/id-sequence.ts`).

## Open questions

### OQ1 — Per-team mirror WRITER lives in `atmux-relayd` (extend) or new crate?

**Default**: Extend `atmux-relayd` — add an INSERT into `~/.atmux/cockpit-events.db` for whitelisted topics inside the existing `drain_and_dispatch` loop. Single Rust crate to maintain, no extra per-team supervisor wiring, single round-trip (one SQLite write per whitelisted event).

Alternative options weighed:

- (b) **New dedicated per-team `rust/atmux-mirror-writer` crate** — full separation, easier to evolve writer-side independently, but adds a second per-team Rust process + supervisor + circuit breaker.
- (c) **Bun post-write hook** — write the mirror INSERT inside the existing Bun-side `publish()` helper in `src/abstractions/events.ts`. Avoids any Rust extension to atmux-relayd. **Hard blocker**: Epic A doesn't own `src/abstractions/events.ts` (sibling Epic e-6a066299 owns it per file-ownership rules), so this option requires cross-Epic coordination.

Reversibility: medium. Migrating from (a) to (b) later means extracting the writer logic out of `atmux-relayd` into its own crate — ~1 day of work, no schema impact, no on-disk state migration.

Default (a) recorded in `.atmux/decisions.md` 2026-05-22 (planner-decided, override window: before T-S2 t-b6bea677 merges).

### OQ2 — `~/.atmux/cockpit-events.db` schema bootstrap responsibility

**Default**: Crate `atmux-cockpit-mirror` owns the bootstrap. On startup, opens the file; if Honker tables OR `events` table OR `subscriber_offsets` table are absent, runs the migration set inline. Migration set is kept in sync with `src/abstractions/sqlite-migrations.ts` events / subscriber_offsets schema — file-ownership note: Epic A does NOT modify `sqlite-migrations.ts` itself (Epic B owns it); we inline the same DDL in Rust.

Alternative: ADR-200 install wizard creates + bootstraps the file at install time; cockpit-mirror only opens. Cleaner separation but adds a wizard step + a "DB missing post-install" failure mode that crate-side bootstrap doesn't have.

Reversibility: low (changing later means the wizard takes over the schema-create path; crate becomes open-only).

## Testing

- **Rust unit tests** under `rust/atmux-cockpit-mirror/tests/` — schema-bootstrap-on-absent-file, topic-whitelist-filter, dispatch-args-shape, offset-advance-on-rc-0, offset-no-advance-on-rc-nonzero.
- **Bun unit tests** at `tests/unit/verbs/cockpit-mirror.test.ts` — parser matrix (handle-one, drain, status, error paths) + per-topic dispatch stubbing.
- **Integration smoke** at `tests/e2e/cockpit-mirror-smoke.sh` — bootstrap temp cockpit-events.db + spawn binary with fake atmux + publish whitelisted event + assert spawn-with-correct-argv within 100ms + publish non-whitelisted event + assert NO spawn.
- **8593+ existing unit tests stay green** — cockpit-mirror is opt-in via binary presence + `ATMUX_HONKER=on`; absent path = zero regression.

## File ownership

Per Epic e-95087c8b body file-ownership rules:

- Epic A (this Epic) OWNS: `rust/atmux-cockpit-mirror/`, `docs/adr/219-*.md` (this file), `src/verbs/cockpit-mirror.ts`, `package.json::build:install` (new 3rd binary stage).
- Epic A DOES NOT TOUCH: `src/abstractions/events.ts`, `src/abstractions/sqlite-migrations.ts`, `src/core/id-sequence.ts` (sibling Epic e-6a066299's territory; ADR-202 §IX-B / §X / §XI reserved there).
- If OQ1 resolves to (a) "extend `atmux-relayd` writer-side", the writer-side INSERT lives in `rust/atmux-relayd/src/main.rs` (Epic A owns) — no Epic B file touched.

**Filed via** 2026-05-22 driver session /btw audit fold-in #3 (Epic e-95087c8b Story 2). Planner-authored per Epic e-95087c8b T-S2-7 (t-50f6b226).
