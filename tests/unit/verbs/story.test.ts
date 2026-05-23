// Unit tests for src/verbs/story.ts + src/core/story.ts (ADR-007 + ADR-010).
// Bash spec: lib/story.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { addEpic, advanceEpic, listEpics } from "../../../src/core/epic.ts";
import { addTask, moveTask } from "../../../src/core/kanban.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import {
  addStory,
  advanceStory,
  listStories,
  showStory,
  storyLegalTransition,
  storyNextState,
  storySignoff,
  storyUnsignoff,
} from "../../../src/core/story.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  parseAddArgs,
  parseListArgs,
  parseSignoffFlags,
  story,
} from "../../../src/verbs/story.ts";

let teamDir: string;
let atmuxDir: string;

async function seedTeam(): Promise<void> {
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "team",
      members: [
        { name: "lead", role: "team-lead" },
        { name: "reviewer", role: "reviewer" },
        { name: "gitter", role: "gitter" },
        { name: "alpha", role: "member" },
      ],
    }),
  );
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-story-verb-"));
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

/** Link a task to a story (and optionally lane=test) by direct repo upsert. */
function linkTaskToStory(taskId: string, sid: string, lane?: string): void {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new KanbanRepo(db);
  const t = repo.getTask(taskId);
  if (t !== null) {
    const upd = { ...t, story: sid };
    if (lane !== undefined) upd.lane = lane;
    repo.upsertTask(upd);
  }
  closeDatabase(db);
}

// ---------- Pure: parseAddArgs ----------

describe("story parseAddArgs", () => {
  test("requires title + --epic", () => {
    expect(() => parseAddArgs([])).toThrow(UsageError);
    expect(() => parseAddArgs(["t"])).toThrow(UsageError); // missing --epic
    const a = parseAddArgs(["title", "--epic", "e-1"]);
    expect(a.title).toBe("title");
    expect(a.epic).toBe("e-1");
  });

  test("--body / --ac captured", () => {
    const a = parseAddArgs(["t", "--epic", "e-1", "--body", "B", "--ac", "user can X"]);
    expect(a.body).toBe("B");
    expect(a.ac).toBe("user can X");
  });

  test("`--` collects rest as title", () => {
    const a = parseAddArgs(["--epic", "e-1", "--", "title", "with", "dashes"]);
    expect(a.title).toBe("title with dashes");
  });
});

// ---------- Pure: parseListArgs ----------

describe("story parseListArgs", () => {
  test("--epic required", () => {
    expect(() => parseListArgs([])).toThrow(UsageError);
  });

  test("--epic + --json", () => {
    const a = parseListArgs(["--epic", "e-1", "--json"]);
    expect(a.epic).toBe("e-1");
    expect(a.json).toBe(true);
  });

  test("--status", () => {
    expect(parseListArgs(["--epic", "e-1", "--status", "ready"]).status).toBe("ready");
  });
});

// ---------- Pure: state machine ----------

describe("storyNextState + storyLegalTransition", () => {
  test("full forward chain", () => {
    expect(storyNextState("planning")).toBe("ready");
    expect(storyNextState("ready")).toBe("in-progress");
    expect(storyNextState("in-progress")).toBe("testing");
    expect(storyNextState("testing")).toBe("review");
    expect(storyNextState("review")).toBe("merging");
    expect(storyNextState("merging")).toBe("done");
    expect(storyNextState("done")).toBe(null);
  });

  test("same-state idempotent", () => {
    expect(storyLegalTransition("ready", "ready")).toBe(true);
  });

  test("forward two steps illegal", () => {
    expect(storyLegalTransition("planning", "in-progress")).toBe(false);
  });
});

// ---------- IO: addStory ----------

