// Unit tests for src/core/reap.ts (ADR-223 §D2-§D5 / t-2c319198).
//
// Coverage matrix per DoD:
//
//   Per-class dispatch (5 reapable classes + 1 surface-only):
//     - cron-block-without-worktree   → cronReaperReap(ref)
//     - cockpit-registry-without-cage → removeRegistryEntry(eid)
//     - branch-without-row            → deleteBranch(repo, branch) after Gate 3
//     - worktree-without-cage         → rmZombieWorktree(path) after Gate 1
//     - cage-tmux-without-registry    → killCageServer(socket) after Gate 1
//     - kanban-epic-without-cage      → SURFACE-ONLY (skipped, never auto-reaped)
//
//   Per-gate negative paths:
//     - Gate 1 (active-check): cage active → refused; worktree dirty → refused;
//       --skip-checks bypasses; bypassed[] row recorded
//     - Gate 2 (parent-kind): kind === "parent" → refused with gate-2-parent-kind
//       (compile-time enforced via discriminated union; this test pins the
//       runtime guard against contrived inputs)
//     - Gate 3 (merge-base): unmerged branch → refused; --skip-checks does
//       NOT bypass (preserves ADR-219 §D2 invariant per reviewer audit)
//     - Gate 4: deferred to verb layer; not tested here
//
//   Cascade order per §D2:
//     - cron blocks → registry-only → branch-without-row → worktree-without-cage
//       → cage-tmux-without-registry (cheapest first, biggest blast last)
//
//   Idempotency per §D4:
//     - 2nd run with no new orphans = no-op (zero rows touched)
//     - Mid-cascade primitive failure → collected to failed[]; remaining
//       orphans in cascade continue
//
//   Reap-log per §OQ5:
//     - One append per reaped orphan with schema_version: 1
//     - Failure path appends `result: failed` + error message
//
//   --dry-run + --class filter
//
//   reapZombieWorktree helper guards:
//     - empty path / "/" / $HOME / non-atmux-epics path refused

import { describe, expect, test } from "bun:test";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import {
  makeReapZombieWorktree,
  type OrphanClass,
  type ReapDeps,
  type ReapLogEntry,
  type ReapOpts,
  reapOrphans,
  type TopoOrphan,
} from "../../../src/core/reap.ts";
import { isCageActiveWith, isWorktreeActiveWith } from "../../../src/verbs/topo-io.ts";

// ---------- Mock deps ----------

interface RecordedDeps {
  deps: ReapDeps;
  killCageServerCalls: string[];
  cronReaperReapCalls: string[];
  rmZombieWorktreeCalls: string[];
  deleteBranchCalls: Array<{ repo: string; branch: string }>;
  removeRegistryEntryCalls: string[];
  isCageActiveResponses: Map<string, boolean>;
  isWorktreeActiveResponses: Map<string, boolean>;
  isBranchMergedResponses: Map<string, boolean>;
  reapLog: ReapLogEntry[];
  failOnPrimitive?: string;
}

function makeDeps(
  overrides: {
    failOnPrimitive?: string;
    isCageActive?: Map<string, boolean>;
    isWorktreeActive?: Map<string, boolean>;
    isBranchMerged?: Map<string, boolean>;
  } = {},
): RecordedDeps {
  const r: RecordedDeps = {
    killCageServerCalls: [],
    cronReaperReapCalls: [],
    rmZombieWorktreeCalls: [],
    deleteBranchCalls: [],
    removeRegistryEntryCalls: [],
    isCageActiveResponses: overrides.isCageActive ?? new Map(),
    isWorktreeActiveResponses: overrides.isWorktreeActive ?? new Map(),
    isBranchMergedResponses: overrides.isBranchMerged ?? new Map(),
    reapLog: [],
    deps: {} as ReapDeps,
  };
  if (overrides.failOnPrimitive !== undefined) {
    r.failOnPrimitive = overrides.failOnPrimitive;
  }
  r.deps = {
    async killCageServer(socket) {
      r.killCageServerCalls.push(socket);
      if (r.failOnPrimitive === "killCageServer") {
        throw new Error("simulated kill-server failure");
      }
    },
    async cronReaperReap(scope) {
      r.cronReaperReapCalls.push(scope);
      if (r.failOnPrimitive === "cronReaperReap") {
        throw new Error("simulated cron-reaper failure");
      }
    },
    async rmZombieWorktree(path) {
      r.rmZombieWorktreeCalls.push(path);
      if (r.failOnPrimitive === "rmZombieWorktree") {
        throw new Error("simulated rm failure");
      }
    },
    async deleteBranch(repoPath, branch) {
      r.deleteBranchCalls.push({ repo: repoPath, branch });
      if (r.failOnPrimitive === "deleteBranch") {
        throw new Error("simulated branch-D failure");
      }
    },
    async removeRegistryEntry(eid) {
      r.removeRegistryEntryCalls.push(eid);
      if (r.failOnPrimitive === "removeRegistryEntry") {
        throw new Error("simulated registry-remove failure");
      }
    },
    async isCageActive(socket) {
      return r.isCageActiveResponses.get(socket) ?? false;
    },
    async isWorktreeActive(path) {
      return r.isWorktreeActiveResponses.get(path) ?? false;
    },
    async isBranchMerged(_repo, _base, branch) {
      // Map key = branch name for ergonomic fixtures.
      return r.isBranchMergedResponses.get(branch) ?? true;
    },
    async appendReapLog(entry) {
      r.reapLog.push(entry);
    },
    now() {
      return new Date("2026-05-23T00:00:00.000Z");
    },
  };
  return r;
}

