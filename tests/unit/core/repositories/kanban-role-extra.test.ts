// Regression test for t-95264384 — tasks.role contract.
//
// Background: ADR-090 §Decision-anchor #1 introduced
// `KanbanTask.role` as the canonical marker for the reviewer-trunk-
// signoff Task. The v1 `tasks` table has NO `role` column; the schema
// is `.passthrough()` so the repo's taskToRow funnels unknown fields
// into the `extra` JSON column. Consumers (e.g. ADR-091 §EPIC-done
// gate in `src/verbs/epic-merge.ts::defaultResolveGate`) MUST read
// the field via `extra->>'$.role'` not `role` directly — a direct
// column read returns NULL on every row (SQLite STRICT-mode would
// throw; STRICT is on but the missing-column path returns "no rows
// matched" because the column literal is treated as NULL).
//
// This test pins the contract:
//
//   1. KanbanRepo.upsertTask(task with role) → row.extra contains
//      `{"role":"..."}`.
//   2. KanbanRepo.getTask(id) → returns Task with role round-tripped.
//   3. SQLite `extra->>'$.role'` query matches Tasks with role set
//      and skips Tasks without role.
//   4. JSON1 `json_extract(extra, '$.role')` is equivalent to the
//      `->>'$.role'` text operator (cross-syntax compat).
//
// If a future change moves role to a real column (migration), this
// test surfaces the contract change: the `extra->>'$.role'` query
// must keep working OR consumers must be migrated to read the new
// column. Keep both paths green or land a deliberate ADR-094 follow-up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import { KanbanRepo } from "../../../../src/core/repositories/kanban-repo.ts";

let scratch: string;
let db: Database;
let repo: KanbanRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-kanban-role-extra-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new KanbanRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

describe("KanbanTask.role round-trip via extra JSON (t-95264384)", () => {
  test("upsertTask stores role in extra JSON column (NOT a top-level column)", () => {
    repo.upsertTask({
      id: "t-rolepass",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    const raw = db
      .query<{ role: string | null; extra: string | null }, []>(
        "SELECT extra FROM tasks WHERE id = 't-rolepass'",
      )
      .get() as { extra: string | null };
    expect(raw.extra).not.toBeNull();
    const parsed = JSON.parse(raw.extra ?? "{}") as { role?: string };
    expect(parsed.role).toBe("reviewer-trunk-signoff");
  });

  test("getTask reads role back from extra JSON", () => {
    repo.upsertTask({
      id: "t-roleback",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    const back = repo.getTask("t-roleback");
    expect(back).not.toBeNull();
    expect(back?.role).toBe("reviewer-trunk-signoff");
  });

  test("Task without role → extra column is NULL", () => {
    repo.upsertTask({
      id: "t-noroleA",
      subject: "regular task",
      status: "done",
    });
    const raw = db
      .query<{ extra: string | null }, []>("SELECT extra FROM tasks WHERE id = 't-noroleA'")
      .get() as { extra: string | null };
    expect(raw.extra).toBeNull();
  });

  test("SQLite `extra->>'$.role'` query matches role-tagged Tasks (production gate query)", () => {
    // Mirrors the production query in defaultResolveGate after the
    // t-95264384 fix:
    //   SELECT COUNT(*) FROM tasks
    //   WHERE status = 'done' AND extra->>'$.role' = 'reviewer-trunk-signoff'
    repo.upsertTask({
      id: "t-feature1",
      subject: "feature task",
      status: "done",
    });
    repo.upsertTask({
      id: "t-signoff1",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    // Add another role-tagged Task NOT in done — should not match.
    repo.upsertTask({
      id: "t-signoff2",
      subject: "still pending",
      status: "in-progress",
      role: "reviewer-trunk-signoff",
    });
    // Add a Task with a different role marker — should not match.
    repo.upsertTask({
      id: "t-otherrole",
      subject: "other role",
      status: "done",
      role: "epic-ship-gate",
    });
    const row = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE status = 'done' AND extra->>'$.role' = 'reviewer-trunk-signoff'`,
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  test("`extra->>'$.role'` returns NULL on Tasks without role (no false-positive matches)", () => {
    repo.upsertTask({
      id: "t-bareA",
      subject: "no role",
      status: "done",
    });
    const row = db
      .query<{ r: string | null }, []>(
        "SELECT extra->>'$.role' AS r FROM tasks WHERE id = 't-bareA'",
      )
      .get() as { r: string | null };
    expect(row.r).toBeNull();
  });

  test("`json_extract(extra, '$.role')` is equivalent to `extra->>'$.role'`", () => {
    repo.upsertTask({
      id: "t-jsonpath",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    const a = db
      .query<{ r: string | null }, []>(
        "SELECT extra->>'$.role' AS r FROM tasks WHERE id = 't-jsonpath'",
      )
      .get() as { r: string | null };
    const b = db
      .query<{ r: string | null }, []>(
        "SELECT json_extract(extra, '$.role') AS r FROM tasks WHERE id = 't-jsonpath'",
      )
      .get() as { r: string | null };
    expect(a.r).toBe("reviewer-trunk-signoff");
    expect(b.r).toBe("reviewer-trunk-signoff");
    expect(a.r).toBe(b.r);
  });
});
