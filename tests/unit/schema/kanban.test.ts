// Unit tests for src/schema/kanban.ts (ADR-005, bash-shared per #12 carve-out).
//
// Coverage strategy: drive every exported schema's parse path with both
// minimal valid shapes and representative bash-on-disk shapes. Schemas
// are tracked under the ADR-009 §2 narrowed denominator; reviewer's
// 8-check gate enforces 100%.
//
// Coverage map:
//   - Top-level Kanban / KanbanSchema: minimal-empty, fully-populated
//   - KanbanTask: minimal (id only), fully-populated (every field), legacy
//     shapes (missing fields), forward-compat (extra unknown keys via
//     .passthrough()), null-coalesce on every nullable field
//   - KanbanEpic: minimal, fully-populated
//   - KanbanStory: minimal, fully-populated
//   - KanbanLane enum: write-side validation accepts allowed lanes,
//     rejects unknowns (used by core helpers / verbs at write boundary)

import { describe, expect, test } from "bun:test";
import {
  Kanban,
  KanbanEpic,
  KanbanLane,
  KanbanSchema,
  KanbanStory,
  KanbanTask,
} from "../../../src/schema/kanban.ts";

// ---------- Top-level ----------

describe("Kanban (top-level)", () => {
  test("normalized empty shape parses cleanly", () => {
    const empty = { tasks: [], epics: [], stories: [] };
    const parsed = Kanban.parse(empty);
    expect(parsed.tasks).toEqual([]);
    expect(parsed.epics).toEqual([]);
    expect(parsed.stories).toEqual([]);
  });

  test("KanbanSchema is an alias for Kanban (ergonomic import)", () => {
    expect(KanbanSchema).toBe(Kanban);
  });

  test("populated shape with one of each parses cleanly", () => {
    const populated = {
      tasks: [{ id: "t-deadbeef" }],
      epics: [{ id: "e-cafef00d" }],
      stories: [{ id: "s-12345678" }],
    };
    const parsed = Kanban.parse(populated);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.epics).toHaveLength(1);
    expect(parsed.stories).toHaveLength(1);
  });

  test("missing tasks array fails parse (normalize must run first)", () => {
    expect(() => Kanban.parse({ epics: [], stories: [] })).toThrow();
  });

  test("missing epics array fails parse", () => {
    expect(() => Kanban.parse({ tasks: [], stories: [] })).toThrow();
  });

  test("missing stories array fails parse", () => {
    expect(() => Kanban.parse({ tasks: [], epics: [] })).toThrow();
  });

  test("passthrough preserves unknown top-level keys (forward-compat)", () => {
    const input = {
      tasks: [],
      epics: [],
      stories: [],
      // Hypothetical Phase-2 future field bash adds before TS catches up:
      futureBashAddedField: "preserved",
    };
    const parsed = Kanban.parse(input) as unknown as { futureBashAddedField: string };
    expect(parsed.futureBashAddedField).toBe("preserved");
  });
});

// ---------- KanbanTask ----------

