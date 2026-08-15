# ADR-154: Driver-inbox + lead-outbox SQLite migration — markdown → canonical SQLite tables with rendered markdown view

**Status**: accepted
**Date**: 2026-05-15
**Author**: atmux team (driver-claude-sopx complaint c-96e5a8f2, 2026-05-15 /bruh sweep 00:17 MYT)
**Relates**: [ADR-126](126-sqlite-state-store.md) (kanban SQLite canonical store), [ADR-076](./076-inboxes-sqlite-migration.md) (member inboxes → SQLite tasks-table; ELIMINATED `.atmux/inboxes/<m>.json`), [ADR-152] (blockers list — consumes these tables), [ADR-153] (auto-promotion inbox→flag at 12h — needs DB-indexable timestamps), [ADR-155] (pane-state verb — sibling drafting), [ADR-151] (unblocker role — consumer).
**Kanban**: closes EPIC `t-2298cbb0`; T1-of-N decomposition (this commit drafts only). Closes complaint `c-96e5a8f2`.

## Context

### The two coordination surfaces atmux still keeps in markdown

Two structured messaging surfaces remain markdown-canonical post-ADR-126 / ADR-076:

- **`.atmux/driver-inbox.md`** — lead → driver. Written by `atmux tell-lead` (driver hand) and by lead's whip pipeline when surfacing decisions / blockers. Read by driver between turns to triage.
- **`.atmux/lead-outbox.md`** — member → driver. Written by `atmux reply` from every team member. Read by driver via `atmux outbox [--ack]`.

Both files carry **inline triage glyphs** the driver and lead post on read:

```
- ✅ acked
- 📤 routed to <member>
- ⏳ waiting on <input>
- ❌ wontfix / refused
```

…and a per-entry timestamp header, a free-form body, occasional `--task <id>` task pointers, and ad-hoc `## Archive` sections appended by hand when entries age out.

### Why markdown started as the right shape

Pre-ADR-076 the entire kanban + inbox surface lived in JSON files; markdown was the human-legibility add-on for the two surfaces the *operator* reads, not the bot. The flock-guarded read-modify-write pattern (`.lock` sidecar files) handled the small write volume. Triage glyphs gave a low-friction way to post triage state inline without a schema.

That tradeoff is no longer optimal. Adjacent surfaces (`kanban` per ADR-126, member inboxes per ADR-076, complaints) are SQLite-canonical and the markdown surfaces have started to **drift** in ways the structured paths don't:

- **No structured aging.** ADR-153 (auto-promotion inbox→flag at 12h) and the planned ADR-152 blockers list both want queries like *"any outbox entry older than 6h that's still pending?"*. With markdown, every consumer re-parses the file, re-walks date headers, and re-extracts glyphs — three independent parsers diverging silently.
- **Triage glyphs as inline text are unqueryable.** A `triage=📤` row is grepable; an `age(triage=📤) > 6h` is not without parsing.
- **Lock contention is a constant low-grade pain.** `.md.lock` flock dances guard every `atmux tell-lead` / `atmux reply` write; concurrent writes from cron-fired whip + member ack ticks routinely collide and serialize.
- **Prepend-newest is enforced by convention, not by the format.** Operators occasionally append-bottom by mistake; the file's read order then lies to the driver.
- **Cross-surface consistency is a chore.** Auto-promotion to flag (ADR-153) requires reading inbox → walking glyph rows → writing flag DB; a SQL view could express that in one query.

### Why now

Three near-term consumers all want the structured path:

- **ADR-152 blockers list** — a top-level `atmux blockers` rollup the driver reads to see pending unblock asks. The MD parser would have to be re-implemented; a SQL view is one query.
- **ADR-153 auto-promotion** — outbox entry aged ≥12h with no `archived_at` → promote to flag. Needs `WHERE opened_at < now() - 12h AND archived_at IS NULL`, not a date-header scan.
- **ADR-151 unblocker** — its tick reads outbox + inbox to classify blocked workers. Today the parser layer is bespoke per-consumer; a SQL view shares the access path.

