// Regression test for tasks.role typed column (v11 migration).

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
  scratch = await mkdtemp(join(tmpdir(), "atmux-kanban-role-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new KanbanRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

describe("KanbanTask.role typed column", () => {
  test("upsertTask stores role in tasks.role column", () => {
    repo.upsertTask({
      id: "t-rolepass",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    const raw = db
      .query<{ role: string | null }, []>("SELECT role FROM tasks WHERE id = 't-rolepass'")
      .get() as { role: string | null };
    expect(raw.role).toBe("reviewer-trunk-signoff");
  });

  test("getTask reads role back", () => {
    repo.upsertTask({
      id: "t-roleback",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    expect(repo.getTask("t-roleback")?.role).toBe("reviewer-trunk-signoff");
  });

  test("production gate query matches role column", () => {
    repo.upsertTask({ id: "t-feature1", subject: "feature", status: "done" });
    repo.upsertTask({
      id: "t-signoff1",
      subject: "trunk signoff",
      status: "done",
      role: "reviewer-trunk-signoff",
    });
    repo.upsertTask({
      id: "t-signoff2",
      subject: "pending signoff",
      status: "in-progress",
      role: "reviewer-trunk-signoff",
    });
    const row = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE status = 'done' AND role = 'reviewer-trunk-signoff'`,
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
  });
});