describe("KanbanTask", () => {
  test("minimal: only id", () => {
    const parsed = KanbanTask.parse({ id: "t-abc12345" });
    expect(parsed.id).toBe("t-abc12345");
  });

  test("rejects empty id", () => {
    expect(() => KanbanTask.parse({ id: "" })).toThrow();
  });

  test("rejects missing id", () => {
    expect(() => KanbanTask.parse({})).toThrow();
  });

  test("fully-populated bash-on-disk shape parses (every documented field)", () => {
    const fullTask = {
      id: "t-f5bf6722",
      subject: "EPIC: Decompose pull-based kanban expansion",
      body: "long body prose here",
      status: "done",
      owner: "planner",
      deps: ["t-aaa00001", "t-aaa00002"],
      priority: 1,
      epic: "e-cafef00d",
      story: "s-12345678",
      lane: "be",
      deliverable: "ADR-007 + 27 Tasks",
      staleMin: 60,
      driverOnly: false,
      createdAt: 1777087756,
      claimedAt: 1777087762,
      completedAt: 1777088527,
      claimedFrom: null,
      createdFrom: "commit",
      note: "27 Tasks across 9 Stories landed",
    };
    const parsed = KanbanTask.parse(fullTask);
    expect(parsed.subject).toBe(fullTask.subject);
    expect(parsed.deps).toEqual(["t-aaa00001", "t-aaa00002"]);
    expect(parsed.lane).toBe("be");
    expect(parsed.driverOnly).toBe(false);
    expect(parsed.createdAt).toBe(1777087756);
    expect(parsed.claimedFrom).toBeNull();
  });

  test("nulls accepted on every nullable field (bash writes literal null)", () => {
    const allNulls = {
      id: "t-null0000",
      body: null,
      owner: null,
      priority: null,
      epic: null,
      story: null,
      lane: null,
      deliverable: null,
      staleMin: null,
      claimedAt: null,
      completedAt: null,
      claimedFrom: null,
      createdFrom: null,
      note: null,
    };
    const parsed = KanbanTask.parse(allNulls);
    expect(parsed.owner).toBeNull();
    expect(parsed.priority).toBeNull();
    expect(parsed.claimedAt).toBeNull();
  });

  test("legacy shape with missing fields parses (e.g. pre-ADR-033, no driverOnly)", () => {
    const legacy = {
      id: "t-legacy01",
      subject: "old task",
      status: "todo",
      createdAt: 1700000000,
    };
    const parsed = KanbanTask.parse(legacy);
    expect(parsed.id).toBe("t-legacy01");
    expect(parsed.driverOnly).toBeUndefined();
  });

  test("status accepts arbitrary strings (read-permissive)", () => {
    const exotic = { id: "t-foo", status: "phase-2-future-state" };
    expect(KanbanTask.parse(exotic).status).toBe("phase-2-future-state");
  });

  test("lane accepts arbitrary strings (legacy entries beyond enum)", () => {
    const legacyLane = { id: "t-foo", lane: "deprecated-lane-name" };
    expect(KanbanTask.parse(legacyLane).lane).toBe("deprecated-lane-name");
  });

  test("passthrough preserves unknown keys (forward-compat)", () => {
    const withExtra = { id: "t-foo", futureBashField: 42 };
    const parsed = KanbanTask.parse(withExtra) as unknown as { futureBashField: number };
    expect(parsed.futureBashField).toBe(42);
  });

  test("createdAt enforces integer (bash uses date +%s, never fractional)", () => {
    expect(() => KanbanTask.parse({ id: "t-x", createdAt: 1.5 })).toThrow();
  });

  test("deps must be string array — number deps rejected", () => {
    expect(() => KanbanTask.parse({ id: "t-x", deps: [1, 2] })).toThrow();
  });
});

// ---------- KanbanEpic ----------

describe("KanbanEpic", () => {
  test("minimal: only id", () => {
    expect(KanbanEpic.parse({ id: "e-abc12345" }).id).toBe("e-abc12345");
  });

  test("rejects empty id", () => {
    expect(() => KanbanEpic.parse({ id: "" })).toThrow();
  });

  test("fully-populated shape parses", () => {
    const epic = {
      id: "e-cafef00d",
      title: "Pull-based kanban",
      body: "the master epic",
      status: "in-progress",
      driverRef: "/root/.claude/plans/x.md",
      createdAt: 1777087700,
      completedAt: null,
      stories: ["s-aaaa1111", "s-bbbb2222"],
    };
    const parsed = KanbanEpic.parse(epic);
    expect(parsed.title).toBe("Pull-based kanban");
    expect(parsed.stories).toEqual(["s-aaaa1111", "s-bbbb2222"]);
  });

  test("passthrough preserves unknown keys", () => {
    const withExtra = { id: "e-x", futureField: "x" };
    const parsed = KanbanEpic.parse(withExtra) as unknown as { futureField: string };
    expect(parsed.futureField).toBe("x");
  });

  test("driverRef nullable", () => {
    const e = KanbanEpic.parse({ id: "e-x", driverRef: null });
    expect(e.driverRef).toBeNull();
  });
});

// ---------- KanbanStory ----------

