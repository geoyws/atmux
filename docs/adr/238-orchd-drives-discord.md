# ADR-238: orchd is the single Discord emitter — substrate events publish, orchd subscribes-and-renders

**Status**: Proposed (operator-fired 2026-05-24 in same session as [ADR-236](236-three-tier-orchd-supervision.SUPERSEDED.md) + [ADR-237](237-no-llm-discord-and-whip-removal.md); ship under driver as the architectural-funnel piece that makes the post-cron Discord surface coherent).

**Date**: 2026-05-24

**Driver-ref**: 2026-05-24 conversation with operator. Operator's standing position in that session, verbatim:
- *"make orchd drive discord outputs"*
- *"discord messages to boringly come from the kanban itself and not from any LLM anymore because that burns tokens"* (the upstream rationale from ADR-237; this ADR is the architecture that implements it cleanly rather than as N scattered Bucket-A1 callers)
- *"revisit bucket A becuase watchdog and crons are all removed... poke is removed and etc. revisit the whole of bucket A and make it make sense"* (the prompt that surfaced this ADR's necessity — Bucket A as ADR-237 §Context originally framed it was stale because cron-source removal was already in flight)

**Cross-refs**:
- [ADR-202](202-honker-in-db-messaging-substrate.md) — Honker substrate. This ADR adds new event topics + consumer configs on top of the existing infrastructure.
- [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) — orchd's current consumer surface (`atmux:gitter` → `task.done`, `atmux:lane-router` → `task.unclaimed`). This ADR extends that consumer pattern to Discord-emission.
- [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) — cron retirement. The Bucket A2 verbs this ADR retires/migrates were cron-fired pre-ADR-233; without cron they have no auto-caller.
- [ADR-236](236-three-tier-orchd-supervision.SUPERSEDED.md) — superseded by [ADR-240](240-drop-superorchd-orchd-self-supervises.md). Originally proposed `[orchd-supervision-failure]` as a consumer of this ADR's template registry; ADR-240 dropped the superorchd binary that would have emitted it, so this template is NOT built. The template registry shape stays as-is — future external-supervision retrofits would slot into the same registry without ADR-238 changes.
- [ADR-237](237-no-llm-discord-and-whip-removal.md) — sibling policy ADR. ADR-237 says "no LLM cadence in Discord"; this ADR says "ALL Discord emission goes through orchd, regardless of LLM-vs-deterministic origin". Together they specify the full Discord surface shape.
- decision number 068 (no local ADR file exists) — bash discorder cutover history; the `[whip-progress]` / `[whip-heartbeat]` template-name byte-parity decision this ADR finishes reversing per ADR-237 §D4.

## Context

Pre-this-ADR, Discord-emission in atmux is a scattered surface — 24 callsites across `src/core/` and `src/verbs/` invoke `abstractions/discord.send` directly, each with its own template constant, dedup logic (if any), error handling, and rate-limit awareness. The shape evolved organically as features landed; there is no single registry of "what does atmux post to Discord" and no single owner of the emission lifecycle.

The cron-source removal in flight (working-tree at the time of this ADR shows `src/core/cron.ts` + `src/abstractions/crontab.ts` + `src/verbs/cron-install.ts` + `src/verbs/cron-orphans.ts` + `src/verbs/cron-remove.ts` deleted, plus their tests) eliminates the auto-call path for several Bucket A2 Discord-emitters (discorder, watchdog, poke, pulse, report, improve). Those verbs become dispatchable-from-CLI but uncalled-by-anything — dead code in practical terms. ADR-237 §Context calls this out but doesn't specify the *replacement* for the diagnostic/status surface those verbs incidentally provided (commit digests, alive-member counts, blocker reports, watchdog signals).

The replacement shape, per the operator directive *"make orchd drive discord outputs"*, is to treat Discord-emission as a substrate-event consumer pattern, identical to how orchd already handles `task.done` and `task.unclaimed`:

- Things that happen in the substrate (a task completes, a member account swaps, a refusal is detected, an epic merges, the cockpit rotates, supervision escalates) publish an event to Honker.
- orchd subscribes to those topics and decides what (if anything) to emit to Discord based on a consumer config (topic + template + filter + dedup key).
- Discord-template rendering is in Rust, fed by the event payload. No LLM in the path. No scattered call-sites.
- The scattered Bucket A1 callers refactor to emit-to-Honker-topic instead of calling `discord.send` directly. The scattered Bucket A2 callers either delete (no replacement needed) or get a Honker consumer registered (with the verb deleted afterward).

This collapses the Discord surface to one process (orchd), one binary (`rust/atmux-orchd`), one template registry (Rust constants), one dedup table (a new `discord_dedup` table). It also makes "what does atmux post to Discord" a single grep — read the consumer config in orchd's source.

## Decision

### D1 — orchd grows a `discord` consumer family alongside `gitter` and `lane-router`

The `CONSUMERS` slice at `rust/atmux-orchd/src/main.rs:82` extends from 2 to N entries. Each new entry represents a topic→Discord-template mapping:

```rust
// Sketch; final shape lands in implementation.
struct ConsumerCfg {
    name: &'static str,
    topic: &'static str,
    handler: ConsumerHandler,
}

enum ConsumerHandler {
    /// Existing: dispatch to a Bun subprocess via `atmux orchd --handle-one`.
    BunDispatch { bun_topic: &'static str },
    /// New: render a Discord template from event payload, send via http
    /// to webhook, record in dedup table.
    DiscordEmit {
        template: DiscordTemplate,
        dedup_strategy: DedupStrategy,
    },
    /// New: do both — dispatch to Bun AND emit Discord (e.g. a task.done
    /// that needs both gitter-merge and a Discord notification).
    BunDispatchAndDiscord {
        bun_topic: &'static str,
        template: DiscordTemplate,
        dedup_strategy: DedupStrategy,
    },
}
```

Per-topic Discord templates land in `rust/atmux-orchd/src/discord_templates.rs` (new file). Each template is:

- A constant header string (`[heartbeat]`, `[progress]`, `[refusal-detected]`, `[account-swap-completed]`, `[epic-merged]`, `[cockpit-rotated]`, etc.). (`[orchd-supervision-failure]` from the original ADR-236 §D3 sketch is NOT built — ADR-240 dropped superorchd; no caller emits the template.)
- A `fn render(payload: &JsonValue, ctx: &TeamContext) -> String` body builder. Pure function, no I/O, deterministic output for identical inputs (essential for dedup correctness).

The template-render function signature is shared across all templates so the dispatcher loop is uniform.

### D2 — New Honker topic family: substrate-event publishers move to topic emission

The Bucket A1 callers (substrate-event-driven Discord emitters) refactor from `await discord.send(...)` to `await honker.notify(topic, payload)`. The publish-side is async-fire-and-forget; the orchd consumer side handles the Discord roundtrip.

Topic naming convention (consistent with existing `task.done` / `task.unclaimed`):
- `refusal.detected` — payload includes member id, refusal-class, pane-capture excerpt.
- `account.swap.done` — payload includes from-account, to-account, member, success/fail.
- `account.swap.failed` — payload includes failure reason.
- `cursor.self_heal.fired` — payload includes target, action, outcome.
- `epic.merged` — payload includes epic id, merge sha, story count.
- `cockpit.rotated` — payload includes prior session, new session, reason.
- `orchd.supervision.failed` — payload per ADR-236 §D3 (escalation shape).
- `heartbeat.tick` — emitted by orchd itself on a configurable cadence (default off; operator opt-in via cockpit.json) for periodic alive-signal. **Not LLM. Not cron. Just orchd's own internal timer publishing to its own topic.** Provides the "is atmux alive?" signal that pulse/watchdog used to provide, without a separate verb or cron line.

The topic-namespace convention is `<domain>.<event>` (dot-separated, lowercase, past-tense verb). Topics are append-only — adding a new one is free; renaming requires a deprecation cycle.

### D3 — `discord_dedup` table schema

New SQLite table managed by orchd, schema-migration lands in `src/abstractions/sqlite-migrations.ts` as a new monotonic version bump (find current MAX, bump by 1):

```sql
CREATE TABLE discord_dedup (
  template TEXT NOT NULL,         -- e.g. "[refusal-detected]"
  dedup_key TEXT NOT NULL,        -- per-template + per-payload string
  first_sent_at_sec INTEGER NOT NULL,
  last_sent_at_sec INTEGER NOT NULL,
  send_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (template, dedup_key)
);
CREATE INDEX discord_dedup_last_sent ON discord_dedup(last_sent_at_sec);
```

Dedup strategies (per-template, chosen in `DiscordTemplate::dedup_strategy()`):

- `Always` — never dedup; send every time. For templates where each event is independently meaningful (epic-merged, cockpit-rotated).
- `EpochBucket { seconds: u64 }` — dedup within a time bucket. `(template, dedup_key, floor(now/seconds))` is unique. Useful for any deterministic alert that fires from a recurring scan (e.g. refusal-detected within a 5-min bucket) so a wedged condition doesn't ping every scan. (Original ADR-236 §D3 superorchd-escalation use of this strategy is moot — ADR-240 dropped superorchd; no caller exists today.)
- `OncePerPayload` — dedup forever on the exact payload-derived key. Used for events that should fire at most once for a given trigger (e.g. account-swap-success for a specific swap operation).

The dedup check happens in Rust before the HTTP send; on dedup-hit, increment `send_count` + update `last_sent_at_sec` + skip the HTTP send. On dedup-miss, perform the HTTP send and insert the row.

### D4 — Bucket A2 verbs: delete or migrate

For each Bucket A2 verb (was cron-fired, now uncalled post-cron-source removal), one of two paths:

| Verb | Replacement | Rationale |
|---|---|---|
| `atmux discorder progress` | orchd consumer on `task.done` + `epic.merged` topics → `[progress]` template emitted per batch (e.g. when ≥3 events accumulate OR 30 min elapsed since last emit, whichever first) | Operator-visible "what shipped" digest moves from cron-polled to event-batched. No cron, no LLM. |
| `atmux discorder heartbeat` | orchd self-emit on `heartbeat.tick` cadence (default off; opt-in per team) | Operator-visible "team is alive" signal moves from cron-fired to orchd's own optional internal timer. |
| `atmux watchdog` | DELETE | Whip-loop-detection was the use case; whip is gone (ADR-237 §D1). No event class needs separate watchdog after refusal-trigger + account-swap-failed cover the operator-visible failure modes. (Orchd-death falls outside the Discord-auto-ping path per ADR-240; operator notices via dead pane on cockpit-attach.) |
| `atmux poke` (renamed from `whip`) | DELETE | Whip is gone. `poke` was the bash-side per-cycle worker; replaced by /goal + orchd subscribers. |
| `atmux poke-resume-check` | DELETE | Same as poke. |
| `atmux pulse` | DELETE | Cockpit-pulse role replaced by orchd's `heartbeat.tick` self-emit (D2 above). (Original justification also cited superorchd's supervision-failure escalation per ADR-236 §D3; ADR-240 dropped superorchd, so heartbeat-self-emit is now the sole replacement signal — orchd-death is operator-visible via the dead `__orchd__` pane on cockpit-attach.) |
| `atmux report` | KEEP, manual only | Operator-fired one-shot report verb stays useful. Cron-fired path was the only auto-caller; now it's CLI-invokable when the operator wants a report. No Discord side effect by default. |
| `atmux improve` | KEEP, manual only | Same as report. |

