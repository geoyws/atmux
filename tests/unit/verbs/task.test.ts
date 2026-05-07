// Unit tests for src/verbs/task.ts (ADR-010).
// Bash spec: lib/kanban.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatched, loadInbox } from "../../../src/core/inbox.ts";
import { addTask, assignTask, loadKanban, moveTask } from "../../../src/core/kanban.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { parseAddArgs, parseListArgs, task } from "../../../src/verbs/task.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-task-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "team", members: [{ name: "alpha" }] }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

/** Capture stdout for a verb call. */
async function captureStdout(fn: () => Promise<number>): Promise<{ exit: number; out: string }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await fn();
    return { exit, out };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- Pure: parseAddArgs ----------

describe("parseAddArgs", () => {
  test("subject from single positional", () => {
    expect(parseAddArgs(["my-task"])).toEqual({ subject: "my-task" });
  });

  test("subject from multiple positionals joined by space", () => {
    expect(parseAddArgs(["one", "two", "three"]).subject).toBe("one two three");
  });

  test("--body / --assignee / --priority / --deps consumed", () => {
    const a = parseAddArgs([
      "subj",
      "--body",
      "details",
      "--assignee",
      "alpha",
      "--priority",
      "3",
      "--deps",
      "a,b,",
    ]);
    expect(a.subject).toBe("subj");
    expect(a.body).toBe("details");
    expect(a.assignee).toBe("alpha");
    expect(a.priority).toBe(3);
    expect(a.deps).toEqual(["a", "b"]);
  });

  test("--prio alias works", () => {
    expect(parseAddArgs(["s", "--prio", "5"]).priority).toBe(5);
  });

  test("non-numeric --priority → priority undefined (bash null parity)", () => {
    expect(parseAddArgs(["s", "--priority", "high"]).priority).toBeUndefined();
  });

  test("`--` collects remaining as subject (bash subject=$*)", () => {
    const a = parseAddArgs(["--", "task", "with", "dashes"]);
    expect(a.subject).toBe("task with dashes");
  });

  test("missing subject → UsageError", () => {
    expect(() => parseAddArgs([])).toThrow(UsageError);
  });

  test("--body without value → UsageError", () => {
    expect(() => parseAddArgs(["--body"])).toThrow(UsageError);
  });

  test("--assignee without value → UsageError", () => {
    expect(() => parseAddArgs(["--assignee"])).toThrow(UsageError);
  });

  test("--deps without value → UsageError", () => {
    expect(() => parseAddArgs(["--deps"])).toThrow(UsageError);
  });

  test("--priority without value → UsageError", () => {
    expect(() => parseAddArgs(["--priority"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseAddArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("--team-dir <dir> consumed", () => {
    expect(parseAddArgs(["s", "--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("unknown -* flag → UsageError", () => {
    expect(() => parseAddArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- Pure: parseListArgs ----------

describe("parseListArgs", () => {
  test("empty argv → defaults (json=false)", () => {
    expect(parseListArgs([])).toEqual({ json: false });
  });

  test("--status / --assignee / --json all consumed", () => {
    const a = parseListArgs(["--status", "todo", "--assignee", "alpha", "--json"]);
    expect(a.status).toBe("todo");
    expect(a.assignee).toBe("alpha");
    expect(a.json).toBe(true);
  });

  test("--team-dir <dir> consumed", () => {
    expect(parseListArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("--status without value → UsageError", () => {
    expect(() => parseListArgs(["--status"])).toThrow(UsageError);
  });

  test("--assignee without value → UsageError", () => {
    expect(() => parseListArgs(["--assignee"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseListArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseListArgs(["bogus"])).toThrow(UsageError);
  });
});

// ---------- Integration: subverb dispatch ----------

describe("task verb — dispatch", () => {
  test("no subverb defaults to list (bash kanban.sh:16 parity)", async () => {
    const { exit, out } = await captureStdout(() => task(["--team-dir", teamDir]));
    expect(exit).toBe(0);
    expect(out).toContain("(no tasks)");
  });

  test("'add' creates a task + prints id", async () => {
    const { exit, out } = await captureStdout(() =>
      task(["add", "--team-dir", teamDir, "first task"]),
    );
    expect(exit).toBe(0);
    expect(out).toMatch(/^t-[0-9a-f]{8}\n$/);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(1);
    expect(k.tasks[0]?.subject).toBe("first task");
  });

  test("'list' prints header + sorted rows by priority", async () => {
    await addTask(atmuxDir, { subject: "low-prio", priority: 5 });
    await addTask(atmuxDir, { subject: "high-prio", priority: 1 });
    const { out } = await captureStdout(() => task(["list", "--team-dir", teamDir]));
    expect(out).toContain("ID");
    expect(out).toContain("STATUS");
    expect(out).toContain("PRIO");
    // high-prio (priority 1) sorted before low-prio (priority 5).
    const hi = out.indexOf("high-prio");
    const lo = out.indexOf("low-prio");
    expect(hi).toBeGreaterThan(0);
    expect(lo).toBeGreaterThan(hi);
  });

  test("'list --json' emits valid JSON of tasks[]", async () => {
    await addTask(atmuxDir, { subject: "first" });
    const { out } = await captureStdout(() =>
      task(["list", "--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].subject).toBe("first");
  });

  test("'list --status todo' filters", async () => {
    const id = await addTask(atmuxDir, { subject: "todo-task" });
    await addTask(atmuxDir, { subject: "in-progress-task" });
    await moveTask(atmuxDir, id, "todo"); // already todo, no-op but exercises path
    const idDone = await addTask(atmuxDir, { subject: "done-task" });
    await moveTask(atmuxDir, idDone, "done");

    const { out } = await captureStdout(() =>
      task(["list", "--status", "done", "--team-dir", teamDir]),
    );
    expect(out).toContain("done-task");
    expect(out).not.toContain("todo-task");
  });

  test("'ls' alias works", async () => {
    const { out } = await captureStdout(() => task(["ls", "--team-dir", teamDir]));
    expect(out).toContain("(no tasks)");
  });

  test("'show' prints task JSON", async () => {
    const id = await addTask(atmuxDir, { subject: "find-me" });
    const { out } = await captureStdout(() => task(["show", id, "--team-dir", teamDir]));
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(id);
    expect(parsed.subject).toBe("find-me");
  });

  test("'show' missing id → UsageError", async () => {
    await expect(task(["show", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("'show' nonexistent task → ConfigError", async () => {
    await expect(task(["show", "t-deadbeef", "--team-dir", teamDir])).rejects.toThrow(
      ConfigError,
    );
  });

  test("'get' alias works", async () => {
    const id = await addTask(atmuxDir, { subject: "get-me" });
    const { out } = await captureStdout(() => task(["get", id, "--team-dir", teamDir]));
    expect(out).toContain(id);
  });

  test("'move' transitions status", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exit, out } = await captureStdout(() =>
      task(["move", id, "in-progress", "--team-dir", teamDir]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("→ in-progress");
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.status).toBe("in-progress");
  });

  test("'mv' alias works", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await captureStdout(() => task(["mv", id, "done", "--team-dir", teamDir]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.status).toBe("done");
  });

  test("'move' missing args → UsageError", async () => {
    await expect(task(["move", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("'move' bad status → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(task(["move", id, "bogus", "--team-dir", teamDir])).rejects.toThrow(
      UsageError,
    );
  });

  test("'assign' updates owner", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exit, out } = await captureStdout(() =>
      task(["assign", id, "alpha", "--team-dir", teamDir]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("→ alpha");
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.owner).toBe("alpha");
  });

  test("'assign' missing args → UsageError", async () => {
    await expect(task(["assign", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("'rm' removes task", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exit, out } = await captureStdout(() =>
      task(["rm", id, "--team-dir", teamDir]),
    );
    expect(exit).toBe(0);
    expect(out).toContain("removed");
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(0);
  });

  test("'remove' alias works", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await captureStdout(() => task(["remove", id, "--team-dir", teamDir]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(0);
  });

  test("'rm' missing id → UsageError", async () => {
    await expect(task(["rm", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("unknown subverb → UsageError", async () => {
    await expect(task(["bogus", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("subverb with unknown trailing flag → UsageError", async () => {
    await expect(task(["show", "t-aaaaaaaa", "--bogus"])).rejects.toThrow(UsageError);
  });

  test("subverb --team-dir without value → UsageError", async () => {
    await expect(task(["show", "t-aaaaaaaa", "--team-dir"])).rejects.toThrow(UsageError);
  });
});

// ---------- t-e452296b: kanban→inbox drift on parking transitions ----------

describe("'task move' drains assignee inbox.inProgress on parking transitions", () => {
  test("'move <id> blocked' drains owner's inbox.inProgress entry", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await assignTask(atmuxDir, id, "alpha");
    // Stage alpha's inbox as if dispatch had pushed the task.
    await appendDispatched(atmuxDir, "alpha", { id, subject: "x" }, 1_700_000_000);
    let inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress.map((t) => t.id)).toEqual([id]);

    await captureStdout(() => task(["move", id, "blocked", "--team-dir", teamDir]));

    inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toEqual([]);
    // Kanban side still reflects the block + retains owner for audit.
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.status).toBe("blocked");
    expect(k.tasks[0]?.owner).toBe("alpha");
  });

  test("'move <id> todo' drains owner's inbox.inProgress entry (un-claim parity)", async () => {
    const id = await addTask(atmuxDir, { subject: "y" });
    await assignTask(atmuxDir, id, "alpha");
    await appendDispatched(atmuxDir, "alpha", { id, subject: "y" }, 1_700_000_000);

    await captureStdout(() => task(["move", id, "todo", "--team-dir", teamDir]));

    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toEqual([]);
  });

  test("'move <id> in-progress' does NOT drain (transition isn't parking)", async () => {
    const id = await addTask(atmuxDir, { subject: "z" });
    await assignTask(atmuxDir, id, "alpha");
    await appendDispatched(atmuxDir, "alpha", { id, subject: "z" }, 1_700_000_000);

    await captureStdout(() => task(["move", id, "in-progress", "--team-dir", teamDir]));

    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress.map((t) => t.id)).toEqual([id]);
  });

  test("'move <id> blocked' on unowned task is a no-op (no member resolution needed)", async () => {
    const id = await addTask(atmuxDir, { subject: "no-owner" });
    // Stage alpha's inbox empty — simulating "ownership not yet set".
    await captureStdout(() => task(["move", id, "blocked", "--team-dir", teamDir]));
    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toEqual([]);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.status).toBe("blocked");
  });

  test("'move <id> blocked' when entry not actually in inbox is idempotent", async () => {
    // owner is "alpha" on kanban but alpha's inbox does NOT contain the
    // entry — block transition should not throw / not corrupt the inbox.
    const id = await addTask(atmuxDir, { subject: "ghosted" });
    await assignTask(atmuxDir, id, "alpha");
    // Don't stage alpha's inbox at all.

    await captureStdout(() => task(["move", id, "blocked", "--team-dir", teamDir]));

    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toEqual([]);
  });

  test("'move <id> done' continues to use moveTask completedAt stamp (not drained here)", async () => {
    // The `atmux done` verb owns the inbox.inProgress → inbox.done
    // transition; `task move <id> done` is the bare kanban-side path
    // and intentionally doesn't migrate the inbox entry to .done.
    const id = await addTask(atmuxDir, { subject: "kanban-done-only" });
    await assignTask(atmuxDir, id, "alpha");
    await appendDispatched(atmuxDir, "alpha", { id, subject: "kanban-done-only" }, 1_700_000_000);

    await captureStdout(() => task(["move", id, "done", "--team-dir", teamDir]));

    const inbox = await loadInbox(atmuxDir, "alpha");
    // Bare task-move-done leaves the inbox entry alone — `atmux done`
    // is the verb that drains+migrates. Pinning current behaviour.
    expect(inbox.inProgress.map((t) => t.id)).toEqual([id]);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.status).toBe("done");
    expect(k.tasks[0]?.completedAt).toBeGreaterThan(0);
  });
});
