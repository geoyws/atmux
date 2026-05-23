// ADR-225 Core API tests — addEpic dependsOn / setEpicReady /
// setEpicDependsOn / epicTransitiveDeps / epicIsEligible.
//
// T3 of EPIC e-cf8a6195 (master design task t-802c468b). Covers the
// validation matrix (self / existence / cycle), the toggle path, the
// transitive-walk graceful-skip semantics, and the 4-cell
// eligibility matrix.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  addEpic,
  advanceEpic,
  epicIsEligible,
  epicTransitiveDeps,
  setEpicDependsOn,
  setEpicReady,
} from "../../../src/core/epic.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-core-epic-"));
  // Bootstrap state.db so the `exists` guard at the top of addEpic et al
  // passes. openDatabase walks the full migration ladder.
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  // advanceEpic to `review` dispatches a summary Task to a member whose
  // role is `team-lead` (or alias `lead`). A minimal team.json with such
  // a member keeps the dispatch path happy without surfacing the dispatch
  // logic into these tests' assertions.
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "epic-core-test",
      members: [{ name: "lead", role: "team-lead" }],
    }),
  );
});
afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- addEpic with dependsOn ----------

describe("addEpic — dependsOn validation matrix", () => {
  test("dep-on-existing epic accepted; row inserts cleanly", async () => {
    const a = await addEpic(atmuxDir, { title: "upstream" });
    const b = await addEpic(atmuxDir, { title: "downstream", dependsOn: [a] });
    expect(b).toMatch(/^e-/);
    // Round-trip the dependsOn list back from storage.
    const deps = await epicTransitiveDeps(atmuxDir, b);
    expect(deps).toEqual([a]);
  });

  test("dep-on-already-done epic accepted (no-op semantics)", async () => {
    const a = await addEpic(atmuxDir, { title: "upstream" });
    // Walk a through the state machine to done.
    await advanceEpic(atmuxDir, a, "ready");
    await advanceEpic(atmuxDir, a, "in-progress");
    await advanceEpic(atmuxDir, a, "review");
    await advanceEpic(atmuxDir, a, "done");
    const b = await addEpic(atmuxDir, { title: "downstream", dependsOn: [a] });
    expect(b).toMatch(/^e-/);
  });

  test("self-dep refused (newly-minted id can't be in its own dep list)", async () => {
    // Self-dep at addEpic time is structurally impossible (caller doesn't
    // know the new id until insert completes); we exercise the defense by
    // calling setEpicDependsOn with self instead.
    const a = await addEpic(atmuxDir, { title: "a" });
    await expect(setEpicDependsOn(atmuxDir, a, [a])).rejects.toThrow(/cannot depend on itself/);
  });

  test("non-existent dep refused with explicit typo-protection message", async () => {
    await expect(addEpic(atmuxDir, { title: "x", dependsOn: ["e-doesnotexist"] })).rejects.toThrow(
      /dep e-doesnotexist does not exist/,
    );
  });

  test("2-cycle refused — A depends on B, then setEpicDependsOn(B, [A]) closes it", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await expect(setEpicDependsOn(atmuxDir, a, [b])).rejects.toThrow(/cycle/);
  });

  test("3-cycle refused — A→B→C, then setEpicDependsOn(A, [C])", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const c = await addEpic(atmuxDir, { title: "C", dependsOn: [b] });
    await expect(setEpicDependsOn(atmuxDir, a, [c])).rejects.toThrow(/cycle/);
  });
});

// ---------- setEpicReady ----------

describe("setEpicReady — toggle semantics", () => {
  test("0 → 1 returns from:false, to:true, noop:false", async () => {
    const a = await addEpic(atmuxDir, { title: "x" });
    const r = await setEpicReady(atmuxDir, a, true);
    expect(r).toEqual({ from: false, to: true, noop: false });
  });

  test("1 → 1 returns noop:true", async () => {
    const a = await addEpic(atmuxDir, { title: "x" });
    await setEpicReady(atmuxDir, a, true);
    const r = await setEpicReady(atmuxDir, a, true);
    expect(r.noop).toBe(true);
    expect(r.from).toBe(true);
    expect(r.to).toBe(true);
  });

  test("1 → 0 returns from:true, to:false, noop:false", async () => {
    const a = await addEpic(atmuxDir, { title: "x" });
    await setEpicReady(atmuxDir, a, true);
    const r = await setEpicReady(atmuxDir, a, false);
    expect(r).toEqual({ from: true, to: false, noop: false });
  });

  test("refuses on done epic — is_ready toggle on terminal is meaningless", async () => {
    const a = await addEpic(atmuxDir, { title: "x" });
    await advanceEpic(atmuxDir, a, "ready");
    await advanceEpic(atmuxDir, a, "in-progress");
    await advanceEpic(atmuxDir, a, "review");
    await advanceEpic(atmuxDir, a, "done");
    await expect(setEpicReady(atmuxDir, a, true)).rejects.toThrow(/done epic/);
  });

  test("refuses on missing epic with explicit message", async () => {
    await expect(setEpicReady(atmuxDir, "e-nope", true)).rejects.toThrow(/no such epic/);
  });
});

// ---------- setEpicDependsOn ----------