describe("addStory", () => {
  test("creates a story under existing epic", async () => {
    const eid = await addEpic(atmuxDir, { title: "Big" });
    const sid = await addStory(atmuxDir, { title: "Slice 1", epic: eid });
    expect(sid).toMatch(/^s-[1-9][0-9]*-[0-9a-f]{8}$/);
    const stories = await listStories(atmuxDir, { epic: eid });
    expect(stories.map((s) => s.id)).toEqual([sid]);
    expect(stories[0]?.status).toBe("planning");
  });

  test("appends to parent epic's stories[] array", async () => {
    const eid = await addEpic(atmuxDir, { title: "Big" });
    const sid = await addStory(atmuxDir, { title: "Slice 1", epic: eid });
    const epicRow = (await listEpics(atmuxDir)).find((e) => e.id === eid);
    expect(epicRow?.stories).toContain(sid);
  });

  test("body + acceptanceCriteria captured", async () => {
    const eid = await addEpic(atmuxDir, { title: "Big" });
    const sid = await addStory(atmuxDir, {
      title: "Slice",
      epic: eid,
      body: "details",
      acceptanceCriteria: "user can X",
    });
    const story = (await listStories(atmuxDir, { epic: eid })).find((s) => s.id === sid);
    expect(story?.body).toBe("details");
    expect(story?.acceptanceCriteria).toBe("user can X");
  });

  test("unknown epic → ConfigError", async () => {
    await expect(addStory(atmuxDir, { title: "t", epic: "e-bogus" })).rejects.toThrow(ConfigError);
  });

  test("empty title → UsageError", async () => {
    const eid = await addEpic(atmuxDir, { title: "X" });
    await expect(addStory(atmuxDir, { title: "  ", epic: eid })).rejects.toThrow(UsageError);
  });

  test("empty epic → UsageError", async () => {
    await expect(addStory(atmuxDir, { title: "t", epic: "" })).rejects.toThrow(UsageError);
  });
});

describe("listStories filtering", () => {
  test("by status", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const a = await addStory(atmuxDir, { title: "A", epic: eid });
    await addStory(atmuxDir, { title: "B", epic: eid });
    await advanceStory(atmuxDir, a, "ready");
    const ready = await listStories(atmuxDir, { epic: eid, status: "ready" });
    expect(ready.map((s) => s.id)).toEqual([a]);
  });

  test("empty list when no stories", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    expect(await listStories(atmuxDir, { epic: eid })).toEqual([]);
  });
});

describe("showStory", () => {
  test("joins task children", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const tid = await addTask(atmuxDir, { subject: "child task" });
    linkTaskToStory(tid, sid);
    const s = await showStory(atmuxDir, sid);
    expect(s?.tasks.map((t) => t.id)).toEqual([tid]);
  });

  test("missing → null", async () => {
    expect(await showStory(atmuxDir, "s-deadbeef")).toBe(null);
  });
});

// ---------- IO: advanceStory state machine + gates ----------

describe("advanceStory", () => {
  test("planning → ready default step", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const r = await advanceStory(atmuxDir, sid);
    expect(r.from).toBe("planning");
    expect(r.to).toBe("ready");
  });

  test("ready → in-progress auto-flips parent epic ready → in-progress", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    await advanceEpic(atmuxDir, eid, "ready"); // epic ready
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    const r = await advanceStory(atmuxDir, sid, "in-progress");
    expect(r.parentEpicFlipped).toBe(true);
    const epicRow = (await listEpics(atmuxDir)).find((e) => e.id === eid);
    expect(epicRow?.status).toBe("in-progress");
  });

  test("ready → in-progress does NOT re-flip when epic is past ready", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    await advanceEpic(atmuxDir, eid, "ready");
    await advanceEpic(atmuxDir, eid, "in-progress");
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    const r = await advanceStory(atmuxDir, sid, "in-progress");
    expect(r.parentEpicFlipped).toBe(false);
  });

  test("in-progress → testing blocked by non-test-lane tasks", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    const tid = await addTask(atmuxDir, { subject: "be work", lane: "be" });
    linkTaskToStory(tid, sid, "be");
    await expect(advanceStory(atmuxDir, sid, "testing")).rejects.toThrow(
      /non-test-lane tasks still open/,
    );
    // Close it → can advance.
    await moveTask(atmuxDir, tid, "done");
    const r = await advanceStory(atmuxDir, sid, "testing");
    expect(r.to).toBe("testing");
  });

  test("testing → review blocked by open test-lane tasks", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    const tid = await addTask(atmuxDir, { subject: "e2e", lane: "test" });
    linkTaskToStory(tid, sid, "test");
    await expect(advanceStory(atmuxDir, sid, "review")).rejects.toThrow(
      /test-lane tasks still open/,
    );
    await moveTask(atmuxDir, tid, "done");
    const r = await advanceStory(atmuxDir, sid, "review");
    expect(r.to).toBe("review");
    expect(r.dispatchedTaskId).not.toBe(null);
  });

  test("review entry auto-dispatches review task to reviewer", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    const r = await advanceStory(atmuxDir, sid, "review");
    expect(r.dispatchedTaskId).not.toBe(null);
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    const repo = new KanbanRepo(db);
    const t = repo.getTask(r.dispatchedTaskId as string);
    closeDatabase(db);
    expect(t?.owner).toBe("reviewer");
    expect(t?.lane).toBe("review");
    expect(t?.subject).toBe(`review ${sid}`);
  });

  test("review → merging blocked without reviewSignoff", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await expect(advanceStory(atmuxDir, sid, "merging")).rejects.toThrow(/reviewer signoff/);
  });

  test("review → merging dispatches merge task to gitter after signoff", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    // Stamp signoff via direct repo update (reviewer-side action).
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const s = repo.getStory(sid);
      if (s !== null) repo.upsertStory({ ...s, reviewSignoff: true });
      closeDatabase(db);
    }
    const r = await advanceStory(atmuxDir, sid, "merging");
    expect(r.to).toBe("merging");
    expect(r.dispatchedTaskId).not.toBe(null);
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    const repo = new KanbanRepo(db);
    const t = repo.getTask(r.dispatchedTaskId as string);
    const s = repo.getStory(sid);
    closeDatabase(db);
    expect(t?.owner).toBe("gitter");
    expect(t?.subject).toBe(`merge ${sid}`);
    // Story.mergeTaskId stamped.
    expect(s?.mergeTaskId).toBe(r.dispatchedTaskId);
  });

  test("merging → done blocked until merge task done", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const s = repo.getStory(sid);
      if (s !== null) repo.upsertStory({ ...s, reviewSignoff: true });
      closeDatabase(db);
    }
    const m = await advanceStory(atmuxDir, sid, "merging");
    await expect(advanceStory(atmuxDir, sid, "done")).rejects.toThrow(/gitter has not completed/);
    // Close the merge task → done unblocks.
    await moveTask(atmuxDir, m.dispatchedTaskId as string, "done");
    const r = await advanceStory(atmuxDir, sid, "done");
    expect(r.to).toBe("done");
  });

  test("idempotent same-state no-op", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const r = await advanceStory(atmuxDir, sid, "planning");
    expect(r.noop).toBe(true);
  });

  test("illegal jump rejected", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await expect(advanceStory(atmuxDir, sid, "done")).rejects.toThrow(UsageError);
  });

  test("missing story → ConfigError", async () => {
    await expect(advanceStory(atmuxDir, "s-deadbeef")).rejects.toThrow(ConfigError);
  });
});

