// Unit tests for src/core/kanban.ts (ADR-003 + ADR-005).
// Bash spec refs: lib/kanban.sh, lib/claim.sh @ worktree-frozen.
//
// Strategy: real .atmux/ tmpdir per test. updateJson uses real flock
// + atomicWrite, so behaviour matches production end-to-end. genTaskId
// + nowEpoch are pure helpers — also covered with synthetic input.
//
// `setNow` from the time abstraction lets us pin epoch values for
// deterministic createdAt / claimedAt / completedAt assertions
// (memory: time abstraction is mockable per ADR-003).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetNow, setNow } from "../../../src/abstractions/time.ts";
import {
  addTask,
  assignTask,
  claimTask,
  emptyKanban,
  genTaskId,
  listTasks,
  loadKanban,
  markTaskDone,
  moveTask,
  nowEpoch,
  removeTask,
  showTask,
  unresolvedDeps,
} from "../../../src/core/kanban.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-kanban-"));
  resetNow();
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
  resetNow();
});

// ---------- Pure helpers ----------

describe("genTaskId — bash atmux::gen_id parity", () => {
  test("shape matches t-<8 hex chars>", () => {
    expect(genTaskId()).toMatch(/^t-[0-9a-f]{8}$/);
  });

  test("two calls return different ids (random)", () => {
    expect(genTaskId()).not.toBe(genTaskId());
  });
});

describe("nowEpoch — bash atmux::now_epoch parity", () => {
  test("returns floor(now() / 1000) — seconds, not ms", () => {
    setNow(() => 1_700_000_000_500); // 1700000000.5 sec
    expect(nowEpoch()).toBe(1_700_000_000);
  });

  test("respects setNow injection", () => {
    setNow(() => 42_000); // 42 seconds in ms
    expect(nowEpoch()).toBe(42);
  });
});

describe("emptyKanban — empty-shape factory", () => {
  test("has empty tasks/epics/stories arrays", () => {
    const k = emptyKanban();
    expect(k.tasks).toEqual([]);
    expect(k.epics).toEqual([]);
    expect(k.stories).toEqual([]);
  });
});

describe("unresolvedDeps — pure dep-check", () => {
  const t = (id: string, status: string, deps: string[] = []): KanbanTask => ({
    id,
    subject: id,
    status,
    deps,
  });

  test("no deps → empty array", () => {
    expect(unresolvedDeps([], t("a", "todo"))).toEqual([]);
  });

  test("all deps done → empty array", () => {
    const a = t("a", "done");
    const target = t("b", "todo", ["a"]);
    expect(unresolvedDeps([a, target], target)).toEqual([]);
  });

  test("one dep not-done → returned in array", () => {
    const a = t("a", "in-progress");
    const target = t("b", "todo", ["a"]);
    expect(unresolvedDeps([a, target], target)).toEqual(["a"]);
  });

  test("multiple deps mixed → only not-done in array", () => {
    const a = t("a", "done");
    const b = t("b", "todo");
    const c = t("c", "in-progress");
    const target = t("d", "todo", ["a", "b", "c"]);
    expect(unresolvedDeps([a, b, c, target], target)).toEqual(["b", "c"]);
  });

  test("unknown dep id → NOT counted (bash IN-only-known parity)", () => {
    const target = t("b", "todo", ["nonexistent"]);
    expect(unresolvedDeps([target], target)).toEqual([]);
  });
});

// ---------- loadKanban + addTask ----------

describe("loadKanban", () => {
  test("missing kanban.json → returns initial empty shape", async () => {
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toEqual([]);
  });

  test("existing valid kanban.json → returns parsed shape", async () => {
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        tasks: [
          {
            id: "t-12345678",
            subject: "x",
            status: "todo",
            deps: [],
          },
        ],
        epics: [],
        stories: [],
      }),
    );
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(1);
    expect(k.tasks[0]?.id).toBe("t-12345678");
  });
});

