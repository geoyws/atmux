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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetNow, setNow } from "../../../src/abstractions/time.ts";
import {
  addTask,
  assignTask,
  claimTask,
  emptyKanban,
  genTaskId,
  isDriverOnlyBlocked,
  listTasks,
  loadKanban,
  markTaskDone,
  moveTask,
  nowEpoch,
  removeTask,
  setTaskBody,
  setTaskDeps,
  setTaskDriverOnly,
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

// ADR-033 centralizing predicate — 2x2 over (driverOnly × scope) +
// legacy-default cell. Used by selectNextClaimable, claimTask, and
// (post t-a90c80b0) markTaskDone / task move.
describe("isDriverOnlyBlocked (ADR-033 predicate)", () => {
  test("driverOnly=true + scope='member' → blocked", () => {
    expect(isDriverOnlyBlocked({ driverOnly: true }, "member")).toBe(true);
  });

  test("driverOnly=true + scope='driver' → not blocked", () => {
    expect(isDriverOnlyBlocked({ driverOnly: true }, "driver")).toBe(false);
  });

  test("driverOnly=false + scope='member' → not blocked", () => {
    expect(isDriverOnlyBlocked({ driverOnly: false }, "member")).toBe(false);
  });

  test("driverOnly undefined (legacy Task) + scope='member' → not blocked", () => {
    expect(isDriverOnlyBlocked({}, "member")).toBe(false);
  });

  test("driverOnly=true + scope undefined (caller forgot to pass) → blocked (fail-secure)", () => {
    expect(isDriverOnlyBlocked({ driverOnly: true }, undefined)).toBe(true);
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

describe("setTaskBody", () => {
  test("updates body in place", async () => {
    const id = await addTask(atmuxDir, { subject: "x", body: "old body" });
    await setTaskBody(atmuxDir, id, "rewritten body — gates 2+3 reworded");
    const task = await showTask(atmuxDir, id);
    expect(task?.body).toBe("rewritten body — gates 2+3 reworded");
  });

  test("empty string clears body to null", async () => {
    const id = await addTask(atmuxDir, { subject: "x", body: "to be cleared" });
    await setTaskBody(atmuxDir, id, "");
    const task = await showTask(atmuxDir, id);
    expect(task?.body).toBeNull();
  });

  test("missing id → ConfigError", async () => {
    await expect(setTaskBody(atmuxDir, "t-missing0", "body")).rejects.toThrow(ConfigError);
  });
});

describe("setTaskDeps", () => {
  test("replaces deps list", async () => {
    const id = await addTask(atmuxDir, { subject: "x", deps: ["t-a", "t-b"] });
    await setTaskDeps(atmuxDir, id, ["t-c", "t-d", "t-e"]);
    const task = await showTask(atmuxDir, id);
    expect(task?.deps).toEqual(["t-c", "t-d", "t-e"]);
  });

  test("empty array clears all deps", async () => {
    const id = await addTask(atmuxDir, { subject: "x", deps: ["t-a"] });
    await setTaskDeps(atmuxDir, id, []);
    const task = await showTask(atmuxDir, id);
    expect(task?.deps).toEqual([]);
  });

  test("missing id → ConfigError", async () => {
    await expect(setTaskDeps(atmuxDir, "t-missing0", ["t-a"])).rejects.toThrow(ConfigError);
  });
});

describe("setTaskDriverOnly", () => {
  test("sets driverOnly=true on a task that didn't have the flag", async () => {
    const id = await addTask(atmuxDir, { subject: "park me" });
    await setTaskDriverOnly(atmuxDir, id, true);
    const task = await showTask(atmuxDir, id);
    expect(task?.driverOnly).toBe(true);
  });

  test("clearing back to false normalizes to undefined (omitted)", async () => {
    const id = await addTask(atmuxDir, { subject: "park then unpark", driverOnly: true });
    await setTaskDriverOnly(atmuxDir, id, false);
    const task = await showTask(atmuxDir, id);
    // Schema treats undefined/false as equivalent for the refuse-gate;
    // we normalize on write to keep the on-disk shape clean.
    expect(task?.driverOnly).toBeUndefined();
  });

  test("idempotent: re-setting true is a no-op (re-stamp tolerated)", async () => {
    const id = await addTask(atmuxDir, { subject: "x", driverOnly: true });
    await setTaskDriverOnly(atmuxDir, id, true);
    await setTaskDriverOnly(atmuxDir, id, true);
    const task = await showTask(atmuxDir, id);
    expect(task?.driverOnly).toBe(true);
  });

  test("missing id → ConfigError", async () => {
    await expect(setTaskDriverOnly(atmuxDir, "t-missing0", true)).rejects.toThrow(ConfigError);
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
    const { post } = await claimTask(atmuxDir, id, "alpha");
    expect(post.owner).toBe("alpha");
    expect(post.status).toBe("in-progress");
    expect(post.claimedAt).toBe(1_700_000_111);
  });

  test("returns pre-mutation snapshot — original task shape (ADR-029 §F1)", async () => {
    // Bash dispatch + claim capture `$task` BEFORE jq_update
    // (lib/dispatch.sh:39, lib/claim.sh:35); inbox entries carry the
    // ORIGINAL task shape, not owner/status/claimedAt-mutated post.
    // Verify claimTask exposes the pre-snapshot for the inbox-mirror
    // write to use.
    setNow(() => 1_700_000_000_000);
    const id = await addTask(atmuxDir, { subject: "y" });
    setNow(() => 1_700_000_222_000);
    const { pre, post } = await claimTask(atmuxDir, id, "alpha");
    // pre carries no owner/claimedAt — original todo shape
    expect(pre.owner).toBeFalsy();
    expect(pre.claimedAt).toBeFalsy();
    expect(pre.status === "todo" || pre.status === undefined).toBe(true);
    // post carries the mutated triple
    expect(post.owner).toBe("alpha");
    expect(post.status).toBe("in-progress");
    expect(post.claimedAt).toBe(1_700_000_222);
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
    const { post } = await claimTask(atmuxDir, id, "alpha");
    expect(post.status).toBe("in-progress");
  });

  test("missing task id → ConfigError", async () => {
    await expect(claimTask(atmuxDir, "t-missing0", "alpha")).rejects.toThrow(ConfigError);
  });

  // 2026-05-12 incident regression — JSON-path mirror. Gate lives on
  // `claimTaskForMember`, not bare `claimTask`.
  test("claimTaskForMember (JSON path): refuses if already in-progress under different owner", async () => {
    const { claimTaskForMember } = await import("../../../src/core/kanban.ts");
    const id = await addTask(atmuxDir, { subject: "race candidate" });
    await claimTaskForMember(atmuxDir, id, "alpha");
    await expect(claimTaskForMember(atmuxDir, id, "beta")).rejects.toThrow(
      /already in-progress under 'alpha'/,
    );
  });

  test("re-claim by SAME owner succeeds (idempotent / re-entrancy)", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await claimTask(atmuxDir, id, "alpha");
    const { post } = await claimTask(atmuxDir, id, "alpha");
    expect(post.owner).toBe("alpha");
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

  // t-381a6ea0: kanban-hygiene refuse-gate for done-state Tasks.
  // Origin incident: docs ran `atmux claim t-0c4e6397 --as docs` against
  // a done-state Task; the claim silently flipped done → in-progress with
  // no work performed. The 2026-05-12 in-progress race-gate explicitly
  // allowed "re-claiming a done task" as an idempotent path — that
  // tolerance was the bug. Gate fires INSIDE the transaction
  // (BEGIN IMMEDIATE in SQLite / updateJson under flock for JSON path)
  // so a concurrent done-flip can't slip between check + mutation.
  test("claimTask (JSON path): refuses done-state Task with clear error", async () => {
    setNow(() => 1_700_000_000_000);
    const id = await addTask(atmuxDir, { subject: "shipped already" });
    await claimTask(atmuxDir, id, "alpha");
    setNow(() => 1_700_000_500_000);
    await markTaskDone(atmuxDir, id, "shipped");
    setNow(() => 1_700_000_600_000);
    await expect(claimTask(atmuxDir, id, "beta")).rejects.toThrow(/already done.*claim refused/);
  });

  test("claimTask (JSON path): refused done-state claim does NOT mutate state", async () => {
    const id = await addTask(atmuxDir, { subject: "shipped already" });
    await claimTask(atmuxDir, id, "alpha");
    await markTaskDone(atmuxDir, id, "shipped");
    const before = await loadKanban(atmuxDir);
    const beforeTask = before.tasks.find((t) => t.id === id);
    await expect(claimTask(atmuxDir, id, "beta")).rejects.toThrow(ConfigError);
    const after = await loadKanban(atmuxDir);
    const afterTask = after.tasks.find((t) => t.id === id);
    expect(afterTask?.status).toBe("done");
    expect(afterTask?.owner).toBe(beforeTask?.owner);
    expect(afterTask?.claimedAt).toBe(beforeTask?.claimedAt);
    expect(afterTask?.completedAt).toBe(beforeTask?.completedAt);
  });

  test("claimTask (JSON path): refuse message cites task move recovery path + ISO completedAt + owner", async () => {
    const id = await addTask(atmuxDir, { subject: "shipped already" });
    await claimTask(atmuxDir, id, "alpha");
    setNow(() => 1_700_000_500_000);
    await markTaskDone(atmuxDir, id, "shipped");
    try {
      await claimTask(atmuxDir, id, "beta");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as ConfigError).message;
      // Recovery path discoverability per Task body + reviewer pre-flag.
      expect(msg).toContain(`atmux task move ${id} todo`);
      // ISO completedAt — operators correlate with audit fields.
      expect(msg).toContain("2023-11-14T22:21:40.000Z");
      // Owner inlined so the operator sees who held it without a second
      // lookup.
      expect(msg).toContain("owner=alpha");
    }
  });

  test("claimTask (JSON path): todo claim still succeeds (regression guard)", async () => {
    const id = await addTask(atmuxDir, { subject: "fresh" });
    const { post } = await claimTask(atmuxDir, id, "alpha");
    expect(post.status).toBe("in-progress");
    expect(post.owner).toBe("alpha");
  });

  test("claimTask (JSON path): in-progress unowned claim still succeeds (regression guard)", async () => {
    const id = await addTask(atmuxDir, { subject: "manually-set" });
    // Move to in-progress without setting owner — simulates a manual
    // `task move` path that didn't go through claim. The done-gate must
    // ONLY refuse status='done'; in-progress unowned remains claimable.
    await moveTask(atmuxDir, id, "in-progress");
    const { post } = await claimTask(atmuxDir, id, "alpha");
    expect(post.status).toBe("in-progress");
    expect(post.owner).toBe("alpha");
  });
});

describe("doneRefuseMessage — exported message-builder (t-381a6ea0)", () => {
  test("formats completedAt as ISO + inlines owner + cites recovery path", async () => {
    const { doneRefuseMessage } = await import("../../../src/core/kanban.ts");
    const msg = doneRefuseMessage({
      id: "t-deadbeef",
      subject: "x",
      status: "done",
      owner: "alpha",
      completedAt: 1_700_000_000, // 2023-11-14T22:13:20.000Z
      claimedAt: null,
      createdAt: 1_699_000_000,
      deps: [],
      priority: null,
      lane: null,
    });
    expect(msg).toContain("task t-deadbeef already done");
    expect(msg).toContain("owner=alpha");
    expect(msg).toContain("2023-11-14T22:13:20.000Z");
    expect(msg).toContain("atmux task move t-deadbeef todo");
  });

  test("missing completedAt renders 'unknown' (defensive — legacy rows)", async () => {
    const { doneRefuseMessage } = await import("../../../src/core/kanban.ts");
    const msg = doneRefuseMessage({
      id: "t-legacy01",
      subject: "x",
      status: "done",
      owner: "alpha",
      completedAt: null,
      claimedAt: null,
      createdAt: 1_699_000_000,
      deps: [],
      priority: null,
      lane: null,
    });
    expect(msg).toContain("completedAt=unknown");
  });

  test("missing owner renders 'unknown' (defensive — legacy rows)", async () => {
    const { doneRefuseMessage } = await import("../../../src/core/kanban.ts");
    const msg = doneRefuseMessage({
      id: "t-legacy02",
      subject: "x",
      status: "done",
      owner: null,
      completedAt: 1_700_000_000,
      claimedAt: null,
      createdAt: 1_699_000_000,
      deps: [],
      priority: null,
      lane: null,
    });
    expect(msg).toContain("owner=unknown");
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

// ---------- ADR-146 T2: trunk-merge auto-emit hook ----------

import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations as sqliteMigrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  resolveAutoEmitTrunkMergeConfig,
  tryAutoEmitTrunkMerge,
} from "../../../src/core/kanban.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import type { KanbanStory } from "../../../src/schema/kanban.ts";
import type { Team } from "../../../src/schema/team.ts";

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    name: "t",
    worktreeIsolation: true,
    members: [
      { name: "lead", role: "team-lead" },
      { name: "alpha", role: "member" },
      { name: "gitter", role: "gitter" },
    ],
    ...overrides,
  } as Team;
}

function stageStoryDb(): {
  db: ReturnType<typeof openDatabase>;
  repo: KanbanRepo;
} {
  const path = join(atmuxDir, "state.db");
  const db = openDatabase(path, sqliteMigrations);
  const repo = new KanbanRepo(db);
  return { db, repo };
}

function seedStory(repo: KanbanRepo, id: string, branch: string | null): KanbanStory {
  const story: KanbanStory = {
    id,
    epic: "e-test0001",
    title: `story ${id}`,
    body: null,
    acceptanceCriteria: null,
    status: "in-progress",
    createdAt: 1_700_000_000,
    completedAt: null,
    reviewSignoff: false,
    mergeTaskId: null,
    mergeMode: "feature-branch",
    branch,
  };
  repo.upsertStory(story);
  return story;
}

function seedTask(
  repo: KanbanRepo,
  id: string,
  story: string,
  status: string,
  subject = `task ${id}`,
  lane: string | null = "be",
): KanbanTask {
  const task: KanbanTask = {
    id,
    subject,
    body: "",
    status,
    owner: "alpha",
    deps: [],
    priority: null,
    lane,
    createdAt: 1_700_000_000,
    claimedAt: null,
    completedAt: status === "done" ? 1_700_000_100 : null,
    story,
  };
  repo.addTask(task);
  return task;
}

describe("resolveAutoEmitTrunkMergeConfig (ADR-146 §D7)", () => {
  test("absent block + worktreeIsolation=true → enabled defaults true", () => {
    const r = resolveAutoEmitTrunkMergeConfig(makeTeam());
    expect(r.enabled).toBe(true);
    expect(r.fallbackAssignee).toBeNull();
    expect(r.shortCircuitOnSharedBase).toBe(true);
  });

  test("absent block + worktreeIsolation=false → enabled defaults false", () => {
    const r = resolveAutoEmitTrunkMergeConfig(makeTeam({ worktreeIsolation: false }));
    expect(r.enabled).toBe(false);
  });

  test("explicit autoEmitTrunkMerge.enabled overrides default", () => {
    const r = resolveAutoEmitTrunkMergeConfig(
      makeTeam({
        worktreeIsolation: false,
        autoEmitTrunkMerge: { enabled: true },
      }),
    );
    expect(r.enabled).toBe(true);
  });

  test("fallbackAssignee + shortCircuitOnSharedBase override", () => {
    const r = resolveAutoEmitTrunkMergeConfig(
      makeTeam({
        autoEmitTrunkMerge: {
          fallbackAssignee: "manual-merger",
          shortCircuitOnSharedBase: false,
        },
      }),
    );
    expect(r.fallbackAssignee).toBe("manual-merger");
    expect(r.shortCircuitOnSharedBase).toBe(false);
  });
});

describe("tryAutoEmitTrunkMerge (ADR-146 §D1+D2+D5)", () => {
  test("happy path: last sibling done → auto-emit Task created", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0001", "geoyws-alpha");
      seedTask(repo, "t-sibling1", "s-aaaa0001", "done");
      const lastTask = seedTask(repo, "t-lastdone", "s-aaaa0001", "done");
      const newId = tryAutoEmitTrunkMerge(repo, lastTask, makeTeam());
      expect(newId).not.toBeNull();
      // The new Task lives in the kanban + has the §D2 shape.
      const created = repo.getTask(newId!);
      expect(created).not.toBeNull();
      expect(created!.subject).toMatch(
        /^merge t-[0-9a-f]+ \(branch→trunk\): geoyws-alpha → trunk$/,
      );
      expect(created!.owner).toBe("gitter");
      expect(created!.lane).toBe("misc");
      expect(created!.status).toBe("todo");
      // Body carries the §D2 YAML fields.
      expect(created!.body).toContain("source-branch: geoyws-alpha");
      expect(created!.body).toContain("target: trunk");
      expect(created!.body).toContain("auto-emitted: true");
      expect(created!.body).toContain("parent-story: s-aaaa0001");
    } finally {
      closeDatabase(db);
    }
  });

  test("short-circuit: Story.branch unset → no emit (returns null)", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0002", null);
      const lastTask = seedTask(repo, "t-nobranch", "s-aaaa0002", "done");
      const newId = tryAutoEmitTrunkMerge(repo, lastTask, makeTeam());
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("short-circuit: storyless task → no emit", () => {
    const { db, repo } = stageStoryDb();
    try {
      const task: KanbanTask = {
        id: "t-orphan01",
        subject: "orphan",
        body: "",
        status: "done",
        owner: "alpha",
        deps: [],
        priority: null,
        lane: "be",
        createdAt: 1,
        claimedAt: null,
        completedAt: 2,
      };
      repo.addTask(task);
      const newId = tryAutoEmitTrunkMerge(repo, task, makeTeam());
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("short-circuit: worktreeIsolation=false → no emit", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0003", "geoyws-alpha");
      const lastTask = seedTask(repo, "t-sharedcwd", "s-aaaa0003", "done");
      const newId = tryAutoEmitTrunkMerge(repo, lastTask, makeTeam({ worktreeIsolation: false }));
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("short-circuit: autoEmitTrunkMerge.enabled=false → no emit", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0004", "geoyws-alpha");
      const lastTask = seedTask(repo, "t-disabled", "s-aaaa0004", "done");
      const newId = tryAutoEmitTrunkMerge(
        repo,
        lastTask,
        makeTeam({ autoEmitTrunkMerge: { enabled: false } }),
      );
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("short-circuit: Story.branch === merger.baseBranch → no emit (sharedBase)", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0005", "geoyws");
      const lastTask = seedTask(repo, "t-onbase", "s-aaaa0005", "done");
      const newId = tryAutoEmitTrunkMerge(
        repo,
        lastTask,
        makeTeam({ merger: { enabled: true, baseBranch: "geoyws", stalenessHours: 24 } }),
      );
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("short-circuit: remaining non-done siblings → no emit", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0006", "geoyws-alpha");
      seedTask(repo, "t-still-wip", "s-aaaa0006", "in-progress");
      const lastTask = seedTask(repo, "t-justdone", "s-aaaa0006", "done");
      const newId = tryAutoEmitTrunkMerge(repo, lastTask, makeTeam());
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("loop-prevention: an auto-emit Task itself transitioning to done does NOT re-emit", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0007", "geoyws-alpha");
      // The done Task IS an auto-emit (subject matches the pattern).
      const autoEmitTask: KanbanTask = {
        id: "t-automerge",
        subject: "merge t-deadbeef (branch→trunk): geoyws-alpha → trunk",
        body: "auto-emitted: true",
        status: "done",
        owner: "gitter",
        deps: [],
        priority: null,
        lane: "misc",
        createdAt: 1,
        claimedAt: null,
        completedAt: 2,
        story: "s-aaaa0007",
      };
      repo.addTask(autoEmitTask);
      const newId = tryAutoEmitTrunkMerge(repo, autoEmitTask, makeTeam());
      expect(newId).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  test("fallback assignee fires when team has no gitter member", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0008", "geoyws-alpha");
      const lastTask = seedTask(repo, "t-nogitter", "s-aaaa0008", "done");
      const newId = tryAutoEmitTrunkMerge(
        repo,
        lastTask,
        makeTeam({
          members: [
            { name: "lead", role: "team-lead" },
            { name: "alpha", role: "member" },
          ],
          autoEmitTrunkMerge: {
            enabled: true,
            fallbackAssignee: "manual-merger",
          },
        }),
      );
      expect(newId).not.toBeNull();
      const created = repo.getTask(newId!);
      expect(created!.owner).toBe("manual-merger");
    } finally {
      closeDatabase(db);
    }
  });

  test("no gitter + no fallback → owner=null (unassigned)", () => {
    const { db, repo } = stageStoryDb();
    try {
      seedStory(repo, "s-aaaa0009", "geoyws-alpha");
      const lastTask = seedTask(repo, "t-unassigned", "s-aaaa0009", "done");
      const newId = tryAutoEmitTrunkMerge(
        repo,
        lastTask,
        makeTeam({
          members: [
            { name: "lead", role: "team-lead" },
            { name: "alpha", role: "member" },
          ],
        }),
      );
      expect(newId).not.toBeNull();
      const created = repo.getTask(newId!);
      expect(created!.owner).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});

describe("moveTask — ADR-146 auto-emit hook integration", () => {
  test("moving last sibling to done auto-files the trunk-merge Task in same transaction", async () => {
    // Stage a SQLite state.db with team.json so the auto-emit hook
    // fires through the canonical moveTask SQL path.
    const { db, repo } = stageStoryDb();
    seedStory(repo, "s-bbbb0001", "geoyws-alpha");
    seedTask(repo, "t-sib0001a", "s-bbbb0001", "done");
    const lastTaskId = "t-lastopen";
    seedTask(repo, lastTaskId, "s-bbbb0001", "in-progress");
    closeDatabase(db);
    // Stage team.json so tryLoadTeam picks it up.
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        worktreeIsolation: true,
        members: [
          { name: "lead", role: "team-lead" },
          { name: "alpha", role: "member" },
          { name: "gitter", role: "gitter" },
        ],
      }),
    );
    // Move the last open Task to done — the hook should fire.
    await moveTask(atmuxDir, lastTaskId, "done");
    const tasks = await listTasks(atmuxDir);
    // 3 tasks now: 2 seed + 1 auto-emit.
    expect(tasks.length).toBe(3);
    const autoEmit = tasks.find((t) =>
      /^merge t-[0-9a-f]+ \(branch→trunk\): geoyws-alpha → trunk$/.test(t.subject ?? ""),
    );
    expect(autoEmit).toBeDefined();
    expect(autoEmit!.owner).toBe("gitter");
    expect(autoEmit!.lane).toBe("misc");
    expect(autoEmit!.status).toBe("todo");
  });

  test("moving a sibling to done while others still in-progress does NOT auto-emit", async () => {
    const { db, repo } = stageStoryDb();
    seedStory(repo, "s-bbbb0002", "geoyws-alpha");
    seedTask(repo, "t-doneone", "s-bbbb0002", "in-progress");
    seedTask(repo, "t-stillwip", "s-bbbb0002", "in-progress");
    closeDatabase(db);
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        worktreeIsolation: true,
        members: [
          { name: "lead", role: "team-lead" },
          { name: "alpha", role: "member" },
          { name: "gitter", role: "gitter" },
        ],
      }),
    );
    await moveTask(atmuxDir, "t-doneone", "done");
    const tasks = await listTasks(atmuxDir);
    expect(tasks.length).toBe(2); // no auto-emit
  });

  test("missing team.json silently skips auto-emit (no throw)", async () => {
    const { db, repo } = stageStoryDb();
    seedStory(repo, "s-bbbb0003", "geoyws-alpha");
    const lastTaskId = "t-noteamjson";
    seedTask(repo, lastTaskId, "s-bbbb0003", "in-progress");
    closeDatabase(db);
    // No team.json staged.
    await moveTask(atmuxDir, lastTaskId, "done");
    const tasks = await listTasks(atmuxDir);
    expect(tasks.length).toBe(1); // auto-emit skipped silently
  });

  test("non-done transitions do NOT trigger auto-emit (todo / in-progress / blocked)", async () => {
    const { db, repo } = stageStoryDb();
    seedStory(repo, "s-bbbb0004", "geoyws-alpha");
    seedTask(repo, "t-stillwip2", "s-bbbb0004", "in-progress");
    closeDatabase(db);
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "demo",
        worktreeIsolation: true,
        members: [{ name: "alpha", role: "member" }],
      }),
    );
    await moveTask(atmuxDir, "t-stillwip2", "blocked");
    const tasks = await listTasks(atmuxDir);
    expect(tasks.length).toBe(1);
  });
});
