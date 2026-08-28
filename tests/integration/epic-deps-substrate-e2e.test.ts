// ADR-225 end-to-end smoke — exercises the full v13→v14 substrate
// from migration through CLI verbs through the eligibility gate
// through Honker events. T7 of EPIC e-cf8a6195 (master design task
// t-802c468b).
//
// Single integration spec covering the canonical 3-epic chain.
// Closes the gaps between unit tests (which exercise each layer in
// isolation).
//
// SCOPE, after ADR-280 stage 4. The kanban Epic WORK ITEM survives the
// epic-TEAM retirement — `core/epic.ts` + `verbs/epic.ts` are
// internal-kanban surfaces that ADR-280 §D5 leaves under ADR-275's gate,
// so every dependency/eligibility/event assertion below is still live
// coverage of shipping code. What left with stage 3 is the CONSUMER that
// used to read the gate: `atmux team spawn-epic`. The gate itself,
// `epicIsEligible` (ADR-225 §Eligibility), is unchanged and is now
// asserted DIRECTLY rather than through the deleted verb — same
// property, one fewer layer. Deleting these cases instead would have
// dropped the only integration-level coverage of the dep chain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import {
  addEpic,
  advanceEpic,
  epicIsEligible,
  setEpicReady,
  showEpic,
} from "../../src/core/epic.ts";
import { epic } from "../../src/verbs/epic.ts";

let scratch: string;
let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-deps-e2e-"));
  teamDir = join(scratch, "parent-team");
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  // Bootstrap v0→v14 ladder.
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  // team.json with a lead so advanceEpic→review dispatch succeeds.
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "parent-team",
      members: [{ name: "lead", role: "team-lead" }],
    }),
  );
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Capture process.stdout into a string for the duration of fn. */
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

