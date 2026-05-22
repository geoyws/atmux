// Unit tests for src/verbs/epic.ts + src/core/epic.ts (ADR-007 + ADR-010).
// Bash spec: lib/epic.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  addEpic,
  advanceEpic,
  epicLegalTransition,
  epicNextState,
  listEpics,
  showEpic,
} from "../../../src/core/epic.ts";
import { addTask, moveTask } from "../../../src/core/kanban.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import { addStory } from "../../../src/core/story.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { epic, parseAddArgs, parseListArgs } from "../../../src/verbs/epic.ts";

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
  // Bootstrap state.db so SQL-canonical verbs find it.
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-epic-verb-"));
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

// ---------- Pure: parseAddArgs ----------

describe("epic parseAddArgs", () => {
  test("title from single positional", () => {
    expect(parseAddArgs(["my-epic"]).title).toBe("my-epic");
  });

  test("title from multiple positionals joined by space", () => {
    expect(parseAddArgs(["one", "two", "three"]).title).toBe("one two three");
  });

  test("--body / --driver-ref captured", () => {
    const a = parseAddArgs(["t", "--body", "B", "--driver-ref", "R"]);
    expect(a.title).toBe("t");
    expect(a.body).toBe("B");
    expect(a.driverRef).toBe("R");
  });

  test("`--` collects remaining as title", () => {
    const a = parseAddArgs(["--", "title", "with", "dashes"]);
    expect(a.title).toBe("title with dashes");
  });

  test("empty argv → UsageError", () => {
    expect(() => parseAddArgs([])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseAddArgs(["t", "--bogus"])).toThrow(UsageError);
  });

  test("missing value for --body → UsageError", () => {
    expect(() => parseAddArgs(["t", "--body"])).toThrow(UsageError);
  });
});

// ---------- Pure: parseListArgs ----------

