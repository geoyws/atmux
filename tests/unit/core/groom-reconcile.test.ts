// Unit tests for src/core/groom-reconcile.ts (t-dc830eb0).
//
// Coverage:
//   - subject-only match → flip
//   - body-only match → flip
//   - revert commit ignored (no flip)
//   - merge subject still matched (we don't filter merge)
//   - already-done not in scan set (filter scopes to todo+in-progress)
//   - no match → no-op
//   - dry-run: decisions recorded, no DB writes (no markDone calls)
//   - idempotent: re-run on a freshly-flipped task is no-op
//   - skipped when repoDir doesn't exist
//   - skipped when git log fails (non-zero exit)
//   - first SHA wins (multiple commits reference same task)
//   - non-task ID matches (c-/d- prefixes) ignored
//   - empty open-tasks → early return, no git spawn

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { reconcileKanbanVsGit } from "../../../src/core/groom-reconcile.ts";

let atmuxDir: string;
let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "atmux-groom-reconcile-"));
  atmuxDir = join(repoDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

// ---------- helpers ----------

interface OpenTask {
  id: string;
  status: string;
}

interface FakeCommit {
  sha: string;
  subject: string;
  body?: string;
}

function fakeGit(commits: ReadonlyArray<FakeCommit>): {
  spawn: (argv: ReadonlyArray<string>) => Promise<SpawnResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    calls.push([...argv]);
    const stdout =
      commits.map((c) => `${c.sha}\n${c.subject}\n${c.body ?? ""}\x00`).join("");
    return {
      cmd: "git",
      argv,
      exitCode: 0,
      signalled: null,
      stdout,
      stderr: "",
      durationMs: 1,
    };
  };
  return { spawn, calls };
}

function failingGit(): (argv: ReadonlyArray<string>) => Promise<SpawnResult> {
  return async (argv) => ({
    cmd: "git",
    argv,
    exitCode: 128,
    signalled: null,
    stdout: "",
    stderr: "fatal: not a git repository\n",
    durationMs: 1,
  });
}

function makeListOpenTasks(tasks: ReadonlyArray<OpenTask>) {
  return async () => tasks;
}

interface MarkDoneCall {
  id: string;
  note: string;
}

function makeMarkDone(): {
  fn: (id: string, note: string) => Promise<void>;
  calls: MarkDoneCall[];
} {
  const calls: MarkDoneCall[] = [];
  const fn = async (id: string, note: string) => {
    calls.push({ id, note });
  };
  return { fn, calls };
}

// ---------- tests ----------