// ---------- Verb integration ----------

describe("story verb — dispatch", () => {
  test("missing subverb → UsageError", async () => {
    await expect(story(["--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("story add prints id", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const { out } = await captureStdout(() =>
      story(["add", "--epic", eid, "--team-dir", teamDir, "Some", "title"]),
    );
    expect(out).toMatch(/^s-[1-9][0-9]*-[0-9a-f]{8}$/m);
  });

  test("story list (none) prints '(no stories for <eid>)'", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const { out } = await captureStdout(() =>
      story(["list", "--epic", eid, "--team-dir", teamDir]),
    );
    expect(out).toContain(`(no stories for ${eid})`);
  });

  test("story list --json", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    await addStory(atmuxDir, { title: "S", epic: eid });
    const { out } = await captureStdout(() =>
      story(["list", "--epic", eid, "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].title).toBe("S");
  });

  test("story show --json returns story + tasks", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const { out } = await captureStdout(() =>
      story(["show", sid, "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(sid);
    expect(parsed.tasks).toEqual([]);
  });

  test("story show missing id → ConfigError", async () => {
    await expect(story(["show", "s-bogus", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });

  test("story advance --to specific state", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await captureStdout(() => story(["advance", sid, "--to", "ready", "--team-dir", teamDir]));
    const s = (await listStories(atmuxDir, { epic: eid })).find((x) => x.id === sid);
    expect(s?.status).toBe("ready");
  });

  test("story alias ls works", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const { out } = await captureStdout(() => story(["ls", "--epic", eid, "--team-dir", teamDir]));
    expect(out).toContain("(no stories for");
  });
});

// ---------- ADR-175 GAP 1: signoff / unsignoff ----------

async function advanceToReview(eid: string, sid: string): Promise<void> {
  await advanceStory(atmuxDir, sid, "ready");
  await advanceStory(atmuxDir, sid, "in-progress");
  await advanceStory(atmuxDir, sid, "testing");
  await advanceStory(atmuxDir, sid, "review");
  // Silence unused warn — eid kept for caller readability.
  void eid;
}

function getStoryRow(sid: string) {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  const repo = new KanbanRepo(db);
  const s = repo.getStory(sid);
  closeDatabase(db);
  return s;
}

describe("parseSignoffFlags", () => {
  test("empty argv → all undefined", () => {
    const f = parseSignoffFlags([]);
    expect(f.as).toBeUndefined();
    expect(f.note).toBeUndefined();
  });

  test("--as + --note + --team-dir captured", () => {
    const f = parseSignoffFlags([
      "--as",
      "reviewer",
      "--note",
      "approved",
      "--team-dir",
      "/x",
    ]);
    expect(f.as).toBe("reviewer");
    expect(f.note).toBe("approved");
    expect(f.teamDir).toBe("/x");
  });

  test("dangling --as → UsageError", () => {
    expect(() => parseSignoffFlags(["--as"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseSignoffFlags(["--bogus"])).toThrow(UsageError);
  });
});

describe("storySignoff", () => {
  test("flips reviewSignoff=true + appends audit entry", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    const r = await storySignoff(atmuxDir, sid, {
      as: "reviewer",
      note: "n AC clauses covered",
    });
    expect(r.signedOffBy).toBe("reviewer");
    expect(r.signedOffAt).toBeGreaterThan(0);
    const row = getStoryRow(sid);
    expect(row?.reviewSignoff).toBe(true);
    const audit = row?.signoffAudit as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(audit)).toBe(true);
    expect(audit?.length).toBe(1);
    expect(audit?.[0]?.signedOffBy).toBe("reviewer");
    expect(audit?.[0]?.note).toBe("n AC clauses covered");
    expect(typeof audit?.[0]?.signedOffAt).toBe("number");
  });

  test("status != review → UsageError", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    // Still in planning.
    await expect(storySignoff(atmuxDir, sid, { as: "reviewer" })).rejects.toThrow(
      /'planning' state/,
    );
  });

  test("non-reviewer caller without --as → UsageError", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await expect(
      storySignoff(atmuxDir, sid, { callerMember: "alpha" }),
    ).rejects.toThrow(/role=member cannot sign off/);
  });

  test("reviewer caller WITHOUT --as → accepted (caller-role gate satisfied)", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    const r = await storySignoff(atmuxDir, sid, { callerMember: "reviewer" });
    expect(r.signedOffBy).toBe("reviewer");
    expect(getStoryRow(sid)?.reviewSignoff).toBe(true);
  });

  test("--as <member> operator override accepts non-reviewer caller", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    const r = await storySignoff(atmuxDir, sid, {
      as: "reviewer",
      callerMember: "alpha",
    });
    expect(r.signedOffBy).toBe("reviewer");
    expect(getStoryRow(sid)?.reviewSignoff).toBe(true);
  });

  test("--as <bogus> → ConfigError (member must exist)", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await expect(
      storySignoff(atmuxDir, sid, { as: "ghost" }),
    ).rejects.toThrow(/no such member/);
  });

  test("no --as and no $ATMUX_MEMBER → UsageError", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await expect(storySignoff(atmuxDir, sid, {})).rejects.toThrow(/--as/);
  });

  test("missing story → ConfigError", async () => {
    await expect(
      storySignoff(atmuxDir, "s-deadbeef", { as: "reviewer" }),
    ).rejects.toThrow(ConfigError);
  });

  test("callerMember not in team.json → ConfigError", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await expect(
      storySignoff(atmuxDir, sid, { callerMember: "ghost-pane" }),
    ).rejects.toThrow(/ghost-pane.*not found in team\.json/);
  });

  test("no state.db → ConfigError", async () => {
    const freshDir = join(teamDir, "fresh-no-db");
    await mkdir(freshDir, { recursive: true });
    await expect(
      storySignoff(freshDir, "s-anything", { as: "reviewer" }),
    ).rejects.toThrow(ConfigError);
  });

  test("idempotent re-call appends a second audit entry", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await storySignoff(atmuxDir, sid, { as: "reviewer", note: "first" });
    await storySignoff(atmuxDir, sid, { as: "reviewer", note: "second" });
    const audit = getStoryRow(sid)?.signoffAudit as Array<Record<string, unknown>>;
    expect(audit.length).toBe(2);
    expect(audit[0]?.note).toBe("first");
    expect(audit[1]?.note).toBe("second");
  });
});

