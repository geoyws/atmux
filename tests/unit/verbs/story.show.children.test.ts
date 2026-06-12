// Unit tests for `atmux story show` Tasks render (ADR-173 §69).
// Covers: empty story → explicit "Tasks:\n  (none)" marker (not silent
// omission); story with tasks → task rows; --json keys present.

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
import { story } from "../../../src/verbs/story.ts";

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
  teamDir = await mkdtemp(join(tmpdir(), "atmux-story-show-children-"));
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

/** Link a task to a story by direct repo upsert (addTask takes no story). */
function linkTaskToStory(taskId: string, sid: string): void {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new KanbanRepo(db);
  const t = repo.getTask(taskId);
  if (t !== null) repo.upsertTask({ ...t, story: sid });
  closeDatabase(db);
}

describe("story show children render (ADR-173 §69)", () => {
  test("empty story → explicit 'Tasks:\\n  (none)' marker", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "Childless slice", epic: eid });
    const { out } = await captureStdout(() => story(["show", sid, "--team-dir", teamDir]));
    // Header present + explicit empty marker — NOT silently omitted.
    expect(out).toContain("Tasks:\n  (none)");
    // Guard against false-green: no task id leaked into the rendered tree.
    expect(out).not.toMatch(/^\s+t-/m);
  });

  test("story with tasks → task rows, no '(none)' marker", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const tid = await addTask(atmuxDir, { subject: "child task", lane: "be" });
    linkTaskToStory(tid, sid);
    const { out } = await captureStdout(() => story(["show", sid, "--team-dir", teamDir]));
    expect(out).toContain("Tasks:");
    expect(out).toContain(`  ${tid} [`);
    // Lane appears in the row per the existing render format.
    expect(out).toContain("(be)");
    // Populated section must NOT show the empty marker.
    expect(out).not.toContain("(none)");
  });

  test("--json mode exposes tasks key", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const tid = await addTask(atmuxDir, { subject: "child task" });
    linkTaskToStory(tid, sid);
    const { out } = await captureStdout(() =>
      story(["show", sid, "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(sid);
    expect(parsed.epic).toBe(eid);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks.map((t: { id: string }) => t.id)).toEqual([tid]);
  });

  test("--json mode on empty story → tasks is empty array", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "Empty", epic: eid });
    const { out } = await captureStdout(() =>
      story(["show", sid, "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks).toHaveLength(0);
  });
});
