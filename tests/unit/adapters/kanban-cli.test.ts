import { afterAll, afterEach, test as bunTest, describe, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  BOARD_SELECTING_ENV_VARS,
  KanbanCliAdapter,
  sanitizeKanbanEnv,
} from "../../../src/adapters/kanban-cli.ts";
import {
  addEpic as coreAddEpic,
  advanceEpic as coreAdvanceEpic,
  listEpics as coreListEpics,
  setEpicReady as coreSetEpicReady,
  showEpic as coreShowEpic,
} from "../../../src/core/epic.ts";
import {
  activateExternalKanbanCutover,
  observeExternalKanbanCutover,
  prepareExternalKanbanCutover,
  rollbackExternalKanbanCutover,
} from "../../../src/core/external-kanban-cutover.ts";
import {
  addTask as coreAddTask,
  assignTask as coreAssignTask,
  claimTask as coreClaimTask,
  listTasks as coreListTasks,
  loadKanban as coreLoadKanban,
  markTaskDone as coreMarkTaskDone,
  removeTask as coreRemoveTask,
  setTaskDeps as coreSetTaskDeps,
  setTaskDriverOnly as coreSetTaskDriverOnly,
  setTaskEpic as coreSetTaskEpic,
  setTaskLane as coreSetTaskLane,
  setTaskStory as coreSetTaskStory,
  showTask as coreShowTask,
} from "../../../src/core/kanban.ts";
import { readKanbanBackendMarker } from "../../../src/core/kanban-backend.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import {
  addStory as coreAddStory,
  advanceStory as coreAdvanceStory,
  listStories as coreListStories,
  showStory as coreShowStory,
  storySignoff as coreStorySignoff,
  updateStory as coreUpdateStory,
} from "../../../src/core/story.ts";
import {
  KANBAN_CLI_FIXTURES,
  KANBAN_FIXTURE_COMMIT,
  type KanbanCliFixtureName,
} from "../../helpers/kanban-cli-fixtures-414bfdd.ts";

const roots: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const test = bunTest;
const installedKanbanBinary = process.env.KANBAN_BIN?.trim() || Bun.which("kanban");
const installedKanbanCommand = installedKanbanBinary ?? "kanban";
const localProcessTest = bunTest.skipIf(installedKanbanBinary === null);

