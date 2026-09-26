// Unit tests for e-41 T1 origin_team schema leg (t-367c5c03, ADR-150 §D3):
//   - v17→v18 migration adds the nullable column (user_version 18)
//   - insert/getById round-trips originTeam
//   - legacy rows (NULL) read as originTeam null (backward-compat)

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { ComplaintsRepo } from "../../../src/core/repositories/complaints-repo.ts";
import { Complaint } from "../../../src/schema/complaints.ts";

let teamDir: string;
let db: Database;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-complaints-origin-"));
  db = openDatabase(join(teamDir, "state.db"), migrations);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(teamDir, { recursive: true, force: true });
});

function sample(id: string): Complaint {
  return Complaint.parse({
    id,
    openedAt: 1000,
    openedBy: "cli",
    incidentSummary: "x",
    status: "open",
  });
}

describe("origin_team migration", () => {
  test("schema sits at v18 with nullable column", () => {
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(18);
    const cols = db.query("PRAGMA table_info(complaints)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === "origin_team");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  test("insert/getById round-trips originTeam", () => {
    const repo = new ComplaintsRepo(db);
    repo.insert({ ...sample("c-00000001"), originTeam: "team-a", targetTeam: "team-b" });
    const got = repo.getById("c-00000001");
    expect(got?.originTeam).toBe("team-a");
    expect(got?.targetTeam).toBe("team-b");
  });

  test("legacy NULL rows read as originTeam null", () => {
    const repo = new ComplaintsRepo(db);
    repo.insert(sample("c-00000002"));
    expect(repo.getById("c-00000002")?.originTeam).toBeNull();
  });
});