If we do the schema for ADR-152 / ADR-153 / ADR-151 each separately, we end up with three near-identical parsers wedged underneath three slightly-different SQL shapes. The right move is to do the cut once.

## Decision

### (D1) Canonical store flips to SQLite under `.atmux/state.db`

Both surfaces become **rows in `state.db`**. Markdown becomes a *render* of those rows via verb, not the source of truth. The flip is **single-cutover**, not gradual: new writes go to SQLite only; legacy `.md` files are retained as **read-only archive** for ≥1 minor release post-cut (deprecation window per §D7).

Per `[[project_kanban_storage_sqlite]]` memory + ADR-126 + ADR-076 precedent — the codebase already treats `state.db` as the canonical multi-surface store. Adding two more tables matches the established pattern; introducing a second canonical-write path (markdown still authoritative for some subset) would re-fragment the storage layer.

### (D2) Schema shape — UNIFIED `coordination_messages` table with `direction` column

A single table covers both directions, discriminated by the `direction` column. Operator + lead recommendation per the EPIC task body's planner-anchors (#1) — favored over per-direction tables (`driver_inbox` + `lead_outbox`) because:

- Triage semantics are identical across directions (same glyph set, same aging rules) → duplicate-schema friction.
- ADR-152 blockers list wants both directions in one rollup; per-direction tables would force a UNION ALL on every query.
- Future cross-direction features (member → driver THEN driver → lead handoff threading) compose naturally as `parent_id` joins on a single table.

The per-direction shape is documented in §Tradeoffs as the rejected alternative. Schema:

```sql
CREATE TABLE coordination_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at       INTEGER NOT NULL,                -- epoch seconds; insert-time
  direction       TEXT    NOT NULL,                -- 'lead-to-driver' | 'member-to-driver'
  from_role       TEXT    NOT NULL,                -- 'lead' | 'member' | 'planner' | etc.
  from_member     TEXT,                            -- nullable; specific member name when from_role='member'
  to_role         TEXT    NOT NULL,                -- 'driver' (today; cross-team later per ADR-150)
  body            TEXT    NOT NULL,                -- free-form prose, markdown-formatted
  status          TEXT    NOT NULL DEFAULT 'pending', -- per (D4) state machine
  acked_at        INTEGER,                         -- epoch seconds; populated on status='acked' transition
  archived_at     INTEGER,                         -- epoch seconds; populated on status='archived' transition
  triaged_by      TEXT,                            -- 'driver' | 'lead' | 'ombudsman'; NULL on pending
  related_task_id TEXT,                            -- 't-xxxxxxxx'; nullable
  parent_id       INTEGER REFERENCES coordination_messages(id),  -- thread chain; nullable
  extra           TEXT                             -- JSON forward-compat blob; see (D6)
);

CREATE INDEX idx_coord_msgs_direction_opened     ON coordination_messages(direction, opened_at DESC);
CREATE INDEX idx_coord_msgs_status               ON coordination_messages(status);
CREATE INDEX idx_coord_msgs_related_task_id      ON coordination_messages(related_task_id);
```

- `direction` IS the discriminator. Migration to per-direction tables (if ever) is a SQL pivot, not a schema rewrite.
- `from_member` is intentionally nullable: lead-to-driver rows leave it null (the `from_role` already encodes "lead"); member-to-driver rows carry the specific member name.
- `parent_id` enables future threading without touching the row schema (a `tell-lead` followed by a `reply` referencing the same ask becomes a 2-row chain).

### (D3) Markdown is RENDER-ONLY (view-on-read), never auto-synced

`atmux driver-inbox show [--json|--md|--triage <status>]` reads SQLite and renders. There is **no** background sync of `state.db` ↔ `driver-inbox.md`. The markdown file the operator opens in `nvim` is generated on-demand by the verb, not maintained as a parallel write.

Operator + lead recommendation per the EPIC task body's planner-anchors (#2). Auto-sync would reintroduce drift: the file would race the DB, and the question "which is canonical?" would have a non-obvious answer. View-on-read keeps the canonical answer clear (SQLite) and the convenience layer cheap (a verb).

