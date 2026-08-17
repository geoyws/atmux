// Unit tests for src/core/cage-resolver.ts (e-11-446429c9 §S1).

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  epicCageRootCandidates,
  resolveCageForEpic,
  resolveEpicCageRoot,
} from "../../../src/core/cage-resolver.ts";
import type { Cockpit as CockpitShape } from "../../../src/schema/cockpit.ts";

function mkCockpit(overrides: Partial<CockpitShape> = {}): CockpitShape {
  // `schemaVersion` + `cockpitSession` carry Zod defaults; the resolver
  // only reads `sessions`, so synthesize a minimal fixture and cast
  // (same idiom as tests/unit/core/cockpit.test.ts::buildFixtureCockpit).
  return {
    sessions: [],
    ...overrides,
  } as unknown as CockpitShape;
}

describe("epicCageRootCandidates", () => {
  test("yields the ADR-089 in-parent path FIRST, then the ADR-090 sibling path", () => {
    // Order is the contract, not an implementation detail: a cage that
    // exists under both conventions must resolve to the in-parent one.
    expect(epicCageRootCandidates("/w/mx-root", "8-abc", "8-abc")).toEqual([
      "/w/mx-root/.atmux/worktrees/8-abc",
      "/w/mx-root-epics/8-abc",
    ]);
  });

  test("keys the in-parent path on the TEAM NAME and the sibling path on the EPIC ID", () => {
    // The two differ in principle (`spawn-epic` sets name := epicId, but
    // the cockpit schema does not force it), so a helper that used one
    // for both would miss a cage whenever they diverge.
    expect(epicCageRootCandidates("/w/p", "lane-name", "e-99")).toEqual([
      "/w/p/.atmux/worktrees/lane-name",
      "/w/p-epics/e-99",
    ]);
  });
});

