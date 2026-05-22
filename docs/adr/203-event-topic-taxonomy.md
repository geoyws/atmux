# ADR-203: Event topic taxonomy — canonical names, Zod payload schemas, cross-team propagation rules, post-commit hook

**Status**: proposed (deferred: gated on ADR-202 substrate landing first — taxonomy is meaningless without the messaging primitive)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-20 evening design session — operator: *"come up with a complete recommendation to rehaul the entire atmux to use pubsub with honker"* — taxonomy is the second of three Honker-stack ADRs queued.
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) §D4 (typed-discriminated-union decision this fleshes out), [ADR-202](202-honker-in-db-messaging-substrate.md) §D9 (post-commit hook architecture this specifies in detail), [ADR-091](091-kanban-driven-auto-merge.md) §Triggers (task-done event consumer), [ADR-134](134-in-team-auto-merger.md) §Triggers (branch-ready event consumer), [ADR-145](145-atmux-adopts-gitter.md) (gitter event-consumer mapping), [ADR-126](126-sqlite-state-store.md) §kanban schema (events table sibling), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) §D6 (`budget.warning` / `budget.recovered` topics), [ADR-200](200-install-wizard-guided-first-run-setup.md) §D9 (hook install wizard step), forthcoming ADR-204 (`_jury` consumer of `story.tested` + emitter of `story.jury_ratified` / `story.jury_verdict`).

## Context

ADR-202 commits the substrate (Honker as in-DB messaging) and the typing approach (Zod discriminated union by topic). It does not enumerate topics. Without a canonical taxonomy, each consumer EPIC invents its own topic names + payload shapes — within six months the substrate calcifies around inconsistent vocabulary (`taskDone` vs `task.done` vs `task_completed`), payload shapes diverge (some events carry `member`, others `claimedBy`), and cross-consumer integration becomes a translation layer.

The taxonomy needs to be set **before** the first consumer EPIC (jury) ships, so the conventions are tested against a real consumer pair, not a single one. It also needs to specify cross-team propagation (which events mirror from team DB → cockpit DB, per ADR-202 D3) and the post-commit hook contract (ADR-202 D9) at the implementation level.

## Decision

### D1 — Topic naming convention

Topics are **lowercase dotted segments**, hierarchical, noun-first-then-verb past-tense:

- `<scope>.<action>` — single-segment scope. Examples: `task.claimed`, `epic.dissolved`, `commit.landed`.
- `<scope>.<sub-scope>.<action>` — nested scope when ambiguous. Examples: `story.jury.ratified`, `story.jury.verdict`, `pane.classifier.completed`.

**Rules:**

- Lowercase only. Hyphens within a segment for multi-word (e.g. `merge-ready`). No camelCase, no underscores.
- Verb is past-tense (event already happened): `claimed` not `claim`, `done` not `do`. The substrate emits events for completed state transitions; pre-state announcements would be a future addition (out of scope here).
- Wildcards (`task.*`) are valid at the **subscribe** call but not as published topic names. Honker stream subscriptions can wildcard-match; publishers always emit a fully-qualified name.
- Reserved namespace prefixes: `internal.*` for substrate's own events (heartbeats, smoke probes); operator code must not emit into `internal.*`.

### D2 — Canonical topic set (v1)

The v1 topic set, organized by domain. **Each entry has a payload schema in D3.** This is the closed set for substrate landing; additions land via ADR amendment so consumers stay in sync.

#### Task lifecycle (team-scope)
- `task.claimed` — member claimed an unclaimed task
- `task.done` — member moved task to done state (cascades to gitter, jury if story-complete)
- `task.stalled` — watchdog fired with no commit/activity within configured window
- `task.unclaimed` — task was un-claimed (lane rotation, member rotation)
- `task.role-mismatched` — claim verb refused due to role mismatch (hygiene class)

#### Story lifecycle (team-scope)
- `story.created` — planner created a new story
- `story.tested` — test-gate (ADR-144) passed for the story
- `story.test-failed` — test-gate failed
- `story.jury.ratified` — planner's AC ratified by `_jury` (ADR-204 pre-work gate)
- `story.jury.pending` — story sitting in jury-pending state awaiting verdict
- `story.jury.verdict` — jury issued verdict (payload distinguishes pass/reject)
- `story.merge-ready` — story crossed into merge-ready state (gitter consumer wake)