describe("storyUnsignoff", () => {
  test("flips reviewSignoff=false + appends counter-entry", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await storySignoff(atmuxDir, sid, { as: "reviewer", note: "approve" });
    const r = await storyUnsignoff(atmuxDir, sid, {
      as: "reviewer",
      note: "changed my mind",
    });
    expect(r.unsignedBy).toBe("reviewer");
    const row = getStoryRow(sid);
    expect(row?.reviewSignoff).toBe(false);
    const audit = row?.signoffAudit as Array<Record<string, unknown>>;
    expect(audit.length).toBe(2);
    expect(audit[0]?.signedOffBy).toBe("reviewer");
    expect(audit[1]?.unsignedBy).toBe("reviewer");
    expect(audit[1]?.note).toBe("changed my mind");
  });

  test("refuses when mergeTaskId already set (signoff consumed)", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    // Plant a mergeTaskId by writing directly — we don't want to advance
    // past review here (that flips status to merging which would itself
    // refuse on status gate; this isolates the mergeTaskId gate).
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const s = repo.getStory(sid);
      if (s !== null)
        repo.upsertStory({ ...s, reviewSignoff: true, mergeTaskId: "t-faketask" });
      closeDatabase(db);
    }
    await expect(
      storyUnsignoff(atmuxDir, sid, { as: "reviewer" }),
    ).rejects.toThrow(/mergeTaskId/);
  });

  test("status != review → UsageError", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await expect(
      storyUnsignoff(atmuxDir, sid, { as: "reviewer" }),
    ).rejects.toThrow(/'planning' state/);
  });

  test("non-reviewer caller without --as → UsageError", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceToReview(eid, sid);
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    await expect(
      storyUnsignoff(atmuxDir, sid, { callerMember: "alpha" }),
    ).rejects.toThrow(/cannot sign off/);
  });

  test("missing story → ConfigError", async () => {
    await expect(
      storyUnsignoff(atmuxDir, "s-deadbeef", { as: "reviewer" }),
    ).rejects.toThrow(ConfigError);
  });
});

