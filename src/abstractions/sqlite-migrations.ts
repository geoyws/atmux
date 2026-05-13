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
  // ADR-077 §D5 / §F2: per-team complaint box. The durable artifact of
  // superdoctor's diagnosis loop — one row per anomaly with root cause
  // + preventive ask. Stored per-team (each `<team>/.atmux/state.db`
  // holds its own complaints) per ADR-077 §Open.
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
  // `source_kind` (superdoctor/member/operator/cli/cron) + structured
  // `source_id` give a queryable replacement for the free-form
  // `opened_by` text field; `target_team` distinguishes the team a
  // complaint is ABOUT from the team's state.db it happens to live
  // in (needed once superdoctor files cross-team).
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
];
