# ADR-292: `atmux msg` — mailbox record + wake over `inbox_messages`

**Status**: proposed
**Date**: 2026-09-23
**Driver-ref**: epic e-05309933, settled E1 decisions 1–6 (transcribed, not re-decided); E1-T1 finding t-50652206 option (b)
**Supersedes**: ADR-154 §D2 (schema shape) — option (b) departs from the unified `coordination_messages` table exactly as a markdown store would have: `msg` rows extend the existing `inbox_messages` table instead of landing in a unified table
**Relates**: [ADR-154](154-driver-inbox-lead-outbox-sqlite-migration.md) (§D2 superseded; rest stands), [ADR-126](126-sqlite-state-store.md) (D5 idempotent-open migration), [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) (§D2 no-send-keys invariant), [ADR-092](092-cross-team-tell-lead.md) (team.json `findLead` roster path precedent — `src/verbs/tell-lead.ts:187-191`, not the cockpit-walk resolution at `:145-184`)

## Context

Epic e-05309933 settled six decisions for a new `atmux msg` verb family: a durable mailbox record plus a wake pointer (`msg send` / `msg check` / `msg read`). The E1-T1 slice (t-50652206) audited the existing readers and writers of the `inbox_messages` table and returned option (b): extend `inbox_messages` with `kind='msg'` rows carrying priority in `extra`, rather than building a new table or a markdown `.atmux/mail` store.

The audited call sites, verified in-tree before citing:

- Writers: `src/core/inbox.ts:273` (`INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra)` — `kind` and `extra` columns already exist) and `src/verbs/send.ts:518-524` (medic-inbox path writes `kind`, defaulting to `"heads-up"`).
- Readers: `src/core/inbox.ts:335` (`SELECT ... kind, extra FROM inbox_messages ...` — `kind` is surfaced on the read shape) and `src/core/groom-archive.ts:156` (archive move selects `kind, extra` explicitly, so a new `kind` value survives archival without code changes).
- Table shape: `src/abstractions/sqlite-migrations.ts:90-99` — `inbox_messages(id, member, msg_id, sender, body, ts, kind, extra)`; there are **no** `status` / `acked_at` columns.
- Cursor precedent: `src/verbs/driver-inbox.ts:25` (`--since` / `--all` / `--ack` / `--json`, `cursorBefore` / `cursorAfter` at `:137-138`) over the on-disk cursor at `src/core/driver-inbox.ts:36-40`.
- Roster precedent: `src/verbs/tell-lead.ts:148-191` (unknown team / unknown lead → `ConfigError`).
- Send-keys guard: `src/abstractions/tmux.ts:106-145` (`DriverSendKeysViolation`, per ADR-239 §D2).
- Harness concepts such as `SendMessage` / `ListAgents` appear nowhere in `src/` (verified by grep; `src/verbs/tell-lead.ts:8-9` describes its own routing as "file-based, not SendMessage"). This ADR therefore words the wake decision using only in-tree concepts.

## Decision

### D1 — SQLite store in `.atmux/state.db`; markdown `.atmux/mail` ruled out

