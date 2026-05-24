// ADR-231 Phase 2 — Integration trigger-matrix test (t-17-d41f607f, S3.2).
//
// Exercises the full §D2/§D4/§D5/§D6 surface end-to-end: Honker event
// → production handler (`createSpawnEpicHandler` / `createDissolveSoloWorkerHandler`)
// → SQLite mutation (`epics.spawned_at`, `epics.extra.spawnPressureDeferred`,
// `epics.extra.spawnFailed`) → `atmux flag add` emission. The cron-only
// + dedup scenarios drive `orchdSweep` directly.
//
// Wires the S3.1 scaffolding (t-16-27fdc08b):
//   - `HonkerMock` — at-least-once dispatch for the event-only scenario.
//   - `seedEpic` / `seedTask` — Zod-validated rows seeded via KanbanRepo.
//   - `SpawnEpicStub` — per-class spawn-epic results (success /
//     host-pressure / eligibility-race / hard-failure / dissolve).
//   - `FlagSpy` — assertion target for §D5 flag emission paths.
//
// Per-scenario isolation: each test gets a fresh in-memory DB + fresh
// migrations + fresh stub/spy instances. No cross-test leakage; nothing
// touches the host's `.atmux/` (atmuxDir is a sentinel path that's only
// passed through to test stubs, not used for I/O — listEpics +
// epicIsEligible are dep-injected).

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SpawnOpts,
  SpawnResult,
  spawn as defaultSpawnType,
} from "../../src/abstractions/spawn.ts";
import { openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import {
  createSpawnEpicHandler,
  HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD,
  type SpawnEpicHandlerOutcome,
} from "../../src/core/orchd-spawn.ts";
import { createDissolveSoloWorkerHandler } from "../../src/core/orchd-dissolve-solo-worker.ts";
import { orchdSweep } from "../../src/core/orchd-sweep.ts";
import { KanbanRepo } from "../../src/core/repositories/kanban-repo.ts";
import { createFlagSpy, type FlagSpy } from "../helpers/atmux-flag-spy.ts";
import { createHonkerMock } from "../helpers/honker-mock.ts";
import { seedEpic, seedTask } from "../helpers/kanban-fixtures.ts";
import {
  CANONICAL_ELIGIBILITY_RACE_STDERR,
  CANONICAL_HARD_FAILURE_STDERR,
  CANONICAL_HOST_PRESSURE_STDERR,
  createSpawnEpicStub,
  ELIGIBILITY_RACE_RESULT,
  HARD_FAILURE_RESULT,
  HOST_PRESSURE_RESULT,
  type SpawnEpicResult,
  type SpawnEpicStub,
  SUCCESS_RESULT,
} from "../helpers/spawn-epic-subprocess-stub.ts";
import type { EpicReadyPayload, TaskDonePayload } from "../../src/schema/events.ts";
import type { Team } from "../../src/schema/team.ts";

// ---------- Per-test fixtures ----------

const PARENT_TEAM: Team = {
  name: "atmux-cage",
  members: [],
};

let scratch: string;
let db: Database;
let atmuxDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-p2-trigger-"));
  atmuxDir = scratch;
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Spawn router ----------
//
// Production handlers shell out to `atmux team spawn-epic ...`,
// `atmux team dissolve-worker ...`, AND `atmux flag add ...` through the
// SAME `spawn` dep. This router parses argv + routes each call to the
// right S3.1 helper (SpawnEpicStub for spawn-epic, FlagSpy for flag-add,
// or an inline dissolveStub for dissolve-worker).

interface RouterDeps {
  spawnEpicStub: SpawnEpicStub;
  flagSpy: FlagSpy;
  /** Inline stub for `atmux team dissolve-worker` — separate from the
   *  spawn-epic stub because dissolve has its own success/escalate
   *  branch in §D6. Records every invocation; tests poll
   *  `.setResult({...})` before publishing the triggering event. */
  dissolveStub: DissolveStub;
  /** Captures argv blobs the router didn't recognise — surfaces
   *  integration-class regressions like a new subprocess shape the
   *  router would otherwise silently no-op on. */
  unrouted: SpawnOpts[];
}

interface DissolveStub {
  setResult: (result: { exitCode: number; stderr?: string }) => void;
  invocations: Array<{ teamName: string }>;
  take: (teamName: string) => { exitCode: number; stderr?: string };
}

function createDissolveStub(): DissolveStub {
  let nextResult: { exitCode: number; stderr?: string } = { exitCode: 0 };
  const invocations: Array<{ teamName: string }> = [];
  return {
    setResult(result: { exitCode: number; stderr?: string }): void {
      nextResult = result;
    },
    invocations,
    take(teamName: string): { exitCode: number; stderr?: string } {
      invocations.push({ teamName });
      return nextResult;
    },
  };
}

function buildSpawnRouter(deps: RouterDeps): typeof defaultSpawnType {
  return (async (opts: SpawnOpts): Promise<SpawnResult> => {
    const argv = opts.argv ?? [];
    const baseResult = {
      cmd: opts.cmd,
      argv,
      signalled: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
    } satisfies Pick<SpawnResult, "cmd" | "argv" | "signalled" | "stdout" | "stderr" | "durationMs">;

    // Recognise `atmux team spawn-epic <epicId> --from <parent> [--roster X] [--force-spawn]`.
    if (argv[0] === "team" && argv[1] === "spawn-epic") {
      const epicId = argv[2] ?? "";
      const fromIdx = argv.indexOf("--from");
      const rosterIdx = argv.indexOf("--roster");
      const force = argv.includes("--force-spawn");
      const result = await deps.spawnEpicStub.invoke({
        epicId,
        roster: rosterIdx >= 0 ? (argv[rosterIdx + 1] ?? "") : "",
        force,
        extraArgs: argv.slice(fromIdx >= 0 ? fromIdx : argv.length),
      });
      return {
        ...baseResult,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    // Recognise `atmux team dissolve-worker <teamName>`.
    if (argv[0] === "team" && argv[1] === "dissolve-worker") {
      const r = deps.dissolveStub.take(argv[2] ?? "");
      return { ...baseResult, exitCode: r.exitCode, stderr: r.stderr ?? "" };
    }

    // Recognise `atmux flag add <body> --severity <s> --needs <n>`.
    if (argv[0] === "flag" && argv[1] === "add") {
      const sevIdx = argv.indexOf("--severity");
      const needsIdx = argv.indexOf("--needs");
      const taskIdx = argv.indexOf("--task");
      await deps.flagSpy.add({
        message: argv[2] ?? "",
        severity: sevIdx >= 0
          ? (argv[sevIdx + 1] as "p0" | "p1" | "p2" | undefined)
          : undefined,
        needs: needsIdx >= 0 ? argv[needsIdx + 1] : undefined,
        taskId: taskIdx >= 0 ? argv[taskIdx + 1] : undefined,
      });
      return { ...baseResult, exitCode: 0 };
    }

    // Anything else: record + return exit 0 so the handler doesn't crash
    // on an unrecognised argv. Tests assert `unrouted` stayed empty as a
    // regression guard.
    deps.unrouted.push(opts);
    return { ...baseResult, exitCode: 0 };
  }) as typeof defaultSpawnType;
}

// ---------- Eligibility stub ----------

function eligibilityAlwaysTrue() {
  return async (_atmuxDir: string, _epicId: string) => ({ eligible: true as const, blockers: [] });
}

function eligibilityAlwaysFalse(blockers: string[] = ["dep e-x not done"]) {
  return async (_atmuxDir: string, _epicId: string) => ({
    eligible: false as const,
    blockers,
  });
}

// ---------- Helpers shared across scenarios ----------

function makeEpicReadyEvent(epicId: string): EpicReadyPayload {
  return {
    topic: "epic.ready",
    epicId,
    transitionedAt: 1_779_540_000,
    eventId: `evt-ready-${epicId}`,
    emittedAtSec: 1_779_540_000,
    schemaVersion: 1,
  };
}

function makeTaskDoneEvent(taskId: string, team: string, member: string): TaskDonePayload {
  return {
    topic: "task.done",
    taskId,
    member,
    team,
    doneAtSec: 1_779_540_000,
    eventId: `evt-done-${taskId}`,
    emittedAtSec: 1_779_540_000,
    schemaVersion: 1,
  };
}

// ---------- §1. Event-only success ----------

describe("ADR-231 §D2/§D4 — event-only success", () => {
  test("epic.ready → spawn handler runs once → spawned_at stamped, NO flag", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-eventok",
        title: "demo: event-only success",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
      nowSec: () => 1_779_540_100,
    });

    // Drive via HonkerMock to exercise the at-least-once seam too.
    const honker = createHonkerMock();
    honker.register({
      topic: "epic.ready",
      consumerId: "atmux:orchd:spawn:on-ready",
      handler: async (event) => {
        await handler({ epicId: (event as EpicReadyPayload).epicId });
      },
    });
    honker.publish(makeEpicReadyEvent("e-eventok"));
    const drained = await honker.drain();

    expect(drained[0]!.delivered).toBe(1);
    expect(spawnEpicStub.invocations).toHaveLength(1);
    expect(spawnEpicStub.invocations[0]!).toMatchObject({
      epicId: "e-eventok",
      roster: "solo",
      force: false,
    });
    expect(flagSpy.calls).toHaveLength(0);
    expect(unrouted).toEqual([]);

    const after = repo.getEpic("e-eventok");
    expect(after!.spawnedAt).toBe(1_779_540_100);
  });
});