afterEach(() => {
  delete process.env.ATMUX_KANBAN_BACKEND;
  for (const name of BOARD_SELECTING_ENV_VARS) delete process.env[name];
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

// Board isolation runs through XDG_DATA_HOME, not KANBAN_DATA_DIR. The adapter
// strips ambient KANBAN_DB / KANBAN_DATA_DIR before spawning (they outrank the
// pinned cwd in the runtime's board resolution), so a test that redirected the
// board that way would only be exercising the leak the adapter now closes.
// XDG_DATA_HOME relocates the registry the cwd walk-up consults without
// overriding cwd selection, so every adapter in this process — the ones these
// tests construct and the module-level singletons inside src/core — agrees on
// the same throwaway registry.
function fixture(): { root: string; atmuxDir: string; adapter: KanbanCliAdapter } {
  const root = mkdtempSync(join(tmpdir(), "atmux-kanban-adapter-"));
  roots.push(root);
  const atmuxDir = join(root, ".atmux");
  mkdirSync(atmuxDir);
  process.env.XDG_DATA_HOME = join(root, "private-kanban");
  return {
    root,
    atmuxDir,
    adapter: new KanbanCliAdapter({ binary: installedKanbanCommand }),
  };
}

// A stand-in for the `kanban` binary that replays a captured fixture and
// records how it was called. Fixture replay runs through the adapter's real
// spawn/parse/throw path rather than a hand-written runner, so the transport
// is exercised, not restated: whatever the adapter does with the captured
// bytes here is exactly what it does with the runtime's.
const FAKE_KANBAN_BINARY = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync(process.env.KANBAN_FIXTURE_FILE, "utf8"));
const routes = JSON.parse(process.env.KANBAN_FIXTURE_ROUTES);
const name = routes[argv.slice(0, 2).join(" ")] ?? routes[argv[0]] ?? routes["*"];
const fixture = fixtures[name];
if (!fixture) {
  process.stderr.write(\`no fixture route for \${argv.join(" ")}\\n\`);
  process.exit(2);
}
const call = {
  argv,
  fixture: name,
  cwd: process.cwd(),
  board: {
    KANBAN_DB: process.env.KANBAN_DB ?? null,
    KANBAN_DATA_DIR: process.env.KANBAN_DATA_DIR ?? null,
  },
};
appendFileSync(process.env.KANBAN_CALL_LOG, \`\${JSON.stringify(call)}\\n\`);
appendFileSync(process.env.KANBAN_SERVED_LOG, \`\${name}\\n\`);
process.stdout.write(fixture.stdout);
process.stderr.write(fixture.stderr);
process.exit(fixture.exitCode);
`;

interface ReplayedCall {
  argv: string[];
  fixture: KanbanCliFixtureName;
  cwd: string;
  board: { KANBAN_DB: string | null; KANBAN_DATA_DIR: string | null };
}

/** Fixtures actually served across the whole file, so the completeness check
 *  counts what ran rather than what a route table claimed. Outlives the
 *  per-test roots that `afterEach` removes. */
const servedRoot = mkdtempSync(join(tmpdir(), "atmux-kanban-served-"));
const servedLog = join(servedRoot, "served.log");
afterAll(() => rmSync(servedRoot, { recursive: true, force: true }));

async function fixtureReplay(
  routes: Record<string, KanbanCliFixtureName>,
  env: Record<string, string | undefined> = {},
): Promise<{
  root: string;
  atmuxDir: string;
  adapter: KanbanCliAdapter;
  calls: () => Promise<ReplayedCall[]>;
}> {
  const root = mkdtempSync(join(tmpdir(), "atmux-kanban-replay-"));
  roots.push(root);
  const atmuxDir = join(root, ".atmux");
  mkdirSync(atmuxDir);
  const binary = join(root, "kanban-fixture-stub");
  const fixtureFile = join(root, "fixtures.json");
  const callLog = join(root, "calls.log");
  await writeFile(binary, FAKE_KANBAN_BINARY);
  chmodSync(binary, 0o755);
  await writeFile(fixtureFile, JSON.stringify(KANBAN_CLI_FIXTURES));
  await writeFile(callLog, "");
  return {
    root,
    atmuxDir,
    adapter: new KanbanCliAdapter({
      binary,
      env: {
        KANBAN_FIXTURE_FILE: fixtureFile,
        KANBAN_FIXTURE_ROUTES: JSON.stringify(routes),
        KANBAN_CALL_LOG: callLog,
        KANBAN_SERVED_LOG: servedLog,
        ...env,
      },
    }),
    calls: async () =>
      (await readFile(callLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ReplayedCall),
  };
}

describe("external Kanban CLI adapter (requires nonblank KANBAN_BIN or local kanban)", () => {
  const test = localProcessTest;

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

    const fromNestedPath = new KanbanCliAdapter({ binary: installedKanbanCommand });
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
    const { atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    const taskID = await adapter.addTask(atmuxDir, { subject: "External authority", lane: "ops" });
    process.env.ATMUX_KANBAN_BACKEND = "external";

    expect((await coreListTasks(atmuxDir))[0]?.id).toBe(taskID);
    expect((await coreShowTask(atmuxDir, taskID))?.subject).toBe("External authority");
    const board = await coreLoadKanban(atmuxDir);
    expect(board.tasks.map((task) => task.id)).toEqual([taskID]);
    expect(board.epics).toEqual([]);
    expect(board.stories).toEqual([]);
  });

  test("routes atmux core task mutations without writing atmux state.db", async () => {
    const { atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
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
    await coreRemoveTask(atmuxDir, consumer);
    expect(await coreShowTask(atmuxDir, consumer)).toBeNull();
    expect(existsSync(join(atmuxDir, "state.db"))).toBe(false);
  });

  test("normalizes atmux epic and story links into the external hierarchy", async () => {
    const { atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    const epic = await adapter.addTask(atmuxDir, { subject: "Epic", type: "epic" });
    const story = await adapter.addTask(atmuxDir, { subject: "Story", type: "story" });
    const task = await adapter.addTask(atmuxDir, { subject: "Task" });
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
    const { atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
    process.env.ATMUX_KANBAN_BACKEND = "external";

    const epic = await coreAddEpic(atmuxDir, { title: "External epic" });
    expect((await coreListEpics(atmuxDir)).map((item) => item.id)).toEqual([epic]);
    expect((await coreShowEpic(atmuxDir, epic))?.status).toBe("planning");
    expect((await coreSetEpicReady(atmuxDir, epic, true)).to).toBe(true);
    expect((await coreAdvanceEpic(atmuxDir, epic)).to).toBe("ready");
    expect((await coreAdvanceEpic(atmuxDir, epic)).to).toBe("in-progress");
  });

  test("routes atmux story CRUD through the normalized hierarchy", async () => {
    const { atmuxDir, adapter } = fixture();
    await adapter.initialize(atmuxDir);
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
    expect((await coreAdvanceStory(atmuxDir, story)).to).toBe("ready");
    expect((await coreAdvanceStory(atmuxDir, story)).to).toBe("in-progress");
    expect((await coreAdvanceStory(atmuxDir, story)).to).toBe("testing");
    expect(
      (await adapter.advanceStory(atmuxDir, story, "driver", { reviewer: "reviewer" })).to,
    ).toBe("review");
    expect((await coreStorySignoff(atmuxDir, story, { as: "reviewer" })).signedOffBy).toBe(
      "reviewer",
    );
    const merging = await adapter.advanceStory(atmuxDir, story, "driver", {
      committer: "committer",
    });
    expect(merging.to).toBe("merging");
    expect(merging.dispatchedTaskID).not.toBeNull();
    if (!merging.dispatchedTaskID) throw new Error("missing merge task");
    await adapter.markTaskDone(atmuxDir, merging.dispatchedTaskID, "committer");
    expect((await adapter.advanceStory(atmuxDir, story, "driver")).to).toBe("done");
  });

  test("prepares a read-only migration with private source and board receipts", async () => {
    const { root, atmuxDir, adapter } = fixture();
    const source = join(atmuxDir, "state.db");
    const db = openDatabase(source, migrations);
    new KanbanRepo(db).addTask({
      id: "t-source",
      subject: "Preserve me",
      body: "",
      status: "todo",
      owner: null,
      deps: [],
      priority: 2,
      lane: null,
      createdAt: 1_700_000_000,
      claimedAt: null,
      completedAt: null,
    });
    closeDatabase(db);

    const receipt = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      receiptRoot: join(root, "receipts"),
      adapter,
    });

    expect(receipt.status).toBe("prepared");
    expect(receipt.activation).toBe("not-activated");
    expect(receipt.sourceIntegrity).toBe("ok");
    expect(existsSync(receipt.sourceBackup)).toBe(true);
    expect(statSync(receipt.sourceBackup).mode & 0o777).toBe(0o600);
    expect(existsSync(join(receipt.boardBackupDirectory, "registry.db"))).toBe(true);
    expect((await adapter.showTask(atmuxDir, "t-source"))?.subject).toBe("Preserve me");
    expect(process.env.ATMUX_KANBAN_BACKEND).toBeUndefined();
  });

  test("prepares and activates a JSON-only atmux hierarchy", async () => {
    const { root, atmuxDir, adapter } = fixture();
    await Bun.write(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({
        epics: [{ id: "e-json", title: "JSON epic", status: "in-progress", isReady: true }],
        stories: [{ id: "s-json", epic: "e-json", title: "JSON story", status: "testing" }],
        tasks: [
          {
            id: "t-json",
            epic: "e-json",
            story: "s-json",
            subject: "JSON task",
            status: "todo",
          },
        ],
      }),
    );

    const prepared = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      receiptRoot: join(root, "receipts"),
      adapter,
    });
    expect(prepared.sourceKind).toBe("json");
    const activated = await activateExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      preparationReceipt: prepared.receiptPath,
      writersStopped: true,
      adapter,
    });
    expect(activated.counts).toEqual({ tasks: 1, epics: 1, stories: 1 });
    expect((await adapter.showTask(atmuxDir, "t-json"))?.story).toBe("s-json");
  });

  test("reconciles a prepared board only with stopped-writer acknowledgement", async () => {
    const { root, atmuxDir, adapter } = fixture();
    const source = join(atmuxDir, "state.db");
    let db = openDatabase(source, migrations);
    new KanbanRepo(db).addTask({
      id: "t-reconcile",
      subject: "Before",
      body: "",
      status: "todo",
      owner: null,
      deps: [],
      priority: 2,
      lane: null,
      createdAt: 1_700_000_000,
      claimedAt: null,
      completedAt: null,
    });
    closeDatabase(db);
    await prepareExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      receiptRoot: join(root, "receipts"),
      adapter,
    });
    db = openDatabase(source, migrations);
    new KanbanRepo(db).upsertTask({
      id: "t-reconcile",
      subject: "After",
      body: "",
      status: "blocked",
      owner: null,
      deps: [],
      priority: 2,
      lane: null,
      createdAt: 1_700_000_000,
      claimedAt: null,
      completedAt: null,
    });
    closeDatabase(db);

    await expect(
      prepareExternalKanbanCutover(atmuxDir, {
        actor: "operator",
        receiptRoot: join(root, "receipts"),
        reconcile: true,
        writersStopped: false,
        adapter,
      }),
    ).rejects.toThrow("stopped writers");
    const prepared = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      receiptRoot: join(root, "receipts"),
      reconcile: true,
      writersStopped: true,
      adapter,
    });
    expect((prepared.importReceipt as { updated: number }).updated).toBe(1);
    expect(await adapter.showTask(atmuxDir, "t-reconcile")).toMatchObject({
      subject: "After",
      status: "blocked",
    });
  });

  test("activates only a matching stopped-writer receipt and permits rollback before a write", async () => {
    const { root, atmuxDir, adapter } = fixture();
    const source = join(atmuxDir, "state.db");
    const db = openDatabase(source, migrations);
    new KanbanRepo(db).addTask({
      id: "t-activate",
      subject: "Activate me",
      body: "",
      status: "todo",
      owner: null,
      deps: [],
      priority: 1,
      lane: null,
      createdAt: 1_700_000_000,
      claimedAt: null,
      completedAt: null,
    });
    closeDatabase(db);
    const prepared = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      receiptRoot: join(root, "receipts"),
      adapter,
    });

    await expect(
      activateExternalKanbanCutover(atmuxDir, {
        actor: "operator",
        preparationReceipt: prepared.receiptPath,
        writersStopped: false,
        adapter,
      }),
    ).rejects.toThrow("writers-stopped");
    const activated = await activateExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      preparationReceipt: prepared.receiptPath,
      writersStopped: true,
      adapter,
    });
    expect(activated.counts.tasks).toBe(1);
    expect((await readKanbanBackendMarker(atmuxDir))?.backend).toBe("external");

    const rolledBack = await rollbackExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      writersStopped: true,
      adapter,
    });
    expect(rolledBack.backend).toBe("legacy");

    await activateExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      preparationReceipt: prepared.receiptPath,
      writersStopped: true,
      adapter,
    });
    await adapter.addTask(atmuxDir, { subject: "Post-cutover durable work" });
    await expect(
      rollbackExternalKanbanCutover(atmuxDir, {
        actor: "operator",
        writersStopped: true,
        adapter,
      }),
    ).rejects.toThrow("board changed after activation");
  });

  test("observation proves external progress without legacy work-state writes", async () => {
    const { root, atmuxDir, adapter } = fixture();
    const source = join(atmuxDir, "state.db");
    let db = openDatabase(source, migrations);
    new KanbanRepo(db).addTask({
      id: "t-observe",
      subject: "Observe me",
      body: "",
      status: "todo",
      owner: null,
      deps: [],
      priority: 1,
      lane: null,
      createdAt: 1_700_000_000,
      claimedAt: null,
      completedAt: null,
    });
    closeDatabase(db);
    const prepared = await prepareExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      receiptRoot: join(root, "receipts"),
      adapter,
    });
    await activateExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      preparationReceipt: prepared.receiptPath,
      writersStopped: true,
      adapter,
    });
    await adapter.addTask(atmuxDir, { subject: "External progress" });
    const observed = await observeExternalKanbanCutover(atmuxDir, {
      actor: "operator",
      adapter,
    });
    expect(observed.legacyWritesObserved).toBe(false);
    expect(observed.externalWritesObserved).toBe(true);
    expect(existsSync(observed.receiptPath)).toBe(true);

    db = openDatabase(source, migrations);
    new KanbanRepo(db).upsertTask({
      id: "t-observe",
      subject: "Legacy writer returned",
      body: "",
      status: "todo",
      owner: null,
      deps: [],
      priority: 1,
      lane: null,
      createdAt: 1_700_000_000,
      claimedAt: null,
      completedAt: null,
    });
    closeDatabase(db);
    await expect(
      observeExternalKanbanCutover(atmuxDir, { actor: "operator", adapter }),
    ).rejects.toThrow("legacy work state changed");
  });
});

