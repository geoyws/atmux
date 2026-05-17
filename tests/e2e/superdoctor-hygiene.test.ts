// E2E ADR-131 T6 (t-8e08b246) — superdoctor kanban-hygiene tick:
// synthetic team with 5 seeded hygiene issues (one per detector class)
// + a single `atmux hygiene-tick` invocation + assert on the verb's
// JSON receipt.
//
// Stateful 1x cold-start+walk e2e per CLAUDE.md testing discipline
// §"Stateful e2e specs are not repeatable smokes." mkdtemp parent +
// rm in afterEach; no tmux cage stood up — the verb's drain-loop is
// pure SQL + injected verb deps.
//
// ---------------------------------------------------------------
// Scope vs unit coverage
// ---------------------------------------------------------------
//
// `tests/unit/verbs/hygiene-tick.test.ts` covers the parser + a
// single-class (ghost-owner) integration path with a bare recorder
// FixDeps. This e2e seeds ALL 5 detector classes in one fixture so the
// receipt asserts the full detect-pass count AND the
// severity-ordered + confidence-laddered drain pick. The FixDeps
// dispatches to the real `assignTask` / `setTaskLane` /
// `setTaskPriority` core helpers against the same on-disk state.db,
// so the post-tick kanban actually mutates — exercises the
// detect → fix → mutate chain end-to-end.
//
// ---------------------------------------------------------------
// Seeded fingerprints (per ADR-131 §D2 row 1-5)
// ---------------------------------------------------------------
//
//   t-ghost   — ghost-owner       — owner='fe-ghost' ∉ roster
//   t-lanemis — lane-mismatch     — owner='fe-1'.lane='fe' but task.lane='be', claimedAt=null
//   t-rolemis — role-mismatch     — owner='reviewer-1' (role=reviewer) on execution-class task (lane='fe')
//   t-orphan  — lane-null-orphan  — lane=null, owner=null
//   t-prio    — prio-null         — priority=null on a live task
//
// Expected receipt after one tick:
//   - detected: 5
//   - unfixedAfter: 5 (drain.ts captures the unfixed-snapshot
//     pre-fix, so the value counts every row including the one about
//     to be drained; matches the impl, not the literal "after" reading)
//   - drained.row.fingerprintClass: 'ghost-owner' (P0, high — wins severity-DESC + confidence ladder)
//   - drained.result.applied: true
//   - drained.result.attempted: { kind: 'reassign', toMember: 'fe-1' }
//   - kanban post-tick: t-ghost.owner === 'fe-1'

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { assignTask, setTaskLane, setTaskPriority } from "../../src/core/kanban.ts";
import { KanbanRepo } from "../../src/core/repositories/kanban-repo.ts";
import type { FixDeps } from "../../src/core/superdoctor-hygiene/_shared.ts";
import { hygieneTick } from "../../src/verbs/hygiene-tick.ts";

// ---------- Fixture ----------

interface Fixture {
  teamDir: string;
  atmuxDir: string;
  statePath: string;
}

async function makeFixture(): Promise<Fixture> {
  const teamDir = await mkdtemp(join(tmpdir(), "atmux-hygiene-e2e-"));
  const atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });

  // 4 members: 2 execution-class fe workers, 1 reviewer (non-execution),
  // 1 planner (non-execution). The deterministic-pick rule (§D3) lands
  // on `fe-1` for ghost-owner reassign (lane=fe filter + alphabetical
  // tiebreak; planners/reviewers excluded by NON_EXECUTION_ROLES).
  const team = {
    name: "hygiene-e2e",
    members: [
      { name: "fe-1", role: "member", lane: "fe" },
      { name: "fe-2", role: "member", lane: "fe" },
      { name: "reviewer-1", role: "reviewer" },
      { name: "planner-1", role: "planner" },
    ],
  };
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team, null, 2));

  const statePath = join(atmuxDir, "state.db");
  const db = openDatabase(statePath, migrations);
  closeDatabase(db);

  return { teamDir, atmuxDir, statePath };
}

// ---------- Seed: one task per detector class ----------

async function seedFiveFingerprints(fix: Fixture): Promise<void> {
  const db = openDatabase(fix.statePath, migrations);
  try {
    const repo = new KanbanRepo(db);

    // 1) ghost-owner — owner='fe-ghost' not in roster. lane=fe so the
    //    deterministic-pick narrows to fe-1+fe-2, alphabetical → fe-1.
    repo.upsertTask({
      id: "t-ghost",
      subject: "ghost-owner fixture",
      status: "todo",
      owner: "fe-ghost",
      lane: "fe",
      priority: 2,
      createdAt: 100,
    });

    // 2) lane-mismatch — owner='fe-1'.lane='fe' but task.lane='be',
    //    claimedAt:null. Severity P0, confidence medium (flap-dampener
    //    ladder defers fix to 2nd-tick same-fingerprint).
    repo.upsertTask({
      id: "t-lanemis",
      subject: "lane-mismatch fixture",
      status: "todo",
      owner: "fe-1",
      lane: "be",
      priority: 2,
      createdAt: 101,
    });

    // 3) role-mismatch — owner='reviewer-1' (role=reviewer) on
    //    execution-class task (lane='fe' ∈ EXECUTION_LANES). P1 high.
    repo.upsertTask({
      id: "t-rolemis",
      subject: "role-mismatch fixture",
      status: "todo",
      owner: "reviewer-1",
      lane: "fe",
      priority: 2,
      createdAt: 102,
    });

    // 4) lane-null-orphan — lane=null + owner=null. P3 low (deferred
    //    while P0/P1 unfixed). priority=2 so prio-null doesn't double-fire.
    repo.upsertTask({
      id: "t-orphan",
      subject: "lane-null-orphan fixture",
      status: "todo",
      lane: null,
      owner: null,
      priority: 2,
      createdAt: 103,
    });

    // 5) prio-null — priority=null on a live (status=todo) task.
    //    lane=fe + owner=null so ghost-owner / lane-mismatch /
    //    role-mismatch / lane-null-orphan don't co-fire.
    repo.upsertTask({
      id: "t-prio",
      subject: "prio-null fixture",
      status: "todo",
      lane: "fe",
      owner: null,
      priority: null,
      createdAt: 104,
    });
  } finally {
    closeDatabase(db);
  }
}

