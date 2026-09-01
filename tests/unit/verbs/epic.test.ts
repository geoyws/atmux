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

// ---------- ADR-225: CLI surface for dependsOn / isReady ----------

describe("epic parseAddArgs — --depends-on (ADR-225)", () => {
  test("--depends-on with a single id", () => {
    const a = parseAddArgs(["t", "--depends-on", "e-aaa"]);
    expect(a.dependsOn).toEqual(["e-aaa"]);
  });

  test("--depends-on comma-splits + trims tokens", () => {
    const a = parseAddArgs(["t", "--depends-on", " e-aaa , e-bbb ,e-ccc "]);
    expect(a.dependsOn).toEqual(["e-aaa", "e-bbb", "e-ccc"]);
  });

  test("--depends-on with empty string → empty list (explicit no-deps)", () => {
    const a = parseAddArgs(["t", "--depends-on", ""]);
    expect(a.dependsOn).toEqual([]);
  });

  test("--depends-on without a value throws UsageError", () => {
    expect(() => parseAddArgs(["t", "--depends-on"])).toThrow(UsageError);
  });

  test("--depends-on absent → dependsOn undefined (defaults to [] downstream)", () => {
    const a = parseAddArgs(["t"]);
    expect(a.dependsOn).toBeUndefined();
  });
});