// ---------- §2. Cron-only success ----------

describe("ADR-231 §D4 — cron-only success", () => {
  test("orchdSweep walks eligible+autoSpawn epics → spawn handler fires", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-cronok",
        title: "demo: cron-only success",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
      nowSec: () => 1_779_540_200,
    });

    const result = await orchdSweep(atmuxDir, {
      listEpics: async () => repo.listEpics(),
      epicIsEligible: eligibilityAlwaysTrue(),
      effectiveAutoSpawn: (epic) => epic.extra?.autoSpawn?.enabled === true,
      spawnEpicHandler: async (_atmuxDir, epic) => {
        const outcome = await handler({ epicId: epic.id });
        if (outcome === "spawned") return "spawned";
        if (outcome === "flag-raised") return "flag-raised";
        return "skipped";
      },
    });

    expect(result.epicsConsidered).toBe(1);
    expect(result.epicsSpawned).toBe(1);
    expect(spawnEpicStub.invocations).toHaveLength(1);
    expect(spawnEpicStub.invocations[0]!.epicId).toBe("e-cronok");
    expect(flagSpy.calls).toHaveLength(0);
    expect(repo.getEpic("e-cronok")!.spawnedAt).toBe(1_779_540_200);
  });
});

// ---------- §3. Both-fire dedup ----------