describe("kanban board selection", () => {
  test("sanitizeKanbanEnv drops ambient board selectors and keeps explicit ones", () => {
    const ambient = { PATH: "/usr/bin", KANBAN_DB: "/ambient.db", KANBAN_DATA_DIR: "/ambient" };

    expect(sanitizeKanbanEnv(ambient)).toEqual({
      env: { PATH: "/usr/bin" },
      stripped: ["KANBAN_DB", "KANBAN_DATA_DIR"],
    });
    expect(sanitizeKanbanEnv(ambient, { KANBAN_DB: "/explicit.db" })).toEqual({
      env: { PATH: "/usr/bin", KANBAN_DB: "/explicit.db" },
      stripped: ["KANBAN_DATA_DIR"],
    });
    // A caller that names the variable means it, even to unset it.
    expect(sanitizeKanbanEnv(ambient, { KANBAN_DATA_DIR: undefined }).stripped).toEqual([
      "KANBAN_DB",
    ]);
    expect(sanitizeKanbanEnv({ PATH: "/usr/bin" }, { HOME: "/root" })).toEqual({
      env: { PATH: "/usr/bin", HOME: "/root" },
      stripped: [],
    });
  });

  localProcessTest(
    "an inherited KANBAN_DB cannot redirect the board, and is named once [requires local kanban]",
    async () => {
      const { root, atmuxDir, adapter } = fixture();
      await adapter.initialize(atmuxDir, "strip-test");
      const taskID = await adapter.addTask(atmuxDir, { subject: "Selected by cwd" });

      // If the ambient value reached the subprocess, `store_path` would
      // short-circuit board discovery and open (creating) this file instead.
      const decoy = join(root, "decoy-board.db");
      process.env.KANBAN_DB = decoy;
      const warnings: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };
      try {
        expect((await adapter.listTasks(atmuxDir)).map((task) => task.id)).toEqual([taskID]);
        expect((await adapter.listTasks(atmuxDir)).map((task) => task.id)).toEqual([taskID]);
      } finally {
        console.error = originalConsoleError;
      }

      expect(existsSync(decoy)).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("KANBAN_DB");
      expect(warnings[0]).toContain(root);
    },
  );

  localProcessTest(
    "an inherited KANBAN_DATA_DIR cannot redirect the registry [requires local kanban]",
    async () => {
      const { root, atmuxDir, adapter } = fixture();
      await adapter.initialize(atmuxDir, "registry-strip-test");
      const taskID = await adapter.addTask(atmuxDir, { subject: "Selected by cwd" });

      // An empty registry root: leaked through, the cwd walk-up finds no
      // workspace and every call fails instead of reading the project's board.
      const decoyRegistry = join(root, "decoy-registry");
      mkdirSync(decoyRegistry);
      process.env.KANBAN_DATA_DIR = decoyRegistry;
      const originalConsoleError = console.error;
      console.error = () => {};
      try {
        expect((await adapter.listTasks(atmuxDir)).map((task) => task.id)).toEqual([taskID]);
      } finally {
        console.error = originalConsoleError;
      }
      expect(existsSync(join(decoyRegistry, "registry.db"))).toBe(false);
    },
  );

  test("initialize pins the board with cwd and passes no --workspace", async () => {
    const replay = await fixtureReplay({ init: "taskAdd" });
    await replay.adapter.initialize(replay.atmuxDir, "named-board");

    const [call] = await replay.calls();
    // `--workspace` is read by `init` alone at runtime 414bfdd and ignored by
    // every other verb, so this adapter never states it: cwd is the selector
    // that holds for all of them.
    expect(call?.argv).toEqual(["init", "--name", "named-board", "--json"]);
    expect(realpathSync(call?.cwd ?? "")).toBe(realpathSync(replay.root));
  });

  test("initialize defaults the board name to the project directory", async () => {
    const replay = await fixtureReplay({ init: "taskAdd" });
    await replay.adapter.initialize(replay.atmuxDir);

    const [call] = await replay.calls();
    expect(call?.argv).toEqual(["init", "--name", basename(replay.root), "--json"]);
  });

  test("explicit adapter env still reaches the subprocess; ambient never does", async () => {
    process.env.KANBAN_DB = "/ambient/leak.db";
    const inherited = await fixtureReplay({ "task list": "taskListWithRelations" });
    const explicit = await fixtureReplay(
      { "task list": "taskListWithRelations" },
      { KANBAN_DB: "/explicit/intent.db" },
    );
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await inherited.adapter.listTasks(inherited.atmuxDir);
      await explicit.adapter.listTasks(explicit.atmuxDir);
    } finally {
      console.error = originalConsoleError;
    }

    expect((await inherited.calls())[0]?.board.KANBAN_DB).toBeNull();
    expect((await explicit.calls())[0]?.board.KANBAN_DB).toBe("/explicit/intent.db");
  });
});