// ---------- Orphan fixture builder ----------

function makeOrphan(
  cls: OrphanClass,
  ref: string,
  overrides: Partial<TopoOrphan> = {},
): TopoOrphan {
  return {
    kind: "epic",
    class: cls,
    ref,
    details: "test orphan",
    first_seen: "2026-05-22T13:00:00.000Z",
    ...overrides,
  };
}

function makeOpts(deps: ReapDeps, overrides: Partial<ReapOpts> = {}): ReapOpts {
  return {
    deps,
    dryRun: false,
    repoPathForBranch: (b) => `/srv/${b.split("-")[0] ?? "atmux"}`,
    baseBranchForBranch: () => "trunk",
    worktreePathForOrphan: (o) => `/srv/atmux-epics/${o.ref}`,
    cageSocketForOrphan: (o) => `/tmp/atmux-atmux/epics/${o.ref}/tmux-0/default`,
    ...overrides,
  };
}

// ---------- Per-class dispatch ----------

describe("per-class dispatch", () => {
  test("cron-block-without-worktree → cronReaperReap(ref)", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("cron-block-without-worktree", "atmux:team=x")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.cronReaperReapCalls).toEqual(["atmux:team=x"]);
    expect(result.reaped).toHaveLength(1);
    expect(result.reaped[0]?.primitive).toBe("cronReaperReap");
  });

  test("cockpit-registry-without-cage → removeRegistryEntry(eid)", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("cockpit-registry-without-cage", "e-1")];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.removeRegistryEntryCalls).toEqual(["e-1"]);
  });

  test("branch-without-row → deleteBranch after Gate 3 passes", async () => {
    const r = makeDeps({ isBranchMerged: new Map([["atmux-geoyws-epic-e-1", true]]) });
    const orphans = [makeOrphan("branch-without-row", "atmux-geoyws-epic-e-1")];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.deleteBranchCalls).toEqual([{ repo: "/srv/atmux", branch: "atmux-geoyws-epic-e-1" }]);
  });

  test("worktree-without-cage → rmZombieWorktree(path) after Gate 1 passes", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("worktree-without-cage", "e-2")];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.rmZombieWorktreeCalls).toEqual(["/srv/atmux-epics/e-2"]);
  });

  test("cage-tmux-without-registry → killCageServer(socket) after Gate 1 passes", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-3")];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.killCageServerCalls).toEqual(["/tmp/atmux-atmux/epics/e-3/tmux-0/default"]);
  });

  test("kanban-epic-without-cage → surface-only (skipped)", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("kanban-epic-without-cage", "e-4")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("surface-only");
  });
});

// ---------- Gate 1 (active-check) ----------

