// Unit tests for src/core/msg/* (ADR-292 mailbox over inbox_messages).
//
// Run with `env -u TMUX bun test tests/unit/core/msg.test.ts` — the
// `env -u TMUX` prefix keeps the runner off the live cockpit socket.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase, readUserVersion } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { appendInboxMessage } from "../../../src/core/inbox.ts";
import {
  ackMsgs,
  coercePriority,
  DEFAULT_MSG_MIN,
  DEFAULT_MSG_PRIORITY,
  filterSince,
  filterUnread,
  firstLine,
  formatMyt,
  isPriority,
  listMsg,
  MSG_CURSOR_FEATURE,
  MSG_KIND,
  type MsgRecord,
  meetsMin,
  msgCursorKey,
  msgTipTs,
  priorityRank,
  readMsgCursor,
  resolveEffectiveCursor,
  sendMsg,
  withAckState,
  writeMsgCursor,
} from "../../../src/core/msg/index.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-msg-core-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Priorities ----------

describe("priorities", () => {
  test("isPriority accepts p0..p3 only", () => {
    expect(isPriority("p0")).toBe(true);
    expect(isPriority("p3")).toBe(true);
    expect(isPriority("p4")).toBe(false);
    expect(isPriority("")).toBe(false);
    expect(isPriority("P0")).toBe(false);
  });

  test("rank orders p0 first", () => {
    expect(priorityRank("p0")).toBeLessThan(priorityRank("p3"));
  });

  test("meetsMin: urgent passes lax thresholds", () => {
    expect(meetsMin("p0", "p0")).toBe(true);
    expect(meetsMin("p0", "p3")).toBe(true);
    expect(meetsMin("p3", "p0")).toBe(false);
    expect(meetsMin("p2", "p1")).toBe(false);
    expect(meetsMin("p1", "p2")).toBe(true);
  });

  test("coercePriority falls back to the default", () => {
    expect(coercePriority("p1")).toBe("p1");
    expect(coercePriority("p9")).toBe(DEFAULT_MSG_PRIORITY);
    expect(coercePriority(null)).toBe(DEFAULT_MSG_PRIORITY);
    expect(coercePriority(2)).toBe(DEFAULT_MSG_PRIORITY);
    expect(DEFAULT_MSG_PRIORITY).toBe("p2");
    // p0-most-urgent ranking ⇒ the show-everything default is p3.
    expect(DEFAULT_MSG_MIN).toBe("p3");
  });

  test("cursor key namespaces the reader", () => {
    expect(msgCursorKey("driver-2")).toBe("cursor:driver-2");
    expect(MSG_CURSOR_FEATURE).toBe("msg");
    expect(MSG_KIND).toBe("msg");
  });
});

// ---------- Formatting ----------

describe("formatting", () => {
  test("firstLine takes the head line and caps length", () => {
    expect(firstLine("one\ntwo")).toBe("one");
    expect(firstLine("short")).toBe("short");
    const long = "x".repeat(100);
    expect(firstLine(long)).toBe(`${"x".repeat(80)}…`);
    expect(firstLine("")).toBe("");
  });

  test("formatMyt renders Asia/Kuala_Lumpur wall time", () => {
    // Epoch 0 predates Malaysia's 1982 shift from +7:30 to +8:00, so
    // 07:30 is historically correct, not a bug.
    expect(formatMyt(0)).toBe("1970-01-01 07:30 MYT");
    expect(formatMyt(1788393600)).toBe("2026-09-03 08:00 MYT");
    expect(formatMyt(1756858800)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} MYT$/);
  });
});

// ---------- Cursors ----------