// ---------- Integration: full state-machine via signoff verb ----------

describe("ADR-175 signoff integration — full feature-branch state machine", () => {
  test("planning → ready → in-progress → testing → review → SIGNOFF → merging → done", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    // Drive forward through the full machine.
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    // Signoff via canonical verb path (not raw repo upsert like the
    // pre-ADR-175 test at L322-329).
    await storySignoff(atmuxDir, sid, {
      as: "reviewer",
      note: "approve — full state-machine integration",
    });
    const afterSignoff = getStoryRow(sid);
    expect(afterSignoff?.reviewSignoff).toBe(true);
    const audit = afterSignoff?.signoffAudit as Array<Record<string, unknown>>;
    expect(audit[0]?.signedOffBy).toBe("reviewer");
    // review → merging now legal (signoff bit set).
    const m = await advanceStory(atmuxDir, sid, "merging");
    expect(m.dispatchedTaskId).not.toBe(null);
    expect(getStoryRow(sid)?.mergeTaskId).toBe(m.dispatchedTaskId);
    // Close synthetic gitter Task → story → done.
    await moveTask(atmuxDir, m.dispatchedTaskId as string, "done");
    const d = await advanceStory(atmuxDir, sid, "done");
    expect(d.to).toBe("done");
    // Audit trail survives state advance (extra-JSON intact).
    const finalAudit = getStoryRow(sid)?.signoffAudit as Array<Record<string, unknown>>;
    expect(finalAudit.length).toBe(1);
    expect(finalAudit[0]?.signedOffBy).toBe("reviewer");
  });
});

// ---------- Verb-layer signoff dispatch ----------

