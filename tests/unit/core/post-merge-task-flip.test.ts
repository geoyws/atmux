// Unit tests for src/core/post-merge-task-flip.ts (t-f8beb03b — Part b
// of the kanban-vs-git two-part fix; sibling to Part a's
// src/core/groom-reconcile.ts).
//
// Coverage mirrors groom-reconcile.test.ts (the helpers share a
// convention contract — subject-only matching + PARENT_REF_KEYWORDS
// filter; tests pin the same fingerprints):
//   - subject-only match → flip with merge-SHA note
//   - body-only match → NOT flipped (per t-4ea69dd1 — body-grep was too greedy)
//   - cross-ref guard: subject A + body B → only A flips
//   - EPIC parent-ref in subject → NOT flipped (3-of-21 false-positive fingerprint)
//   - Revert commit ignored
//   - no-range soft-skip (fromSha null)
//   - empty-stdout soft-no-op
//   - git log failure soft-skip
//   - skip-not-open when task isn't in the open set
//   - dry-run reports decisions without markDone calls
//   - first SHA wins when multiple commits in the range ref the same task
//   - git invocation uses `<from>..<to>` range form

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { flipTasksMergedInRange } from "../../../src/core/post-merge-task-flip.ts";

let atmuxDir: string;
let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "atmux-post-merge-flip-"));
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
  /** Retained for fixture readability; NOT emitted to stdout (helper
   *  is subject-only per t-4ea69dd1 P0 fix). */
  body?: string;
}

