// E2E ADR-146 T3 (t-51610d4e) — Story chain auto-emit + short-circuits
// + atomicity walked through the real `moveTask` verb against a real
// SQLite state.db.
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume a fresh
// mkdtemp'd state.db + team.json fixture per beat. Don't streak; don't
// run-of-N.** Per CLAUDE.md testing discipline §"Stateful e2e specs
// are not repeatable smokes."
//
// ---------------------------------------------------------------
// Scope vs T2's unit coverage
// ---------------------------------------------------------------
//
// `tests/unit/core/kanban.test.ts` covers `tryAutoEmitTrunkMerge`
// (the pure function) extensively at the function call level — happy
// path, every short-circuit, loop-prevention. This e2e tests the
// LAYER ABOVE — the moveTask verb's transactImmediate-wrapped
// integration with the hook + the auto-emit's effect on the persisted
// state.db. Different concern: same-transaction atomicity, multi-Task
// sequencing through real `moveTask` calls, ADR-032 cascade
// observability (the auto-emit Task IS the cascade signal — a
// gitter subscriber watches `tasks` for `subject like "merge t-...
// (branch→trunk):%"` rows).
//
// Deps NOT yet shipped — explicit skip-docs:
//
//   - **ADR-032 socket-pubsub wake** — the actual pubsub publish on
//     task-done cascade (ADR-134 T3 / `t-27b06cda`) is still todo.
//     Subscriber-mocking against an absent dispatcher would test the
//     mock, not the integration. This e2e asserts the LEDGER side
//     of the cascade (the auto-emit Task row is present in state.db
//     after moveTask returns, ready for a future cascade subscriber
//     to pick up). T3's e2e covers the actual fire-and-cascade.
//
// ---------------------------------------------------------------
// Beats
// ---------------------------------------------------------------
//
//   B1. Auto-emit on last task done — 3 child tasks under a branched
//       Story; mark each done in sequence; auto-emit fires ONLY on
//       task 3 (last sibling). Subject + owner + body field
//       assertions per ADR-146 §D2 / §D3.
//   B2. Loop prevention — a Task whose subject already matches the
//       auto-emit pattern transitioning to done does NOT trigger a
//       new auto-emit. Pre/post Task count parity test.
//   B3. Short-circuit: Story.branch unset.
//   B4. Short-circuit: Story.branch === team.merger.baseBranch
//       (shared-base, with shortCircuitOnSharedBase: true).
//   B5. Short-circuit: team.worktreeIsolation !== true.
//   B6. Short-circuit: team.autoEmitTrunkMerge.enabled === false.
//   B7. Atomicity (positive direction) — after a successful auto-
//       emit, BOTH the done-transition row + the auto-emit row are
//       present in state.db. The transactImmediate guarantee on the
//       negative direction (mid-tx throw → both roll back) is
//       SQLite's contract + the kanban unit-test fixtures already
//       exercise the throw path.
//   B8. ADR-032 cascade observability — list tasks via
//       repo.listTasks filtering on the auto-emit subject pattern;
//       assert the auto-emit row is queryable (cascade subscriber
//       contract).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { listTasks, moveTask } from "../../src/core/kanban.ts";
import { KanbanRepo } from "../../src/core/repositories/kanban-repo.ts";
import type { KanbanStory, KanbanTask } from "../../src/schema/kanban.ts";
import type { Team } from "../../src/schema/team.ts";

// ---------- Fixture helpers ----------

interface Fixture {
  teamDir: string;
  atmuxDir: string;
  statePath: string;
}

/** Cold-start a fresh fixture with a writable .atmux dir + state.db
 *  migrated. Each test gets its own — no inter-test state. */
async function makeFixture(teamOverrides: Partial<Team> = {}): Promise<Fixture> {
  const teamDir = await mkdtemp(join(tmpdir(), "atmux-auto-emit-"));
  const atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "inboxes"), { recursive: true });

  const baseTeam: Team = {
    name: "auto-emit-test",
    members: [
      { name: "be-1", role: "member", lane: "be" },
      { name: "gitter", role: "gitter", lane: "misc" },
    ],
    worktreeIsolation: true,
    merger: { enabled: true, baseBranch: "develop" },
    autoEmitTrunkMerge: { enabled: true, shortCircuitOnSharedBase: true },
  } as Team;

  // Deep-merge — overrides win on the top-level fields the beats
  // toggle (worktreeIsolation / autoEmitTrunkMerge / merger).
  const team: Team = { ...baseTeam, ...teamOverrides } as Team;
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team, null, 2));

  const statePath = join(atmuxDir, "state.db");
  const db = openDatabase(statePath, migrations);
  closeDatabase(db);

  return { teamDir, atmuxDir, statePath };
}

interface SeededStory {
  storyId: string;
  taskIds: string[];
}