describe("story verb — signoff / unsignoff dispatch", () => {
  test("story signoff missing id → UsageError", async () => {
    await expect(story(["signoff", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("story signoff applies via verb path", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    const rc = await story([
      "signoff",
      sid,
      "--as",
      "reviewer",
      "--note",
      "via verb",
      "--team-dir",
      teamDir,
    ]);
    expect(rc).toBe(0);
    expect(getStoryRow(sid)?.reviewSignoff).toBe(true);
  });

  test("story unsignoff applies via verb path", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    const rc = await story([
      "unsignoff",
      sid,
      "--as",
      "reviewer",
      "--note",
      "reverse",
      "--team-dir",
      teamDir,
    ]);
    expect(rc).toBe(0);
    expect(getStoryRow(sid)?.reviewSignoff).toBe(false);
  });

  test("unknown verb hint mentions signoff/unsignoff", async () => {
    await expect(story(["bogus", "--team-dir", teamDir])).rejects.toThrow(
      /signoff/,
    );
  });

  test("verb-layer threads $ATMUX_MEMBER to callerMember", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    const prior = process.env.ATMUX_MEMBER;
    process.env.ATMUX_MEMBER = "reviewer";
    try {
      const rc = await story(["signoff", sid, "--team-dir", teamDir]);
      expect(rc).toBe(0);
      expect(getStoryRow(sid)?.reviewSignoff).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.ATMUX_MEMBER;
      else process.env.ATMUX_MEMBER = prior;
    }
  });

  test("verb-layer non-reviewer $ATMUX_MEMBER refuses", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    const prior = process.env.ATMUX_MEMBER;
    process.env.ATMUX_MEMBER = "alpha";
    try {
      await expect(
        story(["signoff", sid, "--team-dir", teamDir]),
      ).rejects.toThrow(/cannot sign off/);
    } finally {
      if (prior === undefined) delete process.env.ATMUX_MEMBER;
      else process.env.ATMUX_MEMBER = prior;
    }
  });
});

// ---------- ADR-175 GAP 2: mergeMode field + trunk-direct branching ----------

describe("parseAddArgs — --merge-mode", () => {
  test("default omitted → mergeMode undefined", () => {
    const a = parseAddArgs(["t", "--epic", "e-1"]);
    expect(a.mergeMode).toBeUndefined();
  });

  test("--merge-mode trunk-direct captured", () => {
    const a = parseAddArgs(["t", "--epic", "e-1", "--merge-mode", "trunk-direct"]);
    expect(a.mergeMode).toBe("trunk-direct");
  });

  test("--merge-mode feature-branch captured", () => {
    const a = parseAddArgs(["t", "--epic", "e-1", "--merge-mode", "feature-branch"]);
    expect(a.mergeMode).toBe("feature-branch");
  });

  test("--merge-mode bogus → UsageError naming the field", () => {
    expect(() =>
      parseAddArgs(["t", "--epic", "e-1", "--merge-mode", "bogus"]),
    ).toThrow(/--merge-mode must be/);
  });

  test("dangling --merge-mode → UsageError", () => {
    expect(() => parseAddArgs(["t", "--epic", "e-1", "--merge-mode"])).toThrow(
      UsageError,
    );
  });
});

describe("addStory — mergeMode field", () => {
  test("omitted defaults to 'feature-branch'", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    const s = (await listStories(atmuxDir, { epic: eid })).find((x) => x.id === sid);
    expect(s?.mergeMode).toBe("feature-branch");
  });

  test("explicit trunk-direct persists", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, {
      title: "S",
      epic: eid,
      mergeMode: "trunk-direct",
    });
    const s = (await listStories(atmuxDir, { epic: eid })).find((x) => x.id === sid);
    expect(s?.mergeMode).toBe("trunk-direct");
  });

  test("explicit feature-branch persists", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, {
      title: "S",
      epic: eid,
      mergeMode: "feature-branch",
    });
    const s = (await listStories(atmuxDir, { epic: eid })).find((x) => x.id === sid);
    expect(s?.mergeMode).toBe("feature-branch");
  });
});

describe("advanceStory — trunk-direct branching", () => {
  async function buildTrunkDirectAtReview(): Promise<{ eid: string; sid: string }> {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, {
      title: "S",
      epic: eid,
      mergeMode: "trunk-direct",
    });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    return { eid, sid };
  }

  test("review → done legal after signoff (no merge-task synthesized)", async () => {
    const { sid } = await buildTrunkDirectAtReview();
    await storySignoff(atmuxDir, sid, { as: "reviewer", note: "trunk-direct ack" });
    const r = await advanceStory(atmuxDir, sid, "done");
    expect(r.to).toBe("done");
    const row = getStoryRow(sid);
    expect(row?.status).toBe("done");
    expect(row?.mergeTaskId ?? null).toBeNull();
    expect(row?.completedAt).toBeGreaterThan(0);
  });

  test("review → done refused without signoff", async () => {
    const { sid } = await buildTrunkDirectAtReview();
    await expect(advanceStory(atmuxDir, sid, "done")).rejects.toThrow(
      /reviewer signoff missing/,
    );
  });

  test("review → merging refused (no merging phase for trunk-direct)", async () => {
    const { sid } = await buildTrunkDirectAtReview();
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    await expect(advanceStory(atmuxDir, sid, "merging")).rejects.toThrow(
      /trunk-direct/,
    );
  });

  test("default next-step from review jumps to done for trunk-direct", async () => {
    const { sid } = await buildTrunkDirectAtReview();
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    // No --to: trunk-direct should jump straight to done, not merging.
    const r = await advanceStory(atmuxDir, sid);
    expect(r.from).toBe("review");
    expect(r.to).toBe("done");
  });

  test("feature-branch regression — review → merging path unchanged", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    // No --mergeMode → defaults to feature-branch.
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    const m = await advanceStory(atmuxDir, sid, "merging");
    expect(m.to).toBe("merging");
    expect(m.dispatchedTaskId).not.toBe(null);
    expect(getStoryRow(sid)?.mergeTaskId).toBe(m.dispatchedTaskId);
  });

  test("feature-branch regression — review → done without merging refused", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, { title: "S", epic: eid });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    // feature-branch must NOT take the trunk-direct review→done shortcut.
    await expect(advanceStory(atmuxDir, sid, "done")).rejects.toThrow(/illegal transition/);
  });
});

