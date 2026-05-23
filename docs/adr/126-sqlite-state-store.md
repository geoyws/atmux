# ADR-126: SQLite for `.atmux/` state, JSON archive-only

**Status:** Accepted — ratified by driver 2026-05-23 (foundation shipped + dogfooded for months: state.db powers kanban + merger_state + cron decommission + Honker events + epic-team registry; JSON archive-only enforced via ADR-076 + subsequent migrations through v13 on trunk).
**Date:** 2026-05-07
**Owner:** driver
**Driver-ref:** chat 2026-05-07 16:0X MYT — "let's entertain the idea of using sqlite instead of jq" + corruption incident on `.atmux/kanban.json` from bash misinterpretation. Build-now (post-cutover) per same chat.
**Release scope:** v1.1.x (post-v1.0.0 cutover; aligns with ADR-057 stall-prevention timing)
**Supersedes / extends:** ADR-098 (JSON+lock model) — narrows the JSON scope; ADR-057 D3a/D3c (lock-TTL + atomic-write) — becomes mostly obsolete for migrated state, retained for the JSON files that stay.

## Context

`.atmux/kanban.json` (and sibling state files: `inboxes/<member>.json`, `state/<feature>.json`) is a multi-writer, frequently-rewritten JSON store. The current invariant stack:

1. `flock` advisory locks on a sidecar `.lock` file (ADR-098)
2. `writeAtomic(path, content)` — write-tmp + fsync + rename (ADR-057 D3c)
3. PID-bearing locks + lock-TTL recovery (ADR-057 D3a)
4. Zod parse on read; `kanban_normalize` shim on write
5. Bash `jq` round-trips on the `lib/*.sh` side; TS `JSON.parse` + Zod on the bun side

Each layer compensates for a missing native primitive of JSON-on-disk. Today (2026-05-07) `.atmux/kanban.json` corrupted from a bash misinterpretation — the trap mode `kanban.sh` writes via `jq '...' >file` rather than through the atomic-write helper for some legacy paths, and a malformed bash variable expansion produced invalid JSON that `jq -e .` accepted because of the way the wrapper script parsed args.

The "kanban is gitignored" framing eliminates the historical argument for human-readable JSON — there's no PR diff to read; the only consumer of "human readable" is the operator running `jq '.tasks[] | select(.id=="X")'` ad-hoc, which is a tradeoff not a constraint.

