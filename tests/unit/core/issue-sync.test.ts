// ADR-263 §D3 (P3): issue-sync engine tests.
//
// The tracker is dependency-injected (a mock returning canned pages), so
// every test runs offline. The engine opens a real temp `state.db` (the
// migration ladder creates it), so the dedup index + watermark behavior
// are exercised end-to-end against SQLite.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IssueTracker,
  IssueTrackerPage,
  ListIssuesOptions,
  NormalizedIssue,
} from "../../../src/abstractions/issue-tracker.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  defaultResolveTracker,
  readWatermark,
  renderTaskBody,
  type SyncDeps,
  sourceIdPrefix,
  syncSource,
  taskNeedsRefresh,
} from "../../../src/core/issue-sync.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import type { TaskSource } from "../../../src/schema/team.ts";

let scratch: string;
let atmuxDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-issue-sync-"));
  atmuxDir = join(scratch, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const SOURCE: TaskSource = {
  provider: "github",
  scope: "o/r",
  state: "open",
  onClose: "done",
};

function issue(over: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    trackerId: "github",
    sourceId: "github:o/r#1",
    url: "https://github.com/o/r/issues/1",
    title: "Bug one",
    body: "body one",
    state: "open",
    labels: ["bug"],
    assignee: null,
    author: "alice",
    createdAtSec: 1_700_000_000,
    updatedAtSec: 1_700_000_100,
    extra: { isPullRequest: false },
    ...over,
  };
}

/** Mock tracker. `pages` is an array of issue-pages served by cursor
 *  index ("1" → pages[0], "2" → pages[1], …). Records every listIssues
 *  call's options in `seen`. */
function mockTracker(pages: NormalizedIssue[][]): {
  tracker: IssueTracker;
  seen: ListIssuesOptions[];
} {
  const seen: ListIssuesOptions[] = [];
  const tracker: IssueTracker = {
    id: "github",
    async listIssues(o: ListIssuesOptions): Promise<IssueTrackerPage> {
      seen.push(o);
      const page = o.cursor != null ? Number.parseInt(o.cursor, 10) : 1;
      const idx = page - 1;
      const issues = pages[idx] ?? [];
      const nextCursor = idx + 1 < pages.length ? String(page + 1) : null;
      return { issues, nextCursor };
    },
    async getIssue(): Promise<NormalizedIssue | null> {
      return null;
    },
  };
  return { tracker, seen };
}

function depsFor(tracker: IssueTracker, nowMs = 1_700_000_500_000): SyncDeps {
  return { resolveTracker: async () => tracker, nowMs: () => nowMs };
}

/** Read all tasks straight from the engine-written DB. */
function readTasks(): ReturnType<KanbanRepo["listTasks"]> {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    return new KanbanRepo(db).listTasks();
  } finally {
    closeDatabase(db);
  }
}

// ---------- create / dedup / refresh ----------

describe("syncSource — create", () => {
  test("an open issue becomes a todo task with provenance + fenced body", async () => {
    const { tracker } = mockTracker([[issue()]]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(tracker));
    expect(r).toMatchObject({
      provider: "github",
      scope: "o/r",
      fetched: 1,
      created: 1,
      updated: 0,
      closed: 0,
    });

    const tasks = readTasks();
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    expect(t?.subject).toBe("Bug one");
    expect(t?.status).toBe("todo");
    expect(t?.sourceKind).toBe("github");
    expect(t?.sourceId).toBe("github:o/r#1");
    expect(t?.owner ?? null).toBeNull();
    // body carries provenance + the untrusted-banner fence
    expect(t?.body).toContain("github:o/r#1");
    expect(t?.body).toContain("UNTRUSTED");
    expect(t?.body).toContain("body one");
  });

  test("source lane + priority are stamped on created tasks", async () => {
    const { tracker } = mockTracker([[issue()]]);
    const src: TaskSource = { ...SOURCE, lane: "be", priority: 2 };
    await syncSource(atmuxDir, src, depsFor(tracker));
    const t = readTasks()[0];
    expect(t?.lane).toBe("be");
    expect(t?.priority).toBe(2);
  });
});

