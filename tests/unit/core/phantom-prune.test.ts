// Unit tests for src/core/phantom-prune.ts (t-af159454).
//
// Coverage:
//   - findPhantomInProgressClaims: dead-owner → flagged, live-owner →
//     skipped, empty-owner → skipped, no in-progress rows → [].
//   - prunePhantomInProgressClaims: flips status + note, returns the
//     pruned ids, idempotent re-call short-circuits on the
//     `auto-pruned` prefix.
//   - formatPruneIso: drops the ms component.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, claimTask, listTasks, showTask } from "../../../src/core/kanban.ts";
import {
  findPhantomInProgressClaims,
  formatPruneIso,
  prunePhantomInProgressClaims,
} from "../../../src/core/phantom-prune.ts";
import type { Team } from "../../../src/schema/team.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-phantom-prune-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "tt",
      members: [
        { name: "alpha", role: "member" },
        { name: "beta", role: "member" },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

function makeTeam(memberNames: string[]): Team {
  return {
    name: "tt",
    members: memberNames.map((n) => ({ name: n, role: "member" })),
  } as Team;
}

async function seedAndClaim(opts: {
  subject: string;
  owner: string;
}): Promise<string> {
  const id = await addTask(atmuxDir, { subject: opts.subject, assignee: opts.owner });
  // addTask creates `status='todo'` — flip to in-progress via direct task
  // move so the phantom detector sees it.
  const { moveTask } = await import("../../../src/core/kanban.ts");
  await moveTask(atmuxDir, id, "in-progress");
  return id;
}

// ---------- findPhantomInProgressClaims ----------

describe("findPhantomInProgressClaims", () => {
  test("empty kanban → []", async () => {
    const team = makeTeam(["alpha", "beta"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(["alpha", "beta"]),
    });
    expect(got).toEqual([]);
  });

  test("in-progress row with live owner → not flagged", async () => {
    await seedAndClaim({ subject: "alpha row", owner: "alpha" });
    const team = makeTeam(["alpha", "beta"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(["alpha", "beta"]),
    });
    expect(got).toEqual([]);
  });

  test("in-progress row with dead owner → flagged", async () => {
    const id = await seedAndClaim({ subject: "alpha row", owner: "alpha" });
    const team = makeTeam(["alpha", "beta"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(["beta"]), // alpha pane dead
    });
    expect(got.map((p) => p.id)).toEqual([id]);
    expect(got[0]?.owner).toBe("alpha");
    expect(got[0]?.subject).toBe("alpha row");
  });

  test("multiple in-progress — partitions by liveness", async () => {
    const alphaId = await seedAndClaim({ subject: "a", owner: "alpha" });
    const betaId = await seedAndClaim({ subject: "b", owner: "beta" });
    const team = makeTeam(["alpha", "beta"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(["alpha"]), // only alpha live
    });
    expect(got.map((p) => p.id)).toEqual([betaId]);
    expect(alphaId).not.toEqual(betaId);
  });

  test("todo rows ignored (not in-progress)", async () => {
    // Direct addTask leaves status='todo' — should NOT be flagged.
    await addTask(atmuxDir, { subject: "todo row", assignee: "alpha" });
    const team = makeTeam(["alpha", "beta"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set([]), // no one live
    });
    expect(got).toEqual([]);
  });

  test("in-progress with empty/null owner → skipped (no phantom claim if no owner)", async () => {
    // Stage an in-progress row with no owner via direct kanban manipulation.
    const id = await addTask(atmuxDir, { subject: "ownerless" });
    const { moveTask } = await import("../../../src/core/kanban.ts");
    await moveTask(atmuxDir, id, "in-progress");
    const team = makeTeam(["alpha"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(["alpha"]),
    });
    expect(got).toEqual([]);
  });
});

// ---------- prunePhantomInProgressClaims ----------

describe("prunePhantomInProgressClaims", () => {
  test("flips status → blocked + writes auto-pruned note", async () => {
    const id = await seedAndClaim({ subject: "a", owner: "alpha" });
    const result = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [{ id, owner: "alpha", subject: "a" }],
      asOfIso: "2026-05-13T15:57:42Z",
      source: "doctor-fix",
    });
    expect(result.prunedIds).toEqual([id]);
    expect(result.alreadyPrunedIds).toEqual([]);
    const after = await showTask(atmuxDir, id);
    expect(after?.status).toBe("blocked");
    expect(after?.note).toBe("auto-pruned at 2026-05-13T15:57:42Z via doctor-fix");
  });

  test("session-stop source surfaces in the note", async () => {
    const id = await seedAndClaim({ subject: "a", owner: "alpha" });
    await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [{ id, owner: "alpha", subject: "a" }],
      asOfIso: "2026-05-13T15:57:42Z",
      source: "session-stop",
    });
    const after = await showTask(atmuxDir, id);
    expect(after?.note).toBe("auto-pruned at 2026-05-13T15:57:42Z via session-stop");
  });

  test("idempotency — second call on same id returns alreadyPruned", async () => {
    const id = await seedAndClaim({ subject: "a", owner: "alpha" });
    const r1 = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [{ id, owner: "alpha", subject: "a" }],
      asOfIso: "2026-05-13T15:57:42Z",
      source: "doctor-fix",
    });
    expect(r1.prunedIds).toEqual([id]);
    // Re-run with the same phantom set (real-world: doctor --fix
    // re-invoked while the kanban still carries the auto-pruned row).
    const r2 = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [{ id, owner: "alpha", subject: "a" }],
      asOfIso: "2026-05-13T16:00:00Z",
      source: "doctor-fix",
    });
    expect(r2.prunedIds).toEqual([]);
    expect(r2.alreadyPrunedIds).toEqual([id]);
    // The note should still carry the FIRST timestamp — idempotent
    // means we don't re-write.
    const after = await showTask(atmuxDir, id);
    expect(after?.note).toBe("auto-pruned at 2026-05-13T15:57:42Z via doctor-fix");
  });

  test("partitions pruned vs already-pruned across the input set", async () => {
    const aId = await seedAndClaim({ subject: "a", owner: "alpha" });
    const bId = await seedAndClaim({ subject: "b", owner: "beta" });
    // Prune just `a` first.
    await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [{ id: aId, owner: "alpha", subject: "a" }],
      asOfIso: "2026-05-13T15:57:42Z",
      source: "doctor-fix",
    });
    // Second call covers BOTH — a is already-pruned, b is new.
    const r2 = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [
        { id: aId, owner: "alpha", subject: "a" },
        { id: bId, owner: "beta", subject: "b" },
      ],
      asOfIso: "2026-05-13T16:00:00Z",
      source: "session-stop",
    });
    expect(r2.prunedIds).toEqual([bId]);
    expect(r2.alreadyPrunedIds).toEqual([aId]);
  });

  test("empty phantoms input → empty result", async () => {
    const r = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [],
      asOfIso: "2026-05-13T15:57:42Z",
      source: "doctor-fix",
    });
    expect(r.prunedIds).toEqual([]);
    expect(r.alreadyPrunedIds).toEqual([]);
  });
});