The v1.0.0 cutover (PR #2 merged 2026-05-07 ~17:24 MYT, commit `ef852b7`) retired the bash-shared schema constraint that blocked cleaner state-store changes. Bash carve-outs in `src/schema/kanban.ts` (`.passthrough()`, permissive enums, nullable-everything) can simplify post-cutover.

### What this ADR is NOT

- **Not** a migration of every file under `.atmux/`. Markdown files stay markdown; `team.json` stays JSON (git-tracked, human-edited, schema small); JSONL append-only logs stay JSONL.
- **Not** a replacement of Zod. SQLite is the persistence layer; Zod stays as the parse/validate layer at the in-memory boundary. Belt-and-suspenders: DB schema constraints + Zod runtime validation.
- **Not** a multi-process coordination overhaul. SQLite's transactions + WAL handle the cases that ADR-098 + ADR-057 D3 were patching. Other coordination concerns (member↔lead, cron↔interactive) are unchanged.
- **Not** a switch to a remote DB. SQLite is single-file local; the `.atmux/state.db` lives where `.atmux/kanban.json` lived.

## Decision

### D1 — File-by-file migration policy

| Path | Today | Post-ADR-126 | Why |
|------|-------|--------------|-----|
| `.atmux/kanban.json` | JSON + flock + writeAtomic | **SQLite `tasks/epics/stories` tables** | Highest write-rate, most-corrupted, multi-writer (lead + workers + cron) |
| `.atmux/inboxes/<member>.json` | JSON + flock | **SQLite `inboxes` table** (member, msg_id, body, ts) | Frequent appends from `atmux send`; multi-reader |
| `.atmux/state/<feature>.json` (whip-idle, budget-warning, cursor-self-heal, account-swap, eternal-improvement) | JSON + flock | **SQLite `state_kv` table** (feature, key, value JSON, mtime) | Many small files → one keyed table; flock no longer needed |
| `.atmux/team.json` | JSON | **JSON (unchanged)** | Git-tracked, human-edited, schema small, low-write-rate |
| `.atmux/driver-inbox.md`, `lead-outbox.md`, `decisions.md`, `HANDOFF.md` | Markdown | **Markdown (unchanged)** | Human + LLM consumers; markdown is the right format |
| `.atmux/logs/*.jsonl` (budget-history, auto-push, lock-recovery) | JSONL append | **JSONL (unchanged)** | Append-only logs; SQLite gives no advantage unless time-series queries land |
| `.atmux/flags.md` | Markdown | **Markdown (unchanged)** | Operator-facing |
| `.atmux/pending-decisions.md` | Markdown | **Markdown (unchanged)** | Operator-facing |

**Carve-out rule:** if a file is human-edited or git-tracked or markdown by content type, it stays. SQLite gets the machine-managed, frequently-rewritten, lock-contended state.

### D2 — `bun:sqlite` over alternatives

`bun:sqlite` ships with the runtime. Zero deps, prepared statements, transaction helpers, type-safe via `Statement<T>`. Better than `better-sqlite3` (Node-native binding requires rebuilds across Bun versions) and infinitely better than `sqlite3` (callback-based, async-where-sync-suffices, no prepared-statement caching).

WAL mode mandatory: `PRAGMA journal_mode=WAL` + `PRAGMA synchronous=NORMAL`. WAL gives concurrent-read-while-write semantics — readers (status verb, doctor, dashboard) don't block writers (claim, done, dispatch).

### D3 — Repository pattern, schemas as bridges

Each existing `src/schema/<X>.ts` Zod module gains:

```ts
// src/schema/kanban.ts (additions)
export interface TaskRow { id: string; subject: string | null; ... }
export const taskFromRow = (row: TaskRow): KanbanTask => KanbanTask.parse({...});
export const taskToRow = (task: KanbanTask): TaskRow => ({...});
```

A new `src/core/repositories/<X>-repo.ts` owns the SQL:

```ts
// src/core/repositories/kanban-repo.ts
export class KanbanRepo {
  constructor(private db: Database) {}
  addTask(task: KanbanTask): void { /* INSERT */ }
  getTask(id: string): KanbanTask | null { /* SELECT */ }
  listTasks(filter: TaskFilter): KanbanTask[] { /* SELECT WHERE */ }
  // ... mirror existing core/kanban.ts API
}
```

Verbs continue to import from `core/kanban.ts`; that module switches from JSON-file ops to repo calls. **One internal API change, callers unchanged.**

### D4 — Migration verb: `atmux migrate-state json-to-sqlite`

```
atmux migrate-state json-to-sqlite [--team-dir <dir>] [--dry-run] [--archive-dir <dir>]
```

Behaviour:
1. Open `.atmux/state.db` (create + apply DDL if absent).
2. Read `.atmux/kanban.json`, parse via Zod, INSERT each task/epic/story.
3. Read `.atmux/inboxes/*.json`, parse, INSERT each entry.
4. Read `.atmux/state/*.json`, INSERT into `state_kv`.
5. Move source JSON files into `.atmux/archive/json-pre-sqlite-<epoch>/` (preserving directory structure).
6. Write `.atmux/migration-state-sqlite.json` audit record (epoch, source files, row counts, dest db path, schema version).
7. Idempotent: re-runs detect existing `state.db` + skip already-migrated rows by checking `(table, primary-key)` existence.

`--dry-run` parses everything + reports counts + errors but does not write the DB or move files.

### D5 — Schema versioning

`PRAGMA user_version` stores the schema version (integer). Migrations are Bun functions in `src/abstractions/sqlite-migrations.ts`:

```ts
export const migrations: Migration[] = [
  { from: 0, to: 1, up: (db) => { /* DDL: tasks/epics/stories/inboxes/state_kv */ } },
  // future
];
```

`openDatabase(path)` runs pending migrations on open. ADR-109 (schema-version-deferred-until-v2) is superseded by this for SQLite-managed state; markdown + team.json continue without versioning.

### D6 — Operator ergonomics: `atmux state` verb

To replace ad-hoc `jq` invocations, a thin reader verb:

```
atmux state tasks [--owner X] [--status todo] [--lane fe] [--json|--table]
atmux state task <id>
atmux state inbox <member>
atmux state kv <feature> <key>
atmux state sql '<query>'        # read-only; rejects INSERT/UPDATE/DELETE
```

`atmux state sql` is read-only (parse-rejected on mutation keywords) so operators don't accidentally corrupt state via a typo.

### D7 — Backups: nightly `.backup` snapshots

Cron-groom (`atmux groom`) gets a new step: `sqlite3 .atmux/state.db ".backup .atmux/backups/state-<YYYY-MM-DD>.db"`. Keep 7 days. Postmortem-recovery path: `cp .atmux/backups/state-<date>.db .atmux/state.db` after a stop.

### D8 — Parity harness retrofit

The Phase 3 parity matrix (ADR-119/027) currently does byte-exact / JSON-aware diffs on `.atmux/kanban.json`. Post-ADR-126, the parity harness gains a SQLite-aware comparator: opens both `state.db` files, diffs row sets per table (set-difference + row-level diff for matching IDs). The channel-mask config (ADR-120) extends to `db.tasks`, `db.epics`, `db.stories` channels. Existing JSON channels deprecate as files migrate.

### D9 — Carve-out: bash-side compatibility

The `lib/*.sh` bash side is being decommissioned per the v1.0.0 cutover (PR #2). Until it's fully removed, bash callers reading `.atmux/kanban.json` would see the moved-to-archive file. Two options:

- **Option A (fast):** decommission bash callers in lockstep. Anything in `lib/*.sh` that reads `kanban.json` either gets removed or rewritten to call `atmux state ...` (which goes through the SQLite repo).
- **Option B (slow):** add a JSON-mirror writer in the SQLite repo that re-emits `.atmux/kanban.json` on every transaction. Burns I/O for compatibility.

**Decision: A.** The cutover already deprecates bash. Burning compat I/O on a deprecated path is wrong direction.

### D10 — Concurrency: WAL + busy-timeout, not flock

WAL mode + `PRAGMA busy_timeout=5000` (5s) replaces the file-lock dance. Multiple processes can read concurrently; writes serialize within SQLite via the WAL.

The cron whip + interactive driver + per-pane `atmux done` calls all open the same DB file in WAL mode → no extra coordination. ADR-057 D3a's lock-recovery audit log (`.atmux/logs/lock-recovery.log`) becomes unused for SQLite-managed state — kept for the markdown files that still use `flock`.

## Consequences

### Positive

- Atomic writes free (transaction = no torn writes).
- Crash safety free (WAL + `synchronous=NORMAL`).
- Bash-quoting corruption class eliminated for migrated state (typed bind params).
- Concurrent reads don't block writers (WAL).
- Smaller surface: one `.atmux/state.db` instead of N JSON files + N `.lock` files + N `.bak.*` files.
- `sqldiff` for postmortem state-comparison (built into sqlite tooling).
- Native nightly snapshot via `.backup`.

### Negative

- Operator ergonomics shift: `jq '.tasks[] | select(.id=="X")'` → `sqlite3 state.db "SELECT * FROM tasks WHERE id='X'"` (slightly more verbose, but `atmux state` verb covers common cases).
- New dependency on the `atmux state` verb for CLI introspection.
- Migration verb has to be run on every existing team's `.atmux/`. Rollout coordination via `atmux migrate-state` + cron-groom check that each team has `state.db`.
- One more file format in the project. Tools (backup scripts, fly-by inspection) need updating.

### Neutral

- Storage: many small JSON files → one `state.db` + WAL + SHM. Roughly equivalent disk footprint at our scale (KBs).
- Backup story changes from `cp *.json` to `sqlite3 .backup` — different but not harder.
- `mtime > X` file-watcher idioms keep working (DB file mtime updates per write).

## Open questions

### OQ-1 — Migration order: which file first?

**Recommendation: kanban first.** Highest write-rate + corruption-prone + multi-writer = highest leverage. Inboxes second (similar shape). State KV last (smallest, easiest, can wait).

### OQ-2 — `state_kv` value column: BLOB or TEXT?

**Recommendation: TEXT with JSON validation via `CHECK(json_valid(value))`.** Fits Zod-on-read pattern; allows `json_extract` for indexed queries on hot fields.

### OQ-3 — Inbox archive: rows or compact JSON blob?

Inboxes can grow large (D3d size-cap at 1MB per ADR-057). Two shapes:

- **Per-message rows** (`inbox_messages`): clean schema, indexed by member+ts, supports cross-member queries.
- **One row per member, JSON-blob body** (mirrors current shape): minimal change.

**Recommendation: per-message rows.** Cleaner schema; the size-cap moves from "1MB JSON file" to "delete oldest rows beyond N".

### OQ-4 — Fleet rollout: per-team or global?

Each team's `.atmux/state.db` is independent. Migration verb is per-team. Cron-groom enforces every team has `state.db` (auto-runs migration if missing post-rollout date).

**Recommendation:** opt-in per-team for v1.1.0, default-on in v1.2.0 with auto-migration on first whip-tick post-upgrade.

### OQ-5 — When to remove JSON write-side entirely?

Post-burn-in. Once all teams have `state.db` + parity harness shows zero divergence + bash decommission complete (ADR-106 Phase 5 finished), `core/kanban.ts` drops the JSON write fallback. Tracked as v1.2.x.

## Cross-references

- ADR-098: JSON + locking model (predecessor)
- ADR-107: v2 verb redesign (parallel — SQLite migration is Phase-5 / v1.1.x; verb redesign is Phase-6 / v2)
- ADR-109: schema-version-deferred (superseded for SQLite-managed state)
- ADR-119 / ADR-120: parity matrix + channel-mask (extends to SQLite channels)
- ADR-057 D3a/D3c: lock-TTL + atomic-write (mostly obsolete for migrated state)
- ADR-058: multi-tier fallback chain (paused; resumes post-cutover, orthogonal to ADR-126)
