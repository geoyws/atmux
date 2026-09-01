// Concurrent-claim regression test for src/core/kanban.ts (t-254a34da,
// EPIC e-829fcfd0 / ADR-210 TIER 2, slice S4 PREREQUISITE).
//
// AUDIT FINDING: the kanban claim lock IS robust. `claimTask`
// (src/core/kanban.ts:967) runs the read-check-flip inside
// `transactImmediate` (BEGIN IMMEDIATE), and the in-progress-owner gate
// (`refuseInProgressOther`) was deliberately folded INSIDE that
// transaction (kanban.ts:989-997) to close the former
// `claimTaskForMember` check-then-act TOCTOU. The `claim --next` verb
// routes through `claimTaskForMember` (src/verbs/claim.ts), so a racing
// member loses cleanly. No source fix is required — this file is the
// explicitly-required NEW regression test that PROVES the property.
//
// Scenario (S5 dispatch-timeout race): two (or N) members hit
// T_DISPATCH_TIMEOUT simultaneously and both call `claim --next` against
// the SAME todo task. The first claimant must win; every other must see
// the task as in-progress under a different owner and skip with the
// ADR-085 refuse message. NEVER a silent double-claim (that would
// corrupt kanban state).
//
// DB setup mirrors tests/unit/core/kanban-sqlite.test.ts: a per-test
// tmpdir `.atmux/` with a pre-created `state.db` on the canonical
// migration ladder so `_useSqlite()` returns true and the BEGIN
// IMMEDIATE path runs. Each `claimTaskForMember` call opens its OWN
// connection (per-call open/close, see kanban.ts:_withDb), so N parallel
// calls genuinely contend on the SQLite write lock — exactly what the
// real concurrent-claim surface does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  addTask,
  claimTaskForMember,
  inProgressOtherRefuseMessage,
  showTask,
} from "../../../src/core/kanban.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

interface TestEnv {
  atmuxDir: string;
}

async function makeEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), "atmux-kanban-concurrent-claim-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  // Pre-create state.db so the dual-path router picks SQLite (the
  // BEGIN IMMEDIATE branch under test).
  const db = openDatabase(join(atmuxDir, "state.db"), migrations);
  closeDatabase(db);
  return { atmuxDir };
}

async function teardown(env: TestEnv): Promise<void> {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
}

/**
 * Settle one claim attempt to a discriminated outcome — keeps the
 * assertions readable AND lets us inspect the failure MESSAGE (not just
 * "it threw"), so a wrong-reason throw (deps / driver-only / no-such-task)
 * can't masquerade as a clean concurrent-loss.
 */
type ClaimOutcome =
  | { kind: "won"; who: string; post: KanbanTask }
  | { kind: "lost"; who: string; message: string };

async function attemptClaim(atmuxDir: string, id: string, who: string): Promise<ClaimOutcome> {
  try {
    const { post } = await claimTaskForMember(atmuxDir, id, who);
    return { kind: "won", who, post };
  } catch (err) {
    return { kind: "lost", who, message: err instanceof Error ? err.message : String(err) };
  }
}

describe("kanban concurrent claim (SQLite BEGIN IMMEDIATE gate)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  test("N parallel claimTaskForMember on one task → exactly 1 wins, N-1 refuse", async () => {
    const id = await addTask(env.atmuxDir, { subject: "race target", lane: "be" });

    const members = ["alice", "bob", "carol", "dave", "erin", "frank"];
    const outcomes = await Promise.all(members.map((m) => attemptClaim(env.atmuxDir, id, m)));

    const won = outcomes.filter(
      (o): o is Extract<ClaimOutcome, { kind: "won" }> => o.kind === "won",
    );
    const lost = outcomes.filter(
      (o): o is Extract<ClaimOutcome, { kind: "lost" }> => o.kind === "lost",
    );

    // Core invariant: exactly one claimant wins; the rest lose.
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(members.length - 1);

    const winner = won[0]!.who;
    expect(won[0]!.post.owner).toBe(winner);
    expect(won[0]!.post.status).toBe("in-progress");

    // Every loser must lose for the RIGHT reason: the ADR-085
    // in-progress-other refuse message naming the actual winner. This is
    // what distinguishes a real concurrent-loss from any other throw —
    // if the gate were broken (e.g. two writers both flipped owner), the
    // losers would instead WIN and this assertion would never even run
    // because `won` would have length > 1.
    for (const l of lost) {
      expect(l.message).toBe(inProgressOtherRefuseMessage(id, winner));
    }
  });

  test("no silent double-claim: persisted owner is exactly the single winner", async () => {
    const id = await addTask(env.atmuxDir, { subject: "single-owner invariant" });

    const members = ["m1", "m2", "m3", "m4"];
    const outcomes = await Promise.all(members.map((m) => attemptClaim(env.atmuxDir, id, m)));

    const winners = outcomes.filter((o) => o.kind === "won");
    expect(winners).toHaveLength(1);

    // Re-read from a FRESH connection (closes the per-call DB each time)
    // and assert the committed row reflects the single winner only — no
    // last-write-wins overwrite by a racing claimant. If two transactions
    // had both flipped the owner, the final persisted owner could be a
    // LOSER, so this catches a silent double-claim that corrupted state.
    const persisted = await showTask(env.atmuxDir, id);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("in-progress");
    const winnerWho = (winners[0] as Extract<ClaimOutcome, { kind: "won" }>).who;
    expect(persisted?.owner).toBe(winnerWho);
  });

  test("the loser's own re-claim of its own in-progress task is idempotent (not refused)", async () => {
    // Guards against an over-broad gate: the refuse fires ONLY for a
    // DIFFERENT owner. The winner re-claiming its own task must succeed,
    // otherwise recovery / retry paths would wedge.
    const id = await addTask(env.atmuxDir, { subject: "self re-claim" });

    const first = await claimTaskForMember(env.atmuxDir, id, "owner-x");
    expect(first.post.owner).toBe("owner-x");
    expect(first.post.status).toBe("in-progress");

    // Same owner re-claims — must NOT throw the in-progress-other refuse.
    const second = await claimTaskForMember(env.atmuxDir, id, "owner-x");
    expect(second.post.owner).toBe("owner-x");
    expect(second.post.status).toBe("in-progress");
  });

  test("a second member claiming an already-claimed task gets the ADR-085 refuse", async () => {
    // Sequential (non-race) variant: proves the message + gate directly,
    // independent of scheduler interleaving in the parallel test above.
    const id = await addTask(env.atmuxDir, { subject: "sequential refuse" });

    await claimTaskForMember(env.atmuxDir, id, "first-owner");

    await expect(claimTaskForMember(env.atmuxDir, id, "second-owner")).rejects.toThrow(
      inProgressOtherRefuseMessage(id, "first-owner"),
    );

    // And the persisted owner is still the first owner — the refused
    // claim left no trace.
    const persisted = await showTask(env.atmuxDir, id);
    expect(persisted?.owner).toBe("first-owner");
  });
});
