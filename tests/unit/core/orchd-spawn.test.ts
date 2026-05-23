// ADR-231 §D2 + §D3 — spawnEpicHandler + effectiveAutoSpawn unit coverage.
//
// Pins per t-14-c27cdce1 AC (§D2 5-step branch matrix):
//   1. row-missing → skipped-row-missing
//   2. spawned_at set → skipped-already-spawned
//   3. autoSpawn off → skipped-autospawn-off
//   4. eligibility false → skipped-eligibility-race
//   5. spawn-success → spawned + spawned_at stamped
//   6a. hard failure → flag-raised + extra.spawnFailed written
//   6b. host-pressure < threshold → skipped-host-pressure + counter++
//   6c. host-pressure ≥ threshold → skipped-host-pressure + flag emitted
//   6d. eligibility-race transient → skipped-eligibility-race silent
//
// effectiveAutoSpawn (§D3 precedence):
//   - per-epic explicit true → wins
//   - per-epic explicit false → wins (defeats per-team match)
//   - per-team defaults[] first-match → wins
//   - no match → enabled false
//
// Idempotency: re-delivery after spawn-success is no-op (spawned_at
// dedup-gate fires at step 2).

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
import {
  createSpawnEpicHandler,
  effectiveAutoSpawn,
  HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD,
  type SpawnEpicHandlerOutcome,
} from "../../../src/core/orchd-spawn.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import type { KanbanEpic } from "../../../src/schema/kanban.ts";
import type { Team } from "../../../src/schema/team.ts";

// ---------- Fixtures ----------

const TEAM_BARE: Team = {
  name: "demo-cage",
  members: [],
};

const TEAM_WITH_DEFAULTS: Team = {
  name: "demo-cage",
  members: [],
  autoSpawn: {
    defaults: [
      { match: "^demo:", roster: "solo", autoSpawn: true },
      { match: "^prod:", roster: "backend-heavy", autoSpawn: true, forceSpawn: true },
    ],
  },
};

function makeEpic(overrides: Partial<KanbanEpic> = {}): KanbanEpic {
  return {
    id: "e-test",
    title: "demo: test epic",
    status: "planning",
    isReady: true,
    dependsOn: [],
    ...overrides,
  };
}

function insertEpic(db: Database, epic: KanbanEpic): void {
  new KanbanRepo(db).upsertEpic(epic);
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

let scratch: string;
let db: Database;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-spawn-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
});

afterEach(async () => {
  db.close();
  await rm(scratch, { recursive: true, force: true });
});

// ---------- effectiveAutoSpawn (§D3) ----------

describe("effectiveAutoSpawn — §D3 precedence", () => {
  test("per-epic explicit enabled=true wins (overrides team defaults)", () => {
    const epic = makeEpic({ extra: { autoSpawn: { enabled: true, roster: "solo" } } });
    expect(effectiveAutoSpawn(epic, TEAM_WITH_DEFAULTS)).toEqual({
      enabled: true,
      roster: "solo",
    });
  });

  test("per-epic explicit enabled=false wins (defeats per-team default)", () => {
    // Even though the team has a defaults[] entry matching "demo: …",
    // the explicit false on the epic wins.
    const epic = makeEpic({ title: "demo: x", extra: { autoSpawn: { enabled: false } } });
    expect(effectiveAutoSpawn(epic, TEAM_WITH_DEFAULTS)).toEqual({ enabled: false });
  });

  test("per-epic explicit carries forceSpawn through", () => {
    const epic = makeEpic({
      extra: { autoSpawn: { enabled: true, roster: "x", forceSpawn: true } },
    });
    expect(effectiveAutoSpawn(epic, TEAM_BARE)).toEqual({
      enabled: true,
      roster: "x",
      forceSpawn: true,
    });
  });

  test("per-team defaults[] first-match wins when per-epic absent", () => {
    const epic = makeEpic({ title: "demo: foo" });
    expect(effectiveAutoSpawn(epic, TEAM_WITH_DEFAULTS)).toEqual({
      enabled: true,
      roster: "solo",
    });
  });

  test("per-team defaults[] second-entry matches when first doesn't", () => {
    const epic = makeEpic({ title: "prod: deploy" });
    expect(effectiveAutoSpawn(epic, TEAM_WITH_DEFAULTS)).toEqual({
      enabled: true,
      roster: "backend-heavy",
      forceSpawn: true,
    });
  });

  test("no per-epic + no per-team match → enabled false", () => {
    const epic = makeEpic({ title: "unrelated thing" });
    expect(effectiveAutoSpawn(epic, TEAM_WITH_DEFAULTS)).toEqual({ enabled: false });
  });

  test("team config absent → enabled false (no per-epic config)", () => {
    const epic = makeEpic({ title: "demo: x" });
    expect(effectiveAutoSpawn(epic, undefined)).toEqual({ enabled: false });
  });

  test("empty title + per-team defaults → enabled false (regex needs something to match)", () => {
    const epic = makeEpic({ title: "" });
    expect(effectiveAutoSpawn(epic, TEAM_WITH_DEFAULTS)).toEqual({ enabled: false });
  });

  test("invalid regex in entry → graceful (caught by try/catch; no throw)", () => {
    const team: Team = {
      name: "x",
      members: [],
      autoSpawn: {
        defaults: [
          // The Zod refine catches this at parse-time, but defensively
          // pass through if a non-Zod path loads team.json with a bad
          // regex. effectiveAutoSpawn should NOT throw.
          { match: "[unclosed", roster: "x", autoSpawn: true },
          { match: "demo:", roster: "fallback", autoSpawn: true },
        ],
      },
    };
    const epic = makeEpic({ title: "demo: anything" });
    expect(effectiveAutoSpawn(epic, team)).toEqual({
      enabled: true,
      roster: "fallback",
    });
  });
});

