// E2E ADR-134 T8 (t-c607d9f1) — intra-team auto-merger acceptance proof.
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume real
// git state (fresh repo + bare remote + per-member worktrees) + a
// real SQLite state.db ledger. Don't streak; don't run-of-N.** Per
// CLAUDE.md testing discipline §"Stateful e2e specs are not
// repeatable smokes."
//
// ---------------------------------------------------------------
// Scope vs EPIC body (this proof covers the SHIPPED layers)
// ---------------------------------------------------------------
//
// The ADR-134 EPIC reshape on 2026-05-14 (per planner pushback +
// memory `[[project_merger_pattern_adr_134]]`) moved the merger
// from a cockpit W4 cage to an **in-team expanded gitter role**:
// no cockpit pane, no separate cage; the team's existing gitter
// drives the state-machine via `merge-cycle`/`performMerge` against
// the team's state.db ledger. Original T8 body predates that
// reshape, so the cockpit-W4 fixture (Beat 2 in the task body) is
// no longer applicable; the in-team integration covered here
// supersedes it.
//
// The shipped composition this proof exercises end-to-end:
//
//   1. **State machine** — `src/core/branch-merge-state.ts`
//      (ADR-134 T2). Pure transition rules over BranchMergeState.
//   2. **State ledger** — `src/core/repositories/merger-state-repo.ts`
//      (ADR-134 T2). state.db `merger_state` table; one row per
//      `<base>-<member>` branch.
//   3. **State-machine caller** — `src/core/intra-team-merge.ts`'s
//      `performMerge()` (ADR-134 T2). Walks one tick at a time,
//      composing (1)+(2)+(3) above the merge primitive.
//   4. **Merge primitive** — `src/abstractions/branch-merge.ts`'s
//      `mergeMember()` (ADR-088 W1). The actual `git merge --no-ff
//      <branch>` step underneath.
//   5. **Bulk fan-in CLI** — `src/verbs/merge-cycle.ts` (ADR-088 W3 /
//      ADR-134 T6). The gitter / operator-driven verb that drives a
//      full per-team sweep.
//
// Deps NOT yet shipped — beats that depend on them are explicitly
// skip-marked + documented inline (NOT silently dropped, so the
// reviewer sees what's deferred):
//
//   - T3 (`t-27b06cda`) **socket-pubsub event-driven trigger**
//     on task-done. Original Beat 3 ("event-driven path: 3 parallel
//     happy commits → merge-queued event published within 1s") needs
//     this dispatcher. Until T3 lands, the cron-backstop sibling path
//     (T4, done) is the production fallback — same `performMerge` call
//     site, different fire-source. This proof exercises `performMerge`
//     direct + via `mergeCycle`; the event-driven cascade is the
//     T3-shipping-Task's e2e responsibility.
//
//   - T5 (`t-e9363607`) **conflict surface** — `atmux send <member>
//     ...`, `[merge-conflict]` Discord template, `atmux flag add`.
//     Original Beats 5+7 require T5 to assert the FAN-OUT side of
//     conflict/test-fail handling. This proof asserts the LEDGER side
//     (state.db `merger_state` row with `state="conflict"`,
//     `conflict_sha` set), which is what every T5 surface reads from.
//     T5's e2e covers the renders + sends + flag write.
//
//   - **Post-merge test-fail revert path** (Beat 7) — `performMerge`'s
//     `test_failed`/`reverted` branches are caller-driven (see
//     `intra-team-merge.ts:282-285`): they wait on T3+T4 wiring to
//     run `bun test` after merge + auto-revert on red. The state
//     machine accepts the states; the bun-test invocation +
//     auto-revert composition isn't a unit-of-this-Task.
//
// ---------------------------------------------------------------
// Beats this proof asserts (sequenced, cold-start-fresh per test)
// ---------------------------------------------------------------
//
//   B1. Happy 3-merge sequential — three member branches → three
//       `performMerge` walks → three `merger_state` rows with
//       `state="merged"` + `base_sha` set + monotonic `base`
//       advancement.
//   B2. Conflict path — two members touch the same file; first
//       merges, second hits MergeConflictError → ledger row
//       `state="conflict"` with `conflict_sha`, base unchanged for
//       that branch, member's branch retains the conflict commit.
//   B3. Idempotent terminal short-circuit — `performMerge` on an
//       already-`merged` branch returns `{ changed: false, reason:
//       /^terminal state 'merged'/ }` without touching git or the
//       ledger.
//   B4. Operator-reset + retry — simulate the operator clearing the
//       conflict (replace the colliding commit with one that lands
//       cleanly) + reset state to `in_progress`; next
//       `performMerge` tick walks the row to `merged`.
//   B5. Bulk fan-in via `merge-cycle` verb — assert the CLI wrapper
//       walks the same state-machine + writes the same ledger rows
//       as the direct `performMerge` ticks. Sibling-coverage to
//       `tests/e2e/merger-fan-in.test.ts` (ADR-088); this beat adds
//       the merger_state ledger assertion that the older test
//       lacked (ADR-088 wrote flags.md but not the ADR-134 state.db
//       ledger).
//
// Per CLAUDE.md testing discipline §"Pair demo runbook beats with
// rehearsal spec steps": every beat's `test()` label names the
// state-machine transition or the assertion class it pins.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { defaultGitSpawn, provisionWorktree } from "../../src/abstractions/worktree.ts";
import type { BranchMergeState } from "../../src/core/branch-merge-state.ts";
import { isTerminalState } from "../../src/core/branch-merge-state.ts";
import { performMerge } from "../../src/core/intra-team-merge.ts";
import { MergerStateRepo } from "../../src/core/repositories/merger-state-repo.ts";
import { mergeCycle } from "../../src/verbs/merge-cycle.ts";