describe("addTask", () => {
  test("appends task with bash-shape id + createdAt", async () => {
    setNow(() => 1_700_000_000_000);
    const id = await addTask(atmuxDir, { subject: "first task" });
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);

    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(1);
    const task = k.tasks[0];
    expect(task?.id).toBe(id);
    expect(task?.subject).toBe("first task");
    expect(task?.status).toBe("todo");
    expect(task?.owner).toBeNull();
    expect(task?.deps).toEqual([]);
    expect(task?.priority).toBeNull();
    expect(task?.createdAt).toBe(1_700_000_000);
    expect(task?.claimedAt).toBeNull();
    expect(task?.completedAt).toBeNull();
  });

  test("respects assignee + body + deps + priority", async () => {
    const id = await addTask(atmuxDir, {
      subject: "with options",
      body: "details",
      assignee: "alpha",
      deps: ["t-aaaaaaaa"],
      priority: 1,
    });
    const k = await loadKanban(atmuxDir);
    const task = k.tasks.find((t) => t.id === id);
    expect(task?.body).toBe("details");
    expect(task?.owner).toBe("alpha");
    expect(task?.deps).toEqual(["t-aaaaaaaa"]);
    expect(task?.priority).toBe(1);
  });

  test("empty assignee string treated as null owner", async () => {
    const id = await addTask(atmuxDir, { subject: "x", assignee: "" });
    const task = (await loadKanban(atmuxDir)).tasks.find((t) => t.id === id);
    expect(task?.owner).toBeNull();
  });

  test("empty subject (after trim) → UsageError", async () => {
    await expect(addTask(atmuxDir, { subject: "  " })).rejects.toThrow(UsageError);
  });

  test("subject is trimmed", async () => {
    const id = await addTask(atmuxDir, { subject: "  spaced  " });
    const task = (await loadKanban(atmuxDir)).tasks.find((t) => t.id === id);
    expect(task?.subject).toBe("spaced");
  });

  test("appends to existing tasks (does not truncate)", async () => {
    const id1 = await addTask(atmuxDir, { subject: "one" });
    const id2 = await addTask(atmuxDir, { subject: "two" });
    expect(id1).not.toBe(id2);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(2);
  });
});

// ---------- listTasks + showTask ----------

describe("listTasks", () => {
  beforeEach(async () => {
    await addTask(atmuxDir, { subject: "todo-alpha", assignee: "alpha" });
    await addTask(atmuxDir, { subject: "todo-beta", assignee: "beta" });
    const id = await addTask(atmuxDir, { subject: "done-alpha", assignee: "alpha" });
    await moveTask(atmuxDir, id, "done");
  });

  test("no filter → all tasks", async () => {
    const all = await listTasks(atmuxDir);
    expect(all).toHaveLength(3);
  });

  test("status filter narrows", async () => {
    const todos = await listTasks(atmuxDir, { status: "todo" });
    expect(todos).toHaveLength(2);
    expect(todos.every((t) => t.status === "todo")).toBe(true);
  });

  test("assignee filter narrows", async () => {
    const alphas = await listTasks(atmuxDir, { assignee: "alpha" });
    expect(alphas).toHaveLength(2);
    expect(alphas.every((t) => t.owner === "alpha")).toBe(true);
  });

  test("status + assignee combined narrows further", async () => {
    const out = await listTasks(atmuxDir, { status: "done", assignee: "alpha" });
    expect(out).toHaveLength(1);
    expect(out[0]?.subject).toBe("done-alpha");
  });
});

describe("showTask", () => {
  test("returns the task on hit", async () => {
    const id = await addTask(atmuxDir, { subject: "hit" });
    const task = await showTask(atmuxDir, id);
    expect(task?.id).toBe(id);
  });

  test("returns null on miss", async () => {
    expect(await showTask(atmuxDir, "t-deadbeef")).toBeNull();
  });
});

// ---------- moveTask + assignTask + removeTask ----------

describe("moveTask", () => {
  test("transitions status without setting completedAt for non-done", async () => {
    setNow(() => 1_700_000_000_000);
    const id = await addTask(atmuxDir, { subject: "x" });
    await moveTask(atmuxDir, id, "in-progress");
    const task = await showTask(atmuxDir, id);
    expect(task?.status).toBe("in-progress");
    expect(task?.completedAt).toBeNull();
  });

  test("moving to 'done' stamps completedAt (bash conditional parity)", async () => {
    setNow(() => 1_700_000_000_000);
    const id = await addTask(atmuxDir, { subject: "x" });
    setNow(() => 1_700_000_999_000);
    await moveTask(atmuxDir, id, "done");
    const task = await showTask(atmuxDir, id);
    expect(task?.status).toBe("done");
    expect(task?.completedAt).toBe(1_700_000_999);
  });

  test("missing id → ConfigError", async () => {
    await expect(moveTask(atmuxDir, "t-missing0", "done")).rejects.toThrow(ConfigError);
  });
});

