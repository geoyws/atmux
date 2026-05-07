// SQLite-mode tests for src/core/kanban.ts (ADR-060 dual-path refactor).
//
// Mirror of tests/unit/core/kanban.test.ts but with state.db pre-created
// before each test, so `_useSqlite()` returns true and the SQLite branch
// of every public function runs. JSON-mode coverage stays in
// kanban.test.ts; this file proves SQLite-mode behaviour matches.
//
// Strategy: per-test tmpdir as `.atmux/`. Open a SQLite DB with the
// canonical migration ladder so the schema exists before any kanban
// helper runs. Then exercise the same surface as kanban.test.ts —
// addTask / listTasks / showTask / moveTask / assignTask / removeTask
// / claimTask / markTaskDone / loadKanban — and assert the same
// observable semantics.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  addTask,
  assignTask,
  claimTask,
  listTasks,
  loadKanban,
  markTaskDone,
  moveTask,
  removeTask,
  showTask,
} from "../../../src/core/kanban.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";

interface TestEnv {
  atmuxDir: string;
}

async function makeEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), "atmux-kanban-sqlite-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  // Pre-create state.db so the dual-path router picks SQLite.
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  return { atmuxDir };
}

async function teardown(env: TestEnv): Promise<void> {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
}

describe("kanban (SQLite mode)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  test("addTask + showTask round-trip", async () => {
    const id = await addTask(env.atmuxDir, { subject: "first task" });
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);

    const t = await showTask(env.atmuxDir, id);
    expect(t).not.toBeNull();
    expect(t?.subject).toBe("first task");
    expect(t?.status).toBe("todo");
    expect(t?.owner).toBeNull();
  });

  test("addTask: empty subject throws UsageError", async () => {
    await expect(addTask(env.atmuxDir, { subject: "   " })).rejects.toThrow(UsageError);
  });

  test("addTask: assignee + body + deps + priority", async () => {
    const dep = await addTask(env.atmuxDir, { subject: "dep task" });
    const id = await addTask(env.atmuxDir, {
      subject: "main task",
      body: "the body",
      assignee: "fe0",
      deps: [dep],
      priority: 5,
    });

    const t = await showTask(env.atmuxDir, id);
    expect(t?.subject).toBe("main task");
    expect(t?.body).toBe("the body");
    expect(t?.owner).toBe("fe0");
    expect(t?.deps).toEqual([dep]);
    expect(t?.priority).toBe(5);
  });

  test("listTasks + filters", async () => {
    const a = await addTask(env.atmuxDir, { subject: "a", assignee: "fe0" });
    await addTask(env.atmuxDir, { subject: "b", assignee: "fe1" });
    await moveTask(env.atmuxDir, a, "in-progress");

    const all = await listTasks(env.atmuxDir);
    expect(all.length).toBe(2);

    const inProgress = await listTasks(env.atmuxDir, { status: "in-progress" });
    expect(inProgress.length).toBe(1);
    expect(inProgress[0]?.id).toBe(a);

    const fe0Tasks = await listTasks(env.atmuxDir, { assignee: "fe0" });
    expect(fe0Tasks.length).toBe(1);
    expect(fe0Tasks[0]?.id).toBe(a);
  });

  test("showTask: miss returns null", async () => {
    const t = await showTask(env.atmuxDir, "t-deadbeef");
    expect(t).toBeNull();
  });

  test("moveTask: status=done stamps completedAt; other statuses don't", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x" });

    await moveTask(env.atmuxDir, id, "in-progress");
    let t = await showTask(env.atmuxDir, id);
    expect(t?.status).toBe("in-progress");
    expect(t?.completedAt).toBeNull();

    await moveTask(env.atmuxDir, id, "done");
    t = await showTask(env.atmuxDir, id);
    expect(t?.status).toBe("done");
    expect(typeof t?.completedAt).toBe("number");
    expect(t?.completedAt).toBeGreaterThan(0);
  });

  test("moveTask: missing id throws ConfigError", async () => {
    await expect(moveTask(env.atmuxDir, "t-deadbeef", "done")).rejects.toThrow(ConfigError);
  });

  test("assignTask: change owner", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x" });
    await assignTask(env.atmuxDir, id, "fe0");
    const t = await showTask(env.atmuxDir, id);
    expect(t?.owner).toBe("fe0");
  });

  test("assignTask: missing id throws ConfigError", async () => {
    await expect(assignTask(env.atmuxDir, "t-deadbeef", "fe0")).rejects.toThrow(ConfigError);
  });

  test("removeTask: deletes by id", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x" });
    await removeTask(env.atmuxDir, id);
    const t = await showTask(env.atmuxDir, id);
    expect(t).toBeNull();
  });

  test("removeTask: missing id throws ConfigError", async () => {
    await expect(removeTask(env.atmuxDir, "t-deadbeef")).rejects.toThrow(ConfigError);
  });

  test("claimTask: clean claim with no deps", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x" });
    const { pre, post } = await claimTask(env.atmuxDir, id, "fe0");
    expect(pre.owner).toBeNull();
    expect(pre.status).toBe("todo");
    expect(post.owner).toBe("fe0");
    expect(post.status).toBe("in-progress");
    expect(typeof post.claimedAt).toBe("number");

    const persisted = await showTask(env.atmuxDir, id);
    expect(persisted?.owner).toBe("fe0");
    expect(persisted?.status).toBe("in-progress");
  });

  test("claimTask: blocked by unresolved deps throws ConfigError", async () => {
    const dep = await addTask(env.atmuxDir, { subject: "dep" });
    const main = await addTask(env.atmuxDir, { subject: "main", deps: [dep] });

    await expect(claimTask(env.atmuxDir, main, "fe0")).rejects.toThrow(
      /blocked by unresolved deps/,
    );

    // After dep is done, claim succeeds.
    await markTaskDone(env.atmuxDir, dep);
    const { post } = await claimTask(env.atmuxDir, main, "fe0");
    expect(post.status).toBe("in-progress");
  });

  test("claimTask: missing id throws ConfigError", async () => {
    await expect(claimTask(env.atmuxDir, "t-deadbeef", "fe0")).rejects.toThrow(ConfigError);
  });

  test("markTaskDone: stamps completedAt + optional note", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x" });
    const done = await markTaskDone(env.atmuxDir, id, "shipped via PR #42");
    expect(done.status).toBe("done");
    expect(typeof done.completedAt).toBe("number");
    expect((done as { note?: string }).note).toBe("shipped via PR #42");

    const persisted = await showTask(env.atmuxDir, id);
    expect(persisted?.status).toBe("done");
  });

  test("markTaskDone: no note", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x" });
    const done = await markTaskDone(env.atmuxDir, id);
    expect(done.status).toBe("done");
    // Schema is `note: z.string().nullable().optional()` — both null
    // (SQLite mode, NULL column) and undefined (JSON mode, key absent)
    // mean "not set". Accept either; reject any actual string.
    const note = (done as { note?: string | null }).note;
    expect(note === null || note === undefined).toBe(true);
  });

  test("markTaskDone: missing id throws ConfigError", async () => {
    await expect(markTaskDone(env.atmuxDir, "t-deadbeef")).rejects.toThrow(ConfigError);
  });

  test("loadKanban: returns full snapshot in SQLite mode", async () => {
    await addTask(env.atmuxDir, { subject: "a" });
    await addTask(env.atmuxDir, { subject: "b" });
    const k = await loadKanban(env.atmuxDir);
    expect(k.tasks.length).toBe(2);
    expect(k.epics).toEqual([]);
    expect(k.stories).toEqual([]);
  });
});