// ---------- Integration: trunk-direct full state-machine via signoff verb ----------

describe("ADR-175 GAP 2 integration — trunk-direct full state machine", () => {
  test("planning → ready → in-progress → testing → review → SIGNOFF → done (skips merging)", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const sid = await addStory(atmuxDir, {
      title: "rentx E1 shape (trunk-direct)",
      epic: eid,
      mergeMode: "trunk-direct",
    });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await storySignoff(atmuxDir, sid, {
      as: "reviewer",
      note: "trunk-direct integration capstone",
    });
    const d = await advanceStory(atmuxDir, sid, "done");
    expect(d.to).toBe("done");
    expect(d.dispatchedTaskId).toBeNull();
    const final = getStoryRow(sid);
    expect(final?.status).toBe("done");
    expect(final?.mergeMode).toBe("trunk-direct");
    expect(final?.mergeTaskId ?? null).toBeNull();
    expect(final?.reviewSignoff).toBe(true);
    const audit = final?.signoffAudit as Array<Record<string, unknown>>;
    expect(audit.length).toBe(1);
    expect(audit[0]?.signedOffBy).toBe("reviewer");
  });
});

// ---------- Verb-layer --merge-mode dispatch ----------

describe("story verb — --merge-mode dispatch", () => {
  test("story add --merge-mode trunk-direct persists mode", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    const { out } = await captureStdout(() =>
      story([
        "add",
        "--epic",
        eid,
        "--merge-mode",
        "trunk-direct",
        "--team-dir",
        teamDir,
        "Some",
        "title",
      ]),
    );
    const sid = out.trim();
    expect(sid).toMatch(/^s-[1-9][0-9]*-[0-9a-f]{8}$/);
    const s = (await listStories(atmuxDir, { epic: eid })).find((x) => x.id === sid);
    expect(s?.mergeMode).toBe("trunk-direct");
  });

  test("story add --merge-mode bogus → UsageError via verb path", async () => {
    const eid = await addEpic(atmuxDir, { title: "E" });
    await expect(
      story([
        "add",
        "--epic",
        eid,
        "--merge-mode",
        "no-merge",
        "--team-dir",
        teamDir,
        "T",
      ]),
    ).rejects.toThrow(/--merge-mode must be/);
  });
});

// ---------- T3 capstone: ADR-175 rentx E1 4-story shape repro ----------
//
// Closes the rentx-driver SQL-bypass class per ADR-175 §Consequences.
// 4 stories historically used raw `UPDATE stories SET status='done'`
// (operator-authorized 2026-05-17 13:55 MYT) because no CLI surface
// existed for: (a) flipping reviewSignoff, (b) skipping merging for
// trunk-direct shapes. T1 (signoff verbs) + T2 (mergeMode field +
// trunk-direct advance branching) close both gaps; this capstone walks
// each historical story shape through the canonical CLI path and
// asserts the bypass is no longer needed.

interface RentxE1Shape {
  /** Original story-id from rentx E1 — used as a grep anchor so the
   *  4-id list in the commit body matches the test names. */
  rentxStoryId: string;
  /** Short label matching the platform/infra shape observed on rentx. */
  shapeLabel: string;
}

const RENTX_E1_SHAPES: ReadonlyArray<RentxE1Shape> = [
  { rentxStoryId: "s-425249d0", shapeLabel: "rentx submodule attach" },
  { rentxStoryId: "s-dc19b96e", shapeLabel: "rentx nginx symlink" },
  { rentxStoryId: "s-f5797a08", shapeLabel: "rentx systemd unit" },
  { rentxStoryId: "s-cb99f131", shapeLabel: "rentx deploy worktree provision" },
];

