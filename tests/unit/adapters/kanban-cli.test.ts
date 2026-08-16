import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanCliAdapter } from "../../../src/adapters/kanban-cli.ts";
import {
  addEpic as coreAddEpic,
  advanceEpic as coreAdvanceEpic,
  listEpics as coreListEpics,
  setEpicReady as coreSetEpicReady,
  showEpic as coreShowEpic,
} from "../../../src/core/epic.ts";
import {
  addTask as coreAddTask,
  assignTask as coreAssignTask,
  claimTask as coreClaimTask,
  listTasks as coreListTasks,
  loadKanban as coreLoadKanban,
  markTaskDone as coreMarkTaskDone,
  setTaskDeps as coreSetTaskDeps,
  setTaskDriverOnly as coreSetTaskDriverOnly,
  setTaskEpic as coreSetTaskEpic,
  setTaskLane as coreSetTaskLane,
  setTaskStory as coreSetTaskStory,
  showTask as coreShowTask,
} from "../../../src/core/kanban.ts";
import {
  addStory as coreAddStory,
  listStories as coreListStories,
  showStory as coreShowStory,
  updateStory as coreUpdateStory,
} from "../../../src/core/story.ts";

const roots: string[] = [];

afterEach(() => {
  delete process.env.ATMUX_KANBAN_BACKEND;
  delete process.env.KANBAN_DATA_DIR;
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; atmuxDir: string; adapter: KanbanCliAdapter } {
  const root = mkdtempSync(join(tmpdir(), "atmux-kanban-adapter-"));
  roots.push(root);
  const atmuxDir = join(root, ".atmux");
  mkdirSync(atmuxDir);
  return {
    root,
    atmuxDir,
    adapter: new KanbanCliAdapter({
      env: { KANBAN_DATA_DIR: join(root, "private-kanban") },
    }),
  };
}

describe("external Kanban CLI adapter", () => {
  test("initializes and round-trips task lifecycle through the installed command", async () => {
    const { root, atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir, "adapter-test");
    const foundation = await adapter.addTask(atmuxDir, {
      subject: "Foundation",
      lane: "be",
      priority: 1,
    });
    const taskID = await adapter.addTask(atmuxDir, {
      subject: "Consumer",
      body: "Use the shared board",
      deps: [foundation],
      assignee: "driver",
      deliverable: "src/adapter.ts",
      driverOnly: true,
    });

    expect((await adapter.listTasks(atmuxDir)).map((task) => task.id)).toEqual([
      foundation,
      taskID,
    ]);
    expect((await adapter.showTask(atmuxDir, taskID))?.deps).toEqual([foundation]);
    await adapter.markTaskDone(atmuxDir, foundation, "driver", "dependency verified");
    const claimed = await adapter.claimTask(atmuxDir, taskID, "driver", {
      callerScope: "driver",
    });
    expect(claimed.status).toBe("in-progress");
    expect(claimed.owner).toBe("driver");
    expect((await adapter.markTaskDone(atmuxDir, taskID, "driver")).status).toBe("done");

    const fromNestedPath = new KanbanCliAdapter({
      env: { KANBAN_DATA_DIR: join(root, "private-kanban") },
    });
    expect((await fromNestedPath.listTasks(join(root, ".atmux"))).length).toBe(2);
  });

  test("maps lane-aware next claims and task updates", async () => {
    const { atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    const fe = await adapter.addTask(atmuxDir, { subject: "FE", lane: "fe" });
    const general = await adapter.addTask(atmuxDir, { subject: "General" });

    expect((await adapter.claimTask(atmuxDir, undefined, "fe-worker", { lane: "fe" })).id).toBe(fe);
    const updated = await adapter.updateTask(atmuxDir, general, "driver", {
      assignee: "ops-worker",
      lane: "ops",
      priority: 1,
      dependencies: [fe],
    });
    expect(updated.owner).toBe("ops-worker");
    expect(updated.lane).toBe("ops");
    expect((await adapter.showTask(atmuxDir, general))?.deps).toEqual([fe]);
    expect(
      (await adapter.updateTask(atmuxDir, general, "driver", { dependencies: [] })).deps,
    ).toEqual([]);
    const epic = await adapter.addTask(atmuxDir, { subject: "Workflow", type: "epic" });
    await adapter.patchMetadata(atmuxDir, epic, "driver", { workflowStatus: "ready" });
    expect(
      (await adapter.loadKanban(atmuxDir)).epics.find((item) => item.id === epic)?.status,
    ).toBe("ready");
    expect(
      (
        await adapter.transitionTask(atmuxDir, general, "review", "driver", {
          workflowStatus: "review",
        })
      ).status,
    ).toBe("review");
  });

  test("routes atmux core read paths to the external board behind the cutover flag", async () => {
    const { root, atmuxDir, adapter } = fixture();
    const dataDir = join(root, "private-kanban");
    await adapter.initialize(atmuxDir);
    const taskID = await adapter.addTask(atmuxDir, { subject: "External authority", lane: "ops" });
    process.env.KANBAN_DATA_DIR = dataDir;
    process.env.ATMUX_KANBAN_BACKEND = "external";

    expect((await coreListTasks(atmuxDir))[0]?.id).toBe(taskID);
    expect((await coreShowTask(atmuxDir, taskID))?.subject).toBe("External authority");
    const board = await coreLoadKanban(atmuxDir);
    expect(board.tasks.map((task) => task.id)).toEqual([taskID]);
    expect(board.epics).toEqual([]);
    expect(board.stories).toEqual([]);
  });

  test("routes atmux core task mutations without writing atmux state.db", async () => {
    const { root, atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    process.env.KANBAN_DATA_DIR = join(root, "private-kanban");
    process.env.ATMUX_KANBAN_BACKEND = "external";

    const foundation = await coreAddTask(atmuxDir, { subject: "Foundation" });
    const consumer = await coreAddTask(atmuxDir, { subject: "Consumer" });
    await coreSetTaskLane(atmuxDir, consumer, "be");
    await coreSetTaskDeps(atmuxDir, consumer, [foundation]);
    await coreAssignTask(atmuxDir, consumer, "worker");
    await coreSetTaskDriverOnly(atmuxDir, consumer, true);
    await coreMarkTaskDone(atmuxDir, foundation, "verified");

    const claimed = await coreClaimTask(atmuxDir, consumer, "worker", {
      callerScope: "driver",
      refuseInProgressOther: true,
    });
    expect(claimed.pre.status).toBe("todo");
    expect(claimed.post.status).toBe("in-progress");
    expect(claimed.post.lane).toBe("be");
    expect(
      (await coreMarkTaskDone(atmuxDir, consumer, "complete", { callerScope: "driver" })).status,
    ).toBe("done");
    expect(existsSync(join(atmuxDir, "state.db"))).toBe(false);
  });

  test("normalizes atmux epic and story links into the external hierarchy", async () => {
    const { root, atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    const epic = await adapter.addTask(atmuxDir, { subject: "Epic", type: "epic" });
    const story = await adapter.addTask(atmuxDir, { subject: "Story", type: "story" });
    const task = await adapter.addTask(atmuxDir, { subject: "Task" });
    process.env.KANBAN_DATA_DIR = join(root, "private-kanban");
    process.env.ATMUX_KANBAN_BACKEND = "external";

    await coreSetTaskEpic(atmuxDir, task, epic);
    expect((await coreShowTask(atmuxDir, task))?.epic).toBe(epic);
    await coreSetTaskStory(atmuxDir, task, story);
    await coreSetTaskEpic(atmuxDir, task, epic);
    expect(await coreShowTask(atmuxDir, task)).toMatchObject({ epic, story });
    await coreSetTaskStory(atmuxDir, task, null);
    expect(await coreShowTask(atmuxDir, task)).toMatchObject({ epic, story: null });
  });

  test("routes atmux epic lifecycle through external Kanban", async () => {
    const { root, atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    process.env.KANBAN_DATA_DIR = join(root, "private-kanban");
    process.env.ATMUX_KANBAN_BACKEND = "external";

    const epic = await coreAddEpic(atmuxDir, { title: "External epic" });
    expect((await coreListEpics(atmuxDir)).map((item) => item.id)).toEqual([epic]);
    expect((await coreShowEpic(atmuxDir, epic))?.status).toBe("planning");
    expect((await coreSetEpicReady(atmuxDir, epic, true)).to).toBe(true);
    expect((await coreAdvanceEpic(atmuxDir, epic)).to).toBe("ready");
    expect((await coreAdvanceEpic(atmuxDir, epic)).to).toBe("in-progress");
  });

  test("routes atmux story CRUD through the normalized hierarchy", async () => {
    const { root, atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    process.env.KANBAN_DATA_DIR = join(root, "private-kanban");
    process.env.ATMUX_KANBAN_BACKEND = "external";

    const epic = await coreAddEpic(atmuxDir, { title: "Parent" });
    const story = await coreAddStory(atmuxDir, {
      title: "External story",
      epic,
      body: "Initial",
      acceptanceCriteria: "Observed",
    });
    expect((await coreListStories(atmuxDir, { epic })).map((item) => item.id)).toEqual([story]);
    expect(await coreShowStory(atmuxDir, story)).toMatchObject({
      epic,
      body: "Initial",
      acceptanceCriteria: "Observed",
    });
    await coreUpdateStory(atmuxDir, story, { body: "Updated", acceptanceCriteria: null });
    expect(await coreShowStory(atmuxDir, story)).toMatchObject({
      body: "Updated",
      acceptanceCriteria: null,
    });
  });
});
