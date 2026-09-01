// Unit tests for src/core/gitter-merge-handler.ts — T4 of EPIC
// e-4acc3562.
//
// Pins:
//   - Roster-skip: a member not in deps.roster returns
//     'skipped-not-mine' without invoking the dispatcher.
//   - Ahead-0 short-circuit: `rev-list --count <base>..<member>` = 0
//     returns 'skipped-not-mine' without invoking the dispatcher.
//   - Dispatcher → 'merged' state: returns 'merged'.
//   - Dispatcher → 'conflict' or 'test_failed': returns 'escalated'
//     (T5 picks up the signal + emits gitter.escalated).
//   - Dispatcher → walkable non-terminal (in_progress / ready_to_merge
//     / rebasing / merging / tested): returns 'gate-held' (idempotent).
//   - Hard invariant per ADR-212 §D2 + ADR-134: the injected GitSpawn
//     NEVER receives 'rebase' / 'squash' / 'reset' / 'checkout' across
//     the full test matrix.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { BranchMergeState } from "../../../src/core/branch-merge-state.ts";
import type { Logger } from "../../../src/core/gitter-consumer.ts";
import { createGitterMergeHandler } from "../../../src/core/gitter-merge-handler.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";
import type { TaskDonePayload } from "../../../src/schema/events.ts";

let scratch: string;
let db: Database;
let mergerRepo: MergerStateRepo;
let kanbanRepo: KanbanRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-gitter-handler-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  mergerRepo = new MergerStateRepo(db);
  kanbanRepo = new KanbanRepo(db);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

const FORBIDDEN_VERBS = new Set(["rebase", "squash", "reset", "checkout"]);

interface SpawnCapture {
  calls: string[][];
  spawn: GitSpawn;
}

function makeSpawnCapture(
  responder: (argv: ReadonlyArray<string>) => Partial<SpawnResult>,
): SpawnCapture {
  const calls: string[][] = [];
  const spawn: GitSpawn = async (argv) => {
    calls.push([...argv]);
    const partial = responder(argv);
    return {
      cmd: "git",
      argv: [...argv],
      exitCode: 0,
      signalled: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      ...partial,
    };
  };
  return { calls, spawn };
}

function assertNoForbiddenVerbs(calls: ReadonlyArray<ReadonlyArray<string>>): void {
  for (const argv of calls) {
    for (const token of argv) {
      if (FORBIDDEN_VERBS.has(token)) {
        throw new Error(
          `gitter handler invoked forbidden git verb '${token}' (full argv: ${argv.join(" ")})`,
        );
      }
    }
  }
}

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function baseDeps(spawn: GitSpawn) {
  return {
    teamRoot: "/fake/repo",
    baseBranch: "atmux-geoyws",
    git: spawn,
    mergerRepo,
    kanbanRepo,
    logger: NOOP_LOGGER,
    resolveMemberWorktreePath: async () => null,
    emit: (() => ({})) as never,
    atmuxDir: "/fake/.atmux",
    roster: ["be-1", "be-2", "fe-1", "fe-2"] as const,
  };
}

function taskDoneEvent(over: Partial<TaskDonePayload> = {}): TaskDonePayload {
  return {
    topic: "task.done",
    eventId: "01890000-0000-7000-8000-000000000001",
    emittedAtSec: 1_700_000_000,
    schemaVersion: 1,
    taskId: "t-aaaaaaaa",
    member: "be-1",
    team: "atmux",
    doneAtSec: 1_700_000_001,
    ...over,
  };
}

function fakeDispatcher(opts: { postState?: BranchMergeState; queued?: boolean; reason?: string }) {
  return () =>
    async ({ memberBranch }: { memberBranch: string; aheadCount: number }) => {
      if (opts.postState !== undefined) {
        mergerRepo.transition({
          memberBranch,
          next: opts.postState,
          note: "fake dispatcher",
          by: "cron",
          transitionedAt: 1_700_000_000,
        });
      }
      const result: { queued: boolean; reason?: string } = {
        queued: opts.queued ?? true,
      };
      if (opts.reason !== undefined) result.reason = opts.reason;
      return result;
    };
}

