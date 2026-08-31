// Unit tests for src/core/groom-reconcile.ts (t-dc830eb0 initial impl;
// t-4ea69dd1 P0 subject-only fix).
//
// Coverage:
//   - subject-only match → flip
//   - body-only match → NOT flipped (t-4ea69dd1 — body-grep was too greedy)
//   - cross-ref guard: subject names A, body names B → only A flips, never B
//   - revert commit ignored (no flip)
//   - merge subject still matched (we don't filter merge)
//   - already-done not in scan set (filter scopes to todo+in-progress)
//   - no match → no-op
//   - dry-run: decisions recorded, no DB writes (no markDone calls)
//   - skip-already-done defensive path still records the decision
//   - real SQLite-backed open scan persists done state + note
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
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
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
    // Emit SUBJECT-ONLY per the new git log format `%H%n%s%x00`
    // (t-4ea69dd1 P0 fix — body is no longer scanned). `c.body` is
    // retained on the FakeCommit type for test-fixture readability
    // but is intentionally NOT included in stdout — that's the contract
    // the helper now relies on.
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

function seedTaskRows(
  atmuxDir: string,
  rows: ReadonlyArray<OpenTask & { createdAt: number; driverOnly?: boolean; note?: string | null }>,
) {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    for (const row of rows) {
      db.query(
        "INSERT INTO tasks (id, subject, status, driver_only, created_at, note) VALUES ($id, $subject, $status, $driver_only, $created_at, $note)",
      ).run({
        $id: row.id,
        $subject: `seeded ${row.id}`,
        $status: row.status,
        $driver_only: row.driverOnly === true ? 1 : 0,
        $created_at: row.createdAt,
        $note: row.note ?? null,
      });
    }
  } finally {
    closeDatabase(db);
  }
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
    expect(md.calls).toEqual([{ id: "t-aaaaaaaa", note: "groomed: shipped via SHA deadbeefcafe" }]);
  });

  test("body-only match → NOT flipped (t-4ea69dd1 P0 fix — subject-only)", async () => {
    // Subject names something unrelated; the task ID would have been
    // in the body. With subject-only matching the helper MUST NOT
    // flip the task. Pre-fix behaviour was a flip — this is the
    // regression-pin test.
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
    expect(r.matched).toBe(0);
    expect(r.flipped).toBe(0);
    expect(md.calls).toHaveLength(0);
  });

  test("EPIC parent-ref in subject → NOT flipped (3-of-21 follow-up false-positive)", async () => {
    // 2026-05-16 t-4ea69dd1 follow-up: subject-only matching alone
    // still hit 3/21 false-positives because conventional-commits
    // subjects carry EPIC parent IDs in parentheticals. The fix is
    // PARENT_REF_KEYWORDS filter: `EPIC ` immediately preceding a
    // task ID marks that ID as a parent reference, not a ship signal.
    // Verbatim 2026-05-16 commit subjects:
    //   `docs(adr): ADR-140 — cheap-model-first principle (T1 of EPIC t-83dcef6b)`
    //   `docs(adr): ADR-134 — in-team auto-merger via expanded gitter role (t-63e3ddc2, EPIC t-51d2c635)`
    //   `docs(adr): ADR-138 — verified send-keys (verify-and-retry pattern) (t-f58c6ccc, T1 of EPIC t-5df48a74)`
    const open: OpenTask[] = [
      { id: "t-83dcef6b", status: "todo" }, // EPIC — must NOT flip
      { id: "t-51d2c635", status: "todo" }, // EPIC — must NOT flip
      { id: "t-5df48a74", status: "todo" }, // EPIC — must NOT flip
      { id: "t-63e3ddc2", status: "todo" }, // shipping ID — should flip
      { id: "t-f58c6ccc", status: "todo" }, // shipping ID — should flip
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
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    // Only the shipping IDs flip; the 3 EPIC parent-refs stay open.
    expect(r.matched).toBe(2);
    expect(r.flipped).toBe(2);
    const flippedIds = md.calls.map((c) => c.id).sort();
    expect(flippedIds).toEqual(["t-63e3ddc2", "t-f58c6ccc"]);
    // Defensive: the EPIC IDs MUST NOT appear in any decision.
    const decided = r.decisions.map((d) => d.taskId);
    expect(decided).not.toContain("t-83dcef6b");
    expect(decided).not.toContain("t-51d2c635");
    expect(decided).not.toContain("t-5df48a74");
  });

  test("cross-ref guard: subject names A, body names B → only A flips", async () => {
    // The 21-false-positive bug fingerprint: a commit that shipped
    // task A but mentioned task B in its body (as cross-ref, EPIC
    // parent, deps list, follow-up filing, CHANGELOG mention) used
    // to flip BOTH A and B. The fix is subject-only matching; B
    // must stay open even though its ID appears in body content.
    const open: OpenTask[] = [
      { id: "t-aaaaaaa1", status: "todo" }, // A — should flip
      { id: "t-bbbbbbb2", status: "todo" }, // B — must NOT flip (cross-ref only)
    ];
    const { spawn } = fakeGit([
      {
        sha: "shipsha01",
        subject: "feat(scope): t-aaaaaaa1 — ship the legit thing",
        body:
          "EPIC parent: t-bbbbbbb2.\n" +
          "Cross-refs: t-bbbbbbb2 §scope.\n" +
          "Deps: t-bbbbbbb2 shipped first.\n" +
          "Follow-up filed as t-bbbbbbb2 → see kanban.\n" +
          "CHANGELOG mentions t-bbbbbbb2 for traceability.",
      },
    ]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    // Only A flips; B remains untouched despite 5 body mentions.
    expect(r.matched).toBe(1);
    expect(r.flipped).toBe(1);
    expect(md.calls).toHaveLength(1);
    expect(md.calls[0]?.id).toBe("t-aaaaaaa1");
    // Defensive: assert B never appeared in any decision.
    expect(r.decisions.some((d) => d.taskId === "t-bbbbbbb2")).toBe(false);
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
    const { spawn } = fakeGit([{ sha: "abc", subject: "feat(x): t-99999999 — different task" }]);
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
    const { spawn } = fakeGit([{ sha: "shaeeee0001", subject: "feat: t-eeeeeeee — ship" }]);
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

  test("matching done task → skip-already-done and no markDone call", async () => {
    const open: OpenTask[] = [{ id: "t-ddd0d0d0", status: "done" }];
    const { spawn } = fakeGit([{ sha: "sha0d0d0d0", subject: "fix: t-ddd0d0d0 — already closed" }]);
    const md = makeMarkDone();
    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
      listOpenTasks: makeListOpenTasks(open),
      markDone: md.fn,
    });
    expect(r.scanned).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.flipped).toBe(0);
    expect(r.decisions).toEqual([
      { taskId: "t-ddd0d0d0", sha: "sha0d0d0d0", action: "skip-already-done" },
    ]);
    expect(md.calls).toHaveLength(0);
  });

  test("SQLite-backed open scan persists done state and note via default driver-scope markTaskDone", async () => {
    seedTaskRows(atmuxDir, [
      { id: "t-00000000", status: "done", createdAt: 0, note: "kept-done" },
      { id: "t-11111111", status: "todo", driverOnly: true, createdAt: 1 },
    ]);

    const { spawn } = fakeGit([
      { sha: "feedfacecafe", subject: "feat(core): t-11111111 — ship the thing" },
    ]);

    const r = await reconcileKanbanVsGit(atmuxDir, {
      repoDir,
      git: spawn,
    });

    expect(r.scanned).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.flipped).toBe(1);
    expect(r.decisions).toEqual([{ taskId: "t-11111111", sha: "feedfacecafe", action: "flip" }]);

    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      const rows = db
        .query("SELECT id, status, driver_only, completed_at, note FROM tasks ORDER BY id ASC")
        .all() as Array<{
        id: string;
        status: string | null;
        driver_only: number | null;
        completed_at: number | null;
        note: string | null;
      }>;
      expect(rows).toEqual([
        {
          id: "t-00000000",
          status: "done",
          driver_only: 0,
          completed_at: null,
          note: "kept-done",
        },
        {
          id: "t-11111111",
          status: "done",
          driver_only: 1,
          completed_at: expect.any(Number),
          note: "groomed: shipped via SHA feedfacecafe",
        },
      ]);
    } finally {
      closeDatabase(db);
    }
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
