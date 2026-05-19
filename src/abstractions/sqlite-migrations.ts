// ADR-060 §D5: SQLite migration ladder. New migrations append-only;
// never edit a landed migration's `up` body. Each entry bumps
// `PRAGMA user_version` from `from` to `to` atomically (the
// `openDatabase()` helper wraps the call in a transaction).
//
// Tables created in v1 mirror the file shapes in `.atmux/`:
//   - tasks / epics / stories  ← .atmux/kanban.json
//   - inbox_messages           ← .atmux/inboxes/<member>.json
//   - state_kv                 ← .atmux/state/<feature>.json
//
// Field choices follow the existing Zod schemas (src/schema/*.ts).
// Permissive types (TEXT for status enums, nullable for most cols)
// match the bash-era schema's `.passthrough()` posture so the
// migration verb can populate from existing JSON without lossy
// coercion. Tightening to enum CHECKs is a v2 concern.

import type { Migration } from "./sqlite.ts";

export const migrations: readonly Migration[] = [
  // ---------- v0 → v1 ----------
  {
    from: 0,
    to: 1,
    up: (db) => {
      // ----- kanban: tasks / epics / stories -----
      db.exec(`
				CREATE TABLE tasks (
					id TEXT PRIMARY KEY NOT NULL,
					subject TEXT,
					body TEXT,
					status TEXT,
					owner TEXT,
					deps TEXT,                 -- JSON array; query via json_each
					priority INTEGER,
					epic TEXT,
					story TEXT,
					lane TEXT,
					deliverable TEXT,
					stale_min INTEGER,
					driver_only INTEGER,       -- 0/1
					created_at INTEGER,
					claimed_at INTEGER,
					completed_at INTEGER,
					claimed_from TEXT,
					created_from TEXT,
					note TEXT,
					extra TEXT                 -- JSON; passthrough for unknown fields
				) STRICT;
			`);
      db.exec("CREATE INDEX idx_tasks_status ON tasks(status)");
      db.exec("CREATE INDEX idx_tasks_owner ON tasks(owner)");
      db.exec("CREATE INDEX idx_tasks_lane ON tasks(lane)");
      db.exec("CREATE INDEX idx_tasks_epic ON tasks(epic)");
      db.exec("CREATE INDEX idx_tasks_story ON tasks(story)");

      db.exec(`
				CREATE TABLE epics (
					id TEXT PRIMARY KEY NOT NULL,
					title TEXT,
					body TEXT,
					status TEXT,
					driver_ref TEXT,
					created_at INTEGER,
					completed_at INTEGER,
					stories TEXT,              -- JSON array
					extra TEXT
				) STRICT;
			`);

      db.exec(`
				CREATE TABLE stories (
					id TEXT PRIMARY KEY NOT NULL,
					epic TEXT,
					title TEXT,
					body TEXT,
					acceptance_criteria TEXT,
					status TEXT,
					created_at INTEGER,
					completed_at INTEGER,
					advanced_at INTEGER,
					review_signoff INTEGER,    -- 0/1
					merge_task_id TEXT,
					extra TEXT
				) STRICT;
			`);
      db.exec("CREATE INDEX idx_stories_epic ON stories(epic)");

      // ----- inbox: per-message rows (ADR-060 OQ-3 recommendation) -----
      db.exec(`
				CREATE TABLE inbox_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					member TEXT NOT NULL,
					msg_id TEXT,
					sender TEXT,
					body TEXT,
					ts INTEGER NOT NULL,
					kind TEXT,
					extra TEXT
				) STRICT;
			`);
      db.exec("CREATE INDEX idx_inbox_member_ts ON inbox_messages(member, ts DESC)");

      // ----- state_kv: per-feature small JSON (whip-idle, budget-warning, etc.) -----
      db.exec(`
				CREATE TABLE state_kv (
					feature TEXT NOT NULL,
					key TEXT NOT NULL,
					value TEXT NOT NULL CHECK(json_valid(value)),
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (feature, key)
				) STRICT;
			`);
    },
  },
  // ---------- v1 → v2 ----------
  // ADR-077 §D5 / §F2 / ADR-133: per-team complaint box. The durable
  // artifact of medic's diagnosis loop (medic = the role formerly
  // named `superdoctor`; renamed per ADR-133) — one row per anomaly
  // with root cause + preventive ask. Stored per-team (each
  // `<team>/.atmux/state.db` holds its own complaints) per ADR-077
  // §Open.
  {
    from: 1,
    to: 2,
    up: (db) => {
      db.exec(`
				CREATE TABLE complaints (
					id TEXT PRIMARY KEY NOT NULL,
					opened_at INTEGER NOT NULL,
					opened_by TEXT,
					incident_summary TEXT NOT NULL,
					root_cause TEXT,
					preventive_ask TEXT,
					status TEXT NOT NULL DEFAULT 'open',
					resolved_at INTEGER,
					resolved_by TEXT,
					related_task_id TEXT,
					extra TEXT
				) STRICT;
			`);
      db.exec("CREATE INDEX idx_complaints_status ON complaints(status)");
      db.exec("CREATE INDEX idx_complaints_opened_at ON complaints(opened_at DESC)");
    },
  },
  // ---------- v2 → v3 ----------
  // Per t-e5e5d576: structured provenance for cross-team analysis.
  // `source_kind` (medic/superdoctor [deprecated alias per ADR-133]
  // /member/operator/cli/cron) + structured `source_id` give a
  // queryable replacement for the free-form `opened_by` text field;
  // `target_team` distinguishes the team a complaint is ABOUT from
  // the team's state.db it happens to live in (needed once medic
  // files cross-team).
  //
  // Existing v2 rows get NULL in the three new columns — no heuristic
  // backfill from `opened_by` (the inference risk isn't worth it; the
  // verb requires explicit `--source-kind` for new rows).
  {
    from: 2,
    to: 3,
    up: (db) => {
      db.exec("ALTER TABLE complaints ADD COLUMN source_kind TEXT");
      db.exec("ALTER TABLE complaints ADD COLUMN source_id TEXT");
      db.exec("ALTER TABLE complaints ADD COLUMN target_team TEXT");
      db.exec("CREATE INDEX idx_complaints_source_kind ON complaints(source_kind)");
      db.exec("CREATE INDEX idx_complaints_target_team ON complaints(target_team)");
    },
  },
  // ---------- v3 → v4 ----------
  // ADR-077 §F6: superdoctor self-escalation event log. One row per
  // structural-fix attempt against a complaint. After N=3 rows with
  // `outcome='failed'` for the same `complaint_id`, the skill emits
  // exactly one `[self-heal-failed]` Discord ping (renderer in
  // src/abstractions/discord.ts). Dedup state for the ping lives in
  // state_kv (feature `superdoctor-self-heal-escalation`); this table
  // is the durable attempt log, not the dedup ledger.
  //
  // Renumbered v2→v3 → v3→v4 at trunk-merge 2026-05-14: trunk's
  // complaints provenance migration (t-e5e5d576) claimed v3 first;
  // the migration ladder must stay monotonic so this lands on top.
  //
  // IF NOT EXISTS guards are defensive (ADR-147 T9 dogfood, 2026-05-15):
  // they make the migration safe to re-run when paired with the v6→v7
  // legacy-DB rescue below, which fires this SQL again on DBs that
  // skipped the renumbered v3→v4 because they ran the pre-renumber
  // hygiene-at-v3→v4 instead.
  {
    from: 3,
    to: 4,
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS superdoctor_attempts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					complaint_id TEXT NOT NULL,
					attempt_n INTEGER NOT NULL,
					outcome TEXT NOT NULL CHECK(outcome IN ('resolved','partial','failed')),
					attempted_at INTEGER NOT NULL,
					action TEXT,
					note TEXT,
					extra TEXT
				) STRICT;
			`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_sd_attempts_complaint ON superdoctor_attempts(complaint_id, attempted_at DESC)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_sd_attempts_outcome ON superdoctor_attempts(outcome)",
      );
    },
  },
  // ---------- v4 → v5 ----------
  // ADR-131 §D4 / T3 (t-247b4b35): per-team kanban-hygiene fingerprint
  // table. Idempotent upsert keyed on (task_id, fingerprint_class) so
  // re-detection across ticks bumps last_seen_at without duplicating
  // rows. Severity is stored as INTEGER for cheap `ORDER BY` in the
  // drain loop (P0=0, P1=1, P3=3 — P2 reserved but unused). Drain-loop
  // sort: severity ASC, detected_at ASC, then confidence-ladder filter.
  //
  // Renumbered v3→v4 → v4→v5 at trunk-merge round 2 (2026-05-14 16:05
  // MYT): trunk's superdoctor_attempts migration (4836a7e, ADR-077 §F6)
  // claimed v3→v4 first; this hygiene table appends as v4→v5 to keep
  // the migration ladder monotonic per ADR-060 §D5.
  //
  // IF NOT EXISTS guards (ADR-147 T9 dogfood, 2026-05-15): without
  // these, DBs that ran the pre-renumber v3→v4 (which was this same
  // hygiene SQL) crash here on every open — user_version=4 + the
  // hygiene table already physically exists, so the bare CREATE TABLE
  // throws. The guard makes the step a no-op on those DBs while still
  // creating the table for fresh DBs walking the ladder from v0.
  {
    from: 4,
    to: 5,
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS superdoctor_hygiene (
					task_id TEXT NOT NULL,
					fingerprint_class TEXT NOT NULL,
					severity INTEGER NOT NULL,
					confidence TEXT NOT NULL,
					diagnosis TEXT NOT NULL,
					detected_at INTEGER NOT NULL,
					last_seen_at INTEGER NOT NULL,
					attempted_fix TEXT,
					fix_applied_at INTEGER,
					fix_successful INTEGER,
					PRIMARY KEY (task_id, fingerprint_class)
				) STRICT;
			`);
      // Drain-loop hot path: list unfixed rows by severity/detected
      // ordering. Partial index on `fix_applied_at IS NULL` keeps the
      // index small (fixed rows live forever for audit but aren't
      // re-scanned).
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_hygiene_unfixed ON superdoctor_hygiene(severity ASC, detected_at ASC) WHERE fix_applied_at IS NULL",
      );
    },
  },
  // ---------- v5 → v6 ----------
  // ADR-134 §state-machine / t-6a959e02: per-member-branch merge state.
  // One row per `<base>-<member>` branch under the team's gitter loop;
  // primary key is the branch name itself (operator-visible, unique
  // within the team's state.db scope). State literals match the 10-state
  // BranchMergeState union from `src/core/branch-merge-state.ts`; permissive
  // TEXT typing (no CHECK constraint) matches the bash-era posture used by
  // the rest of this ladder and lets a future state-set extension land
  // without an ALTER TABLE.
  //
  // The `note` column carries the human-readable transition reason
  // (PreMergeGateDecision.reason, conflict SHA, etc.) so operators
  // inspecting state.db can answer "why is this branch stuck" without
  // grepping logs. `transitioned_by` records the caller identity
  // ('event' / 'cron' / 'operator' / <member-name>) for cross-trigger
  // audit (ADR-134 §triggers — event-driven primary vs cron backstop).
  //
  // Indexes:
  //   - `state` — cron sweep's "list all not-terminal" hot path.
  //   - `transitioned_at DESC` — recent-activity probes (doctor, audit).
  {
    from: 5,
    to: 6,
    up: (db) => {
      db.exec(`
				CREATE TABLE merger_state (
					member_branch TEXT PRIMARY KEY NOT NULL,
					state TEXT NOT NULL,
					note TEXT,
					transitioned_at INTEGER NOT NULL,
					transitioned_by TEXT,
					base_sha TEXT,
					conflict_sha TEXT,
					extra TEXT
				) STRICT;
			`);
      db.exec("CREATE INDEX idx_merger_state_state ON merger_state(state)");
      db.exec("CREATE INDEX idx_merger_state_transitioned ON merger_state(transitioned_at DESC)");
    },
  },
  // ---------- v6 → v7 ----------
  // Legacy-DB rescue (ADR-147 T9 dogfood discovery, 2026-05-15): the
  // v3→v4 renumber on 2026-05-14 swapped superdoctor_hygiene
  // (was v3→v4) with superdoctor_attempts (now v3→v4). DBs migrated
  // before the renumber sit at user_version=4 with the hygiene table
  // but NO superdoctor_attempts — the new v3→v4 (attempts) never ran
  // on them. The v4→v5 (hygiene) IF NOT EXISTS guard above lets those
  // DBs advance, but they still need superdoctor_attempts created.
  // This step is that backfill: re-runs the v3→v4 SQL idempotently so
  // pre-renumber DBs end up with both tables present.
  //
  // For fresh DBs (walked the ladder from v0): the table already
  // exists from v3→v4, so all CREATEs here are no-ops.
  {
    from: 6,
    to: 7,
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS superdoctor_attempts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					complaint_id TEXT NOT NULL,
					attempt_n INTEGER NOT NULL,
					outcome TEXT NOT NULL CHECK(outcome IN ('resolved','partial','failed')),
					attempted_at INTEGER NOT NULL,
					action TEXT,
					note TEXT,
					extra TEXT
				) STRICT;
			`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_sd_attempts_complaint ON superdoctor_attempts(complaint_id, attempted_at DESC)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_sd_attempts_outcome ON superdoctor_attempts(outcome)",
      );
    },
  },
  // ---------- v7 → v8 ----------
  // ADR-139 §D2 / T3 (t-841049e4): refusal-event ledger for the
  // refusal-pattern auto-rotate path. Medic (hourly, ADR-077 / ADR-133)
  // and sentinel (per-tick, ADR-132 / ADR-158 rename) scan each member-pane
  // via `classifyRefusal` from `src/core/refusal-classifier.ts` (T2); positive
  // results record here. T3 ships only the SCAN + RECORD path; T4 reads
  // these rows through `refusal-threshold.ts::shouldRotate` and fires
  // `atmux rotate-member` when threshold crossed.
  //
  // Renumbered from v6→v7 (gitter branch) to v7→v8 at merge time because
  // trunk landed an ADR-147 legacy-DB rescue at v6→v7 first. Pre-existing
  // DBs that walked the v6→v7 ladder before this merge sit at user_version=7
  // with the legacy-rescue tables present; this v7→v8 then creates
  // refusal_events. Fresh DBs walking from v0 see them as sequential
  // migrations with no cross-coupling.
  //
  // Idempotency: `UNIQUE(member, minute_bucket, severity)` collapses
  // repeat detections within the same minute to a single row. Re-scans
  // across ticks within the same minute are no-ops via `INSERT OR IGNORE`
  // at the call site. `minute_bucket = floor(detected_at / 60)` —
  // computed by the caller (a generated column would couple this
  // migration to bun-sqlite's STRICT-mode generated-column support; the
  // explicit column is more portable).
  //
  // `phrases` is a JSON array of `{ phrase, class }` mirroring the
  // `RefusalDetectionResult.phrases` shape from ADR-139 T2. `severity`
  // is the highest-precedence class observed ('soft' / 'hard' / 'role' /
  // 'meta'); the bare 'none' value never lands here (caller only writes
  // on `detected === true`).
  //
  // Indexes:
  //   - `(member, detected_at DESC)` — threshold-window lookup hot path
  //     (T4 `shouldRotate(recentEvents, …)` reads last N events per
  //     member).
  //   - `severity` — cross-member audit + Discord aggregator (T4).
  {
    from: 7,
    to: 8,
    up: (db) => {
      db.exec(`
				CREATE TABLE refusal_events (
					id TEXT PRIMARY KEY NOT NULL,
					member TEXT NOT NULL,
					team TEXT NOT NULL,
					phrases TEXT NOT NULL CHECK(json_valid(phrases)),
					severity TEXT NOT NULL,
					confidence REAL NOT NULL,
					detected_at INTEGER NOT NULL,
					minute_bucket INTEGER NOT NULL,
					UNIQUE(member, minute_bucket, severity)
				) STRICT;
			`);
      db.exec(
        "CREATE INDEX idx_refusal_events_member_detected ON refusal_events(member, detected_at DESC)",
      );
      db.exec("CREATE INDEX idx_refusal_events_severity ON refusal_events(severity)");
    },
  },
  // ---------- v8 → v9 ----------
  // ADR-144 §Decision T2 (t-49bd4fe1): epic-team test-gate — durable
  // outcome record for the `tested` state.
  //
  // The merger_state.state column already accepts 'tested' + 'test_failed'
  // literals (permissive TEXT typing per v5→v6 comment); this migration
  // adds a sibling `test_outcome` column for the test-gate guard
  // ({@link canEnterMerging} in src/core/branch-merge-state.ts). Values:
  //   - 'pass'   — test suite passed; `tested → merging` allowed.
  //   - 'fail'   — test suite failed; `tested → merging` refused. The
  //                test-runner advances to `test_failed` instead.
  //   - 'bypass' — operator ADR-033 driver-scope override via
  //                `atmux epic-merge advance --to merging --skip-test-gate`.
  //                Logged to ~/.atmux/state/test-gate-bypasses.log +
  //                Discord [test-gate-bypass] (T5).
  //   - NULL     — no outcome on record. Default for fresh rows; also
  //                the value held during ADR-134 intra-team scope
  //                (intra-team's test-gate is post-merge so the column
  //                stays NULL for those branches).
  //
  // Permissive TEXT typing (no CHECK constraint) matches the rest of
  // the merger_state shape; a future state-set extension (e.g.
  // 'flake-retry' for §retryOnFlake telemetry) lands additively.
  //
  // No index — column is read alongside the row by branch-name PK; no
  // standalone scan path.
  {
    from: 8,
    to: 9,
    up: (db) => {
      db.exec("ALTER TABLE merger_state ADD COLUMN test_outcome TEXT");
    },
  },
];