`msg` records are rows in the existing `inbox_messages` table, per E1-T1 option (b): writers set `kind='msg'` and carry priority in `extra.priority`. No new table, no new columns, no `.atmux/mail` markdown store. `driver-inbox.md` / `lead-outbox.md` stay legacy markdown (ADR-154's migration scope is unchanged by this ADR beyond the §D2 supersession).

### D2 — Priority `p0..p3` with `check --min`

`msg send` accepts a priority in `{p0, p1, p2, p3}`, persisted at `extra.priority`. `msg check` accepts `--min <p>` and surfaces only rows at or above that priority. Default priority and default `--min` are **open** (see OQ1).

### D3 — Cursor + ack reusing the driver-inbox pattern

`msg check` / `msg read` reuse the `atmux driver-inbox` read contract verbatim: `--since` / `--all` / `--ack` / `--json` flags and `cursorBefore` / `cursorAfter` in JSON output. Per-reader cursors live in `state_kv` (one row per reader, per the ADR-126 D1 `state_kv(feature, key, value)` shape) — this traces to epic e-05309933 decision 3, which explicitly says per-reader cursor in `state_kv`, and is a deliberate departure from the driver-inbox on-disk cursor-file precedent (`src/core/driver-inbox.ts:36-40`). `--ack` advances the caller's cursor; ack sets `status=acked` / `acked_at` per the ADR-154 D4 state machine semantics (the triage vocabulary, not its table).

Implementation note (not a new decision): `inbox_messages` has no `status` / `acked_at` columns (`src/abstractions/sqlite-migrations.ts:90-99`), so under option (b) per-reader ack state rides inside the `extra` JSON blob — e.g. an `extra.acked_by` per-reader map of reader → ack epoch — with zero schema change. If a future consumer count crosses the ADR-154 D6 hoist threshold (~3 consumers), promoting ack state to typed columns is a follow-up ADR, not this one.

### D4 — `check` exit codes; no driver-inbox retrofit

`msg check` exits `0` when nothing unread matches, `1` when unread exists, `2` is reserved. `atmux driver-inbox` is explicitly **not** retrofitted with these codes — its contract is unchanged.

### D5 — Wake prints a pointer; never touches pane input

`msg` wake prints the peer's address plus a pointer to the record. It never drives pane input: no `send-keys`, no paste-buffer write. Actual delivery to a live pane stays with the caller, via the operator-sanctioned `/pane-agent send --queued` path (operator sanction 2026-09-08). A unit test asserts `src/verbs/msg.ts` imports nothing that sends — i.e. no import of the tmux send-keys path guarded by `src/abstractions/tmux.ts:106-145`.

Guard status: the in-tree `DriverSendKeysViolation` guard's future (kept, narrowed, or lifted per the 2026-09-08 revocation) is pending E1-T0 (kb atmux t-d90f05c6, still todo). This ADR records that revocation and keeps `msg` correct under every outcome: `msg` never calls the guarded path, so whether the guard stays, narrows, or lifts, `msg`'s no-send posture (ADR-239 §D2, current invariant) is preserved by construction rather than by guard.

### D6 — Roster addressing like tell-lead; `ConfigError` on unknown peer

`msg send` addresses peers through the team.json `findLead` roster path, as `tell-lead` does (`src/verbs/tell-lead.ts:187-191` — the team.json lookup, not the cockpit-walk cross-team resolution at `:145-184`). An unknown peer name fails with `ConfigError`, never with silent delivery elsewhere.

### D7 — Migration is idempotent on open

`kind='msg'` rows need no backfill — the `kind` column already exists and readers tolerate unknown values. Opening the database runs pending migrations per ADR-126 D5; no `msg`-specific migration step ships.

### CLI shape (from the epic)

| Verb | Purpose |
|---|---|
| `atmux msg send <peer> [--priority p0..p3] <body...>` | Append a `kind='msg'` row addressed by roster name |
| `atmux msg check [--min <p>] [--since <epoch>] [--all] [--ack] [--json]` | Cursor read over unread `msg` rows; exit 0/1/2 per D4 |
| `atmux msg read [--all] [--json]` | Full-body read of `msg` rows |

## Consequences

- One table serves medic heads-up rows and `msg` rows, discriminated by `kind` — the same discriminator the groom-archive path already preserves.
- Per-reader ack state in `extra` JSON keeps the schema frozen but puts structured per-reader data inside an opaque blob; queries like "who acked row N" require `json_extract`, not a column read. Acceptable at one consumer; the D6 hoist rule bounds the debt.
- `msg check`'s exit-code contract makes it cron- and script-friendly without touching `driver-inbox`'s contract.
- The wake decision keeps `msg` correct regardless of the E1-T0 guard outcome, because avoidance is structural (no import) rather than enforced (guard throw).

## Rejected alternatives

- **Markdown `.atmux/mail` store** — ruled out in E1 decision 1; re-fragments the canonical store against ADR-126.
- **New dedicated table** — rejected by E1-T1 option (b); `kind` + `extra` already cover the shape with zero migration.
- **Unified `coordination_messages` table (ADR-154 §D2)** — superseded for this surface; option (b) extends `inbox_messages`, departing from the unified table exactly as a markdown store would have.
- **Wake via direct pane input** — rejected in E1 decision 5; delivery stays caller-side through the sanctioned queued-send path.
- **Retrofitting `driver-inbox` with check exit codes** — rejected in E1 decision 4; contract churn on a stable verb for no consumer gain.

## Open questions

- **OQ1** — default send priority and default `check --min` threshold. Lean (not decided): default send `p2`, default `--min p0` (show everything unless filtered). Decided-by: owner at implementation.
- **OQ2** — `extra.acked_by` exact key shape (reader-name vocabulary, epoch vs ISO). Lean: reader name → epoch seconds, matching `ts` conventions. Decided-by: implementation, within this ADR's implementation note.
- **OQ3** — E1-T0 guard outcome (kb atmux t-d90f05c6, still todo): whether `DriverSendKeysViolation` is kept, narrowed, or lifted. `msg` is correct under all three; this ADR does not prejudge it.

## Acceptance

- [ ] ADR-292 Status: `proposed`; owner promotes (no code lands on proposed).
- [ ] Every normative statement above traces to epic e-05309933 decisions 1–6, the E1-T1 finding (t-50652206, option b), or a verified `file:line` cited inline.
- [ ] No `SendMessage` / `ListAgents` wording; no invented schema columns (`status` / `acked_at` appear only as ADR-154 D4 vocabulary and inside the `extra` implementation note).
- [ ] `src/verbs/msg.ts` (when implemented) imports nothing that sends — unit-tested per D5.
- [ ] ADR-154 carries a dated amendment noting the §D2 supersession; INDEX carries the 292 row.
