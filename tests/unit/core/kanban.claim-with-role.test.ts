// Unit tests for selectNextClaimable's `roleFilter` option — ADR-210
// Tier-2 §73 role-tag filter (Task t-f6659897, slice S6). `roleFilter`
// is a HARD lane filter applied at selection time: only Tasks whose
// `.lane === roleFilter` are eligible, and the callerLane /
// crossLaneClaim lane passes are bypassed entirely. No lane-less
// fallback, no cross-lane. Empty / undefined roleFilter → legacy logic.

import { describe, expect, test } from "bun:test";
import { selectNextClaimable } from "../../../src/core/kanban.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

const baseTask = (over: Partial<KanbanTask>): KanbanTask => ({
  id: "t-x",
  subject: "x",
  body: "",
  status: "todo",
  owner: null,
  deps: [],
  priority: null,
  lane: null,
  createdAt: 1000,
  claimedAt: null,
  completedAt: null,
  ...over,
});

describe("selectNextClaimable roleFilter", () => {
  test("roleFilter='fe' picks only FE-lane Task even when a BE Task has better priority", () => {
    const tasks = [
      baseTask({ id: "t-be", lane: "be", priority: 1 }),
      baseTask({ id: "t-fe", lane: "fe", priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "fe",
    });
    expect(pick?.id).toBe("t-fe");
  });

  test("roleFilter='be' picks only BE-lane Task", () => {
    const tasks = [
      baseTask({ id: "t-fe", lane: "fe", priority: 1 }),
      baseTask({ id: "t-be", lane: "be", priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "be",
    });
    expect(pick?.id).toBe("t-be");
  });

  test("roleFilter mismatch: no Task in that role → null (no fallback)", () => {
    const tasks = [
      baseTask({ id: "t-fe", lane: "fe", priority: 1 }),
      baseTask({ id: "t-noLane", lane: null, priority: 1 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "be",
    });
    expect(pick).toBeNull();
  });

  test("roleFilter does NOT fall back to lane-less Tasks", () => {
    const tasks = [baseTask({ id: "t-noLane", lane: null, priority: 1 })];
    const pick = selectNextClaimable(tasks, {
      callerLane: null,
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "fe",
    });
    expect(pick).toBeNull();
  });

  test("roleFilter overrides callerLane: fe caller can target a BE Task", () => {
    const tasks = [
      baseTask({ id: "t-fe", lane: "fe", priority: 1 }),
      baseTask({ id: "t-be", lane: "be", priority: 1 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "be",
    });
    expect(pick?.id).toBe("t-be");
  });

  test("roleFilter ignores crossLaneClaim=false (it's an explicit hard filter)", () => {
    const tasks = [baseTask({ id: "t-be", lane: "be", priority: 1 })];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: false,
      caller: "worker",
      roleFilter: "be",
    });
    expect(pick?.id).toBe("t-be");
  });

  test("roleFilter still honors deps-gating within the role", () => {
    const tasks = [
      baseTask({ id: "t-blocker", lane: "fe", priority: 9 }),
      baseTask({ id: "t-blocked", lane: "fe", deps: ["t-blocker"], priority: 1 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "fe",
    });
    // priority-1 t-blocked is dep-blocked; only the blocker is eligible.
    expect(pick?.id).toBe("t-blocker");
  });

  test("roleFilter still honors owner-gate (other-owned skipped, self-owned ok)", () => {
    const tasks = [
      baseTask({ id: "t-other", lane: "fe", owner: "someone-else", priority: 1 }),
      baseTask({ id: "t-mine", lane: "fe", owner: "worker", priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "fe",
    });
    expect(pick?.id).toBe("t-mine");
  });

  test("roleFilter still honors ADR-033 driverOnly gate for member scope", () => {
    const tasks = [
      baseTask({ id: "t-driverOnly", lane: "fe", priority: 1, driverOnly: true }),
      baseTask({ id: "t-regular", lane: "fe", priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      callerScope: "member",
      roleFilter: "fe",
    });
    expect(pick?.id).toBe("t-regular");
  });

  test("roleFilter tie-break: priority asc then createdAt asc within the role", () => {
    const tasks = [
      baseTask({ id: "t-late", lane: "fe", priority: 2, createdAt: 2000 }),
      baseTask({ id: "t-early", lane: "fe", priority: 2, createdAt: 1000 }),
      baseTask({ id: "t-low", lane: "fe", priority: 5, createdAt: 500 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "fe",
    });
    expect(pick?.id).toBe("t-early");
  });

  test("empty-string roleFilter falls through to legacy lane logic", () => {
    const tasks = [
      baseTask({ id: "t-fe", lane: "fe", priority: 5 }),
      baseTask({ id: "t-noLane", lane: null, priority: 1 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "worker",
      roleFilter: "",
    });
    // Legacy: own-lane (fe) preferred over lane=null → t-fe.
    expect(pick?.id).toBe("t-fe");
  });
});
