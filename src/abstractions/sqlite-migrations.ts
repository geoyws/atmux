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
  {
    from: 3,
    to: 4,
    up: (db) => {
      db.exec(`
				CREATE TABLE superdoctor_attempts (
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
        "CREATE INDEX idx_sd_attempts_complaint ON superdoctor_attempts(complaint_id, attempted_at DESC)",
      );
      db.exec("CREATE INDEX idx_sd_attempts_outcome ON superdoctor_attempts(outcome)");
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
  {
    from: 4,
    to: 5,
    up: (db) => {
      db.exec(`
				CREATE TABLE superdoctor_hygiene (
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
        "CREATE INDEX idx_hygiene_unfixed ON superdoctor_hygiene(severity ASC, detected_at ASC) WHERE fix_applied_at IS NULL",
      );
    },
  },
  // ---------- v5 → v6 ----------
  // ADR-134 §state-machine / T2 (t-b5f12ab1): branch-merge state
  // ledger. One row per `(team, branch_key)` where `branch_key`
  // is `<base>-<member>` (e.g. `geoyws-whip-impl`). All transitions
  // route through `merger-state-repo::transition` which wraps a
  // BEGIN IMMEDIATE transaction (reviewer pre-flag #1 per ADR-091
  // audit) — concurrent dispatcher + cron-backstop fires serialize
  // at the SQLite writer-lock level.
  //
  // `state` mirrors the ten-state union in `branch-merge-state.ts`
  // (open / in_progress / ready_to_merge / rebasing / merging /
  // tested / merged / conflict / test_failed / reverted); kept as
  // TEXT (not INTEGER) so SQLite-cli inspection reads naturally +
  // operator-edits don't need a literal-index lookup. CHECK
  // constraint pins the closed set; the Zod schema is the
  // application-layer mirror.
  //
  // `note` carries the operator-facing reason string (`from
  // shouldTransitionFromInProgress.reason` or conflict SHA per
  // ADR-134 §Conflict surface §1 "durable signal must precede
  // fire-and-forget"). `updated_at` is set on every transition
  // (event-driven dispatcher OR cron backstop), used by
  // `merger-state-repo::loadAll` ordering + the auditor's
  // staleness probe.
  {
    from: 5,
    to: 6,
    up: (db) => {
      db.exec(`
					CREATE TABLE merger_state (
						team TEXT NOT NULL,
						branch_key TEXT NOT NULL,
						state TEXT NOT NULL CHECK(state IN (
							'open','in_progress','ready_to_merge','rebasing',
							'merging','tested','merged','conflict','test_failed','reverted'
						)),
						note TEXT,
						updated_at INTEGER NOT NULL,
						PRIMARY KEY (team, branch_key)
					) STRICT;
				`);
      // Hot path: load by team, ordered by recency. Used by the
      // ADR-134 dispatcher's per-tick sweep of in_progress /
      // ready_to_merge rows.
      db.exec(
        "CREATE INDEX idx_merger_state_team_updated ON merger_state(team, updated_at DESC)",
      );
      // Open-work index: dispatchers filter to non-terminal rows
      // every tick; partial-index keeps it small (terminal rows
      // stay forever for audit).
      db.exec(
        "CREATE INDEX idx_merger_state_open ON merger_state(team, state) WHERE state NOT IN ('merged','conflict','reverted')",
      );
    },
  },
];