describe("roster-skip", () => {
  test("member not in roster returns 'skipped-not-mine' (no dispatcher call)", async () => {
    const capture = makeSpawnCapture(() => ({}));
    let dispatched = false;
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: () => async () => {
        dispatched = true;
        return { queued: false };
      },
    });

    const outcome = await handler(taskDoneEvent({ member: "ghost-9" }));

    expect(outcome).toBe("skipped-not-mine");
    expect(dispatched).toBe(false);
    assertNoForbiddenVerbs(capture.calls);
  });

  test("event.member empty + commitSha missing returns 'skipped-not-mine'", async () => {
    const capture = makeSpawnCapture(() => ({}));
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent({ member: "", commitSha: undefined }));

    expect(outcome).toBe("skipped-not-mine");
    assertNoForbiddenVerbs(capture.calls);
  });
});

describe("ahead=0 short-circuit", () => {
  test("rev-list --count returns 0 → 'skipped-not-mine' without dispatch", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "0\n" };
      return {};
    });
    let dispatched = false;
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: () => async () => {
        dispatched = true;
        return { queued: false };
      },
    });

    const outcome = await handler(taskDoneEvent());

    expect(outcome).toBe("skipped-not-mine");
    expect(dispatched).toBe(false);
    assertNoForbiddenVerbs(capture.calls);
  });
});

describe("dispatcher result → outcome mapping", () => {
  test("post-state 'merged' → returns 'merged'", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "3\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("merged");
    assertNoForbiddenVerbs(capture.calls);
  });

  test("post-state 'conflict' → returns 'escalated'", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "1\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "conflict" }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("escalated");
    assertNoForbiddenVerbs(capture.calls);
  });

  test("post-state 'test_failed' → returns 'escalated'", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "2\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "test_failed" }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("escalated");
    assertNoForbiddenVerbs(capture.calls);
  });

  test.each([
    "in_progress",
    "ready_to_merge",
    "rebasing",
    "merging",
    "tested",
  ] as const)("post-state '%s' → returns 'gate-held'", async (s) => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "1\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({
        postState: s,
        queued: false,
        reason: "gate-held",
      }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("gate-held");
    assertNoForbiddenVerbs(capture.calls);
  });

  test("unknown terminal state ('reverted') → returns 'gate-held' (defensive fallback)", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "1\n" };
      return {};
    });
    let warned = "";
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      logger: {
        info: () => {},
        warn: (m) => {
          warned = m;
        },
        error: () => {},
      },
      dispatcherFactory: fakeDispatcher({ postState: "reverted" }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("gate-held");
    expect(warned).toContain("unexpected post-dispatch state");
    assertNoForbiddenVerbs(capture.calls);
  });
});

describe("commitSha fallback resolution", () => {
  test("event.member missing → resolves via git branch --contains", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("branch") && argv.includes("--contains")) {
        // Two branches reachable; first matching <base>-<member> wins.
        return { stdout: "  some/other-branch\n* atmux-geoyws-be-2\n" };
      }
      if (argv.includes("rev-list")) return { stdout: "1\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent({ member: "", commitSha: "deadbeef" }));

    expect(outcome).toBe("merged");
    // Resolver consulted branch --contains
    expect(
      capture.calls.some((argv) => argv.includes("branch") && argv.includes("--contains")),
    ).toBe(true);
    assertNoForbiddenVerbs(capture.calls);
  });

  test("git branch --contains exit != 0 → returns 'skipped-not-mine'", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("branch") && argv.includes("--contains")) {
        return { exitCode: 128, stderr: "fatal: bad commit" };
      }
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent({ member: "", commitSha: "deadbeef" }));

    expect(outcome).toBe("skipped-not-mine");
    assertNoForbiddenVerbs(capture.calls);
  });

  test("git branch --contains returns only non-roster branches → 'skipped-not-mine'", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("branch") && argv.includes("--contains")) {
        return { stdout: "  atmux-geoyws-ghost\n  feature/x\n" };
      }
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent({ member: "", commitSha: "deadbeef" }));

    expect(outcome).toBe("skipped-not-mine");
    assertNoForbiddenVerbs(capture.calls);
  });
});

