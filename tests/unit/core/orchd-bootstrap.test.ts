// Unit tests for src/core/orchd-bootstrap.ts — driver P0 step 2/5
// (2026-05-23) wire-up that registers the three orchd handlers
// (auto-merge / auto-dissolve / auto-push) against ORCHD_SUBSCRIPTIONS.
//
// Pins:
//   - First bootstrap registers exactly 3 subscriptions in canonical
//     order (merge → dissolve → push).
//   - Canonical consumer IDs + topics match the exported constants
//     (drift detector for the registry contract step 3/5 will iterate).
//   - Re-bootstrap with the same db is idempotent: each subscription's
//     `isNew` flips to false, ORCHD_SUBSCRIPTIONS length stays at 3.
//   - Each registered handler is a `(EventPayload) => Promise<void>` —
//     specifically does NOT throw when dispatched with a topic-matching
//     payload under stubbed-default deps (skipped-not-mine path).
//   - Optional deps injection threads through to the underlying handler
//     factories (verified by overriding `dispatchEpicMerge` and observing
//     it called when the handler dispatches).

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  bootstrapOrchd,
  ORCHD_COMPLAINT_CONSUMER_ID,
  ORCHD_COMPLAINT_TOPIC,
  ORCHD_DISSOLVE_CONSUMER_ID,
  ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID,
  ORCHD_DISSOLVE_SOLO_WORKER_TOPIC,
  ORCHD_DISSOLVE_TOPIC,
  ORCHD_MERGE_CONSUMER_ID,
  ORCHD_MERGE_TOPIC,
  ORCHD_PUSH_CONSUMER_ID,
  ORCHD_PUSH_TOPIC,
  ORCHD_LEAD_STALL_ON_STORY_READY_CONSUMER_ID,
  ORCHD_LEAD_STALL_ON_STORY_UNCLAIMED_CONSUMER_ID,
  ORCHD_LEAD_STALL_ON_TASK_UNCLAIMED_CONSUMER_ID,
  ORCHD_ROTATION_CONSUMER_ID,
  ORCHD_ROTATION_TOPIC,
  ORCHD_SPAWN_ON_READY_CONSUMER_ID,
  ORCHD_SPAWN_ON_READY_TOPIC,
  ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID,
  ORCHD_SPAWN_ON_UNBLOCKED_TOPIC,
} from "../../../src/core/orchd-bootstrap.ts";
import { ORCHD_SUBSCRIPTIONS } from "../../../src/core/orchd-registry.ts";
import type {
  EpicMergedPayload,
  EventPayload,
  TaskDonePayload,
} from "../../../src/schema/events.ts";

let scratch: string;
let db: Database;
let priorCwd: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-bootstrap-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  ORCHD_SUBSCRIPTIONS.length = 0;
  // Hermeticity: the handler factories' default audit-log paths are
  // RELATIVE (`.atmux/logs/orchd-push.jsonl` /
  // `.atmux/logs/orchd-dissolve.log`), so under stubbed defaults they
  // resolve against process.cwd(). Left at the repo root this suite
  // appended a fake `e-deadbeef` row into the LIVE team's audit trail,
  // and — worse — its own result depended on whether some earlier
  // suite had happened to create `./.atmux/logs/` as a side effect
  // (`tests/unit/cli.test.ts` drives `cli.ts::main()` with no
  // ATMUX_DIR override, whose events-log envelope mkdir -p's
  // `./.atmux/logs/<yyyy>/<mm>/`). That made the full-suite green a
  // FALSE green while the standalone run failed. Anchoring cwd to the
  // per-test scratch dir makes the outcome identical in both modes.
  priorCwd = process.cwd();
  process.chdir(scratch);
});

afterEach(async () => {
  ORCHD_SUBSCRIPTIONS.length = 0;
  db.close();
  process.chdir(priorCwd);
  await rm(scratch, { recursive: true, force: true });
});

