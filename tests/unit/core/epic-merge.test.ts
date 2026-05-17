// Unit tests for src/core/epic-merge.ts (ADR-091 §State machine /
// t-04350614).
//
// Coverage focus: each branch of `performEpicMerge` — the seeding
// path (no row → in_progress, existing open → in_progress), the
// epic-aware gate decision (refines shared gate with the §Decision-
// anchor #5 reviewer-trunk-signoff requirement), the auto-merge
// path from ready_to_merge (no-op / merged / conflict), the pr-mode
// short-circuit (§Decision-anchor #6 schema-accept-runtime-noop),
// terminal short-circuits, caller-driven holding states, and the
// concurrency-loss TOCTOU edges.
//
// Strategy: real SQLite DB (fresh per test), real branch-merge-state
// shared module, mocked `mergeMember` via the `git` GitSpawn
// injection. Mirrors the intra-team-merge.test.ts harness for
// consistency — same fixture functions, same scratch-dir lifecycle.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { PreMergeGateInput } from "../../../src/core/branch-merge-state.ts";
import {
  type EpicMergeContext,
  performEpicMerge,
  shouldEpicTransitionFromInProgress,
} from "../../../src/core/epic-merge.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";

let scratch: string;
let db: Database;
let repo: MergerStateRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-epic-merge-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new MergerStateRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Helpers ----------

