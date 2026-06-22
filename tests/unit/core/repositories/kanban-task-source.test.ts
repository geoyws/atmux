// ADR-263 §D3 repo round-trip — tasks.source_kind + tasks.source_id +
// the dedup lookups. Pins the SQLite ↔ Zod boundary for the two columns
// added in sqlite-migrations v16→v17 and the partial-unique index that
// keys the issue-sync dedup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import { KanbanRepo } from "../../../../src/core/repositories/kanban-repo.ts";
import type { KanbanTask } from "../../../../src/schema/kanban.ts";

let scratch: string;
let db: Database;
let repo: KanbanRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-task-source-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new KanbanRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

function sourcedTask(over: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t-src-1",
    subject: "Bug from upstream",
    body: "body",
    status: "todo",
    owner: null,
    deps: [],
    priority: null,
    lane: null,
    createdAt: 100,
    claimedAt: null,
    completedAt: null,
    sourceKind: "github",
    sourceId: "github:o/r#1",
    ...over,
  };
}

describe("source_kind / source_id round-trip", () => {
  test("addTask + getTask preserves provenance fields", () => {
    repo.addTask(sourcedTask());
    const t = repo.getTask("t-src-1");
    expect(t?.sourceKind).toBe("github");
    expect(t?.sourceId).toBe("github:o/r#1");
  });

  test("a manual task (no source) round-trips with null provenance", () => {
    repo.addTask({
      id: "t-manual",
      subject: "manual",
      status: "todo",
      deps: [],
      createdAt: 1,
    } as KanbanTask);
    const t = repo.getTask("t-manual");
    expect(t?.sourceKind ?? null).toBeNull();
    expect(t?.sourceId ?? null).toBeNull();
  });

  test("upsertTask updates provenance + survives a status flip", () => {
    repo.addTask(sourcedTask());
    repo.upsertTask(sourcedTask({ status: "done", completedAt: 999 }));
    const t = repo.getTask("t-src-1");
    expect(t?.status).toBe("done");
    expect(t?.sourceId).toBe("github:o/r#1");
  });
});

describe("getTaskBySourceId", () => {
  test("finds a task by its external identity", () => {
    repo.addTask(sourcedTask());
    expect(repo.getTaskBySourceId("github:o/r#1")?.id).toBe("t-src-1");
  });
  test("returns null for an unknown identity", () => {
    expect(repo.getTaskBySourceId("github:o/r#404")).toBeNull();
  });
});

describe("listTasksBySourcePrefix", () => {
  test("lists tasks under a scope prefix, in createdAt order", () => {
    repo.addTask(sourcedTask({ id: "t-a", sourceId: "github:o/r#1", createdAt: 100 }));
    repo.addTask(sourcedTask({ id: "t-b", sourceId: "github:o/r#2", createdAt: 200 }));
    repo.addTask(sourcedTask({ id: "t-c", sourceId: "github:other/repo#1", createdAt: 300 }));
    const got = repo.listTasksBySourcePrefix("github:o/r#");
    expect(got.map((t) => t.id)).toEqual(["t-a", "t-b"]);
  });
});

describe("dedup unique index", () => {
  test("two tasks cannot share a non-null source_id", () => {
    repo.addTask(sourcedTask({ id: "t-1", sourceId: "github:o/r#1" }));
    expect(() => repo.addTask(sourcedTask({ id: "t-2", sourceId: "github:o/r#1" }))).toThrow();
  });

  test("the partial index does NOT constrain NULL source_id (many manual tasks)", () => {
    repo.addTask({
      id: "t-m1",
      subject: "m1",
      status: "todo",
      deps: [],
      createdAt: 1,
    } as KanbanTask);
    repo.addTask({
      id: "t-m2",
      subject: "m2",
      status: "todo",
      deps: [],
      createdAt: 2,
    } as KanbanTask);
    expect(repo.listTasks()).toHaveLength(2);
  });
});
