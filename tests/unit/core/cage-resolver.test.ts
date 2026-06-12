// Unit tests for src/core/cage-resolver.ts (e-11-446429c9 §S1).

import { describe, expect, test } from "bun:test";
import { resolveCageForEpic } from "../../../src/core/cage-resolver.ts";
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