describe("syncSource — dedup + refresh", () => {
  test("re-syncing the same unchanged issue does not duplicate", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, SOURCE, depsFor(m1.tracker));
    const m2 = mockTracker([[issue()]]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(m2.tracker));
    expect(readTasks()).toHaveLength(1);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(0);
  });

  test("an upstream title edit refreshes subject + body, preserving status/owner", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, SOURCE, depsFor(m1.tracker));
    // simulate the operator claiming the task (in-progress under 'bob')
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const t = repo.listTasks()[0];
      if (t === undefined) throw new Error("setup: no task");
      repo.upsertTask({ ...t, status: "in-progress", owner: "bob" });
      closeDatabase(db);
    }
    const m2 = mockTracker([[issue({ title: "Bug one (edited)", updatedAtSec: 1_700_000_200 })]]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(m2.tracker));
    expect(r.updated).toBe(1);
    const t = readTasks()[0];
    expect(t?.subject).toBe("Bug one (edited)");
    expect(t?.status).toBe("in-progress"); // claim preserved
    expect(t?.owner).toBe("bob"); // owner preserved
  });

  test("a done task is never refreshed or re-opened by an upstream edit", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, SOURCE, depsFor(m1.tracker));
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const t = repo.listTasks()[0];
      if (t === undefined) throw new Error("setup: no task");
      repo.upsertTask({ ...t, status: "done", completedAt: 123 });
      closeDatabase(db);
    }
    const m2 = mockTracker([[issue({ title: "edited", updatedAtSec: 1_700_000_300 })]]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(m2.tracker));
    expect(r.updated).toBe(0);
    expect(readTasks()[0]?.status).toBe("done");
    expect(readTasks()[0]?.subject).toBe("Bug one");
  });
});

// ---------- close reconciliation ----------

describe("syncSource — close reconciliation", () => {
  test("onClose=done moves a still-todo task to done when the issue closes", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(m1.tracker));
    const m2 = mockTracker([[issue({ state: "closed", updatedAtSec: 1_700_000_400 })]]);
    const r = await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(m2.tracker));
    expect(r.closed).toBe(1);
    const t = readTasks()[0];
    expect(t?.status).toBe("done");
    expect(t?.completedAt).toBe(1_700_000_500); // nowSec from injected clock
  });

  test("onClose=done does NOT yank an in-progress task", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(m1.tracker));
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const t = repo.listTasks()[0];
      if (t === undefined) throw new Error("setup: no task");
      repo.upsertTask({ ...t, status: "in-progress", owner: "bob" });
      closeDatabase(db);
    }
    const m2 = mockTracker([[issue({ state: "closed", updatedAtSec: 1_700_000_400 })]]);
    const r = await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(m2.tracker));
    expect(r.closed).toBe(0);
    expect(readTasks()[0]?.status).toBe("in-progress");
  });

  test("onClose=leave never auto-mutates on close", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, { ...SOURCE, state: "all", onClose: "leave" }, depsFor(m1.tracker));
    const m2 = mockTracker([[issue({ state: "closed", updatedAtSec: 1_700_000_400 })]]);
    const r = await syncSource(
      atmuxDir,
      { ...SOURCE, state: "all", onClose: "leave" },
      depsFor(m2.tracker),
    );
    expect(r.closed).toBe(0);
    expect(readTasks()[0]?.status).toBe("todo");
  });

  test("a closed issue with no existing task is NOT backfilled as a done task", async () => {
    const { tracker } = mockTracker([[issue({ state: "closed" })]]);
    const r = await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(tracker));
    expect(r.created).toBe(0);
    expect(r.closed).toBe(0);
    expect(readTasks()).toHaveLength(0);
  });
});

// ---------- pagination + watermark ----------

describe("syncSource — pagination", () => {
  test("walks every page", async () => {
    const { tracker } = mockTracker([
      [issue({ sourceId: "github:o/r#1" })],
      [issue({ sourceId: "github:o/r#2" })],
      [issue({ sourceId: "github:o/r#3" })],
    ]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(tracker));
    expect(r.fetched).toBe(3);
    expect(r.created).toBe(3);
    expect(
      readTasks()
        .map((t) => t.sourceId)
        .sort(),
    ).toEqual(["github:o/r#1", "github:o/r#2", "github:o/r#3"]);
  });
});

describe("syncSource — pagination cap", () => {
  test("stops after MAX_PAGES when the tracker never exhausts + records an error", async () => {
    // A tracker that always advertises a next page (empty issues) — the
    // engine must break at the cap rather than loop forever.
    const runaway: IssueTracker = {
      id: "github",
      async listIssues(): Promise<IssueTrackerPage> {
        return { issues: [], nextCursor: "2" };
      },
      async getIssue(): Promise<NormalizedIssue | null> {
        return null;
      },
    };
    const r = await syncSource(atmuxDir, SOURCE, { resolveTracker: async () => runaway });
    expect(r.errors.some((e) => /pagination cap/.test(e))).toBe(true);
    expect(r.fetched).toBe(0);
  });
});

describe("syncSource — per-issue resilience", () => {
  test("a corrupt pre-existing row records an error but does not abort the batch", async () => {
    // Seed a corrupt task row (empty id fails the Zod min(1) at read) that
    // collides on the source_id the next sync will probe. applyIssue's
    // getTaskBySourceId then throws on parse — the engine records the
    // error and continues to the next issue rather than aborting.
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      db.query("INSERT INTO tasks (id, source_id) VALUES ('', 'github:o/r#1')").run();
      closeDatabase(db);
    }
    const { tracker } = mockTracker([
      [issue({ sourceId: "github:o/r#1" }), issue({ sourceId: "github:o/r#2" })],
    ]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(tracker));
    expect(r.errors.some((e) => e.startsWith("github:o/r#1:"))).toBe(true);
    // #2 still landed (the batch continued past the corrupt row). Read raw
    // — listTasks() would itself choke on the corrupt id='' row.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const row = db.query("SELECT id FROM tasks WHERE source_id = 'github:o/r#2'").get() as {
        id: string;
      } | null;
      expect(row).not.toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});

