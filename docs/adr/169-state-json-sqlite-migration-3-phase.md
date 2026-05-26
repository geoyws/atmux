# ADR-169: state.db migration for residual `.atmux/state/*.json` — 3-phase decomp (flags / role_state / budget)

**Status**: Accepted — ratified by driver 2026-05-21 (3-phase state.db migration: flags / role_state / budget tables; JSON archive-only post-migration per ADR-126; §OQ recommendations as-written)
**Date**: 2026-05-17
**Supplements**: [ADR-126](126-sqlite-state-store.md) §SQLite for `.atmux/` state, JSON archive-only
**Closes**: ombudsman complaint `c-67bbac0a` (filed by medic 2026-05-17; adjudicated 2026-05-17)
**EPIC**: `e-38ee9939`

## Context

[ADR-126](126-sqlite-state-store.md) (proposed 2026-05-07) established the principle *"SQLite for `.atmux/` state, JSON archive-only"*. The kanban migration shipped at epoch `1778159007497` (April 2026) per `.atmux/migration-state-sqlite.json`; kanban now lives in `state.db` (~2.4 MB), `kanban.json` archived under `.atmux/archive/json-pre-sqlite-*`. The inbox migration shipped per ADR-076 (atmux 0.5.0+). Both worked.

**~14 state-of-record JSON files remain** under `.atmux/state/` — each its own bespoke read/write path (no shared abstraction beyond `tryParseJsonString`), each carrying its own corruption-as-fresh / atomicity / concurrency surface that the kanban migration consolidated away.

Medic flagged this via complaint `c-67bbac0a` (sourceKind=null, targetTeam=atmux, kind=improvement, severity=medium). Ombudsman adjudicated and filed EPIC `e-38ee9939`. The EPIC body proposes a 3-phase decomp; this ADR ratifies the table schemas + per-phase migration verb contracts.

### In-scope (14 files)

Per medic's enumeration (verified 2026-05-17):

**Per-flag state — single-row toggle (6 files post-OQ-3 resolution)**:
- `paused.json`
- `resume.json`
- `pulse-state.json`
- `sentinel-state.json`
- `eternal-improvement.json`
- `whip-config-drift-state.json`

**Per-role tracking (12+ files, variable count for cost-*/modal-history-*)**:
- `cost-<role>.json` (8 files; one per current member)
- `modal-history-<role>.json` (2 files)
- `heads-up-cursor.json` (team-scoped, role=`_`)
- `brief-versions.json` (team-scoped, role=`_`)
- `ombudsman-pending.json` (team-scoped, role=`_`)

**Budget state (3 files)**:
- `budget-pause.json`
- `budget-refresh-soon-state.json`
- `budget-warning-state.json`

### KEEP-AS-JSON (out of scope, explicit)

- `cockpit.json` + `team.json` + `.claude/team.json` — config, human-editable, per ADR-164.
- `.atmux/state/budget-probe-*.json` — per-skill cache, ephemeral.
- `.atmux/logs/budget-history.json` — jsonl-style log.

T5's doctor probe `migration-state-incomplete` enforces this list mechanically.

## Decision

### Three new SQLite tables

#### `flags` table (P1 — 6 single-row state toggles)

```sql
CREATE TABLE IF NOT EXISTS flags (
    key            TEXT     PRIMARY KEY,
    value          TEXT     NOT NULL,
    updated_at     INTEGER  NOT NULL,
    schema_version INTEGER  NOT NULL
);
```

- One row per source file; `key` = file basename without `.json` suffix
- `value` = full Zod-validated JSON string (TEXT-blob encoding per OQ-1)
- `updated_at` = epoch milliseconds at write time
- `schema_version` = per-row forward-compat marker per OQ-2

Repo abstraction: `src/core/flags-repo.ts` exporting `readFlag(key)` / `writeFlag(key, value)` / `clearFlag(key)`.

#### `role_state` table (P2 — 12+ per-role tracking files)

```sql
CREATE TABLE IF NOT EXISTS role_state (
    role            TEXT     NOT NULL,
    namespace       TEXT     NOT NULL,
    payload         TEXT     NOT NULL,
    updated_at      INTEGER  NOT NULL,
    schema_version  INTEGER  NOT NULL,
    PRIMARY KEY (role, namespace)
);
```

- Multi-role keying via composite primary key `(role, namespace)`
- Role-scoped files use the role parsed from filename (e.g. `cost-lead.json` → `role=lead`)
- Team-scoped files use sentinel `role='_'` (heads-up-cursor, brief-versions, ombudsman-pending)
- `payload` = full Zod-validated JSON string (per OQ-1 default)
- Glob discovery at migration time: `cost-*.json` + `modal-history-*.json`

