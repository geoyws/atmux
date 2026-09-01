// Unit tests for src/abstractions/tmux-window-orchestrator.ts (ADR-161 TR3).
//
// Covers pure helpers (sortMembersDefaultsFirst, candidateWindowNames)
// + the orchestration primitives against a stubbed TmuxNamespace. Real-
// tmux coverage of resolveMemberToWindowIdx / moveMemberWindow lives in
// tests/unit/verbs/member.test.ts where the verbs drive a live socket.

import { describe, expect, test } from "bun:test";
import { TmuxError } from "../../../src/errors.ts";
import { buildWindowName, buildWindowNameLegacy } from "../../../src/core/common.ts";
import {
  candidateWindowNames,
  MemberWindowResolveError,
  moveMemberWindow,
  resolveMemberToWindowIdx,
  sortMembersDefaultsFirst,
  swapMemberWindows,
} from "../../../src/abstractions/tmux-window-orchestrator.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";

// ---------- sortMembersDefaultsFirst ----------

const CANONICAL = ["team-lead", "planner", "reviewer", "ombudsman"] as const;

describe("sortMembersDefaultsFirst", () => {
  test("places defaults first in canonical order, preserves user-added relative order", () => {
    const members = [
      { name: "alpha", role: "member" },
      { name: "rev", role: "reviewer" },
      { name: "beta", role: "member" },
      { name: "lead", role: "team-lead" },
      { name: "plan", role: "planner" },
    ];
    const sorted = sortMembersDefaultsFirst(members, CANONICAL);
    expect(sorted.map((m) => m.name)).toEqual(["lead", "plan", "rev", "alpha", "beta"]);
  });

  test("idempotent on already-sorted input", () => {
    const members = [
      { name: "lead", role: "team-lead" },
      { name: "plan", role: "planner" },
      { name: "alpha", role: "member" },
    ];
    const sorted = sortMembersDefaultsFirst(members, CANONICAL);
    expect(sorted.map((m) => m.name)).toEqual(["lead", "plan", "alpha"]);
  });

  test("treats roles outside canonical set as user-added", () => {
    const members = [
      { name: "exotic", role: "future-role" },
      { name: "lead", role: "team-lead" },
    ];
    const sorted = sortMembersDefaultsFirst(members, CANONICAL);
    expect(sorted.map((m) => m.name)).toEqual(["lead", "exotic"]);
  });

  test("members without a role land in user-added bucket", () => {
    const members = [{ name: "noRole" }, { name: "lead", role: "team-lead" }];
    const sorted = sortMembersDefaultsFirst(members, CANONICAL);
    expect(sorted.map((m) => m.name)).toEqual(["lead", "noRole"]);
  });

  test("stable: same-role duplicates retain input order", () => {
    const members = [
      { name: "rev1", role: "reviewer" },
      { name: "rev2", role: "reviewer" },
      { name: "lead", role: "team-lead" },
    ];
    const sorted = sortMembersDefaultsFirst(members, CANONICAL);
    expect(sorted.map((m) => m.name)).toEqual(["lead", "rev1", "rev2"]);
  });

  test("empty input → empty output", () => {
    expect(sortMembersDefaultsFirst([], CANONICAL)).toEqual([]);
  });
});

// ---------- candidateWindowNames ----------

describe("candidateWindowNames", () => {
  test("default-role member yields underscore-canonical + hyphen-fallback + legacy", () => {
    const names = candidateWindowNames(
      { name: "lead", role: "team-lead", emoji: "🧭" },
      buildWindowName,
      buildWindowNameLegacy,
    );
    expect(new Set(names)).toEqual(new Set(["🧭_lead", "🧭-lead", "🧭lead"]));
  });

  test("user-added member yields hyphen-canonical + legacy (no underscore)", () => {
    const names = candidateWindowNames(
      { name: "worker", role: "member", emoji: "🛠️" },
      buildWindowName,
      buildWindowNameLegacy,
    );
    expect(new Set(names)).toEqual(new Set(["🛠️-worker", "🛠️worker"]));
  });

  test("no-emoji member collapses to just the id", () => {
    const names = candidateWindowNames(
      { name: "lead", role: "team-lead" },
      buildWindowName,
      buildWindowNameLegacy,
    );
    expect(names).toEqual(["lead"]);
  });

  test("label overrides id in canonical forms", () => {
    const names = candidateWindowNames(
      { name: "lead", role: "team-lead", emoji: "🧭", label: "Coord" },
      buildWindowName,
      buildWindowNameLegacy,
    );
    // legacy form ignores label (label didn't exist pre-ADR-135), so id wins there.
    expect(new Set(names)).toEqual(new Set(["🧭_Coord", "🧭-Coord", "🧭lead"]));
  });
});