describe("ADR-231 §D2 — both-fire dedup (event then cron)", () => {
  test("event-driven spawn THEN cron sweep → spawn-epic called ONCE total", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-dedup",
        title: "demo: dedup",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
      nowSec: () => 1_779_540_300,
    });

    // Step 1 — event-driven spawn (success → stamps spawned_at).
    const firstOutcome = await handler({ epicId: "e-dedup" });
    expect(firstOutcome).toBe<SpawnEpicHandlerOutcome>("spawned");

    // Step 2 — cron sweep on the SAME db. Handler's dedup gate (§D2
    // step 2) should short-circuit on the populated spawned_at. Walker's
    // own pre-filter (§D4 step 2.a) also short-circuits — both layers
    // skip; we expect the spawn stub to NOT be invoked again.
    const sweep = await orchdSweep(atmuxDir, {
      listEpics: async () => repo.listEpics(),
      epicIsEligible: eligibilityAlwaysTrue(),
      effectiveAutoSpawn: (epic) => epic.extra?.autoSpawn?.enabled === true,
      spawnEpicHandler: async (_atmuxDir, epic) => {
        const outcome = await handler({ epicId: epic.id });
        if (outcome === "spawned") return "spawned";
        if (outcome === "flag-raised") return "flag-raised";
        return "skipped";
      },
    });

    expect(sweep.epicsSpawned).toBe(0); // walker pre-filter skipped via spawnedAt
    expect(spawnEpicStub.invocations).toHaveLength(1); // only the event-driven one
  });
});

// ---------- §4. Eligibility-race (transient classifier hit) ----------

