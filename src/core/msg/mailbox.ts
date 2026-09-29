// ADR-292: `atmux msg` mailbox — pure logic + SQLite store.
//
// `msg` rows live in the existing `inbox_messages` table (ADR-292 §D1,
// E1-T1 option (b)): writers set `kind='msg'` and carry the priority in
// `extra.priority`. No new table, no new columns, no `msg`-specific
// migration step (§D7 — the `kind` column already exists and readers
// tolerate unknown values).
//
// Per-reader ack state rides inside the `extra` JSON blob as
// `extra.acked_by` (reader name → ack epoch seconds, §D3 implementation
// note); per-reader cursors live in `state_kv` (feature `msg`, key
// `cursor:<reader>`, value = JSON epoch seconds).
//
// This module (and `src/verbs/msg.ts`) MUST NEVER import the pane-input
// injection surface from `src/abstractions/tmux.ts` — the wake is
// print-only (§D5). A unit test pins that boundary.

import { ensureDir, exists } from "../../abstractions/fs.ts";
import {
  closeDatabase,
  type Database,
  openDatabase,
  transactImmediate,
} from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import { stateDbPath } from "../common.ts";
import { appendInboxMessage } from "../inbox.ts";

/** `inbox_messages.kind` discriminator for mailbox rows (ADR-292 §D1). */
export const MSG_KIND = "msg";

/** `state_kv.feature` scoping per-reader msg cursors (ADR-292 §D3). */
export const MSG_CURSOR_FEATURE = "msg";

/** Priorities, most-urgent first (ADR-292 §D2). */
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type MsgPriority = (typeof PRIORITIES)[number];

/** Default send priority (ADR-292 OQ1 lean: `p2`). */
export const DEFAULT_MSG_PRIORITY: MsgPriority = "p2";

/** Default `check`/`read` threshold: `p3`, so everything surfaces unless
 *  filtered. (ADR-292 OQ1 leans "`--min p0` shows everything", but with
 *  p0-most-urgent ranking that token narrows to p0-only; the lean's
 *  *intent* — show everything — is `p3`. Noted in the lane report.) */
export const DEFAULT_MSG_MIN: MsgPriority = "p3";

/** True iff `s` is a `p0..p3` priority token. */
export function isPriority(s: string): s is MsgPriority {
  return (PRIORITIES as readonly string[]).includes(s);
}

/** Rank for ordering: `p0` (most urgent) = 0 … `p3` = 3. */
export function priorityRank(p: MsgPriority): number {
  return PRIORITIES.indexOf(p);
}

/** True iff `p` is at or above (at least as urgent as) `min`. */
export function meetsMin(p: MsgPriority, min: MsgPriority): boolean {
  return priorityRank(p) <= priorityRank(min);
}

/** Coerce an `extra.priority` blob value; garbage/missing → default `p2`. */
export function coercePriority(v: unknown): MsgPriority {
  return typeof v === "string" && isPriority(v) ? v : DEFAULT_MSG_PRIORITY;
}

/** `state_kv.key` for one reader's cursor. */
export function msgCursorKey(reader: string): string {
  return `cursor:${reader}`;
}

/** First line of `body`, capped at `max` chars with `…` on truncation. */
export function firstLine(body: string, max = 80): string {
  const line = body.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Format epoch seconds as `YYYY-MM-DD HH:MM MYT` (Asia/Kuala_Lumpur). */
export function formatMyt(epochSec: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochSec * 1000));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} MYT`;
}

// ---------- Cursors (state_kv) ----------

/**
 * Read one reader's cursor (epoch seconds). Returns `null` when the
 * team's `state.db` doesn't exist yet or the reader has never
 * read/acked — "never read" surfaces everything, mirroring the
 * driver-inbox absent-cursor posture.
 */
export async function readMsgCursor(atmuxDir: string, reader: string): Promise<number | null> {
  if (!(await exists(stateDbPath(atmuxDir)))) return null;
  let db: Database | null = null;
  try {
    db = openDatabase(stateDbPath(atmuxDir), migrations);
    const row = db
      .query("SELECT value FROM state_kv WHERE feature = ? AND key = ?")
      .get(MSG_CURSOR_FEATURE, msgCursorKey(reader)) as { value: string } | null;
    if (row === null) return null;
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  } finally {
    if (db !== null) closeDatabase(db);
  }
}

/** Persist one reader's cursor (epoch seconds). Creates `state.db` on first use. */
export async function writeMsgCursor(
  atmuxDir: string,
  reader: string,
  epochSec: number,
): Promise<void> {
  await ensureDir(atmuxDir);
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    db.query(
      `INSERT INTO state_kv (feature, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(feature, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(MSG_CURSOR_FEATURE, msgCursorKey(reader), JSON.stringify(epochSec), epochSec);
  } finally {
    closeDatabase(db);
  }
}