The deletion list (`watchdog`, `poke`, `poke-resume-check`, `pulse`, `discorder`) covers:
- `src/verbs/{verb}.ts` + `src/core/{verb}-*.ts` helpers (deleted).
- CLI dispatch case in `src/cli.ts` (deleted).
- Schema fields referencing these verbs in `src/schema/{team,cockpit}.ts` (back-compat-shimmed for one release per ADR-237 §D5 deprecation pattern, then deleted).
- Tests under `tests/unit/{verbs,core}/{verb}-*.test.ts` and `tests/e2e/{verb}-*.test.ts` (deleted).

The kept list (`report`, `improve`) is preserved as operator-fired one-shots; their bodies are reviewed during implementation to strip any cron-caller assumptions but the manual-invoke path stays.

### D5 — Bucket A1 callers refactor: emit-to-topic instead of direct-send

For each Bucket A1 caller:

| File | Pre-change | Post-change |
|---|---|---|
| `src/core/refusal-trigger.ts` | `await discord.send(...)` on detection | `await honker.notify("refusal.detected", payload)` |
| `src/core/account-swap.ts` | `await deps.discordSend(...)` on success/fail | `await honker.notify("account.swap.done", payload)` or `"account.swap.failed"` per branch |
| `src/core/cursor-self-heal.ts` | direct send | `await honker.notify("cursor.self_heal.fired", payload)` |
| `src/verbs/epic-merge.ts` | direct send on merge completion | `await honker.notify("epic.merged", payload)` |
| `src/verbs/cockpit-rotate.ts` | direct send on rotation | `await honker.notify("cockpit.rotated", payload)` |