describe("ADR-231 §D5 — eligibility-race (transient classifier)", () => {
  test("spawn-epic returns eligible=false stderr → silent skip, no flag, spawned_at stays null", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-elig-race",
        title: "demo: eligibility race",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    spawnEpicStub.setResult(ELIGIBILITY_RACE_RESULT);
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
    });

    const outcome = await handler({ epicId: "e-elig-race" });

    expect(outcome).toBe<SpawnEpicHandlerOutcome>("skipped-eligibility-race");
    expect(spawnEpicStub.invocations).toHaveLength(1);
    expect(spawnEpicStub.invocations[0]!.epicId).toBe("e-elig-race");
    expect(spawnEpicStub.invocations[0]!.extraArgs[0]).toBe("--from");
    expect(flagSpy.calls).toHaveLength(0); // ADR-231 §D5: eligibility-race is silent
    expect(repo.getEpic("e-elig-race")!.spawnedAt).toBeNull();
    // Stderr the stub emitted matches the production classifier regex
    // (defense-in-depth: catches drift between this test's canonical
    // string + the classifier in orchd-spawn-classify.ts).
    expect(/eligible=false:\s/.test(CANONICAL_ELIGIBILITY_RACE_STDERR)).toBe(true);
  });
});

// ---------- §5. Host-pressure deferred ≥ threshold ----------

describe("ADR-231 §D5 — host-pressure deferred ≥3 → flag", () => {
  test("3× host-pressure stderr → counter increments to threshold, flag emitted on 3rd", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-hp",
        title: "demo: host-pressure",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    spawnEpicStub.setResult(HOST_PRESSURE_RESULT);
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
    });

    // Fire the handler `THRESHOLD` times — first (THRESHOLD-1) should
    // increment without emitting a flag; the Nth should emit one.
    expect(HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD).toBe(3); // sanity-check
    for (let i = 1; i <= HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD; i++) {
      const outcome = await handler({ epicId: "e-hp" });
      expect(outcome).toBe<SpawnEpicHandlerOutcome>("skipped-host-pressure");
      const epicNow = repo.getEpic("e-hp");
      expect(epicNow!.extra?.spawnPressureDeferred).toBe(i);

      if (i < HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD) {
        expect(flagSpy.calls).toHaveLength(0);
      } else {
        // Flag fires AT the threshold.
        expect(flagSpy.calls).toHaveLength(1);
        const flagged = flagSpy.calls[0]!;
        expect(flagged.message).toMatch(/host-pressure-deferred for epic=e-hp/);
        expect(flagged.message).toMatch(/counter=3/);
        expect(flagged.severity).toBe("p1");
        expect(flagged.needs).toBe("context");
      }
    }

    // spawned_at stays null across all attempts — cron --sweep is the
    // designated retry vehicle, per ADR-231 anti-retry-storm doctrine.
    expect(repo.getEpic("e-hp")!.spawnedAt).toBeNull();
    expect(spawnEpicStub.invocations).toHaveLength(HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD);
    expect(unrouted).toEqual([]);
  });
});

// ---------- §6. Hard failure ----------

describe("ADR-231 §D5 — hard failure (neither transient signature)", () => {
  test("non-transient stderr → flag emitted, extra.spawnFailed populated, no retry", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-hard",
        title: "demo: hard",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    spawnEpicStub.setResult(HARD_FAILURE_RESULT);
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
      nowSec: () => 1_779_540_400,
    });

    const outcome = await handler({ epicId: "e-hard" });
    expect(outcome).toBe<SpawnEpicHandlerOutcome>("flag-raised");

    const after = repo.getEpic("e-hard");
    expect(after!.spawnedAt).toBeNull(); // §D2 dedup gate stays open

    // §D5 hard-failure receipt: extra.spawnFailed = { at, stderrTail }.
    const failedReceipt = (after!.extra as { spawnFailed?: { at: number; stderrTail: string } })
      .spawnFailed;
    expect(failedReceipt).toBeDefined();
    expect(failedReceipt!.at).toBe(1_779_540_400);
    expect(failedReceipt!.stderrTail).toBe(CANONICAL_HARD_FAILURE_STDERR);

    // Flag emitted with p1 + unblock (operator-action-required tier).
    expect(flagSpy.calls).toHaveLength(1);
    const flagged = flagSpy.calls[0]!;
    expect(flagged.message).toMatch(/HARD failure for epic=e-hard/);
    expect(flagged.severity).toBe("p1");
    expect(flagged.needs).toBe("unblock");

    expect(spawnEpicStub.invocations).toHaveLength(1);
  });

  test("hard-failure stderr is NOT classified as either transient (regex sanity)", () => {
    // Defense-in-depth — if a future refactor changes the canonical
    // hard-failure fixture, the production classifier's regexes must
    // STILL NOT match it (otherwise §D5 hard path collapses into a
    // transient path + the operator loses visibility).
    expect(/host-wide cap\s*\(\d+\)\s*reached/.test(CANONICAL_HARD_FAILURE_STDERR)).toBe(false);
    expect(/eligible=false:\s/.test(CANONICAL_HARD_FAILURE_STDERR)).toBe(false);
  });
});