describe("rev-list parse robustness", () => {
  test("non-numeric rev-list stdout → treated as ahead=0 (skip)", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "not-a-number\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("skipped-not-mine");
    assertNoForbiddenVerbs(capture.calls);
  });

  test("rev-list exit != 0 → ahead=0 (skip)", async () => {
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { exitCode: 128 };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      dispatcherFactory: fakeDispatcher({ postState: "merged" }),
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("skipped-not-mine");
    assertNoForbiddenVerbs(capture.calls);
  });
});

describe("logger adapter (consumer-tier → tui.Logger)", () => {
  test("dispatcher's logger.log/ok/warn/err all route to consumer-tier logger.info", async () => {
    const infos: string[] = [];
    const capture = makeSpawnCapture((argv) => {
      if (argv.includes("rev-list")) return { stdout: "1\n" };
      return {};
    });
    const handler = createGitterMergeHandler({
      ...baseDeps(capture.spawn),
      logger: {
        info: (m) => infos.push(m),
        warn: () => {},
        error: () => {},
      },
      dispatcherFactory:
        (dispatcherDeps) =>
        async ({ memberBranch }) => {
          // Exercise every adapter method — production dispatcher only
          // calls .log() but the surface must conform to tui.Logger.
          dispatcherDeps.logger.log(`adapter-log: ${memberBranch}`);
          dispatcherDeps.logger.ok(`adapter-ok: ${memberBranch}`);
          dispatcherDeps.logger.warn(`adapter-warn: ${memberBranch}`);
          dispatcherDeps.logger.err(`adapter-err: ${memberBranch}`);
          mergerRepo.transition({
            memberBranch,
            next: "merged",
            note: "fake",
            by: "cron",
            transitionedAt: 1_700_000_000,
          });
          return { queued: true };
        },
    });

    const outcome = await handler(taskDoneEvent());
    expect(outcome).toBe("merged");
    expect(infos).toEqual([
      "adapter-log: atmux-geoyws-be-1",
      "adapter-ok: atmux-geoyws-be-1",
      "adapter-warn: atmux-geoyws-be-1",
      "adapter-err: atmux-geoyws-be-1",
    ]);
    assertNoForbiddenVerbs(capture.calls);
  });
});

describe("safety invariant — no destructive git verbs (ADR-212 §D2 + ADR-134)", () => {
  test("full happy-path matrix never invokes rebase/squash/reset/checkout", async () => {
    const allCalls: string[][] = [];
    const responder = (argv: ReadonlyArray<string>): Partial<SpawnResult> => {
      allCalls.push([...argv]);
      if (argv.includes("rev-list")) return { stdout: "5\n" };
      if (argv.includes("branch") && argv.includes("--contains")) {
        return { stdout: "* atmux-geoyws-be-1\n" };
      }
      return {};
    };

    const spawn: GitSpawn = async (argv) => {
      const partial = responder(argv);
      return {
        cmd: "git",
        argv: [...argv],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        ...partial,
      };
    };

    for (const state of [
      "merged",
      "conflict",
      "test_failed",
      "in_progress",
      "rebasing",
      "tested",
    ] as const) {
      const handler = createGitterMergeHandler({
        ...baseDeps(spawn),
        dispatcherFactory: fakeDispatcher({ postState: state }),
      });
      await handler(taskDoneEvent());
    }

    assertNoForbiddenVerbs(allCalls);
  });
});
