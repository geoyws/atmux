// Unit tests for src/core/orchd-sweep.ts (ADR-231 §D4 — orchd
// --sweep walker scaffold; cron backstop).
//
// Coverage (per Task t-10-ab3815cf AC):
//   (a) all-stubs no-op returns zero counters
//   (b) spawned_at non-null → epic skipped
//   (c) eligibility-false → epic skipped
//   (d) autoSpawn-false → epic skipped
//   (e) handler-reuse — spawnEpicHandler mock called per eligible epic
//   (f) handler outcome maps correctly to counters (spawned vs skipped)
//   (g) handler throw → walker continues + does NOT count as spawned
//   (h) solo-worker walk + handler-reuse counter

import { describe, expect, test } from "bun:test";
import type { KanbanEpic } from "../../../src/schema/kanban.ts";
import type { EpicEligibility } from "../../../src/core/epic.ts";
import {
  type OrchdSweepDeps,
  orchdSweep,
} from "../../../src/core/orchd-sweep.ts";

// ---------- Test helpers ----------

function makeEpic(id: string, overrides: Partial<KanbanEpic> = {}): KanbanEpic {
  return {
    id,
    title: `${id} title`,
    status: "planning",
    dependsOn: [],
    isReady: false,
    ...overrides,
  } as KanbanEpic;
}

function eligibleYes(): EpicEligibility {
  return { eligible: true, blockers: [] };
}

function eligibleNo(reason: string): EpicEligibility {
  return { eligible: false, blockers: [reason] };
}

interface SpawnCall {
  epicId: string;
}

function recordingSpawnHandler(
  behavior: "spawned" | "skipped" | "flag-raised" | "throw",
): {
  spawnEpicHandler: NonNullable<OrchdSweepDeps["spawnEpicHandler"]>;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnEpicHandler: NonNullable<OrchdSweepDeps["spawnEpicHandler"]> = async (
    _atmuxDir,
    epic,
  ) => {
    calls.push({ epicId: epic.id });
    if (behavior === "throw") throw new Error("spawn-handler injected failure");
    return behavior;
  };
  return { spawnEpicHandler, calls };
}

// ---------- (a) Scaffold no-op ----------

describe("orchdSweep — scaffold no-op (all stubs default)", () => {
  test("empty epic list + empty worker list → zero counters", async () => {
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [],
      epicIsEligible: async () => eligibleYes(),
      resolveSoloWorkerMembers: async () => [],
    });
    expect(result).toEqual({
      epicsConsidered: 0,
      epicsSpawned: 0,
      workersConsidered: 0,
      workersDissolved: 0,
    });
  });

  test("stub defaults (autoSpawn=false, spawnHandler='skipped') yield zero spawned even on eligible epics", async () => {
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-1"), makeEpic("e-2"), makeEpic("e-3")],
      epicIsEligible: async () => eligibleYes(),
      // effectiveAutoSpawn left as default stub (returns false) → all skip pre-handler
      // spawnEpicHandler left as default stub → would return 'skipped' even if reached
      resolveSoloWorkerMembers: async () => [],
    });
    expect(result.epicsConsidered).toBe(3);
    expect(result.epicsSpawned).toBe(0);
    expect(result.workersConsidered).toBe(0);
    expect(result.workersDissolved).toBe(0);
  });
});

// ---------- (b) Dedup gate per §D2 ----------

