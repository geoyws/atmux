// ADR-231 §D6 + ADR-221 §Phase 2 — dissolveSoloWorkerHandler unit coverage.
//
// Pins per t-15-6a65eadb AC:
//   - row-missing → skipped-task-missing
//   - non-solo team prefix → skipped-not-solo-worker
//   - solo + pending owner tasks → skipped-pending-work
//   - solo + all-done → dissolved (atmux team dissolve-worker spawn)
//   - dissolve subprocess failure → escalated + atmux flag add fired
//   - idempotency: re-delivery after dissolve is a clean no-op (atmux
//     team dissolve-worker on already-dissolved worker → handler
//     classifies as escalated when subprocess refuses with non-zero
//     exit; operator triages via flag).

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SpawnOpts,
  SpawnResult,
  spawn as defaultSpawnType,
} from "../../../src/abstractions/spawn.ts";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { emit } from "../../../src/abstractions/events.ts";
import {
  createDissolveSoloWorkerHandler,
  type DissolveSoloWorkerOutcome,
  orchdDissolveSoloWorkerConsume,
} from "../../../src/core/orchd-dissolve-solo-worker.ts";
import type { TaskDonePayload } from "../../../src/schema/events.ts";

const HONKER_ON: NodeJS.ProcessEnv = { ATMUX_HONKER: "on" };
const HONKER_OFF: NodeJS.ProcessEnv = { ATMUX_HONKER: "off" };

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-dsw-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