Repo abstraction: `src/core/role-state-repo.ts` exporting `readRoleState(role, namespace)` / `writeRoleState(role, namespace, payload)` / `listRoleState(namespace)`.

#### `budget` table (P3 — 3 budget state files)

```sql
CREATE TABLE IF NOT EXISTS budget (
    probe_name      TEXT     PRIMARY KEY,
    observed_at     INTEGER  NOT NULL,
    state           TEXT     NOT NULL,
    updated_at      INTEGER  NOT NULL,
    schema_version  INTEGER  NOT NULL
);
```

- One row per budget probe; `probe_name` = file basename without `.json` suffix
- `observed_at` = epoch milliseconds parsed from payload's timestamp field, fallback to file mtime
- `state` = full Zod-validated JSON string

Repo abstraction: `src/core/budget-state-repo.ts` exporting `readBudgetState(probe)` / `writeBudgetState(probe, state)`.

### Migration verb extension

`src/verbs/migrate-state.ts` (per existing kanban target template per `t-26dba81c` / `src/verbs/migrate-state.ts:1`):

```
atmux migrate-state json-to-sqlite [--team-dir <dir>]
                                   [--dry-run]
                                   [--target=all|kanban|inboxes|state|flags|role-state|budget]
                                   [--db-path <path>]
```

New target enum values:
- `--target=flags` → reads 6 flag files, upserts into `flags`, archives sources to `.atmux/archive/json-pre-sqlite-flags-<ts>/`
- `--target=role-state` → glob-discovers cost-*.json + modal-history-*.json + reads 3 team-scoped files, upserts into `role_state`, archives
- `--target=budget` → reads 3 budget files, upserts into `budget`, archives
- `--target=all` → runs kanban + inboxes (no-op if already done) + flags + role-state + budget sequentially

Each phase writes its own migration entry to `.atmux/migration-state-sqlite.json` on completion.

### Idempotence semantics (OQ-5)

`INSERT ... ON CONFLICT DO UPDATE` (upsert) per phase, matching kanban migration precedent. Re-firing on the same source state is safe; `updated_at` refreshes; no duplicate rows. Archive step skips if destination dir already exists.

### Caller-migration timing (OQ-4)

Each phase's impl Task (T2 / T3 / T4) lands **schema + verb + caller migration + same-commit unit tests in one commit**. This matches the single-commit invariant per CLAUDE.md §Same-commit doc updates: the documented surface (`.atmux/state/<file>.json`) and its replacement abstraction land atomically. No interim state where some callers read JSON + some read SQLite.

### OQ-3 conflict resolution: budget files

EPIC body's §Proposed 3-phase decomposition mapped budget files into **both** P1 (flags) and P3 (budget) tables. This ADR resolves: **budget files live in `budget` table exclusively**. P1's `flags` table covers ONLY the 6 non-budget single-row toggles.

Rationale: `budget` table's `observed_at` column gives a queryable timestamp that `flags`'s opaque `value` blob doesn't. Future probes (e.g. budget-history rollups) benefit from the dedicated table shape; flag toggles don't need that affordance.

### KEEP-AS-JSON enforcement (OQ-6)

Defense-in-depth via two surfaces:

1. ADR body explicit enumeration (this §Context §KEEP-AS-JSON section).
2. T5 doctor probe `migration-state-incomplete` — scans `.atmux/state/` for `*.json` files not in the canonical KEEP list; warns per match.

The probe is severity P2 warn (not error) — operators may have legitimate ad-hoc state files that haven't yet been classified. Periodic operator review keeps the KEEP list accurate.

## Consequences

- **Corruption surface consolidates** — 14 bespoke JSON read/write paths fold into 3 repo abstractions (`flags-repo` / `role-state-repo` / `budget-state-repo`) on top of `state.db`'s atomic transaction layer. Matches the kanban-migration win.
- **No code-side runtime cost increase** — SQLite reads are equal-or-faster than the existing `tryParseJsonString` paths; writes gain atomic semantics.
- **Archive pattern preserves rollback** — `.atmux/archive/json-pre-sqlite-<phase>-<ts>/` lets operators inspect pre-migration state for ~30 days; rollback per phase is `git restore` + JSON re-read OR explicit re-migration runs on the archived dir.
- **3 new SQLite migrations** land sequentially (one per phase); migration-runner head advances v(N) → v(N+3) over the EPIC duration.
- **Doctor probe `migration-state-incomplete`** continuously verifies the migration is complete + the KEEP-AS-JSON list is accurate.
- **`migration-state-sqlite.json`** audit file grows from 1 entry (kanban) to 4 entries (kanban + flags + role-state + budget).
- **No new ADRs after this one** for the 14-file scope. Future state-shape changes land via §Amendment to ADR-169 OR siblings to this ADR for unanticipated state classes.

