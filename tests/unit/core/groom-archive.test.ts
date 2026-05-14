// Unit tests for src/core/groom-archive.ts (t-8287b37d C1).
//
// Coverage:
//   - groomArchive: no-op when state.db absent
//   - empty state.db / no qualifying rows → zero moved
//   - done tasks > cutoff archived; recent done untouched; non-done untouched
//   - inbox_messages > cutoff archived
//   - idempotency: re-run is a no-op (rows already moved)
//   - dry-run: counts surfaced, no mutations
//   - archive.db schema materializes on first call (same migrations)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { exists } from "../../../src/abstractions/fs.ts";
import {
  archiveDbPath,
  groomArchive,
  stateDbPath,
} from "../../../src/core/groom-archive.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";

let atmuxDir: string;

beforeEach(async () => {
  const teamDir = await mkdtemp(join(tmpdir(), "atmux-groom-archive-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(join(atmuxDir, ".."), { recursive: true, force: true });
});

const ONE_DAY = 86400;
const NOW_MS = Date.UTC(2026, 4, 14, 12, 0, 0); // 2026-05-14T12:00:00Z
const NOW_SEC = Math.floor(NOW_MS / 1000);

// ---------- helpers ----------

function seedTask(
  atmuxDir_: string,
  opts: { id: string; status: string; completedAt?: number },
): void {
  const db = openDatabase(stateDbPath(atmuxDir_), migrations);
  try {
    const repo = new KanbanRepo(db);
    repo.addTask({
      id: opts.id,
      subject: opts.id,
      body: null,
      status: opts.status,
      owner: null,
      deps: [],
      priority: null,
      epic: null,
      story: null,
      lane: null,
      deliverable: null,
      staleMin: null,
      driverOnly: false,
      createdAt: NOW_SEC - 365 * ONE_DAY,
      claimedAt: null,
      completedAt: opts.completedAt ?? null,
      claimedFrom: null,
      createdFrom: null,
      note: null,
    });
  } finally {
    closeDatabase(db);
  }
}

function seedInboxMessage(
  atmuxDir_: string,
  opts: { member: string; body: string; ts: number },
): void {
  const db = openDatabase(stateDbPath(atmuxDir_), migrations);
  try {
    db.exec(
      `INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra)
       VALUES ('${opts.member}', NULL, NULL, '${opts.body.replace(/'/g, "''")}', ${opts.ts}, NULL, NULL)`,
    );
  } finally {
    closeDatabase(db);
  }
}

function countMainAndArchive(atmuxDir_: string, table: string): {
  main: number;
  archive: number;
} {
  let main = 0;
  let archive = 0;
  const db = openDatabase(stateDbPath(atmuxDir_), migrations);
  try {
    main = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    closeDatabase(db);
  }
  const adb = openDatabase(archiveDbPath(atmuxDir_), migrations);
  try {
    archive = (adb.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    closeDatabase(adb);
  }
  return { main, archive };
}

// ---------- tests ----------

describe("groomArchive — preflight", () => {
  test("no-op when state.db absent", async () => {
    // Fresh atmuxDir, no state.db created.
    const r = await groomArchive(atmuxDir, { nowMs: NOW_MS });
    expect(r.tasksArchived).toBe(0);
    expect(r.inboxArchived).toBe(0);
    // archive.db should NOT have been created (preflight check returns early).
    expect(await exists(archiveDbPath(atmuxDir))).toBe(false);
  });
});

describe("groomArchive — tasks", () => {
  test("done + completed older than cutoff → archived; state.db cleared of them", async () => {
    seedTask(atmuxDir, {
      id: "t-old-done",
      status: "done",
      completedAt: NOW_SEC - 60 * ONE_DAY, // 60d ago
    });
    seedTask(atmuxDir, {
      id: "t-recent-done",
      status: "done",
      completedAt: NOW_SEC - 7 * ONE_DAY, // 7d ago, NOT > 30d cutoff
    });
    seedTask(atmuxDir, {
      id: "t-todo",
      status: "todo",
      completedAt: undefined,
    });

    const r = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r.tasksArchived).toBe(1);
    expect(r.inboxArchived).toBe(0);

    const counts = countMainAndArchive(atmuxDir, "tasks");
    expect(counts.main).toBe(2); // recent-done + todo still in main
    expect(counts.archive).toBe(1); // old-done moved
  });

  test("done with NULL completed_at → not archived (no cutoff signal)", async () => {
    seedTask(atmuxDir, {
      id: "t-null-completed",
      status: "done",
      completedAt: undefined,
    });
    const r = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r.tasksArchived).toBe(0);
    const counts = countMainAndArchive(atmuxDir, "tasks");
    expect(counts.main).toBe(1);
    expect(counts.archive).toBe(0);
  });

  test("blocked / cancelled / todo with old completed_at → not archived (status filter)", async () => {
    seedTask(atmuxDir, {
      id: "t-blocked-old",
      status: "blocked",
      completedAt: NOW_SEC - 60 * ONE_DAY,
    });
    seedTask(atmuxDir, {
      id: "t-cancelled-old",
      status: "cancelled",
      completedAt: NOW_SEC - 60 * ONE_DAY,
    });
    const r = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r.tasksArchived).toBe(0);
    const counts = countMainAndArchive(atmuxDir, "tasks");
    expect(counts.main).toBe(2);
    expect(counts.archive).toBe(0);
  });
});

