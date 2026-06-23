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
//   (ADR-264: the Epic / Story schemas are cut — Task is the sole unit)
//   - KanbanLane enum: write-side validation accepts allowed lanes,
//     rejects unknowns (used by core helpers / verbs at write boundary)

import { describe, expect, test } from "bun:test";
import { Kanban, KanbanLane, KanbanSchema, KanbanTask } from "../../../src/schema/kanban.ts";

// ---------- Top-level ----------

describe("Kanban (top-level)", () => {
  test("normalized empty shape parses cleanly", () => {
    // ADR-264: `tasks` is the only top-level array.
    const empty = { tasks: [] };
    const parsed = Kanban.parse(empty);
    expect(parsed.tasks).toEqual([]);
  });

  test("KanbanSchema is an alias for Kanban (ergonomic import)", () => {
    expect(KanbanSchema).toBe(Kanban);
  });

  test("populated shape with one task parses cleanly", () => {
    const populated = {
      tasks: [{ id: "t-deadbeef" }],
    };
    const parsed = Kanban.parse(populated);
    expect(parsed.tasks).toHaveLength(1);
  });

  test("missing tasks array fails parse (normalize must run first)", () => {
    expect(() => Kanban.parse({})).toThrow();
  });

  test("passthrough preserves unknown top-level keys (forward-compat)", () => {
    const input = {
      tasks: [],
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
      subject: "Decompose pull-based kanban expansion",
      body: "long body prose here",
      status: "done",
      owner: "planner",
      deps: ["t-aaa00001", "t-aaa00002"],
      priority: 1,
      lane: "be",
      deliverable: "ADR-007 + 27 Tasks",
      staleMin: 60,
      driverOnly: false,
      createdAt: 1777087756,
      claimedAt: 1777087762,
      completedAt: 1777088527,
      claimedFrom: null,
      createdFrom: "commit",
      note: "27 Tasks landed",
    };
    const parsed = KanbanTask.parse(fullTask);
    expect(parsed.subject).toBe(fullTask.subject);
    expect(parsed.deps).toEqual(["t-aaa00001", "t-aaa00002"]);
    expect(parsed.lane).toBe("be");
    expect(parsed.driverOnly).toBe(false);
    expect(parsed.createdAt).toBe(1777087756);
    expect(parsed.claimedFrom).toBeNull();
  });

  test("ADR-263 §D3: git-source provenance fields (sourceKind / sourceId) parse", () => {
    const sourced = KanbanTask.parse({
      id: "t-1",
      subject: "Bug from upstream",
      status: "todo",
      sourceKind: "github",
      sourceId: "github:owner/repo#123",
    });
    expect(sourced.sourceKind).toBe("github");
    expect(sourced.sourceId).toBe("github:owner/repo#123");
  });

  test("ADR-263 §D3: provenance fields accept null (manual task) + omit (legacy)", () => {
    const nulled = KanbanTask.parse({ id: "t-2", sourceKind: null, sourceId: null });
    expect(nulled.sourceKind).toBeNull();
    expect(nulled.sourceId).toBeNull();
    const omitted = KanbanTask.parse({ id: "t-3" });
    expect(omitted.sourceKind).toBeUndefined();
    expect(omitted.sourceId).toBeUndefined();
  });

  test("nulls accepted on every nullable field (bash writes literal null)", () => {
    const allNulls = {
      id: "t-null0000",
      body: null,
      owner: null,
      priority: null,
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
          subject: "Decompose plan",
          status: "done",
          owner: "planner",
          deps: [],
          priority: null,
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
    };
    const parsed = Kanban.parse(realistic);
    expect(parsed.tasks).toHaveLength(2);
    // Both tasks parsed: one done with note, one fresh todo with nulls.
    expect(parsed.tasks[0]?.status).toBe("done");
    expect(parsed.tasks[1]?.owner).toBeNull();
  });
});