// ---------- spawnEpicHandler (§D2 5-step matrix) ----------

describe("createSpawnEpicHandler — §D2 step 1: row-missing", () => {
  test("event for unknown epic id → skipped-row-missing (no spawn)", async () => {
    const stub = stubSpawn([]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
    });
    const r = await handler({ epicId: "e-nope" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-row-missing");
    expect(stub.calls).toEqual([]);
  });
});

describe("createSpawnEpicHandler — §D2 step 2: dedup gate", () => {
  test("epic.spawned_at set → skipped-already-spawned (no spawn)", async () => {
    insertEpic(db, makeEpic({ spawnedAt: 1_700_000_000 }));
    const stub = stubSpawn([]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      // resolveAutoSpawn would otherwise return true; the dedup gate
      // fires BEFORE the autoSpawn check.
      effectiveAutoSpawn: () => ({ enabled: true }),
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-already-spawned");
    expect(stub.calls).toEqual([]);
  });
});

describe("createSpawnEpicHandler — §D2 step 3: autoSpawn gate", () => {
  test("autoSpawn disabled → skipped-autospawn-off (no spawn, no eligibility check)", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([]);
    let eligibilityCalled = false;
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: false }),
      epicIsEligible: async () => {
        eligibilityCalled = true;
        return { eligible: true, blockers: [] };
      },
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-autospawn-off");
    expect(stub.calls).toEqual([]);
    expect(eligibilityCalled).toBe(false);
  });
});

describe("createSpawnEpicHandler — §D2 step 4: eligibility gate", () => {
  test("ADR-225 predicate false → skipped-eligibility-race (no spawn)", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "solo" }),
      epicIsEligible: async () => ({
        eligible: false,
        blockers: ["dep e-aaaa not done"],
      }),
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-eligibility-race");
    expect(stub.calls).toEqual([]);
  });

  test("forceSpawn=true bypasses eligibility (calls spawn-epic anyway)", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([{ exitCode: 0 }]);
    let eligibilityCalled = false;
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x", forceSpawn: true }),
      epicIsEligible: async () => {
        eligibilityCalled = true;
        return { eligible: false, blockers: [] };
      },
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("spawned");
    expect(eligibilityCalled).toBe(false);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("createSpawnEpicHandler — §D2 step 5: spawn-success", () => {
  test("exit 0 → spawned + spawned_at stamped + correct argv", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "solo" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
      nowSec: () => 1_700_000_100,
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("spawned");

    // spawned_at stamped to the injected nowSec
    const epic = new KanbanRepo(db).getEpic("e-test");
    expect(epic?.spawnedAt).toBe(1_700_000_100);

    // argv shape per ADR-090 §spawn-epic
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    if (call === undefined) throw new Error("spawn call missing");
    expect(call.cmd).toBe("atmux");
    expect(call.argv).toEqual([
      "team",
      "spawn-epic",
      "e-test",
      "--from",
      "demo-cage",
      "--roster",
      "solo",
    ]);
    expect(call.cwd).toBe(scratch);
    // ADR-231 §D5 amendment 2026-05-23 — orchd passes
    // ATMUX_CALLER_SCOPE=driver so ADR-033 caller-scope gate accepts
    // the call from cron context.
    expect(call.env).toEqual({ ATMUX_CALLER_SCOPE: "driver" });
  });

  test("forceSpawn=true adds --force-spawn to argv", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x", forceSpawn: true }),
    });
    await handler({ epicId: "e-test" });
    const call = stub.calls[0];
    if (call === undefined) throw new Error("spawn call missing");
    expect(call.argv).toContain("--force-spawn");
  });

  test("absent roster omits --roster from argv", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
    });
    await handler({ epicId: "e-test" });
    const call = stub.calls[0];
    if (call === undefined) throw new Error("spawn call missing");
    expect(call.argv).not.toContain("--roster");
  });
});

