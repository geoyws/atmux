// Unit tests for src/core/inbox.ts — SQL-canonical inbox view.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { SUPERDOCTOR_INBOX_KEY } from "../../../src/core/common.ts";
import {
  appendInboxMessage,
  emptyInbox,
  loadInbox,
  loadInboxMessages,
} from "../../../src/core/inbox.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-inbox-"));
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

function seedTask(
  owner: string,
  id: string,
  status: "todo" | "in-progress" | "done",
  subject: string,
): void {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new KanbanRepo(db);
  repo.upsertTask({ id, subject, status, owner, deps: [] });
  closeDatabase(db);
}

describe("emptyInbox", () => {
  test("has empty pending/inProgress/done arrays", () => {
    expect(emptyInbox()).toEqual({ pending: [], inProgress: [], done: [] });
  });
});

describe("loadInbox", () => {
  test("returns empty buckets when state.db is absent", async () => {
    expect(await loadInbox(atmuxDir, "alpha")).toEqual(emptyInbox());
  });

  test("buckets member-owned tasks by status", async () => {
    seedTask("alpha", "t-aaaaaaaa", "todo", "pending-one");
    seedTask("alpha", "t-bbbbbbbb", "in-progress", "active-one");
    seedTask("alpha", "t-cccccccc", "done", "done-one");
    seedTask("bravo", "t-dddddddd", "in-progress", "other-member");

    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.pending.map((t) => t.id)).toEqual(["t-aaaaaaaa"]);
    expect(inbox.inProgress.map((t) => t.id)).toEqual(["t-bbbbbbbb"]);
    expect(inbox.done.map((t) => t.id)).toEqual(["t-cccccccc"]);
  });
});

describe("inbox_messages", () => {
  test("append + load round-trip", async () => {
    const id = await appendInboxMessage(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sender: "ifca-docs:cli",
      body: "heads-up ping",
      kind: "heads-up",
      ts: 1_700_000_000,
    });
    expect(id).toBeGreaterThan(0);
    const msgs = await loadInboxMessages(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
      sinceTs: 0,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.body).toBe("heads-up ping");
  });

  test("loadInboxMessages returns [] when state.db absent", async () => {
    const msgs = await loadInboxMessages(atmuxDir, {
      member: SUPERDOCTOR_INBOX_KEY,
    });
    expect(msgs).toEqual([]);
  });
});