describe("readMsgCursor / writeMsgCursor", () => {
  test("absent state.db → null", async () => {
    expect(await readMsgCursor(atmuxDir, "r")).toBeNull();
  });

  test("round-trips and overwrites", async () => {
    expect(await readMsgCursor(atmuxDir, "r")).toBeNull();
    await writeMsgCursor(atmuxDir, "r", 100);
    expect(await readMsgCursor(atmuxDir, "r")).toBe(100);
    await writeMsgCursor(atmuxDir, "r", 200);
    expect(await readMsgCursor(atmuxDir, "r")).toBe(200);
  });

  test("readers are independent", async () => {
    await writeMsgCursor(atmuxDir, "a", 10);
    expect(await readMsgCursor(atmuxDir, "b")).toBeNull();
  });

  test("non-numeric / negative cursor blobs read as null", async () => {
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      db.query("INSERT INTO state_kv (feature, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
        MSG_CURSOR_FEATURE,
        msgCursorKey("s"),
        '"oops"',
        1,
      );
      db.query("INSERT INTO state_kv (feature, key, value, updated_at) VALUES (?, ?, ?, ?)").run(
        MSG_CURSOR_FEATURE,
        msgCursorKey("n"),
        "-5",
        1,
      );
    } finally {
      closeDatabase(db);
    }
    expect(await readMsgCursor(atmuxDir, "s")).toBeNull();
    expect(await readMsgCursor(atmuxDir, "n")).toBeNull();
  });

  test("unopenable state.db reads as null", async () => {
    await mkdir(join(atmuxDir, "state.db"), { recursive: true });
    expect(await readMsgCursor(atmuxDir, "r")).toBeNull();
  });
});

// ---------- Store ----------

describe("sendMsg / listMsg", () => {
  test("fresh team lists nothing", async () => {
    expect(await listMsg(atmuxDir, "driver-2")).toEqual([]);
  });

  test("round-trip uses deterministic m-<rowid> pointer ids", async () => {
    const { id, msgId } = await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "prod deploy wedged",
      priority: "p0",
      ts: 1000,
    });
    expect(msgId).toBe(`m-${id}`);
    const rows = await listMsg(atmuxDir, "driver-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      msgId,
      sender: "driver",
      body: "prod deploy wedged",
      ts: 1000,
      priority: "p0",
      ackedBy: {},
    });
  });

  test("send defaults to p2", async () => {
    await sendMsg(atmuxDir, { to: "d2", sender: "d", body: "b", ts: 10 });
    expect((await listMsg(atmuxDir, "d2"))[0]?.priority).toBe("p2");
  });

  test("rows are per-recipient, oldest-first, and ignore other kinds", async () => {
    await sendMsg(atmuxDir, { to: "b", sender: "a", body: "second", ts: 20 });
    await sendMsg(atmuxDir, { to: "b", sender: "a", body: "first", ts: 10 });
    await sendMsg(atmuxDir, { to: "other", sender: "a", body: "elsewhere", ts: 5 });
    await appendInboxMessage(atmuxDir, {
      member: "b",
      sender: "a",
      body: "medic heads-up",
      kind: "heads-up",
      ts: 15,
    });
    const rows = await listMsg(atmuxDir, "b");
    expect(rows.map((r) => r.body)).toEqual(["first", "second"]);
  });

  test("legacy / corrupt extra blobs decode to safe defaults", async () => {
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const insert = db.prepare(
        "INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insert.run("b", null, null, null, 1, MSG_KIND, null);
      insert.run("b", null, "a", "garbage", 2, MSG_KIND, "not-json{{{");
      insert.run("b", null, "a", "str-blob", 3, MSG_KIND, '"just-a-string"');
      insert.run(
        "b",
        null,
        "a",
        "typed-garbage",
        4,
        MSG_KIND,
        JSON.stringify({ priority: "p9", acked_by: { r: "when?", ok: 7 } }),
      );
    } finally {
      closeDatabase(db);
    }
    const rows = await listMsg(atmuxDir, "b");
    expect(rows.map((r) => r.priority)).toEqual(["p2", "p2", "p2", "p2"]);
    expect(rows[0]).toMatchObject({ sender: "", body: "", ackedBy: {} });
    expect(rows[3]?.ackedBy).toEqual({ ok: 7 });
  });

  test("msgTipTs takes the max, null when empty", () => {
    expect(msgTipTs([])).toBeNull();
    const rows = [{ ts: 5 }, { ts: 9 }, { ts: 7 }] as MsgRecord[];
    expect(msgTipTs(rows)).toBe(9);
  });
});