describe("ADR-175 rentx E1 capstone — 4 trunk-direct story shapes", () => {
  for (const shape of RENTX_E1_SHAPES) {
    test(`shape repro (${shape.rentxStoryId} — ${shape.shapeLabel}): planning → review → SIGNOFF → done (no merging)`, async () => {
      const eid = await addEpic(atmuxDir, { title: "rentx E1" });
      // Synthetic local story modeling the rentx-side shape — we cannot
      // use the literal rentxStoryId because addStory mints a fresh ID,
      // but the rentxStoryId is the audit-trail anchor in the test name.
      const sid = await addStory(atmuxDir, {
        title: shape.shapeLabel,
        epic: eid,
        mergeMode: "trunk-direct",
        acceptanceCriteria: `repro of ${shape.rentxStoryId} historical SQL-bypass shape`,
      });
      // Drive through machine — same advance path as feature-branch up
      // through review; only review → done differs.
      await advanceStory(atmuxDir, sid, "ready");
      await advanceStory(atmuxDir, sid, "in-progress");
      await advanceStory(atmuxDir, sid, "testing");
      await advanceStory(atmuxDir, sid, "review");
      // Canonical signoff verb — replaces the SQL UPDATE bypass.
      await storySignoff(atmuxDir, sid, {
        as: "reviewer",
        note: `rentx E1 capstone shape repro (${shape.rentxStoryId})`,
      });
      // review → done — trunk-direct skips merging entirely.
      const d = await advanceStory(atmuxDir, sid, "done");
      expect(d.from).toBe("review");
      expect(d.to).toBe("done");
      expect(d.dispatchedTaskId).toBe(null);
      // Final state assertions — every gate per task body:
      const row = getStoryRow(sid);
      expect(row?.status).toBe("done");
      expect(row?.mergeTaskId ?? null).toBe(null);
      expect(row?.reviewSignoff).toBe(true);
      expect(row?.completedAt).toBeGreaterThan(0);
      const audit = row?.signoffAudit as Array<Record<string, unknown>>;
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit[0]?.signedOffBy).toBe("reviewer");
      expect(audit[0]?.note).toMatch(new RegExp(shape.rentxStoryId));
      // No synthetic merge-Task lingering — listTasks(story) returns
      // empty (no test-lane task was filed for this synthetic shape).
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const childTasks = repo.listTasks({ story: sid });
      const reviewTasks = childTasks.filter((t) => t.lane === "review");
      const mergeTasks = childTasks.filter(
        (t) => (t.subject ?? "").startsWith("merge "),
      );
      closeDatabase(db);
      // review entry dispatches a `review <sid>` reviewer-lane Task per
      // src/core/story.ts — that's expected. NO merge-Task should ever
      // get synthesized.
      expect(reviewTasks.length).toBe(1);
      expect(mergeTasks.length).toBe(0);
    });
  }

  test("feature-branch negative control — synthetic merge-Task IS created (T2 did not regress)", async () => {
    const eid = await addEpic(atmuxDir, { title: "feature-branch control" });
    // Default mergeMode — omitted, schema default 'feature-branch' applies.
    const sid = await addStory(atmuxDir, {
      title: "feature-branch shape",
      epic: eid,
    });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await storySignoff(atmuxDir, sid, { as: "reviewer", note: "feature-branch control" });
    // review → merging: synthetic merge-Task dispatched to gitter.
    const m = await advanceStory(atmuxDir, sid, "merging");
    expect(m.to).toBe("merging");
    expect(m.dispatchedTaskId).not.toBe(null);
    const tid = m.dispatchedTaskId as string;
    const mergedRow = getStoryRow(sid);
    expect(mergedRow?.mergeTaskId).toBe(tid);
    // merging → done blocked until merge-Task done.
    await expect(advanceStory(atmuxDir, sid, "done")).rejects.toThrow(
      /gitter has not completed/,
    );
    await moveTask(atmuxDir, tid, "done");
    const d = await advanceStory(atmuxDir, sid, "done");
    expect(d.to).toBe("done");
    expect(getStoryRow(sid)?.mergeTaskId).toBe(tid);
  });

  test("trunk-direct review → done refuses without signoff", async () => {
    const eid = await addEpic(atmuxDir, { title: "negative gate" });
    const sid = await addStory(atmuxDir, {
      title: "trunk-direct no-signoff",
      epic: eid,
      mergeMode: "trunk-direct",
    });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    // No signoff — review → done MUST refuse with the documented message.
    await expect(advanceStory(atmuxDir, sid, "done")).rejects.toThrow(
      /reviewer signoff missing/,
    );
    // State unchanged — still in review.
    expect(getStoryRow(sid)?.status).toBe("review");
    expect(getStoryRow(sid)?.reviewSignoff).not.toBe(true);
  });

  test("trunk-direct review → merging is an explicit foot-gun (T2 documented refusal)", async () => {
    const eid = await addEpic(atmuxDir, { title: "trunk-direct merging foot-gun" });
    const sid = await addStory(atmuxDir, {
      title: "trunk-direct -> merging",
      epic: eid,
      mergeMode: "trunk-direct",
    });
    await advanceStory(atmuxDir, sid, "ready");
    await advanceStory(atmuxDir, sid, "in-progress");
    await advanceStory(atmuxDir, sid, "testing");
    await advanceStory(atmuxDir, sid, "review");
    await storySignoff(atmuxDir, sid, { as: "reviewer" });
    await expect(advanceStory(atmuxDir, sid, "merging")).rejects.toThrow(
      /trunk-direct.*has no merging phase/,
    );
  });
});