describe("KanbanStory", () => {
  test("minimal: only id", () => {
    expect(KanbanStory.parse({ id: "s-abc12345" }).id).toBe("s-abc12345");
  });

  test("rejects empty id", () => {
    expect(() => KanbanStory.parse({ id: "" })).toThrow();
  });

  test("fully-populated story (review-signoff workflow)", () => {
    const story = {
      id: "s-12345678",
      epic: "e-cafef00d",
      title: "Add lane enum",
      body: "scope: be-kanban + bats",
      acceptanceCriteria: "all bats pass under shellcheck",
      status: "merging",
      createdAt: 1777087800,
      completedAt: null,
      advancedAt: 1777088000,
      reviewSignoff: true,
      mergeTaskId: "t-merge0001",
    };
    const parsed = KanbanStory.parse(story);
    expect(parsed.reviewSignoff).toBe(true);
    expect(parsed.mergeTaskId).toBe("t-merge0001");
  });

  test("orphaned story (no parent epic) parses with epic=null", () => {
    const orphan = { id: "s-orphan", epic: null };
    expect(KanbanStory.parse(orphan).epic).toBeNull();
  });

  test("passthrough preserves unknown keys", () => {
    const withExtra = { id: "s-x", futureField: true };
    const parsed = KanbanStory.parse(withExtra) as unknown as { futureField: boolean };
    expect(parsed.futureField).toBe(true);
  });

  test("ADR-146 §D4: branch field round-trips", () => {
    const story = KanbanStory.parse({
      id: "s-aaaaa111",
      branch: "geoyws-whip-impl",
    });
    expect(story.branch).toBe("geoyws-whip-impl");
  });

  test("ADR-146 §D4: branch accepts null (Story not yet backfilled)", () => {
    const story = KanbanStory.parse({ id: "s-aaaaa222", branch: null });
    expect(story.branch).toBeNull();
  });

  test("ADR-146 §D4: branch is optional (existing Stories pre-backfill)", () => {
    const story = KanbanStory.parse({ id: "s-aaaaa333" });
    expect(story.branch).toBeUndefined();
  });
});

// ---------- KanbanLane (write-side enum) ----------

describe("KanbanLane (write-side enum, per kanban.sh:84)", () => {
  test.each([
    "fe",
    "be",
    "db",
    "ops",
    "test",
    "review",
    "misc",
  ] as const)("accepts canonical lane '%s'", (lane) => {
    expect(KanbanLane.parse(lane)).toBe(lane);
  });

  test("rejects unknown lane (e.g. 'frontend')", () => {
    expect(() => KanbanLane.parse("frontend")).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => KanbanLane.parse("")).toThrow();
  });

  test("rejects null", () => {
    expect(() => KanbanLane.parse(null)).toThrow();
  });
});

// ---------- Cross-schema integration: realistic kanban.json ----------

describe("realistic kanban.json (parity-style integration)", () => {
  test("a kanban.json mirroring real bash on-disk state parses cleanly", () => {
    const realistic = {
      tasks: [
        {
          id: "t-f5bf6722",
          subject: "EPIC: Decompose plan",
          status: "done",
          owner: "planner",
          deps: [],
          priority: null,
          epic: "e-aaaa0001",
          story: null,
          lane: null,
          createdAt: 1777087756,
          claimedAt: 1777087762,
          completedAt: 1777088527,
          driverOnly: false,
          note: "27 Tasks landed",
        },
        {
          id: "t-fresh001",
          subject: "fresh todo",
          status: "todo",
          owner: null,
          deps: [],
          priority: null,
          createdAt: 1777200000,
          claimedAt: null,
          completedAt: null,
          driverOnly: false,
        },
      ],
      epics: [
        {
          id: "e-aaaa0001",
          title: "Decompose pull-based kanban",
          status: "done",
          createdAt: 1777087700,
          completedAt: 1777088600,
          stories: ["s-bbbb0001"],
        },
      ],
      stories: [
        {
          id: "s-bbbb0001",
          epic: "e-aaaa0001",
          title: "Schema additions",
          status: "done",
          createdAt: 1777087800,
          completedAt: 1777088400,
          reviewSignoff: true,
        },
      ],
    };
    const parsed = Kanban.parse(realistic);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.epics[0]?.stories).toEqual(["s-bbbb0001"]);
    expect(parsed.stories[0]?.reviewSignoff).toBe(true);
    // Both tasks parsed: one done with note, one fresh todo with nulls.
    expect(parsed.tasks[0]?.status).toBe("done");
    expect(parsed.tasks[1]?.owner).toBeNull();
  });
});