// Drift guard. Each test replays bytes captured from the real binary at
// runtime commit KANBAN_FIXTURE_COMMIT and asserts the fields the adapter
// reads off them. When the runtime changes shape, these fail by name against a
// known commit instead of the change surfacing as a wrong answer inside a verb.
describe(`kanban CLI contract at runtime ${KANBAN_FIXTURE_COMMIT}`, () => {
  test("addTask reads the id off a created record", async () => {
    const replay = await fixtureReplay({ "task add": "taskAdd" });
    expect(
      await replay.adapter.addTask(replay.atmuxDir, {
        subject: "task alpha",
        body: "some body",
        lane: "fe",
        priority: 2,
        assignee: "be-1",
        deliverable: "a thing",
        epic: "e-4d17bce8",
        driverOnly: true,
      }),
    ).toBe("t-02f3afe1");
    expect((await replay.calls())[0]?.argv).toEqual([
      "task",
      "add",
      "task alpha",
      "--json",
      "--body",
      "some body",
      "--assignee",
      "be-1",
      "--priority",
      "2",
      "--lane",
      "fe",
      "--deliverable",
      "a thing",
      "--driver-only",
      "--parent",
      "e-4d17bce8",
    ]);
  });

  test("listTasks maps the relations listing onto KanbanTask", async () => {
    const replay = await fixtureReplay({ "task list": "taskListWithRelations" });
    const tasks = await replay.adapter.listTasks(replay.atmuxDir);

    expect((await replay.calls())[0]?.argv).toEqual(["task", "list", "--with-relations", "--json"]);
    // The epic in the capture is filtered out of the task list.
    expect(tasks.map((task) => task.id)).toEqual(["t-02f3afe1", "t-b2b57495"]);
    expect(tasks[0]).toMatchObject({
      subject: "task alpha",
      body: "some body",
      status: "todo",
      owner: "be-1",
      lane: "fe",
      deliverable: "a thing",
      staleMin: 45,
      driverOnly: true,
      priority: 2,
      epic: "e-4d17bce8",
      story: null,
      deps: [],
      // Runtime emits epoch milliseconds; KanbanTask carries seconds.
      createdAt: 1_786_932_660,
      claimedAt: null,
      completedAt: null,
    });
    expect(tasks[1]?.deps).toEqual(["t-02f3afe1"]);
  });

  test("loadKanban splits the same listing by record type", async () => {
    const replay = await fixtureReplay({ "task list": "taskListWithRelations" });
    const board = await replay.adapter.loadKanban(replay.atmuxDir);

    expect(board.tasks.map((task) => task.id)).toEqual(["t-02f3afe1", "t-b2b57495"]);
    expect(board.stories).toEqual([]);
    expect(board.epics).toHaveLength(1);
    expect(board.epics[0]).toMatchObject({
      id: "e-4d17bce8",
      title: "epic one",
      status: "todo",
      isReady: false,
      createdAt: 1_786_932_660,
      completedAt: null,
    });
  });

  test("showTask filters the listing, and reads a miss as absence", async () => {
    const found = await fixtureReplay({ "task list": "taskListWithRelations" });
    expect(await found.adapter.showTask(found.atmuxDir, "t-02f3afe1")).toMatchObject({
      subject: "task alpha",
    });
    expect(await found.adapter.showTask(found.atmuxDir, "t-nosuch")).toBeNull();

    // The runtime's not-found wording is what showTask's guard matches.
    const missing = await fixtureReplay({ "task list": "taskShowMissing" });
    expect(await missing.adapter.showTask(missing.atmuxDir, "t-deadbeef")).toBeNull();
  });

  test("moveTask translates atmux status spelling the runtime rejects", async () => {
    const rejected = await fixtureReplay({ "task move": "taskMoveInvalidStatus" });
    // The capture proves the runtime refuses atmux's hyphenated spelling, so
    // the adapter must send the underscored one.
    expect(KANBAN_CLI_FIXTURES.taskMoveInvalidStatus.stderr).toContain(
      "invalid task status in-progress",
    );
    await expect(
      rejected.adapter.moveTask(rejected.atmuxDir, "t-b2b57495", "review", "tester"),
    ).rejects.toThrow("invalid task status in-progress");

    const accepted = await fixtureReplay({ "task move": "taskMoveDone" });
    await accepted.adapter.moveTask(accepted.atmuxDir, "t-02f3afe1", "in-progress", "tester");
    expect((await accepted.calls())[0]?.argv).toEqual([
      "task",
      "move",
      "t-02f3afe1",
      "in_progress",
      "--as",
      "tester",
      "--json",
    ]);
  });

  test("markTaskDone notes then moves, and reads completion off the move", async () => {
    const replay = await fixtureReplay({ note: "noteDone", "task move": "taskMoveDone" });
    const done = await replay.adapter.markTaskDone(
      replay.atmuxDir,
      "t-02f3afe1",
      "tester",
      "closing note",
    );

    expect(done).toMatchObject({
      status: "done",
      completedAt: 1_786_932_661,
      owner: null,
      lane: null,
    });
    const calls = await replay.calls();
    expect(calls.map((call) => call.fixture)).toEqual(["noteDone", "taskMoveDone"]);
    expect(calls[0]?.argv).toEqual([
      "note",
      "t-02f3afe1",
      "closing note",
      "--as",
      "tester",
      "--kind",
      "done",
      "--json",
    ]);
  });

  test("addNote carries the note kind through to the runtime", async () => {
    const replay = await fixtureReplay({ note: "noteDone" });
    await replay.adapter.addNote(replay.atmuxDir, "t-9e692daf", "be-1", "blocker", "closing note");
    expect((await replay.calls())[0]?.argv).toEqual([
      "note",
      "t-9e692daf",
      "closing note",
      "--as",
      "be-1",
      "--kind",
      "blocker",
      "--json",
    ]);
  });

  test("updateTask reads the whole mutated record back", async () => {
    const assigned = await fixtureReplay({ "task update": "taskUpdateAssign" });
    expect(
      await assigned.adapter.updateTask(assigned.atmuxDir, "t-02f3afe1", "tester", {
        assignee: "fe-2",
      }),
    ).toMatchObject({ owner: "fe-2", lane: "fe" });

    const cleared = await fixtureReplay({ "task update": "taskUpdateClearLane" });
    expect(
      await cleared.adapter.updateTask(cleared.atmuxDir, "t-02f3afe1", "tester", {
        lane: null,
        assignee: null,
      }),
    ).toMatchObject({ lane: null, owner: null });
    expect((await cleared.calls())[0]?.argv).toEqual([
      "task",
      "update",
      "t-02f3afe1",
      "--as",
      "tester",
      "--json",
      "--unassign",
      "--clear-lane",
    ]);
  });

  test("removeTask discards the receipt the runtime answers with", async () => {
    const replay = await fixtureReplay({ "task remove": "taskRemove" });
    expect(
      await replay.adapter.removeTask(replay.atmuxDir, "t-b2b57495", "tester"),
    ).toBeUndefined();
    expect((await replay.calls())[0]?.argv).toEqual([
      "task",
      "remove",
      "t-b2b57495",
      "--as",
      "tester",
      "--json",
    ]);
  });

  test("claimTask re-reads, because a claim answers with a lease not a task", async () => {
    // The capture also pins a live hazard: `claim --next` hands back an EPIC.
    const replay = await fixtureReplay({
      claim: "claimNextPickedAnEpic",
      "task list": "taskListWithRelations",
    });
    const claimed = await replay.adapter.claimTask(replay.atmuxDir, undefined, "be-1");

    expect(claimed).toMatchObject({ id: "e-4d17bce8", subject: "epic one" });
    const calls = await replay.calls();
    expect(calls[0]?.argv).toEqual(["claim", "--next", "--as", "be-1", "--json"]);
    expect(calls[1]?.argv).toEqual(["task", "list", "--with-relations", "--json"]);
  });

  test("claimTask surfaces a lease whose task the board does not list", async () => {
    const replay = await fixtureReplay({
      claim: "claim",
      "task list": "taskListWithRelations",
    });
    await expect(
      replay.adapter.claimTask(replay.atmuxDir, "t-9e692daf", "be-1", {
        callerScope: "member",
      }),
    ).rejects.toThrow("Kanban claim returned missing task t-9e692daf");
  });

  test("claim refusals reach the caller verbatim", async () => {
    const taken = await fixtureReplay({ claim: "claimAlreadyClaimed" });
    await expect(
      taken.adapter.claimTask(taken.atmuxDir, "t-9e692daf", "be-2", { callerScope: "member" }),
    ).rejects.toThrow("task t-9e692daf is already claimed");

    const empty = await fixtureReplay({ claim: "claimNextEmpty" });
    await expect(empty.adapter.claimTask(empty.atmuxDir, undefined, "be-9")).rejects.toThrow(
      "no claimable task",
    );
  });

  test("every captured fixture is replayed by the tests above", async () => {
    const served = new Set((await readFile(servedLog, "utf8")).split("\n").filter(Boolean));
    // A capture nothing parses guards nothing — keep the file honest.
    expect([...served].sort()).toEqual(Object.keys(KANBAN_CLI_FIXTURES).sort());
  });
});