// ---------- Cursor precedence + unread ----------

describe("resolveEffectiveCursor", () => {
  test("--all wins over --since wins over stored", () => {
    expect(resolveEffectiveCursor({ showAll: true, sinceEpoch: 5, stored: 9 })).toBe(0);
    expect(resolveEffectiveCursor({ showAll: false, sinceEpoch: 5, stored: 9 })).toBe(5);
    expect(resolveEffectiveCursor({ showAll: false, stored: 9 })).toBe(9);
    expect(resolveEffectiveCursor({ showAll: false, stored: null })).toBe(0);
  });
});

describe("withAckState / filterSince / filterUnread", () => {
  const rows: MsgRecord[] = [
    { id: 1, msgId: "m-1", sender: "a", body: "x", ts: 10, priority: "p0", ackedBy: { me: 11 } },
    { id: 2, msgId: "m-2", sender: "a", body: "y", ts: 20, priority: "p2", ackedBy: {} },
    { id: 3, msgId: "m-3", sender: "a", body: "z", ts: 30, priority: "p3", ackedBy: {} },
  ];

  test("withAckState attaches this reader's ack", () => {
    const views = withAckState(rows, "me");
    expect(views[0]).toMatchObject({ acked: true, ackedAt: 11 });
    expect(views[1]).toMatchObject({ acked: false, ackedAt: null });
    expect(withAckState(rows, "other")[0]).toMatchObject({ acked: false, ackedAt: null });
  });

  test("filterSince keeps cursor+min matches regardless of ack", () => {
    const views = withAckState(rows, "me");
    expect(filterSince(views, { cursor: 0, min: "p3" }).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(filterSince(views, { cursor: 15, min: "p3" }).map((r) => r.id)).toEqual([2, 3]);
    expect(filterSince(views, { cursor: 0, min: "p2" }).map((r) => r.id)).toEqual([1, 2]);
    expect(filterSince(views, { cursor: 0, min: "p0" }).map((r) => r.id)).toEqual([1]);
  });

  test("filterUnread additionally hides acked rows", () => {
    const views = withAckState(rows, "me");
    expect(filterUnread(views, { cursor: 0, min: "p3" }).map((r) => r.id)).toEqual([2, 3]);
    expect(filterUnread(views, { cursor: 25, min: "p3" }).map((r) => r.id)).toEqual([3]);
  });
});

// ---------- Ack ----------

describe("ackMsgs", () => {
  test("empty ids: no cursor written", async () => {
    await ackMsgs({ atmuxDir, reader: "r", ids: [], tipTs: 99, nowEpochSec: 99 });
    expect(await readMsgCursor(atmuxDir, "r")).toBeNull();
  });

  test("acks merge per-reader and advance the cursor", async () => {
    const a = await sendMsg(atmuxDir, { to: "b", sender: "a", body: "one", ts: 10 });
    const b = await sendMsg(atmuxDir, { to: "b", sender: "a", body: "two", ts: 20 });
    await ackMsgs({ atmuxDir, reader: "b", ids: [a.id], tipTs: 20, nowEpochSec: 42 });
    let rows = await listMsg(atmuxDir, "b");
    expect(rows.find((r) => r.id === a.id)?.ackedBy).toEqual({ b: 42 });
    expect(rows.find((r) => r.id === b.id)?.ackedBy).toEqual({});
    expect(await readMsgCursor(atmuxDir, "b")).toBe(20);

    // Re-ack keeps the original epoch. An id from another mailbox is
    // never written: reader `c` cannot ack a row addressed to `b`.
    await ackMsgs({ atmuxDir, reader: "c", ids: [a.id], tipTs: 20, nowEpochSec: 50 });
    await ackMsgs({ atmuxDir, reader: "b", ids: [a.id], tipTs: 20, nowEpochSec: 60 });
    rows = await listMsg(atmuxDir, "b");
    expect(rows.find((r) => r.id === a.id)?.ackedBy).toEqual({ b: 42 });
  });

  test("acks never touch another mailbox's rows or non-msg rows", async () => {
    const mine = await sendMsg(atmuxDir, { to: "b", sender: "a", body: "mine", ts: 10 });
    const theirs = await sendMsg(atmuxDir, { to: "z", sender: "a", body: "theirs", ts: 11 });
    await ackMsgs({ atmuxDir, reader: "b", ids: [mine.id, theirs.id], tipTs: 11, nowEpochSec: 5 });
    expect((await listMsg(atmuxDir, "b"))[0]?.ackedBy).toEqual({ b: 5 });
    expect((await listMsg(atmuxDir, "z"))[0]?.ackedBy).toEqual({});
  });

  test("corrupt / null / non-object extra still records the ack", async () => {
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    let ids: number[] = [];
    try {
      const insert = db.prepare(
        "INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      ids = [
        Number(insert.run("b", null, "a", "nullex", 1, MSG_KIND, null).lastInsertRowid),
        Number(insert.run("b", null, "a", "badex", 2, MSG_KIND, "{{{").lastInsertRowid),
        Number(
          insert.run("b", null, "a", "strex", 3, MSG_KIND, JSON.stringify({ acked_by: "nope" }))
            .lastInsertRowid,
        ),
      ];
    } finally {
      closeDatabase(db);
    }
    await ackMsgs({ atmuxDir, reader: "b", ids, tipTs: 3, nowEpochSec: 7 });
    const rows = await listMsg(atmuxDir, "b");
    for (const r of rows) expect(r.ackedBy).toEqual({ b: 7 });
  });
});

// ---------- Migration idempotency on a pre-E1 state.db ----------

describe("pre-E1 state.db upgrade", () => {
  /** Faithful v1 db: runs the real v0→v1 migration, then pins
   *  user_version=1 — exactly what a pre-E1 cage carries. */
  const seedPreE1 = (path: string): void => {
    const db = new Database(path, { create: true });
    try {
      for (const m of migrations) {
        if (m.from === 0) m.up(db);
      }
      db.exec("PRAGMA user_version = 1");
      db.query(
        "INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("__medic__", "h-1", "driver", "legacy heads-up", 50, "heads-up", null);
    } finally {
      db.close();
    }
  };

  test("opening twice upgrades once, preserves rows, and serves msg", async () => {
    const path = join(atmuxDir, "state.db");
    seedPreE1(path);
    const latest = migrations.at(-1)?.to ?? -1;
    expect(latest).toBeGreaterThan(1);

    const first = openDatabase(path, migrations);
    const v1 = readUserVersion(first);
    closeDatabase(first);
    const second = openDatabase(path, migrations);
    const v2 = readUserVersion(second);
    closeDatabase(second);

    expect(v1).toBe(latest);
    expect(v2).toBe(latest);

    // Legacy medic row survived the upgrade untouched.
    const db = openDatabase(path, migrations);
    try {
      const row = db
        .query("SELECT body, kind FROM inbox_messages WHERE member = ?")
        .get("__medic__") as { body: string; kind: string };
      expect(row).toMatchObject({ body: "legacy heads-up", kind: "heads-up" });
    } finally {
      closeDatabase(db);
    }

    // And the msg surface works on the upgraded db.
    await sendMsg(atmuxDir, { to: "b", sender: "a", body: "post-upgrade", ts: 100 });
    expect((await listMsg(atmuxDir, "b")).map((r) => r.body)).toEqual(["post-upgrade"]);
  });
});