// ---------- ADR-090 §Schema additions ----------

describe("KanbanTask.role — ADR-090 §Decision-anchor #1", () => {
  test("reviewer-trunk-signoff marker parses on a Task", () => {
    const t = KanbanTask.parse({
      id: "t-abcd0001",
      subject: "trunk signoff: checkout-flow epic",
      role: "reviewer-trunk-signoff",
      status: "done",
    });
    expect(t.role).toBe("reviewer-trunk-signoff");
  });

  test("role accepts arbitrary strings (forward-compat for future markers)", () => {
    // §Decision-anchor #1 reserves `reviewer-trunk-signoff` as the v1
    // marker. Schema-permissive z.string() so future role-markers land
    // without schema churn.
    const t = KanbanTask.parse({
      id: "t-abcd0002",
      role: "epic-ship-gate",
    });
    expect(t.role).toBe("epic-ship-gate");
  });

  test("role is nullable + optional (legacy Tasks pre-ADR-090)", () => {
    // Legacy Tasks (no role field) AND nullable-explicit (role:null) both
    // parse — ADR-091's state-machine treats absent + null identically
    // (neither matches the reviewer-trunk-signoff predicate).
    const tLegacy = KanbanTask.parse({ id: "t-abcd0003" });
    expect(tLegacy.role).toBeUndefined();
    const tNull = KanbanTask.parse({ id: "t-abcd0004", role: null });
    expect(tNull.role).toBeNull();
  });
});

describe("KanbanEpic — ADR-090 §Schema additions (epicTeamName/Root/prNumber/prState/note)", () => {
  test("epic-team-attached Epic carries epicTeamName + epicTeamRoot", () => {
    const e = KanbanEpic.parse({
      id: "e-1a2b3c4d",
      title: "Checkout flow rewrite",
      status: "in-progress",
      epicTeamName: "checkout-flow",
      epicTeamRoot: "/root/work/ifca/src/sopx-epics/checkout-flow",
    });
    expect(e.epicTeamName).toBe("checkout-flow");
    expect(e.epicTeamRoot).toBe("/root/work/ifca/src/sopx-epics/checkout-flow");
  });

  test("legacy / shared-team Epic (no epicTeam attached) parses with the new fields null/absent", () => {
    const eLegacy = KanbanEpic.parse({ id: "e-legacy01", status: "in-progress" });
    expect(eLegacy.epicTeamName).toBeUndefined();
    expect(eLegacy.epicTeamRoot).toBeUndefined();

    const eNull = KanbanEpic.parse({
      id: "e-legacy02",
      epicTeamName: null,
      epicTeamRoot: null,
    });
    expect(eNull.epicTeamName).toBeNull();
    expect(eNull.epicTeamRoot).toBeNull();
  });

  test("forward-ref pr-mode fields parse (deferred runtime)", () => {
    // §Decision-anchor #6: schema-accept-runtime-noop. Tests pin the
    // schema shape so ADR-091's pr-mode runtime can land without
    // changing the schema.
    const e = KanbanEpic.parse({
      id: "e-pr0001",
      epicTeamName: "checkout-flow",
      epicTeamRoot: "/p",
      prNumber: 1234,
      prState: "open",
    });
    expect(e.prNumber).toBe(1234);
    expect(e.prState).toBe("open");
  });

  test("note field captures merge-state annotations (e.g. conflict at <SHA>)", () => {
    const e = KanbanEpic.parse({
      id: "e-conflict01",
      epicTeamName: "checkout-flow",
      epicTeamRoot: "/p",
      note: "conflict at 12345abc",
    });
    expect(e.note).toBe("conflict at 12345abc");
  });

  test("KanbanEpic.passthrough() preserves forward-compat with unknown keys", () => {
    // Pin the .passthrough() posture — adding a new bash-side field
    // must NOT break the TS parser before TS catches up.
    const e = KanbanEpic.parse({
      id: "e-future01",
      futureField: "should-passthrough",
    });
    expect((e as unknown as Record<string, unknown>).futureField).toBe("should-passthrough");
  });
});