/** Seed a Story + N child tasks directly via the repo (bypassing
 *  `addTask` because `addTask` doesn't accept a `story` field — the
 *  attribute lives on `KanbanTask` per the schema but isn't a
 *  first-class option on the verb). */
function seedStoryWithTasks(
  fix: Fixture,
  opts: {
    storyId?: string;
    branch?: string | null;
    taskCount: number;
    taskSubject?: (i: number) => string;
    taskStatus?: string;
  },
): SeededStory {
  const db = openDatabase(fix.statePath, migrations);
  try {
    const repo = new KanbanRepo(db);
    const storyId = opts.storyId ?? `s-${Math.random().toString(16).slice(2, 10)}`;
    const story: KanbanStory = {
      id: storyId,
      title: "auto-emit fixture story",
      body: null,
      status: "in-progress",
      createdAt: Math.floor(Date.now() / 1000),
      mergeMode: "feature-branch",
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    };
    repo.upsertStory(story);

    const taskIds: string[] = [];
    for (let i = 0; i < opts.taskCount; i += 1) {
      const id = `t-fix${Math.random().toString(16).slice(2, 8)}${i}`;
      const subject =
        opts.taskSubject !== undefined ? opts.taskSubject(i) : `fixture task ${i + 1}`;
      const task: KanbanTask = {
        id,
        subject,
        body: "",
        status: opts.taskStatus ?? "in-progress",
        owner: "be-1",
        story: storyId,
        deps: [],
        priority: null,
        lane: "be",
        createdAt: Math.floor(Date.now() / 1000),
        claimedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
      };
      repo.upsertTask(task);
      taskIds.push(id);
    }
    return { storyId, taskIds };
  } finally {
    closeDatabase(db);
  }
}

/** Read every Task whose subject matches the auto-emit pattern.
 *  This is the cascade-subscriber contract: gitter (or any subscriber
 *  reacting to the ADR-032 task-done cascade) queries for these rows
 *  to pick up newly-filed trunk-merge work.
 *
 *  The regex below (and at B7/B8 inline call-sites) mirrors
 *  AUTO_EMIT_SUBJECT_RE in src/core/kanban.ts — accepts BOTH legacy
 *  hex IDs (`t-3b017960`) and ADR-202 §VIII compound IDs
 *  (`t-1-3b017960`). */
function findAutoEmitTasks(fix: Fixture): KanbanTask[] {
  const db = openDatabase(fix.statePath, migrations);
  try {
    const repo = new KanbanRepo(db);
    return repo
      .listTasks()
      .filter((t) => /^merge t-(?:[1-9][0-9]*-)?[0-9a-f]+ \(branch→trunk\):/.test(t.subject ?? ""));
  } finally {
    closeDatabase(db);
  }
}

function countAllTasks(fix: Fixture): number {
  const db = openDatabase(fix.statePath, migrations);
  try {
    return new KanbanRepo(db).listTasks().length;
  } finally {
    closeDatabase(db);
  }
}

// ---------- Fixture lifecycle ----------

let fix: Fixture;

afterEach(async () => {
  if (fix !== undefined) {
    await rm(fix.teamDir, { recursive: true, force: true });
  }
});

// ---------- Beats ----------

