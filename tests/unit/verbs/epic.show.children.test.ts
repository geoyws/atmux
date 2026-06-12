// Unit tests for `atmux epic show` children render (ADR-173 §69 + §139).
// Covers: empty epic → explicit "(none)" markers (not silent omission);
// stories+tasks → nested tree; --json keys present; `.epic: null` absorbed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { addEpic } from "../../../src/core/epic.ts";
import { addTask } from "../../../src/core/kanban.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import { addStory } from "../../../src/core/story.ts";
import { epic } from "../../../src/verbs/epic.ts";

let teamDir: string;
let atmuxDir: string;

async function seedTeam(): Promise<void> {
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "team",
      members: [{ name: "alpha", role: "member" }],
    }),
  );
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-epic-show-children-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await seedTeam();
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

/** Hard-write the epic link onto a direct (storyless) task, since
 *  addTask doesn't take an epic option. Mirrors epic.test.ts seeding. */
function linkTaskToEpic(taskId: string, eid: string, story?: string): void {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new KanbanRepo(db);
  const t = repo.getTask(taskId);
  if (t !== null) {
    const upd = { ...t, epic: eid };
    if (story !== undefined) upd.story = story;
    repo.upsertTask(upd);
  }
  closeDatabase(db);
}

describe("epic show children render (ADR-173 §69)", () => {
  test("empty epic → explicit '(none)' markers for both sections", async () => {
    const eid = await addEpic(atmuxDir, { title: "Lonely epic" });
    const { out } = await captureStdout(() => epic(["show", eid, "--team-dir", teamDir]));
    // Headers are present, and each empty section renders the explicit
    // marker — NOT silently omitted (the pre-fix behaviour).
    expect(out).toContain("Stories:\n  (none)");
    expect(out).toContain("Direct tasks:\n  (none)");
    // Guard against false-green: confirm the section was actually empty
    // (no story/task ids leaked into the output).
    expect(out).not.toMatch(/^\s+s-/m);
    expect(out).not.toMatch(/^\s+t-/m);
  });

  test("stories + tasks → nested tree, no '(none)' markers", async () => {
    const eid = await addEpic(atmuxDir, { title: "Big work" });
    const sid = await addStory(atmuxDir, { title: "First slice", epic: eid });
    // A task under the story (nested) and a direct task (no story).
    const storyTid = await addTask(atmuxDir, { subject: "Nested task" });
    linkTaskToEpic(storyTid, eid, sid);
    const directTid = await addTask(atmuxDir, { subject: "Direct task" });
    linkTaskToEpic(directTid, eid);

    const { out } = await captureStdout(() => epic(["show", eid, "--team-dir", teamDir]));
    // Story row + its nested task under "Stories:".
    expect(out).toContain("Stories:");
    expect(out).toContain(`  ${sid} [`);
    expect(out).toContain(`    task ${storyTid} [`);
    // Direct (storyless) task under "Direct tasks:".
    expect(out).toContain("Direct tasks:");
    expect(out).toContain(`  ${directTid} [`);
    // Populated sections must NOT show the empty marker.
    expect(out).not.toContain("(none)");
  });

  test("--json mode exposes children keys (stories + tasks)", async () => {
    const eid = await addEpic(atmuxDir, { title: "T" });
    const sid = await addStory(atmuxDir, { title: "child", epic: eid });
    const tid = await addTask(atmuxDir, { subject: "direct" });
    linkTaskToEpic(tid, eid);

    const { out } = await captureStdout(() =>
      epic(["show", eid, "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(eid);
    // ADR-173 JSON mode: children keys present + populated from the join.
    expect(Array.isArray(parsed.stories)).toBe(true);
    expect(parsed.stories.map((s: { id: string }) => s.id)).toEqual([sid]);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks.map((t: { id: string }) => t.id)).toContain(tid);
    // The internal storyRows alias is stripped on output (matches bash shape).
    expect(parsed.storyRows).toBeUndefined();
  });

  test("absorbs `.epic: null` tasks gracefully — direct section stays '(none)'", async () => {
    // ADR-173 §139: a task with no epic link must NOT leak into this
    // epic's direct-task section; the join returns empty → "(none)".
    const eid = await addEpic(atmuxDir, { title: "Isolated" });
    const orphanTid = await addTask(atmuxDir, { subject: "Orphan (epic=null)" });

    const { out } = await captureStdout(() => epic(["show", eid, "--team-dir", teamDir]));
    expect(out).toContain("Direct tasks:\n  (none)");
    expect(out).not.toContain(orphanTid);
  });
});
