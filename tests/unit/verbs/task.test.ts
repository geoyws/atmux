// Unit tests for src/verbs/task.ts (ADR-010).
// Bash spec: lib/kanban.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatched, loadInbox } from "../../../src/core/inbox.ts";
import { addTask, assignTask, loadKanban, moveTask, showTask } from "../../../src/core/kanban.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  closestStatus,
  parseAddArgs,
  parseListArgs,
  resolveLaneAlias,
  task,
} from "../../../src/verbs/task.ts";

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

  test("ADR-033: --driver-only sets driverOnly=true (boolean, no value)", () => {
    const a = parseAddArgs(["subj", "--driver-only"]);
    expect(a.driverOnly).toBe(true);
  });

  test("ADR-033: --driver-only absent → driverOnly undefined (preserves legacy default)", () => {
    expect(parseAddArgs(["subj"]).driverOnly).toBeUndefined();
  });

  // ---------- ADR-193: --epic / --story / --deliverable ----------
  test("ADR-193: --epic / --story / --deliverable consumed (legacy hex8 ids)", () => {
    const a = parseAddArgs([
      "subj",
      "--epic",
      "e-3b017960",
      "--story",
      "s-c4e91c33",
      "--deliverable",
      "docs/adr/171-x.md",
    ]);
    expect(a.epic).toBe("e-3b017960");
    expect(a.story).toBe("s-c4e91c33");
    expect(a.deliverable).toBe("docs/adr/171-x.md");
  });

  test("ADR-193: running-number ids accepted (ADR-202 §VIII — e-1 / s-1203)", () => {
    const a = parseAddArgs(["subj", "--epic", "e-1", "--story", "s-1203"]);
    expect(a.epic).toBe("e-1");
    expect(a.story).toBe("s-1203");
  });

  test("ADR-193: malformed --epic → UsageError (shape check, exit 64)", () => {
    expect(() => parseAddArgs(["subj", "--epic", "e-zzz"])).toThrow(UsageError);
    expect(() => parseAddArgs(["subj", "--epic", "nope"])).toThrow(UsageError);
  });

  test("ADR-193: malformed --story → UsageError", () => {
    expect(() => parseAddArgs(["subj", "--story", "e-1"])).toThrow(UsageError);
  });

  test("ADR-193: --deliverable over 256 chars → UsageError", () => {
    expect(() => parseAddArgs(["subj", "--deliverable", "x".repeat(257)])).toThrow(UsageError);
  });

  test("ADR-193: --deliverable at exactly 256 chars accepted", () => {
    expect(parseAddArgs(["subj", "--deliverable", "x".repeat(256)]).deliverable).toHaveLength(256);
  });

  test("ADR-193: empty --epic on add = unset (no validation, field absent)", () => {
    expect(parseAddArgs(["subj", "--epic", ""]).epic).toBeUndefined();
  });

  test("ADR-193: --epic / --story / --deliverable without value → UsageError", () => {
    expect(() => parseAddArgs(["subj", "--epic"])).toThrow(UsageError);
    expect(() => parseAddArgs(["subj", "--story"])).toThrow(UsageError);
    expect(() => parseAddArgs(["subj", "--deliverable"])).toThrow(UsageError);
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

  // ---------- ADR-080 §D — --status normalize + did-you-mean ----------

  test("ADR-080§D: --status in_progress (snake_case) → normalized to in-progress", () => {
    const a = parseListArgs(["--status", "in_progress"]);
    expect(a.status).toBe("in-progress");
  });

  test("ADR-080§D: --status in-progress (canonical) → unchanged", () => {
    const a = parseListArgs(["--status", "in-progress"]);
    expect(a.status).toBe("in-progress");
  });

  test("ADR-080§D: --status to_do → normalized to to-do BUT to-do isn't valid → UsageError + did-you-mean 'todo'", () => {
    let err: unknown;
    try {
      parseListArgs(["--status", "to_do"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect(((err as UsageError).context as { what: string }).what).toContain('"to_do"');
    expect(((err as UsageError).context as { what: string }).what).toContain('"todo"');
  });

  test("ADR-080§D: --status nonsense (no near match) → UsageError, no did-you-mean", () => {
    let err: unknown;
    try {
      parseListArgs(["--status", "nonsense"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    const what = ((err as UsageError).context as { what: string }).what;
    expect(what).toContain('"nonsense"');
    expect(what).not.toContain("did you mean");
  });

  test("ADR-080§D: --status (no value) → UsageError 'requires a value' (regression-pin)", () => {
    let err: unknown;
    try {
      parseListArgs(["--status"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect(((err as UsageError).context as { what: string }).what).toContain("requires a value");
  });

  test("ADR-080§D: --status blokced (typo) → did-you-mean 'blocked'", () => {
    let err: unknown;
    try {
      parseListArgs(["--status", "blokced"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect(((err as UsageError).context as { what: string }).what).toContain('"blocked"');
  });
});

// ---------- closestStatus helper ----------

describe("closestStatus", () => {
  test("exact match → returns input", () => {
    expect(closestStatus("todo")).toBe("todo");
  });

  test("distance-1 typo → suggests valid status", () => {
    expect(closestStatus("dond")).toBe("done");
  });

  test("distance-2 typo → suggests valid status", () => {
    expect(closestStatus("dnoe")).toBe("done");
  });

  test("distance > 2 → null (no suggestion)", () => {
    expect(closestStatus("nonsense")).toBeNull();
  });

  test("empty string → null (no near valid status)", () => {
    expect(closestStatus("")).toBeNull();
  });

  test("post-normalize 'to-do' → suggests 'todo'", () => {
    expect(closestStatus("to-do")).toBe("todo");
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
    // JSON-mode kanban (no state.db) stays on legacy hex IDs per
    // ADR-202 §VIII fallback. SQLite-mode tests get the compound
    // `t-N-<hash>` shape (see kanban-sqlite.test.ts).
    expect(out).toMatch(/^t-[0-9a-f]{8}\n$/);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(1);
    expect(k.tasks[0]?.subject).toBe("first task");
  });

  test("ADR-033: 'add --driver-only' stamps driverOnly=true on the new Task", async () => {
    await captureStdout(() =>
      task(["add", "--team-dir", teamDir, "--driver-only", "fires-only-by-driver"]),
    );
    const k = await loadKanban(atmuxDir);
    expect(k.tasks).toHaveLength(1);
    expect(k.tasks[0]?.driverOnly).toBe(true);
  });

  test("ADR-033: 'add' without --driver-only leaves driverOnly absent (legacy default)", async () => {
    await captureStdout(() => task(["add", "--team-dir", teamDir, "regular-task"]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.driverOnly).toBeUndefined();
  });

  test("ADR-033: 'list' surfaces D marker on driverOnly Tasks (blank otherwise)", async () => {
    await addTask(atmuxDir, { subject: "regular", priority: 1 });
    await addTask(atmuxDir, { subject: "fires-by-driver", priority: 1, driverOnly: true });
    const { out } = await captureStdout(() => task(["list", "--team-dir", teamDir]));
    expect(out).toContain(" F  SUBJECT");
    const lines = out.split("\n");
    const regularLine = lines.find((l) => l.includes("regular")) ?? "";
    const driverLine = lines.find((l) => l.includes("fires-by-driver")) ?? "";
    // The flag column comes right before SUBJECT, padded to width 2.
    expect(driverLine).toMatch(/\sD\s+fires-by-driver$/);
    expect(regularLine).toMatch(/\s\s\s+regular$/);
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
    const { out } = await captureStdout(() => task(["list", "--json", "--team-dir", teamDir]));
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].subject).toBe("first");
  });

  test("ADR-080§E: 'list --json' round-trips adversarial body (backticks/newlines/quotes/$)", async () => {
    // Forward trip-wire per ADR-080 §E investigation: sopx-driver
    // observed `atmux task list --json | jq` parse-errors on bodies
    // containing backticks/newlines/quotes. Bun-side `task.ts` emits via
    // `JSON.stringify(tasks, null, 2)` (standard library, properly
    // escapes); the suspected bug is bash-sopx-side. This fixture
    // documents the bun-side guarantee so a future regression — e.g.
    // someone replacing `JSON.stringify` with a hand-rolled formatter,
    // or `core/kanban.ts::listTasks` returning a string field that's
    // already JSON-encoded-once — gets caught at PR time. See
    // `docs/INVESTIGATION-bash-task-list-json.md`.
    // Fixture purposely embeds a literal `${world}` substring (the
    // adversarial body) — backticks + dollar-brace are escaped within
    // the template literal so neither template-substitution nor a
    // future biome auto-fix can accidentally interpolate `world`.
    const ADVERSARIAL_BODY = `\`\`\`ts\nconst x = \`hello \${world}\`;\nconst y = 'a' + "b";\nconst z = $1 + $foo;\n\`\`\``;
    await addTask(atmuxDir, { subject: "adversarial", body: ADVERSARIAL_BODY });
    const { out } = await captureStdout(() => task(["list", "--json", "--team-dir", teamDir]));
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      throw new Error(
        `bun task.ts --json emit produced un-parseable output (ADR-080§E regression):\n` +
          `  parse error: ${(e as Error).message}\n` +
          `  raw stdout (first 200): ${out.slice(0, 200)}\n`,
      );
    }
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as Array<{ subject: string; body?: string }>).length).toBe(1);
    expect((parsed as Array<{ subject: string }>)[0]?.subject).toBe("adversarial");
    expect((parsed as Array<{ body?: string }>)[0]?.body).toBe(ADVERSARIAL_BODY);
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
    await expect(task(["show", "t-deadbeef", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
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
    await expect(task(["move", id, "bogus", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  // ADR-033 task move refuse-gate (t-a90c80b0). `in-progress` and
  // `done` transitions on driverOnly Tasks refuse for non-driver scope;
  // `todo` and `blocked` bookkeeping moves remain allowed per ADR-033
  // §Refuse-gate site #2 carve-out.
  describe("ADR-033 driver-only refuse-gate", () => {
    const priorScope = (): string | undefined => process.env.ATMUX_CALLER_SCOPE;
    const restoreScope = (v: string | undefined): void => {
      if (v === undefined) delete process.env.ATMUX_CALLER_SCOPE;
      else process.env.ATMUX_CALLER_SCOPE = v;
    };

    test("driverOnly + member scope: move → in-progress refused", async () => {
      const id = await addTask(atmuxDir, { subject: "driver-fires", driverOnly: true });
      const saved = priorScope();
      delete process.env.ATMUX_CALLER_SCOPE;
      try {
        await expect(task(["move", id, "in-progress", "--team-dir", teamDir])).rejects.toThrow(
          /task move:.*driver-only Task/,
        );
      } finally {
        restoreScope(saved);
      }
      const k = await loadKanban(atmuxDir);
      expect(k.tasks[0]?.status).toBe("todo");
    });

    test("driverOnly + member scope: move → done refused", async () => {
      const id = await addTask(atmuxDir, { subject: "driver-fires", driverOnly: true });
      const saved = priorScope();
      delete process.env.ATMUX_CALLER_SCOPE;
      try {
        await expect(task(["move", id, "done", "--team-dir", teamDir])).rejects.toThrow(
          /task move:.*driver-only Task/,
        );
      } finally {
        restoreScope(saved);
      }
      const k = await loadKanban(atmuxDir);
      expect(k.tasks[0]?.status).toBe("todo");
    });

    test("driverOnly + driver scope: move → in-progress succeeds", async () => {
      const id = await addTask(atmuxDir, { subject: "driver-fires", driverOnly: true });
      const saved = priorScope();
      process.env.ATMUX_CALLER_SCOPE = "driver";
      try {
        await captureStdout(() => task(["move", id, "in-progress", "--team-dir", teamDir]));
      } finally {
        restoreScope(saved);
      }
      const k = await loadKanban(atmuxDir);
      expect(k.tasks[0]?.status).toBe("in-progress");
    });

    test("driverOnly + member scope: move → todo ALLOWED (bookkeeping carve-out)", async () => {
      const id = await addTask(atmuxDir, { subject: "driver-fires", driverOnly: true });
      // Get it to in-progress first via driver path so we have somewhere
      // to move from.
      const saved = priorScope();
      process.env.ATMUX_CALLER_SCOPE = "driver";
      try {
        await captureStdout(() => task(["move", id, "in-progress", "--team-dir", teamDir]));
      } finally {
        restoreScope(saved);
      }
      // Now back to todo as member — must be allowed.
      delete process.env.ATMUX_CALLER_SCOPE;
      try {
        await captureStdout(() => task(["move", id, "todo", "--team-dir", teamDir]));
      } finally {
        restoreScope(saved);
      }
      const k = await loadKanban(atmuxDir);
      expect(k.tasks[0]?.status).toBe("todo");
    });

    test("driverOnly + member scope: move → blocked ALLOWED (bookkeeping carve-out)", async () => {
      const id = await addTask(atmuxDir, { subject: "driver-fires", driverOnly: true });
      const saved = priorScope();
      delete process.env.ATMUX_CALLER_SCOPE;
      try {
        await captureStdout(() => task(["move", id, "blocked", "--team-dir", teamDir]));
      } finally {
        restoreScope(saved);
      }
      const k = await loadKanban(atmuxDir);
      expect(k.tasks[0]?.status).toBe("blocked");
    });

    test("driverOnly absent (legacy): move → done allowed for any scope", async () => {
      const id = await addTask(atmuxDir, { subject: "regular" });
      const saved = priorScope();
      delete process.env.ATMUX_CALLER_SCOPE;
      try {
        await captureStdout(() => task(["move", id, "done", "--team-dir", teamDir]));
      } finally {
        restoreScope(saved);
      }
      const k = await loadKanban(atmuxDir);
      expect(k.tasks[0]?.status).toBe("done");
    });
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

  // ---------- ADR-131 T4: 'task priority' ----------

  test("'priority' sets the integer priority on an existing task", async () => {
    const id = await addTask(atmuxDir, { subject: "p task" });
    const { exit } = await captureStdout(() => task(["priority", id, "5", "--team-dir", teamDir]));
    expect(exit).toBe(0);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.priority).toBe(5);
  });

  test("'prio' alias works", async () => {
    const id = await addTask(atmuxDir, { subject: "p task" });
    await captureStdout(() => task(["prio", id, "2", "--team-dir", teamDir]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.priority).toBe(2);
  });

  test("'priority -' clears the priority (sets null)", async () => {
    const id = await addTask(atmuxDir, { subject: "p task", priority: 3 });
    await captureStdout(() => task(["priority", id, "-", "--team-dir", teamDir]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.priority).toBeNull();
  });

  test("'priority' rejects non-integer value", async () => {
    const id = await addTask(atmuxDir, { subject: "p task" });
    await expect(task(["priority", id, "high", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("'priority' missing args → UsageError", async () => {
    await expect(task(["priority", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("'priority' on missing id → ConfigError", async () => {
    await expect(task(["priority", "t-deadbeef", "1", "--team-dir", teamDir])).rejects.toThrow(
      ConfigError,
    );
  });

  test("'rm' removes task", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exit, out } = await captureStdout(() => task(["rm", id, "--team-dir", teamDir]));
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

  test("'update' rewrites body in place", async () => {
    const id = await addTask(atmuxDir, { subject: "x", body: "old" });
    const { exit, out } = await captureStdout(() =>
      task(["update", id, "--body", "rewritten gates 2+3", "--team-dir", teamDir]),
    );
    expect(exit).toBe(0);
    expect(out).toContain(`task ${id} updated`);
    const after = await showTask(atmuxDir, id);
    expect(after?.body).toBe("rewritten gates 2+3");
  });

  test("'update' rewrites deps list", async () => {
    const id = await addTask(atmuxDir, { subject: "x", deps: ["t-old01010"] });
    await captureStdout(() =>
      task(["update", id, "--deps", "t-new01010,t-new20202", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.deps).toEqual(["t-new01010", "t-new20202"]);
  });

  test("'update' --body and --deps together", async () => {
    const id = await addTask(atmuxDir, { subject: "x", body: "old", deps: ["t-old01010"] });
    await captureStdout(() =>
      task(["update", id, "--body", "new", "--deps", "t-fresh0001", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.body).toBe("new");
    expect(after?.deps).toEqual(["t-fresh0001"]);
  });

  test("'update' --deps '' clears the deps list", async () => {
    const id = await addTask(atmuxDir, { subject: "x", deps: ["t-a0000001", "t-b0000001"] });
    await captureStdout(() => task(["update", id, "--deps", "", "--team-dir", teamDir]));
    const after = await showTask(atmuxDir, id);
    expect(after?.deps).toEqual([]);
  });

  test("'update' with no flags → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(task(["update", id, "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("'update' missing id → UsageError", async () => {
    await expect(task(["update", "--body", "x", "--team-dir", teamDir])).rejects.toThrow(
      UsageError,
    );
  });

  test("'update' on missing id → ConfigError", async () => {
    await expect(
      task(["update", "t-missing0", "--body", "x", "--team-dir", teamDir]),
    ).rejects.toThrow(/no such task/);
  });

  // ---------- t-218b2c08: --owner / --unassign on `task update` ----------

  test("'update' --owner reassigns to existing member", async () => {
    const id = await addTask(atmuxDir, { subject: "phantom-owned" });
    await captureStdout(() =>
      task(["update", id, "--owner", "alpha", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.owner).toBe("alpha");
  });

  test("'update' --owner unknown member → ConfigError with valid-members hint", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(
      task(["update", id, "--owner", "ghost", "--team-dir", teamDir]),
    ).rejects.toThrow(/not in team\.json/);
  });

  test("'update' --unassign sets owner to null (parking-lot pattern)", async () => {
    const id = await addTask(atmuxDir, { subject: "x", assignee: "alpha" });
    const before = await showTask(atmuxDir, id);
    expect(before?.owner).toBe("alpha");
    await captureStdout(() =>
      task(["update", id, "--unassign", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.owner).toBeNull();
  });

  test("'update' --owner doesn't clobber body/deps (multi-flag)", async () => {
    const id = await addTask(atmuxDir, {
      subject: "x",
      body: "preserve me",
      deps: ["t-keep0001"],
    });
    await captureStdout(() =>
      task(["update", id, "--owner", "alpha", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.owner).toBe("alpha");
    expect(after?.body).toBe("preserve me");
    expect(after?.deps).toEqual(["t-keep0001"]);
  });

  test("'update' --owner '' aliases --unassign (parking-lot pattern)", async () => {
    const id = await addTask(atmuxDir, { subject: "x", assignee: "alpha" });
    await captureStdout(() =>
      task(["update", id, "--owner", "", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.owner).toBeNull();
  });

  test("'update' with only --owner is valid (no body/deps required)", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exit } = await captureStdout(() =>
      task(["update", id, "--owner", "alpha", "--team-dir", teamDir]),
    );
    expect(exit).toBe(0);
  });

  test("'update' --owner without value → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    // --owner as last arg → parser sees rest[i+1]=undefined and refuses
    // before getAtmuxDir runs. Ordered so --team-dir comes first.
    await expect(
      task(["update", id, "--team-dir", teamDir, "--owner"]),
    ).rejects.toThrow(UsageError);
  });

  // ---------- ADR-193: task add/update --epic / --story / --deliverable ----------

  test("ADR-193: 'add --epic --story --deliverable' persists all three", async () => {
    await captureStdout(() =>
      task([
        "add",
        "--team-dir",
        teamDir,
        "--epic",
        "e-3b017960",
        "--story",
        "s-c4e91c33",
        "--deliverable",
        "docs/adr/171-x.md",
        "decomp child T1",
      ]),
    );
    const k = await loadKanban(atmuxDir);
    const t = k.tasks[0];
    expect(t?.epic).toBe("e-3b017960");
    expect(t?.story).toBe("s-c4e91c33");
    expect(t?.deliverable).toBe("docs/adr/171-x.md");
  });

  test("ADR-193: 'add' without epic/story leaves fields absent (no forced null)", async () => {
    await captureStdout(() => task(["add", "--team-dir", teamDir, "plain"]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.epic).toBeUndefined();
    expect(k.tasks[0]?.story).toBeUndefined();
  });

  test("ADR-193: 'add --epic <malformed>' → UsageError (shape gate)", async () => {
    await expect(
      task(["add", "--team-dir", teamDir, "--epic", "garbage", "subj"]),
    ).rejects.toThrow(UsageError);
  });

  test("ADR-193: 'update --epic' re-parents an existing task", async () => {
    const id = await addTask(atmuxDir, { subject: "orphan" });
    await captureStdout(() =>
      task(["update", id, "--epic", "e-4976c457", "--team-dir", teamDir]),
    );
    expect((await showTask(atmuxDir, id))?.epic).toBe("e-4976c457");
  });

  test("ADR-193: 'update --epic ''' clears the link (null)", async () => {
    const id = await addTask(atmuxDir, { subject: "parented", epic: "e-4976c457" });
    expect((await showTask(atmuxDir, id))?.epic).toBe("e-4976c457");
    await captureStdout(() => task(["update", id, "--epic", "", "--team-dir", teamDir]));
    expect((await showTask(atmuxDir, id))?.epic).toBeNull();
  });

  test("ADR-193: 'update --story ''' and '--deliverable ''' clear", async () => {
    const id = await addTask(atmuxDir, {
      subject: "x",
      story: "s-c4e91c33",
      deliverable: "old",
    });
    await captureStdout(() =>
      task(["update", id, "--story", "", "--deliverable", "", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.story).toBeNull();
    expect(after?.deliverable).toBeNull();
  });

  test("ADR-193: 'update --epic <malformed>' → UsageError (no mutation)", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(
      task(["update", id, "--epic", "bad", "--team-dir", teamDir]),
    ).rejects.toThrow(UsageError);
  });

  test("ADR-193: 'update' with only --epic is valid (counts toward the gate)", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exit } = await captureStdout(() =>
      task(["update", id, "--epic", "e-00000001", "--team-dir", teamDir]),
    );
    expect(exit).toBe(0);
  });

  test("ADR-193: 'update --epic' doesn't clobber body (multi-field isolation)", async () => {
    const id = await addTask(atmuxDir, { subject: "x", body: "keep me" });
    await captureStdout(() =>
      task(["update", id, "--epic", "e-12345678", "--team-dir", teamDir]),
    );
    const after = await showTask(atmuxDir, id);
    expect(after?.epic).toBe("e-12345678");
    expect(after?.body).toBe("keep me");
  });

  test("ADR-193: 'update --epic/--story/--deliverable' without value → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    // Flag last → parser sees rest[i+1]=undefined; --team-dir comes first.
    await expect(task(["update", id, "--team-dir", teamDir, "--epic"])).rejects.toThrow(UsageError);
    await expect(task(["update", id, "--team-dir", teamDir, "--story"])).rejects.toThrow(
      UsageError,
    );
    await expect(task(["update", id, "--team-dir", teamDir, "--deliverable"])).rejects.toThrow(
      UsageError,
    );
  });

  test("ADR-193: 'update --deliverable <over 256>' → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(
      task(["update", id, "--deliverable", "x".repeat(257), "--team-dir", teamDir]),
    ).rejects.toThrow(UsageError);
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

// ---------- ADR t-cea78f99: --lane member-name aliases ----------

describe("task --lane member-name aliases (t-cea78f99)", () => {
  test("`task add --lane gitter` resolves to lane=git", async () => {
    const { out } = await captureStdout(() =>
      task(["add", "test-gitter-alias", "--lane", "gitter", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const k = await loadKanban(atmuxDir);
    const created = k.tasks.find((t) => t.id === id);
    expect(created?.lane).toBe("git");
  });

  test("`task lane <id> planner` resolves to lane=docs", async () => {
    const id = await addTask(atmuxDir, { subject: "lane-alias-target" });
    await captureStdout(() => task(["lane", id, "planner", "--team-dir", teamDir]));
    const k = await loadKanban(atmuxDir);
    const t = k.tasks.find((tt) => tt.id === id);
    expect(t?.lane).toBe("docs");
  });

  test("`task add --lane reviewer` resolves to lane=review", async () => {
    const { out } = await captureStdout(() =>
      task(["add", "reviewer-alias", "--lane", "reviewer", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === id)?.lane).toBe("review");
  });

  test("`task add --lane dba` resolves to lane=db", async () => {
    const { out } = await captureStdout(() =>
      task(["add", "dba-alias", "--lane", "dba", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === id)?.lane).toBe("db");
  });

  test("`task add --lane devops` resolves to lane=ops", async () => {
    const { out } = await captureStdout(() =>
      task(["add", "devops-alias", "--lane", "devops", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === id)?.lane).toBe("ops");
  });

  test("unknown lane STILL rejects (no alias match falls through)", async () => {
    await expect(
      captureStdout(() => task(["add", "bogus-lane", "--lane", "frontend", "--team-dir", teamDir])),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("canonical lanes pass through unchanged", async () => {
    const { out } = await captureStdout(() =>
      task(["add", "canonical-be", "--lane", "be", "--team-dir", teamDir]),
    );
    const id = out.trim();
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === id)?.lane).toBe("be");
  });

  test("resolveLaneAlias pure function: every known alias", () => {
    expect(resolveLaneAlias("gitter")).toBe("git");
    expect(resolveLaneAlias("planner")).toBe("docs");
    expect(resolveLaneAlias("reviewer")).toBe("review");
    expect(resolveLaneAlias("dba")).toBe("db");
    expect(resolveLaneAlias("devops")).toBe("ops");
  });

  test("resolveLaneAlias pure function: unknown input passes through", () => {
    expect(resolveLaneAlias("be")).toBe("be");
    expect(resolveLaneAlias("frontend")).toBe("frontend");
    expect(resolveLaneAlias("")).toBe("");
    expect(resolveLaneAlias("-")).toBe("-");
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