describe("bootstrapOrchd — first registration", () => {
  test("registers exactly 8 subscriptions in canonical order (merge → dissolve → push → dissolve-solo-worker → spawn:on-ready → spawn:on-unblocked → complaint → rotation)", () => {
    const result = bootstrapOrchd({ db });

    expect(result.registered).toHaveLength(8);
    expect(result.registered.map((r) => r.consumerId)).toEqual([
      ORCHD_MERGE_CONSUMER_ID,
      ORCHD_DISSOLVE_CONSUMER_ID,
      ORCHD_PUSH_CONSUMER_ID,
      ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID,
      ORCHD_SPAWN_ON_READY_CONSUMER_ID,
      ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID,
      ORCHD_COMPLAINT_CONSUMER_ID,
      ORCHD_ROTATION_CONSUMER_ID,
    ]);
    expect(result.registered.map((r) => r.topic)).toEqual([
      ORCHD_MERGE_TOPIC,
      ORCHD_DISSOLVE_TOPIC,
      ORCHD_PUSH_TOPIC,
      ORCHD_DISSOLVE_SOLO_WORKER_TOPIC,
      ORCHD_SPAWN_ON_READY_TOPIC,
      ORCHD_SPAWN_ON_UNBLOCKED_TOPIC,
      ORCHD_COMPLAINT_TOPIC,
      ORCHD_ROTATION_TOPIC,
    ]);
    expect(result.registered.every((r) => r.isNew)).toBe(true);
    expect(ORCHD_SUBSCRIPTIONS).toHaveLength(8);
  });

  test("canonical consumer IDs match the ADR-224 §D6 + ADR-231 §D2/§D6 naming convention", () => {
    expect(ORCHD_MERGE_CONSUMER_ID).toBe("atmux:orchd:auto-merge");
    expect(ORCHD_DISSOLVE_CONSUMER_ID).toBe("atmux:orchd:auto-dissolve");
    expect(ORCHD_PUSH_CONSUMER_ID).toBe("atmux:orchd:auto-push");
    expect(ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID).toBe("atmux:orchd:dissolve-solo-worker");
    expect(ORCHD_SPAWN_ON_READY_CONSUMER_ID).toBe("atmux:orchd:spawn:on-ready");
    expect(ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID).toBe("atmux:orchd:spawn:on-unblocked");
  });

  test("canonical topics match each handler module's documented trigger", () => {
    // merge: task.done per ADR-226 §D1
    // dissolve: epic.pushed per ADR-227 §Amendment 2026-05-23
    // push: epic.merged per ADR-229 §D1
    // dissolve-solo-worker: task.done per ADR-231 §D6
    // spawn:on-ready: epic.ready per ADR-231 §D2 + ADR-225 §Events
    // spawn:on-unblocked: epic.unblocked per ADR-231 §D2 + ADR-225 §Events
    expect(ORCHD_MERGE_TOPIC).toBe("task.done");
    expect(ORCHD_DISSOLVE_TOPIC).toBe("epic.pushed");
    expect(ORCHD_PUSH_TOPIC).toBe("epic.merged");
    expect(ORCHD_DISSOLVE_SOLO_WORKER_TOPIC).toBe("task.done");
    expect(ORCHD_SPAWN_ON_READY_TOPIC).toBe("epic.ready");
    expect(ORCHD_SPAWN_ON_UNBLOCKED_TOPIC).toBe("epic.unblocked");
  });

  test("dissolve-solo-worker shares task.done topic with auto-merge — per-consumer offsets isolate them", () => {
    // Both subscribe to task.done; consumerIds differ so Honker's
    // per-consumer offsets keep their drain progress independent
    // (ADR-202 §VIII + ADR-231 §D6 coordination note).
    expect(ORCHD_DISSOLVE_SOLO_WORKER_TOPIC).toBe(ORCHD_MERGE_TOPIC);
    expect(ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID).not.toBe(ORCHD_MERGE_CONSUMER_ID);
  });

  test("spawn handler subscribes to BOTH epic.ready AND epic.unblocked with distinct consumerIds", () => {
    // Per ADR-231 §D2: one handler factory, two subscriptions —
    // per-topic offsets stay independent so a backlog on one topic
    // doesn't shadow the other.
    expect(ORCHD_SPAWN_ON_READY_CONSUMER_ID).not.toBe(ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID);
    expect(ORCHD_SPAWN_ON_READY_TOPIC).not.toBe(ORCHD_SPAWN_ON_UNBLOCKED_TOPIC);
  });
});