describe("epic verb — ADR-225 dispatch", () => {
  test("`epic add --depends-on a,b` writes the dep list correctly", async () => {
    // Seed two upstream epics.
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B" });
    // Run the verb to add a downstream with both as deps.
    const { out } = await captureStdout(async () => {
      return await epic(["add", "--team-dir", teamDir, "Z", "--depends-on", `${a},${b}`]);
    });
    const newId = out.trim();
    const z = await showEpic(atmuxDir, newId);
    expect(z?.dependsOn?.sort()).toEqual([a, b].sort());
    expect(z?.isReady).toBe(false);
  });

  test("`epic ready <id>` flips is_ready=1; `epic show` reflects it", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await epic(["ready", a, "--team-dir", teamDir]);
    const after = await showEpic(atmuxDir, a);
    expect(after?.isReady).toBe(true);
  });

  test("`epic unready <id>` reverses to is_ready=0", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await epic(["ready", a, "--team-dir", teamDir]);
    await epic(["unready", a, "--team-dir", teamDir]);
    const after = await showEpic(atmuxDir, a);
    expect(after?.isReady).toBe(false);
  });

  test("`epic ready` then `epic ready` again is a noop (no error)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await epic(["ready", a, "--team-dir", teamDir]);
    // Second call: same value → noop path.
    const code = await epic(["ready", a, "--team-dir", teamDir]);
    expect(code).toBe(0);
  });

  test("`epic set-depends-on <id> e-NEW` replaces (not appends)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B" });
    const c = await addEpic(atmuxDir, { title: "C", dependsOn: [a] });
    await epic(["set-depends-on", c, b, "--team-dir", teamDir]);
    const after = await showEpic(atmuxDir, c);
    expect(after?.dependsOn).toEqual([b]);
  });

  test('`epic set-depends-on <id> ""` clears the dep list', async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await epic(["set-depends-on", b, "", "--team-dir", teamDir]);
    const after = await showEpic(atmuxDir, b);
    expect(after?.dependsOn).toEqual([]);
  });

  test("`epic deps <id>` renders a 3-level chain as nested tree", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const c = await addEpic(atmuxDir, { title: "C", dependsOn: [b] });
    const { out } = await captureStdout(async () => {
      return await epic(["deps", c, "--team-dir", teamDir]);
    });
    // Three levels: c (root), b (child), a (grandchild). Indent grows
    // by two spaces per level.
    expect(out).toContain(c);
    expect(out).toContain(`  ${b}`);
    expect(out).toContain(`    ${a}`);
  });

  test("`epic deps --json` emits the same tree as nested JSON", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const { out } = await captureStdout(async () => {
      return await epic(["deps", b, "--team-dir", teamDir, "--json"]);
    });
    const tree = JSON.parse(out) as {
      id: string;
      status: string;
      children: Array<{ id: string; status: string; children: unknown[] }>;
    };
    expect(tree.id).toBe(b);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]?.id).toBe(a);
  });

  test("`epic show` text view includes is_ready + depends_on lines", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await epic(["ready", b, "--team-dir", teamDir]);
    const { out } = await captureStdout(async () => {
      return await epic(["show", b, "--team-dir", teamDir]);
    });
    expect(out).toMatch(/is_ready: 1/);
    expect(out).toContain(`depends_on: [${a}]`);
  });

  test("`epic show` text view renders owner/priority/deps inline on task rows (ADR-173)", async () => {
    const eid = await addEpic(atmuxDir, { title: "T" });
    const sid = await addStory(atmuxDir, { title: "child story", epic: eid });
    // An upstream blocker task (epic-direct, unowned, no priority).
    const blocker = await addTask(atmuxDir, { subject: "blocker" });
    // Epic-direct task: owned by alpha, priority 2, depends on the blocker.
    const direct = await addTask(atmuxDir, {
      subject: "direct task",
      assignee: "alpha",
      priority: 2,
      deps: [blocker],
    });
    // Story-child task: owned by reviewer, priority 5, no deps.
    const childTask = await addTask(atmuxDir, {
      subject: "story child task",
      assignee: "reviewer",
      priority: 5,
    });
    // Link epic/story via the repo (addTask has no --epic/--story surface).
    {
      const db = openDatabase(join(atmuxDir, "state.db"), migrations);
      const repo = new KanbanRepo(db);
      for (const id of [blocker, direct]) {
        const t = repo.getTask(id);
        if (t !== null) repo.upsertTask({ ...t, epic: eid });
      }
      const ct = repo.getTask(childTask);
      if (ct !== null) repo.upsertTask({ ...ct, epic: eid, story: sid });
      closeDatabase(db);
    }
    const { out } = await captureStdout(async () => {
      return await epic(["show", eid, "--team-dir", teamDir]);
    });
    // Locate the epic-direct task row and assert owner + priority + deps
    // all render inline on that single line (not a global `toContain`,
    // which could pass off another row's substring).
    const directLine = out.split("\n").find((l) => l.includes(direct));
    expect(directLine).toBeDefined();
    expect(directLine).toContain("[alpha, P2]");
    expect(directLine).toContain(`← deps: ${blocker}`);
    // The unowned, no-priority blocker renders the `-` / `P-` placeholders
    // and no deps trailer (empty deps[] omits the marker entirely).
    const blockerLine = out.split("\n").find((l) => l.includes(blocker) && !l.includes(direct));
    expect(blockerLine).toBeDefined();
    expect(blockerLine).toContain("[-, P-]");
    expect(blockerLine).not.toContain("← deps:");
    // The story-child task row carries its own owner/priority inline.
    const childLine = out.split("\n").find((l) => l.includes(childTask));
    expect(childLine).toBeDefined();
    expect(childLine).toContain("[reviewer, P5]");
  });

  test("`epic list` table includes R + D columns", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    // Walk a to done so its dep counts as `done`.
    await advanceEpic(atmuxDir, a, "ready");
    await advanceEpic(atmuxDir, a, "in-progress");
    await advanceEpic(atmuxDir, a, "review");
    await advanceEpic(atmuxDir, a, "done");
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await epic(["ready", b, "--team-dir", teamDir]);
    const { out } = await captureStdout(async () => {
      return await epic(["list", "--team-dir", teamDir]);
    });
    // Header now exposes R + D columns.
    expect(out).toContain("R ");
    expect(out).toContain("D");
    // b has 1 dep (a), and a is done → D=1/1; b is ready → R=1.
    const bLine = out.split("\n").find((l) => l.startsWith(b));
    expect(bLine).toMatch(/\s1\s+1\/1\s/);
    // a has no deps → D=`-`; a is not ready (we only flipped b) → R=0.
    const aLine = out.split("\n").find((l) => l.startsWith(a));
    expect(aLine).toMatch(/\s0\s+-\s/);
  });

  test("validation propagation: cycle surfaces as UsageError exit", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    // Closing the cycle via the verb path.
    await expect(epic(["set-depends-on", a, b, "--team-dir", teamDir])).rejects.toThrow(/cycle/);
  });

  test("validation propagation: self-dep refused via the verb", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await expect(epic(["set-depends-on", a, a, "--team-dir", teamDir])).rejects.toThrow(
      /cannot depend on itself/,
    );
  });

  test("validation propagation: non-existent dep refused via epic add", async () => {
    await expect(
      epic(["add", "--team-dir", teamDir, "Z", "--depends-on", "e-ghost"]),
    ).rejects.toThrow(/does not exist/);
  });

  test("`epic ready` on a missing epic surfaces as ConfigError", async () => {
    await expect(epic(["ready", "e-ghost", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });

  test("`epic deps` on a missing epic surfaces as ConfigError", async () => {
    await expect(epic(["deps", "e-ghost", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });
});

// ---------- Pure: parseAddArgs — ADR-231 §D3 (auto-spawn flags) ----------

describe("epic parseAddArgs — auto-spawn flags (ADR-231 §D3)", () => {
  test("--auto-spawn alone → autoSpawn={enabled:true}", () => {
    const a = parseAddArgs(["t", "--auto-spawn"]);
    expect(a.autoSpawn).toEqual({ enabled: true });
  });

  test("--no-auto-spawn alone → autoSpawn={enabled:false}", () => {
    const a = parseAddArgs(["t", "--no-auto-spawn"]);
    expect(a.autoSpawn).toEqual({ enabled: false });
  });

  test("--auto-spawn --roster solo → autoSpawn={enabled:true,roster:'solo'}", () => {
    const a = parseAddArgs(["t", "--auto-spawn", "--roster", "solo"]);
    expect(a.autoSpawn).toEqual({ enabled: true, roster: "solo" });
  });

  test("--auto-spawn --force-spawn → autoSpawn={enabled:true,forceSpawn:true}", () => {
    const a = parseAddArgs(["t", "--auto-spawn", "--force-spawn"]);
    expect(a.autoSpawn).toEqual({ enabled: true, forceSpawn: true });
  });

  test("combo: --auto-spawn --roster solo --force-spawn → all three set", () => {
    const a = parseAddArgs(["t", "--auto-spawn", "--roster", "solo", "--force-spawn"]);
    expect(a.autoSpawn).toEqual({
      enabled: true,
      roster: "solo",
      forceSpawn: true,
    });
  });

  test("no flags → autoSpawn undefined (falls back to per-team defaults match OR off)", () => {
    const a = parseAddArgs(["t"]);
    expect(a.autoSpawn).toBeUndefined();
  });

  test("mutex: --no-auto-spawn + --force-spawn → UsageError", () => {
    expect(() => parseAddArgs(["t", "--no-auto-spawn", "--force-spawn"])).toThrow(
      /--no-auto-spawn cannot combine with --force-spawn/,
    );
  });

  test("mutex: --roster without --auto-spawn → UsageError (helpful message)", () => {
    expect(() => parseAddArgs(["t", "--roster", "solo"])).toThrow(/--roster requires --auto-spawn/);
  });

  test("mutex: --force-spawn without --auto-spawn → UsageError", () => {
    expect(() => parseAddArgs(["t", "--force-spawn"])).toThrow(
      /--force-spawn requires --auto-spawn/,
    );
  });

  test("mutex: --no-auto-spawn + --roster → UsageError (--roster requires --auto-spawn-enable)", () => {
    // --no-auto-spawn sets autoSpawnFlag='disable', not 'enable',
    // so the --roster mutex check fires.
    expect(() => parseAddArgs(["t", "--no-auto-spawn", "--roster", "solo"])).toThrow(
      /--roster requires --auto-spawn/,
    );
  });

  test("--roster without a value → UsageError", () => {
    expect(() => parseAddArgs(["t", "--auto-spawn", "--roster"])).toThrow(
      /--roster requires a value/,
    );
  });

  test("--roster with empty value → UsageError (treated as missing)", () => {
    expect(() => parseAddArgs(["t", "--auto-spawn", "--roster", ""])).toThrow(
      /--roster requires a value/,
    );
  });
});

// ---------- IO: epic verb dispatch — ADR-231 §D3 round-trip ----------

describe("epic verb — ADR-231 §D3 auto-spawn round-trip", () => {
  test("`epic add --auto-spawn --roster solo` writes extra.autoSpawn", async () => {
    const { out } = await captureStdout(async () => {
      return await epic(["add", "--team-dir", teamDir, "Z", "--auto-spawn", "--roster", "solo"]);
    });
    const newId = out.trim();
    const z = await showEpic(atmuxDir, newId);
    expect(z?.extra?.autoSpawn).toEqual({ enabled: true, roster: "solo" });
  });

  test("`epic add --no-auto-spawn` writes extra.autoSpawn={enabled:false}", async () => {
    const { out } = await captureStdout(async () => {
      return await epic(["add", "--team-dir", teamDir, "Z", "--no-auto-spawn"]);
    });
    const newId = out.trim();
    const z = await showEpic(atmuxDir, newId);
    expect(z?.extra?.autoSpawn).toEqual({ enabled: false });
  });

  test("`epic add` (no auto-spawn flags) → no autoSpawn key in extra", async () => {
    const { out } = await captureStdout(async () => {
      return await epic(["add", "--team-dir", teamDir, "Z"]);
    });
    const newId = out.trim();
    const z = await showEpic(atmuxDir, newId);
    // Either extra absent OR extra present without autoSpawn — both
    // valid; the meaningful assertion is "no autoSpawn config" so
    // per-team defaults (T-S1.3) drive the decision downstream.
    expect(z?.extra?.autoSpawn).toBeUndefined();
  });

  test("`epic add --auto-spawn --roster solo --force-spawn` writes full triple", async () => {
    const { out } = await captureStdout(async () => {
      return await epic([
        "add",
        "--team-dir",
        teamDir,
        "Z",
        "--auto-spawn",
        "--roster",
        "solo",
        "--force-spawn",
      ]);
    });
    const newId = out.trim();
    const z = await showEpic(atmuxDir, newId);
    expect(z?.extra?.autoSpawn).toEqual({
      enabled: true,
      roster: "solo",
      forceSpawn: true,
    });
  });

  test("`epic add --no-auto-spawn --force-spawn` rejects with mutex UsageError before any DB write", async () => {
    const before = await listEpics(atmuxDir);
    await expect(
      epic(["add", "--team-dir", teamDir, "Z", "--no-auto-spawn", "--force-spawn"]),
    ).rejects.toThrow(/--no-auto-spawn cannot combine with --force-spawn/);
    // Confirm no partial row landed.
    const after = await listEpics(atmuxDir);
    expect(after.length).toBe(before.length);
  });
});