/** Read every row from the `events` table for assertions. */
function readEvents(): Array<{
  topic: string;
  payload: Record<string, unknown>;
}> {
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  try {
    const rows = db
      .prepare("SELECT topic, payload FROM events ORDER BY emitted_at_sec ASC, event_id ASC")
      .all() as Array<{ topic: string; payload: string }>;
    return rows.map((r) => ({
      topic: r.topic,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  } finally {
    closeDatabase(db);
  }
}

describe("ADR-225 substrate — 3-epic chain end-to-end", () => {
  test("happy path: chain A→B→C; epic.ready + epic.unblocked fire as deps clear; eligibility gate refuses then permits", async () => {
    // ---------- 1. Build the chain: A deps_on [B], B deps_on [C], C leaf.
    const c = await addEpic(atmuxDir, { title: "C" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [c] });
    const a = await addEpic(atmuxDir, { title: "A", dependsOn: [b] });

    // ---------- 2. `atmux epic list` shows R + D columns correctly.
    const { out: listOut } = await captureStdout(async () => {
      return await epic(["list", "--team-dir", teamDir]);
    });
    // C has no deps → D=`-`. B has 1 dep (c, planning) → D=0/1. A
    // has 1 dep (b, planning) → D=0/1. R=0 for all (none ready).
    const cLine = listOut.split("\n").find((l) => l.startsWith(c));
    const bLine = listOut.split("\n").find((l) => l.startsWith(b));
    const aLine = listOut.split("\n").find((l) => l.startsWith(a));
    expect(cLine).toMatch(/\s0\s+-\s/);
    expect(bLine).toMatch(/\s0\s+0\/1\s/);
    expect(aLine).toMatch(/\s0\s+0\/1\s/);

    // ---------- 3. `atmux epic deps A` renders the 3-level tree.
    const { out: depsOut } = await captureStdout(async () => {
      return await epic(["deps", a, "--team-dir", teamDir]);
    });
    expect(depsOut).toContain(a);
    expect(depsOut).toContain(`  ${b}`);
    expect(depsOut).toContain(`    ${c}`);

    // ---------- 4. Eligibility gate on A — refused, and it names BOTH
    //              blockers (is_ready=0 AND the unmet dep).
    const gate0 = await epicIsEligible(atmuxDir, a);
    expect(gate0.eligible).toBe(false);
    expect(gate0.blockers).toContain("is_ready=0");
    expect(gate0.blockers.some((x) => x.startsWith(`dep ${b} not done`))).toBe(true);

    // ---------- 5. `epic ready A` → epic.ready event lands.
    await setEpicReady(atmuxDir, a, true);
    const eventsAfterReady = readEvents().filter((e) => e.topic === "epic.ready");
    expect(eventsAfterReady).toHaveLength(1);
    expect(eventsAfterReady[0]?.payload.epicId).toBe(a);

    // A is still ineligible — is_ready=1 now, but the dep is unmet, so
    // `is_ready=0` drops off the blocker list and the dep blocker stays.
    const gate1 = await epicIsEligible(atmuxDir, a);
    expect(gate1.eligible).toBe(false);
    expect(gate1.blockers).not.toContain("is_ready=0");
    expect(gate1.blockers.some((x) => x.startsWith(`dep ${b} not done`))).toBe(true);

    // ---------- 6. Advance C to done — at THIS layer, A's deps include
    //              only B (not C); B is still planning + B's own deps
    //              just cleared. So no epic.unblocked for A. Per the
    //              ADR §OQ-4: emit only on the LAST unmet dep transition.
    //              The chain's transitive substrate cares about A's
    //              direct deps only.
    await advanceEpic(atmuxDir, c, "ready");
    await advanceEpic(atmuxDir, c, "in-progress");
    await advanceEpic(atmuxDir, c, "review");
    await advanceEpic(atmuxDir, c, "done");
    // B's deps just cleared (C went done) → emit epic.unblocked FOR B
    // (byEpicId=C). A is NOT yet unblocked because B is still planning.
    const evsAfterC = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(evsAfterC).toHaveLength(1);
    expect(evsAfterC[0]?.payload.epicId).toBe(b);
    expect(evsAfterC[0]?.payload.byEpicId).toBe(c);

    // ---------- 7. `epic ready B` → epic.ready for B.
    await setEpicReady(atmuxDir, b, true);
    const readyEvents = readEvents().filter((e) => e.topic === "epic.ready");
    expect(readyEvents.length).toBe(2);
    expect(readyEvents.map((e) => e.payload.epicId as string).sort()).toEqual([a, b].sort());

    // ---------- 8. Advance B to done — A's last unmet dep clears.
    //              epic.unblocked fires for A with byEpicId=B.
    await advanceEpic(atmuxDir, b, "ready");
    await advanceEpic(atmuxDir, b, "in-progress");
    await advanceEpic(atmuxDir, b, "review");
    await advanceEpic(atmuxDir, b, "done");
    const evsAfterB = readEvents().filter((e) => e.topic === "epic.unblocked");
    expect(evsAfterB.length).toBe(2);
    const aUnblocked = evsAfterB.find((e) => e.payload.epicId === a);
    expect(aUnblocked).toBeDefined();
    expect(aUnblocked?.payload.byEpicId).toBe(b);

    // ---------- 9. A is now ELIGIBLE: is_ready=1 + every direct dep done.
    //              This is the transition the gate exists to express.
    const gate2 = await epicIsEligible(atmuxDir, a);
    expect(gate2.eligible).toBe(true);
    expect(gate2.blockers).toEqual([]);
  });

  // ADR-280 stage 4: the former "`--force` on ineligible epic spawns +
  // writes override log line" case drove the deleted `spawn-epic` verb and
  // its `spawn-overrides.log`. The verb is gone and `core/spawn-override.ts`
  // is now caller-less (reported, not deleted — ADR-276/275 own it). What
  // the case actually pinned at THIS layer is the gate's blocker report on
  // a dep-free but unready epic, which is kept:
  test("a dep-free but unready epic is ineligible, and `is_ready=0` is its only blocker", async () => {
    const e = await addEpic(atmuxDir, { title: "draft" });
    expect((await showEpic(atmuxDir, e))?.isReady).toBe(false);

    const gate = await epicIsEligible(atmuxDir, e);
    expect(gate.eligible).toBe(false);
    expect(gate.blockers).toEqual(["is_ready=0"]);

    // Marking it ready clears the sole blocker — no deps to satisfy.
    await setEpicReady(atmuxDir, e, true);
    const after = await epicIsEligible(atmuxDir, e);
    expect(after.eligible).toBe(true);
    expect(after.blockers).toEqual([]);
  });
});

describe("ADR-225 validation matrix smoke", () => {
  test("`atmux epic add --depends-on e-NONEXISTENT` refused with typo-protection message", async () => {
    await expect(
      epic(["add", "--team-dir", teamDir, "X", "--depends-on", "e-nonexistent"]),
    ).rejects.toThrow(/does not exist/);
  });

  test("self-dep refused via `atmux epic set-depends-on`", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    await expect(epic(["set-depends-on", a, a, "--team-dir", teamDir])).rejects.toThrow(
      /cannot depend on itself/,
    );
  });

  test("2-cycle refused via `atmux epic set-depends-on`", async () => {
    const a = await addEpic(atmuxDir, { title: "A" });
    const b = await addEpic(atmuxDir, { title: "B", dependsOn: [a] });
    // Closing the loop A→B via set-depends-on creates a 2-cycle.
    await expect(epic(["set-depends-on", a, b, "--team-dir", teamDir])).rejects.toThrow(/cycle/);
  });
});