// ---------- Store (inbox_messages, kind='msg') ----------

/** Options for {@link sendMsg}. */
export interface SendMsgOpts {
  /** Recipient roster name — becomes the `inbox_messages.member` key. */
  to: string;
  /** Sender identity (free-form; `$ATMUX_MEMBER` or `--as` at the verb). */
  sender: string;
  /** Message body (free-form text). */
  body: string;
  /** Priority token; defaults to `p2` (ADR-292 OQ1 lean). */
  priority?: MsgPriority;
  /** Override timestamp (epoch seconds). Defaults to now. */
  ts?: number;
}

/** A decoded `kind='msg'` row. */
export interface MsgRecord {
  id: number;
  msgId: string | null;
  sender: string;
  body: string;
  ts: number;
  priority: MsgPriority;
  /** Per-reader ack epochs from `extra.acked_by` (ADR-292 §D3 note). */
  ackedBy: Record<string, number>;
}

/**
 * Append a `kind='msg'` row addressed to `to`. The stable pointer id is
 * deterministic (`m-<rowid>`) so send output is snapshot-pinnable.
 */
export async function sendMsg(
  atmuxDir: string,
  opts: SendMsgOpts,
): Promise<{ id: number; msgId: string }> {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const priority = opts.priority ?? DEFAULT_MSG_PRIORITY;
  const id = await appendInboxMessage(atmuxDir, {
    member: opts.to,
    sender: opts.sender,
    body: opts.body,
    kind: MSG_KIND,
    ts,
    extra: JSON.stringify({ priority }),
  });
  const msgId = `m-${id}`;
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    db.query("UPDATE inbox_messages SET msg_id = ? WHERE id = ?").run(msgId, id);
  } finally {
    closeDatabase(db);
  }
  return { id, msgId };
}

/** Decode one raw `inbox_messages` row into a {@link MsgRecord}. */
function decodeMsgRow(r: {
  id: number;
  msg_id: string | null;
  sender: string | null;
  body: string | null;
  ts: number;
  extra: string | null;
}): MsgRecord {
  let priority: MsgPriority = DEFAULT_MSG_PRIORITY;
  let ackedBy: Record<string, number> = {};
  if (r.extra !== null) {
    try {
      const extra: unknown = JSON.parse(r.extra);
      if (typeof extra === "object" && extra !== null) {
        const rec = extra as Record<string, unknown>;
        priority = coercePriority(rec.priority);
        if (typeof rec.acked_by === "object" && rec.acked_by !== null) {
          const entries = Object.entries(rec.acked_by as Record<string, unknown>);
          const clean: Record<string, number> = {};
          for (const [k, v] of entries) {
            if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
          }
          ackedBy = clean;
        }
      }
    } catch {
      // Legacy / hand-edited extra blob: default priority, no acks.
    }
  }
  return {
    id: r.id,
    msgId: r.msg_id,
    sender: r.sender ?? "",
    body: r.body ?? "",
    ts: r.ts,
    priority,
    ackedBy,
  };
}

/**
 * List every `kind='msg'` row for one recipient, oldest-first. Returns
 * `[]` when `state.db` doesn't exist (fresh team pre-first-write).
 */
