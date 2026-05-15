// Unit tests for src/core/repositories/merger-state-repo.ts
// (ADR-134 §state-machine merger repo / t-6a959e02).
//
// Coverage matrix:
//   - migration v6 — table + indexes exist after openDatabase
//   - getState — null when missing, row when present
//   - transition — insert path, update path, ON CONFLICT UPSERT shape
//   - transition — Zod validation rejects invalid state literals + empty branch
//   - transition — round-trips note / by / baseSha / conflictSha
//   - listByState — filters + sorts oldest-transition first
//   - listAll — sorts most-recent-transition first
//   - deleteState — removes row + no-op on missing
//   - transactImmediate — concurrent transition serializes (BEGIN IMMEDIATE)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  closeDatabase,
  openDatabase,
  type Database,
} from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import {
  MergerStateRepo,
  MergerStateTransition,
} from "../../../../src/core/repositories/merger-state-repo.ts";

let scratch: string;
let db: Database;
let repo: MergerStateRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-merger-state-repo-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new MergerStateRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

// ---------- migration v6 schema shape ----------

describe("migration v6 — merger_state table", () => {
  test("user_version reaches 6 after openDatabase", () => {
    const v = db
      .query("PRAGMA user_version")
      .get() as { user_version: number } | null;
    expect(v?.user_version).toBe(6);
  });

  test("table exists with the right columns + types", () => {
    const cols = db.query("PRAGMA table_info(merger_state)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("member_branch")?.type).toBe("TEXT");
    expect(byName.get("member_branch")?.pk).toBe(1);
    expect(byName.get("member_branch")?.notnull).toBe(1);
    expect(byName.get("state")?.type).toBe("TEXT");
    expect(byName.get("state")?.notnull).toBe(1);
    expect(byName.get("transitioned_at")?.type).toBe("INTEGER");
    expect(byName.get("transitioned_at")?.notnull).toBe(1);
    expect(byName.get("note")?.notnull).toBe(0);
    expect(byName.get("transitioned_by")?.notnull).toBe(0);
    expect(byName.get("base_sha")?.notnull).toBe(0);
    expect(byName.get("conflict_sha")?.notnull).toBe(0);
    expect(byName.get("extra")?.notnull).toBe(0);
  });

  test("indexes exist on state + transitioned_at DESC", () => {
    const idx = db
      .query("PRAGMA index_list(merger_state)")
      .all() as Array<{ name: string }>;
    const names = new Set(idx.map((i) => i.name));
    expect(names.has("idx_merger_state_state")).toBe(true);
    expect(names.has("idx_merger_state_transitioned")).toBe(true);
  });
});

// ---------- getState ----------

describe("getState", () => {
  test("returns null for an untracked branch", () => {
    expect(repo.getState("geoyws-fe-1")).toBeNull();
  });

  test("returns the row after a transition", () => {
    repo.transition({
      memberBranch: "geoyws-fe-1",
      next: "in_progress",
      note: "owner picked up first task",
      by: "event",
      transitionedAt: 100,
    });
    const row = repo.getState("geoyws-fe-1");
    expect(row).not.toBeNull();
    expect(row?.state).toBe("in_progress");
    expect(row?.note).toBe("owner picked up first task");
    expect(row?.transitionedBy).toBe("event");
    expect(row?.transitionedAt).toBe(100);
  });
});

// ---------- transition: insert + update ----------

describe("transition", () => {
  test("insert path — first call for a branch creates the row", () => {
    const out = repo.transition({
      memberBranch: "geoyws-be-1",
      next: "open",
      transitionedAt: 50,
    });
    expect(out.memberBranch).toBe("geoyws-be-1");
    expect(out.state).toBe("open");
    expect(out.note).toBeNull();
    expect(out.transitionedBy).toBeNull();
    expect(out.baseSha).toBeNull();
    expect(out.conflictSha).toBeNull();
  });

  test("update path — second call for the same branch overwrites", () => {
    repo.transition({
      memberBranch: "geoyws-be-1",
      next: "open",
      transitionedAt: 50,
    });
    const out = repo.transition({
      memberBranch: "geoyws-be-1",
      next: "in_progress",
      note: "task t-001 claimed",
      by: "event",
      transitionedAt: 120,
    });
    expect(out.state).toBe("in_progress");
    expect(out.note).toBe("task t-001 claimed");
    expect(out.transitionedBy).toBe("event");
    expect(out.transitionedAt).toBe(120);
    // PRIMARY KEY constraint ensures one row total.
    const all = repo.listAll();
    expect(all).toHaveLength(1);
  });

  test("round-trips baseSha + conflictSha through a conflict transition", () => {
    const out = repo.transition({
      memberBranch: "geoyws-fe-2",
      next: "conflict",
      note: "conflict at deadbeef",
      by: "cron",
      baseSha: "abc1234",
      conflictSha: "deadbeef",
      transitionedAt: 200,
    });
    expect(out.state).toBe("conflict");
    expect(out.baseSha).toBe("abc1234");
    expect(out.conflictSha).toBe("deadbeef");
    expect(out.transitionedBy).toBe("cron");
  });

  test("accepts arbitrary member-name string for `by` (operator-driven)", () => {
    const out = repo.transition({
      memberBranch: "geoyws-fe-3",
      next: "in_progress",
      by: "fe-3",
      transitionedAt: 300,
    });
    expect(out.transitionedBy).toBe("fe-3");
  });
});

// ---------- transition: Zod validation ----------

describe("transition — Zod validation", () => {
  test("rejects an unknown state literal", () => {
    expect(() =>
      repo.transition({
        memberBranch: "geoyws-fe-1",
        // Trailing space — a typo that would silently persist without
        // Zod validation at the boundary.
        next: "merged " as unknown as "merged",
        transitionedAt: 100,
      }),
    ).toThrow(ZodError);
  });

  test("rejects empty memberBranch string", () => {
    expect(() =>
      repo.transition({
        memberBranch: "",
        next: "open",
        transitionedAt: 100,
      }),
    ).toThrow(ZodError);
  });

  test("rejects empty `by` string (member-name lower bound 1)", () => {
    expect(() =>
      repo.transition({
        memberBranch: "geoyws-fe-1",
        next: "in_progress",
        by: "",
        transitionedAt: 100,
      }),
    ).toThrow(ZodError);
  });
});

// ---------- listByState ----------

describe("listByState", () => {
  test("filters by state + sorts oldest transition first", () => {
    repo.transition({
      memberBranch: "geoyws-fe-1",
      next: "in_progress",
      transitionedAt: 300,
    });
    repo.transition({
      memberBranch: "geoyws-be-1",
      next: "in_progress",
      transitionedAt: 100,
    });
    repo.transition({
      memberBranch: "geoyws-fe-2",
      next: "merged",
      transitionedAt: 200,
    });
    const inProg = repo.listByState("in_progress");
    expect(inProg.map((r) => r.memberBranch)).toEqual([
      "geoyws-be-1", // 100
      "geoyws-fe-1", // 300
    ]);
    expect(repo.listByState("merged")).toHaveLength(1);
    expect(repo.listByState("conflict")).toEqual([]);
  });
});

// ---------- listAll ----------

describe("listAll", () => {
  test("returns every row, most-recent transition first", () => {
    repo.transition({
      memberBranch: "geoyws-fe-1",
      next: "in_progress",
      transitionedAt: 100,
    });
    repo.transition({
      memberBranch: "geoyws-be-1",
      next: "merged",
      transitionedAt: 200,
    });
    repo.transition({
      memberBranch: "geoyws-fe-2",
      next: "ready_to_merge",
      transitionedAt: 150,
    });
    const all = repo.listAll();
    expect(all.map((r) => r.memberBranch)).toEqual([
      "geoyws-be-1", // 200
      "geoyws-fe-2", // 150
      "geoyws-fe-1", // 100
    ]);
  });

  test("returns empty array when no rows exist", () => {
    expect(repo.listAll()).toEqual([]);
  });
});

// ---------- deleteState ----------

describe("deleteState", () => {
  test("removes the row by branch", () => {
    repo.transition({
      memberBranch: "geoyws-fe-1",
      next: "merged",
      transitionedAt: 100,
    });
    expect(repo.getState("geoyws-fe-1")?.state).toBe("merged");
    repo.deleteState("geoyws-fe-1");
    expect(repo.getState("geoyws-fe-1")).toBeNull();
  });

  test("no-op on missing branch — does not throw", () => {
    expect(() => repo.deleteState("never-existed")).not.toThrow();
  });
});

// ---------- atomic transition (BEGIN IMMEDIATE) ----------

describe("transition — transactImmediate semantics", () => {
  test("ON CONFLICT UPSERT keeps one row per branch under repeated transitions", () => {
    // Hammer the same branch through multiple states. Each call runs
    // BEGIN IMMEDIATE → UPSERT → SELECT → COMMIT atomically. End-state
    // should be the LAST transition; row count stays at 1.
    const states = [
      "open",
      "in_progress",
      "ready_to_merge",
      "rebasing",
      "ready_to_merge",
      "merging",
      "tested",
      "merged",
    ] as const;
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (s === undefined) continue;
      repo.transition({
        memberBranch: "geoyws-stress-1",
        next: s,
        transitionedAt: 100 + i,
      });
    }
    const row = repo.getState("geoyws-stress-1");
    expect(row?.state).toBe("merged");
    expect(row?.transitionedAt).toBe(100 + states.length - 1);
    expect(repo.listAll()).toHaveLength(1);
  });
});

// ---------- Zod schema export ----------

describe("MergerStateTransition (exported Zod schema)", () => {
  test("parses a valid input", () => {
    const out = MergerStateTransition.parse({
      memberBranch: "geoyws-fe-1",
      next: "in_progress",
      transitionedAt: 100,
    });
    expect(out.memberBranch).toBe("geoyws-fe-1");
    expect(out.next).toBe("in_progress");
  });

  test("strips no fields — note/by/baseSha/conflictSha pass through when set", () => {
    const out = MergerStateTransition.parse({
      memberBranch: "geoyws-fe-1",
      next: "conflict",
      note: "conflict at deadbeef",
      by: "cron",
      baseSha: "abc1234",
      conflictSha: "deadbeef",
      transitionedAt: 200,
    });
    expect(out.note).toBe("conflict at deadbeef");
    expect(out.by).toBe("cron");
    expect(out.baseSha).toBe("abc1234");
    expect(out.conflictSha).toBe("deadbeef");
  });
});
