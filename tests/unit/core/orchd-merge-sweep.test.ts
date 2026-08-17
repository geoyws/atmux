import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { sweepMerges } from "../../../src/core/orchd-merge-sweep.ts";
import type { Kanban } from "../../../src/schema/kanban.ts";

describe("sweepMerges external snapshot", () => {
  let scratch: string;
  let db: Database;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-orchd-merge-sweep-"));
    db = openDatabase(join(scratch, "state.db"), migrations);
  });

  afterEach(async () => {
    db.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("uses adapter snapshot instead of empty legacy work-state tables", async () => {
    const snapshot = {
      epics: [
        {
          id: "e-external",
          status: "done",
          dependsOn: [],
          isReady: true,
          extra: {},
        },
      ],
      stories: [],
      tasks: [
        {
          id: "t-external",
          subject: "external task",
          status: "done",
          epic: "e-external",
          completedAt: 100,
        },
      ],
    } as Kanban;
    const dispatched: string[] = [];

    const result = await sweepMerges({
      db,
      loadKanban: async () => snapshot,
      nowSec: () => 1_000,
      attendedWindowSec: 300,
      dispatchEpicMerge: async (epicId) => {
        dispatched.push(epicId);
        return { state: "already-merged" };
      },
    });

    expect(dispatched).toEqual(["e-external"]);
    expect(result.epicsConsidered).toBe(1);
    expect(result.epicsDispatchedSkipped).toBe(1);
  });
});