// ---------- Stubbed tmux harness ----------

interface StubState {
  windows: { index: number; id: string; name: string; active: boolean }[];
  swapCalls: { source: string; target: string }[];
  moveCalls: { source: string; target: string }[];
  swapThrows?: TmuxError;
}

function stubTmux(state: StubState): TmuxNamespace {
  const ns: Partial<TmuxNamespace> = {
    window: {
      listWindows: async () => state.windows,
      newWindow: async () => ({ sessionName: "x", windowIndex: 0 }),
      killWindow: async () => {},
      renameWindow: async () => {},
      selectWindow: async () => {},
      moveWindow: async (opts) => {
        state.moveCalls.push({
          source:
            typeof opts.source === "string"
              ? opts.source
              : `W${(opts.source as { windowIndex: number }).windowIndex}`,
          target:
            typeof opts.target === "string"
              ? opts.target
              : `W${(opts.target as { windowIndex: number }).windowIndex}`,
        });
      },
      swapWindow: async (opts) => {
        if (state.swapThrows !== undefined) throw state.swapThrows;
        state.swapCalls.push({
          source:
            typeof opts.source === "string"
              ? opts.source
              : `W${(opts.source as { windowIndex: number }).windowIndex}`,
          target:
            typeof opts.target === "string"
              ? opts.target
              : `W${(opts.target as { windowIndex: number }).windowIndex}`,
        });
      },
    },
  };
  return ns as TmuxNamespace;
}

// ---------- resolveMemberToWindowIdx ----------

describe("resolveMemberToWindowIdx", () => {
  const members = [
    { name: "lead", role: "team-lead", emoji: "🧭" },
    { name: "worker", role: "member", emoji: "🛠️" },
  ];

  test("happy path: finds member by canonical window name", async () => {
    const state: StubState = {
      windows: [
        { index: 1, id: "@1", name: "driver", active: false },
        { index: 2, id: "@2", name: "🧭_lead", active: false },
      ],
      swapCalls: [],
      moveCalls: [],
    };
    const r = await resolveMemberToWindowIdx({
      sessionName: "s",
      memberId: "lead",
      members,
      tmux: stubTmux(state),
      buildWindowName,
      buildWindowNameLegacy,
    });
    expect(r).toEqual({ id: "lead", index: 2, name: "🧭_lead" });
  });

  test("unknown id throws MemberWindowResolveError", async () => {
    const state: StubState = {
      windows: [{ index: 1, id: "@1", name: "driver", active: false }],
      swapCalls: [],
      moveCalls: [],
    };
    await expect(
      resolveMemberToWindowIdx({
        sessionName: "s",
        memberId: "ghost",
        members,
        tmux: stubTmux(state),
        buildWindowName,
        buildWindowNameLegacy,
      }),
    ).rejects.toThrow(MemberWindowResolveError);
  });

  test("no live window for known id throws", async () => {
    const state: StubState = {
      windows: [{ index: 1, id: "@1", name: "driver", active: false }],
      swapCalls: [],
      moveCalls: [],
    };
    await expect(
      resolveMemberToWindowIdx({
        sessionName: "s",
        memberId: "lead",
        members,
        tmux: stubTmux(state),
        buildWindowName,
        buildWindowNameLegacy,
      }),
    ).rejects.toThrow(/no live tmux window/);
  });

  test("member resolves to driver index → driver-window refusal", async () => {
    const state: StubState = {
      windows: [{ index: 1, id: "@1", name: "🧭_lead", active: false }],
      swapCalls: [],
      moveCalls: [],
    };
    await expect(
      resolveMemberToWindowIdx({
        sessionName: "s",
        memberId: "lead",
        members,
        tmux: stubTmux(state),
        buildWindowName,
        buildWindowNameLegacy,
      }),
    ).rejects.toThrow(/driver window/);
  });

  test("duplicate window names for one member → duplicate-window error", async () => {
    const state: StubState = {
      windows: [
        { index: 2, id: "@2", name: "🧭_lead", active: false },
        { index: 3, id: "@3", name: "🧭_lead", active: false },
      ],
      swapCalls: [],
      moveCalls: [],
    };
    await expect(
      resolveMemberToWindowIdx({
        sessionName: "s",
        memberId: "lead",
        members,
        tmux: stubTmux(state),
        buildWindowName,
        buildWindowNameLegacy,
      }),
    ).rejects.toThrow(/multiple tmux windows/);
  });
});

// ---------- moveMemberWindow ----------