describe("bootstrapOrchd — idempotency", () => {
  test("re-bootstrap with the same db flips every isNew to false, no duplicate push", () => {
    const first = bootstrapOrchd({ db });
    expect(first.registered.every((r) => r.isNew)).toBe(true);
    expect(ORCHD_SUBSCRIPTIONS).toHaveLength(8);

    const second = bootstrapOrchd({ db });
    expect(second.registered.every((r) => !r.isNew)).toBe(true);
    expect(ORCHD_SUBSCRIPTIONS).toHaveLength(8);
  });
});

describe("bootstrapOrchd — handler dispatch shape", () => {
  test("each registered handler accepts a topic-matching EventPayload without throwing (stubbed defaults)", async () => {
    bootstrapOrchd({ db });

    const mergeSub = ORCHD_SUBSCRIPTIONS.find((s) => s.consumerId === ORCHD_MERGE_CONSUMER_ID);
    const dissolveSub = ORCHD_SUBSCRIPTIONS.find(
      (s) => s.consumerId === ORCHD_DISSOLVE_CONSUMER_ID,
    );
    const pushSub = ORCHD_SUBSCRIPTIONS.find((s) => s.consumerId === ORCHD_PUSH_CONSUMER_ID);
    expect(mergeSub).toBeDefined();
    expect(dissolveSub).toBeDefined();
    expect(pushSub).toBeDefined();

    const taskDone: TaskDonePayload = {
      topic: "task.done",
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1_700_000_000,
    } as TaskDonePayload;
    const epicMerged: EpicMergedPayload = {
      topic: "epic.merged",
      epicId: "e-deadbeef",
      parentBase: "atmux-geoyws",
      mergeSha: "0".repeat(40),
      mergedAtSec: 1_700_000_000,
    } as EpicMergedPayload;
    const epicPushed: EventPayload = {
      topic: "epic.pushed",
      epicId: "e-deadbeef",
      base: "atmux-geoyws",
      headSha: "0".repeat(40),
      pushedAtSec: 1_700_000_000,
    } as unknown as EventPayload;

    await expect(mergeSub?.handler(taskDone)).resolves.toBeUndefined();
    await expect(dissolveSub?.handler(epicPushed)).resolves.toBeUndefined();
    await expect(pushSub?.handler(epicMerged)).resolves.toBeUndefined();
  });
});

describe("bootstrapOrchd — dep injection threading", () => {
  test("mergeDeps.dispatchEpicMerge override is invoked when the handler dispatches", async () => {
    // Pre-seed an epic + task so the handler's pre-flight (resolveEpicId
    // + isEpicComplete) passes and reaches the dispatch step.
    const epicId = "e-12345678";
    db.prepare(
      "INSERT INTO tasks (id, subject, status, owner, lane, deps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `t-${epicId.slice(2)}01`,
      `[${epicId}] last task`,
      "done",
      "be-1",
      "be",
      "[]",
      1_700_000_000,
    );

    let dispatchCalls = 0;
    let seenEpicId: string | null = null as string | null;
    bootstrapOrchd({
      db,
      mergeDeps: {
        dispatchEpicMerge: async (eid) => {
          dispatchCalls += 1;
          seenEpicId = eid;
          return { state: "skipped-not-mine" };
        },
      },
    });

    const mergeSub = ORCHD_SUBSCRIPTIONS.find((s) => s.consumerId === ORCHD_MERGE_CONSUMER_ID);
    expect(mergeSub).toBeDefined();

    const taskDone: TaskDonePayload = {
      topic: "task.done",
      taskId: `t-${epicId.slice(2)}01`,
      member: "be-1",
      team: "atmux",
      doneAtSec: 1_700_000_000,
      epicId,
    } as TaskDonePayload;

    await mergeSub?.handler(taskDone);

    expect(dispatchCalls).toBe(1);
    expect(seenEpicId).toBe(epicId);
  });
});