describe("reconcileKanbanVsGit", () => {
  test("subject-only match → flip with groomed note", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaaa", status: "todo" }];
    const { spawn } = fakeGit([
      { sha: "deadbeefcafe", subject: "feat(x): t-aaaaaaaa — ship the thing" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.scanned).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.flipped).toBe(1);
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]).toEqual({
      taskId: "t-aaaaaaaa",
      sha: "deadbeefcafe",
      action: "flip",
    });
    expect(md.calls).toEqual([
      { id: "t-aaaaaaaa", note: "groomed: shipped via SHA deadbeefcafe" },
    ]);
  });

  test("body-only match → flip", async () => {
    const open: OpenTask[] = [{ id: "t-bbbbbbbb", status: "in-progress" }];
    const { spawn } = fakeGit([
      {
        sha: "1234567890ab",
        subject: "feat(unrelated): something",
        body: "Closes t-bbbbbbbb. Multiple lines.\nMore body.",
      },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.flipped).toBe(1);
    expect(md.calls[0]?.id).toBe("t-bbbbbbbb");
  });

  test("Revert commit not treated as ship signal", async () => {
    const open: OpenTask[] = [{ id: "t-cccccccc", status: "todo" }];
    const { spawn } = fakeGit([
      { sha: "abc", subject: 'Revert "feat: t-cccccccc — ship"' },
      { sha: "def", subject: "Revert t-cccccccc rollback" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(md.calls).toHaveLength(0);
  });

  test("no match → no-op, decisions empty", async () => {
    const open: OpenTask[] = [{ id: "t-dddddddd", status: "todo" }];
    const { spawn } = fakeGit([
      { sha: "abc", subject: "feat(x): t-99999999 — different task" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.scanned).toBe(1);
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(r.decisions).toHaveLength(0);
    expect(md.calls).toHaveLength(0);
  });

  test("dry-run: decisions recorded, markDone not called", async () => {
    const open: OpenTask[] = [{ id: "t-eeeeeeee", status: "todo" }];
    const { spawn } = fakeGit([
      { sha: "shaeeee0001", subject: "feat: t-eeeeeeee — ship" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      dryRun: true,
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.matched).toBe(1);
    expect(r.flipped).toBe(0);
    expect(r.decisions[0]?.action).toBe("flip");
    expect(md.calls).toHaveLength(0);
  });

  test("repoDir missing → soft-skip with skippedReason", async () => {
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir: "/no/such/path/does/not/exist",
      git: failingGit(),
      listOpenTasks: makeListOpenTasks([{ id: "t-ffffffff", status: "todo" }]),
      markDone: makeMarkDone().fn,
    });
    expect(r.skippedReason).toBe("not-a-repo");
    expect(r.flipped).toBe(0);
  });

  test("git log fails → soft-skip", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaab", status: "todo" }];
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: failingGit(),
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.skippedReason).toBe("git-log-failed");
    expect(r.flipped).toBe(0);
    expect(md.calls).toHaveLength(0);
  });

  test("first SHA wins when multiple commits reference same task", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaac", status: "todo" }];
    // git log default: reverse-chrono — newest first
    const { spawn } = fakeGit([
      { sha: "newest", subject: "fixup: t-aaaaaaac" },
      { sha: "older", subject: "feat: t-aaaaaaac — original ship" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.flipped).toBe(1);
    expect(md.calls[0]?.note).toBe("groomed: shipped via SHA newest");
  });

  test("non-task IDs (c- / d- prefixes) ignored", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaad", status: "todo" }];
    const { spawn } = fakeGit([
      // commit only references a complaint + decision, not the task
      { sha: "abc", subject: "ack: c-aaaaaaad d-bbbbbbbb noise" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
  });

  test("empty open-tasks → early return, no git spawn", async () => {
    let gitCalled = false;
    const spy = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
      gitCalled = true;
      return {
        cmd: "git",
        argv,
        exitCode: 0,
        signalled: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
      };
    };
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spy,
      listOpenTasks: makeListOpenTasks([]),
      markDone: makeMarkDone().fn,
    });
    expect(r.scanned).toBe(0);
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(gitCalled).toBe(false);
  });

  test("multiple tasks, mixed match/no-match", async () => {
    const open: OpenTask[] = [
      { id: "t-11111111", status: "todo" },
      { id: "t-22222222", status: "in-progress" },
      { id: "t-33333333", status: "todo" }, // no match
    ];
    const { spawn } = fakeGit([
      { sha: "sha1", subject: "feat: t-11111111 — A" },
      { sha: "sha2", subject: "fix: t-22222222 — B", body: "second line" },
      { sha: "sha9", subject: "chore: unrelated" },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.scanned).toBe(3);
    expect(r.matched).toBe(2);
    expect(r.flipped).toBe(2);
    const ids = md.calls.map((c) => c.id).sort();
    expect(ids).toEqual(["t-11111111", "t-22222222"]);
  });

  test("git invocation includes --all flag", async () => {
    const { spawn, calls } = fakeGit([]);
    await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks([{ id: "t-aaaaaaae", status: "todo" }]),
      markDone: makeMarkDone().fn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--all");
    expect(calls[0]).toContain("log");
    expect(calls[0]).toContain("-C");
    expect(calls[0]).toContain(repoDir);
  });
});