// ---------- §7. Solo-worker dissolve ----------

describe("ADR-231 §D6 — solo-worker dissolve (task.done topic)", () => {
  test("task.done for solo-worker w/ all tasks done → dissolve-worker subprocess, no flag", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertTask(
      seedTask({
        id: "t-aaaaaaa1",
        status: "done",
        owner: "worker-0",
        completedAt: 1_779_540_500,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    dissolveStub.setResult({ exitCode: 0 });
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createDissolveSoloWorkerHandler({
      db,
      spawn: router,
      isSoloWorker: (teamName) => teamName.startsWith("w-"),
    });

    // Drive via HonkerMock — task.done event matches the §D6 subscriber
    // topic.
    const honker = createHonkerMock();
    honker.register({
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-solo-worker",
      handler: async (event) => {
        await handler(event as TaskDonePayload);
      },
    });
    honker.publish(makeTaskDoneEvent("t-aaaaaaa1", "w-solo-test", "worker-0"));
    const drained = await honker.drain();

    expect(drained[0]!.delivered).toBe(1);
    expect(dissolveStub.invocations).toEqual([{ teamName: "w-solo-test" }]);
    expect(flagSpy.calls).toHaveLength(0); // success path is silent
    expect(spawnEpicStub.invocations).toHaveLength(0); // wrong handler topic
    expect(unrouted).toEqual([]);
  });

  test("dissolve subprocess exit non-zero → flag emitted, outcome=escalated", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertTask(
      seedTask({
        id: "t-bbbbbbb1",
        status: "done",
        owner: "worker-0",
        completedAt: 1_779_540_500,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    dissolveStub.setResult({ exitCode: 1, stderr: "dissolve-worker: refused (no such team)" });
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createDissolveSoloWorkerHandler({
      db,
      spawn: router,
      isSoloWorker: (teamName) => teamName.startsWith("w-"),
    });

    const outcome = await handler(
      makeTaskDoneEvent("t-bbbbbbb1", "w-solo-fail", "worker-0"),
    );

    expect(outcome).toBe("escalated");
    expect(dissolveStub.invocations).toEqual([{ teamName: "w-solo-fail" }]);
    expect(flagSpy.calls).toHaveLength(1);
    expect(flagSpy.calls[0]!.message).toMatch(/dissolve failed for worker-team w-solo-fail/);
    expect(flagSpy.calls[0]!.severity).toBe("p1");
    expect(flagSpy.calls[0]!.needs).toBe("unblock");
  });
});

// ---------- §8. Handler-level dedup (defensive re-check vs walker pre-filter) ----------

describe("ADR-231 §D2 step 2 — handler-level dedup gate (independent of sweep pre-filter)", () => {
  test("calling handler twice on same epic → second invocation hits dedup gate", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-handler-dedup",
        title: "demo: handler dedup",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
      nowSec: () => 1_779_540_600,
    });

    const first = await handler({ epicId: "e-handler-dedup" });
    expect(first).toBe<SpawnEpicHandlerOutcome>("spawned");

    // Second invocation — handler's own §D2 step 2 dedup gate fires
    // because spawnedAt is now populated on the repo read. spawn-epic
    // stub must NOT be invoked again. This validates the kanban-repo
    // spawned_at column read (the surface be-1 fixed in 9e7f344).
    const second = await handler({ epicId: "e-handler-dedup" });
    expect(second).toBe<SpawnEpicHandlerOutcome>("skipped-already-spawned");
    expect(spawnEpicStub.invocations).toHaveLength(1);
  });
});

// ---------- §9. Row-missing + autoSpawn-off + pre-spawn eligibility-false ----------

describe("ADR-231 §D2 — silent-skip branches (row missing / autoSpawn off / eligibility predicate held)", () => {
  test("epicId with no row in db → skipped-row-missing (no spawn, no flag)", async () => {
    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
    });

    const outcome = await handler({ epicId: "e-ghost" });
    expect(outcome).toBe<SpawnEpicHandlerOutcome>("skipped-row-missing");
    expect(spawnEpicStub.invocations).toEqual([]);
    expect(flagSpy.calls).toEqual([]);
  });

  test("epic with extra.autoSpawn.enabled=false → skipped-autospawn-off (per-epic explicit wins)", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-autospawn-off",
        title: "demo: off",
        autoSpawn: { enabled: false }, // explicit-false per §D3 precedence rule
        spawnedAt: null,
        isReady: true,
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysTrue(),
    });

    const outcome = await handler({ epicId: "e-autospawn-off" });
    expect(outcome).toBe<SpawnEpicHandlerOutcome>("skipped-autospawn-off");
    expect(spawnEpicStub.invocations).toEqual([]);
  });

  test("pre-spawn eligibility predicate held → skipped-eligibility-race (NO spawn subprocess fired)", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-elig-pre",
        title: "demo: elig pre",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
        dependsOn: ["e-upstream-blocker"],
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: eligibilityAlwaysFalse(["dep e-upstream-blocker not done"]),
    });

    const outcome = await handler({ epicId: "e-elig-pre" });
    expect(outcome).toBe<SpawnEpicHandlerOutcome>("skipped-eligibility-race");
    expect(spawnEpicStub.invocations).toEqual([]); // gate fires BEFORE spawn
    expect(flagSpy.calls).toEqual([]); // silent per §D5
  });
});