describe("orchdSweep — dedup gate (§D2)", () => {
  test("spawnedAt non-null epic → considered but not handled", async () => {
    const { spawnEpicHandler, calls } = recordingSpawnHandler("spawned");
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [
        makeEpic("e-already", { spawnedAt: 1_700_000_500 }),
        makeEpic("e-fresh", { spawnedAt: null }),
      ],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(result.epicsConsidered).toBe(2);
    expect(result.epicsSpawned).toBe(1);
    expect(calls.map((c) => c.epicId)).toEqual(["e-fresh"]);
  });

  test("spawnedAt of zero is still 'set' — treated as not-spawned only on null/undefined", async () => {
    // Edge case: spawnedAt=0 means "spawned at unix-epoch 0" — extremely
    // unlikely in practice but the walker treats it as "set", not "null".
    const { spawnEpicHandler, calls } = recordingSpawnHandler("spawned");
    await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-zero", { spawnedAt: 0 })],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------- (c) Eligibility gate per ADR-225 ----------

describe("orchdSweep — eligibility gate (ADR-225)", () => {
  test("eligible=false → considered but not handled", async () => {
    const { spawnEpicHandler, calls } = recordingSpawnHandler("spawned");
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-blocked"), makeEpic("e-ok")],
      epicIsEligible: async (_dir, id) =>
        id === "e-blocked" ? eligibleNo("is_ready=0") : eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(result.epicsConsidered).toBe(2);
    expect(result.epicsSpawned).toBe(1);
    expect(calls.map((c) => c.epicId)).toEqual(["e-ok"]);
  });
});

// ---------- (d) autoSpawn gate per §D3 ----------

describe("orchdSweep — autoSpawn gate (§D3)", () => {
  test("effectiveAutoSpawn=false → considered but not handled", async () => {
    const { spawnEpicHandler, calls } = recordingSpawnHandler("spawned");
    await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-off"), makeEpic("e-on")],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: (e) => e.id === "e-on",
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(calls.map((c) => c.epicId)).toEqual(["e-on"]);
  });
});

// ---------- (e + f) Handler-reuse + outcome mapping ----------

describe("orchdSweep — handler-reuse (NOT duplicate logic, AC core)", () => {
  test("eligible epics route through spawnEpicHandler; counters reflect outcomes", async () => {
    const calls: Array<{ id: string; outcome: "spawned" | "skipped" }> = [];
    const spawnEpicHandler: NonNullable<OrchdSweepDeps["spawnEpicHandler"]> = async (
      _dir,
      epic,
    ) => {
      // Synthetic mix of outcomes to confirm counter mapping.
      const outcome = epic.id === "e-3" ? "skipped" : "spawned";
      calls.push({ id: epic.id, outcome });
      return outcome;
    };
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-1"), makeEpic("e-2"), makeEpic("e-3")],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(calls).toHaveLength(3);
    expect(result.epicsSpawned).toBe(2); // e-1 + e-2; e-3 returned 'skipped'
    expect(result.epicsConsidered).toBe(3);
  });

  test("'flag-raised' outcome does NOT count as spawned", async () => {
    const { spawnEpicHandler, calls } = recordingSpawnHandler("flag-raised");
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-failed")],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(calls).toHaveLength(1);
    expect(result.epicsSpawned).toBe(0);
    expect(result.epicsConsidered).toBe(1);
  });
});

// ---------- (g) Failure isolation ----------

describe("orchdSweep — failure isolation (ADR-231 anti-retry-storm)", () => {
  test("handler throw → walk continues + outcome NOT counted as spawned", async () => {
    const calls: string[] = [];
    const spawnEpicHandler: NonNullable<OrchdSweepDeps["spawnEpicHandler"]> = async (
      _dir,
      epic,
    ) => {
      calls.push(epic.id);
      if (epic.id === "e-bad") throw new Error("synthetic handler failure");
      return "spawned";
    };
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-ok-a"), makeEpic("e-bad"), makeEpic("e-ok-b")],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(calls).toEqual(["e-ok-a", "e-bad", "e-ok-b"]);
    expect(result.epicsSpawned).toBe(2); // e-ok-a + e-ok-b; e-bad threw
    expect(result.epicsConsidered).toBe(3);
  });
});

// ---------- (h) Solo-worker walk ----------

describe("orchdSweep — solo-worker walk (§D4 dissolve backstop)", () => {
  test("each worker invokes considerSoloWorker; dissolved outcome bumps counter", async () => {
    const calls: string[] = [];
    const considerSoloWorker: NonNullable<OrchdSweepDeps["considerSoloWorker"]> = async (
      _dir,
      name,
    ) => {
      calls.push(name);
      if (name === "w-pending-task") return "skipped";
      return "dissolved";
    };
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [],
      resolveSoloWorkerMembers: async () => [
        "w-done-1",
        "w-pending-task",
        "w-done-2",
      ],
      considerSoloWorker,
    });
    expect(calls).toEqual(["w-done-1", "w-pending-task", "w-done-2"]);
    expect(result.workersConsidered).toBe(3);
    expect(result.workersDissolved).toBe(2);
  });

  test("considerSoloWorker throw → walk continues + NOT counted as dissolved", async () => {
    const considerSoloWorker: NonNullable<OrchdSweepDeps["considerSoloWorker"]> = async (
      _dir,
      name,
    ) => {
      if (name === "w-bad") throw new Error("dissolve-handler injected failure");
      return "dissolved";
    };
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [],
      resolveSoloWorkerMembers: async () => ["w-ok-a", "w-bad", "w-ok-b"],
      considerSoloWorker,
    });
    expect(result.workersConsidered).toBe(3);
    expect(result.workersDissolved).toBe(2); // w-ok-a + w-ok-b
  });

  test("escalated outcome does NOT count as dissolved", async () => {
    const considerSoloWorker: NonNullable<OrchdSweepDeps["considerSoloWorker"]> = async () =>
      "escalated";
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [],
      resolveSoloWorkerMembers: async () => ["w-stuck"],
      considerSoloWorker,
    });
    expect(result.workersConsidered).toBe(1);
    expect(result.workersDissolved).toBe(0);
  });
});

