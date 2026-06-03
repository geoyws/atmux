// ADR-250 — orchd stale-epic-team reaper. Tests pin each dep-injection
// seam for deterministic counter + side-effect assertions:
//   (a) dead-cage orphan → reaped (dissolve called)
//   (b) live + active → skipped-live-active (no dissolve, no escalate)
//   (c) live + idle → escalated (escalate called, dissolve NOT called)
//   (d) --dry-run → classifies but takes no destructive action
//   (e) failure isolation → a thrown action is counted + the walk continues
//   (f) safe defaults → unknown liveness fails CLOSED (treated alive, never reaped)

import { describe, expect, test } from "bun:test";
import {
  reapStaleEpicTeams,
  type SpawnedEpicTeam,
} from "../../../src/core/orchd-reap.ts";

const ATMUX_DIR = "/tmp/team/.atmux";

function team(epicId: string): SpawnedEpicTeam {
  return {
    epicId,
    cageSessionName: `atmux-${epicId}`,
    cageSocket: `/tmp/atmux-parent/epics/${epicId}/tmux-0/default`,
  };
}

describe("reapStaleEpicTeams — empty enumeration (no spawned epic-teams)", () => {
  test("all counters zero, no details", async () => {
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      listSpawnedEpicTeams: async () => [],
    });
    expect(r).toEqual({
      considered: 0,
      reaped: 0,
      escalated: 0,
      skippedActive: 0,
      errors: 0,
      details: [],
    });
  });

  test("shipped default (no deps) is a safe no-op — default enumerator considers nothing", async () => {
    const r = await reapStaleEpicTeams(ATMUX_DIR);
    expect(r.considered).toBe(0);
    expect(r.reaped).toBe(0);
    expect(r.escalated).toBe(0);
  });
});

describe("reapStaleEpicTeams — dead-cage orphan → reaped", () => {
  test("dissolves and counts reaped", async () => {
    const dissolved: string[] = [];
    const escalated: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      listSpawnedEpicTeams: async () => [team("e-dead")],
      isCageAlive: async () => false,
      dissolve: async (id) => {
        dissolved.push(id);
      },
      escalate: async (t) => {
        escalated.push(t.epicId);
      },
    });
    expect(dissolved).toEqual(["e-dead"]);
    expect(escalated).toEqual([]); // dead cage is reaped, never escalated
    expect(r.reaped).toBe(1);
    expect(r.escalated).toBe(0);
    expect(r.considered).toBe(1);
    expect(r.details[0]).toMatchObject({ epicId: "e-dead", outcome: "reaped" });
  });
});

describe("reapStaleEpicTeams — live + active → skipped-live-active", () => {
  test("neither dissolves nor escalates a live, progressing cage", async () => {
    const dissolved: string[] = [];
    const escalated: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      listSpawnedEpicTeams: async () => [team("e-live")],
      isCageAlive: async () => true,
      isCageStaleIdle: async () => false,
      dissolve: async (id) => {
        dissolved.push(id);
      },
      escalate: async (t) => {
        escalated.push(t.epicId);
      },
    });
    expect(dissolved).toEqual([]);
    expect(escalated).toEqual([]);
    expect(r.skippedActive).toBe(1);
    expect(r.reaped).toBe(0);
    expect(r.details[0]).toMatchObject({ outcome: "skipped-live-active" });
  });
});

describe("reapStaleEpicTeams — live + idle → escalated (NEVER auto-killed)", () => {
  test("escalates and does NOT dissolve a live-but-idle cage", async () => {
    const dissolved: string[] = [];
    const escalated: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      listSpawnedEpicTeams: async () => [team("e-idle")],
      isCageAlive: async () => true,
      isCageStaleIdle: async () => true,
      dissolve: async (id) => {
        dissolved.push(id);
      },
      escalate: async (t) => {
        escalated.push(t.epicId);
      },
    });
    expect(dissolved).toEqual([]); // live cage is NEVER auto-killed
    expect(escalated).toEqual(["e-idle"]);
    expect(r.escalated).toBe(1);
    expect(r.reaped).toBe(0);
    expect(r.details[0]).toMatchObject({ outcome: "escalated" });
  });
});

describe("reapStaleEpicTeams — --dry-run takes no destructive action", () => {
  test("dead cage under dry-run: classified, not dissolved", async () => {
    const dissolved: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      dryRun: true,
      listSpawnedEpicTeams: async () => [team("e-dead")],
      isCageAlive: async () => false,
      dissolve: async (id) => {
        dissolved.push(id);
      },
    });
    expect(dissolved).toEqual([]);
    expect(r.reaped).toBe(0);
    expect(r.details[0]).toMatchObject({ outcome: "skipped-dry-run" });
  });

  test("live-idle under dry-run: classified, not escalated", async () => {
    const escalated: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      dryRun: true,
      listSpawnedEpicTeams: async () => [team("e-idle")],
      isCageAlive: async () => true,
      isCageStaleIdle: async () => true,
      escalate: async (t) => {
        escalated.push(t.epicId);
      },
    });
    expect(escalated).toEqual([]);
    expect(r.escalated).toBe(0);
    expect(r.details[0]).toMatchObject({ outcome: "skipped-dry-run" });
  });
});

describe("reapStaleEpicTeams — failure isolation (ADR-231 anti-retry-storm)", () => {
  test("a thrown dissolve is counted as error; walk continues to next epic", async () => {
    const dissolved: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      listSpawnedEpicTeams: async () => [team("e-boom"), team("e-ok")],
      isCageAlive: async () => false,
      dissolve: async (id) => {
        if (id === "e-boom") throw new Error("dissolve refused: dirty worktree");
        dissolved.push(id);
      },
    });
    expect(r.considered).toBe(2);
    expect(r.errors).toBe(1);
    expect(r.reaped).toBe(1); // e-ok still reaped after e-boom threw
    expect(dissolved).toEqual(["e-ok"]);
    expect(r.details.find((d) => d.epicId === "e-boom")?.outcome).toBe("error");
  });
});

describe("reapStaleEpicTeams — safe defaults fail CLOSED", () => {
  test("with only the enumerator injected, unknown liveness ⇒ treated alive ⇒ never reaped", async () => {
    const dissolved: string[] = [];
    const escalated: string[] = [];
    const r = await reapStaleEpicTeams(ATMUX_DIR, {
      listSpawnedEpicTeams: async () => [team("e-unknown")],
      // isCageAlive / isCageStaleIdle / dissolve / escalate all default
      dissolve: async (id) => {
        dissolved.push(id);
      },
      escalate: async (t) => {
        escalated.push(t.epicId);
      },
    });
    expect(dissolved).toEqual([]); // default isCageAlive=true ⇒ no reap
    expect(escalated).toEqual([]); // default isCageStaleIdle=false ⇒ no escalate
    expect(r.skippedActive).toBe(1);
  });
});