// ---------- §10. forceSpawn bypass + spawn-throws ----------

describe("ADR-231 §D2 — forceSpawn bypass + spawn-throws hard-flag path", () => {
  test("epic.extra.autoSpawn.forceSpawn=true → eligibility check SKIPPED, spawn called with --force-spawn", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-force",
        title: "demo: force",
        autoSpawn: { enabled: true, roster: "solo", forceSpawn: true },
        spawnedAt: null,
        isReady: false, // would be ineligible if checked
      }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    let eligibilityCalls = 0;
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: router,
      epicIsEligible: async (_atmuxDir, _epicId) => {
        eligibilityCalls += 1;
        return { eligible: false as const, blockers: ["should-not-be-checked"] };
      },
      nowSec: () => 1_779_540_700,
    });

    const outcome = await handler({ epicId: "e-force" });
    expect(outcome).toBe<SpawnEpicHandlerOutcome>("spawned");
    expect(eligibilityCalls).toBe(0); // forceSpawn=true → no eligibility probe
    expect(spawnEpicStub.invocations).toHaveLength(1);
    expect(spawnEpicStub.invocations[0]!.force).toBe(true);
    expect(repo.getEpic("e-force")!.spawnedAt).toBe(1_779_540_700);
  });

  test("spawn fn throws → flag-raised, extra.spawnFailed populated with 'spawn threw:' tail", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertEpic(
      seedEpic({
        id: "e-throw",
        title: "demo: throw",
        autoSpawn: { enabled: true, roster: "solo" },
        spawnedAt: null,
        isReady: true,
      }),
    );

    const flagSpy = createFlagSpy();
    // Custom spawn fn — throws ONLY for `team spawn-epic`; routes
    // `flag add` to the spy so we can still assert flag emission.
    const throwingSpawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
      const argv = opts.argv ?? [];
      if (argv[0] === "team" && argv[1] === "spawn-epic") {
        throw new Error("simulated subprocess explosion");
      }
      if (argv[0] === "flag" && argv[1] === "add") {
        const sevIdx = argv.indexOf("--severity");
        const needsIdx = argv.indexOf("--needs");
        await flagSpy.add({
          message: argv[2] ?? "",
          severity: sevIdx >= 0
            ? (argv[sevIdx + 1] as "p0" | "p1" | "p2" | undefined)
            : undefined,
          needs: needsIdx >= 0 ? argv[needsIdx + 1] : undefined,
        });
        return {
          cmd: opts.cmd,
          argv,
          exitCode: 0,
          signalled: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
        };
      }
      throw new Error(`unrouted: ${argv.join(" ")}`);
    }) as typeof defaultSpawnType;

    const handler = createSpawnEpicHandler({
      db,
      atmuxDir,
      team: PARENT_TEAM,
      spawn: throwingSpawn,
      epicIsEligible: eligibilityAlwaysTrue(),
      nowSec: () => 1_779_540_800,
    });

    const outcome = await handler({ epicId: "e-throw" });
    expect(outcome).toBe<SpawnEpicHandlerOutcome>("flag-raised");

    const after = repo.getEpic("e-throw");
    expect(after!.spawnedAt).toBeNull();
    const failed = (after!.extra as { spawnFailed?: { at: number; stderrTail: string } })
      .spawnFailed;
    expect(failed).toBeDefined();
    expect(failed!.at).toBe(1_779_540_800);
    expect(failed!.stderrTail).toMatch(/spawn threw: simulated subprocess explosion/);
    expect(flagSpy.calls).toHaveLength(1);
    expect(flagSpy.calls[0]!.message).toMatch(/HARD failure for epic=e-throw/);
  });
});