describe("syncSource — watermark", () => {
  test("first sync passes no sinceSec; checkpoints the max updatedAt", async () => {
    const { tracker, seen } = mockTracker([
      [
        issue({ updatedAtSec: 1_700_000_100 }),
        issue({ sourceId: "github:o/r#2", updatedAtSec: 1_700_000_900 }),
      ],
    ]);
    await syncSource(atmuxDir, SOURCE, depsFor(tracker));
    expect(seen[0]?.sinceSec).toBeUndefined();
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      expect(readWatermark(db, SOURCE)).toBe(1_700_000_900);
    } finally {
      closeDatabase(db);
    }
  });

  test("the next sync passes the stored watermark as sinceSec", async () => {
    const m1 = mockTracker([[issue({ updatedAtSec: 1_700_000_900 })]]);
    await syncSource(atmuxDir, SOURCE, depsFor(m1.tracker));
    const m2 = mockTracker([[]]);
    await syncSource(atmuxDir, SOURCE, depsFor(m2.tracker));
    expect(m2.seen[0]?.sinceSec).toBe(1_700_000_900);
  });

  test("readWatermark ignores a stored value of the wrong shape", async () => {
    // First seed a real state.db (via a no-op sync), then poke a
    // valid-JSON-but-wrong-shape row in directly. CHECK(json_valid)
    // forbids non-JSON, so the engine's shape guard (not a try/catch) is
    // what protects against a malformed watermark.
    await syncSource(atmuxDir, SOURCE, depsFor(mockTracker([[]]).tracker));
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      db.query(
        `INSERT INTO state_kv (feature, key, value, updated_at)
         VALUES ('issue-sync', 'github:o/r', '{"other":1}', 1)
         ON CONFLICT(feature, key) DO UPDATE SET value=excluded.value`,
      ).run();
      expect(readWatermark(db, SOURCE)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

describe("defaultResolveTracker (production resolver)", () => {
  test("resolves a github adapter; honors a team.json token literal", async () => {
    const t1 = await defaultResolveTracker({
      provider: "github",
      scope: "o/r",
      state: "open",
      onClose: "done",
    });
    expect(t1.id).toBe("github");
    // token literal path (source.token set) — no network, just resolution
    const t2 = await defaultResolveTracker({
      provider: "github",
      scope: "o/r",
      state: "open",
      onClose: "done",
      token: "ghp_literal",
    });
    expect(t2.id).toBe("github");
  });
});

// ---------- dry-run ----------

describe("syncSource — dry-run", () => {
  test("counts what would happen but writes nothing", async () => {
    const { tracker } = mockTracker([[issue(), issue({ sourceId: "github:o/r#2" })]]);
    const r = await syncSource(atmuxDir, SOURCE, depsFor(tracker), { dryRun: true });
    expect(r.fetched).toBe(2);
    expect(r.created).toBe(2);
    expect(readTasks()).toHaveLength(0); // nothing persisted
    // no watermark written either
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      expect(readWatermark(db, SOURCE)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("dry-run counts a would-close", async () => {
    const m1 = mockTracker([[issue()]]);
    await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(m1.tracker));
    const m2 = mockTracker([[issue({ state: "closed", updatedAtSec: 1_700_000_400 })]]);
    const r = await syncSource(atmuxDir, { ...SOURCE, state: "all" }, depsFor(m2.tracker), {
      dryRun: true,
    });
    expect(r.closed).toBe(1);
    expect(readTasks()[0]?.status).toBe("todo"); // unchanged
  });
});

// ---------- pure helpers ----------

describe("pure helpers", () => {
  test("sourceIdPrefix composes provider:scope#", () => {
    expect(sourceIdPrefix(SOURCE)).toBe("github:o/r#");
  });

  test("renderTaskBody flags pull requests + fences untrusted body", () => {
    const body = renderTaskBody(issue({ extra: { isPullRequest: true } }));
    expect(body).toContain("pull-request");
    expect(body).toContain("UNTRUSTED");
  });

  test("renderTaskBody tolerates a null body", () => {
    expect(renderTaskBody(issue({ body: null }))).toContain("(no body)");
  });

  test("taskNeedsRefresh detects subject + body drift", () => {
    const i = issue();
    const fresh = { id: "t-1", subject: i.title, body: renderTaskBody(i) };
    expect(taskNeedsRefresh(fresh, i)).toBe(false);
    expect(taskNeedsRefresh({ ...fresh, subject: "x" }, i)).toBe(true);
  });
});