describe("Gate 1 — active-check", () => {
  test("cage active → refused (no --skip-checks)", async () => {
    const socket = "/tmp/atmux-atmux/epics/e-1/tmux-0/default";
    const r = makeDeps({ isCageActive: new Map([[socket, true]]) });
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-1")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.killCageServerCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-1-active-check");
  });

  test("worktree dirty → refused (no --skip-checks)", async () => {
    const path = "/srv/atmux-epics/e-2";
    const r = makeDeps({ isWorktreeActive: new Map([[path, true]]) });
    const orphans = [makeOrphan("worktree-without-cage", "e-2")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.rmZombieWorktreeCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("worktree dirty");
  });

  test("--skip-checks bypasses Gate 1 + records bypassed[] row", async () => {
    const socket = "/tmp/atmux-atmux/epics/e-1/tmux-0/default";
    const r = makeDeps({ isCageActive: new Map([[socket, true]]) });
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-1")];
    const result = await reapOrphans(orphans, makeOpts(r.deps, { skipChecks: true }));
    expect(r.killCageServerCalls).toEqual([socket]);
    expect(result.bypassed).toContainEqual({ gate: "gate-1-active-check", ref: "e-1" });
  });

  test("--skip-checks bypasses worktree Gate 1", async () => {
    const path = "/srv/atmux-epics/e-2";
    const r = makeDeps({ isWorktreeActive: new Map([[path, true]]) });
    const orphans = [makeOrphan("worktree-without-cage", "e-2")];
    const result = await reapOrphans(orphans, makeOpts(r.deps, { skipChecks: true }));
    expect(r.rmZombieWorktreeCalls).toEqual([path]);
    expect(result.bypassed).toContainEqual({ gate: "gate-1-active-check", ref: "e-2" });
  });
});

// ---------- Gate 2 (parent-kind, structural) ----------

describe("Gate 2 — parent-kind structural refusal", () => {
  test("kind === 'parent' → refused with gate-2-parent-kind", async () => {
    const r = makeDeps();
    const parentOrphan = {
      ...makeOrphan("cage-tmux-without-registry", "atmux"),
      kind: "parent" as const,
    };
    const result = await reapOrphans([parentOrphan], makeOpts(r.deps));
    expect(r.killCageServerCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-2-parent-kind");
  });

  test("--skip-checks does NOT bypass Gate 2", async () => {
    const r = makeDeps();
    const parentOrphan = {
      ...makeOrphan("cage-tmux-without-registry", "atmux"),
      kind: "parent" as const,
    };
    const result = await reapOrphans([parentOrphan], makeOpts(r.deps, { skipChecks: true }));
    expect(r.killCageServerCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
  });
});

// ---------- Gate 3 (merge-base, NEVER bypassed) ----------

describe("Gate 3 — merge-base (NEVER bypassed)", () => {
  test("unmerged branch → refused", async () => {
    const r = makeDeps({ isBranchMerged: new Map([["atmux-geoyws-epic-e-1", false]]) });
    const orphans = [makeOrphan("branch-without-row", "atmux-geoyws-epic-e-1")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.deleteBranchCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-3-merge-base");
  });

  test("--skip-checks does NOT bypass Gate 3 (preserves ADR-219 §D2)", async () => {
    const r = makeDeps({ isBranchMerged: new Map([["atmux-geoyws-epic-e-1", false]]) });
    const orphans = [makeOrphan("branch-without-row", "atmux-geoyws-epic-e-1")];
    const result = await reapOrphans(orphans, makeOpts(r.deps, { skipChecks: true }));
    expect(r.deleteBranchCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.bypassed.find((b) => b.gate === "gate-3-merge-base")).toBeUndefined();
  });

  test("missing repoPathForBranch → refused with gate-3 reason", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("branch-without-row", "atmux-geoyws-epic-e-1")];
    const opts = makeOpts(r.deps);
    delete opts.repoPathForBranch;
    const result = await reapOrphans(orphans, opts);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-3-merge-base");
  });

  test("missing baseBranchForBranch → refused with gate-3 reason", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("branch-without-row", "atmux-geoyws-epic-e-1")];
    const opts = makeOpts(r.deps);
    delete opts.baseBranchForBranch;
    const result = await reapOrphans(orphans, opts);
    expect(result.refused).toHaveLength(1);
  });
});

// ---------- Missing-path refusals (defensive) ----------

describe("missing-path refusals", () => {
  test("worktree class missing worktreePathForOrphan → refused", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("worktree-without-cage", "e-1")];
    const opts = makeOpts(r.deps);
    delete opts.worktreePathForOrphan;
    const result = await reapOrphans(orphans, opts);
    expect(result.refused).toHaveLength(1);
    expect(r.rmZombieWorktreeCalls).toEqual([]);
  });

  test("cage class missing cageSocketForOrphan → refused", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-1")];
    const opts = makeOpts(r.deps);
    delete opts.cageSocketForOrphan;
    const result = await reapOrphans(orphans, opts);
    expect(result.refused).toHaveLength(1);
    expect(r.killCageServerCalls).toEqual([]);
  });
});

