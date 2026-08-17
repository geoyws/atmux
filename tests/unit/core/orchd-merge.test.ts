// Unit tests for src/core/orchd-merge.ts — Phase 3 orchd auto-merge
// subscriber (ADR-226).
//
// Pins:
//   - Kill-switch off (`ATMUX_HONKER=off`) short-circuits to
//     {processed:0, escalated:0} without touching the events table.
//   - Default (unset env) drains via the no-op stub handler.
//   - resolveEpicId 3-stage: payload → tasks.epic col → [e-XXX] subject
//     prefix → null. Per ADR-226 §DA5 + §OQ4 (be-1 verify 2026-05-23).
//   - Subject-prefix regex anchored at start; hex-only chars; no false-
//     positive on prose containing inline "e-..." substrings.
//   - isEpicComplete subject-prefix-aware: catches `[e-XXX]`,
//     `[e-XXX T1]`, `[e-XXX/s-YYY]` shapes (universal NULL on
//     tasks.epic today per §OQ4).
//   - createAutoMergeHandler 6 outcomes:
//       * merged → emit epic.merged + return "merged".
//       * merge-conflict / gate-held → emit epic.merge-blocked +
//         return "escalated".
//       * already-merged → return "skipped-already-merged" (no emit).
//       * skipped-not-mine → return "skipped-not-mine" (no emit).
//       * skipped-no-epic → no dispatch, no emit.
//       * skipped-epic-not-complete → no dispatch, no emit.
//   - withIdempotency wrapper: thrown handler halts drain + offset
//     stays before the failing event (re-sweep contract).

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSince, emit, loadOffset } from "../../../src/abstractions/events.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  type AutoMergeOutcome,
  createAutoMergeHandler,
  type DispatchEpicMergeResult,
  isEpicComplete,
  orchdMergeConsume,
  resolveEpicId,
} from "../../../src/core/orchd-merge.ts";
import type { TaskDonePayload } from "../../../src/schema/events.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

let scratch: string;
let db: Database;
const HONKER_ON: NodeJS.ProcessEnv = { ATMUX_HONKER: "on" };
const HONKER_OFF: NodeJS.ProcessEnv = { ATMUX_HONKER: "off" };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-merge-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function emitTaskDone(n: number, extra: Partial<TaskDonePayload> = {}): void {
  emit(
    db,
    {
      topic: "task.done",
      taskId: `t-${String(n).padStart(8, "0")}`,
      member: "be-1",
      team: "atmux",
      doneAtSec: 1_700_000_000 + n,
      ...extra,
    },
    { generateId: () => fakeId(n), nowSec: () => 1_700_000_000 + n },
  );
}

