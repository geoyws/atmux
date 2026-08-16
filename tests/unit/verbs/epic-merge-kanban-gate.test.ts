import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { readKanbanGateFacts } from "../../../src/verbs/epic-merge.ts";

describe("epic merge Kanban gate projection", () => {
  let scratch = "";

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("counts open work and reviewer signoff through canonical load", async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-epic-gate-"));
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir);
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    db.prepare("INSERT INTO tasks (id,subject,status,created_at) VALUES (?,?,?,?)").run(
      "t-open",
      "open",
      "todo",
      1,
    );
    db.prepare("INSERT INTO tasks (id,subject,status,created_at,extra) VALUES (?,?,?,?,?)").run(
      "t-signoff",
      "signoff",
      "done",
      1,
      JSON.stringify({ role: "reviewer-trunk-signoff" }),
    );
    closeDatabase(db);

    expect(await readKanbanGateFacts(atmuxDir)).toEqual({
      ownerOpenTaskCount: 1,
      hasReviewerTrunkSignoff: true,
    });
  });
});