For users who want a live tail, **`atmux driver-inbox watch`** opens a stdout tail of newly-committed rows (similar to `tail -F` on the markdown). The tail emits committed rows only — no streaming-uncommitted guarantee (per §D5 / EPIC planner-anchor #4).

### (D4) Triage column is a structured STATUS enum, not raw glyphs

The inline triage glyphs (✅ acked / 📤 routed / ⏳ waiting / ❌ wontfix) become a structured `status` enum + accompanying `acked_at` / `archived_at` / `triaged_by` columns. Operator + lead recommendation per the EPIC task body's planner-anchors (#4).

Status state machine:

```
                ┌───────────┐
                │  pending  │  ← INSERT default
                └─────┬─────┘
                      │ triage action
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
  ┌─────────┐   ┌──────────┐   ┌──────────┐
  │  acked  │   │ routed   │   │ waiting  │
  └────┬────┘   └────┬─────┘   └────┬─────┘
       │             │              │
       └─────────────┼──────────────┘
                     ▼
                ┌──────────┐
                │ archived │  ← terminal; archived_at populated
                └──────────┘
```

- `pending` — INSERT default. No triage has fired.
- `acked` / `routed` / `waiting` — triage transitions; mutually exclusive but reversible (e.g. `waiting` → `routed` after the missing input arrives). Each transition populates `acked_at` (one-shot first-triage timestamp; subsequent re-triages reuse it).
- `archived` — terminal. Replaces the `## Archive` markdown convention. `archived_at` populated; the row is excluded from default `atmux driver-inbox show` output unless `--all` is passed.

Markdown render translates back to glyphs for operator legibility:

| `status`   | rendered glyph |
|------------|----------------|
| `pending`  | (none)         |
| `acked`    | ✅              |
| `routed`   | 📤              |
| `waiting`  | ⏳              |
| `archived` | (filtered out by default; `❌` if explicit-show) |

Wontfix glyph (`❌`) is rendered for any `archived` row whose `extra.wontfix_reason` is set — operator authors that via `atmux driver-inbox triage <id> --status archived --reason wontfix:<text>`. Keeps the legacy semantic without bloating the status enum.

### (D5) Verb surface

Mirrors the kanban / complaints CLI shape:

| Verb | Purpose |
|---|---|
| `atmux driver-inbox add ...` | Programmatic INSERT (lead writes; equivalent to today's `atmux tell-lead`) |
| `atmux driver-inbox show [--json\|--md\|--status <s>\|--all]` | Render from SQLite (default: pending + acked + routed + waiting; `--all` includes archived) |
| `atmux driver-inbox watch` | tail-mode stdout of newly-committed rows |
| `atmux driver-inbox triage <id> --status <s> [--related-task <t-id>] [--note <text>]` | Transition + populate `triaged_by` / `acked_at` |
| `atmux driver-inbox archive <id> [--reason <text>]` | Terminal transition; populates `archived_at` |
| `atmux lead-outbox <subcmd>` | Same shape, scoped to `direction='member-to-driver'`. Wraps existing `atmux outbox` reader semantics. |

Backwards-compat: today's `atmux tell-lead "<msg>"` and `atmux reply "<msg>"` keep working — they internally become `atmux driver-inbox add ...` / `atmux lead-outbox add ...` after migration. Operators don't relearn the surface.

### (D6) `extra` JSON forward-compat slot

A `TEXT` column holding JSON; readers tolerate `NULL` / `{}` / arbitrary keys. Naming convention: **kebab-case keys** to match the existing `task.extra` precedent in `src/schema/kanban.ts`. Examples:

- `extra.wontfix_reason` — set by `archive --reason wontfix:<text>`
- `extra.discord_message_id` — set when the row was mirrored to Discord (future)
- `extra.thread_root_id` — denormalized fast-path for threading queries

Adding a new key requires no schema migration; promoting a key to a typed column happens when the consumer count crosses ~3 (same threshold the kanban-extra hoist used).

### (D7) Migration shape — one-shot at upgrade, idempotent re-run

`atmux migrate inbox-to-sqlite` ships in the same release as the SQLite cut. Behavior:

1. Probe state: if `coordination_messages` row count > 0 OR the migration audit row exists, log `already-migrated, no-op`, exit 0. Idempotent re-fire is safe.
2. Parse `.atmux/driver-inbox.md`: walk date headers, extract triage glyphs, body, `--task <id>` pointers; INSERT per row with `direction='lead-to-driver'`, `status` derived from glyph (no-glyph → `pending`; ✅ → `acked`; 📤 → `routed`; ⏳ → `waiting`; ❌ → `archived` + `extra.wontfix_reason='migrated-legacy'`).
3. Parse `.atmux/lead-outbox.md`: same shape, `direction='member-to-driver'`.
4. Move both `.md` files to `.atmux/legacy/` directory (read-only marker) + write `.atmux/legacy/MIGRATION.md` pointing operators at `atmux driver-inbox show`.
5. Write a `migration_audit` table row with `name='coordination-messages-v1'`, `applied_at=<epoch>`.

Auto-fire trigger: `atmux start` calls `migrate inbox-to-sqlite` once when the migration audit row is absent. Operators upgrading mid-session pick up the migration on their next `atmux start` cycle without a manual step.

Per planner-anchor #7: idempotence is checked at row count + audit row both, so a partial-migration retry (interrupted by tmux crash mid-write) still safely re-runs to completion.

### (D8) Deprecation window — one minor release, then markdown-write path removed

- `0.x.0` (next minor) — SQLite cut lands; markdown read-AND-write paths kept for backward-compat. Migration auto-fires on first `atmux start`.
- `0.(x+1).0` — markdown read-AND-write paths removed. Operators on legacy `.md`-only setups hit a hard error on `atmux start` pointing at `atmux migrate inbox-to-sqlite`.

Per project CLAUDE.md §"Hooks, Commits, Tooling" outcome-rule and the `[[project_inbox_migration_done.md]]` memory — ADR-076's inbox migration shipped clean-cut after a one-release deprecation window; ADR-154 follows the same pattern.

### (D9) Backward-compat — legacy `.md` files preserved post-migration

The migration MOVES (not copies) `.atmux/driver-inbox.md` + `.atmux/lead-outbox.md` to `.atmux/legacy/` and writes a `MIGRATION.md` pointer. The originals stay readable for forensics and operator nostalgia; nothing in the live code path consumes them post-migration. Removal happens in the cut-over release (D8) by deleting the legacy directory.

Per planner-anchor #5: existing `.md` files preserved as read-only archive; new writes go to DB only.

## Tradeoffs + alternatives considered

### Per-direction tables (`driver_inbox` + `lead_outbox`), NOT chosen

Per the complaint c-96e5a8f2's verbatim schema sketch and the EPIC task body. Considered. Rejected per (D2) rationale:

- Identical triage semantics across directions = duplicate schema.
- Cross-direction queries (ADR-152 blockers list) need UNION ALL.
- Threading (`parent_id`) cross-direction would need a discriminator anyway.

Migration cost from unified → per-direction (if ever needed): a SQL pivot, trivial. Reverse: schema rewrite.

### Raw-glyph `triage TEXT` column, NOT chosen

Per the complaint's verbatim sketch. Considered. Rejected per (D4) rationale:

- Glyph-as-text is unqueryable for aging without parsing.
- Status enum is a closed set that the renderer translates BACK to glyphs for operator legibility — zero loss of legibility, full structured query power.

### Auto-synced markdown mirror, NOT chosen

Considered. Rejected per (D3) rationale:

- Reintroduces "which is canonical" ambiguity.
- Doubles the write path (every INSERT becomes write-DB + write-MD).
- The watch-mode tail (`atmux driver-inbox watch`) covers the live-tail use case without a synced file.

### Lazy-append-only migration (read .md until empty, then flip), NOT chosen

Considered. Rejected per (D7) rationale:

- "Empty" is fuzzy — the operator-archive convention means `.md` files don't go empty until explicit hand-curation.
- One-shot at upgrade is deterministic + auditable (migration row in `migration_audit`).
- Idempotent re-fire makes one-shot safe to retry on partial failure.

### Streaming-uncommitted writes via WAL tail, NOT chosen

Considered for `atmux driver-inbox watch`. Rejected per planner-anchor #4 + kanban/complaints conventions: SQLite handles atomic writes, the tail emits committed rows only. Streaming uncommitted would surface partial INSERTs to consumers and create the kind of race the markdown lock-dance was trying to prevent.

## Open questions (proposed → accepted gate)

- **OQ1** — should `direction` accept a third value `cross-team` for ADR-150 (cross-team coordination)? Default v1: NO; ADR-150 may extend the enum when it lands.
- **OQ2** — should `parent_id` be a hard foreign key (with `ON DELETE SET NULL`) or a soft pointer (no FK constraint)? Default v1: hard FK with `ON DELETE SET NULL` (matches kanban-task FK pattern).
- **OQ3** — does the `acked_at` reset on re-triage (e.g. `waiting` → `routed`) or stay pinned at first-triage? Default v1: STAY PINNED — the first-triage timestamp is the operator-visible "I saw this" event; subsequent transitions add an `extra.triage_history[]` audit array.
- **OQ4** — should `atmux driver-inbox watch` honor a `--since <iso>` flag for replay? Default v1: NO; the `show --status all` verb covers post-hoc query, and replay-on-tail risks operators interpreting old rows as live.

Reviewer / operator: any non-default flips `Status: proposed → accepted`.

## Acceptance (T1 commit)

- [x] ADR-154 Status: `proposed`, ready for reviewer pre-flag
- [x] Cross-refs ADR-126 (kanban SQLite canonical), ADR-076 (inboxes migration precedent), ADR-152 / ADR-153 / ADR-155 (consumer drafts; same /bruh sweep), ADR-151 (unblocker consumer)
- [x] §Decision documents both table shape (unified) + indices + `extra` JSON convention
- [x] §Migration documents one-shot script + idempotence audit row + one-release deprecation window
- [x] §Verbs documents the show / watch / add / triage / archive API surface
- [x] §Out-of-scope: cross-team aggregation (ADR-150) + .md→.db live bidirectional sync
- [x] Single commit (ADR only)
- [x] CHANGELOG `[Unreleased]` entry under `🟢 Shipped` (the doc + the structural ADR; impl T2-T6 are deferred per scope below)

## Out of scope

- Blockers list verb (ADR-152 T1+)
- Auto-promotion rules (ADR-153 T1+)
- Pane-state verb (ADR-155 T1+)
- Unblocker role (ADR-151 T1+)
- Cross-team aggregation (ADR-150 — different layer, parent-trunk cockpit roll-up)
- Execution slices T2-T6 — schema migration code, verb impls, dogfood gate, e2e tests. Each filed as a separate Task post-acceptance per the same-session decomp pattern (per `[[feedback_decomp_same_session_with_deps]]`); the staged carve-out is operator-decided.

## Related work + sibling patterns

- **ADR-126** — kanban SQLite canonical. Sibling pattern: `state.db` already hosts `tasks`, `epics`, `stories`. Adding `coordination_messages` to the same DB co-locates all coordination state for atomic cross-table reads (e.g. blockers list joining tasks + coordination_messages).
- **ADR-076** — member inboxes → SQLite (post-cutover, `.atmux/inboxes/<m>.json` frozen). Direct precedent for "markdown / JSON surface → SQLite canonical + verb-rendered view". This ADR is ADR-076's natural successor for the remaining two surfaces.
- **ADR-152 / ADR-153** — direct downstream consumers; the SQL view paths they need land in this ADR's schema.
- **CLAUDE.md driver-inbox triage convention** — the ✅ / 📤 / ⏳ / ❌ glyph set is preserved in the markdown render (D4 table) so operator muscle-memory survives the cut.
- **`[[project_inbox_migration_done.md]]` memory** — ADR-076 burned in a clean one-release deprecation window. ADR-154 mirrors that pattern (D7 + D8).


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