// ---------- §11. Dissolve handler — silent-skip branches ----------

describe("ADR-231 §D6 — dissolve silent-skip branches", () => {
  test("task.done for unknown task id → skipped-task-missing (no dissolve subprocess)", async () => {
    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createDissolveSoloWorkerHandler({
      db,
      spawn: router,
      isSoloWorker: (teamName) => teamName.startsWith("w-"),
    });

    const outcome = await handler(makeTaskDoneEvent("t-ghost", "w-ghost", "worker-0"));
    expect(outcome).toBe("skipped-task-missing");
    expect(dissolveStub.invocations).toEqual([]);
    expect(flagSpy.calls).toEqual([]);
  });

  test("task.done for non-solo team prefix → skipped-not-solo-worker", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertTask(
      seedTask({ id: "t-notsolo", status: "done", owner: "be-1" }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createDissolveSoloWorkerHandler({
      db,
      spawn: router,
      isSoloWorker: (teamName) => teamName.startsWith("w-"),
    });

    // team='atmux-cage' has no `w-` prefix → handler's solo classifier
    // refuses, even though the task row exists + is done.
    const outcome = await handler(makeTaskDoneEvent("t-notsolo", "atmux-cage", "be-1"));
    expect(outcome).toBe("skipped-not-solo-worker");
    expect(dissolveStub.invocations).toEqual([]);
  });

  test("solo team but owner has pending tasks → skipped-pending-work (no dissolve)", async () => {
    const repo = new KanbanRepo(db);
    repo.upsertTask(
      seedTask({ id: "t-done-1", status: "done", owner: "worker-0" }),
    );
    repo.upsertTask(
      seedTask({ id: "t-pending-1", status: "in-progress", owner: "worker-0" }),
    );

    const spawnEpicStub = createSpawnEpicStub();
    const flagSpy = createFlagSpy();
    const dissolveStub = createDissolveStub();
    const unrouted: SpawnOpts[] = [];
    const router = buildSpawnRouter({ spawnEpicStub, flagSpy, dissolveStub, unrouted });

    const handler = createDissolveSoloWorkerHandler({
      db,
      spawn: router,
      isSoloWorker: (teamName) => teamName.startsWith("w-"),
    });

    const outcome = await handler(makeTaskDoneEvent("t-done-1", "w-solo-pending", "worker-0"));
    expect(outcome).toBe("skipped-pending-work");
    expect(dissolveStub.invocations).toEqual([]);
  });
});

// ---------- Cross-class invariant — canonical stderr fixtures track production regexes ----------

describe("integration-class invariant — S3.1 canonical stderr matches t-13 classifier", () => {
  test("host-pressure canonical text matches /host-wide cap (\\d+) reached/", () => {
    expect(/host-wide cap\s*\(\d+\)\s*reached/.test(CANONICAL_HOST_PRESSURE_STDERR)).toBe(true);
  });
  test("eligibility-race canonical text matches /eligible=false: /", () => {
    expect(/eligible=false:\s/.test(CANONICAL_ELIGIBILITY_RACE_STDERR)).toBe(true);
  });
  test("success result has empty stderr (classifier returns 'hard' on empty — won't fire because exitCode=0)", () => {
    expect(SUCCESS_RESULT.stderr).toBe("");
    expect(SUCCESS_RESULT.exitCode).toBe(0);
  });
});