export async function listMsg(atmuxDir: string, member: string): Promise<MsgRecord[]> {
  if (!(await exists(stateDbPath(atmuxDir)))) return [];
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const rows = db
      .query(
        `SELECT id, msg_id, sender, body, ts, extra
         FROM inbox_messages
         WHERE member = ? AND kind = ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(member, MSG_KIND) as Array<{
      id: number;
      msg_id: string | null;
      sender: string | null;
      body: string | null;
      ts: number;
      extra: string | null;
    }>;
    return rows.map(decodeMsgRow);
  } finally {
    closeDatabase(db);
  }
}

/** Latest `ts` across rows, or `null` when there are none. */
export function msgTipTs(rows: ReadonlyArray<MsgRecord>): number | null {
  let tip: number | null = null;
  for (const r of rows) {
    if (tip === null || r.ts > tip) tip = r.ts;
  }
  return tip;
}

/**
 * Resolve the effective cursor (epoch seconds). `--all` wins over
 * `--since` wins over the stored cursor; absent everything = 0 (epoch
 * start — every row is "after" it). Mirrors the driver-inbox
 * `--all > --since > stored` precedence (ADR-292 §D3).
 */
export function resolveEffectiveCursor(opts: {
  showAll: boolean;
  sinceEpoch?: number | undefined;
  stored: number | null;
}): number {
  if (opts.showAll) return 0;
  if (opts.sinceEpoch !== undefined) return opts.sinceEpoch;
  return opts.stored ?? 0;
}

/**
 * Rows after the cursor at or above `--min`, regardless of ack state —
 * the `read` view: full bodies with per-row ack columns.
 */
export function filterSince(
  rows: ReadonlyArray<MsgView>,
  opts: { cursor: number; min: MsgPriority },
): MsgView[] {
  return rows.filter((r) => r.ts > opts.cursor && meetsMin(r.priority, opts.min));
}

/**
 * Unread rows for one reader: the `read` view minus rows this reader
 * already acked — the `check` view driving the 0/1 exit contract.
 * Acked rows stay hidden even when `--since` rewinds past them:
 * per-row ack outlives the cursor (ADR-292 §D3).
 */
export function filterUnread(
  rows: ReadonlyArray<MsgView>,
  opts: { cursor: number; min: MsgPriority },
): MsgView[] {
  return filterSince(rows, opts).filter((r) => !r.acked);
}
/** One display row: the record plus this reader's ack state. */
export interface MsgView extends MsgRecord {
  /** True when this reader already acked the row (`extra.acked_by`). */
  acked: boolean;
  /** This reader's ack epoch, or `null` when unacked. */
  ackedAt: number | null;
}

/** Attach one reader's ack state to each row. */
export function withAckState(rows: ReadonlyArray<MsgRecord>, reader: string): MsgView[] {
  return rows.map((r) => {
    const ackedAt = r.ackedBy[reader];
    return { ...r, acked: ackedAt !== undefined, ackedAt: ackedAt ?? null };
  });
}

// ---------- Ack ----------

/**
 * Record one reader's ack over the given row ids (`extra.acked_by`
 * merge — other readers' acks are preserved) and advance the reader's
 * cursor to `tipTs`. Rows already carrying this reader's ack keep
 * their original epoch. The read-modify-write runs in ONE
 * `BEGIN IMMEDIATE` transaction so two concurrent `--ack` runs cannot
 * drop each other's `acked_by` entry, and every row is scoped to the
 * reader's own mailbox (`member = reader`, `kind = 'msg'`): an id from
 * another mailbox is ignored, never written.
 */
export async function ackMsgs(opts: {
  atmuxDir: string;
  reader: string;
  ids: ReadonlyArray<number>;
  tipTs: number;
  nowEpochSec: number;
}): Promise<void> {
  if (opts.ids.length === 0) return;
  const db = openDatabase(stateDbPath(opts.atmuxDir), migrations);
  try {
    transactImmediate(db, () => {
      for (const id of opts.ids) {
        const row = db
          .query("SELECT extra FROM inbox_messages WHERE id = ? AND member = ? AND kind = 'msg'")
          .get(id, opts.reader) as {
          extra: string | null;
        } | null;
        if (row === null) continue;
        let extra: Record<string, unknown> = {};
        if (row?.extra !== null && row?.extra !== undefined) {
          try {
            const parsed: unknown = JSON.parse(row.extra);
            if (typeof parsed === "object" && parsed !== null) {
              extra = parsed as Record<string, unknown>;
            }
          } catch {
            extra = {};
          }
        }
        const ackedBy =
          typeof extra.acked_by === "object" && extra.acked_by !== null
            ? { ...(extra.acked_by as Record<string, unknown>) }
            : {};
        if (typeof ackedBy[opts.reader] !== "number") {
          ackedBy[opts.reader] = opts.nowEpochSec;
        }
        extra.acked_by = ackedBy;
        db.query(
          "UPDATE inbox_messages SET extra = ? WHERE id = ? AND member = ? AND kind = 'msg'",
        ).run(JSON.stringify(extra), id, opts.reader);
      }
    });
  } finally {
    closeDatabase(db);
  }
  await writeMsgCursor(opts.atmuxDir, opts.reader, opts.tipTs);
}