describe("assignTask", () => {
  test("updates owner", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await assignTask(atmuxDir, id, "alpha");
    const task = await showTask(atmuxDir, id);
    expect(task?.owner).toBe("alpha");
  });

  test("missing id → ConfigError", async () => {
    await expect(assignTask(atmuxDir, "t-missing0", "alpha")).rejects.toThrow(ConfigError);
  });
});

describe("removeTask", () => {
  test("removes the matching task only", async () => {
    const id1 = await addTask(atmuxDir, { subject: "keep" });
    const id2 = await addTask(atmuxDir, { subject: "remove" });
    await removeTask(atmuxDir, id2);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(1);
    expect(k.tasks[0]?.id).toBe(id1);
  });

  test("missing id → ConfigError", async () => {
    await expect(removeTask(atmuxDir, "t-missing0")).rejects.toThrow(ConfigError);
  });
});

// ---------- claimTask + markTaskDone (with deps) ----------

describe("claimTask — dep enforcement (bash claim.sh:42-50 parity)", () => {
  test("clean deps → claims successfully + sets owner/status/claimedAt", async () => {
    setNow(() => 1_700_000_000_000);
    const id = await addTask(atmuxDir, { subject: "x" });
    setNow(() => 1_700_000_111_000);
    const claimed = await claimTask(atmuxDir, id, "alpha");
    expect(claimed.owner).toBe("alpha");
    expect(claimed.status).toBe("in-progress");
    expect(claimed.claimedAt).toBe(1_700_000_111);
  });

  test("dep not done → ConfigError with unresolved id list", async () => {
    const depId = await addTask(atmuxDir, { subject: "dep" });
    const id = await addTask(atmuxDir, { subject: "x", deps: [depId] });
    await expect(claimTask(atmuxDir, id, "alpha")).rejects.toThrow(ConfigError);
  });

  test("dep done → claim succeeds", async () => {
    const depId = await addTask(atmuxDir, { subject: "dep" });
    await moveTask(atmuxDir, depId, "done");
    const id = await addTask(atmuxDir, { subject: "x", deps: [depId] });
    const claimed = await claimTask(atmuxDir, id, "alpha");
    expect(claimed.status).toBe("in-progress");
  });

  test("missing task id → ConfigError", async () => {
    await expect(claimTask(atmuxDir, "t-missing0", "alpha")).rejects.toThrow(ConfigError);
  });

  test("error message lists unresolved deps comma-separated", async () => {
    const dep1 = await addTask(atmuxDir, { subject: "d1" });
    const dep2 = await addTask(atmuxDir, { subject: "d2" });
    const id = await addTask(atmuxDir, { subject: "x", deps: [dep1, dep2] });
    try {
      await claimTask(atmuxDir, id, "alpha");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const ctx = (e as ConfigError).context as { what: string };
      expect(ctx.what).toContain("blocked by unresolved deps");
      expect(ctx.what).toContain(dep1);
      expect(ctx.what).toContain(dep2);
    }
  });
});

describe("markTaskDone", () => {
  test("sets status=done + completedAt; no deps check", async () => {
    setNow(() => 1_700_000_500_000);
    const id = await addTask(atmuxDir, { subject: "x" });
    const done = await markTaskDone(atmuxDir, id);
    expect(done.status).toBe("done");
    expect(done.completedAt).toBe(1_700_000_500);
  });

  test("optional note is persisted on the task", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const done = await markTaskDone(atmuxDir, id, "shipped clean");
    expect((done as { note?: string }).note).toBe("shipped clean");
  });

  test("missing id → ConfigError", async () => {
    await expect(markTaskDone(atmuxDir, "t-missing0")).rejects.toThrow(ConfigError);
  });
});