function fakeId(n: number): string {
  return `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function insertTask(
  id: string,
  fields: {
    owner?: string | null;
    status?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO tasks (id, subject, status, owner, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `task ${id}`, fields.status ?? "done", fields.owner ?? null, 1_700_000_000);
}

function donePayload(taskId: string, team: string, member: string): TaskDonePayload {
  return {
    topic: "task.done",
    taskId,
    member,
    team,
    doneAtSec: 1,
    eventId: fakeId(1),
    emittedAtSec: 1,
    schemaVersion: 1 as const,
  };
}

function stubSpawn(
  scripts: Array<Partial<SpawnResult>>,
): { spawn: typeof defaultSpawnType; calls: SpawnOpts[] } {
  const calls: SpawnOpts[] = [];
  let i = 0;
  const spawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
    calls.push(opts);
    const next = scripts[i++] ?? {};
    return {
      cmd: opts.cmd,
      argv: opts.argv ?? [],
      exitCode: next.exitCode ?? 0,
      signalled: next.signalled ?? null,
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      durationMs: next.durationMs ?? 0,
    };
  }) as typeof defaultSpawnType;
  return { spawn, calls };
}

// ---------- skipped-task-missing ----------

describe("createDissolveSoloWorkerHandler — row missing", () => {
  test("event for unknown task id → skipped-task-missing (no spawn)", async () => {
    const stub = stubSpawn([]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "be-1"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("skipped-task-missing");
    expect(stub.calls).toEqual([]);
  });
});

// ---------- skipped-not-solo-worker ----------

describe("createDissolveSoloWorkerHandler — non-solo team", () => {
  test("team='atmux' (no w- prefix) → skipped-not-solo-worker", async () => {
    insertTask("t-00000001", { owner: "be-1", status: "done" });
    const stub = stubSpawn([]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "atmux", "be-1"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("skipped-not-solo-worker");
    expect(stub.calls).toEqual([]);
  });

  test("team='e-deadbeef' (epic-team prefix, not worker) → skipped-not-solo-worker", async () => {
    insertTask("t-00000002", { owner: "lead", status: "done" });
    const stub = stubSpawn([]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000002", "e-deadbeef", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("skipped-not-solo-worker");
    expect(stub.calls).toEqual([]);
  });

  test("isSoloWorker override stub forces skip regardless of prefix", async () => {
    insertTask("t-00000003", { owner: "lead", status: "done" });
    const stub = stubSpawn([]);
    const handler = createDissolveSoloWorkerHandler({
      db,
      spawn: stub.spawn,
      isSoloWorker: () => false,
    });
    const r = await handler(donePayload("t-00000003", "w-anything", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("skipped-not-solo-worker");
    expect(stub.calls).toEqual([]);
  });
});

// ---------- skipped-pending-work ----------

describe("createDissolveSoloWorkerHandler — solo + pending work", () => {
  test("solo team with one open task by same member → skipped-pending-work", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    insertTask("t-00000002", { owner: "lead", status: "todo" });
    const stub = stubSpawn([]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("skipped-pending-work");
    expect(stub.calls).toEqual([]);
  });

  test("solo team with one in-progress task by same member → skipped-pending-work", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    insertTask("t-00000002", { owner: "lead", status: "in-progress" });
    const stub = stubSpawn([]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("skipped-pending-work");
    expect(stub.calls).toEqual([]);
  });

  test("pending task owned by OTHER member is ignored (per-member gate)", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    insertTask("t-00000002", { owner: "other-member", status: "todo" });
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("dissolved");
    expect(stub.calls).toHaveLength(1);
  });
});

// ---------- dissolved (happy path) ----------

describe("createDissolveSoloWorkerHandler — dissolved (happy path)", () => {
  test("solo + no pending work → spawns dissolve-worker + returns dissolved", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "w-mytask", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("dissolved");

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    if (call === undefined) throw new Error("dissolve spawn call missing");
    expect(call.cmd).toBe("atmux");
    expect(call.argv).toEqual(["team", "dissolve-worker", "w-mytask"]);
  });

  test("event carries the worker-team name verbatim into argv", async () => {
    insertTask("t-00000099", { owner: "be-1", status: "done" });
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    await handler(donePayload("t-00000099", "w-abc123de", "be-1"));
    expect(stub.calls[0]?.argv?.[2]).toBe("w-abc123de");
  });
});

// ---------- escalated (dissolve failure) ----------

describe("createDissolveSoloWorkerHandler — dissolve failure (escalated)", () => {
  test("subprocess non-zero exit → escalated + flag-add fires with stderr tail", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    const stub = stubSpawn([
      { exitCode: 2, stderr: "atmux: dissolve-worker refused: cockpit row missing" },
      { exitCode: 0 }, // flag-add call
    ]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("escalated");

    expect(stub.calls).toHaveLength(2);
    const flagCall = stub.calls[1];
    if (flagCall === undefined) throw new Error("flag spawn call missing");
    expect(flagCall.cmd).toBe("atmux");
    expect(flagCall.argv?.slice(0, 2)).toEqual(["flag", "add"]);
    const body = flagCall.argv?.[2] ?? "";
    expect(body).toContain("w-foo");
    expect(body).toContain("cockpit row missing");
    expect(flagCall.argv).toContain("--severity");
    expect(flagCall.argv).toContain("p1");
    expect(flagCall.argv).toContain("--needs");
    expect(flagCall.argv).toContain("unblock");
  });

  test("subprocess throw (e.g. ENOENT) → escalated + flag fires with throw message", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    let callIdx = 0;
    const spawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
      callIdx += 1;
      if (callIdx === 1) throw new Error("ENOENT: atmux not on PATH");
      // Second call = flag-add; return clean exit.
      return {
        cmd: opts.cmd,
        argv: opts.argv ?? [],
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    }) as typeof defaultSpawnType;
    const handler = createDissolveSoloWorkerHandler({ db, spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("escalated");
    expect(callIdx).toBe(2); // dispatch + flag
  });

  test("flag-add spawn failure is swallowed (best-effort, escalated still returned)", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    let callIdx = 0;
    const spawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
      callIdx += 1;
      if (callIdx === 1) {
        return {
          cmd: opts.cmd,
          argv: opts.argv ?? [],
          exitCode: 1,
          signalled: null,
          stdout: "",
          stderr: "dissolve failed",
          durationMs: 0,
        };
      }
      throw new Error("flag-add subprocess died");
    }) as typeof defaultSpawnType;
    const handler = createDissolveSoloWorkerHandler({ db, spawn });
    const r = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r).toBe<DissolveSoloWorkerOutcome>("escalated");
  });

  test("huge stderr is tailed to last 500 chars in flag body", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    const big = "x".repeat(2000);
    const stub = stubSpawn([
      { exitCode: 1, stderr: big },
      { exitCode: 0 },
    ]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    await handler(donePayload("t-00000001", "w-foo", "lead"));
    const flagBody = stub.calls[1]?.argv?.[2] ?? "";
    // Body has the worker-team header + stderr tail; tail is ≤500 chars.
    const stderrSection = flagBody.slice(flagBody.indexOf("xxx"));
    expect(stderrSection.length).toBeLessThanOrEqual(500 + 8);
  });

  test("empty stderr falls back to stdout for flag tail", async () => {
    insertTask("t-00000001", { owner: "lead", status: "done" });
    const stub = stubSpawn([
      { exitCode: 3, stderr: "", stdout: "cockpit refused — row not found" },
      { exitCode: 0 },
    ]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    await handler(donePayload("t-00000001", "w-foo", "lead"));
    const flagBody = stub.calls[1]?.argv?.[2] ?? "";
    expect(flagBody).toContain("cockpit refused");
  });
});

// ---------- orchdDissolveSoloWorkerConsume (consumer surface) ----------

describe("orchdDissolveSoloWorkerConsume — consumer surface", () => {
  test("ATMUX_HONKER=off → short-circuits to {processed:0, escalated:0}", async () => {
    const r = await orchdDissolveSoloWorkerConsume({ db, env: HONKER_OFF });
    expect(r).toEqual({ processed: 0, escalated: 0 });
  });

  test("default handler (no override) returns skipped-not-solo-worker — drain processes events without escalating", async () => {
    emit(
      db,
      {
        topic: "task.done",
        taskId: "t-00000010",
        member: "be-1",
        team: "atmux",
        doneAtSec: 1_700_000_010,
      },
      { generateId: () => fakeId(10), nowSec: () => 1_700_000_010 },
    );
    const r = await orchdDissolveSoloWorkerConsume({ db, env: HONKER_ON });
    expect(r.processed).toBe(1);
    expect(r.escalated).toBe(0);
  });

  test("handler that returns escalated bumps the escalated counter", async () => {
    emit(
      db,
      {
        topic: "task.done",
        taskId: "t-00000020",
        member: "be-1",
        team: "atmux",
        doneAtSec: 1_700_000_020,
      },
      { generateId: () => fakeId(20), nowSec: () => 1_700_000_020 },
    );
    const r = await orchdDissolveSoloWorkerConsume({
      db,
      env: HONKER_ON,
      handler: async () => "escalated",
    });
    expect(r.processed).toBe(1);
    expect(r.escalated).toBe(1);
  });

  test("custom consumerName + topics survive the drain", async () => {
    emit(
      db,
      {
        topic: "task.done",
        taskId: "t-00000030",
        member: "be-1",
        team: "atmux",
        doneAtSec: 1_700_000_030,
      },
      { generateId: () => fakeId(30), nowSec: () => 1_700_000_030 },
    );
    let seen = 0;
    const r = await orchdDissolveSoloWorkerConsume({
      db,
      env: HONKER_ON,
      consumerName: "atmux:test:custom",
      topics: ["task.done"],
      handler: async () => {
        seen += 1;
        return "dissolved";
      },
      nowSec: () => 1_700_000_100,
    });
    expect(seen).toBe(1);
    expect(r.processed).toBe(1);
    expect(r.escalated).toBe(0);
  });
});

// ---------- idempotency ----------

describe("createDissolveSoloWorkerHandler — idempotency on re-delivery", () => {
  test("re-delivery after dissolve maps refuse-non-zero → escalated (operator triage)", async () => {
    // First delivery: success. Second delivery (sim): worker already
    // gone, dissolve-worker refuses with non-zero. Handler classifies
    // as escalated; operator's flag triage confirms it's the
    // already-dissolved case.
    insertTask("t-00000001", { owner: "lead", status: "done" });
    const stub = stubSpawn([
      { exitCode: 0 }, // first delivery — success
      { exitCode: 2, stderr: "dissolve-worker: no such epic-team w-foo" }, // re-delivery
      { exitCode: 0 }, // flag-add for the failed re-delivery
    ]);
    const handler = createDissolveSoloWorkerHandler({ db, spawn: stub.spawn });
    const r1 = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r1).toBe<DissolveSoloWorkerOutcome>("dissolved");
    const r2 = await handler(donePayload("t-00000001", "w-foo", "lead"));
    expect(r2).toBe<DissolveSoloWorkerOutcome>("escalated");
  });
});