#### Epic lifecycle (team-scope + cockpit-mirror)
- `epic.created` — epic spawned
- `epic.dissolved` — epic-team dissolved (cockpit consumer reaps cron blocks per ADR-197)
- `epic.merge-ready` — every child task done; ready for fan-in
- `epic.spawn-blocked` — `spawn-epic` refused due to pool exhaustion (ADR-199 D3) — cockpit-scope

#### Commit lifecycle (team-scope)
- `commit.landed` — post-commit hook fired (D5 hook contract)
- `commit.pushed` — push verb completed
- `commit.merge-staged` — merge committer staged a merge commit

#### Pane lifecycle (team-scope, event-triggered classifier per ADR-202)
- `pane.classifier.completed` — pane-classifier job finished; carries the classification result
- `pane.wedged` — classifier detected wedge (replaces periodic `detectAndResubmit` scan)
- `pane.refusal-detected` — refusal classifier triggered (per ADR-139)

#### Coordination + hygiene (mixed scope)
- `complaint.filed` — `atmux complaint add` verb emitted (medic consumer)
- `flag.raised` — flag verb (when ADR-200 D2 flag verb finally lands) — team-scope
- `decision.added` — driver/lead/planner added a decision row — team-scope
- `hygiene.violated` — hygiene fingerprint scanner flagged a row (medic consumer)

#### Cockpit-scope (cross-team-fanout)
- `team.idle` — team's commit cadence dropped below threshold (sentinel + medic consumer)
- `team.recovered` — team cadence recovered
- `team.stopped` — team session stopped (graceful or force)
- `sentinel.escalated` — sentinel-escalation classifier triggered E1/E2 gate (lead pane wake)
- `medic.hygiene-drained` — medic auto-fixed N hygiene wedges in this tick
- `budget.warning <account>` — Claude account crossed low-headroom threshold (per ADR-199 D6)
- `budget.recovered <account>` — Claude account crossed back above recovery threshold
- `disk.warning` — disk-space probe crossed threshold (medic consumer)

**Topic counts:** ~30 in v1, organized 5 domains × ~6 topics. Adding a domain or topic requires ADR amendment.

### D3 — Payload schema convention

Every topic has a Zod schema. Common fields across all payloads:

```ts
const BasePayloadFields = {
  topic: z.string(),         // literal per topic (discriminator)
  eventId: z.string(),       // UUIDv7 — time-ordered; subscriber idempotency key
  emittedAtSec: z.number(),  // epoch seconds; for absence-detection windowing
  schemaVersion: z.literal(1).default(1),  // for forward-compat amendments
};
```

Per-topic payload extends these. Example for `task.claimed`:

```ts
export const TaskClaimedPayload = z.object({
  ...BasePayloadFields,
  topic: z.literal("task.claimed"),
  taskId: z.string(),
  member: z.string(),
  team: z.string(),
  lane: z.enum(["FE", "BE", "DB", "OPS", "TEST", "REVIEW", "MISC"]).optional(),
  epicId: z.string().optional(),
  storyId: z.string().optional(),
}).passthrough();  // forward-compat per kanban convention
```

**Schema discipline:**

- All payloads `.passthrough()` (forward-compat with unknown fields per memory `reference_kanbantask_passthrough_extra_json`).
- Required fields are minimal: just enough to identify the entity + the action context. Optional fields carry secondary detail (lane, story-id) for consumers that want it without forcing every publisher to fetch.
- Field names follow the kanban convention (`taskId` not `task_id`; `epicId` not `epic_id`). Snake_case stays out.
- `schemaVersion: 1` is the v1 contract. Future shape changes bump the version + add backward-compat shim at the subscribe boundary (subscriber decides if it can handle old/new shape).

**The full schema set lives in `src/schema/events.ts` (new file in substrate EPIC).** Schemas are imported by publishers (via `EventPayload.parse(...)` before INSERT) and subscribers (via the discriminated union exhaustive-switch at handler-dispatch time).

### D4 — Cross-team propagation rules

ADR-202 D3 specifies separate per-team and cockpit DBs with per-team `cockpit-mirror` consumer. This ADR specifies **which topics mirror**:

| Topic | Mirrors? | Reason |
|---|---|---|
| `task.*` | No | Team-scoped; not interesting to other teams. |
| `story.*` | No | Same. |
| `epic.created` / `epic.merge-ready` | **Yes** — to parent team only | Parent gitter needs to know to fan-in. Mirror selectively to the parent team's state.db (epic-team relationship known via `epics.extra` per memory `project_epic_team_extra_schema`). |
| `epic.dissolved` | **Yes** — to cockpit | Cron-reaper (ADR-197) is cockpit-scope. |
| `epic.spawn-blocked` | **Yes** — to cockpit | Operator notification; ADR-199 D3 cockpit consumer. |
| `commit.*` | No | Team-scoped. |
| `pane.*` | No | Team-scoped. Sentinel cockpit observation eventually reads via ATTACH if needed. |
| `complaint.filed` | **Yes** — to cockpit | Medic role is cockpit-scope. |
| `flag.*` / `decision.*` | No | Team-scoped (lead reads team's own state.db). |
| `hygiene.violated` | **Yes** — to cockpit | Medic hygiene-drain is cockpit-scope. |
| `team.*` | n/a | Already cockpit-scope (emitted by cockpit-mirror consumer based on team aggregates). |
| `sentinel.*` / `medic.*` | n/a | Already cockpit-scope. |
| `budget.*` / `disk.*` | n/a | Already cockpit-scope (cockpit-level probe). |

**Mirror implementation pattern (per-team `cockpit-mirror` consumer):**

```ts
// runs once per team process, long-lived
subscribeTopic(teamDb, ["epic.dissolved", "complaint.filed", "hygiene.violated"], async (event) => {
  await insertEvent(cockpitDb, { ...event, sourceTeam: teamName });
});

subscribeTopic(teamDb, ["epic.created", "epic.merge-ready"], async (event) => {
  const parentTeam = await resolveParentTeam(event.epicId);
  if (parentTeam && parentTeam !== teamName) {
    const parentDb = openTeamDb(parentTeam);
    await insertEvent(parentDb, { ...event, sourceTeam: teamName });
  }
});
```

Mirror is **best-effort + async**: if cockpit-events.db is locked or absent, local state.db emit still fires; cockpit visibility is eventually-consistent. No two-phase commit; the local emit is the source of truth.

### D5 — Post-commit hook contract

Per ADR-202 D9, atmux ships a hook installer wiring `.git/hooks/post-commit` to invoke `.atmux/hooks/post-commit`. This ADR specifies the hook contract.

**`.atmux/hooks/post-commit` (atmux ships this template):**

```bash
#!/usr/bin/env bash
# >>> atmux:post-commit
# Emits `commit.landed` event to .atmux/state.db on every commit.
# Idempotent: emit-failure does not block git operation; logs to .atmux/logs/hook-emit.log
set -e
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --format='%s')
COMMIT_AUTHOR=$(git log -1 --format='%ae')
BRANCH=$(git rev-parse --abbrev-ref HEAD)
exec atmux internal emit-event commit.landed \
  --commitSha "$COMMIT_SHA" \
  --message "$COMMIT_MSG" \
  --author "$COMMIT_AUTHOR" \
  --branch "$BRANCH" \
  2>>.atmux/logs/hook-emit.log || true
# <<< atmux:post-commit
```

**Wiring `.git/hooks/post-commit`** (managed by atmux installer):

```bash
#!/usr/bin/env bash
# >>> atmux:post-commit
if [[ -x .atmux/hooks/post-commit ]]; then
  .atmux/hooks/post-commit "$@" || true
fi
# <<< atmux:post-commit
# (operator's own hooks below this marker are preserved)
```

Marker-fenced (same pattern as cron sandwich-markers per ADR-083 + ADR-192). Installer:

1. Reads existing `.git/hooks/post-commit` content.
2. If marker absent, **appends** the invoking block (preserves operator's pre-existing hooks).
3. If marker present, rewrites the block in-place (idempotent re-runs).
4. `.atmux/hooks/post-commit` is generated from `templates/hooks/post-commit.sh` on `atmux init` (ADR-200 Layer 2 step 5).

The `atmux internal emit-event` verb is a thin wrapper around the Zod schema + Honker `notify()`. Defers schema validation + atomicity to the substrate; the hook is line-of-sight bash.

**Hook failure mode**: `|| true` swallows any emit failure (log goes to `.atmux/logs/hook-emit.log`). The hook **never blocks the commit** — git's post-commit is purely informational by design, and a broken substrate must not break commits. Lost events are caught by the cron-backstop sweep (ADR-202 D6).

### D6 — Event ID + ordering convention

`eventId` is **UUIDv7** (time-ordered UUID per RFC 9562). Properties relied on:

- Lexicographic sort matches creation order — enables consumer-side `WHERE eventId > last_processed` queries on Honker streams.
- Embedded timestamp (millisecond precision) — supports absence-detection without a separate timestamp field.
- Universally unique — eliminates per-team / per-host coordination overhead.

`bun:sqlite` doesn't ship a built-in UUIDv7 generator; substrate EPIC adds a `src/abstractions/uuidv7.ts` helper (~30 lines). Pinned as the only ID generator in `src/abstractions/events.ts` — no per-call-site UUIDv4 / nanoid drift.

### D7 — Subscriber idempotency contract

Per ADR-202 D6: subscribers must be idempotent. This ADR specifies the **contract shape**:

Each subscriber maintains a single state-row at `subscriber_offsets` table in its host DB:

```sql
CREATE TABLE subscriber_offsets (
  consumerName TEXT PRIMARY KEY,
  lastEventId TEXT NOT NULL,
  lastProcessedAtSec INTEGER NOT NULL
);
```

Subscriber handler:

```ts
async function handle(event: EventPayload): Promise<void> {
  const lastProcessed = await getOffset(consumerName);
  if (event.eventId <= lastProcessed) return;  // already handled
  await processEvent(event);
  await setOffset(consumerName, event.eventId);
}
```

**Two scopes for `consumerName`:**

- `<team>:<consumer>` for team-scope consumers (`team-alpha:gitter`, `team-alpha:jury`).
- `cockpit:<consumer>` for cockpit-scope consumers (`cockpit:medic`, `cockpit:sentinel`).

Helper `withIdempotency(consumerName, handler)` wraps every subscriber in substrate EPIC to make the pattern frictionless. Skipping the helper is a reviewer-class flag.

### D8 — Substrate's own internal events

Substrate emits a small set of `internal.*` topics for self-monitoring (consumed by doctor probe per ADR-202 D5 / D11):

- `internal.honker.loaded` — emitted at successful extension load + smoke probe pass
- `internal.honker.fallback` — emitted when extension load fails (consumer fallback to poll mode)
- `internal.subscriber.crash` — emitted when a subscriber handler throws (doctor surfaces)
- `internal.smoke.tick` — periodic substrate-health emit (every 60s); absent ticks indicate substrate stall

Operator code MUST NOT emit into `internal.*`. Schema enforcement via Zod literal-type check at the publisher boundary.

## Consequences

**Becomes easier:**

- Consumer EPICs land against a known taxonomy — no per-EPIC topic naming churn.
- Cross-team integration testing: published topic set is closed v1; consumer fixture mocks can cover the full shape.
- Schema-level evolution: amendments are explicit + reviewed (ADR-cycle); silent drift impossible.
- Operator debugging: `atmux events tail <topic>` style verbs become tractable (closed namespace; well-defined payloads).

**Becomes harder:**

- Adding a new topic requires ADR amendment — slows ad-hoc consumer wiring. Acceptable trade-off: the discipline is the point. Substrate landing six months from now with 80 topics + 4 naming conventions is worse than 30 topics + 1 convention.
- Mirror policy (D4) is per-topic boilerplate — needs review at every consumer-EPIC scope to confirm correct mirror direction.
- UUIDv7 dependency adds a tiny utility surface (~30 lines); risk class is "bug in UUID generator." Mitigated by RFC-9562 spec + reference test vectors.

**Risks + mitigations:**

- **Risk**: Topic naming drift creeps in despite the convention (consumers emit `task.completed` thinking it's a synonym for `task.done`). **Mitigation**: discriminated union (D3) makes invalid topic names a compile-time error in TS; runtime parse fails publish at the boundary.
- **Risk**: Mirror consumer crashes; cockpit DB falls behind team DB. **Mitigation**: best-effort + async mirror (D4); local state.db emit is source of truth; sweep-style reconciler in cleanup EPIC catches divergence.
- **Risk**: `eventId` ordering assumption breaks if system clock skews. **Mitigation**: UUIDv7's millisecond-precision timestamp + 62-bit random tail; clock skew within a host is bounded; cross-host events are rare (only via mirror to cockpit which has its own clock). At-least-once + idempotency contract (D7) means moderate clock skew → duplicate processing, not lost events.
- **Risk**: Hook `|| true` masks a permanent emit failure (substrate broken silently). **Mitigation**: doctor probe reads `.atmux/logs/hook-emit.log` tail; non-empty log surfaces a yellow warning. Cron-backstop sweep + manual `atmux events backfill` verb in cleanup EPIC covers the recovery path.
- **Risk**: `schemaVersion` evolution requires every subscriber to handle every past version. **Mitigation**: at any time, the substrate may only emit one `schemaVersion` per topic — the current version. Subscribers handle one version. Migrations land in lockstep ADR + code amendment. No "v1 and v2 coexist" — the substrate is small enough to hard-cut.

## Out of scope (deferred)

- **Pre-state announcements** — verbs like `task.about-to-be-claimed` would enable optimistic-locking patterns. Out of scope; v1 is past-tense-only.
- **Topic versioning at the topic-name level** — no `task.claimed.v2`. Versioning lives in payload `schemaVersion` field per D3.
- **Cross-host event distribution** — Honker is in-DB single-host. Cross-host stays with ADR-032 (cross-cage socket pubsub) or tell-lead durable-inbox.
- **Event archival / pruning** — Honker streams have per-consumer offsets; pruning policy (TTL? max-rows?) is a separate cleanup-EPIC scope decision.
- **External webhook export** — Discord/Slack/HTTP webhook consumers are post-cleanup-EPIC.

## References

- ADR-202 — Honker substrate (decisions this fleshes out)
- ADR-091 — kanban-driven auto-merge (task-done consumer pattern)
- ADR-134 — in-team auto-merger (branch-ready consumer pattern)
- ADR-145 — atmux adopts gitter (gitter event-consumer)
- ADR-126 — SQLite state store (events table sibling to kanban tables)
- ADR-199 §D6 — Claude account pool (consumer of `budget.*`)
- ADR-200 §D9 — install wizard hook arming step
- forthcoming ADR-204 — `_jury` (consumer of `story.tested`, emitter of `story.jury.*`)
- RFC 9562 — UUIDv7 spec (D6)
- memory `reference_kanbantask_passthrough_extra_json` — `.passthrough()` precedent
- memory `project_epic_team_extra_schema` — epic-team parent relationship resolution (D4 mirror rule)
- memory `project_honker_pubsub_rehaul_design` — decisions locked in design memory; this ADR commits the taxonomy half


## §Amendment 2026-05-22 — First emit point + consumer wired in production

`task.done` and `task.claimed` topics graduate from schema-only to actually-emitted. `src/core/kanban.ts::moveTask` invokes `emit()` via a same-transaction hook (`tryEmitTaskLifecycle`) on every status flip into the relevant terminal/entry state. Payload shapes verified against the discriminated union — TS narrows correctly, runtime validation passes.

Topic-specific semantics now pinned by code:

- **`task.done`** fires on EVERY move with target status `done`. If a Task is moved from `done` back to `todo` and then again to `done`, two events fire — at-least-once on the consumer side is the contract. `doneAtSec` reflects each emit (not the original completion).
- **`task.claimed`** fires ONLY on the first transition from a non-`in-progress` status into `in-progress`. Status flips within `in-progress` (re-assignment, body edits, etc.) are no-ops. This prevents emit floods when planner-tier verbs touch the same row repeatedly.

First production consumer wired: `atmux committer --daemon` (long-lived) + `atmux committer --drain` (cron-backstop). See ADR-202 §Amendment 2026-05-22 for the consumer side.

**Filed via** 2026-05-22 driver session (`atmux-geoyws-honker-events` branch).