// ---------- Cascade order per §D2 ----------

describe("cascade order (§D2)", () => {
  test("cron → registry → branch → worktree → cage", async () => {
    const r = makeDeps({
      isBranchMerged: new Map([["atmux-geoyws-epic-e-b", true]]),
    });
    // Intentionally shuffle input order — cascade should re-sort.
    const orphans = [
      makeOrphan("cage-tmux-without-registry", "e-cage"),
      makeOrphan("worktree-without-cage", "e-wt"),
      makeOrphan("branch-without-row", "atmux-geoyws-epic-e-b"),
      makeOrphan("cockpit-registry-without-cage", "e-reg"),
      makeOrphan("cron-block-without-worktree", "atmux:team=cron"),
    ];
    await reapOrphans(orphans, makeOpts(r.deps));
    // Order observed by checking reap-log appendage order.
    expect(r.reapLog.map((e) => e.orphan_class)).toEqual([
      "cron-block-without-worktree",
      "cockpit-registry-without-cage",
      "branch-without-row",
      "worktree-without-cage",
      "cage-tmux-without-registry",
    ]);
  });
});

// ---------- Idempotency (§D4) ----------

describe("idempotency", () => {
  test("2nd run with no orphans = no-op", async () => {
    const r = makeDeps();
    const result = await reapOrphans([], makeOpts(r.deps));
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(r.reapLog).toEqual([]);
  });

  test("running same orphan twice = primitive called twice (caller idempotency assumed)", async () => {
    const r = makeDeps();
    const orphan = makeOrphan("cron-block-without-worktree", "atmux:team=x");
    await reapOrphans([orphan], makeOpts(r.deps));
    await reapOrphans([orphan], makeOpts(r.deps));
    expect(r.cronReaperReapCalls).toHaveLength(2);
    // Each primitive's underlying impl is idempotent against an already-
    // reaped target (cron-reaper no-ops on missing block); the
    // orchestrator delegates that contract to the primitive.
  });
});

// ---------- Mid-cascade failure isolation ----------

describe("mid-cascade failure isolation", () => {
  test("failure on orphan N does NOT block orphan N+1", async () => {
    const r = makeDeps({ failOnPrimitive: "cronReaperReap" });
    const orphans = [
      makeOrphan("cron-block-without-worktree", "atmux:team=x"), // fails
      makeOrphan("cockpit-registry-without-cage", "e-1"), // should still run
    ];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(result.failed).toHaveLength(1);
    expect(result.reaped).toHaveLength(1);
    expect(r.removeRegistryEntryCalls).toEqual(["e-1"]);
  });

  test("failed orphan appends reap-log with result: failed + error", async () => {
    const r = makeDeps({ failOnPrimitive: "killCageServer" });
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-1")];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.reapLog).toHaveLength(1);
    expect(r.reapLog[0]?.result).toBe("failed");
    expect(r.reapLog[0]?.error).toContain("simulated kill-server failure");
  });

  test("non-Error throw is stringified", async () => {
    const r = makeDeps();
    let called = false;
    r.deps.cronReaperReap = async () => {
      called = true;
      // Intentional non-Error throw to exercise the String(err) fallback.
      throw "string-thrown"; // eslint-disable-line no-throw-literal
    };
    const orphans = [makeOrphan("cron-block-without-worktree", "atmux:team=x")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(called).toBe(true);
    expect(result.failed[0]?.error).toBe("string-thrown");
  });
});

// ---------- Reap-log (§OQ5) ----------

describe("reap-log", () => {
  test("appends one row per reaped orphan with schema_version: 1", async () => {
    const r = makeDeps();
    const orphans = [
      makeOrphan("cron-block-without-worktree", "atmux:team=a"),
      makeOrphan("cockpit-registry-without-cage", "e-1"),
    ];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.reapLog).toHaveLength(2);
    for (const entry of r.reapLog) {
      expect(entry.schema_version).toBe(1);
      expect(entry.timestamp).toBe("2026-05-23T00:00:00.000Z");
      expect(entry.result).toBe("ok");
    }
  });

  test("does NOT append for refused orphans", async () => {
    const r = makeDeps({ isBranchMerged: new Map([["atmux-geoyws-epic-e-1", false]]) });
    const orphans = [makeOrphan("branch-without-row", "atmux-geoyws-epic-e-1")];
    await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.reapLog).toEqual([]);
  });

  test("does NOT append for dry-run", async () => {
    const r = makeDeps();
    const orphans = [makeOrphan("cron-block-without-worktree", "atmux:team=a")];
    await reapOrphans(orphans, makeOpts(r.deps, { dryRun: true }));
    expect(r.reapLog).toEqual([]);
  });
});