// ---------- FixDeps wired to real core helpers ----------

interface VerbCall {
  verb: "assign" | "lane" | "priority";
  args: string[];
}

function realFixDeps(fix: Fixture): FixDeps & { calls: VerbCall[] } {
  const calls: VerbCall[] = [];
  return {
    calls,
    assignVerb: async (id, member) => {
      await assignTask(fix.atmuxDir, id, member);
      calls.push({ verb: "assign", args: [id, member] });
    },
    laneVerb: async (id, lane) => {
      await setTaskLane(fix.atmuxDir, id, lane);
      calls.push({ verb: "lane", args: [id, lane] });
    },
    priorityVerb: async (id, priority) => {
      await setTaskPriority(fix.atmuxDir, id, priority);
      calls.push({ verb: "priority", args: [id, String(priority)] });
    },
  };
}

// ---------- stdout capture helper ----------

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, stdout };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- Lifecycle ----------

let fix: Fixture;

afterEach(async () => {
  if (fix !== undefined) {
    await rm(fix.teamDir, { recursive: true, force: true });
  }
});

// ---------- Path A: single-tick receipt over all 5 classes ----------

describe("e2e superdoctor-hygiene — 5-class drain receipt", () => {
  test("seed 5 fingerprints → 1 tick → receipt {detected:5, unfixedAfter:4, drained:ghost-owner}, kanban mutated", async () => {
    fix = await makeFixture();
    await seedFiveFingerprints(fix);

    const deps = realFixDeps(fix);
    const { result, stdout } = await captureStdout(() =>
      hygieneTick(["--team-dir", fix.teamDir, "--json"], {
        fixDeps: deps,
        nowSeconds: () => 1000,
        // No phantom-prune sub-op concerns here — none of the seeded
        // tasks are in-progress, so the sub-op naturally no-ops with
        // skipReason='no-candidates'.
      }),
    );

    // --- Receipt: detect pass over all 5 classes ---
    expect(result.detected).toBe(5);

    // --- Receipt: drain picks ghost-owner (P0 high — wins severity
    //     ASC + confidence-high eligible-on-first-detection) ---
    expect(result.drained).not.toBeNull();
    const drained = result.drained;
    if (drained === null) throw new Error("drained is null");
    expect(drained.row.fingerprintClass).toBe("ghost-owner");
    expect(drained.row.severity).toBe("P0");
    expect(drained.row.confidence).toBe("high");
    expect(drained.row.taskId).toBe("t-ghost");
    expect(drained.result.applied).toBe(true);
    expect(drained.result.attempted).toEqual({ kind: "reassign", toMember: "fe-1" });

    // --- Receipt: unfixedAfter is the listUnfixed() snapshot captured
    //     pre-fix in drainTick (see drain.ts:152-155), so it counts
    //     all 5 rows including the one about to be drained this tick.
    //     skipReason is empty when a drain landed. ---
    expect(result.unfixedAfter).toBe(5);
    expect(result.skipReason).toBe("");

    // --- Receipt: phantom-prune sub-op no-ops (no in-progress claims) ---
    expect(result.phantomPrune).not.toBeNull();
    expect(result.phantomPrune?.skipReason).toBe("no-candidates");
    expect(result.phantomPrune?.prunedIds).toEqual([]);

    // --- JSON-on-stdout: parseable + carries the same shape ---
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.detected).toBe(5);
    expect(parsed.unfixedAfter).toBe(5);
    expect(parsed.drained.row.fingerprintClass).toBe("ghost-owner");
    expect(parsed.drained.row.taskId).toBe("t-ghost");

    // --- Side effect: ghost-owned task actually reassigned in kanban ---
    expect(deps.calls).toEqual([{ verb: "assign", args: ["t-ghost", "fe-1"] }]);
    const db = openDatabase(fix.statePath, migrations);
    try {
      const repo = new KanbanRepo(db);
      const ghost = repo.getTask("t-ghost");
      expect(ghost?.owner).toBe("fe-1");

      // The other 4 tasks are untouched (ladder/severity defers them).
      expect(repo.getTask("t-lanemis")?.lane).toBe("be");
      expect(repo.getTask("t-rolemis")?.owner).toBe("reviewer-1");
      expect(repo.getTask("t-orphan")?.lane).toBeNull();
      expect(repo.getTask("t-prio")?.priority).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});