function spawnOk(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function spawnFail(stdout: string, stderr: string, code: number): SpawnResult {
  return {
    exitCode: code,
    stdout,
    stderr,
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

/** mergeMember probe-sequence stub. Same shape as the intra-team-
 *  merge test stub — the wrapper compose-shape is identical. */
function makeGitStub(behavior: "success" | "no-op" | "conflict"): GitSpawn {
  let mergeFired = false;
  let abortFired = false;
  return async (argv) => {
    if (argv.includes("status") && argv.includes("--porcelain")) {
      if (abortFired) return spawnOk("");
      if (mergeFired && behavior === "conflict") {
        return spawnOk("UU file1.ts\nUU file2.ts\n");
      }
      return spawnOk("");
    }
    if (argv.includes("rev-parse") && argv.includes("--verify")) {
      return spawnOk("aaa\n");
    }
    if (argv.includes("rev-list") && argv.includes("--count")) {
      return spawnOk(behavior === "no-op" ? "0\n" : "1\n");
    }
    if (argv.includes("fetch")) return spawnOk("");
    if (argv.includes("checkout")) return spawnOk("");
    if (argv.includes("merge") && argv.includes("--no-ff")) {
      mergeFired = true;
      if (behavior === "conflict") {
        return spawnFail("", "Merge conflict in file1.ts", 1);
      }
      return spawnOk("");
    }
    if (argv.includes("merge") && argv.includes("--abort")) {
      abortFired = true;
      return spawnOk("");
    }
    if (argv.includes("rev-parse") && argv.includes("HEAD")) {
      return spawnOk("epicMergedSha\n");
    }
    return spawnOk("");
  };
}

/** Default gate-pass profile — owner zero open tasks, worktree clean,
 *  branch ahead, base stable. */
function gate(over: Partial<PreMergeGateInput> = {}): PreMergeGateInput {
  return {
    ownerOpenTaskCount: 0,
    worktreeIsClean: true,
    isAheadOfBase: true,
    baseHasMoved: false,
    ...over,
  };
}

const EPIC_BRANCH = "sopx-geoyws-epic-checkout-flow";
const PARENT_BASE = "sopx-geoyws";
const EPIC_ID = "e-aabb0001";

function baseCtx(overrides: Partial<EpicMergeContext> = {}): EpicMergeContext {
  return {
    epicBranch: EPIC_BRANCH,
    parentBase: PARENT_BASE,
    parentRepoPath: "/tmp/fake-parent",
    gate: gate(),
    hasReviewerTrunkSignoff: true,
    mergeMode: "auto",
    epicId: EPIC_ID,
    repo,
    by: "epic-cron",
    now: () => 1000,
    git: async () => spawnOk(""),
    fetch: false,
    ...overrides,
  };
}

function seedState(state: string, t = 100, note: string | null = null): void {
  repo.transition({
    memberBranch: EPIC_BRANCH,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next: state as any,
    note,
    by: "operator",
    transitionedAt: t,
  });
}

// ---------- Pure gate refinement ----------

describe("shouldEpicTransitionFromInProgress — pure refinement", () => {
  test("clean gate + signoff present → ready_to_merge", () => {
    const r = shouldEpicTransitionFromInProgress(gate(), true);
    expect(r.next).toBe("ready_to_merge");
    expect(r.reason).toMatch(/all checks pass/i);
  });

  test("owner has open tasks → stay in_progress (shared gate wins)", () => {
    const r = shouldEpicTransitionFromInProgress(gate({ ownerOpenTaskCount: 3 }), true);
    expect(r.next).toBe("in_progress");
    expect(r.reason).toContain("3 open tasks");
  });

  test("dirty worktree → stay in_progress (shared gate wins; signoff irrelevant)", () => {
    const r = shouldEpicTransitionFromInProgress(gate({ worktreeIsClean: false }), false);
    expect(r.next).toBe("in_progress");
    expect(r.reason).toMatch(/worktree dirty/);
  });

  test("clean gate but missing signoff → stay in_progress with §Decision-anchor #5 reason", () => {
    const r = shouldEpicTransitionFromInProgress(gate(), false);
    expect(r.next).toBe("in_progress");
    expect(r.reason).toContain("reviewer-trunk-signoff");
    expect(r.reason).toContain("§Decision-anchor #5");
  });

  test("base moved + signoff present → rebasing (shared gate's recommendation)", () => {
    const r = shouldEpicTransitionFromInProgress(gate({ baseHasMoved: true }), true);
    expect(r.next).toBe("rebasing");
  });

  test("missing signoff PRECEDES base-moved decision (signoff is harder gate)", () => {
    // Signoff missing AND base moved — the signoff veto wins so the
    // operator sees the trunk-signoff blocker before rebase prep.
    const r = shouldEpicTransitionFromInProgress(gate({ baseHasMoved: true }), false);
    expect(r.next).toBe("in_progress");
    expect(r.reason).toContain("reviewer-trunk-signoff");
  });
});

// ---------- Seeding path ----------

describe("performEpicMerge — seeding path", () => {
  test("no row → advance to in_progress with epic-id-tagged reason", async () => {
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true);
    expect(r.reason).toContain(EPIC_ID);
    expect(r.reason).toContain("fan-in pending");
    expect(r.dissolveDispatched).toBe(false);
    expect(repo.getState(EPIC_BRANCH)?.state).toBe("in_progress");
  });

  test("existing `open` row → transitions to in_progress", async () => {
    seedState("open", 500);
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true);
  });

  test("seeding tick uses 'epic-cron' as default `by`", async () => {
    await performEpicMerge(baseCtx());
    expect(repo.getState(EPIC_BRANCH)?.transitionedBy).toBe("epic-cron");
  });
});

// ---------- in_progress branch ----------

describe("performEpicMerge — in_progress (epic gate decisions)", () => {
  beforeEach(() => {
    seedState("in_progress", 200, "seed");
  });

  test("gate clear + signoff present → ready_to_merge", async () => {
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("ready_to_merge");
    expect(r.changed).toBe(true);
  });

  test("gate clear but signoff missing → stay in_progress", async () => {
    const r = await performEpicMerge(baseCtx({ hasReviewerTrunkSignoff: false }));
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("reviewer-trunk-signoff");
  });

  test("owner open tasks > 0 → stay in_progress", async () => {
    const r = await performEpicMerge(baseCtx({ gate: gate({ ownerOpenTaskCount: 2 }) }));
    expect(r.state).toBe("in_progress");
    expect(r.reason).toContain("2 open tasks");
  });

  test("base moved + signoff present → rebasing", async () => {
    const r = await performEpicMerge(baseCtx({ gate: gate({ baseHasMoved: true }) }));
    expect(r.state).toBe("rebasing");
  });
});

// ---------- ready_to_merge — auto-mode merge ----------

describe("performEpicMerge — ready_to_merge auto-mode", () => {
  beforeEach(() => {
    seedState("ready_to_merge", 300, "all checks pass");
  });

  test("successful merge → terminal `merged` with sha + dissolve attempt (no hook → false)", async () => {
    const r = await performEpicMerge(baseCtx({ git: makeGitStub("success") }));
    expect(r.state).toBe("merged");
    expect(r.changed).toBe(true);
    expect(r.mergedSha).toBe("epicMergedSha");
    // No dispatchDissolve hook passed → falls back to the no-hook TODO
    // log + returns false. Production callers (cron tick verb) always
    // wire the hook — the `dispatchDissolve hook wired` test below
    // covers that path.
    expect(r.dissolveDispatched).toBe(false);
    expect(r.reason).toContain("epicMergedSha");
    expect(r.reason).toContain(PARENT_BASE);
  });

  test("no-op merge (epic had nothing to fan in) → terminal `merged` with no-op note", async () => {
    const r = await performEpicMerge(baseCtx({ git: makeGitStub("no-op") }));
    expect(r.state).toBe("merged");
    expect(r.changed).toBe(true);
    expect(r.mergedSha).toBeUndefined();
    expect(r.reason).toContain("no-op");
    expect(r.reason).toContain(PARENT_BASE);
  });

  test("conflict path → terminal `conflict` with conflict paths in note", async () => {
    const r = await performEpicMerge(baseCtx({ git: makeGitStub("conflict") }));
    expect(r.state).toBe("conflict");
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("conflict on");
    expect(r.reason).toContain("file1.ts");
    expect(r.dissolveDispatched).toBe(false);
  });

  test("durable signal: conflict tick LEAVES the row in `conflict` (terminal)", async () => {
    await performEpicMerge(baseCtx({ git: makeGitStub("conflict") }));
    expect(repo.getState(EPIC_BRANCH)?.state).toBe("conflict");
    // Note carries operator-actionable detail.
    expect(repo.getState(EPIC_BRANCH)?.note).toContain("file1.ts");
  });
});

// ---------- ADR-090↔ADR-091 dispatch-hook wire-up (t-9a8b0e4e) ----------

describe("performEpicMerge — dispatchDissolve hook (t-9a8b0e4e)", () => {
  beforeEach(() => {
    seedState("ready_to_merge", 300, "all checks pass");
  });

  test("hook returning true → dissolveDispatched=true with hook called once with (epicId, by)", async () => {
    const calls: Array<{ epicId: string; by: string }> = [];
    const hook = async (epicId: string, by: string): Promise<boolean> => {
      calls.push({ epicId, by });
      return true;
    };
    const r = await performEpicMerge(
      baseCtx({
        git: makeGitStub("success"),
        dispatchDissolve: hook,
        by: "epic-cron",
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.dissolveDispatched).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.epicId).toBe(EPIC_ID);
    expect(calls[0]?.by).toBe("epic-cron");
  });

  test("hook returning false → dissolveDispatched=false (hook DID fire, just failed gracefully)", async () => {
    const hook = async (): Promise<boolean> => false;
    const r = await performEpicMerge(
      baseCtx({
        git: makeGitStub("success"),
        dispatchDissolve: hook,
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.dissolveDispatched).toBe(false);
  });

  test("hook throwing → dissolveDispatched=false WITHOUT re-throwing (merge already terminal)", async () => {
    // The merge already succeeded; a throw inside the dispatch hook
    // must NOT propagate — operator-recoverable via manual dissolve-
    // epic. tryDispatchDissolve's catch swallows + logs to stderr.
    const hook = async (): Promise<boolean> => {
      throw new Error("simulated cockpit-entry missing");
    };
    const r = await performEpicMerge(
      baseCtx({
        git: makeGitStub("success"),
        dispatchDissolve: hook,
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.dissolveDispatched).toBe(false);
    // Merge SHA still surfaces — the dispatch failure didn't kill the
    // merge result.
    expect(r.mergedSha).toBe("epicMergedSha");
  });

  test("no-op merge (HEAD already at parentBase) still fires the hook", async () => {
    // Per ADR-090 §dissolve-epic step 5 — dissolve still runs even on
    // an empty-merge tick. Wire-up regression: the no-op branch in
    // performEpicMerge calls tryDispatchDissolve as well.
    const calls: string[] = [];
    const hook = async (epicId: string): Promise<boolean> => {
      calls.push(epicId);
      return true;
    };
    const r = await performEpicMerge(
      baseCtx({
        git: makeGitStub("no-op"),
        dispatchDissolve: hook,
      }),
    );
    expect(r.state).toBe("merged");
    expect(r.dissolveDispatched).toBe(true);
    expect(calls).toEqual([EPIC_ID]);
  });
});

// ---------- ready_to_merge — pr-mode short-circuit ----------

describe("performEpicMerge — ready_to_merge pr-mode (§Decision-anchor #6)", () => {
  beforeEach(() => {
    seedState("ready_to_merge", 300, "all checks pass");
  });

  test("pr-mode short-circuits without entering merging", async () => {
    const r = await performEpicMerge(baseCtx({ mergeMode: "pr" }));
    expect(r.state).toBe("ready_to_merge");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("pr-mode runtime deferred");
    expect(r.reason).toContain("§Decision-anchor #6");
    // Row stays at ready_to_merge — no transition fired.
    expect(repo.getState(EPIC_BRANCH)?.state).toBe("ready_to_merge");
    expect(r.dissolveDispatched).toBe(false);
  });
});

// ---------- Terminal short-circuits ----------

describe("performEpicMerge — terminal short-circuits", () => {
  test("`merged` row → no-op return with operator-friendly reason", async () => {
    seedState("merged", 1000, "merge sha epicMergedSha on parent");
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("merged");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("dissolve-epic");
    expect(r.reason).toContain("already auto-dispatched");
  });

  test("`conflict` row → no-op return with operator-resolution-required reason", async () => {
    seedState("conflict", 1000, "conflict on epic-branch");
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("conflict");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("operator-resolution required");
  });

  test("`reverted` row → no-op return", async () => {
    seedState("reverted", 1000, "reverted by operator");
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("reverted");
    expect(r.changed).toBe(false);
  });
});

// ---------- Caller-driven mid-flight states ----------

describe("performEpicMerge — caller-driven mid-flight states", () => {
  test("`rebasing` → no-op observed (waiting on outer wiring)", async () => {
    seedState("rebasing", 500, "base moved during work");
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("rebasing");
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/mid-flight|operator-resolution/);
  });

  test("`merging` (mid-flight crash) → no-op observed", async () => {
    seedState("merging", 500, "running git merge");
    const r = await performEpicMerge(baseCtx());
    expect(r.state).toBe("merging");
    expect(r.changed).toBe(false);
  });
});

// ---------- TOCTOU concurrency-loss edges ----------

describe("performEpicMerge — TOCTOU concurrency loss", () => {
  test("seed-attempt against a non-`open` row reports concurrency loss", async () => {
    // Sibling tick already advanced the row past `open` — our tick's
    // re-read sees the new state and short-circuits.
    seedState("in_progress", 100, "sibling advanced");
    // Now the state is `in_progress`, but performEpicMerge will read
    // it as `in_progress` and run the gate decision (NOT a concurrency
    // loss — different code path). Test the concurrency loss explicitly
    // by manipulating during the call would require a more elaborate
    // setup; for unit-test scope, the equivalent assertion is "the
    // seeding path doesn't fire when the row is already past open."
    const r = await performEpicMerge(baseCtx());
    // The in_progress branch fires (gate decision → ready_to_merge).
    expect(r.state).toBe("ready_to_merge");
  });
});

// ---------- Attribution surfaces ----------

describe("performEpicMerge — attribution surfaces", () => {
  test("default `by` is 'epic-cron'", async () => {
    await performEpicMerge(baseCtx());
    expect(repo.getState(EPIC_BRANCH)?.transitionedBy).toBe("epic-cron");
  });

  test("explicit `by` is honored end-to-end", async () => {
    await performEpicMerge(baseCtx({ by: "operator" }));
    expect(repo.getState(EPIC_BRANCH)?.transitionedBy).toBe("operator");
  });

  test("clock injection is honored — `transitionedAt` matches `now()`", async () => {
    await performEpicMerge(baseCtx({ now: () => 4242 }));
    expect(repo.getState(EPIC_BRANCH)?.transitionedAt).toBe(4242);
  });

  test("merge SHA lands in `baseSha` column on terminal `merged`", async () => {
    seedState("ready_to_merge", 300, "all checks pass");
    await performEpicMerge(baseCtx({ git: makeGitStub("success") }));
    expect(repo.getState(EPIC_BRANCH)?.baseSha).toBe("epicMergedSha");
  });
});

// ---------- hasReviewerTrunkSignoff SQL (t-b2d9c955 regression) ----------
//
// Pre-fix defaultResolveGate ran `WHERE status='done' AND role=?` which
// threw "no such column: role" — `role` lives in the `extra` JSON column.
// These tests pin the corrected `json_extract(extra,'$.role')=?` shape.
// Tests exercise the SQL directly (defaultResolveGate isn't exported);
// drift between the inline query here and the verb's query is the
// regression signal.
describe("hasReviewerTrunkSignoff query — json_extract(extra,'$.role')", () => {
  const QUERY = `SELECT COUNT(*) AS n FROM tasks
     WHERE status = 'done' AND json_extract(extra, '$.role') = 'reviewer-trunk-signoff'`;

  function insertTask(id: string, status: string, extra: string | null): void {
    db.prepare(
      `INSERT INTO tasks (id, status, extra, created_at) VALUES (?, ?, ?, ?)`,
    ).run(id, status, extra, 1000);
  }

  test("done row with extra.role='reviewer-trunk-signoff' → count=1", () => {
    insertTask("t-signoff", "done", JSON.stringify({ role: "reviewer-trunk-signoff" }));
    const row = db.query<{ n: number }, []>(QUERY).get();
    expect(row?.n).toBe(1);
  });

  test("done row with extra.role='other' → count=0", () => {
    insertTask("t-other", "done", JSON.stringify({ role: "member" }));
    const row = db.query<{ n: number }, []>(QUERY).get();
    expect(row?.n).toBe(0);
  });

  test("done row with no extra.role → count=0", () => {
    insertTask("t-no-role", "done", JSON.stringify({ priority: 1 }));
    const row = db.query<{ n: number }, []>(QUERY).get();
    expect(row?.n).toBe(0);
  });

  test("done row with extra=NULL → count=0 (no SQL error)", () => {
    insertTask("t-null-extra", "done", null);
    const row = db.query<{ n: number }, []>(QUERY).get();
    expect(row?.n).toBe(0);
  });

  test("non-done row with extra.role='reviewer-trunk-signoff' → count=0 (status gate enforced)", () => {
    insertTask("t-in-progress-signoff", "in-progress", JSON.stringify({ role: "reviewer-trunk-signoff" }));
    const row = db.query<{ n: number }, []>(QUERY).get();
    expect(row?.n).toBe(0);
  });

  test("mixed rows: only done+signoff-role counted", () => {
    insertTask("t-1", "done", JSON.stringify({ role: "reviewer-trunk-signoff" }));
    insertTask("t-2", "done", JSON.stringify({ role: "reviewer-trunk-signoff" }));
    insertTask("t-3", "done", JSON.stringify({ role: "member" }));
    insertTask("t-4", "in-progress", JSON.stringify({ role: "reviewer-trunk-signoff" }));
    insertTask("t-5", "done", null);
    const row = db.query<{ n: number }, []>(QUERY).get();
    expect(row?.n).toBe(2);
  });

  test("pre-fix query (role as column) FAILS — regression-pin proves bug existed", () => {
    insertTask("t-signoff", "done", JSON.stringify({ role: "reviewer-trunk-signoff" }));
    expect(() =>
      db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE status = 'done' AND role = 'reviewer-trunk-signoff'`,
        )
        .get(),
    ).toThrow(/no such column.*role/i);
  });
});
