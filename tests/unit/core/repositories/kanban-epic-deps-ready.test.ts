// ADR-225 repo round-trip — epics.depends_on + epics.is_ready.
//
// T2 of EPIC e-cf8a6195 (master design task t-802c468b). Pins the
// SQLite ↔ Zod boundary for the two new columns added in sqlite-
// migrations v13→v14:
//
//   - `depends_on TEXT NOT NULL DEFAULT '[]'` ↔ `KanbanEpic.dependsOn: string[]`
//     (JSON serialize on write; JSON parse on read).
//   - `is_ready INTEGER NOT NULL DEFAULT 0`   ↔ `KanbanEpic.isReady: boolean`
//     (0/1 ↔ boolean coercion).
//
// Setter API + cycle/self/existence validation lives in T3
// (src/core/epic.ts setEpicDependsOn / setEpicReady / epicIsEligible) —
// out of scope here.

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
  scratch = await mkdtemp(join(tmpdir(), "atmux-kanban-deps-ready-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new KanbanRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

describe("KanbanEpic.dependsOn round-trip", () => {
  test("upsertEpic + getEpic round-trips a non-empty dep list", () => {
    repo.upsertEpic({
      id: "e-chain",
      title: "downstream",
      status: "planning",
      dependsOn: ["e-up1", "e-up2"],
      isReady: false,
    });
    const back = repo.getEpic("e-chain");
    expect(back).not.toBeNull();
    expect(back?.dependsOn).toEqual(["e-up1", "e-up2"]);
  });

  test("write-side stores depends_on as JSON in the dedicated column (NOT extra)", () => {
    repo.upsertEpic({
      id: "e-store",
      title: "x",
      status: "planning",
      dependsOn: ["e-up1"],
      isReady: false,
    });
    const raw = db.prepare("SELECT depends_on, extra FROM epics WHERE id = 'e-store'").get() as {
      depends_on: string;
      extra: string | null;
    };
    expect(JSON.parse(raw.depends_on)).toEqual(["e-up1"]);
    // Extra JSON must not duplicate dependsOn (it's a known column now).
    if (raw.extra) {
      const parsed = JSON.parse(raw.extra) as Record<string, unknown>;
      expect(parsed.dependsOn).toBeUndefined();
      expect(parsed.depends_on).toBeUndefined();
    }
  });

  test("empty dependsOn round-trips as []", () => {
    repo.upsertEpic({
      id: "e-empty",
      title: "x",
      status: "planning",
      dependsOn: [],
      isReady: false,
    });
    const back = repo.getEpic("e-empty");
    expect(back?.dependsOn).toEqual([]);
  });

  test("re-upsert overwrites the dep list cleanly (no append)", () => {
    repo.upsertEpic({
      id: "e-mut",
      title: "x",
      status: "planning",
      dependsOn: ["e-old1", "e-old2"],
      isReady: false,
    });
    repo.upsertEpic({
      id: "e-mut",
      title: "x",
      status: "planning",
      dependsOn: ["e-new"],
      isReady: false,
    });
    const back = repo.getEpic("e-mut");
    expect(back?.dependsOn).toEqual(["e-new"]);
  });
});

describe("KanbanEpic.isReady round-trip", () => {
  test("isReady=true serializes as 1 + reads back as boolean true", () => {
    repo.upsertEpic({
      id: "e-rdy",
      title: "x",
      status: "planning",
      dependsOn: [],
      isReady: true,
    });
    const raw = db.prepare("SELECT is_ready FROM epics WHERE id = 'e-rdy'").get() as {
      is_ready: number;
    };
    expect(raw.is_ready).toBe(1);
    const back = repo.getEpic("e-rdy");
    expect(back?.isReady).toBe(true);
  });

  test("isReady=false serializes as 0 + reads back as boolean false", () => {
    repo.upsertEpic({
      id: "e-drf",
      title: "x",
      status: "planning",
      dependsOn: [],
      isReady: false,
    });
    const raw = db.prepare("SELECT is_ready FROM epics WHERE id = 'e-drf'").get() as {
      is_ready: number;
    };
    expect(raw.is_ready).toBe(0);
    const back = repo.getEpic("e-drf");
    expect(back?.isReady).toBe(false);
  });

  test("toggle true → false → true via re-upsert flips storage value", () => {
    repo.upsertEpic({
      id: "e-tog",
      title: "x",
      status: "planning",
      dependsOn: [],
      isReady: true,
    });
    expect(repo.getEpic("e-tog")?.isReady).toBe(true);

    repo.upsertEpic({
      id: "e-tog",
      title: "x",
      status: "planning",
      dependsOn: [],
      isReady: false,
    });
    expect(repo.getEpic("e-tog")?.isReady).toBe(false);

    repo.upsertEpic({
      id: "e-tog",
      title: "x",
      status: "planning",
      dependsOn: [],
      isReady: true,
    });
    expect(repo.getEpic("e-tog")?.isReady).toBe(true);
  });
});

describe("KanbanEpic legacy-row read path (defaults applied)", () => {
  // A row that landed via the migration backfill (or pre-T2 code path)
  // can have NULL-ish or zero-shaped values for the new columns. The
  // repo + schema together must coerce those to clean TS defaults.
  test("a row written via raw SQL with column defaults reads back as ([], false)", () => {
    db.prepare(`INSERT INTO epics (id, title, status, created_at) VALUES (?, ?, ?, ?)`).run(
      "e-legacy",
      "legacy",
      "in-progress",
      1_700_000_000,
    );
    const back = repo.getEpic("e-legacy");
    expect(back?.dependsOn).toEqual([]);
    expect(back?.isReady).toBe(false);
  });

  test("listEpics surfaces dependsOn + isReady on every row", () => {
    repo.upsertEpic({
      id: "e-a",
      title: "a",
      status: "planning",
      dependsOn: ["e-up"],
      isReady: true,
    });
    repo.upsertEpic({
      id: "e-b",
      title: "b",
      status: "planning",
      dependsOn: [],
      isReady: false,
    });
    const all = repo.listEpics();
    const byId = new Map(all.map((e) => [e.id, e]));
    expect(byId.get("e-a")?.dependsOn).toEqual(["e-up"]);
    expect(byId.get("e-a")?.isReady).toBe(true);
    expect(byId.get("e-b")?.dependsOn).toEqual([]);
    expect(byId.get("e-b")?.isReady).toBe(false);
  });
});