// ---------- end-to-end: detect → prune ----------

describe("phantom-prune end-to-end", () => {
  test("detect → prune → re-detect returns empty", async () => {
    const id = await seedAndClaim({ subject: "alpha row", owner: "alpha" });
    const team = makeTeam(["alpha"]);
    const liveMembers = async () => new Set<string>(); // pane dead

    const before = await findPhantomInProgressClaims({ atmuxDir, team, liveMembers });
    expect(before.map((p) => p.id)).toEqual([id]);

    await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: before,
      asOfIso: "2026-05-13T15:57:42Z",
      source: "doctor-fix",
    });

    const after = await findPhantomInProgressClaims({ atmuxDir, team, liveMembers });
    expect(after).toEqual([]);
  });

  test("seeded run mirrors the c-368c375b incident shape (5 stuck IDs)", async () => {
    // Five members each holding an orphan in-progress claim, none with
    // a live pane. Matches the 2026-05-08 complaint that motivated this
    // task (5 cited phantom IDs).
    const seedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      seedIds.push(
        await seedAndClaim({ subject: `incident ${i}`, owner: `ghost${i}` }),
      );
    }
    const team = makeTeam(["ghost0", "ghost1", "ghost2", "ghost3", "ghost4"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(), // every pane dead
    });
    expect(got).toHaveLength(5);
    const result = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: got,
      asOfIso: "2026-05-13T15:57:42Z",
      source: "session-stop",
    });
    expect(result.prunedIds).toHaveLength(5);
    // Every row now `blocked`.
    const stillInProgress = await listTasks(atmuxDir, { status: "in-progress" });
    expect(stillInProgress).toHaveLength(0);
    const blocked = await listTasks(atmuxDir, { status: "blocked" });
    expect(blocked.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------- findPhantomInProgressClaims — t-d6fc03a7 age filter ----------

describe("findPhantomInProgressClaims — minAgeSec filter (t-d6fc03a7)", () => {
  /** Seed a row via the real `claimTask` so `claimedAt` is populated.
   *  Returns the captured `claimedAt` so tests can do deterministic
   *  age arithmetic without freezing the system clock. */
  async function seedAndRealClaim(opts: {
    subject: string;
    owner: string;
  }): Promise<{ id: string; claimedAt: number }> {
    const id = await addTask(atmuxDir, { subject: opts.subject, assignee: opts.owner });
    const { post } = await claimTask(atmuxDir, id, opts.owner);
    const claimedAt = post.claimedAt;
    if (claimedAt === null || claimedAt === undefined) {
      throw new Error("test seed: claimTask did not stamp claimedAt");
    }
    return { id, claimedAt };
  }

  test("minAgeSec omitted → no filtering (existing behaviour preserved)", async () => {
    const { id } = await seedAndRealClaim({ subject: "a", owner: "alpha" });
    const team = makeTeam(["alpha"]);
    // No minAgeSec — every dead-owner phantom returned regardless of age.
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(),
    });
    expect(got.map((p) => p.id)).toEqual([id]);
  });

  test("minAgeSec=86400 + claim within window → filtered out", async () => {
    const { id, claimedAt } = await seedAndRealClaim({ subject: "a", owner: "alpha" });
    const team = makeTeam(["alpha"]);
    // nowSec = claimedAt + 100s (fresh claim, well inside 24h window).
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(),
      minAgeSec: 86_400,
      nowSec: claimedAt + 100,
    });
    expect(got).toEqual([]);
    // Sanity: without the filter, the same row IS reported as phantom.
    const unfiltered = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(),
      nowSec: claimedAt + 100,
    });
    expect(unfiltered.map((p) => p.id)).toEqual([id]);
  });

  test("minAgeSec=86400 + claim past window → returned", async () => {
    const { id, claimedAt } = await seedAndRealClaim({ subject: "a", owner: "alpha" });
    const team = makeTeam(["alpha"]);
    // 25h later — past the 24h gate.
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(),
      minAgeSec: 86_400,
      nowSec: claimedAt + 90_000,
    });
    expect(got.map((p) => p.id)).toEqual([id]);
  });

  test("claimedAt=null (legacy row) → kept regardless of filter (fail-safe toward pruning)", async () => {
    // addTask + moveTask does NOT stamp claimedAt — mirrors the
    // legacy / pre-claim-stamp shape `findPhantomInProgressClaims`
    // must still flag, since the only way to reach in-progress
    // without a claimedAt is data drift on a stale row.
    const id = await seedAndClaim({ subject: "legacy", owner: "alpha" });
    const team = makeTeam(["alpha"]);
    const got = await findPhantomInProgressClaims({
      atmuxDir,
      team,
      liveMembers: async () => new Set(),
      minAgeSec: 86_400,
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(got.map((p) => p.id)).toEqual([id]);
  });

  test("hygiene-tick source carries through prune note", async () => {
    const id = await seedAndClaim({ subject: "a", owner: "alpha" });
    const r = await prunePhantomInProgressClaims({
      atmuxDir,
      phantoms: [{ id, owner: "alpha", subject: "a" }],
      asOfIso: "2026-05-15T03:00:00Z",
      source: "hygiene-tick",
    });
    expect(r.prunedIds).toEqual([id]);
    const after = await showTask(atmuxDir, id);
    expect(after?.note).toBe("auto-pruned at 2026-05-15T03:00:00Z via hygiene-tick");
  });
});

// ---------- formatPruneIso ----------

describe("formatPruneIso", () => {
  test("drops millisecond component", () => {
    // 2026-05-13T15:57:42.123Z → 2026-05-13T15:57:42Z
    const ms = Date.UTC(2026, 4, 13, 15, 57, 42, 123);
    expect(formatPruneIso(ms)).toBe("2026-05-13T15:57:42Z");
  });

  test("epoch 0 → 1970-01-01T00:00:00Z", () => {
    expect(formatPruneIso(0)).toBe("1970-01-01T00:00:00Z");
  });
});