describe("groomArchive — inbox_messages", () => {
  test("older than cutoff → archived; recent untouched", async () => {
    // Need to materialize state.db first; seedTask does that as a
    // side-effect, but we want a pure inbox test. Use seedTask to
    // create the file then add inbox rows.
    seedTask(atmuxDir, { id: "t-anchor", status: "todo", completedAt: undefined });
    seedInboxMessage(atmuxDir, {
      member: "alpha",
      body: "old msg",
      ts: NOW_SEC - 60 * ONE_DAY,
    });
    seedInboxMessage(atmuxDir, {
      member: "alpha",
      body: "recent msg",
      ts: NOW_SEC - 7 * ONE_DAY,
    });
    const r = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r.inboxArchived).toBe(1);
    const counts = countMainAndArchive(atmuxDir, "inbox_messages");
    expect(counts.main).toBe(1);
    expect(counts.archive).toBe(1);
  });
});

describe("groomArchive — idempotency", () => {
  test("re-run on a settled cluster moves zero rows", async () => {
    seedTask(atmuxDir, {
      id: "t-old-done",
      status: "done",
      completedAt: NOW_SEC - 60 * ONE_DAY,
    });
    const r1 = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r1.tasksArchived).toBe(1);
    const r2 = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r2.tasksArchived).toBe(0);
    expect(r2.inboxArchived).toBe(0);
  });
});

describe("groomArchive — dry-run", () => {
  test("counts surfaced, no mutations", async () => {
    seedTask(atmuxDir, {
      id: "t-old-done-1",
      status: "done",
      completedAt: NOW_SEC - 60 * ONE_DAY,
    });
    seedTask(atmuxDir, {
      id: "t-old-done-2",
      status: "done",
      completedAt: NOW_SEC - 90 * ONE_DAY,
    });
    seedInboxMessage(atmuxDir, {
      member: "alpha",
      body: "old",
      ts: NOW_SEC - 60 * ONE_DAY,
    });

    const r = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS, dryRun: true });
    expect(r.tasksArchived).toBe(2);
    expect(r.inboxArchived).toBe(1);

    // Verify nothing actually moved.
    const taskCounts = countMainAndArchive(atmuxDir, "tasks");
    expect(taskCounts.main).toBe(2);
    expect(taskCounts.archive).toBe(0);
    const inboxCounts = countMainAndArchive(atmuxDir, "inbox_messages");
    expect(inboxCounts.main).toBe(1);
    expect(inboxCounts.archive).toBe(0);
  });
});

describe("groomArchive — archive.db schema", () => {
  test("first call materializes archive.db at latest user_version", async () => {
    seedTask(atmuxDir, {
      id: "t-trigger",
      status: "done",
      completedAt: NOW_SEC - 60 * ONE_DAY,
    });
    await groomArchive(atmuxDir, { nowMs: NOW_MS });
    expect(await exists(archiveDbPath(atmuxDir))).toBe(true);
    const adb = openDatabase(archiveDbPath(atmuxDir), migrations);
    try {
      const v = (adb.query("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      expect(v).toBeGreaterThanOrEqual(3);
      const tables = adb
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = new Set(tables.map((t) => t.name));
      expect(names.has("tasks")).toBe(true);
      expect(names.has("inbox_messages")).toBe(true);
      expect(names.has("complaints")).toBe(true);
    } finally {
      closeDatabase(adb);
    }
  });

  test("cutoffEpoch returned reflects the days option", async () => {
    seedTask(atmuxDir, { id: "t-anchor", status: "todo" });
    const r = await groomArchive(atmuxDir, { days: 30, nowMs: NOW_MS });
    expect(r.cutoffEpoch).toBe(NOW_SEC - 30 * ONE_DAY);
  });
});