// ---------- Default stubs (T-S2.5 / T-S2.6 land real impls) ----------

describe("orchdSweep — default stubs (scaffolding intent)", () => {
  test("default effectiveAutoSpawn returns false → eligible epics get skipped (safe pre-T-S2.5 no-op)", async () => {
    // Only override listEpics + epicIsEligible + resolveSoloWorkerMembers;
    // leave effectiveAutoSpawn + spawnEpicHandler defaults stubbed.
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-eligible")],
      epicIsEligible: async () => eligibleYes(),
      resolveSoloWorkerMembers: async () => [],
    });
    expect(result.epicsConsidered).toBe(1);
    // Default stub returned false → never reached spawnEpicHandler → zero
    // spawned. Confirms the pre-T-S2.5 no-op invariant.
    expect(result.epicsSpawned).toBe(0);
  });

  test("default spawnEpicHandler returns 'skipped' → safe no-op on accidental autoSpawn=true (defense-in-depth)", async () => {
    // Synthetic: force autoSpawn=true but use the default spawnEpicHandler
    // (no override). Confirms even with the gate flipped on, the default
    // stub still returns "skipped" so no spawn fires pre-T-S2.5.
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-1")],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      resolveSoloWorkerMembers: async () => [],
    });
    expect(result.epicsConsidered).toBe(1);
    expect(result.epicsSpawned).toBe(0);
  });

  test("default resolveSoloWorkerMembers returns empty → zero workers considered (safe pre-T-S2.6 no-op)", async () => {
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [],
      // resolveSoloWorkerMembers + considerSoloWorker both defaulted.
    });
    expect(result.workersConsidered).toBe(0);
    expect(result.workersDissolved).toBe(0);
  });

  test("default considerSoloWorker returns 'skipped' → safe no-op when resolver returns workers pre-T-S2.6", async () => {
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [],
      resolveSoloWorkerMembers: async () => ["w-injected"],
      // considerSoloWorker defaulted → returns "skipped"
    });
    expect(result.workersConsidered).toBe(1);
    expect(result.workersDissolved).toBe(0);
  });
});

// ---------- Counter shape contract ----------

describe("orchdSweep — return-shape contract", () => {
  test("counters are non-negative integers + sum coherently", async () => {
    const { spawnEpicHandler } = recordingSpawnHandler("spawned");
    const result = await orchdSweep("/scratch/atmux-dir", {
      listEpics: async () => [makeEpic("e-1"), makeEpic("e-skip", { spawnedAt: 1 })],
      epicIsEligible: async () => eligibleYes(),
      effectiveAutoSpawn: () => true,
      spawnEpicHandler,
      resolveSoloWorkerMembers: async () => ["w-1"],
      considerSoloWorker: async () => "dissolved",
    });
    expect(result.epicsConsidered).toBeGreaterThanOrEqual(result.epicsSpawned);
    expect(result.workersConsidered).toBeGreaterThanOrEqual(result.workersDissolved);
    for (const v of Object.values(result)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