function fakeGit(commits: ReadonlyArray<FakeCommit>): {
  spawn: (argv: ReadonlyArray<string>) => Promise<SpawnResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawn = async (argv: ReadonlyArray<string>): Promise<SpawnResult> => {
    calls.push([...argv]);
    // Subject-only per the new git log format `%H%n%s%x00`.
    const stdout = commits.map((c) => `${c.sha}\n${c.subject}\x00`).join("");
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
    stderr: "fatal: bad revision\n",
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

describe("flipTasksMergedInRange", () => {
  test("subject-only match in range → flip with merge-SHA note", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaaa", status: "todo" }];
    const { spawn } = fakeGit([
      { sha: "deadbeefcafe", subject: "feat(x): t-aaaaaaaa — ship the thing" },
    ]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "olbsha000000", "newsha000000", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.commitsScanned).toBe(1);
    expect(r.openTasks).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.flipped).toBe(1);
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]).toEqual({
      taskId: "t-aaaaaaaa",
      sha: "deadbeefcafe",
      action: "flip",
    });
    expect(md.calls).toEqual([
      { id: "t-aaaaaaaa", note: "flipped: shipped via merge SHA deadbeefcafe" },
    ]);
  });

  test("body-only match → NOT flipped (t-4ea69dd1 P0 mirror)", async () => {
    const open: OpenTask[] = [{ id: "t-bbbbbbbb", status: "in-progress" }];
    const { spawn } = fakeGit([
      {
        sha: "1234567890ab",
        subject: "feat(unrelated): something",
        body: "Closes t-bbbbbbbb. Cross-ref scaffolding.",
      },
    ]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(md.calls).toHaveLength(0);
  });

  test("cross-ref guard: subject A + body B → only A flips", async () => {
    const open: OpenTask[] = [
      { id: "t-aaaaaaa1", status: "todo" }, // A
      { id: "t-bbbbbbb2", status: "todo" }, // B (body only)
    ];
    const { spawn } = fakeGit([
      {
        sha: "shipsha01",
        subject: "feat(scope): t-aaaaaaa1 — ship the legit thing",
        body: "EPIC parent: t-bbbbbbb2.\nDeps: t-bbbbbbb2.\nFollow-up filed as t-bbbbbbb2.",
      },
    ]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.flipped).toBe(1);
    expect(md.calls).toEqual([
      { id: "t-aaaaaaa1", note: "flipped: shipped via merge SHA shipsha01" },
    ]);
  });

  test("EPIC parent-ref in subject → NOT flipped (3-of-21 fingerprint mirror)", async () => {
    const open: OpenTask[] = [
      { id: "t-83dcef6b", status: "todo" }, // EPIC
      { id: "t-51d2c635", status: "todo" }, // EPIC
      { id: "t-5df48a74", status: "todo" }, // EPIC
      { id: "t-63e3ddc2", status: "todo" }, // shipping
      { id: "t-f58c6ccc", status: "todo" }, // shipping
    ];
    const { spawn } = fakeGit([
      {
        sha: "sha140",
        subject: "docs(adr): ADR-140 — cheap-model-first principle (T1 of EPIC t-83dcef6b)",
      },
      {
        sha: "sha134",
        subject:
          "docs(adr): ADR-134 — in-team auto-merger via expanded gitter role (t-63e3ddc2, EPIC t-51d2c635)",
      },
      {
        sha: "sha138",
        subject:
          "docs(adr): ADR-138 — verified send-keys (verify-and-retry pattern) (t-f58c6ccc, T1 of EPIC t-5df48a74)",
      },
    ]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.matched).toBe(2);
    expect(r.flipped).toBe(2);
    const flipped = md.calls.map((c) => c.id).sort();
    expect(flipped).toEqual(["t-63e3ddc2", "t-f58c6ccc"]);
    const decidedIds = r.decisions.filter((d) => d.action === "flip").map((d) => d.taskId);
    expect(decidedIds).not.toContain("t-83dcef6b");
    expect(decidedIds).not.toContain("t-51d2c635");
    expect(decidedIds).not.toContain("t-5df48a74");
  });

  test("Revert commit not treated as ship signal", async () => {
    const open: OpenTask[] = [{ id: "t-cccccccc", status: "todo" }];
    const { spawn } = fakeGit([
      { sha: "abc", subject: 'Revert "feat: t-cccccccc — ship"' },
      { sha: "def", subject: "Revert t-cccccccc rollback" },
    ]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(md.calls).toHaveLength(0);
  });

  test("no-range soft-skip when fromSha is null (first-ever merge)", async () => {
    const { spawn, calls } = fakeGit([]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, null, "newsha", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks([{ id: "t-dddddddd", status: "todo" }]),
      markDone: md.fn,
    });
    expect(r.skippedReason).toBe("no-range");
    expect(r.flipped).toBe(0);
    expect(calls).toHaveLength(0); // git not invoked on soft-skip
  });

  test("no-range soft-skip when fromSha is empty string", async () => {
    const r = await flipTasksMergedInRange(atmuxDir, "", "newsha", {
      repoDir,
      git: failingGit(),
      listOpenTasks: makeListOpenTasks([{ id: "t-eeeeeeee", status: "todo" }]),
      markDone: makeMarkDone().fn,
    });
    expect(r.skippedReason).toBe("no-range");
  });

  test("git log fails → soft-skip with reason", async () => {
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: failingGit(),
      listOpenTasks: makeListOpenTasks([{ id: "t-ffffffff", status: "todo" }]),
      markDone: md.fn,
    });
    expect(r.skippedReason).toBe("git-log-failed");
    expect(r.flipped).toBe(0);
    expect(md.calls).toHaveLength(0);
  });

  test("skip-not-open when task isn't in open set (already done)", async () => {
    const open: OpenTask[] = []; // no open tasks
    const { spawn } = fakeGit([{ sha: "shasha01", subject: "feat: t-aaaaaaa9 — ship" }]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.commitsScanned).toBe(1);
    expect(r.openTasks).toBe(0);
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(r.decisions[0]?.action).toBe("skip-not-open");
    expect(md.calls).toHaveLength(0);
  });

  test("dry-run: decisions recorded, markDone NOT called", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaa8", status: "todo" }];
    const { spawn } = fakeGit([{ sha: "shadry001", subject: "feat: t-aaaaaaa8 — ship" }]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
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

  test("first SHA wins when multiple commits in range ref the same task", async () => {
    const open: OpenTask[] = [{ id: "t-aaaaaaa7", status: "todo" }];
    const { spawn } = fakeGit([
      // git log default order = reverse-chrono; newest first.
      { sha: "newest", subject: "fixup: t-aaaaaaa7 cleanup" },
      { sha: "older", subject: "feat: t-aaaaaaa7 — original" },
    ]);
    const md = makeMarkDone();
    const r = await flipTasksMergedInRange(atmuxDir, "old", "new", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.flipped).toBe(1);
    expect(md.calls[0]?.note).toBe("flipped: shipped via merge SHA newest");
  });

  test("git invocation uses `<from>..<to>` range form", async () => {
    const { spawn, calls } = fakeGit([]);
    await flipTasksMergedInRange(atmuxDir, "abc", "def", {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks([{ id: "t-aaaaaaa6", status: "todo" }]),
      markDone: makeMarkDone().fn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("abc..def");
    expect(calls[0]).toContain("log");
    expect(calls[0]).toContain("-C");
    expect(calls[0]).toContain(repoDir);
    // Sanity: NEW format is %H%n%s%x00 (no body) per t-4ea69dd1.
    expect(calls[0]).toContain("--format=%H%n%s%x00");
  });
});
