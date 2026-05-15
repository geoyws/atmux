// Unit tests for src/core/repositories/merger-state-repo.ts
// (ADR-134 §state-machine / t-b5f12ab1).
//
// Coverage:
//   - migration v5→v6 lands the `merger_state` table + indices
//   - load: present row vs absent row
//   - loadAll: ordering by updated_at DESC
//   - loadOpen: partial-index filter (skips terminal states)
//   - upsertOpen: idempotent (no-op on existing row)
//   - transition: BEGIN IMMEDIATE happy path, fromState guard
//     (no-op on missing row, no-op on state-mismatch), surfaces
//     observedFrom, refreshes updated_at + note, atomic rollback
//     on throw

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabase,
  type Database,
  openDatabase,
} from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import { MergerStateRepo } from "../../../../src/core/repositories/merger-state-repo.ts";

let scratch: string;
let db: Database;
let repo: MergerStateRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-merger-repo-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new MergerStateRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Migration shape ----------

describe("merger_state migration v5→v6", () => {
  test("table exists with expected columns + CHECK constraint", () => {
    const cols = db
      .query("PRAGMA table_info(merger_state)")
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["branch_key", "note", "state", "team", "updated_at"]);
    // PK is composite (team, branch_key) — both have pk > 0.
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(["branch_key", "team"]);
    // CHECK constraint refuses invalid state literals.
    expect(() =>
      db
        .prepare(
          "INSERT INTO merger_state (team, branch_key, state, note, updated_at) VALUES (?,?,?,?,?)",
        )
        .run("t", "b", "garbage-state", null, 0),
    ).toThrow();
  });

  test("indices created (idx_merger_state_team_updated + idx_merger_state_open)", () => {
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='merger_state'")
      .all() as Array<{ name: string }>;
    const names = idx.map((r) => r.name).sort();
    expect(names).toContain("idx_merger_state_team_updated");
    expect(names).toContain("idx_merger_state_open");
  });
});

// ---------- load + loadAll + loadOpen ----------

describe("MergerStateRepo.load / loadAll / loadOpen", () => {
  test("load returns null when absent", () => {
    expect(repo.load("t1", "b1")).toBeNull();
  });

  test("load returns row when present", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    const row = repo.load("t1", "b1");
    expect(row).toMatchObject({
      team: "t1",
      branchKey: "b1",
      state: "open",
      note: null,
      updatedAt: 100,
    });
  });

  test("loadAll orders by updated_at DESC", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    repo.upsertOpen({ team: "t1", branchKey: "b2", now: 300 });
    repo.upsertOpen({ team: "t1", branchKey: "b3", now: 200 });
    const rows = repo.loadAll("t1");
    expect(rows.map((r) => r.branchKey)).toEqual(["b2", "b3", "b1"]);
  });

  test("loadAll filters by team", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    repo.upsertOpen({ team: "t2", branchKey: "b1", now: 100 });
    expect(repo.loadAll("t1")).toHaveLength(1);
    expect(repo.loadAll("t2")).toHaveLength(1);
    expect(repo.loadAll("t3")).toHaveLength(0);
  });

  test("loadOpen skips terminal states (merged / conflict / reverted)", () => {
    // Seed two open + three terminals.
    repo.upsertOpen({ team: "t1", branchKey: "open1", now: 100 });
    repo.upsertOpen({ team: "t1", branchKey: "open2", now: 110 });
    repo.upsertOpen({ team: "t1", branchKey: "merged1", now: 120 });
    repo.upsertOpen({ team: "t1", branchKey: "conflict1", now: 130 });
    repo.upsertOpen({ team: "t1", branchKey: "reverted1", now: 140 });
    // Advance the three terminals.
    repo.transition({
      team: "t1",
      branchKey: "merged1",
      fromState: "open",
      toState: "merged",
      note: null,
      now: 150,
    });
    repo.transition({
      team: "t1",
      branchKey: "conflict1",
      fromState: "open",
      toState: "conflict",
      note: null,
      now: 160,
    });
    repo.transition({
      team: "t1",
      branchKey: "reverted1",
      fromState: "open",
      toState: "reverted",
      note: null,
      now: 170,
    });
    const openRows = repo.loadOpen("t1");
    expect(openRows.map((r) => r.branchKey).sort()).toEqual(["open1", "open2"]);
  });
});

// ---------- upsertOpen ----------

describe("MergerStateRepo.upsertOpen", () => {
  test("insert returns true on fresh row; second call returns false (idempotent no-op)", () => {
    const first = repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    expect(first).toBe(true);
    const second = repo.upsertOpen({ team: "t1", branchKey: "b1", now: 200 });
    expect(second).toBe(false);
    // updated_at NOT bumped on no-op (the existing state is authoritative).
    expect(repo.load("t1", "b1")?.updatedAt).toBe(100);
  });
});

// ---------- transition ----------

describe("MergerStateRepo.transition", () => {
  test("happy path: open → in_progress applied; row updated", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    const r = repo.transition({
      team: "t1",
      branchKey: "b1",
      fromState: "open",
      toState: "in_progress",
      note: "owner started",
      now: 200,
    });
    expect(r).toEqual({ applied: true, observedFrom: "open" });
    const after = repo.load("t1", "b1");
    expect(after).toMatchObject({
      state: "in_progress",
      note: "owner started",
      updatedAt: 200,
    });
  });

  test("missing row → applied: false, observedFrom: null", () => {
    const r = repo.transition({
      team: "t1",
      branchKey: "missing",
      fromState: "open",
      toState: "in_progress",
      note: null,
      now: 100,
    });
    expect(r).toEqual({ applied: false, observedFrom: null });
  });

  test("state mismatch → applied: false, observedFrom = current state, row untouched", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    // Sibling writer already advanced the row.
    repo.transition({
      team: "t1",
      branchKey: "b1",
      fromState: "open",
      toState: "in_progress",
      note: "first writer",
      now: 200,
    });
    // Second writer tries with stale fromState.
    const r = repo.transition({
      team: "t1",
      branchKey: "b1",
      fromState: "open",
      toState: "ready_to_merge",
      note: "stale writer",
      now: 300,
    });
    expect(r).toEqual({ applied: false, observedFrom: "in_progress" });
    // Row untouched by the stale writer.
    const after = repo.load("t1", "b1");
    expect(after?.state).toBe("in_progress");
    expect(after?.note).toBe("first writer");
    expect(after?.updatedAt).toBe(200);
  });

  test("note can be null (clear operator-facing reason)", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    repo.transition({
      team: "t1",
      branchKey: "b1",
      fromState: "open",
      toState: "in_progress",
      note: null,
      now: 200,
    });
    expect(repo.load("t1", "b1")?.note).toBeNull();
  });

  test("invalid toState (CHECK constraint) throws + rolls back", () => {
    repo.upsertOpen({ team: "t1", branchKey: "b1", now: 100 });
    expect(() =>
      repo.transition({
        team: "t1",
        branchKey: "b1",
        fromState: "open",
        // @ts-expect-error — testing the database-level guard for a
        // value outside the BranchMergeState union (a bug in caller
        // code that bypassed the type-system gate).
        toState: "garbage",
        note: null,
        now: 200,
      }),
    ).toThrow();
    // Row untouched after the failed transition (rollback fired).
    const after = repo.load("t1", "b1");
    expect(after?.state).toBe("open");
    expect(after?.updatedAt).toBe(100);
  });
});