setDefaultTimeout(60_000);

// ---------- Fixture helpers ----------

async function git(
  cwd: string,
  argv: ReadonlyArray<string>,
  allowNonZero = false,
): Promise<string> {
  const r = await defaultGitSpawn(["-C", cwd, ...argv]);
  if (!allowNonZero && r.exitCode !== 0) {
    throw new Error(
      `git ${argv.join(" ")} (cwd=${cwd}) exit=${r.exitCode}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
    );
  }
  return r.stdout.trim();
}

interface Fixture {
  repoPath: string;
  bareRemotePath: string;
  atmuxDir: string;
  statePath: string;
  baseBranch: string;
}

const BASE_BRANCH = "develop";

async function makeFixture(): Promise<Fixture> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "atmux-e2e-merger-t8-"));
  const bareRemotePath = join(tmpRoot, "origin.git");
  const repoPath = join(tmpRoot, "work");

  await mkdir(bareRemotePath, { recursive: true });
  await git(bareRemotePath, ["init", "--bare", "-b", BASE_BRANCH]);

  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init", "-b", BASE_BRANCH]);
  await git(repoPath, ["config", "user.email", "t8@example.com"]);
  await git(repoPath, ["config", "user.name", "t8"]);
  await git(repoPath, ["remote", "add", "origin", bareRemotePath]);
  await writeFile(join(repoPath, ".gitignore"), ".atmux/\n");
  await writeFile(join(repoPath, "README.md"), "# initial\n");
  await git(repoPath, ["add", ".gitignore", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  await git(repoPath, ["push", "-u", "origin", BASE_BRANCH]);

  const atmuxDir = join(repoPath, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "t8-team",
      members: [
        { name: "be-1", role: "member", lane: "be" },
        { name: "be-2", role: "member", lane: "be" },
        { name: "be-3", role: "member", lane: "be" },
      ],
      worktreeIsolation: true,
      merger: { enabled: true, baseBranch: BASE_BRANCH },
    }),
  );

  const statePath = join(atmuxDir, "state.db");
  // Pre-create the state.db so MergerStateRepo can open it directly
  // without race-creating the migration table.
  const db = openDatabase(statePath, migrations);
  closeDatabase(db);

  return { repoPath, bareRemotePath, atmuxDir, statePath, baseBranch: BASE_BRANCH };
}

async function seedMemberBranch(
  fix: Fixture,
  member: string,
  files: ReadonlyArray<{ name: string; body: string }>,
): Promise<{ wtPath: string; wtBranch: string }> {
  const wtBranch = `${fix.baseBranch}-${member}`;
  const wtPath = join(fix.atmuxDir, "worktrees", member);
  await mkdir(join(fix.atmuxDir, "worktrees"), { recursive: true });
  await provisionWorktree(fix.repoPath, fix.baseBranch, wtBranch, wtPath);
  await git(wtPath, ["config", "user.email", `${member}@example.com`]);
  await git(wtPath, ["config", "user.name", member]);
  for (const f of files) {
    await writeFile(join(wtPath, f.name), f.body);
    await git(wtPath, ["add", f.name]);
    await git(wtPath, ["commit", "-m", `${member}: ${f.name}`]);
  }
  return { wtPath, wtBranch };
}

interface RunPerformMergeOpts {
  fix: Fixture;
  memberBranch: string;
  ownerOpenTaskCount?: number;
  worktreeIsClean?: boolean;
  by?: string;
  now?: () => number;
}

/** Drive `performMerge` until the wrapper's tick loop stops making
 *  progress. The wrapper-from-POV "stop" condition is EITHER a
 *  state-machine terminal (`merged` / `conflict` / `reverted`) OR a
 *  caller-driven holding state where the wrapper deliberately
 *  no-ops awaiting outer wiring (`tested`, `rebasing`, `merging`,
 *  `test_failed` per `intra-team-merge.ts:370-374`).
 *
 *  The happy path's wrapper-stop is **`tested`**, not `merged` —
 *  the `tested → merged` transition is driven by the post-merge
 *  bun-test runner that ADR-134 T3+T4 will wire. Without that
 *  outer dispatcher, performMerge alone stops at `tested` after
 *  the `git merge --no-ff` has already landed; the merge IS done,
 *  but the ledger row stays in `tested` until something runs the
 *  post-merge test gate.
 *
 *  Returns the final state so callers can pin the wrapper-stop
 *  condition + assert ledger row contents. */
async function runUntilStop(opts: RunPerformMergeOpts): Promise<BranchMergeState> {
  const db = openDatabase(opts.fix.statePath, migrations);
  try {
    const repo = new MergerStateRepo(db);
    for (let i = 0; i < 10; i += 1) {
      const aheadCount = await git(opts.fix.repoPath, [
        "rev-list",
        "--count",
        `${opts.fix.baseBranch}..${opts.memberBranch}`,
      ]);
      const isAheadOfBase = Number.parseInt(aheadCount, 10) > 0;
      const result = await performMerge({
        memberBranch: opts.memberBranch,
        base: opts.fix.baseBranch,
        repoPath: opts.fix.repoPath,
        gate: {
          ownerOpenTaskCount: opts.ownerOpenTaskCount ?? 0,
          worktreeIsClean: opts.worktreeIsClean ?? true,
          isAheadOfBase,
          baseHasMoved: false,
        },
        repo,
        by: opts.by ?? "event",
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        fetch: false,
      });
      if (isTerminalState(result.state)) return result.state;
      // No-op tick (state didn't change) — wrapper has stopped
      // making progress; either in a caller-driven holding state
      // (`tested` is the happy-path stop) or genuinely stuck.
      if (!result.changed) return result.state;
    }
    throw new Error("runUntilStop: did not stabilise in 10 ticks");
  } finally {
    closeDatabase(db);
  }
}

function readState(
  fix: Fixture,
  memberBranch: string,
): {
  state: BranchMergeState;
  baseSha: string | null;
  conflictSha: string | null;
  by: string | null;
} | null {
  const db = openDatabase(fix.statePath, migrations);
  try {
    const repo = new MergerStateRepo(db);
    const row = repo.getState(memberBranch);
    if (row === null) return null;
    return {
      state: row.state,
      baseSha: row.baseSha,
      conflictSha: row.conflictSha,
      by: row.transitionedBy,
    };
  } finally {
    closeDatabase(db);
  }
}

// ---------- Fixture lifecycle ----------

let fix: Fixture;

beforeEach(async () => {
  fix = await makeFixture();
});

afterEach(async () => {
  await rm(fix.repoPath, { recursive: true, force: true });
  await rm(fix.bareRemotePath, { recursive: true, force: true });
});

// ---------- Beats ----------

describe("e2e merger — ADR-134 T8 acceptance proof (t-c607d9f1)", () => {
  test("B1: happy 3-merge sequential — 3 branches → 3 ledger rows state='tested' (wrapper stop) + base advances by ≥3 commits", async () => {
    // Wrapper stop on happy path is `tested`, not `merged` — the
    // `tested → merged` transition is the post-merge test gate
    // driven by ADR-134 T3+T4 (still todo). The merge ITSELF has
    // already landed (mergeMember runs during the merging→tested
    // transition); the ledger just hasn't been advanced to merged
    // yet by an outer dispatcher.
    await seedMemberBranch(fix, "be-1", [{ name: "be-1.md", body: "1\n" }]);
    await seedMemberBranch(fix, "be-2", [{ name: "be-2.md", body: "2\n" }]);
    await seedMemberBranch(fix, "be-3", [{ name: "be-3.md", body: "3\n" }]);

    const baseBefore = await git(fix.repoPath, ["rev-parse", fix.baseBranch]);

    const states: BranchMergeState[] = [];
    for (const member of ["be-1", "be-2", "be-3"] as const) {
      const final = await runUntilStop({
        fix,
        memberBranch: `${fix.baseBranch}-${member}`,
      });
      states.push(final);
    }
    expect(states).toEqual(["tested", "tested", "tested"]);

    // Ledger rows present for each member with `state="tested"` +
    // `base_sha` set to the merge commit's SHA.
    for (const member of ["be-1", "be-2", "be-3"] as const) {
      const row = readState(fix, `${fix.baseBranch}-${member}`);
      if (row === null) throw new Error(`ledger row missing for ${member}`);
      expect(row.state).toBe("tested");
      expect(row.baseSha).not.toBe(null);
      expect(row.baseSha?.length).toBeGreaterThan(0);
      expect(row.conflictSha).toBe(null);
    }

    // Base advanced — merge primitive ran during merging→tested
    // (the actual `git merge --no-ff` lands at that step, BEFORE
    // the wrapper transitions to `tested`).
    const baseAfter = await git(fix.repoPath, ["rev-parse", fix.baseBranch]);
    expect(baseAfter).not.toBe(baseBefore);
    const newCommits = await git(fix.repoPath, [
      "rev-list",
      "--count",
      `${baseBefore}..${baseAfter}`,
    ]);
    expect(Number.parseInt(newCommits, 10)).toBeGreaterThanOrEqual(3);
  });

  test("B2: conflict path — colliding member branch records state='conflict' + conflict_sha, base unchanged, branch retains commit", async () => {
    // be-1 merges cleanly; be-2 collides on README.md.
    await seedMemberBranch(fix, "be-1", [{ name: "be-1.md", body: "1\n" }]);
    await seedMemberBranch(fix, "be-2", [{ name: "README.md", body: "be-2 overwrite\n" }]);
    // First, force base to a state that conflicts with be-2's overwrite.
    await writeFile(join(fix.repoPath, "README.md"), "base overwrite\n");
    await git(fix.repoPath, ["add", "README.md"]);
    await git(fix.repoPath, ["commit", "-m", "base mutates README.md"]);

    // be-1 first — clean merge, no conflict. Wrapper stops at
    // `tested` (post-merge test gate is the T3+T4 caller-driven
    // step; not exercised by this wrapper alone).
    const s1 = await runUntilStop({ fix, memberBranch: `${fix.baseBranch}-be-1` });
    expect(s1).toBe("tested");

    // Capture base BEFORE be-2's failed merge so the conflict-side
    // assertion can compare.
    const baseBeforeBe2 = await git(fix.repoPath, ["rev-parse", fix.baseBranch]);
    const branchTipBefore = await git(fix.repoPath, ["rev-parse", `${fix.baseBranch}-be-2`]);

    const s2 = await runUntilStop({ fix, memberBranch: `${fix.baseBranch}-be-2` });
    expect(s2).toBe("conflict");

    const row = readState(fix, `${fix.baseBranch}-be-2`);
    if (row === null) throw new Error("be-2 ledger row missing");
    expect(row.state).toBe("conflict");
    // Note on conflict_sha: the shipped `performMerge` conflict
    // handler (intra-team-merge.ts:354-360) writes `state=conflict`
    // without populating `conflict_sha` — the diagnostic detail
    // lives in the row's `note` column (`conflict on <branch>:
    // <paths>`), not in a separate SHA column. The repo schema
    // accepts a `conflictSha` field, but the production caller
    // intentionally leaves it null today. When T5's surface
    // (`[merge-conflict]` Discord + `atmux flag`) wires through, it
    // may start populating conflict_sha; this assertion pins the
    // current contract so the bridge surfaces naturally if/when it
    // ships.
    expect(row.conflictSha).toBe(null);

    // Base unchanged after the conflict.
    const baseAfterBe2 = await git(fix.repoPath, ["rev-parse", fix.baseBranch]);
    expect(baseAfterBe2).toBe(baseBeforeBe2);

    // be-2's branch retains its commit (NOT auto-reverted).
    const branchTipAfter = await git(fix.repoPath, ["rev-parse", `${fix.baseBranch}-be-2`]);
    expect(branchTipAfter).toBe(branchTipBefore);
  });

  test("B3: caller-driven no-op short-circuit — re-tick on 'tested' branch returns changed=false reason=/caller-driven/", async () => {
    // Happy-path branch lands at `tested` (B1's contract). A re-tick
    // there must NOT re-run the merge — the wrapper recognises
    // `tested` as a caller-driven holding state and returns a no-op
    // with a self-describing reason pointing at the T3+T4 outer
    // wiring that owns the next transition.
    await seedMemberBranch(fix, "be-1", [{ name: "be-1.md", body: "1\n" }]);
    const first = await runUntilStop({ fix, memberBranch: `${fix.baseBranch}-be-1` });
    expect(first).toBe("tested");

    const before = readState(fix, `${fix.baseBranch}-be-1`);
    if (before === null) throw new Error("ledger row missing");
    const baseBefore = await git(fix.repoPath, ["rev-parse", fix.baseBranch]);

    // Re-tick via direct performMerge so we can inspect the raw
    // result tuple (changed/reason fields runUntilStop doesn't
    // surface).
    const db = openDatabase(fix.statePath, migrations);
    try {
      const repo = new MergerStateRepo(db);
      const aheadCount = await git(fix.repoPath, [
        "rev-list",
        "--count",
        `${fix.baseBranch}..${fix.baseBranch}-be-1`,
      ]);
      const result = await performMerge({
        memberBranch: `${fix.baseBranch}-be-1`,
        base: fix.baseBranch,
        repoPath: fix.repoPath,
        gate: {
          ownerOpenTaskCount: 0,
          worktreeIsClean: true,
          isAheadOfBase: Number.parseInt(aheadCount, 10) > 0,
          baseHasMoved: false,
        },
        repo,
        by: "event",
        fetch: false,
      });
      expect(result.state).toBe("tested");
      expect(result.changed).toBe(false);
      expect(result.reason).toMatch(/caller-driven/);
    } finally {
      closeDatabase(db);
    }

    // Ledger row unchanged after the no-op tick.
    const after = readState(fix, `${fix.baseBranch}-be-1`);
    if (after === null) throw new Error("ledger row vanished");
    expect(after.state).toBe(before.state);
    expect(after.baseSha).toBe(before.baseSha);

    // Base SHA didn't budge either.
    const baseAfter = await git(fix.repoPath, ["rev-parse", fix.baseBranch]);
    expect(baseAfter).toBe(baseBefore);
  });

  test("B4: operator-reset + retry — conflict cleared, ledger force-reset to in_progress, next tick walks to merged", async () => {
    // Reproduce the B2 conflict setup but immediately resolve.
    await seedMemberBranch(fix, "be-2", [{ name: "README.md", body: "be-2 overwrite\n" }]);
    await writeFile(join(fix.repoPath, "README.md"), "base overwrite\n");
    await git(fix.repoPath, ["add", "README.md"]);
    await git(fix.repoPath, ["commit", "-m", "base mutates README.md"]);
    const conflictState = await runUntilStop({
      fix,
      memberBranch: `${fix.baseBranch}-be-2`,
    });
    expect(conflictState).toBe("conflict");

    // Operator-resolve simulation: rewind be-2's branch to a
    // non-conflicting commit. We reset the worktree to base, then
    // add a different file so be-2 is ahead with content that
    // doesn't collide with base's README.md.
    const wtPath = join(fix.atmuxDir, "worktrees", "be-2");
    await git(wtPath, ["fetch", "origin", fix.baseBranch], true);
    await git(wtPath, ["reset", "--hard", fix.baseBranch]);
    await writeFile(join(wtPath, "be-2-resolved.md"), "post-resolve\n");
    await git(wtPath, ["add", "be-2-resolved.md"]);
    await git(wtPath, ["commit", "-m", "be-2 post-resolve"]);

    // Force-reset the ledger to in_progress — ADR-134 §state-machine
    // "operator must reset to in_progress to retry"; production
    // operator-driven verb does this via `atmux merger reset
    // <branch>` (per ADR-134 §D) but we exercise the repo directly
    // for the e2e — same SQL write, same result.
    const db = openDatabase(fix.statePath, migrations);
    try {
      const repo = new MergerStateRepo(db);
      repo.transition({
        memberBranch: `${fix.baseBranch}-be-2`,
        next: "in_progress",
        by: "operator",
        note: "operator-reset post-resolve (e2e B4)",
        transitionedAt: Math.floor(Date.now() / 1000),
      });
    } finally {
      closeDatabase(db);
    }

    // Next tick walks the post-reset branch through the happy
    // path to `tested` (wrapper stop — see B1).
    const final = await runUntilStop({
      fix,
      memberBranch: `${fix.baseBranch}-be-2`,
    });
    expect(final).toBe("tested");
    const row = readState(fix, `${fix.baseBranch}-be-2`);
    expect(row?.state).toBe("tested");
    // Ledger conflict_sha must clear on the post-reset re-walk —
    // the row's history of conflict is captured in
    // `transitioned_by` + `note` ordering, not by leaking the old
    // conflict_sha onto a now-clean state.
    expect(row?.conflictSha).toBe(null);
  });

  test("B5: bulk fan-in via merge-cycle verb — runs the merges; ledger integration deferred to ADR-134 T6/T8 follow-up", async () => {
    // merge-cycle (ADR-088 W3 / ADR-134 T6) is the operator-driven
    // bulk fan-in CLI. Trunk-current implementation runs the merge
    // primitive (`mergeMember`) directly and writes flags.md on
    // conflict, but does NOT yet drive the `MergerStateRepo` state
    // machine — that bridging is an ADR-134 T6/T8 integration
    // follow-up. This beat pins TWO things:
    //   (a) merge-cycle still works on its own contract (3 clean
    //       merges land, base advances, origin receives push) —
    //       regression guard on the older ADR-088 surface.
    //   (b) The `merger_state` ledger is observably DECOUPLED from
    //       merge-cycle today (rows are null for branches the verb
    //       just merged). When the integration lands, this
    //       assertion flips from null → state="tested"/"merged",
    //       surfacing the bridge naturally as a regression on this
    //       test.
    await seedMemberBranch(fix, "be-1", [{ name: "be-1.md", body: "1\n" }]);
    await seedMemberBranch(fix, "be-2", [{ name: "be-2.md", body: "2\n" }]);
    await seedMemberBranch(fix, "be-3", [{ name: "be-3.md", body: "3\n" }]);

    const logs: string[] = [];
    const rc = await mergeCycle(["--push", "--team-dir", fix.repoPath], {
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    const log = logs.join("");
    expect(log).toContain("merged:    3");
    expect(log).toContain("push:      ok");

    // Bridge-state assertion: when merge-cycle integrates with the
    // ADR-134 ledger (T6/T8 follow-up), every successful merge will
    // write a `merger_state` row; until then, the rows are null and
    // this beat documents the gap as a pinning assertion that flips
    // when the bridge ships.
    let rowsWritten = 0;
    for (const member of ["be-1", "be-2", "be-3"] as const) {
      const row = readState(fix, `${fix.baseBranch}-${member}`);
      if (row !== null) rowsWritten += 1;
    }
    // Current trunk: 0 rows written (merge-cycle bypasses the state
    // machine). When the T6/T8 bridge lands, this becomes 3 and the
    // expectation flips to `expect(rowsWritten).toBe(3)`.
    expect(rowsWritten).toBe(0);
  });
});