describe("setEpicDependsOn — same validation matrix as addEpic", () => {
  test("replaces dep list cleanly (no append)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B" });
    const c = await addEpic(atmuxDir, { title: "C", dependsOn: [a] });
    await setEpicDependsOn(atmuxDir, c, [b]);
    expect(await epicTransitiveDeps(atmuxDir, c)).toEqual([b]);
  });

  test("empty list clears all deps", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await setEpicDependsOn(atmuxDir, b, []);
    expect(await epicTransitiveDeps(atmuxDir, b)).toEqual([]);
  });

  test("self-dep refused", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await expect(setEpicDependsOn(atmuxDir, a, [a])).rejects.toThrow(/cannot depend on itself/);
  });

  test("non-existent dep refused", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await expect(setEpicDependsOn(atmuxDir, a, ["e-ghost"])).rejects.toThrow(/does not exist/);
  });

  test("cycle refused (transitive)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const c = await addEpic(atmuxDir, { title: "C", dependsOn: [b] });
    // Setting a.deps = [c] would form a → c → b → a cycle.
    await expect(setEpicDependsOn(atmuxDir, a, [c])).rejects.toThrow(/cycle/);
  });

  test("refuses on missing target epic", async () => {
    await expect(setEpicDependsOn(atmuxDir, "e-ghost", [])).rejects.toThrow(/no such epic/);
  });
});

// ---------- epicTransitiveDeps ----------

describe("epicTransitiveDeps — BFS walk semantics", () => {
  test("3-level chain returns the full transitive set", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const c = await addEpic(atmuxDir, { title: "C", dependsOn: [b] });
    const deps = await epicTransitiveDeps(atmuxDir, c);
    expect(deps.sort()).toEqual([a, b].sort());
  });

  test("excludes the seed id itself per the AC", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const deps = await epicTransitiveDeps(atmuxDir, b);
    expect(deps).not.toContain(b);
  });

  test("dangling ref gracefully skipped (render-side concern, not walk-time)", async () => {
    // Bypass the eager validator by writing a dangling ref directly via
    // the repo. We do so by addEpic'ing a downstream with a real dep,
    // then promoting the missing-ref state via a raw DB write.
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    // Open the DB raw + UPDATE b.depends_on to point at a non-existent
    // epic (simulates an epic deletion that bypassed integrity).
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    db.prepare("UPDATE epics SET depends_on = ? WHERE id = ?").run(
      JSON.stringify(["e-ghost", a]),
      b,
    );
    closeDatabase(db);
    // Walk tolerates the dangling — returns the non-dangling deps only.
    const deps = await epicTransitiveDeps(atmuxDir, b);
    // 'e-ghost' is included in the walk-result set (it's an id we
    // visited), but the walk doesn't throw on it; the further-walk
    // from e-ghost is empty (no epic row to read).
    expect(deps.sort()).toEqual(["e-ghost", a].sort());
  });

  test("empty deps returns []", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const deps = await epicTransitiveDeps(atmuxDir, a);
    expect(deps).toEqual([]);
  });
});

// ---------- epicIsEligible — 4-cell matrix ----------

describe("epicIsEligible — (deps-done × isReady) matrix", () => {
  // Cell layout for the matrix:
  //   isReady=false, deps unmet         → not eligible
  //   isReady=false, deps met           → not eligible
  //   isReady=true,  deps unmet         → not eligible (blocker on dep)
  //   isReady=true,  deps met           → ELIGIBLE
  //
  // We additionally cover: missing dep + no deps at all + done-status
  // dep as the deps-met signal.

  test("cell 1/4: ready=false + deps unmet → not eligible", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const r = await epicIsEligible(atmuxDir, b);
    expect(r.eligible).toBe(false);
    expect(r.blockers).toContain("is_ready=0");
    expect(r.blockers.some((m) => m.includes(`dep ${a}`))).toBe(true);
  });

  test("cell 2/4: ready=false + deps met → not eligible (still blocked on is_ready)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    // Walk A to done.
    await advanceEpic(atmuxDir, a, "ready");
    await advanceEpic(atmuxDir, a, "in-progress");
    await advanceEpic(atmuxDir, a, "review");
    await advanceEpic(atmuxDir, a, "done");
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    const r = await epicIsEligible(atmuxDir, b);
    expect(r.eligible).toBe(false);
    expect(r.blockers).toEqual(["is_ready=0"]);
  });

  test("cell 3/4: ready=true + deps unmet → not eligible (dep blocker)", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await setEpicReady(atmuxDir, b, true);
    const r = await epicIsEligible(atmuxDir, b);
    expect(r.eligible).toBe(false);
    expect(r.blockers).not.toContain("is_ready=0");
    expect(r.blockers.some((m) => m.includes(`dep ${a} not done`))).toBe(true);
  });

  test("cell 4/4: ready=true + deps met → ELIGIBLE; blockers empty", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await advanceEpic(atmuxDir, a, "ready");
    await advanceEpic(atmuxDir, a, "in-progress");
    await advanceEpic(atmuxDir, a, "review");
    await advanceEpic(atmuxDir, a, "done");
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    await setEpicReady(atmuxDir, b, true);
    const r = await epicIsEligible(atmuxDir, b);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  test("missing dep surfaces in blockers", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await setEpicReady(atmuxDir, a, true);
    // Promote a dangling dep via raw UPDATE.
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    db.prepare("UPDATE epics SET depends_on = ? WHERE id = ?").run(JSON.stringify(["e-ghost"]), a);
    closeDatabase(db);
    const r = await epicIsEligible(atmuxDir, a);
    expect(r.eligible).toBe(false);
    expect(r.blockers).toContain("dep e-ghost missing");
  });

  test("no deps + ready=true → eligible", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await setEpicReady(atmuxDir, a, true);
    const r = await epicIsEligible(atmuxDir, a);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  test("no such epic returns non-eligible + descriptive blocker", async () => {
    const r = await epicIsEligible(atmuxDir, "e-ghost");
    expect(r.eligible).toBe(false);
    expect(r.blockers[0]).toMatch(/not found/);
  });
});