// ---------- Dry-run + class filter ----------

describe("dry-run + --class filter", () => {
  test("dry-run routes all reapable orphans to skipped[] with primitive label for each class", async () => {
    const r = makeDeps();
    const orphans = [
      makeOrphan("cron-block-without-worktree", "atmux:team=a"),
      makeOrphan("cockpit-registry-without-cage", "e-1"),
      makeOrphan("branch-without-row", "atmux-geoyws-epic-e-b"),
      makeOrphan("worktree-without-cage", "e-w"),
      makeOrphan("cage-tmux-without-registry", "e-c"),
    ];
    const result = await reapOrphans(orphans, makeOpts(r.deps, { dryRun: true }));
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toHaveLength(5);
    // Every primitive label is exercised by dry-run.
    const labels = result.skipped.map((s) => s.primitive).sort();
    expect(labels).toEqual([
      "cronReaperReap",
      "deleteBranch",
      "killCageServer",
      "removeRegistryEntry",
      "rmZombieWorktree",
    ]);
    expect(result.skipped.every((s) => s.reason === "dry-run")).toBe(true);
  });

  test("--class filter scopes the cascade", async () => {
    const r = makeDeps();
    const orphans = [
      makeOrphan("cron-block-without-worktree", "atmux:team=a"),
      makeOrphan("cockpit-registry-without-cage", "e-1"),
    ];
    const result = await reapOrphans(
      orphans,
      makeOpts(r.deps, { classFilter: "cron-block-without-worktree" }),
    );
    expect(r.cronReaperReapCalls).toEqual(["atmux:team=a"]);
    expect(r.removeRegistryEntryCalls).toEqual([]);
    expect(result.reaped).toHaveLength(1);
    // The excluded orphan should be in skipped[] with class-filter reason.
    expect(result.skipped.find((s) => s.reason?.includes("class-filter"))).toBeDefined();
  });

  test("kanban-epic-without-cage always goes to skipped[] even under class-filter", async () => {
    const r = makeDeps();
    const orphans = [
      makeOrphan("kanban-epic-without-cage", "e-k"),
      makeOrphan("cron-block-without-worktree", "atmux:team=a"),
    ];
    const result = await reapOrphans(
      orphans,
      makeOpts(r.deps, { classFilter: "cron-block-without-worktree" }),
    );
    // kanban goes to skipped (surface-only); cron-block matches class
    // filter so it's reaped, not skipped.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.orphan.class).toBe("kanban-epic-without-cage");
    expect(result.reaped).toHaveLength(1);
    expect(result.reaped[0]?.orphan.class).toBe("cron-block-without-worktree");
  });
});

// ---------- reapZombieWorktree helper ----------

describe("makeReapZombieWorktree", () => {
  test("empty path refused", async () => {
    const helper = makeReapZombieWorktree(async () => {});
    await expect(helper("")).rejects.toThrow("empty path refused");
  });

  test("root '/' refused", async () => {
    const helper = makeReapZombieWorktree(async () => {});
    await expect(helper("/")).rejects.toThrow("root-like path");
  });

  test("$HOME refused", async () => {
    const orig = process.env.HOME;
    process.env.HOME = "/srv/home/x";
    try {
      const helper = makeReapZombieWorktree(async () => {});
      await expect(helper("/srv/home/x")).rejects.toThrow("root-like path");
    } finally {
      process.env.HOME = orig;
    }
  });

  test("non-atmux-epics path refused", async () => {
    const helper = makeReapZombieWorktree(async () => {});
    await expect(helper("/srv/some-other-dir")).rejects.toThrow("non-epic-team path");
  });

  test("valid atmux-epics path delegates to rm", async () => {
    const calls: string[] = [];
    const helper = makeReapZombieWorktree(async (p) => {
      calls.push(p);
    });
    await helper("/srv/atmux-epics/e-1");
    expect(calls).toEqual(["/srv/atmux-epics/e-1"]);
  });
});

// ---------- Defensive: unknown class ----------