describe("e2e auto-emit-trunk-merge (ADR-146 T3, t-51610d4e)", () => {
  test("B1: auto-emit on last task done — first 2 transitions silent; 3rd fires; subject + owner + body match §D2 shape", async () => {
    fix = await makeFixture();
    const { storyId, taskIds } = seedStoryWithTasks(fix, {
      branch: "develop-be-1",
      taskCount: 3,
    });

    // Mark tasks 1 + 2 done — no auto-emit yet (siblings remain).
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");
    expect(findAutoEmitTasks(fix)).toHaveLength(0);
    await moveTask(fix.atmuxDir, taskIds[1] ?? "", "done");
    expect(findAutoEmitTasks(fix)).toHaveLength(0);

    // Mark task 3 done — final non-done sibling; auto-emit fires.
    await moveTask(fix.atmuxDir, taskIds[2] ?? "", "done");
    const emitted = findAutoEmitTasks(fix);
    expect(emitted).toHaveLength(1);
    const auto = emitted[0];
    if (auto === undefined) throw new Error("auto-emit Task missing");

    // §D2 subject pattern verbatim.
    expect(auto.subject).toMatch(/^merge t-(?:[1-9][0-9]*-)?[0-9a-f]+ \(branch→trunk\): develop-be-1 → trunk$/);
    // §D3 owner resolution — gitter member wins over fallbackAssignee.
    expect(auto.owner).toBe("gitter");
    expect(auto.status).toBe("todo");
    // §D2 body fields. Body is YAML-flavored markdown.
    const body = auto.body ?? "";
    expect(body).toContain("source-branch: develop-be-1");
    expect(body).toContain("target: trunk");
    expect(body).toContain("owning-lane: be"); // derives from done-task's lane
    expect(body).toContain(`parent-story: ${storyId}`);
    expect(body).toContain("auto-emitted: true");
    expect(body).toMatch(/emitted-at: \d+/);
  });

  test("B2: loop prevention — done Task whose subject matches the auto-emit pattern does NOT re-fire emission", async () => {
    fix = await makeFixture();
    const { taskIds } = seedStoryWithTasks(fix, {
      branch: "develop-be-1",
      taskCount: 1,
      taskSubject: () =>
        // The done Task IS itself an auto-emit Task — subject matches
        // the pattern. Marking it done should hit the §D5 last-row
        // loop-prevention guard and NOT emit a new Task.
        "merge t-deadbeef (branch→trunk): develop-be-1 → trunk",
    });
    const totalBefore = countAllTasks(fix);
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");
    const totalAfter = countAllTasks(fix);
    expect(totalAfter).toBe(totalBefore); // no new Task filed
    expect(findAutoEmitTasks(fix)).toHaveLength(1); // the original is still the only match
  });

  test("B3: short-circuit — Story.branch unset → no emit", async () => {
    fix = await makeFixture();
    // branch undefined — schema's nullable + optional shape; auto-emit
    // §D5 row "Story without branch set" short-circuits cleanly.
    const { taskIds } = seedStoryWithTasks(fix, { taskCount: 1 });
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");
    expect(findAutoEmitTasks(fix)).toHaveLength(0);
  });

  test("B4: short-circuit — Story.branch === team.merger.baseBranch (sharedBase) → no emit", async () => {
    fix = await makeFixture();
    const { taskIds } = seedStoryWithTasks(fix, {
      // base team's merger.baseBranch is "develop"; setting the
      // story's branch to the same value trips §D5 row "Story.branch
      // === team-base-branch (shortCircuitOnSharedBase)".
      branch: "develop",
      taskCount: 1,
    });
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");
    expect(findAutoEmitTasks(fix)).toHaveLength(0);
  });

  test("B5: short-circuit — team.worktreeIsolation !== true → no emit", async () => {
    fix = await makeFixture({ worktreeIsolation: false });
    const { taskIds } = seedStoryWithTasks(fix, {
      branch: "develop-be-1",
      taskCount: 1,
    });
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");
    expect(findAutoEmitTasks(fix)).toHaveLength(0);
  });

  test("B6: short-circuit — team.autoEmitTrunkMerge.enabled === false → no emit", async () => {
    fix = await makeFixture({
      autoEmitTrunkMerge: { enabled: false, shortCircuitOnSharedBase: true },
    });
    const { taskIds } = seedStoryWithTasks(fix, {
      branch: "develop-be-1",
      taskCount: 1,
    });
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");
    expect(findAutoEmitTasks(fix)).toHaveLength(0);
  });

  test("B7: atomicity (positive) — after auto-emit fires, BOTH done-transition row + auto-emit row persist", async () => {
    fix = await makeFixture();
    const { taskIds } = seedStoryWithTasks(fix, {
      branch: "develop-be-1",
      taskCount: 1,
    });
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");

    // Both rows must be present after moveTask's transactImmediate
    // closes. ADR-146 §Atomic — the auto-emit lives in the same
    // BEGIN IMMEDIATE wrap as the done-transition.
    const db = openDatabase(fix.statePath, migrations);
    try {
      const repo = new KanbanRepo(db);
      const original = repo.getTask(taskIds[0] ?? "");
      expect(original?.status).toBe("done");
      const emitted = repo
        .listTasks()
        .filter((t) => /^merge t-(?:[1-9][0-9]*-)?[0-9a-f]+ \(branch→trunk\):/.test(t.subject ?? ""));
      expect(emitted).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("B8: ADR-032 cascade observability — auto-emit Task is queryable via listTasks (subscriber-contract row)", async () => {
    fix = await makeFixture();
    const { taskIds } = seedStoryWithTasks(fix, {
      branch: "develop-be-1",
      taskCount: 1,
    });
    await moveTask(fix.atmuxDir, taskIds[0] ?? "", "done");

    // The ADR-032 cascade subscriber's contract: query `tasks` for
    // `status='todo'` rows with the auto-emit subject pattern. Verify
    // a subscriber executing that query AFTER moveTask returns would
    // observe exactly one new row, owned by gitter.
    const tasks = await listTasks(fix.atmuxDir);
    const subscriberCandidates = tasks.filter(
      (t) => t.status === "todo" && /^merge t-(?:[1-9][0-9]*-)?[0-9a-f]+ \(branch→trunk\):/.test(t.subject ?? ""),
    );
    expect(subscriberCandidates).toHaveLength(1);
    expect(subscriberCandidates[0]?.owner).toBe("gitter");
    // body fields the subscriber parses to route the merge work
    expect(subscriberCandidates[0]?.body).toContain("source-branch: develop-be-1");
    expect(subscriberCandidates[0]?.body).toContain("auto-emitted: true");
  });
});