// ADR-247 §D2 — lead-stall watchdog registration gating.
describe("bootstrapOrchd — lead-stall watchdog (ADR-247 §D2)", () => {
  const LEAD_STALL_IDS = [
    ORCHD_LEAD_STALL_ON_STORY_READY_CONSUMER_ID,
    ORCHD_LEAD_STALL_ON_STORY_UNCLAIMED_CONSUMER_ID,
    ORCHD_LEAD_STALL_ON_TASK_UNCLAIMED_CONSUMER_ID,
  ];

  function leadStallDeps(enabled?: boolean) {
    return {
      atmuxDir: scratch,
      team: {
        name: "atmux",
        members: [
          { name: "lead" },
          { name: "be-1", lane: "be" },
        ] as never,
        ...(enabled !== undefined ? { leadStallWatchdog: { enabled } } : {}),
      },
      loadSnapshot: async () => ({ stories: [], tasks: [] }),
    };
  }

  test("does NOT register the watchdog when leadStallDeps is absent", () => {
    bootstrapOrchd({ db });
    for (const id of LEAD_STALL_IDS) {
      expect(ORCHD_SUBSCRIPTIONS.find((s) => s.consumerId === id)).toBeUndefined();
    }
  });

  test("registers all THREE watchdog subscriptions when deps wired + enabled omitted (default on)", () => {
    const result = bootstrapOrchd({ db, leadStallDeps: leadStallDeps() });
    const registeredIds = result.registered.map((r) => r.consumerId);
    for (const id of LEAD_STALL_IDS) {
      expect(registeredIds).toContain(id);
      expect(ORCHD_SUBSCRIPTIONS.find((s) => s.consumerId === id)).toBeDefined();
    }
    // topics: story.ready / story.unclaimed / task.unclaimed
    const topics = ORCHD_SUBSCRIPTIONS.filter((s) => LEAD_STALL_IDS.includes(s.consumerId)).map(
      (s) => s.topic,
    );
    expect(topics.sort()).toEqual(["story.ready", "story.unclaimed", "task.unclaimed"]);
  });

  test("registers the watchdog when enabled === true", () => {
    const result = bootstrapOrchd({ db, leadStallDeps: leadStallDeps(true) });
    const registeredIds = result.registered.map((r) => r.consumerId);
    for (const id of LEAD_STALL_IDS) expect(registeredIds).toContain(id);
  });

  test("does NOT register the watchdog when enabled === false (operator off-switch)", () => {
    const result = bootstrapOrchd({ db, leadStallDeps: leadStallDeps(false) });
    const registeredIds = result.registered.map((r) => r.consumerId);
    for (const id of LEAD_STALL_IDS) {
      expect(registeredIds).not.toContain(id);
      expect(ORCHD_SUBSCRIPTIONS.find((s) => s.consumerId === id)).toBeUndefined();
    }
  });

  test("re-bootstrap with the watchdog is idempotent (isNew flips false, no duplicates)", () => {
    const first = bootstrapOrchd({ db, leadStallDeps: leadStallDeps() });
    expect(first.registered.filter((r) => LEAD_STALL_IDS.includes(r.consumerId)).every((r) => r.isNew)).toBe(true);
    const before = ORCHD_SUBSCRIPTIONS.length;
    const second = bootstrapOrchd({ db, leadStallDeps: leadStallDeps() });
    expect(second.registered.filter((r) => LEAD_STALL_IDS.includes(r.consumerId)).every((r) => !r.isNew)).toBe(true);
    expect(ORCHD_SUBSCRIPTIONS.length).toBe(before);
  });
});
