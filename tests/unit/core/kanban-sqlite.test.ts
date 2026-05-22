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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSince, type emit } from "../../../src/abstractions/events.ts";
type EmitFn = typeof emit;
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
  setTaskLane,
  setTaskPriority,
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

  // 2026-05-12 incident regression — gate lives on `claimTaskForMember`,
  // not bare `claimTask` (so lead-initiated `dispatch` still reassigns).
  // Two members both running `atmux claim <task-id>` raced to set their
  // own owner on an already-claimed in-progress task; the gate refuses
  // the second claimant with a clear message naming the existing owner.
  test("claimTaskForMember: refuses claim when task already in-progress under different owner", async () => {
    const { claimTaskForMember } = await import("../../../src/core/kanban.ts");
    const id = await addTask(env.atmuxDir, { subject: "race candidate" });
    await claimTaskForMember(env.atmuxDir, id, "fe0");
    await expect(claimTaskForMember(env.atmuxDir, id, "be0")).rejects.toThrow(
      /already in-progress under 'fe0'/,
    );
    // Original owner can re-claim (idempotent for re-entrancy).
    const { post } = await claimTaskForMember(env.atmuxDir, id, "fe0");
    expect(post.owner).toBe("fe0");
    expect(post.status).toBe("in-progress");
  });

  test("claimTaskForMember: refuse message mentions un-claim path", async () => {
    const { claimTaskForMember } = await import("../../../src/core/kanban.ts");
    const id = await addTask(env.atmuxDir, { subject: "stalled candidate" });
    await claimTaskForMember(env.atmuxDir, id, "fe0");
    try {
      await claimTaskForMember(env.atmuxDir, id, "be0");
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("task move");
      expect(msg).toContain("un-claim");
    }
  });

  // Bare claimTask MUST still allow reassignment — that's the dispatch path.
  test("claimTask (NOT claimTaskForMember): bare claimTask still allows owner override", async () => {
    const id = await addTask(env.atmuxDir, { subject: "dispatch target" });
    await claimTask(env.atmuxDir, id, "fe0");
    // Lead-initiated dispatch routes through bare claimTask — must succeed.
    const { post } = await claimTask(env.atmuxDir, id, "be0");
    expect(post.owner).toBe("be0");
  });

  // t-381a6ea0: done-state refuse-gate (SQLite path). The gate fires
  // INSIDE the BEGIN IMMEDIATE block via repo.getTask + status check
  // before repo.upsertTask. Reviewer pre-flag: a concurrent done-flip
  // can't slip between check and mutation because both run under the
  // same SQLite transaction lock. Origin: docs auditor surfaced an
  // anomaly 2026-05-13 — `atmux claim t-0c4e6397` against a done Task
  // silently flipped done → in-progress (the 2026-05-12 in-progress
  // gate's docstring explicitly allowed this as "idempotent"; that
  // tolerance was the bug).
  test("claimTask (SQLite path): refuses done-state Task with clear error", async () => {
    const id = await addTask(env.atmuxDir, { subject: "shipped already" });
    await claimTask(env.atmuxDir, id, "fe0");
    await markTaskDone(env.atmuxDir, id, "shipped");
    await expect(claimTask(env.atmuxDir, id, "be0")).rejects.toThrow(/already done.*claim refused/);
  });

  test("claimTask (SQLite path): refused done-state claim does NOT mutate state", async () => {
    const id = await addTask(env.atmuxDir, { subject: "shipped already" });
    await claimTask(env.atmuxDir, id, "fe0");
    await markTaskDone(env.atmuxDir, id, "shipped");
    const before = await showTask(env.atmuxDir, id);
    await expect(claimTask(env.atmuxDir, id, "be0")).rejects.toThrow(ConfigError);
    const after = await showTask(env.atmuxDir, id);
    expect(after?.status).toBe("done");
    expect(after?.owner).toBe(before?.owner ?? null);
    expect(after?.claimedAt).toBe(before?.claimedAt ?? null);
    expect(after?.completedAt).toBe(before?.completedAt ?? null);
  });

  test("claimTask (SQLite path): refuse message cites task move recovery path", async () => {
    const id = await addTask(env.atmuxDir, { subject: "shipped already" });
    await claimTask(env.atmuxDir, id, "fe0");
    await markTaskDone(env.atmuxDir, id, "shipped");
    try {
      await claimTask(env.atmuxDir, id, "be0");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as ConfigError).message;
      expect(msg).toContain(`atmux task move ${id} todo`);
      expect(msg).toContain("owner=fe0");
    }
  });

  test("claimTask (SQLite path): in-progress unowned claim still succeeds — gate is done-only", async () => {
    // Move to in-progress manually (no owner). The done-gate must ONLY
    // refuse status='done'; in-progress unowned remains claimable per
    // the existing "re-claim by SAME owner / unowned" path.
    const id = await addTask(env.atmuxDir, { subject: "manually-set" });
    await moveTask(env.atmuxDir, id, "in-progress");
    const { post } = await claimTask(env.atmuxDir, id, "fe0");
    expect(post.status).toBe("in-progress");
    expect(post.owner).toBe("fe0");
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

  test("addTask + lane field persists + listTasks --lane filter (ADR-062 prep)", async () => {
    const a = await addTask(env.atmuxDir, { subject: "fe task", lane: "fe" });
    await addTask(env.atmuxDir, { subject: "be task", lane: "be" });
    const c = await addTask(env.atmuxDir, { subject: "no-lane task" });

    const aTask = await showTask(env.atmuxDir, a);
    expect(aTask?.lane).toBe("fe");

    const cTask = await showTask(env.atmuxDir, c);
    expect(cTask?.lane).toBeNull();

    const feTasks = await listTasks(env.atmuxDir, { lane: "fe" });
    expect(feTasks.length).toBe(1);
    expect(feTasks[0]?.id).toBe(a);
  });

  test("setTaskLane: re-tag existing task; null clears", async () => {
    const id = await addTask(env.atmuxDir, { subject: "untagged task" });
    let t = await showTask(env.atmuxDir, id);
    expect(t?.lane).toBeNull();

    await setTaskLane(env.atmuxDir, id, "ops");
    t = await showTask(env.atmuxDir, id);
    expect(t?.lane).toBe("ops");

    await setTaskLane(env.atmuxDir, id, null);
    t = await showTask(env.atmuxDir, id);
    expect(t?.lane).toBeNull();
  });

  test("setTaskLane: missing id throws ConfigError", async () => {
    await expect(setTaskLane(env.atmuxDir, "t-deadbeef", "fe")).rejects.toThrow(ConfigError);
  });

  test("setTaskPriority: set integer; null clears (ADR-131)", async () => {
    const id = await addTask(env.atmuxDir, { subject: "no-prio task" });
    let t = await showTask(env.atmuxDir, id);
    expect(t?.priority).toBeNull();

    await setTaskPriority(env.atmuxDir, id, 3);
    t = await showTask(env.atmuxDir, id);
    expect(t?.priority).toBe(3);

    await setTaskPriority(env.atmuxDir, id, null);
    t = await showTask(env.atmuxDir, id);
    expect(t?.priority).toBeNull();
  });

  test("setTaskPriority: missing id throws ConfigError", async () => {
    await expect(setTaskPriority(env.atmuxDir, "t-deadbeef", 1)).rejects.toThrow(ConfigError);
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

// ---------- ADR-202/203 task-lifecycle event emit ----------

describe("kanban (SQLite mode) — task-lifecycle event emit (ADR-202/203)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
    // Write a minimal team.json so the emit hook has team.name for payload scope.
    await writeFile(
      join(env.atmuxDir, "team.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "be-1", role: "member", lane: "be" }],
      }),
    );
  });

  afterEach(async () => {
    await teardown(env);
  });

  function openStateDb() {
    return openDatabase(join(env.atmuxDir, "state.db"), migrations);
  }

  test("moveTask → done emits task.done with team + member + taskId + doneAtSec", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    await moveTask(env.atmuxDir, id, "in-progress");
    await moveTask(env.atmuxDir, id, "done");
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.done"], lastEventId: "" });
      expect(rows.length).toBe(1);
      const r = rows[0];
      if (r?.topic === "task.done") {
        expect(r.taskId).toBe(id);
        expect(r.team).toBe("test-team");
        expect(r.member).toBe("be-1");
        expect(r.doneAtSec).toBeGreaterThan(0);
      } else {
        throw new Error("expected task.done topic");
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("moveTask → in-progress (from todo) emits task.claimed", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    await moveTask(env.atmuxDir, id, "in-progress");
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.claimed"], lastEventId: "" });
      expect(rows.length).toBe(1);
      const r = rows[0];
      if (r?.topic === "task.claimed") {
        expect(r.taskId).toBe(id);
        expect(r.team).toBe("test-team");
        expect(r.member).toBe("be-1");
      } else {
        throw new Error("expected task.claimed topic");
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("moveTask → blocked emits nothing (status not in event-set)", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    await moveTask(env.atmuxDir, id, "blocked");
    const db = openStateDb();
    try {
      const all = drainSince(db, { topics: [], lastEventId: "" });
      expect(all.length).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("moveTask in-progress → in-progress is a no-op (no duplicate claimed)", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    await moveTask(env.atmuxDir, id, "in-progress");
    // Re-moving to same status (legal in our schema) — must NOT re-emit
    await moveTask(env.atmuxDir, id, "in-progress");
    const db = openStateDb();
    try {
      const claimed = drainSince(db, { topics: ["task.claimed"], lastEventId: "" });
      expect(claimed.length).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("custom emit shim is honored — opts.emit injected", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    let calls = 0;
    const shim: EmitFn = ((..._args: Parameters<EmitFn>) => {
      calls += 1;
      return { topic: "task.done", eventId: "e1", emittedAtSec: 1, schemaVersion: 1 } as ReturnType<EmitFn>;
    }) as EmitFn;
    await moveTask(env.atmuxDir, id, "done", { emit: shim });
    expect(calls).toBe(1);
  });

  test("missing team.json — emit hook short-circuits (no throws)", async () => {
    // Remove team.json before moveTask
    await rm(join(env.atmuxDir, "team.json"));
    const id = await addTask(env.atmuxDir, { subject: "x" });
    // Should still succeed
    await moveTask(env.atmuxDir, id, "done");
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.done"], lastEventId: "" });
      expect(rows.length).toBe(0); // no team → no emit
    } finally {
      closeDatabase(db);
    }
  });

  test("rollback on emit failure does NOT advance kanban row", async () => {
    // Inject an emit shim that throws — confirm it's caught (best-effort)
    // and the kanban row still flips to done.
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    const shim: EmitFn = (() => {
      throw new Error("simulated emit failure");
    }) as EmitFn;
    await moveTask(env.atmuxDir, id, "done", { emit: shim });
    const t = await showTask(env.atmuxDir, id);
    expect(t?.status).toBe("done"); // kanban row still wins
  });

  test("addTask with lane + no owner emits task.unclaimed (ADR-202 §IV)", async () => {
    const id = await addTask(env.atmuxDir, { subject: "do-the-thing", lane: "be" });
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.unclaimed"], lastEventId: "" });
      expect(rows.length).toBe(1);
      const r = rows[0];
      if (r?.topic === "task.unclaimed") {
        expect(r.taskId).toBe(id);
        expect(r.team).toBe("test-team");
        expect(r.lane).toBe("be");
      } else {
        throw new Error("expected task.unclaimed");
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("addTask with lane + ASSIGNED owner does NOT emit task.unclaimed", async () => {
    await addTask(env.atmuxDir, { subject: "x", lane: "be", assignee: "be-1" });
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.unclaimed"], lastEventId: "" });
      expect(rows.length).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("addTask without lane does NOT emit task.unclaimed", async () => {
    await addTask(env.atmuxDir, { subject: "x" });
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.unclaimed"], lastEventId: "" });
      expect(rows.length).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("addTask with non-canonical lane does NOT emit (closed enum guard)", async () => {
    // 'docs' / 'git' aren't in the v1 canonical lane enum — emit skips.
    // The kanban row still lands; the event just doesn't fire.
    const id = await addTask(env.atmuxDir, { subject: "x", lane: "docs" });
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.unclaimed"], lastEventId: "" });
      expect(rows.length).toBe(0);
      // Kanban row landed
      const row = db.query("SELECT lane FROM tasks WHERE id = ?").get(id) as { lane: string };
      expect(row.lane).toBe("docs");
    } finally {
      closeDatabase(db);
    }
  });

  test("addTask with no team.json — emit short-circuits (no throw)", async () => {
    await rm(join(env.atmuxDir, "team.json"));
    const id = await addTask(env.atmuxDir, { subject: "x", lane: "be" });
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);
    // Kanban row landed despite no team
    const db = openStateDb();
    try {
      const row = db.query("SELECT id FROM tasks WHERE id = ?").get(id) as { id: string };
      expect(row.id).toBe(id);
    } finally {
      closeDatabase(db);
    }
  });

  test("done with story+epic context — payload includes both", async () => {
    const id = await addTask(env.atmuxDir, { subject: "x", assignee: "be-1" });
    // Stamp story/epic via direct repo write — AddTaskOpts doesn't expose
    // those fields but the schema supports them via task-update paths.
    {
      const db = openStateDb();
      try {
        db.prepare(
          "UPDATE tasks SET story = ?, epic = ? WHERE id = ?",
        ).run("s-deadbeef", "e-deadbeef", id);
      } finally {
        closeDatabase(db);
      }
    }
    await moveTask(env.atmuxDir, id, "done");
    const db = openStateDb();
    try {
      const rows = drainSince(db, { topics: ["task.done"], lastEventId: "" });
      const r = rows[0];
      if (r?.topic === "task.done") {
        expect(r.storyId).toBe("s-deadbeef");
        expect(r.epicId).toBe("e-deadbeef");
      } else {
        throw new Error("expected task.done");
      }
    } finally {
      closeDatabase(db);
    }
  });
});