describe("epic parseListArgs", () => {
  test("empty → defaults", () => {
    expect(parseListArgs([])).toEqual({ json: false });
  });

  test("--status + --json", () => {
    const a = parseListArgs(["--status", "ready", "--json"]);
    expect(a.status).toBe("ready");
    expect(a.json).toBe(true);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseListArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- Pure: state machine ----------

describe("epicNextState + epicLegalTransition", () => {
  test("forward chain", () => {
    expect(epicNextState("planning")).toBe("ready");
    expect(epicNextState("ready")).toBe("in-progress");
    expect(epicNextState("in-progress")).toBe("review");
    expect(epicNextState("review")).toBe("done");
  });

  test("terminal", () => {
    expect(epicNextState("done")).toBe(null);
  });

  test("unknown returns null", () => {
    expect(epicNextState("bogus")).toBe(null);
  });

  test("same-state is idempotent legal", () => {
    expect(epicLegalTransition("ready", "ready")).toBe(true);
  });

  test("forward one step legal", () => {
    expect(epicLegalTransition("planning", "ready")).toBe(true);
  });

  test("forward two steps illegal", () => {
    expect(epicLegalTransition("planning", "in-progress")).toBe(false);
  });

  test("backwards illegal", () => {
    expect(epicLegalTransition("ready", "planning")).toBe(false);
  });
});

// ---------- IO: addEpic + listEpics + showEpic ----------

describe("addEpic", () => {
  test("creates an epic with default status 'planning'", async () => {
    const id = await addEpic(atmuxDir, { title: "Onboard new hires" });
    expect(id).toMatch(/^e-[1-9][0-9]*-[0-9a-f]{8}$/);
    const epics = await listEpics(atmuxDir);
    expect(epics).toHaveLength(1);
    expect(epics[0]?.id).toBe(id);
    expect(epics[0]?.title).toBe("Onboard new hires");
    expect(epics[0]?.status).toBe("planning");
  });

  test("body + driverRef stored when provided", async () => {
    const id = await addEpic(atmuxDir, {
      title: "Q4 roadmap",
      body: "Themes: X, Y, Z",
      driverRef: "PRD-007",
    });
    const e = (await listEpics(atmuxDir)).find((x) => x.id === id);
    expect(e?.body).toBe("Themes: X, Y, Z");
    expect(e?.driverRef).toBe("PRD-007");
  });

  test("empty title rejected (UsageError)", async () => {
    await expect(addEpic(atmuxDir, { title: "  " })).rejects.toThrow(UsageError);
  });
});

describe("listEpics", () => {
  test("filter by status", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await addEpic(atmuxDir, { title: "B" });
    // Move first to ready
    await advanceEpic(atmuxDir, a, "ready");
    const ready = await listEpics(atmuxDir, { status: "ready" });
    expect(ready.map((e) => e.id)).toEqual([a]);
    const planning = await listEpics(atmuxDir, { status: "planning" });
    expect(planning).toHaveLength(1);
  });

  test("empty atmuxDir → empty list (no throw)", async () => {
    // The seeded state.db is present but no epics exist yet.
    expect(await listEpics(atmuxDir)).toEqual([]);
  });
});

describe("showEpic", () => {
  test("joins stories + direct tasks", async () => {
    const eid = await addEpic(atmuxDir, { title: "Big work" });
    const sid = await addStory(atmuxDir, { title: "First slice", epic: eid });
    // Direct task on the epic (no story).
    const directTid = await addTask(atmuxDir, {
      subject: "Direct task",
      // The CLI accepts via --assignee; the core takes assignee.
    });
    // Hard-write the epic/story link on the direct task since addTask
    // doesn't take epic. We bypass with a direct repo upsert.
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const t = repo.getTask(directTid);
      if (t !== null) repo.upsertTask({ ...t, epic: eid });
      closeDatabase(db);
    }
    const e = await showEpic(atmuxDir, eid);
    expect(e).not.toBe(null);
    expect(e?.storyRows.map((s) => s.id)).toEqual([sid]);
    expect(e?.tasks.map((t) => t.id)).toContain(directTid);
  });

  test("missing epic → null", async () => {
    expect(await showEpic(atmuxDir, "e-deadbeef")).toBe(null);
  });
});

// ---------- IO: advanceEpic state machine ----------

describe("advanceEpic", () => {
  test("default step planning → ready (no children)", async () => {
    const id = await addEpic(atmuxDir, { title: "A" });
    const r = await advanceEpic(atmuxDir, id);
    expect(r.from).toBe("planning");
    expect(r.to).toBe("ready");
    expect(r.noop).toBe(false);
    expect(r.summaryTaskId).toBe(null);
  });

  test("idempotent no-op when --to == current", async () => {
    const id = await addEpic(atmuxDir, { title: "A" });
    const r = await advanceEpic(atmuxDir, id, "planning");
    expect(r.noop).toBe(true);
  });

  test("illegal jump rejected", async () => {
    const id = await addEpic(atmuxDir, { title: "A" });
    await expect(advanceEpic(atmuxDir, id, "done")).rejects.toThrow(UsageError);
  });

  test("backwards transition rejected", async () => {
    const id = await addEpic(atmuxDir, { title: "A" });
    await advanceEpic(atmuxDir, id, "ready");
    await expect(advanceEpic(atmuxDir, id, "planning")).rejects.toThrow(UsageError);
  });

  test("review entry blocked by non-done stories", async () => {
    const eid = await addEpic(atmuxDir, { title: "A" });
    await advanceEpic(atmuxDir, eid, "ready");
    await advanceEpic(atmuxDir, eid, "in-progress");
    await addStory(atmuxDir, { title: "child", epic: eid });
    await expect(advanceEpic(atmuxDir, eid, "review")).rejects.toThrow(/blocking children/);
  });

  test("review entry auto-dispatches summary task to team-lead", async () => {
    const eid = await addEpic(atmuxDir, { title: "A" });
    await advanceEpic(atmuxDir, eid, "ready");
    await advanceEpic(atmuxDir, eid, "in-progress");
    const r = await advanceEpic(atmuxDir, eid, "review");
    expect(r.to).toBe("review");
    expect(r.summaryTaskId).not.toBe(null);
    // Verify the task lands with owner=lead.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    const repo = new KanbanRepo(db);
    const t = repo.getTask(r.summaryTaskId as string);
    closeDatabase(db);
    expect(t?.owner).toBe("lead");
    expect(t?.subject).toBe(`draft Epic summary ${eid}`);
    expect(t?.status).toBe("in-progress");
  });

  test("done entry sets completedAt", async () => {
    const eid = await addEpic(atmuxDir, { title: "A" });
    await advanceEpic(atmuxDir, eid, "ready");
    await advanceEpic(atmuxDir, eid, "in-progress");
    await advanceEpic(atmuxDir, eid, "review");
    await advanceEpic(atmuxDir, eid, "done");
    const e = (await listEpics(atmuxDir)).find((x) => x.id === eid);
    expect(e?.completedAt).toBeGreaterThan(0);
  });

  test("missing epic → ConfigError", async () => {
    await expect(advanceEpic(atmuxDir, "e-deadbeef")).rejects.toThrow(ConfigError);
  });
});

// ---------- Verb integration ----------

describe("epic verb — dispatch", () => {
  test("missing subverb → UsageError", async () => {
    await expect(epic(["--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("unknown subverb → UsageError", async () => {
    await expect(epic(["bogus", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("epic add prints id to stdout", async () => {
    const { out } = await captureStdout(() =>
      epic(["add", "--team-dir", teamDir, "First", "epic"]),
    );
    expect(out).toMatch(/^e-[1-9][0-9]*-[0-9a-f]{8}$/m);
  });

  test("epic list (no epics) prints '(no epics)'", async () => {
    const { out } = await captureStdout(() => epic(["list", "--team-dir", teamDir]));
    expect(out).toContain("(no epics)");
  });

  test("epic list --json returns JSON array", async () => {
    await addEpic(atmuxDir, { title: "A" });
    const { out } = await captureStdout(() => epic(["list", "--json", "--team-dir", teamDir]));
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].title).toBe("A");
  });

  test("epic show <id> --json returns joined shape", async () => {
    const eid = await addEpic(atmuxDir, { title: "T" });
    await addStory(atmuxDir, { title: "child", epic: eid });
    const { out } = await captureStdout(() => epic(["show", eid, "--json", "--team-dir", teamDir]));
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(eid);
    expect(parsed.stories).toHaveLength(1);
  });

  test("epic show missing id → ConfigError", async () => {
    await expect(epic(["show", "e-bogus", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });

  test("epic advance default step works", async () => {
    const eid = await addEpic(atmuxDir, { title: "A" });
    const { out: _ } = await captureStdout(() => epic(["advance", eid, "--team-dir", teamDir]));
    const e = (await listEpics(atmuxDir)).find((x) => x.id === eid);
    expect(e?.status).toBe("ready");
  });

  test("epic advance --to specific state", async () => {
    const eid = await addEpic(atmuxDir, { title: "A" });
    await captureStdout(() => epic(["advance", eid, "--to", "ready", "--team-dir", teamDir]));
    const e = (await listEpics(atmuxDir)).find((x) => x.id === eid);
    expect(e?.status).toBe("ready");
  });

  test("epic alias ls works", async () => {
    const { out } = await captureStdout(() => epic(["ls", "--team-dir", teamDir]));
    expect(out).toContain("(no epics)");
  });
});

// ---------- Direct-task gating on epic advance (children gate) ----------

describe("epic advance — direct-task children gate", () => {
  test("non-done direct task blocks review entry", async () => {
    const eid = await addEpic(atmuxDir, { title: "A" });
    await advanceEpic(atmuxDir, eid, "ready");
    await advanceEpic(atmuxDir, eid, "in-progress");
    const tid = await addTask(atmuxDir, { subject: "direct" });
    // Link as direct on the epic (no story).
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      const t = repo.getTask(tid);
      if (t !== null) repo.upsertTask({ ...t, epic: eid });
      closeDatabase(db);
    }
    await expect(advanceEpic(atmuxDir, eid, "review")).rejects.toThrow(/blocking children/);
    // Closing it unblocks the gate.
    await moveTask(atmuxDir, tid, "done");
    const r = await advanceEpic(atmuxDir, eid, "review");
    expect(r.to).toBe("review");
  });
});