describe("createSpawnEpicHandler — §D2 step 6a: hard failure", () => {
  test("non-zero exit + hard class → flag-raised + extra.spawnFailed written", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([
      { exitCode: 1, stderr: "spawn-epic: unknown roster 'whoops'" },
      { exitCode: 0 }, // flag-add call
    ]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "whoops" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
      nowSec: () => 1_700_000_200,
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("flag-raised");

    // extra.spawnFailed persisted with at + stderrTail
    const epic = new KanbanRepo(db).getEpic("e-test");
    const extra = epic?.extra as { spawnFailed?: { at: number; stderrTail: string } };
    expect(extra.spawnFailed?.at).toBe(1_700_000_200);
    expect(extra.spawnFailed?.stderrTail).toContain("spawn-epic: unknown roster");

    // spawned_at NOT stamped on failure
    expect(epic?.spawnedAt).toBeNull();

    // Flag-add call fired
    expect(stub.calls).toHaveLength(2);
    const flagCall = stub.calls[1];
    if (flagCall === undefined) throw new Error("flag spawn call missing");
    expect(flagCall.argv?.slice(0, 2)).toEqual(["flag", "add"]);
    expect(flagCall.argv).toContain("--severity");
    expect(flagCall.argv).toContain("p1");
  });

  test("spawn-throw → flag-raised + extra.spawnFailed carries throw message", async () => {
    insertEpic(db, makeEpic());
    let callIdx = 0;
    const spawn = (async (opts: SpawnOpts): Promise<SpawnResult> => {
      callIdx += 1;
      if (callIdx === 1) throw new Error("ENOENT: atmux not on PATH");
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
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("flag-raised");
    const epic = new KanbanRepo(db).getEpic("e-test");
    const extra = epic?.extra as { spawnFailed?: { stderrTail: string } };
    expect(extra.spawnFailed?.stderrTail).toContain("ENOENT");
  });
});

describe("createSpawnEpicHandler — §D2 step 6b/6c: host-pressure transient", () => {
  test("host-pressure < threshold → skipped-host-pressure + counter increments", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([{ exitCode: 75, stderr: "host-wide cap (8) reached" }]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-host-pressure");

    const epic = new KanbanRepo(db).getEpic("e-test");
    const extra = epic?.extra as { spawnPressureDeferred?: number };
    expect(extra.spawnPressureDeferred).toBe(1);
    // No flag-add at counter=1 (under threshold)
    expect(stub.calls).toHaveLength(1);
  });

  test("host-pressure ≥ threshold → flag emitted + counter persists", async () => {
    insertEpic(
      db,
      makeEpic({
        extra: { spawnPressureDeferred: HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD - 1 },
      }),
    );
    const stub = stubSpawn([
      { exitCode: 75, stderr: "host-wide cap (8) reached" },
      { exitCode: 0 }, // flag-add
    ]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-host-pressure");

    const epic = new KanbanRepo(db).getEpic("e-test");
    const extra = epic?.extra as { spawnPressureDeferred?: number };
    expect(extra.spawnPressureDeferred).toBe(HOST_PRESSURE_DEFERRED_FLAG_THRESHOLD);

    // Flag-add fired at threshold
    expect(stub.calls).toHaveLength(2);
    const flagCall = stub.calls[1];
    if (flagCall === undefined) throw new Error("flag call missing");
    const body = flagCall.argv?.[2] ?? "";
    expect(body).toContain("host-pressure-deferred");
    expect(body).toContain("e-test");
    expect(flagCall.argv).toContain("--needs");
    expect(flagCall.argv).toContain("context");
  });
});

describe("createSpawnEpicHandler — §D2 step 6d: eligibility-race transient", () => {
  test("non-zero exit with eligible=false stderr → silent skip (no flag)", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([
      { exitCode: 1, stderr: "eligible=false: dep e-aaa not done" },
    ]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
    });
    const r = await handler({ epicId: "e-test" });
    expect(r).toBe<SpawnEpicHandlerOutcome>("skipped-eligibility-race");
    // No flag-add call.
    expect(stub.calls).toHaveLength(1);
  });
});

describe("createSpawnEpicHandler — idempotency on re-delivery", () => {
  test("re-delivery after spawn-success → skipped-already-spawned (no double-spawn)", async () => {
    insertEpic(db, makeEpic());
    const stub = stubSpawn([{ exitCode: 0 }]);
    const handler = createSpawnEpicHandler({
      db,
      atmuxDir: scratch,
      team: TEAM_BARE,
      spawn: stub.spawn,
      effectiveAutoSpawn: () => ({ enabled: true, roster: "x" }),
      epicIsEligible: async () => ({ eligible: true, blockers: [] }),
    });

    const r1 = await handler({ epicId: "e-test" });
    expect(r1).toBe<SpawnEpicHandlerOutcome>("spawned");

    const r2 = await handler({ epicId: "e-test" });
    expect(r2).toBe<SpawnEpicHandlerOutcome>("skipped-already-spawned");

    // Only 1 spawn call across 2 deliveries
    expect(stub.calls).toHaveLength(1);
  });
});
