// Unit tests for the nested-state-db doctor guard (e-39 item 4; t-a20da986):
//   - findNestedStateDb() — readdir walk for nested `.atmux` dirs + stub
//     `state.db` files outside the canonical root DB
//   - checkNestedStateDb() — red-row composer (green path emits no rows)
//   - archiveNestedStateDb() — move orphans under archives/, preserving rel
//
// Imports state.ts directly (not the doctor.ts barrel): the barrel pulls
// ./doctor/nesting.ts, which is lane-untracked sibling WIP (t-62/t-63
// follow-up) and unresolvable in this tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveNestedStateDb,
  checkNestedStateDb,
  findNestedStateDb,
} from "../../../src/verbs/doctor/state.ts";

let scratch = "";

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-doctor-nested-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function mkfile(rel: string): Promise<string> {
  const abs = join(scratch, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, "x");
  return abs;
}

describe("findNestedStateDb", () => {
  test("clean tree (canonical state.db only) → no offenders", async () => {
    await mkfile("state.db");
    await mkfile("team.json");
    expect(await findNestedStateDb(scratch)).toEqual([]);
  });

  test("nested .atmux dir under worktrees → nested-atmux-dir offender", async () => {
    await mkfile("worktrees/driver/.atmux/stub");
    const found = await findNestedStateDb(scratch);
    expect(found).toEqual([{ rel: "worktrees/driver/.atmux", kind: "nested-atmux-dir" }]);
  });

  test("stub state.db outside root → stub-state-db offender, canonical ignored", async () => {
    await mkfile("state.db");
    await mkfile("worktrees/driver/state.db");
    const found = await findNestedStateDb(scratch);
    expect(found).toEqual([{ rel: "worktrees/driver/state.db", kind: "stub-state-db" }]);
  });

  test("beyond depth cap → not reported", async () => {
    await mkfile("a/b/c/d/e/state.db");
    expect(await findNestedStateDb(scratch)).toEqual([]);
  });
});

describe("checkNestedStateDb", () => {
  test("clean tree → no rows", async () => {
    await mkfile("state.db");
    expect(await checkNestedStateDb(scratch)).toEqual([]);
  });

  test("offenders → single red nested-state-db row naming paths", async () => {
    await mkfile("worktrees/driver/.atmux/stub");
    const rows = await checkNestedStateDb(scratch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("nested-state-db");
    expect(rows[0]?.detail).toMatch(/worktrees\/driver\/\.atmux/);
    expect(rows[0]?.hint).toMatch(/doctor --fix/);
  });
});

describe("archiveNestedStateDb", () => {
  test("moves offenders under archives/, preserving rel paths", async () => {
    await mkfile("worktrees/driver/state.db");
    const offenders = await findNestedStateDb(scratch);
    expect(offenders).toHaveLength(1);
    const archived = await archiveNestedStateDb(scratch, offenders, 1234);
    expect(archived).toEqual(["worktrees/driver/state.db"]);
    expect(existsSync(join(scratch, "worktrees/driver/state.db"))).toBe(false);
    expect(existsSync(join(scratch, "archives/nested-state-db-1234/worktrees/driver/state.db"))).toBe(
      true,
    );
    expect(await findNestedStateDb(scratch)).toEqual([]);
  });

  test("archives/ quarantine zone is never re-reported", async () => {
    await mkfile("archives/nested-state-db-1/worktrees/driver/state.db");
    await mkfile("archives/nested-state-db-1/worktrees/driver/.atmux/stub");
    expect(await findNestedStateDb(scratch)).toEqual([]);
  });
});