### Sibling work (cross-ref)

- [ADR-126](126-sqlite-state-store.md) (proposed) — the canonical principle. This ADR closes its remaining surface; T6 flips ADR-126 status `proposed → accepted`.
- [ADR-076](076-inbox-migration-to-sqlite.md) (shipped, atmux 0.5.0+) — `.atmux/inboxes/<m>.json` → SQLite. **Precedent** for the migration verb + archive pattern.
- [ADR-154](154-driver-inbox-lead-outbox-sqlite-migration.md) (proposed, EPIC `t-2298cbb0`) — driver-inbox + lead-outbox markdown→SQLite migration. **Sibling** pattern at the `coordination_messages` table level; non-blocking on this EPIC.

### Hard guardrail

Per ADR-077 §7d ("not a license to redesign atmux") + EPIC body — the medic filed the complaint but explicitly deferred implementation. Scope is fixed at the 14 enumerated files. Don't widen.

## Open questions

1. **OQ-1 (RESOLVED, MEDIUM-rev)**: P2 `role_state` payload encoding — JSON-blob TEXT vs exploded per-namespace columns.
   - **Default**: JSON-blob TEXT.
   - **Rationale**: matches kanban precedent (payload-as-blob with optional indexed columns); avoids per-namespace schema churn. Operators query via JSON1 extension if needed.
   - **Reversibility**: medium — flipping to exploded columns later is a schema migration touching all namespace consumers; possible but invasive.

2. **OQ-2 (RESOLVED, LOW-rev)**: schema_version per-row vs single migration head.
   - **Default**: per-row `schema_version` column on all 3 tables.
   - **Rationale**: forward-compatible — different namespaces / probe_names can evolve their payload shape independently without forcing a global migration. Cost: 1 column per table; minimal.

3. **OQ-3 (RESOLVED, LOW-rev)**: budget file placement — flags table vs budget table.
   - **Default**: budget table exclusively.
   - **Rationale**: budget table's `observed_at` column gives semantic affordance flags doesn't. EPIC body's dual-mapping was an artifact of medic's file enumeration, not a design call.

4. **OQ-4 (RESOLVED, LOW-rev)**: caller-migration timing — within same task as schema/verb OR sibling task.
   - **Default**: within same task as schema + verb impl.
   - **Rationale**: matches CLAUDE.md §Same-commit doc updates discipline; no interim mixed-state where some callers read JSON + others SQLite.

5. **OQ-5 (RESOLVED, LOW-rev)**: idempotence semantics — upsert vs skip-if-exists.
   - **Default**: upsert (overwrite-newer).
   - **Rationale**: kanban migration precedent; matches `INSERT ON CONFLICT DO UPDATE` pattern.

6. **OQ-6 (RESOLVED, LOW-rev)**: KEEP-AS-JSON enforcement — doctor probe vs trust body enumeration.
   - **Default**: doctor probe `migration-state-incomplete` + body enumeration. Defense-in-depth.
   - **Rationale**: probe catches operator-introduced ad-hoc files; body enumeration is the canonical authoritative list.

## Cross-references

- [ADR-126](126-sqlite-state-store.md) — `state.db` SQLite principle; T6 flips this to `accepted`.
- [ADR-076](076-inbox-migration-to-sqlite.md) — inbox migration precedent.
- [ADR-154](154-driver-inbox-lead-outbox-sqlite-migration.md) — sibling markdown→SQLite migration at coordination layer.
- [ADR-164](164-sync-claude-team-json.md) — `cockpit.json` + `team.json` + `.claude/team.json` KEEP-AS-JSON rationale.
- [ADR-005](005-atomic-json-and-flock.md) — flock pattern superseded for state files by SQLite transactions (config files keep flock).
- `src/verbs/migrate-state.ts` — kanban target template (per `t-26dba81c`).
- Ombudsman complaint `c-67bbac0a` (filed 2026-05-17) — the trigger.
- EPIC `e-38ee9939` — 6 sub-tasks T1-T6 with populated deps[].