The `abstractions/discord.send` function stays as a low-level primitive — orchd calls it. Direct callers go away. The `DiscordSendOpts` type stays exported (for orchd's Rust→TS template-render bridge if needed; final implementation may render entirely in Rust and bypass the TS layer).

A test for the Bucket A1 migration: `rg "discord\.send\(|discordSend\(" src/ --type=ts` should return zero hits outside `src/abstractions/discord.ts` itself (the primitive) and `rust/atmux-orchd/` (the canonical caller). Reviewer-enforced; CI may codify later.

### D6 — Template-header rename completes (post-ADR-237 §D4)

ADR-237 §D4 specified renaming `[whip-progress]` → `[progress]` and `[whip-heartbeat]` → `[heartbeat]` in `src/core/discorder.ts`. With ADR-238 D4 deleting `src/verbs/discorder.ts`, the rename moves: the `[progress]` and `[heartbeat]` templates land in `rust/atmux-orchd/src/discord_templates.rs` as the new canonical home. ADR-237 §D4's dual-emit env-flag (`DISCORD_TEMPLATE_DUAL_EMIT`) carries forward into Rust — set via env, orchd emits both `[whip-progress]` and `[progress]` for one release window, then drops the dual-emit shim.

## Consequences

- **Single Discord emitter** — `rust/atmux-orchd` is the only process that calls `discord.send` (or equivalent HTTP webhook POST). Reviewer-enforceable via grep. "Where does this Discord message come from?" has one answer.
- **Single template registry** — all Discord templates live in `rust/atmux-orchd/src/discord_templates.rs`. Adding a template = adding an entry; renaming or removing = grep-and-edit one file.
- **Single dedup table** — `discord_dedup` in each team's `state.db`. No per-caller dedup state files, no `pulse-state.json`/`superdoctor_attempts`/etc. dedup-key proliferation. Pre-existing per-domain tables (`superdoctor_attempts` for ADR-236 §D3 records) stay for their non-dedup audit-log purposes; dedup-specifically moves to `discord_dedup`.
- **Substrate-event topology stabilizes** — adding a new Discord-emit class becomes "emit to a topic + add an orchd consumer entry + write a template render function". No scattered new files; no new module-level singleton; no new CLI verb.
- **Bucket A2 verb deletion drops ~10 source files + ~8 test files.** `watchdog`, `poke`, `poke-resume-check`, `pulse`, `discorder` and their helpers. `report` + `improve` stay as manual-fire one-shots. Net source delta: roughly -2000 LoC across src/ + tests/.
- **Bucket A1 refactor is mechanical** — 5 callers, each a few lines of edit. No behavior change visible to Discord watchers (templates render identically); the path from "event happens" to "message in Discord" gains one hop (publish → orchd → render → send) but the hop latency is ~1ms (Honker p50 wake) + orchd consumer execution. Acceptable.
- **Discord webhook URL surface stabilizes** — pre-this-ADR, each caller could (in principle) target a different webhook; post-this-ADR, orchd owns the webhook URL resolution (from env or cockpit config). Simpler, auditable, single rotation point.
- **`heartbeat.tick` opt-in** is the operator-controlled liveness signal. Default off (no Discord traffic when team is idle). When on (per-team cockpit.json), orchd publishes to its own topic at the configured cadence; the `[heartbeat]` template consumer formats current alive-member count + in-flight task count from kanban.json and posts. This is event-driven publishing using orchd's own scheduler (internal Rust timer, not cron), so it stays within the "no cron" envelope.

## Open questions

1. **Per-team vs cockpit-wide webhook URLs.** Today most callers read `ATMUX_DISCORD_WEBHOOK` env (single global URL). Some setups may want per-team webhooks for routing to per-team Discord channels. Recommend: env stays the default; cockpit.json per-team `discord.webhook` override is honored when present.
2. **Honker topic retention** for the new high-volume topics. Heartbeat ticks at e.g. 5-min cadence accumulate fast. ADR-202's `prune_notifications_keep_latest` helper should be wired into orchd's startup so new topics don't grow unbounded. Cadence for prune tick: every 1000 events or every 10 min, whichever first.
3. **Discord template versioning.** Future template changes (new fields, reordering) could break downstream Discord-grep tooling. Recommend: bump a `schema_version` in the template-render output (footer line like `<!-- v2 -->`) so operator-side scripts can match. Out of scope for D1 implementation; pick up when first template churn arrives.
4. **Bun→Rust template-render boundary.** D1's sketch shows Rust rendering. If a Bun handler needs to emit Discord too (e.g. lane-router's `--handle-one` after a successful claim), should it (a) post to Discord directly bypassing orchd's funnel, (b) publish to a topic that orchd renders+sends, or (c) call back into orchd via local HTTP/IPC? Recommend (b) — preserves single-emitter rule. Bun handlers gain `await honker.notify("...", ...)` access (already have it via the existing `honker` Bun binding).
5. **Migration sequencing.** D4 verb deletions + D5 caller refactors + D2 topic introduction + D1 orchd consumer wiring all need to land in coordinated order to avoid a window where a Bucket A1 caller has been refactored to emit-to-topic but orchd doesn't yet subscribe. Recommend implementation epic break-down: T1 schema migration (D3 table), T2 Rust template registry + dispatcher loop (D1), T3 Bucket A1 caller refactor (D5) + per-caller orchd consumer wiring, T4 Bucket A2 verb deletions (D4), T5 documentation pass.

## Reversal

If orchd-as-single-emitter proves load-bearing-wrong (e.g., orchd outage takes Discord with it and operator-visible incidents go silent):

- **Reverting D1** — orchd's consumer config drops the Discord-emit entries; templates stay in source but unused. Cost: Discord stops working until callers are re-pointed at `abstractions/discord.send` directly.
- **Reverting D5** — Bucket A1 callers go back to direct `discord.send` calls. Mechanical via git revert of the migration commits. Cost: scattered surface returns; single-grep guarantee gone.
- **Reverting D4** — Bucket A2 verb deletions are restorable from git history. Restoring the `cron-install` verb requires reversing the in-flight cron-source removal too; not feasible without ADR-233 reversal first. **D4's deletions assume ADR-233 is settled.**
- **Reverting D6** — template-header rename revert is two-constant change. Dual-emit shim provides a safe migration window.

Partial revert is supported (e.g., keep D1+D5 but restore one Bucket A2 verb). Full revert is restoring the scattered surface — costly but doable. The ADR's intent is to make the funnel feel obvious enough that revert is unattractive.
