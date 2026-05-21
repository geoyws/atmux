// ADR-003 + ADR-005 + ADR-076: src/core/inbox.ts — per-member inbox view.
//
// **SQL-canonical (ADR-076 Phase 3 complete).** `loadInbox` queries the
// `tasks` table (filtered by `owner`) and buckets by status: `todo` →
// pending, `in-progress` → inProgress, `done` → done. Legacy
// `.atmux/inboxes/<member>.json` files are not read or written; use
// `atmux migrate-state json-to-sqlite --target=inboxes` once on any
// pre-cutover team, then `atmux cleanup inboxes` to delete leftovers.

import { join } from "node:path";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { type Inbox, type InboxEntry } from "../schema/inbox.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";

function _stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

/** SQL-backed loadInbox. Queries `tasks` table for member-owned rows
 *  and buckets by status. KanbanTask → InboxEntry is essentially identity
 *  (the schemas mirror each other per src/schema/inbox.ts header). */
function _loadInboxFromTasks(atmuxDir: string, member: string): Inbox {
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    const repo = new KanbanRepo(db);
    const tasks = repo.listTasks({ owner: member });
    const pending: InboxEntry[] = [];
    const inProgress: InboxEntry[] = [];
    const done: InboxEntry[] = [];
    for (const t of tasks) {
      const entry = t as unknown as InboxEntry;
      switch (t.status) {
        case "todo":
          pending.push(entry);
          break;
        case "in-progress":
          inProgress.push(entry);
          break;
        case "done":
          done.push(entry);
          break;
      }
    }
    return { pending, inProgress, done };
  } finally {
    closeDatabase(db);
  }
}

/** Empty `{pending,inProgress,done}` shape. */
export function emptyInbox(): Inbox {
  return { pending: [], inProgress: [], done: [] };
}

/**
 * Read-only inbox load from `state.db` tasks table.
 * Returns empty buckets when `state.db` is absent (fresh team pre-first-write).
 */
export async function loadInbox(atmuxDir: string, member: string): Promise<Inbox> {
  if (!(await exists(_stateDbPath(atmuxDir)))) {
    return emptyInbox();
  }
  return _loadInboxFromTasks(atmuxDir, member);
}

// ---------- ADR-077 §F3 / ADR-133: inbox_messages writer/reader ----------
//
// Distinct from the tasks-table inbox view above: the `inbox_messages`
// table is a row-per-message log used for cockpit-tier heads-up
// signals (e.g. members → medic — the role formerly named
// `superdoctor`; renamed per ADR-133, both inbox keys accepted during
// the one-release-cycle deprecation window).

/** Options for `appendInboxMessage`. */
export interface AppendInboxMessageOpts {
  member: string;
  sender: string;
  body: string;
  msgId?: string;
  kind?: string;
  ts?: number;
  extra?: string;
}

/**
 * Append a row to the `inbox_messages` table. Creates the team's
 * `state.db` (and runs migrations) if it doesn't exist yet.
 */
export async function appendInboxMessage(
  atmuxDir: string,
  opts: AppendInboxMessageOpts,
): Promise<number> {
  await ensureDir(atmuxDir);
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      `INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      opts.member,
      opts.msgId ?? null,
      opts.sender,
      opts.body,
      ts,
      opts.kind ?? "heads-up",
      opts.extra ?? null,
    );
    return Number(result.lastInsertRowid);
  } finally {
    closeDatabase(db);
  }
}

/** A single `inbox_messages` row (read-side shape). */
export interface InboxMessage {
  id: number;
  member: string;
  msgId: string | null;
  sender: string | null;
  body: string | null;
  ts: number;
  kind: string | null;
  extra: string | null;
}

/** Options for `loadInboxMessages`. */
export interface LoadInboxMessagesOpts {
  member: string;
  sinceTs?: number;
  limit?: number;
}

/** Read messages from the `inbox_messages` table for one inbox key. */
export async function loadInboxMessages(
  atmuxDir: string,
  opts: LoadInboxMessagesOpts,
): Promise<InboxMessage[]> {
  if (!(await exists(_stateDbPath(atmuxDir)))) return [];
  const db = openDatabase(_stateDbPath(atmuxDir), migrations);
  try {
    const limit = opts.limit ?? 1000;
    const sinceTs = opts.sinceTs ?? 0;
    const rows = db
      .query(
        `SELECT id, member, msg_id, sender, body, ts, kind, extra
         FROM inbox_messages
         WHERE member = ? AND ts > ?
         ORDER BY ts ASC
         LIMIT ?`,
      )
      .all(opts.member, sinceTs, limit) as Array<{
      id: number;
      member: string;
      msg_id: string | null;
      sender: string | null;
      body: string | null;
      ts: number;
      kind: string | null;
      extra: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      member: r.member,
      msgId: r.msg_id,
      sender: r.sender,
      body: r.body,
      ts: r.ts,
      kind: r.kind,
      extra: r.extra,
    }));
  } finally {
    closeDatabase(db);
  }
}