function insertTask(
  id: string,
  fields: {
    subject?: string;
    status?: string;
    epic?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO tasks (id, subject, status, epic, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, fields.subject ?? null, fields.status ?? "todo", fields.epic ?? null, 1_700_000_000);
}

// ---------- resolveEpicId 3-stage ----------

describe("resolveEpicId (3-stage per ADR-226 §DA5 + §OQ4)", () => {
  test("stage 1: payload.epicId wins when present + non-empty", () => {
    insertTask("t-00000001", { subject: "[e-deadbeef] thing", epic: "e-other" });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      epicId: "e-frompayload",
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBe("e-frompayload");
  });

  test("stage 1: empty-string payload.epicId falls through to stage 2", () => {
    insertTask("t-00000001", { epic: "e-fromcol" });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      epicId: "",
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBe("e-fromcol");
  });

  test("stage 2: tasks.epic column when payload omitted", () => {
    insertTask("t-00000001", { epic: "e-12345abc" });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBe("e-12345abc");
  });

  test("stage 3: [e-XXX] subject prefix when payload + col both null (load-bearing today)", () => {
    insertTask("t-00000001", { subject: "[e-deadbeef T1] do the thing", epic: null });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBe("e-deadbeef");
  });

  test("stage 3: [e-XXX/s-YYY] composite shape also matches (hex bounded)", () => {
    insertTask("t-00000001", {
      subject: "[e-a946af69/s-619616cf] orchd-merge module",
      epic: null,
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBe("e-a946af69");
  });

  test("stage 3: bare [e-XXX] (no suffix) matches", () => {
    insertTask("t-00000001", { subject: "[e-cafebabe] standalone", epic: null });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBe("e-cafebabe");
  });

  test("regex anchored at start: prose containing `e-...` mid-subject does NOT match", () => {
    insertTask("t-00000001", {
      subject: "feat: refer to e-deadbeef from the body, not the prefix",
      epic: null,
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBeNull();
  });

  test("regex hex-only: [e-XYZ123] (non-hex Y, Z) does NOT match — Y is non-hex; capture stops at first non-hex char", () => {
    // Per ADR-058 epic-id charset is lowercase hex 0-9a-f. Hex regex
    // truncates at the first non-hex char — but the `\b` word boundary
    // requires the prior char to be a "word" char (which Y/Z are). So
    // /^\[e-([0-9a-f]+)\b/ exec'd on "[e-XYZ123]" returns null because
    // the FIRST char after "e-" is X (not hex), so the `[0-9a-f]+` does
    // not match (it requires ≥1 hex char immediately).
    insertTask("t-00000001", { subject: "[e-XYZ123] bogus id", epic: null });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBeNull();
  });

  test("all three stages miss → null", () => {
    insertTask("t-00000001", { subject: "no bracket prefix at all", epic: null });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBeNull();
  });

  test("task row missing → null (no crash)", () => {
    // No insertTask call — taskId points to a row that doesn't exist.
    const event = {
      topic: "task.done" as const,
      taskId: "t-ghost",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBeNull();
  });

  test("task row exists but subject is null + epic is null → null", () => {
    insertTask("t-00000001", { epic: null });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(resolveEpicId(event, db)).toBeNull();
  });
});

// ---------- isEpicComplete (subject-prefix-aware §D1 step 3) ----------

describe("isEpicComplete (subject-prefix-aware per ADR-226 §D1 step 3)", () => {
  test("all subject-prefix tasks done → complete", () => {
    insertTask("t-1", { subject: "[e-aaa T1] do it", status: "done" });
    insertTask("t-2", { subject: "[e-aaa T2] verify", status: "done" });
    insertTask("t-3", { subject: "[e-aaa/s-1] story", status: "done" });
    expect(isEpicComplete(db, "e-aaa")).toBe(true);
  });

  test("one subject-prefix task still in-progress → not complete", () => {
    insertTask("t-1", { subject: "[e-aaa T1] do it", status: "done" });
    insertTask("t-2", { subject: "[e-aaa T2] verify", status: "in-progress" });
    expect(isEpicComplete(db, "e-aaa")).toBe(false);
  });

  test("one subject-prefix task still in todo → not complete", () => {
    insertTask("t-1", { subject: "[e-aaa T1] do it", status: "done" });
    insertTask("t-2", { subject: "[e-aaa T2] verify", status: "todo" });
    expect(isEpicComplete(db, "e-aaa")).toBe(false);
  });

  test("`wontfix` status counts as done (gate-passes alongside `done`)", () => {
    insertTask("t-1", { subject: "[e-aaa T1]", status: "wontfix" });
    insertTask("t-2", { subject: "[e-aaa T2]", status: "done" });
    expect(isEpicComplete(db, "e-aaa")).toBe(true);
  });

  test("tasks.epic column populated (future state after `--epic` flag restored) → query catches", () => {
    insertTask("t-1", { subject: "anything", epic: "e-aaa", status: "done" });
    insertTask("t-2", { subject: "anything", epic: "e-aaa", status: "todo" });
    expect(isEpicComplete(db, "e-aaa")).toBe(false);
  });

  test("`[e-aaa]` bare-prefix shape (no suffix) caught by `LIKE '[' || eid || ']%'` branch", () => {
    insertTask("t-1", { subject: "[e-aaa] no T-suffix", status: "todo" });
    expect(isEpicComplete(db, "e-aaa")).toBe(false);
  });

  test("different epic's tasks do NOT count — `e-bbb` open does not affect `e-aaa`", () => {
    insertTask("t-1", { subject: "[e-aaa T1]", status: "done" });
    insertTask("t-2", { subject: "[e-bbb T1]", status: "todo" });
    expect(isEpicComplete(db, "e-aaa")).toBe(true);
  });

  test("empty epic (no tasks anywhere) → vacuously complete (count 0)", () => {
    expect(isEpicComplete(db, "e-nothing")).toBe(true);
  });

  test("prefix substring guard: `[e-aaabb T1]` does NOT match epicId `e-aaa`", () => {
    // The three LIKE branches use `[` || eid || (`]` | ` ` | `/`) so a
    // longer epic id like `e-aaabb` does not collide with `e-aaa`.
    insertTask("t-1", { subject: "[e-aaabb T1] longer epic", status: "todo" });
    expect(isEpicComplete(db, "e-aaa")).toBe(true);
  });
});

// ---------- createAutoMergeHandler outcome paths ----------

describe("createAutoMergeHandler (6 outcomes)", () => {
  test("adapter snapshot is authoritative when supplied", async () => {
    insertTask("t-legacy-open", { epic: "e-aaa", status: "todo" });
    let dispatchCount = 0;
    const externalTask = {
      id: "t-external-done",
      subject: "[e-aaa] external task",
      status: "done",
      epic: "e-aaa",
    } as KanbanTask;
    const handler = createAutoMergeHandler({
      db,
      loadTasks: async () => [externalTask],
      dispatchEpicMerge: async () => {
        dispatchCount += 1;
        return { state: "skipped-not-mine" };
      },
    });

    expect(
      await handler({
        topic: "task.done",
        taskId: externalTask.id,
        member: "be-1",
        team: "atmux",
        doneAtSec: 1,
        eventId: fakeId(1),
        emittedAtSec: 1,
        schemaVersion: 1,
      }),
    ).toBe("skipped-not-mine");
    expect(dispatchCount).toBe(1);
  });

  test("skipped-no-epic when resolveEpicId returns null + no dispatch + no emit", async () => {
    insertTask("t-00000001", { subject: "no prefix here" });
    let dispatchCount = 0;
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => {
        dispatchCount += 1;
        return { state: "skipped-not-mine" };
      },
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("skipped-no-epic");
    expect(dispatchCount).toBe(0);
    // No epic.* event emitted.
    const events = drainSince(db, {
      topics: ["epic.merged", "epic.merge-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(0);
  });

  test("skipped-epic-not-complete when sibling tasks still open + no dispatch", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    insertTask("t-other", { subject: "[e-aaa T2] still open", status: "todo" });
    let dispatchCount = 0;
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => {
        dispatchCount += 1;
        return {
          state: "merged",
          parentBase: "atmux-geoyws",
          mergeSha: "abc1234",
        };
      },
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("skipped-epic-not-complete");
    expect(dispatchCount).toBe(0);
  });

  test("merged → emits epic.merged + returns 'merged'", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({
        state: "merged",
        parentBase: "atmux-geoyws",
        mergeSha: "0123456789abcdef",
      }),
      nowSec: () => 1_700_001_234,
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("merged");
    const events = drainSince(db, { topics: ["epic.merged"], lastEventId: "" });
    expect(events.length).toBe(1);
    expect(events[0]?.topic).toBe("epic.merged");
    expect((events[0] as { epicId: string }).epicId).toBe("e-aaa");
    expect((events[0] as { parentBase: string }).parentBase).toBe("atmux-geoyws");
    expect((events[0] as { mergeSha: string }).mergeSha).toBe("0123456789abcdef");
    expect((events[0] as { mergedAtSec: number }).mergedAtSec).toBe(1_700_001_234);
  });

  test("merge-conflict → emits epic.merge-blocked + returns 'escalated'", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({
        state: "merge-conflict",
        reason: "files X, Y conflict on rebase",
      }),
      nowSec: () => 1_700_002_345,
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("escalated");
    const events = drainSince(db, {
      topics: ["epic.merge-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    expect(events[0]?.topic).toBe("epic.merge-blocked");
    expect((events[0] as { epicId: string }).epicId).toBe("e-aaa");
    expect((events[0] as { reason: string }).reason).toBe("files X, Y conflict on rebase");
    expect((events[0] as { blockedAtSec: number }).blockedAtSec).toBe(1_700_002_345);
  });

  test("gate-held → emits epic.merge-blocked + returns 'escalated'", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({
        state: "gate-held",
        reason: "reviewer-trunk-signoff missing",
      }),
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("escalated");
    const events = drainSince(db, {
      topics: ["epic.merge-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(1);
    expect((events[0] as { reason: string }).reason).toBe("reviewer-trunk-signoff missing");
  });

  test("already-merged → returns 'skipped-already-merged' + NO event emitted", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({ state: "already-merged" }),
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("skipped-already-merged");
    const events = drainSince(db, {
      topics: ["epic.merged", "epic.merge-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(0);
  });

  test("dispatcher returns skipped-not-mine → returns 'skipped-not-mine' + NO event", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({
        state: "skipped-not-mine",
        reason: "epic not in this team's roster",
      }),
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("skipped-not-mine");
    const events = drainSince(db, {
      topics: ["epic.merged", "epic.merge-blocked"],
      lastEventId: "",
    });
    expect(events.length).toBe(0);
  });

  test("default dispatcher (no injection) → skipped-not-mine", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const handler = createAutoMergeHandler({ db });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    expect(await handler(event)).toBe("skipped-not-mine");
  });

  test("logger info/warn invoked appropriately on outcomes", async () => {
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    const infos: string[] = [];
    const warns: string[] = [];
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({
        state: "gate-held",
        reason: "needs signoff",
      }),
      logger: {
        info: (msg) => infos.push(msg),
        warn: (msg) => warns.push(msg),
        error: () => {},
      },
    });
    const event = {
      topic: "task.done" as const,
      taskId: "t-00000001",
      member: "be-1",
      team: "atmux",
      doneAtSec: 1,
      eventId: fakeId(1),
      emittedAtSec: 1,
      schemaVersion: 1 as const,
    };
    await handler(event);
    expect(warns.some((m) => m.includes("gate-held"))).toBe(true);
    expect(infos.length + warns.length).toBeGreaterThan(0);
  });
});

// ---------- Consumer surface (mirrors gitter-consumer) ----------

describe("orchdMergeConsume kill-switch behavior", () => {
  test("ATMUX_HONKER off short-circuits to zero totals without draining", async () => {
    emitTaskDone(1);
    emitTaskDone(2);

    const result = await orchdMergeConsume({ db, env: HONKER_OFF });

    expect(result).toEqual({ processed: 0, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-merge")).toBe("");
  });

  test("ATMUX_HONKER unset drains via default stub handler", async () => {
    emitTaskDone(1);
    const result = await orchdMergeConsume({ db, env: {} });
    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-merge")).toBe(fakeId(1));
  });

  test("short-circuit logs the fallback path", async () => {
    const lines: string[] = [];
    await orchdMergeConsume({
      db,
      env: HONKER_OFF,
      logger: {
        info: (msg) => lines.push(msg),
        warn: () => {},
        error: () => {},
      },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ATMUX_HONKER=off");
  });
});

describe("orchdMergeConsume happy path", () => {
  test("drains N events + calls injected handler for each in event_id order", async () => {
    emitTaskDone(1);
    emitTaskDone(2);
    emitTaskDone(3);

    const seen: string[] = [];
    const handler = async (event: TaskDonePayload): Promise<AutoMergeOutcome> => {
      seen.push(event.taskId);
      return "merged";
    };

    const result = await orchdMergeConsume({ db, env: HONKER_ON, handler });

    expect(result).toEqual({ processed: 3, escalated: 0 });
    expect(seen).toEqual(["t-00000001", "t-00000002", "t-00000003"]);
    expect(loadOffset(db, "atmux:orchd-merge")).toBe(fakeId(3));
  });

  test("counts escalated outcomes separately from processed", async () => {
    emitTaskDone(1);
    emitTaskDone(2);
    emitTaskDone(3);

    const handler = async (event: TaskDonePayload): Promise<AutoMergeOutcome> => {
      return event.taskId === "t-00000002" ? "escalated" : "merged";
    };

    const result = await orchdMergeConsume({ db, env: HONKER_ON, handler });

    expect(result).toEqual({ processed: 3, escalated: 1 });
  });

  test("default stub handler returns 'skipped-no-epic' — advances offset, no escalations", async () => {
    emitTaskDone(1);
    emitTaskDone(2);

    const result = await orchdMergeConsume({ db, env: HONKER_ON });

    expect(result).toEqual({ processed: 2, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-merge")).toBe(fakeId(2));
  });
});

describe("orchdMergeConsume failure mode", () => {
  test("handler throws stops at failing event + offset stays before it", async () => {
    emitTaskDone(1);
    emitTaskDone(2);
    emitTaskDone(3);

    const handler = async (event: TaskDonePayload): Promise<AutoMergeOutcome> => {
      if (event.taskId === "t-00000002") {
        throw new Error("simulated dispatch failure");
      }
      return "merged";
    };

    const result = await orchdMergeConsume({ db, env: HONKER_ON, handler });

    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(loadOffset(db, "atmux:orchd-merge")).toBe(fakeId(1));
  });

  test("re-sweep after fixing the handler resumes from the held offset", async () => {
    emitTaskDone(1);
    emitTaskDone(2);

    let throwOnce = true;
    const handler = async (_event: TaskDonePayload): Promise<AutoMergeOutcome> => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("transient");
      }
      return "merged";
    };

    const first = await orchdMergeConsume({ db, env: HONKER_ON, handler });
    expect(first.processed).toBe(0);
    expect(loadOffset(db, "atmux:orchd-merge")).toBe("");

    const second = await orchdMergeConsume({ db, env: HONKER_ON, handler });
    expect(second.processed).toBe(2);
    expect(loadOffset(db, "atmux:orchd-merge")).toBe(fakeId(2));
  });
});

describe("orchdMergeConsume consumer + topic injection", () => {
  test("custom consumerName isolates offset rows", async () => {
    emitTaskDone(1);
    await orchdMergeConsume({
      db,
      env: HONKER_ON,
      consumerName: "atmux:orchd-merge-shard-A",
      handler: async () => "merged",
    });

    expect(loadOffset(db, "atmux:orchd-merge-shard-A")).toBe(fakeId(1));
    expect(loadOffset(db, "atmux:orchd-merge")).toBe("");
  });

  test("default topics is ['task.done'] — other topics not drained", async () => {
    emit(
      db,
      {
        topic: "commit.landed",
        commitSha: "deadbeef",
        branch: "atmux-geoyws-foo",
        author: "g@x",
        message: "feat: thing",
      },
      { generateId: () => fakeId(1), nowSec: () => 1_700_000_001 },
    );

    const result = await orchdMergeConsume({
      db,
      env: HONKER_ON,
      handler: async () => "merged",
    });

    expect(result).toEqual({ processed: 0, escalated: 0 });
  });
});

// ---------- End-to-end through createAutoMergeHandler + orchdMergeConsume ----------

describe("end-to-end: factory + consumer + dispatcher", () => {
  test("complete-epic happy path emits epic.merged via the consumer", async () => {
    // One task in epic e-aaa, status done. The only open task drives
    // the completion check.
    insertTask("t-00000001", { subject: "[e-aaa T1] last", status: "done" });
    emitTaskDone(1, { epicId: "e-aaa" });

    const dispatchCalls: string[] = [];
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async (epicId) => {
        dispatchCalls.push(epicId);
        return {
          state: "merged",
          parentBase: "atmux-geoyws",
          mergeSha: "feedf00d",
        };
      },
      nowSec: () => 1_700_009_999,
    });

    const result = await orchdMergeConsume({
      db,
      env: HONKER_ON,
      handler,
    });

    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(dispatchCalls).toEqual(["e-aaa"]);
    const merged = drainSince(db, { topics: ["epic.merged"], lastEventId: "" });
    expect(merged.length).toBe(1);
    expect((merged[0] as { mergeSha: string }).mergeSha).toBe("feedf00d");
  });

  test("complete-epic blocked path emits epic.merge-blocked + counts as escalated", async () => {
    insertTask("t-00000001", { subject: "[e-bbb T1] last", status: "done" });
    emitTaskDone(1, { epicId: "e-bbb" });

    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async () => ({
        state: "merge-conflict",
        reason: "conflict in src/foo.ts",
      }),
    });

    const result = await orchdMergeConsume({
      db,
      env: HONKER_ON,
      handler,
    });

    expect(result).toEqual({ processed: 1, escalated: 1 });
    const blocked = drainSince(db, {
      topics: ["epic.merge-blocked"],
      lastEventId: "",
    });
    expect(blocked.length).toBe(1);
    expect((blocked[0] as { reason: string }).reason).toBe("conflict in src/foo.ts");
  });

  test("§OQ4 subject-prefix path: emitter omitted epicId; resolver recovers from subject + dispatches", async () => {
    // Simulates today's reality: tasks.epic is NULL; payload.epicId is
    // omitted by the emitter; only the [e-...] subject prefix survives.
    insertTask("t-00000001", {
      subject: "[e-ccc T1] last open",
      status: "done",
      epic: null,
    });
    emitTaskDone(1); // no epicId in payload

    const dispatchCalls: string[] = [];
    const handler = createAutoMergeHandler({
      db,
      dispatchEpicMerge: async (epicId) => {
        dispatchCalls.push(epicId);
        return {
          state: "merged",
          parentBase: "atmux-geoyws",
          mergeSha: "1234abcd",
        };
      },
    });

    const result = await orchdMergeConsume({
      db,
      env: HONKER_ON,
      handler,
    });

    expect(result).toEqual({ processed: 1, escalated: 0 });
    expect(dispatchCalls).toEqual(["e-ccc"]);
  });
});

// Hint to keep the imports load-bearing for type-only references.
const _typeHints: DispatchEpicMergeResult[] = [
  { state: "merged", parentBase: "x", mergeSha: "y" },
  { state: "merge-conflict", reason: "r" },
  { state: "gate-held", reason: "r" },
  { state: "already-merged" },
  { state: "skipped-not-mine" },
];
void _typeHints;