describe("resolveEpicCageRoot", () => {
  test("returns the in-parent path when it exists", () => {
    const seen: string[] = [];
    const got = resolveEpicCageRoot("/w/p", "n", "e", {
      existsSync: (p) => {
        seen.push(p);
        return p === "/w/p/.atmux/worktrees/n";
      },
    });
    expect(got).toBe("/w/p/.atmux/worktrees/n");
    // Stops at the first hit — the sibling path is never probed.
    expect(seen).toEqual(["/w/p/.atmux/worktrees/n"]);
  });

  test("falls through to the sibling path when only that one exists", () => {
    const got = resolveEpicCageRoot("/w/p", "n", "e", {
      existsSync: (p) => p === "/w/p-epics/e",
    });
    expect(got).toBe("/w/p-epics/e");
  });

  test("returns null — NOT a best-guess path — when neither convention exists", () => {
    // A best guess here would be probed as if it were a real cage, which
    // reads the PARENT and reports a confident wrong answer.
    expect(resolveEpicCageRoot("/w/p", "n", "e", { existsSync: () => false })).toBeNull();
  });

  test("the default existsSync reads the real filesystem", async () => {
    const parent = await mkdtemp(join(tmpdir(), "atmux-cage-resolver-"));
    try {
      await mkdir(join(parent, ".atmux", "worktrees", "n"), { recursive: true });
      expect(resolveEpicCageRoot(parent, "n", "e")).toBe(join(parent, ".atmux", "worktrees", "n"));
      expect(resolveEpicCageRoot(parent, "absent", "also-absent")).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("resolveCageForEpic", () => {
  test("returns null when no epic-team session matches", () => {
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "team",
          name: "atmux",
          root: "/root/work/src/atmux",
          enabled: true,
          sessions: [],
        },
      ],
    });
    expect(resolveCageForEpic(cockpit, "e-unknown", { existsSync: () => false })).toBeNull();
  });

  test("finds epic-team by epicId; resolves epicRoot via in-parent worktree convention (ADR-089 §F)", () => {
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "team",
          name: "atmux",
          root: "/root/work/src/atmux",
          enabled: true,
          sessions: [
            {
              type: "epic-team",
              name: "e-deadbeef-x",
              parent: "atmux",
              epicId: "e-99-deadbeef",
              enabled: false,
              sessions: [],
            },
          ],
        },
      ],
    });
    const existsSync = (p: string) => p === "/root/work/src/atmux/.atmux/worktrees/e-deadbeef-x";
    const r = resolveCageForEpic(cockpit, "e-99-deadbeef", { existsSync });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("e-deadbeef-x");
    expect(r!.parentTeamName).toBe("atmux");
    expect(r!.parentRoot).toBe("/root/work/src/atmux");
    expect(r!.epicRoot).toBe("/root/work/src/atmux/.atmux/worktrees/e-deadbeef-x");
    expect(r!.epicId).toBe("e-99-deadbeef");
    expect(r!.level).toBe(1);
  });

  test("falls back to sibling convention (ADR-090) when in-parent path missing", () => {
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "team",
          name: "sopx",
          root: "/root/work/sopx",
          enabled: true,
          sessions: [
            {
              type: "epic-team",
              name: "be-1-foo",
              parent: "sopx",
              epicId: "e-22-cafebabe",
              enabled: false,
              sessions: [],
            },
          ],
        },
      ],
    });
    const existsSync = (p: string) => p === "/root/work/sopx-epics/e-22-cafebabe";
    const r = resolveCageForEpic(cockpit, "e-22-cafebabe", { existsSync });
    expect(r).not.toBeNull();
    expect(r!.epicRoot).toBe("/root/work/sopx-epics/e-22-cafebabe");
  });

  test("first-match wins on multiple epic-teams (defensive — schema should reject dupes)", () => {
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "team",
          name: "atmux",
          root: "/root/work/src/atmux",
          enabled: true,
          sessions: [
            {
              type: "epic-team",
              name: "first",
              parent: "atmux",
              epicId: "e-dup",
              enabled: false,
              sessions: [],
            },
            {
              type: "epic-team",
              name: "second",
              parent: "atmux",
              epicId: "e-dup",
              enabled: false,
              sessions: [],
            },
          ],
        },
      ],
    });
    const r = resolveCageForEpic(cockpit, "e-dup", { existsSync: () => true });
    expect(r!.name).toBe("first");
  });

  test("skips an epic-team with no ancestor team — an orphan node has no parent root to resolve against", () => {
    // Defensive: the walk invariant says an epic-team always sits under a
    // team, so `parentRoot` is set. A hand-edited cockpit can violate it,
    // and resolving against `undefined` would produce a path rooted at
    // the filesystem root.
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "epic-team",
          name: "orphan",
          parent: "gone",
          epicId: "e-orphan",
          enabled: false,
          sessions: [],
        },
      ],
    });
    expect(resolveCageForEpic(cockpit, "e-orphan", { existsSync: () => true })).toBeNull();
  });

  test("falls back to the in-parent path as the reason string when NEITHER convention exists", () => {
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "team",
          name: "atmux",
          root: "/w/atmux",
          enabled: true,
          sessions: [
            {
              type: "epic-team",
              name: "drifted",
              parent: "atmux",
              epicId: "e-drift",
              enabled: false,
              sessions: [],
            },
          ],
        },
      ],
    });
    const r = resolveCageForEpic(cockpit, "e-drift", { existsSync: () => false });
    expect(r).not.toBeNull();
    expect(r?.epicRoot).toBe("/w/atmux/.atmux/worktrees/drifted");
  });

  test("walks recursively into nested cockpit subtrees", () => {
    const cockpit = mkCockpit({
      sessions: [
        {
          type: "team",
          name: "atmux",
          root: "/root/work/src/atmux",
          enabled: true,
          sessions: [
            {
              type: "epic-team",
              name: "outer",
              parent: "atmux",
              epicId: "e-outer",
              enabled: false,
              sessions: [
                {
                  type: "epic-team",
                  name: "inner",
                  parent: "outer",
                  epicId: "e-inner",
                  enabled: false,
                  sessions: [],
                },
              ],
            },
          ],
        },
      ],
    });
    const r = resolveCageForEpic(cockpit, "e-inner", { existsSync: () => true });
    expect(r).not.toBeNull();
    expect(r!.name).toBe("inner");
    expect(r!.parentTeamName).toBe("outer");
    expect(r!.level).toBe(2);
  });
});