describe("moveMemberWindow", () => {
  test("idempotent when source.index === target", async () => {
    const state: StubState = { windows: [], swapCalls: [], moveCalls: [] };
    const moved = await moveMemberWindow({
      sessionName: "s",
      source: { id: "lead", index: 3, name: "🧭_lead" },
      target: 3,
      tmux: stubTmux(state),
      occupiedIndices: new Set([1, 3]),
    });
    expect(moved).toBe(false);
    expect(state.moveCalls).toHaveLength(0);
    expect(state.swapCalls).toHaveLength(0);
  });

  test("issues a move-window call when target slot is empty", async () => {
    const state: StubState = { windows: [], swapCalls: [], moveCalls: [] };
    const moved = await moveMemberWindow({
      sessionName: "s",
      source: { id: "lead", index: 4, name: "🧭_lead" },
      target: 2,
      tmux: stubTmux(state),
      occupiedIndices: new Set([1, 4]),
    });
    expect(moved).toBe(true);
    expect(state.moveCalls).toEqual([{ source: "W4", target: "W2" }]);
    expect(state.swapCalls).toHaveLength(0);
  });

  test("issues a swap-window call when target slot is occupied (preserves occupant's PIDs)", async () => {
    const state: StubState = { windows: [], swapCalls: [], moveCalls: [] };
    const moved = await moveMemberWindow({
      sessionName: "s",
      source: { id: "lead", index: 4, name: "🧭_lead" },
      target: 2,
      tmux: stubTmux(state),
      occupiedIndices: new Set([1, 2, 3, 4]),
    });
    expect(moved).toBe(true);
    expect(state.swapCalls).toEqual([{ source: "W4", target: "W2" }]);
    expect(state.moveCalls).toHaveLength(0);
  });

  test("refuses to move into driver slot (W1 default)", async () => {
    const state: StubState = { windows: [], swapCalls: [], moveCalls: [] };
    await expect(
      moveMemberWindow({
        sessionName: "s",
        source: { id: "lead", index: 3, name: "🧭_lead" },
        target: 1,
        tmux: stubTmux(state),
        occupiedIndices: new Set([1, 3]),
      }),
    ).rejects.toThrow(/cannot move .* to W1/);
  });
});

// ---------- swapMemberWindows ----------

describe("swapMemberWindows", () => {
  test("idempotent when both members at same index", async () => {
    const state: StubState = { windows: [], swapCalls: [], moveCalls: [] };
    const swapped = await swapMemberWindows({
      sessionName: "s",
      a: { id: "a", index: 3, name: "x" },
      b: { id: "b", index: 3, name: "y" },
      tmux: stubTmux(state),
      highestIndex: 4,
    });
    expect(swapped).toBe(false);
    expect(state.swapCalls).toHaveLength(0);
  });

  test("uses native swap-window primitive in happy path", async () => {
    const state: StubState = { windows: [], swapCalls: [], moveCalls: [] };
    const swapped = await swapMemberWindows({
      sessionName: "s",
      a: { id: "a", index: 2, name: "x" },
      b: { id: "b", index: 4, name: "y" },
      tmux: stubTmux(state),
      highestIndex: 4,
    });
    expect(swapped).toBe(true);
    expect(state.swapCalls).toEqual([{ source: "W2", target: "W4" }]);
    expect(state.moveCalls).toHaveLength(0);
  });

  test("falls back to three-move dance when swap-window throws TmuxError", async () => {
    const state: StubState = {
      windows: [],
      swapCalls: [],
      moveCalls: [],
      swapThrows: new TmuxError({
        argv: ["swap-window"],
        exitCode: 1,
        stderr: "ancient tmux",
        stdout: "",
      }),
    };
    const swapped = await swapMemberWindows({
      sessionName: "s",
      a: { id: "a", index: 2, name: "x" },
      b: { id: "b", index: 4, name: "y" },
      tmux: stubTmux(state),
      highestIndex: 4,
    });
    expect(swapped).toBe(true);
    // Expected dance: A → temp(5), B → A's slot(2), temp → B's slot(4).
    expect(state.moveCalls).toEqual([
      { source: "W2", target: "W5" },
      { source: "W4", target: "W2" },
      { source: "W5", target: "W4" },
    ]);
  });

  test("non-TmuxError from swap-window propagates", async () => {
    const state: StubState = {
      windows: [],
      swapCalls: [],
      moveCalls: [],
      swapThrows: new Error("unexpected") as TmuxError,
    };
    await expect(
      swapMemberWindows({
        sessionName: "s",
        a: { id: "a", index: 2, name: "x" },
        b: { id: "b", index: 4, name: "y" },
        tmux: stubTmux(state),
        highestIndex: 4,
      }),
    ).rejects.toThrow("unexpected");
  });
});