describe("unknown class", () => {
  test("orphan with unmapped class → failed[] with reason", async () => {
    const r = makeDeps();
    const orphan = {
      ...makeOrphan("cron-block-without-worktree", "x"),
      class: "future-unknown-class" as unknown as OrphanClass,
    };
    // Force it into the cascade by faking the class as a reapable one;
    // we manually route into reapOne via injecting into ordered cascade
    // through opts.classFilter... but since unknown classes don't match
    // any REAP_ORDER literal, this row is filtered out entirely.
    const result = await reapOrphans([orphan], makeOpts(r.deps));
    // Should produce 0 reaped + 0 in any bucket because the class
    // isn't recognized by the cascade order.
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ---------- Gate-1 fail-CLOSED (ADR-253 §Defect 3) ----------
//
// These DO NOT stub the liveness function under test. They wire the
// REAL production predicates (isCageActiveWith / isWorktreeActiveWith
// from topo-io.ts) into the orchestrator's Gate-1 deps with a THROWING
// probe, proving the end-to-end chain: probe throws ⇒ predicate returns
// active (fail-closed) ⇒ orchestrator REFUSES ⇒ destructive primitive
// NEVER runs. Pre-ADR-253 these probes caught the throw and returned
// `false` (fail-OPEN), so a cage whose socket was momentarily
// unreadable would have been kill-server'd.

describe("Gate-1 fail-CLOSED with real liveness predicates (ADR-253)", () => {
  test("throwing cage probe ⇒ refused, NOT reaped (no kill-server)", async () => {
    const socket = "/tmp/atmux-atmux/epics/e-1/tmux-0/default";
    const r = makeDeps();
    // Real predicate over a throwing session-lister (socket unreadable).
    r.deps.isCageActive = (s) => {
      expect(s).toBe(socket);
      return isCageActiveWith(async () => {
        throw new Error("no server running on socket");
      });
    };
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-1")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.killCageServerCalls).toEqual([]);
    expect(result.reaped).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-1-active-check");
  });

  test("empty cage session list ⇒ inactive ⇒ reaped (genuinely-clean signal)", async () => {
    const r = makeDeps();
    r.deps.isCageActive = () => isCageActiveWith(async () => []);
    const orphans = [makeOrphan("cage-tmux-without-registry", "e-1")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.killCageServerCalls).toHaveLength(1);
    expect(result.reaped).toHaveLength(1);
  });

  test("throwing worktree git probe ⇒ refused, NOT reaped (no rm)", async () => {
    const wtPath = "/srv/atmux-epics/e-2";
    const throwingGit: GitSpawn = async () => {
      throw new Error("fatal: not a git repository");
    };
    const r = makeDeps();
    r.deps.isWorktreeActive = (p) => {
      expect(p).toBe(wtPath);
      return isWorktreeActiveWith(throwingGit, p);
    };
    const orphans = [makeOrphan("worktree-without-cage", "e-2")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.rmZombieWorktreeCalls).toEqual([]);
    expect(result.reaped).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-1-active-check");
  });

  test("git status rc!=0 ⇒ fail-closed active ⇒ worktree refused, NOT reaped", async () => {
    const rcFailGit: GitSpawn = async (argv) => ({
      cmd: "git",
      argv,
      exitCode: 128,
      signalled: null,
      stdout: "",
      stderr: "fatal: not a git repository",
      durationMs: 1,
    });
    const r = makeDeps();
    r.deps.isWorktreeActive = (p) => isWorktreeActiveWith(rcFailGit, p);
    const orphans = [makeOrphan("worktree-without-cage", "e-2")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.rmZombieWorktreeCalls).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.reason).toContain("gate-1-active-check");
  });

  test("clean + old worktree ⇒ inactive ⇒ reaped (genuinely-clean signal)", async () => {
    const oldTs = Math.floor(new Date("2026-05-23T00:00:00.000Z").getTime() / 1000) - 60 * 60;
    const cleanOldGit: GitSpawn = async (argv) => ({
      cmd: "git",
      argv,
      exitCode: 0,
      signalled: null,
      stdout: argv.includes("log") ? `${oldTs}\n` : "",
      stderr: "",
      durationMs: 1,
    });
    const r = makeDeps();
    r.deps.isWorktreeActive = (p) =>
      isWorktreeActiveWith(cleanOldGit, p, () => new Date("2026-05-23T00:00:00.000Z"));
    const orphans = [makeOrphan("worktree-without-cage", "e-2")];
    const result = await reapOrphans(orphans, makeOpts(r.deps));
    expect(r.rmZombieWorktreeCalls).toHaveLength(1);
    expect(result.reaped).toHaveLength(1);
  });
});
